import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import {
  appendMsg,
  cleanupStale,
  ensureDir,
  isValidEntry,
  migrateRegistryIfNeeded,
  readMsgs,
  readRegistry,
  readSessionState,
  sessionDir,
  writeSessionState,
} from "./dispatch-core.ts";
import type { Message, RegistryEntry } from "./dispatch-core.ts";

function createTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "dispatch-test-"));
}

function cleanTmpDir(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function validEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    sessionId: "test-session-1",
    cwd: "/tmp/test",
    pid: 12345,
    startedAt: new Date().toISOString(),
    status: "active",
    ...overrides,
  };
}

function validMessage(overrides: Partial<Message> = {}): Message {
  return {
    ts: new Date().toISOString(),
    from: "user",
    type: "text",
    content: "hello world",
    ...overrides,
  };
}

let tmpDir = "";

function getDispatchDir() {
  return path.join(tmpDir, "dispatch");
}

beforeEach(() => {
  tmpDir = createTmpDir();
});

afterEach(() => {
  if (tmpDir) cleanTmpDir(tmpDir);
  tmpDir = "";
});

describe("ensureDir", () => {
  it("creates a directory if it does not exist", () => {
    const dir = path.join(tmpDir, "new-dir");

    ensureDir(dir);

    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });

  it("is a no-op if the directory already exists", () => {
    const dir = path.join(tmpDir, "existing-dir");
    fs.mkdirSync(dir, { recursive: true });

    assert.doesNotThrow(() => ensureDir(dir));
    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });

  it("creates nested directories", () => {
    const dir = path.join(tmpDir, "a", "b", "c");

    ensureDir(dir);

    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.statSync(dir).isDirectory(), true);
  });
});

describe("sessionDir", () => {
  it("returns dispatchDir/id", () => {
    const dispatchDir = getDispatchDir();

    assert.equal(sessionDir("session-123", dispatchDir), path.join(dispatchDir, "session-123"));
  });
});

describe("isValidEntry", () => {
  it("accepts a fully valid entry", () => {
    assert.equal(isValidEntry(validEntry()), true);
  });

  it("rejects null", () => {
    assert.equal(isValidEntry(null), false);
  });

  it("rejects undefined", () => {
    assert.equal(isValidEntry(undefined), false);
  });

  it("rejects entries missing sessionId", () => {
    const { sessionId: _sessionId, ...entry } = validEntry();

    assert.equal(isValidEntry(entry), false);
  });

  it("rejects entries with an empty sessionId", () => {
    assert.equal(isValidEntry(validEntry({ sessionId: "" })), false);
  });

  it("rejects entries missing cwd", () => {
    const { cwd: _cwd, ...entry } = validEntry();

    assert.equal(isValidEntry(entry), false);
  });

  it("rejects entries missing pid", () => {
    const { pid: _pid, ...entry } = validEntry();

    assert.equal(isValidEntry(entry), false);
  });

  it("rejects entries with a non-number pid", () => {
    assert.equal(isValidEntry({ ...validEntry(), pid: "12345" }), false);
  });

  it("rejects entries missing startedAt", () => {
    const { startedAt: _startedAt, ...entry } = validEntry();

    assert.equal(isValidEntry(entry), false);
  });

  it("rejects entries missing status", () => {
    const { status: _status, ...entry } = validEntry();

    assert.equal(isValidEntry(entry), false);
  });

  it("rejects entries with an invalid status", () => {
    assert.equal(isValidEntry({ ...validEntry(), status: "paused" }), false);
  });

  it("accepts active and ended statuses", () => {
    assert.equal(isValidEntry(validEntry({ status: "active" })), true);
    assert.equal(
      isValidEntry(validEntry({ status: "ended", endedAt: new Date().toISOString() })),
      true,
    );
  });

  it("accepts entries with optional fields", () => {
    assert.equal(
      isValidEntry(
        validEntry({
          label: "Helpful label",
          itermSessionId: "iterm-123",
          spawnedBy: "parent-session",
        }),
      ),
      true,
    );
  });
});

