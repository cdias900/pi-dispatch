import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import {
  isValidSpawnToken,
  writePendingSpawn,
  type HerdrTerminalLocation,
  type PendingSpawnRecord,
} from "./dispatch-core.ts";

export interface CommandRunOptions {
  env: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
}

export interface CommandRunResult {
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: string[],
  options: CommandRunOptions,
) => Promise<CommandRunResult>;

export class HerdrCommandError extends Error {
  readonly apiCode?: string;
  readonly stderr?: string;

  constructor(message: string, options: { apiCode?: string; stderr?: string; cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HerdrCommandError";
    this.apiCode = options.apiCode;
    this.stderr = options.stderr;
  }
}

export interface SpawnHerdrOptions {
  dispatchDir: string;
  cwd: string;
  name?: string;
  piArgs: string[];
  task: string;
  spawnedBy: string;
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  runner?: CommandRunner;
  token?: string;
}

export interface SpawnHerdrResult {
  terminal: HerdrTerminalLocation;
  token: string;
}

export interface CloseHerdrResult {
  closed: boolean;
  alreadyMissing: boolean;
}

export function isHerdrEnvironment(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.HERDR_ENV === "1";
}

export const execFileRunner: CommandRunner = (executable, args, options) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        encoding: "utf-8",
        env: options.env,
        maxBuffer: 256 * 1024,
        signal: options.signal,
        timeout: options.timeout,
      },
      (error, stdout, stderr) => {
        const stdoutText = stdout == null ? "" : String(stdout);
        const stderrText = stderr == null ? "" : String(stderr);
        if (error) {
          const parsed = parseHerdrError(stderrText);
          reject(
            new HerdrCommandError(
              parsed?.message || stderrText.trim() || error.message,
              { apiCode: parsed?.code, stderr: stderrText, cause: error },
            ),
          );
          return;
        }
        resolve({ stdout: stdoutText, stderr: stderrText });
      },
    );
  });

function parseHerdrError(stderr: string): { code?: string; message: string } | undefined {
  const candidates = [stderr.trim(), ...stderr.trim().split("\n").reverse()].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as {
        error?: { code?: unknown; message?: unknown };
      };
      if (!parsed.error) continue;
      const code = typeof parsed.error.code === "string" ? parsed.error.code : undefined;
      const message = typeof parsed.error.message === "string"
        ? parsed.error.message
        : code ?? "Herdr API request failed";
      return { code, message };
    } catch {
      // Try the next line. Herdr errors are normally one JSON line on stderr.
    }
  }
  return undefined;
}

function herdrContext(environment: NodeJS.ProcessEnv): {
  executable: string;
  socketPath: string;
  commandEnvironment: NodeJS.ProcessEnv;
} {
  if (!isHerdrEnvironment(environment)) {
    throw new HerdrCommandError("Herdr is not active in this Pi session (HERDR_ENV is not 1)");
  }
  const paneId = environment.HERDR_PANE_ID?.trim();
  const socketPath = environment.HERDR_SOCKET_PATH?.trim();
  if (!paneId || !socketPath) {
    throw new HerdrCommandError(
      "Herdr is active but HERDR_PANE_ID or HERDR_SOCKET_PATH is missing",
    );
  }
  const binaryPath = environment.HERDR_BIN_PATH?.trim();
  const executable = binaryPath || "herdr";
  return {
    executable,
    socketPath,
    commandEnvironment: { ...environment, HERDR_SOCKET_PATH: socketPath },
  };
}

function normalizeRunnerError(error: unknown): HerdrCommandError {
  if (error instanceof HerdrCommandError) return error;
  const stderr = (error as { stderr?: unknown } | null | undefined)?.stderr;
  const stderrText = typeof stderr === "string"
    ? stderr
    : Buffer.isBuffer(stderr) ? stderr.toString("utf-8") : "";
  const parsed = parseHerdrError(stderrText);
  const message = parsed?.message
    ?? (error instanceof Error ? error.message : String(error));
  return new HerdrCommandError(message, {
    apiCode: parsed?.code,
    stderr: stderrText,
    cause: error,
  });
}

async function runHerdrCommand(
  runner: CommandRunner,
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeout: number = 15_000,
): Promise<CommandRunResult> {
  try {
    return await runner(executable, args, { env: environment, signal, timeout });
  } catch (error) {
    throw normalizeRunnerError(error);
  }
}

