import * as fs from "fs";
import * as path from "path";

export interface ITermTerminalLocation {
  kind: "iterm2";
  sessionId: string;
}

export interface HerdrTerminalLocation {
  kind: "herdr";
  socketPath: string;
  binaryPath?: string;
  workspaceId: string;
  tabId: string;
  paneId: string;
}

export type TerminalLocation = ITermTerminalLocation | HerdrTerminalLocation;

export function isTerminalLocation(value: unknown): value is TerminalLocation {
  if (!value || typeof value !== "object") return false;
  const location = value as Record<string, unknown>;
  if (location.kind === "iterm2") {
    return typeof location.sessionId === "string" && location.sessionId.length > 0;
  }
  if (location.kind === "herdr") {
    return typeof location.socketPath === "string" && location.socketPath.length > 0
      && (location.binaryPath === undefined
        || (typeof location.binaryPath === "string" && location.binaryPath.length > 0))
      && typeof location.workspaceId === "string" && location.workspaceId.length > 0
      && typeof location.tabId === "string" && location.tabId.length > 0
      && typeof location.paneId === "string" && location.paneId.length > 0;
  }
  return false;
}

export interface PendingSpawnRecord {
  spawnedBy: string;
  name?: string;
  terminal: TerminalLocation;
}

const SPAWN_TOKEN_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

export function isValidSpawnToken(value: unknown): value is string {
  return typeof value === "string" && SPAWN_TOKEN_PATTERN.test(value);
}

export function pendingSpawnPath(dispatchDir: string, token: string): string {
  if (!isValidSpawnToken(token)) {
    throw new Error("invalid dispatch spawn token");
  }
  return path.join(dispatchDir, `_pending_spawn_${token}.json`);
}

export function isPendingSpawnRecord(value: unknown): value is PendingSpawnRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.spawnedBy === "string" && record.spawnedBy.length > 0
    && (record.name === undefined || typeof record.name === "string")
    && isTerminalLocation(record.terminal);
}

export function writePendingSpawn(
  dispatchDir: string,
  token: string,
  record: PendingSpawnRecord,
): string {
  if (!isPendingSpawnRecord(record)) {
    throw new Error("invalid pending dispatch spawn record");
  }
  ensureDir(dispatchDir);
  const target = pendingSpawnPath(dispatchDir, token);
  const tmp = `${target}.tmp.${process.pid}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, target);
    return target;
  } catch (error) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw error;
  }
}

export function readPendingSpawn(
  dispatchDir: string,
  token: unknown,
): { path: string; record: PendingSpawnRecord } | undefined {
  if (!isValidSpawnToken(token)) return undefined;
  try {
    const filePath = pendingSpawnPath(dispatchDir, token);
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return isPendingSpawnRecord(value) ? { path: filePath, record: value } : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSpawnCwd(
  requestedCwd: string | undefined,
  currentCwd: string,
  homeDir: string,
): string {
  if (!requestedCwd) return path.resolve(currentCwd);
  if (requestedCwd === "~") return path.resolve(homeDir);
  if (requestedCwd.startsWith("~/") || requestedCwd.startsWith("~\\")) {
    return path.resolve(homeDir, requestedCwd.slice(2));
  }
  return path.resolve(currentCwd, requestedCwd);
}

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function buildPiArgs(options: {
  extensions?: string;
  skills?: string;
}): string[] {
  const args: string[] = [];
  for (const extension of options.extensions?.split(",").map((value) => value.trim()).filter(Boolean) ?? []) {
    args.push("-e", extension);
  }
  for (const skill of options.skills?.split(",").map((value) => value.trim()).filter(Boolean) ?? []) {
    args.push("--skill", skill);
  }
  return args;
}

export function buildPiCommand(options: {
  task: string;
  extensions?: string;
  skills?: string;
}): string {
  const args = [...buildPiArgs(options), options.task];
  return `pi ${args.map(shellEscape).join(" ")}`;
}

export interface RegistryEntry {
  sessionId: string;
  cwd: string;
  pid: number;
  startedAt: string;
  endedAt?: string;
  status: "active" | "ended";
  label?: string;
  terminal?: TerminalLocation;
  /** Legacy iTerm2 handle retained for existing state files. */
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