describe("readSessionState and writeSessionState", () => {
  it("round-trips a written session state", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({
      sessionId: "roundtrip-session",
      label: "Roundtrip",
      spawnedBy: "root-session",
    });

    writeSessionState(entry.sessionId, entry, dispatchDir);

    assert.deepEqual(readSessionState(entry.sessionId, dispatchDir), entry);
  });

  it("writeSessionState creates the session directory when needed", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({ sessionId: "create-dir-session" });
    const dir = sessionDir(entry.sessionId, dispatchDir);

    writeSessionState(entry.sessionId, entry, dispatchDir);

    assert.equal(fs.existsSync(dir), true);
    assert.equal(fs.existsSync(path.join(dir, "state.json")), true);
  });

  it("writeSessionState uses atomic rename and leaves no tmp files behind", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({ sessionId: "atomic-session" });
    const dir = sessionDir(entry.sessionId, dispatchDir);

    writeSessionState(entry.sessionId, entry, dispatchDir);

    const leftoverTmpFiles = fs.readdirSync(dir).filter((name) => name.includes(".tmp."));
    assert.deepEqual(leftoverTmpFiles, []);
  });

  it("readSessionState returns undefined for a nonexistent session", () => {
    assert.equal(readSessionState("missing-session", getDispatchDir()), undefined);
  });

  it("readSessionState returns undefined for invalid or corrupted state.json", () => {
    const dispatchDir = getDispatchDir();
    const dir = sessionDir("corrupted-session", dispatchDir);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "state.json"), "{ definitely-not-json");

    assert.equal(readSessionState("corrupted-session", dispatchDir), undefined);
  });
});

describe("readRegistry", () => {
  it("returns an empty object for an empty directory", () => {
    const dispatchDir = getDispatchDir();
    fs.mkdirSync(dispatchDir, { recursive: true });

    assert.deepEqual(readRegistry(dispatchDir), {});
  });

  it("returns an empty object for a nonexistent directory", () => {
    assert.deepEqual(readRegistry(getDispatchDir()), {});
  });

  it("scans session directories and returns valid entries", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({ sessionId: "scan-session" });

    writeSessionState(entry.sessionId, entry, dispatchDir);

    assert.deepEqual(readRegistry(dispatchDir), { [entry.sessionId]: entry });
  });

  it("skips directories starting with _", () => {
    const dispatchDir = getDispatchDir();
    const hiddenEntry = validEntry({ sessionId: "_pending_iterm_123" });
    const visibleEntry = validEntry({ sessionId: "visible-session" });

    writeSessionState(hiddenEntry.sessionId, hiddenEntry, dispatchDir);
    writeSessionState(visibleEntry.sessionId, visibleEntry, dispatchDir);

    assert.deepEqual(readRegistry(dispatchDir), { [visibleEntry.sessionId]: visibleEntry });
  });

  it("skips sessions whose state.json is missing", () => {
    const dispatchDir = getDispatchDir();
    ensureDir(sessionDir("missing-state", dispatchDir));

    assert.deepEqual(readRegistry(dispatchDir), {});
  });

  it("skips sessions whose state.json is invalid", () => {
    const dispatchDir = getDispatchDir();
    const dir = sessionDir("invalid-session", dispatchDir);
    ensureDir(dir);
    fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ nope: true }));

    assert.deepEqual(readRegistry(dispatchDir), {});
  });

  it("skips sessions whose directory name does not match entry.sessionId", () => {
    const dispatchDir = getDispatchDir();

    writeSessionState("directory-name", validEntry({ sessionId: "different-id" }), dispatchDir);

    assert.deepEqual(readRegistry(dispatchDir), {});
  });

  it("returns the correct entries for multiple valid sessions", () => {
    const dispatchDir = getDispatchDir();
    const first = validEntry({ sessionId: "session-a", pid: 11111 });
    const second = validEntry({ sessionId: "session-b", pid: 22222, label: "Session B" });

    writeSessionState(first.sessionId, first, dispatchDir);
    writeSessionState(second.sessionId, second, dispatchDir);

    assert.deepEqual(readRegistry(dispatchDir), {
      [first.sessionId]: first,
      [second.sessionId]: second,
    });
  });
});

