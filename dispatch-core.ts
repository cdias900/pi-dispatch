import * as fs from "fs";
import * as path from "path";

/**
 * Authoritative Pi thinking levels, matching the installed Pi 0.80.7 CLI
 * (`VALID_THINKING_LEVELS` in packages/coding-agent/src/cli/args.ts and the
 * `ThinkingLevel` type from @earendil-works/pi-agent-core).
 */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export function isValidThinkingLevel(level: unknown): level is ThinkingLevel {
  return typeof level === "string" && (THINKING_LEVELS as readonly string[]).includes(level);
}

/**
 * Validate an optional model override for a spawned Pi session.
 *
 * This is *structural* format validation, not registry/existence validation.
 * A valid override is a native provider-qualified model reference of the form
 * `provider/modelId` where:
 *  - the provider (before the first `/`) is non-empty and contains no
 *    whitespace;
 *  - the model ID (after the first `/`) is non-empty, contains no whitespace,
 *    and may itself contain additional `/` segments (e.g. OpenRouter nested
 *    IDs such as `openrouter/anthropic/claude-sonnet-4`);
 *  - the value does not carry a trailing native thinking suffix such as
 *    `:high`; callers must use the separate `thinking` field instead.
 *
 * Returns `true` for a valid reference and `false` with a human-readable reason
 * otherwise. `undefined` (omitted) is accepted and treated as "no override";
 * only a supplied-but-invalid value is rejected. An empty string is invalid
 * and distinct from `undefined`.
 */
export function validateModelOverride(model: unknown): { ok: true } | { ok: false; reason: string } {
  if (model === undefined) return { ok: true };
  if (typeof model !== "string") {
    return { ok: false, reason: "model override must be a string" };
  }
  if (model === "") {
    return { ok: false, reason: "model override must not be empty" };
  }
  if (model !== model.trim() || model.includes(" ") || /\s/.test(model)) {
    return { ok: false, reason: "model override must not contain surrounding or internal whitespace" };
  }

  // Reject the native "<id>:<thinking>" shorthand. Pi parses a trailing
  // ":<valid-thinking-level>" suffix as a thinking level (see parseModelPattern
  // in packages/coding-agent/src/core/model-resolver.ts); dispatch_spawn exposes
  // a dedicated `thinking` field, so the suffix is not allowed here.
  const lastColon = model.lastIndexOf(":");
  if (lastColon !== -1) {
    const suffix = model.substring(lastColon + 1);
    if (isValidThinkingLevel(suffix)) {
      return {
        ok: false,
        reason: `model override must not include a thinking suffix (":${suffix}"); use the separate 'thinking' field instead`,
      };
    }
  }

  const slashIndex = model.indexOf("/");
  if (slashIndex === -1) {
    return {
      ok: false,
      reason: "model override must be a provider-qualified reference (\"provider/modelId\"), not a bare or fuzzy alias",
    };
  }

  const provider = model.substring(0, slashIndex);
  const modelId = model.substring(slashIndex + 1);

  if (provider === "") {
    return { ok: false, reason: "model override must have a non-empty provider before the first \"/\"" };
  }
  if (modelId === "") {
    return { ok: false, reason: "model override must have a non-empty model id after the first \"/\"" };
  }

  return { ok: true };
}

/**
 * Result of building optional CLI flag/value pairs for a spawned Pi session.
 * `flags` is the ordered list of CLI tokens (e.g. ["--model", "openai/gpt-5"]).
 * `error` is set when a supplied value is invalid; in that case `flags` is
 * empty so the caller can surface the error without spawning Pi.
 */
export interface SpawnFlagResult {
  flags: string[];
  error: string | undefined;
}

/**
 * Build the optional `--model` and `--thinking` CLI flag/value pairs for a
 * spawned Pi session from raw override inputs. Pure and side-effect free so it
 * can be unit-tested without spawning Pi.
 *
 * `undefined` for either field means "omitted" (no flag emitted). An empty
 * string for `model` is invalid and distinct from `undefined`. `thinking` is
 * only emitted when it is a valid `ThinkingLevel`; an invalid thinking level
 * produces an error.
 */