async function runHerdrJson(
  runner: CommandRunner,
  executable: string,
  args: string[],
  environment: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  timeout: number = 15_000,
): Promise<any> {
  const result = await runHerdrCommand(
    runner,
    executable,
    args,
    environment,
    signal,
    timeout,
  );
  const raw = result.stdout.trim();
  if (!raw) {
    throw new HerdrCommandError(`Herdr returned no JSON for: ${args.join(" ")}`);
  }
  try {
    const response = JSON.parse(raw);
    if (response?.error) {
      const code = typeof response.error.code === "string" ? response.error.code : undefined;
      const message = typeof response.error.message === "string"
        ? response.error.message
        : code ?? "Herdr API request failed";
      throw new HerdrCommandError(message, { apiCode: code, stderr: result.stderr });
    }
    return response;
  } catch (error) {
    if (error instanceof HerdrCommandError) throw error;
    throw new HerdrCommandError(
      `Herdr returned invalid JSON for ${args.slice(0, 2).join(" ")}: ${raw.slice(0, 300)}`,
      { stderr: result.stderr, cause: error },
    );
  }
}

function livePaneFromResponse(response: any): { workspaceId: string; paneId: string } {
  const pane = response?.result?.pane;
  if (typeof pane?.workspace_id !== "string" || !pane.workspace_id) {
    throw new HerdrCommandError("Herdr pane current did not report a live workspace id");
  }
  if (typeof pane?.pane_id !== "string" || !pane.pane_id) {
    throw new HerdrCommandError("Herdr pane current did not report a live pane id");
  }
  return { workspaceId: pane.workspace_id, paneId: pane.pane_id };
}

function createdTabFromResponse(response: any, expectedWorkspaceId: string): {
  workspaceId: string;
  tabId: string;
  paneId: string;
} {
  const result = response?.result;
  const workspaceId = result?.tab?.workspace_id;
  const tabId = result?.tab?.tab_id;
  const paneId = result?.root_pane?.pane_id;
  if (result?.type !== "tab_created") {
    throw new HerdrCommandError("Herdr tab create returned an unexpected response type");
  }
  if (typeof workspaceId !== "string" || workspaceId !== expectedWorkspaceId) {
    throw new HerdrCommandError("Herdr created the child tab in an unexpected workspace");
  }
  if (typeof tabId !== "string" || !tabId || typeof paneId !== "string" || !paneId) {
    throw new HerdrCommandError("Herdr tab create did not report tab and root pane ids");
  }
  return { workspaceId, tabId, paneId };
}

function validateStartedAgent(response: any, expectedPaneId: string): void {
  const result = response?.result;
  if (result?.type !== "agent_started") {
    throw new HerdrCommandError("Herdr agent start returned an unexpected response type");
  }
  if (typeof result?.agent?.pane_id !== "string" || result.agent.pane_id !== expectedPaneId) {
    throw new HerdrCommandError("Herdr started the child agent in an unexpected pane");
  }
}

function validatePromptedAgent(response: any, expectedPaneId: string): void {
  const result = response?.result;
  if (result?.type !== "agent_prompted") {
    throw new HerdrCommandError("Herdr agent prompt returned an unexpected response type");
  }
  if (typeof result?.agent?.pane_id !== "string" || result.agent.pane_id !== expectedPaneId) {
    throw new HerdrCommandError("Herdr prompted an agent in an unexpected pane");
  }
}

function childAgentName(token: string): string {
  return `dispatch_${token.replace(/[^a-zA-Z0-9]/g, "").toLowerCase().slice(0, 20)}`;
}

function removeIfPresent(filePath: string | undefined): void {
  if (!filePath) return;
  try {
    fs.rmSync(filePath, { force: true });
  } catch {
    // Cleanup is best effort and must not mask the primary failure.
  }
}

