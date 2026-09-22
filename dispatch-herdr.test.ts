import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { pendingSpawnPath, readPendingSpawn, type HerdrTerminalLocation } from "./dispatch-core.ts";
import {
  closeHerdrTab,
  HerdrCommandError,
  isHerdrEnvironment,
  spawnHerdrChild,
  type CommandRunner,
} from "./dispatch-herdr.ts";

interface RecordedCall {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeout: number;
  signal?: AbortSignal;
}

let tmpDir = "";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-herdr-test-"));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = "";
});

function herdrEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HERDR_ENV: "1",
    HERDR_SOCKET_PATH: "/tmp/herdr.sock",
    HERDR_BIN_PATH: "/opt/herdr/bin/herdr",
    HERDR_WORKSPACE_ID: "w-stale",
    HERDR_TAB_ID: "w-stale:t1",
    HERDR_PANE_ID: "w-stale:p1",
    ITERM_SESSION_ID: "w0t0p0:outer-iterm-session",
    TERM_PROGRAM: "iTerm.app",
    ...overrides,
  };
}

function json(result: unknown): { stdout: string; stderr: string } {
  return { stdout: JSON.stringify({ id: "test", result }), stderr: "" };
}

function successfulRunner(calls: RecordedCall[]): CommandRunner {
  return async (executable, args, options) => {
    calls.push({ executable, args: [...args], ...options });
    const command = args.slice(0, 2).join(" ");
    if (command === "pane current") {
      return json({
        type: "pane_current",
        pane: { pane_id: "w-live:p1", workspace_id: "w-live", tab_id: "w-live:t1" },
      });
    }
    if (command === "tab create") {
      return json({
        type: "tab_created",
        tab: { tab_id: "w-live:t2", workspace_id: "w-live" },
        root_pane: { pane_id: "w-live:p2", workspace_id: "w-live", tab_id: "w-live:t2" },
      });
    }
    if (command === "agent start") {
      return json({
        type: "agent_started",
        agent: { name: args[2], pane_id: "w-live:p2", agent_status: "idle" },
        argv: ["pi", ...args.slice(args.indexOf("--") + 1)],
      });
    }
    if (command === "agent prompt") {
      return json({
        type: "agent_prompted",
        agent: { name: args[2], pane_id: "w-live:p2", agent_status: "working" },
      });
    }
    if (command === "tab close") return json({ type: "ok" });
    throw new Error(`unexpected Herdr command: ${args.join(" ")}`);
  };
}

function terminal(overrides: Partial<HerdrTerminalLocation> = {}): HerdrTerminalLocation {
  return {
    kind: "herdr",
    socketPath: "/tmp/herdr.sock",
    binaryPath: "/opt/herdr/bin/herdr",
    workspaceId: "w-live",
    tabId: "w-live:t2",
    paneId: "w-live:p2",
    ...overrides,
  };
}

describe("Herdr detection", () => {
  it("selects Herdr only for its explicit marker, even when iTerm variables coexist", () => {
    assert.equal(isHerdrEnvironment(herdrEnvironment()), true);
    assert.equal(isHerdrEnvironment(herdrEnvironment({ HERDR_ENV: "0" })), false);
    assert.equal(isHerdrEnvironment({ ITERM_SESSION_ID: "outer" }), false);
  });
});