export function buildSpawnFlags(options: {
  model?: string;
  thinking?: string;
}): SpawnFlagResult {
  const modelResult = validateModelOverride(options.model);
  if (!modelResult.ok) {
    return { flags: [], error: modelResult.reason };
  }

  let thinking: ThinkingLevel | undefined;
  if (options.thinking !== undefined) {
    if (!isValidThinkingLevel(options.thinking)) {
      return {
        flags: [],
        error: `invalid thinking level "${options.thinking}". Valid values: ${THINKING_LEVELS.join(", ")}`,
      };
    }
    thinking = options.thinking;
  }

  const flags: string[] = [];
  if (options.model !== undefined) {
    flags.push("--model", options.model);
  }
  if (thinking !== undefined) {
    flags.push("--thinking", thinking);
  }

  return { flags, error: undefined };
}

export interface RegistryEntry {
  sessionId: string;
  cwd: string;
  pid: number;
  startedAt: string;
  endedAt?: string;
  status: "active" | "ended";
  label?: string;
  itermSessionId?: string;
  spawnedBy?: string;
}

export interface Message {
  ts: string;
  from: string;
  fromName?: string;
  type: string;
  content: string;
}

export function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function sessionDir(id: string, dispatchDir: string) {
  return path.join(dispatchDir, id);
}

export function isValidEntry(entry: unknown): entry is RegistryEntry {
  if (!entry || typeof entry !== "object") return false;
  const e = entry as Record<string, unknown>;
  return typeof e.sessionId === "string" && e.sessionId.length > 0
    && typeof e.cwd === "string"
    && typeof e.pid === "number"
    && typeof e.startedAt === "string"
    && (e.status === "active" || e.status === "ended");
}

export function appendMsg(filePath: string, msg: Message) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(msg) + "\n");
}

export function readMsgs(filePath: string): Message[] {
  try {
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    if (!raw) return [];
    return raw
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Message];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}

export function readSessionState(id: string, dispatchDir: string): RegistryEntry | undefined {
  try {
    const statePath = path.join(sessionDir(id, dispatchDir), "state.json");
    const entry = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return isValidEntry(entry) ? entry : undefined;
  } catch {
    return undefined;
  }
}

export function writeSessionState(id: string, entry: RegistryEntry, dispatchDir: string) {
  const dir = sessionDir(id, dispatchDir);
  ensureDir(dir);
  const target = path.join(dir, "state.json");
  const tmp = `${target}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2));
  fs.renameSync(tmp, target);
}

export function readRegistry(dispatchDir: string): Record<string, RegistryEntry> {
  try {
    const reg: Record<string, RegistryEntry> = {};
    const entries = fs.readdirSync(dispatchDir, { withFileTypes: true });
    for (const dirent of entries) {
      if (!dirent.isDirectory() || dirent.name.startsWith("_")) continue;
      const entry = readSessionState(dirent.name, dispatchDir);
      if (entry && entry.sessionId === dirent.name) {
        reg[dirent.name] = entry;
      }
    }
    return reg;
  } catch {
    return {};
  }
}

export type ProcessChecker = (pid: number) => boolean;

const defaultProcessChecker: ProcessChecker = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};

export function cleanupStale(
  dispatchDir: string,
  staleHours?: number,
  isProcessAlive: ProcessChecker = defaultProcessChecker,
) {
  const STALE_HOURS_DEFAULT = 24;
  const cutoff = Date.now() - (staleHours ?? STALE_HOURS_DEFAULT) * 60 * 60 * 1000;
  const reg = readRegistry(dispatchDir);
  for (const [id, entry] of Object.entries(reg)) {
    if (entry.status === "ended" && entry.endedAt && new Date(entry.endedAt).getTime() < cutoff) {
      try {
        const dir = sessionDir(id, dispatchDir);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      } catch {}
      continue;
    }
    if (entry.status === "active" && entry.pid) {
      if (!isProcessAlive(entry.pid)) {
        entry.status = "ended";
        entry.endedAt = new Date().toISOString();
        writeSessionState(id, entry, dispatchDir);
      }
    }
  }
}

export function migrateRegistryIfNeeded(dispatchDir: string) {
  const legacyPath = path.join(dispatchDir, "registry.json");
  if (!fs.existsSync(legacyPath)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPath, "utf-8"));
    for (const [id, entry] of Object.entries(raw)) {
      if (isValidEntry(entry) && (entry as RegistryEntry).sessionId === id) {
        const dir = sessionDir(id, dispatchDir);
        const statePath = path.join(dir, "state.json");
        if (!fs.existsSync(statePath)) {
          ensureDir(dir);
          writeSessionState(id, entry as RegistryEntry, dispatchDir);
        }
      }
    }
    fs.unlinkSync(legacyPath);
  } catch {}
}