async function rollbackCreatedTab(
  runner: CommandRunner,
  executable: string,
  tabId: string | undefined,
  environment: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  if (!tabId) return undefined;
  try {
    await runHerdrJson(runner, executable, ["tab", "close", tabId], environment, undefined, 10_000);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function spawnHerdrChild(options: SpawnHerdrOptions): Promise<SpawnHerdrResult> {
  const environment = options.environment ?? process.env;
  const runner = options.runner ?? execFileRunner;
  const { executable, socketPath, commandEnvironment } = herdrContext(environment);
  const token = options.token ?? randomUUID();
  if (!isValidSpawnToken(token)) {
    throw new HerdrCommandError("invalid dispatch spawn token");
  }

  let pendingPath: string | undefined;
  let createdTabId: string | undefined;
  let creationAttempted = false;

  try {
    const current = await runHerdrJson(
      runner,
      executable,
      ["pane", "current", "--current"],
      commandEnvironment,
      options.signal,
    );
    const livePane = livePaneFromResponse(current);

    const createArgs = [
      "tab",
      "create",
      "--workspace",
      livePane.workspaceId,
      "--cwd",
      options.cwd,
    ];
    if (options.name) createArgs.push("--label", options.name);
    createArgs.push("--env", `DISPATCH_SPAWN_TOKEN=${token}`, "--no-focus");

    creationAttempted = true;
    const createdResponse = await runHerdrJson(
      runner,
      executable,
      createArgs,
      commandEnvironment,
      options.signal,
      30_000,
    );
    const responseTabId = createdResponse?.result?.tab?.tab_id;
    if (typeof responseTabId === "string" && responseTabId) createdTabId = responseTabId;
    const created = createdTabFromResponse(createdResponse, livePane.workspaceId);

    const terminal: HerdrTerminalLocation = {
      kind: "herdr",
      socketPath,
      binaryPath: executable,
      workspaceId: created.workspaceId,
      tabId: created.tabId,
      paneId: created.paneId,
    };
    const pendingRecord: PendingSpawnRecord = {
      spawnedBy: options.spawnedBy,
      ...(options.name ? { name: options.name } : {}),
      terminal,
    };
    pendingPath = writePendingSpawn(options.dispatchDir, token, pendingRecord);

    // Starting through Herdr's agent API avoids racing terminal input against
    // interactive shell initialization. It waits only until Pi is detected and
    // ready, then the separate prompt call submits the dispatch task.
    const agentName = childAgentName(token);
    const startArgs = [
      "agent",
      "start",
      agentName,
      "--kind",
      "pi",
      "--pane",
      created.paneId,
      "--timeout",
      "30000",
    ];
    if (options.piArgs.length > 0) startArgs.push("--", ...options.piArgs);
    const started = await runHerdrJson(
      runner,
      executable,
      startArgs,
      commandEnvironment,
      options.signal,
      45_000,
    );
    validateStartedAgent(started, created.paneId);

    const prompted = await runHerdrJson(
      runner,
      executable,
      ["agent", "prompt", agentName, options.task],
      commandEnvironment,
      options.signal,
      30_000,
    );
    validatePromptedAgent(prompted, created.paneId);

    return { terminal, token };
  } catch (error) {
    removeIfPresent(pendingPath);
    const rollbackError = await rollbackCreatedTab(
      runner,
      executable,
      createdTabId,
      commandEnvironment,
    );
    const primary = error instanceof Error ? error.message : String(error);
    const suffix = rollbackError
      ? `; rollback of Herdr tab ${createdTabId ?? "(unknown)"} also failed: ${rollbackError}`
      : createdTabId
        ? `; rolled back Herdr tab ${createdTabId}`
        : creationAttempted ? "; tab creation may be uncertain" : "";
    throw new HerdrCommandError(`Failed to spawn in Herdr: ${primary}${suffix}`, { cause: error });
  }
}

export async function closeHerdrTab(
  terminal: HerdrTerminalLocation,
  options: {
    environment?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    runner?: CommandRunner;
  } = {},
): Promise<CloseHerdrResult> {
  const runner = options.runner ?? execFileRunner;
  const environment: NodeJS.ProcessEnv = {
    ...(options.environment ?? process.env),
    HERDR_SOCKET_PATH: terminal.socketPath,
  };
  const executable = terminal.binaryPath || environment.HERDR_BIN_PATH || "herdr";
  try {
    await runHerdrJson(
      runner,
      executable,
      ["tab", "close", terminal.tabId],
      environment,
      options.signal,
      30_000,
    );
    return { closed: true, alreadyMissing: false };
  } catch (error) {
    if (error instanceof HerdrCommandError && error.apiCode === "tab_not_found") {
      return { closed: false, alreadyMissing: true };
    }
    throw error;
  }
}
