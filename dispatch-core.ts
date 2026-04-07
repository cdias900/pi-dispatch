import * as fs from "fs";
import * as path from "path";

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