describe("spawnHerdrChild", () => {
  it("creates an unfocused tab in the parent's live workspace and starts/prompts Pi through Herdr", async () => {
    const calls: RecordedCall[] = [];
    const token = "fixed-token";
    const result = await spawnHerdrChild({
      dispatchDir: tmpDir,
      cwd: "/repo/path with spaces",
      name: "review worker",
      piArgs: ["--model", "openai/gpt-5.6-sol", "--thinking", "high"],
      task: "review safely",
      spawnedBy: "parent-session",
      environment: herdrEnvironment(),
      runner: successfulRunner(calls),
      token,
    });

    assert.deepEqual(result, { terminal: terminal(), token });
    assert.equal(calls.length, 4);
    assert.deepEqual(calls[0].args, ["pane", "current", "--current"]);
    assert.deepEqual(calls[1].args, [
      "tab", "create",
      "--workspace", "w-live",
      "--cwd", "/repo/path with spaces",
      "--label", "review worker",
      "--env", `DISPATCH_SPAWN_TOKEN=${token}`,
      "--no-focus",
    ]);
    assert.equal(calls[1].args.includes("w-stale"), false);
    assert.deepEqual(calls[2].args, [
      "agent", "start", "dispatch_fixedtoken",
      "--kind", "pi",
      "--pane", "w-live:p2",
      "--timeout", "30000",
      "--", "--model", "openai/gpt-5.6-sol", "--thinking", "high",
    ]);
    assert.deepEqual(calls[3].args, [
      "agent", "prompt", "dispatch_fixedtoken", "review safely",
    ]);
    for (const call of calls) {
      assert.equal(call.executable, "/opt/herdr/bin/herdr");
      assert.equal(call.env.HERDR_SOCKET_PATH, "/tmp/herdr.sock");
    }

    assert.deepEqual(readPendingSpawn(tmpDir, token), {
      path: pendingSpawnPath(tmpDir, token),
      record: {
        spawnedBy: "parent-session",
        name: "review worker",
        terminal: terminal(),
      },
    });
    assert.deepEqual(
      fs.readdirSync(tmpDir).filter((file) => file.startsWith("_launch_")),
      [],
    );
  });

  it("omits the optional tab label when no child name is supplied", async () => {
    const calls: RecordedCall[] = [];
    await spawnHerdrChild({
      dispatchDir: tmpDir,
      cwd: "/repo",
      piArgs: [],
      task: "task",
      spawnedBy: "parent",
      environment: herdrEnvironment(),
      runner: successfulRunner(calls),
      token: "no-name",
    });
    assert.equal(calls[1].args.includes("--label"), false);
  });

  it("rejects an unsafe injected spawn token before writing or calling Herdr", async () => {
    let called = false;
    const runner: CommandRunner = async () => {
      called = true;
      return json({ type: "ok" });
    };
    await assert.rejects(
      spawnHerdrChild({
        dispatchDir: tmpDir,
        cwd: "/repo",
        piArgs: [],
        task: "task",
        spawnedBy: "parent",
        environment: herdrEnvironment(),
        runner,
        token: "../escape",
      }),
      /invalid dispatch spawn token/,
    );
    assert.equal(called, false);
    assert.deepEqual(fs.readdirSync(tmpDir), []);
  });

  it("fails closed when Herdr is marked active but required context is missing", async () => {
    let called = false;
    const runner: CommandRunner = async () => {
      called = true;
      return json({ type: "ok" });
    };
    await assert.rejects(
      spawnHerdrChild({
        dispatchDir: tmpDir,
        cwd: "/repo",
        piArgs: [],
        task: "task",
        spawnedBy: "parent",
        environment: herdrEnvironment({ HERDR_SOCKET_PATH: "" }),
        runner,
      }),
      /HERDR_PANE_ID or HERDR_SOCKET_PATH is missing/,
    );
    assert.equal(called, false);
  });

  it("rolls back its exact tab and artifacts when command submission fails", async () => {
    const calls: RecordedCall[] = [];
    const runner = successfulRunner(calls);
    const failingRunner: CommandRunner = async (executable, args, options) => {
      if (args.slice(0, 2).join(" ") === "agent prompt") {
        calls.push({ executable, args: [...args], ...options });
        throw new HerdrCommandError("agent prompt failed", { apiCode: "agent_prompt_failed" });
      }
      return runner(executable, args, options);
    };

    await assert.rejects(
      spawnHerdrChild({
        dispatchDir: tmpDir,
        cwd: "/repo",
        piArgs: [],
        task: "task",
        spawnedBy: "parent",
        environment: herdrEnvironment(),
        runner: failingRunner,
        token: "rollback-token",
      }),
      /agent prompt failed; rolled back Herdr tab w-live:t2/,
    );

    assert.equal(fs.existsSync(pendingSpawnPath(tmpDir, "rollback-token")), false);
    assert.deepEqual(calls.at(-1)?.args, ["tab", "close", "w-live:t2"]);
    assert.equal(calls.at(-1)?.signal, undefined);
  });

  it("rolls back a reported tab id when the creation response is malformed", async () => {
    const calls: RecordedCall[] = [];
    const runner: CommandRunner = async (executable, args, options) => {
      calls.push({ executable, args: [...args], ...options });
      const command = args.slice(0, 2).join(" ");
      if (command === "pane current") {
        return json({ type: "pane_current", pane: { pane_id: "w-live:p1", workspace_id: "w-live" } });
      }
      if (command === "tab create") {
        return json({ type: "tab_created", tab: { tab_id: "w-live:t9", workspace_id: "w-live" } });
      }
      if (command === "tab close") return json({ type: "ok" });
      throw new Error(`unexpected ${command}`);
    };

    await assert.rejects(
      spawnHerdrChild({
        dispatchDir: tmpDir,
        cwd: "/repo",
        piArgs: [],
        task: "task",
        spawnedBy: "parent",
        environment: herdrEnvironment(),
        runner,
        token: "malformed-create",
      }),
      /did not report tab and root pane ids; rolled back Herdr tab w-live:t9/,
    );
    assert.deepEqual(calls.at(-1)?.args, ["tab", "close", "w-live:t9"]);
  });

  it("surfaces JSON API errors from stderr and does not fall back to another terminal", async () => {
    const calls: RecordedCall[] = [];
    const runner: CommandRunner = async (executable, args, options) => {
      calls.push({ executable, args: [...args], ...options });
      throw {
        stderr: JSON.stringify({
          error: { code: "protocol_mismatch", message: "client and server protocols differ" },
        }),
      };
    };

    await assert.rejects(
      spawnHerdrChild({
        dispatchDir: tmpDir,
        cwd: "/repo",
        piArgs: [],
        task: "task",
        spawnedBy: "parent",
        environment: herdrEnvironment(),
        runner,
        token: "protocol-error",
      }),
      /client and server protocols differ$/,
    );
    assert.equal(calls.length, 1);
  });
});