describe("cleanupStale", () => {
  it("removes ended sessions older than the cutoff", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({
      sessionId: "old-ended-session",
      status: "ended",
      endedAt: new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString(),
    });

    writeSessionState(entry.sessionId, entry, dispatchDir);
    cleanupStale(dispatchDir, 24, () => true);

    assert.equal(fs.existsSync(sessionDir(entry.sessionId, dispatchDir)), false);
  });

  it("preserves ended sessions within the cutoff", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({
      sessionId: "recent-ended-session",
      status: "ended",
      endedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    });

    writeSessionState(entry.sessionId, entry, dispatchDir);
    cleanupStale(dispatchDir, 24, () => true);

    assert.deepEqual(readSessionState(entry.sessionId, dispatchDir), entry);
  });

  it("marks active sessions with dead PIDs as ended", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({ sessionId: "dead-process-session", pid: 99999 });

    writeSessionState(entry.sessionId, entry, dispatchDir);
    cleanupStale(dispatchDir, 24, () => false);

    const updated = readSessionState(entry.sessionId, dispatchDir);
    assert.ok(updated);
    assert.equal(updated.status, "ended");
    assert.ok(updated.endedAt);
  });

  it("preserves active sessions with alive PIDs", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({ sessionId: "alive-process-session", pid: 88888 });

    writeSessionState(entry.sessionId, entry, dispatchDir);
    cleanupStale(dispatchDir, 24, () => true);

    assert.deepEqual(readSessionState(entry.sessionId, dispatchDir), entry);
  });

  it("uses 24 hours as the default stale window", () => {
    const dispatchDir = getDispatchDir();
    const oldEntry = validEntry({
      sessionId: "default-window-old-session",
      status: "ended",
      endedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    });
    const freshEntry = validEntry({
      sessionId: "default-window-fresh-session",
      pid: 54321,
      status: "ended",
      endedAt: new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString(),
    });

    writeSessionState(oldEntry.sessionId, oldEntry, dispatchDir);
    writeSessionState(freshEntry.sessionId, freshEntry, dispatchDir);
    cleanupStale(dispatchDir, undefined, () => true);

    assert.equal(fs.existsSync(sessionDir(oldEntry.sessionId, dispatchDir)), false);
    assert.deepEqual(readSessionState(freshEntry.sessionId, dispatchDir), freshEntry);
  });

  it("supports custom stale windows", () => {
    const dispatchDir = getDispatchDir();
    const entry = validEntry({
      sessionId: "custom-window-session",
      status: "ended",
      endedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    });

    writeSessionState(entry.sessionId, entry, dispatchDir);
    cleanupStale(dispatchDir, 1, () => true);

    assert.equal(fs.existsSync(sessionDir(entry.sessionId, dispatchDir)), false);
  });

  it("is a no-op on an empty directory", () => {
    const dispatchDir = getDispatchDir();
    fs.mkdirSync(dispatchDir, { recursive: true });

    assert.doesNotThrow(() => cleanupStale(dispatchDir, 24, () => true));
    assert.deepEqual(readRegistry(dispatchDir), {});
  });
});

describe("migrateRegistryIfNeeded", () => {
  it("converts legacy registry.json entries to per-session state.json files", () => {
    const dispatchDir = getDispatchDir();
    ensureDir(dispatchDir);
    const first = validEntry({ sessionId: "legacy-session-a", pid: 10001 });
    const second = validEntry({ sessionId: "legacy-session-b", pid: 10002, status: "ended" });

    fs.writeFileSync(
      path.join(dispatchDir, "registry.json"),
      JSON.stringify({ [first.sessionId]: first, [second.sessionId]: second }, null, 2),
    );

    migrateRegistryIfNeeded(dispatchDir);

    assert.deepEqual(readSessionState(first.sessionId, dispatchDir), first);
    assert.deepEqual(readSessionState(second.sessionId, dispatchDir), second);
  });

  it("deletes registry.json after successful migration", () => {
    const dispatchDir = getDispatchDir();
    ensureDir(dispatchDir);
    const entry = validEntry({ sessionId: "legacy-delete-session" });

    fs.writeFileSync(path.join(dispatchDir, "registry.json"), JSON.stringify({ [entry.sessionId]: entry }));
    migrateRegistryIfNeeded(dispatchDir);

    assert.equal(fs.existsSync(path.join(dispatchDir, "registry.json")), false);
  });

  it("is a no-op when registry.json does not exist", () => {
    const dispatchDir = getDispatchDir();

    assert.doesNotThrow(() => migrateRegistryIfNeeded(dispatchDir));
    assert.deepEqual(readRegistry(dispatchDir), {});
  });

  it("does not overwrite existing state.json files", () => {
    const dispatchDir = getDispatchDir();
    const existing = validEntry({ sessionId: "existing-session", pid: 30001, label: "existing" });
    const legacy = validEntry({ sessionId: "existing-session", pid: 30002, label: "legacy" });

    writeSessionState(existing.sessionId, existing, dispatchDir);
    fs.writeFileSync(path.join(dispatchDir, "registry.json"), JSON.stringify({ [legacy.sessionId]: legacy }));

    migrateRegistryIfNeeded(dispatchDir);

    assert.deepEqual(readSessionState(existing.sessionId, dispatchDir), existing);
  });

  it("skips invalid entries during migration", () => {
    const dispatchDir = getDispatchDir();
    ensureDir(dispatchDir);
    const valid = validEntry({ sessionId: "valid-legacy-session" });

    fs.writeFileSync(
      path.join(dispatchDir, "registry.json"),
      JSON.stringify(
        {
          [valid.sessionId]: valid,
          "invalid-legacy-session": { cwd: "/tmp/test" },
        },
        null,
        2,
      ),
    );

    migrateRegistryIfNeeded(dispatchDir);

    assert.deepEqual(readSessionState(valid.sessionId, dispatchDir), valid);
    assert.equal(readSessionState("invalid-legacy-session", dispatchDir), undefined);
  });

  it("creates session directories as needed during migration", () => {
    const dispatchDir = getDispatchDir();
    ensureDir(dispatchDir);
    const entry = validEntry({ sessionId: "create-session-dir-on-migrate" });

    fs.writeFileSync(path.join(dispatchDir, "registry.json"), JSON.stringify({ [entry.sessionId]: entry }));
    migrateRegistryIfNeeded(dispatchDir);

    assert.equal(fs.existsSync(sessionDir(entry.sessionId, dispatchDir)), true);
    assert.equal(fs.existsSync(path.join(sessionDir(entry.sessionId, dispatchDir), "state.json")), true);
  });
});