describe("closeHerdrTab", () => {
  it("closes the recorded tab through its recorded socket and binary", async () => {
    const calls: RecordedCall[] = [];
    const result = await closeHerdrTab(terminal(), {
      environment: { PATH: process.env.PATH, HERDR_SOCKET_PATH: "/wrong/socket" },
      runner: successfulRunner(calls),
    });
    assert.deepEqual(result, { closed: true, alreadyMissing: false });
    assert.deepEqual(calls[0].args, ["tab", "close", "w-live:t2"]);
    assert.equal(calls[0].executable, "/opt/herdr/bin/herdr");
    assert.equal(calls[0].env.HERDR_SOCKET_PATH, "/tmp/herdr.sock");
  });

  it("distinguishes an already-missing tab from other close errors", async () => {
    const missing: CommandRunner = async () => {
      throw {
        stderr: JSON.stringify({ error: { code: "tab_not_found", message: "tab not found" } }),
      };
    };
    assert.deepEqual(await closeHerdrTab(terminal(), { runner: missing }), {
      closed: false,
      alreadyMissing: true,
    });

    const incompatible: CommandRunner = async () => {
      throw new HerdrCommandError("protocol mismatch", { apiCode: "protocol_mismatch" });
    };
    await assert.rejects(closeHerdrTab(terminal(), { runner: incompatible }), /protocol mismatch/);
  });
});