describe("appendMsg and readMsgs", () => {
  it("round-trips an appended message", () => {
    const filePath = path.join(getDispatchDir(), "session-1", "msgs.jsonl");
    const message = validMessage();

    appendMsg(filePath, message);

    assert.deepEqual(readMsgs(filePath), [message]);
  });

  it("multiple appends create valid JSONL", () => {
    const filePath = path.join(getDispatchDir(), "session-1", "msgs.jsonl");
    const first = validMessage({ content: "first" });
    const second = validMessage({ content: "second" });
    const third = validMessage({ content: "third" });

    appendMsg(filePath, first);
    appendMsg(filePath, second);
    appendMsg(filePath, third);

    const rawLines = fs.readFileSync(filePath, "utf-8").trim().split("\n");
    assert.equal(rawLines.length, 3);
    assert.deepEqual(readMsgs(filePath), [first, second, third]);
  });

  it("readMsgs returns an empty array for a nonexistent file", () => {
    const filePath = path.join(getDispatchDir(), "missing", "msgs.jsonl");

    assert.deepEqual(readMsgs(filePath), []);
  });

  it("readMsgs handles an empty file", () => {
    const filePath = path.join(getDispatchDir(), "session-1", "msgs.jsonl");
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(filePath, "");

    assert.deepEqual(readMsgs(filePath), []);
  });

  it("readMsgs skips malformed lines gracefully", () => {
    const filePath = path.join(getDispatchDir(), "session-1", "msgs.jsonl");
    const first = validMessage({ content: "before malformed" });
    const second = validMessage({ content: "after malformed" });
    ensureDir(path.dirname(filePath));
    fs.writeFileSync(
      filePath,
      `${JSON.stringify(first)}\nnot-json\n${JSON.stringify(second)}\n`,
    );

    assert.deepEqual(readMsgs(filePath), [first, second]);
  });
});

describe("session isolation", () => {
  it("two sessions do not clobber each other when writing and updating state", () => {
    const dispatchDir = getDispatchDir();
    const first = validEntry({ sessionId: "session-one", pid: 40101, label: "first" });
    const second = validEntry({ sessionId: "session-two", pid: 40102, label: "second" });

    writeSessionState(first.sessionId, first, dispatchDir);
    writeSessionState(second.sessionId, second, dispatchDir);

    assert.deepEqual(readRegistry(dispatchDir), {
      [first.sessionId]: first,
      [second.sessionId]: second,
    });

    const updatedFirst = { ...first, status: "ended" as const, endedAt: new Date().toISOString() };
    writeSessionState(updatedFirst.sessionId, updatedFirst, dispatchDir);

    assert.deepEqual(readSessionState(updatedFirst.sessionId, dispatchDir), updatedFirst);
    assert.deepEqual(readSessionState(second.sessionId, dispatchDir), second);
    assert.deepEqual(readRegistry(dispatchDir), {
      [updatedFirst.sessionId]: updatedFirst,
      [second.sessionId]: second,
    });
  });
});
