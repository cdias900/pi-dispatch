/**
 * Dispatch Extension — Bidirectional inter-session messaging for Pi
 *
 * Enables an orchestrator session to communicate with child sessions
 * and vice versa, using file-based message passing.
 *
 * Architecture:
 *   ~/.pi/dispatch/
 *     registry.json              # Legacy registry, auto-migrated if present
 *     <session-id>/
 *       state.json               # Session state
 *       inbox.jsonl              # Messages TO this session
 *       outbox.jsonl             # Messages FROM this session
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Container, Text } from "@mariozechner/pi-tui";
import {
  readRegistry as _readRegistry,
  writeSessionState as _writeSessionState,
  readSessionState as _readSessionState,
  cleanupStale as _cleanupStale,
  migrateRegistryIfNeeded as _migrateRegistryIfNeeded,
  appendMsg, readMsgs, ensureDir,
  sessionDir as _sessionDir,
  isValidEntry,
  type RegistryEntry,
  type Message,
} from "./dispatch-core.ts";

const DISPATCH_DIR = path.join(os.homedir(), ".pi", "dispatch");
const ITERM_PY = path.join(os.homedir(), ".local", "iterm2-env", "bin", "python3");

const STALE_HOURS = 24; // Keep ended sessions for 24h before cleanup

const readRegistry = () => _readRegistry(DISPATCH_DIR);
const writeSessionState = (id: string, entry: RegistryEntry) => _writeSessionState(id, entry, DISPATCH_DIR);
const readSessionState = (id: string) => _readSessionState(id, DISPATCH_DIR);
const cleanupStale = (staleHours: number = STALE_HOURS) => _cleanupStale(DISPATCH_DIR, staleHours);
const migrateRegistryIfNeeded = () => _migrateRegistryIfNeeded(DISPATCH_DIR);
const sessionDir = (id: string) => _sessionDir(id, DISPATCH_DIR);

const DISPATCH_GLOBAL_KEY = "__pi_dispatch_state";

interface DispatchPersistedState {
  myId: string;
  spawnedBy?: string;
  label?: string;
  itermSessionId?: string;
  lastInboxCount: number;
}

export default function (pi: ExtensionAPI) {
  let myId = "";
  let myDir = "";
  let inboxPath = "";
  let outboxPath = "";
  let lastInboxCount = 0;
  let watcher: fs.FSWatcher | null = null;
  let watcherTimeout: ReturnType<typeof setTimeout> | null = null;
  let sessionCtx: { hasUI: boolean; ui: { setWidget: (key: string, content: string[] | undefined) => void; notify: (msg: string, type?: string) => void } } | null = null;
  let widgetInterval: ReturnType<typeof setInterval> | null = null;

  // --- Custom renderer for dispatch messages ---
  pi.registerMessageRenderer("dispatch", (message, options, theme) => {
    let from = "unknown";
    let msgType = "message";
    let ts = "";

    try {
      const d = message.details as Record<string, string> | undefined;
      if (d) {
        from = d.from || "unknown";
        msgType = d.type || "message";
        ts = d.ts || "";
      }
    } catch {
      // details parsing failed — use defaults
    }

    const prefix =
      msgType === "complete" ? "✅" :
      msgType === "error" ? "❌" :
      msgType === "question" ? "❓" :
      msgType === "task" ? "🎯" :
      "📨";

    let text = `${prefix} ${theme.fg("accent", from)}: ${message.content}`;
    if (options.expanded && ts) {
      text += `\n${theme.fg("dim", `  at ${ts}`)}`;
    }

    const box = new Box(1, 1, (t2) => theme.bg("customMessageBg", t2));
    box.addChild(new Text(text, 0, 0));
    return box;
  });

  // --- Session lifecycle ---
  pi.on("session_start", async (event, ctx) => {
    const candidateId = `anon-${process.pid}`;
    let savedState: DispatchPersistedState | undefined;
    let reclaimedFrom: RegistryEntry | undefined;

    try {
      migrateRegistryIfNeeded();

      // On reload, restore identity from globalThis (survives module reimport)
      if (event.reason === "reload") {
        const persisted = (globalThis as any)[DISPATCH_GLOBAL_KEY] as DispatchPersistedState | undefined;
        if (persisted?.myId) {
          myId = persisted.myId;
          savedState = persisted;
        }
      }
      // Always clean up globalThis to prevent stale carry-over
      delete (globalThis as any)[DISPATCH_GLOBAL_KEY];

      // Determine our dispatch ID. On /resume, try to reclaim our previous ID
      // so children's spawnedBy references still work.
      if (!myId) {
        const existingReg = readRegistry();
        const RECLAIM_WINDOW_MS = 60_000;
        const now = Date.now();

        const previousEntry = Object.values(existingReg).find((e) => {
          if (e.cwd !== process.cwd()) return false;
          if (typeof e.sessionId !== "string" || !e.sessionId.length) return false;
          if (e.sessionId === candidateId) return false;

          const hasActiveChildren = Object.values(existingReg).some(
            (child) =>
              typeof child.spawnedBy === "string"
              && child.spawnedBy.length > 0
              && child.spawnedBy === e.sessionId
              && child.status === "active",
          );
          if (!hasActiveChildren) return false;

          if (e.status === "active") {
            try {
              process.kill(e.pid, 0);
              return false; // Process alive — not ours to reclaim
            } catch {
              return true; // Process dead — safe to reclaim
            }
          }

          if (e.status === "ended" && e.endedAt) {
            return (now - new Date(e.endedAt).getTime()) < RECLAIM_WINDOW_MS;
          }

          return false;
        });

        if (previousEntry) {
          myId = previousEntry.sessionId;
          reclaimedFrom = previousEntry;
        } else {
          myId = candidateId;
        }
      }

      // Safety net
      if (!myId || typeof myId !== "string") {
        myId = candidateId;
      }

      myDir = sessionDir(myId);
      inboxPath = path.join(myDir, "inbox.jsonl");
      outboxPath = path.join(myDir, "outbox.jsonl");

      ensureDir(myDir);
      if (!fs.existsSync(inboxPath)) fs.writeFileSync(inboxPath, "");
      if (!fs.existsSync(outboxPath)) fs.writeFileSync(outboxPath, "");

      // Register in global registry + clean up stale sessions
      cleanupStale();
      const reg = readRegistry();
      const entry: RegistryEntry = {
        sessionId: myId,
        cwd: process.cwd(),
        pid: process.pid,
        startedAt: new Date().toISOString(),
        status: "active",
      };

      // Carry forward metadata from saved state (reload) or existing registry entry
      const existingEntry = reg[myId];
      if (savedState) {
        if (savedState.spawnedBy) entry.spawnedBy = savedState.spawnedBy;
        if (savedState.label) entry.label = savedState.label;
        if (savedState.itermSessionId) entry.itermSessionId = savedState.itermSessionId;
      } else if (existingEntry) {
        if (existingEntry.spawnedBy) entry.spawnedBy = existingEntry.spawnedBy;
        if (existingEntry.label) entry.label = existingEntry.label;
        if (existingEntry.itermSessionId) entry.itermSessionId = existingEntry.itermSessionId;
      }

      // Only claim pending spawn metadata on fresh starts (not reloads or reclaims with existing metadata)
      if (!savedState && !entry.spawnedBy) {
        try {
          const myItermId = process.env.DISPATCH_ITERM_ID;
          if (myItermId) {
            // Exact match via env var — deterministic correlation
            const pfPath = path.join(DISPATCH_DIR, `_pending_iterm_${myItermId}.json`);
            if (fs.existsSync(pfPath)) {
              const data = JSON.parse(fs.readFileSync(pfPath, "utf-8"));
              entry.itermSessionId = myItermId;
              entry.spawnedBy = data.spawnedBy;
              if (data.name) entry.label = data.name;
              fs.unlinkSync(pfPath);
            }
          } else {
            // Fallback for manually-started sessions: claim first pending file
            const pendingFiles = fs.readdirSync(DISPATCH_DIR).filter((f) => f.startsWith("_pending_iterm_"));
            for (const pf of pendingFiles) {
              const pfPath = path.join(DISPATCH_DIR, pf);
              const data = JSON.parse(fs.readFileSync(pfPath, "utf-8"));
              entry.itermSessionId = data.itermSessionId;
              entry.spawnedBy = data.spawnedBy;
              if (data.name) entry.label = data.name;
              fs.unlinkSync(pfPath);
              break;
            }
          }
        } catch {}
      }

      writeSessionState(myId, entry);

      // Skip old inbox messages
      if (savedState) {
        // Reload: continue from where we left off
        lastInboxCount = savedState.lastInboxCount;
      } else if (reclaimedFrom?.endedAt) {
        // Restart/reclaim: replay messages that arrived after the previous session ended
        const allMsgs = readMsgs(inboxPath);
        const endedAt = new Date(reclaimedFrom.endedAt).getTime();
        const gapStart = allMsgs.findIndex((m) => new Date(m.ts).getTime() > endedAt);
        if (gapStart >= 0) {
          lastInboxCount = gapStart;
        } else {
          lastInboxCount = allMsgs.length;
        }
      } else if (reclaimedFrom) {
        // Reclaimed a dead-active entry without endedAt — replay recent messages
        const allMsgs = readMsgs(inboxPath);
        const recentCutoff = Date.now() - 60_000;
        const gapStart = allMsgs.findIndex((m) => new Date(m.ts).getTime() > recentCutoff);
        if (gapStart >= 0) {
          lastInboxCount = gapStart;
        } else {
          lastInboxCount = allMsgs.length;
        }
      } else {
        // Fresh start: treat all existing messages as old
        lastInboxCount = readMsgs(inboxPath).length;
      }

      // Process any messages that arrived during the reload/restart gap
      const currentMsgs = readMsgs(inboxPath);
      if (currentMsgs.length > lastInboxCount) {
        const backlog = currentMsgs.slice(lastInboxCount);
        lastInboxCount = currentMsgs.length;
        // Deliver backlog after a short delay to ensure UI is ready
        setTimeout(() => {
          for (const msg of backlog) {
            pi.sendMessage(
              {
                customType: "dispatch",
                content: msg.content || "(empty)",
                display: true,
                details: { from: msg.fromName ?? msg.from, type: msg.type, ts: msg.ts },
              },
              { triggerTurn: true },
            );
          }
        }, 100);
      }

      // Watch inbox for new messages — near-instant delivery
      // Delay watcher setup slightly to ensure renderer is fully registered
      watcherTimeout = setTimeout(() => {
        try {
          watcherTimeout = null;
          watcher = fs.watch(inboxPath, () => {
            try {
              const all = readMsgs(inboxPath);
              const newMsgs = all.slice(lastInboxCount);
              if (newMsgs.length === 0) return;
              lastInboxCount = all.length;

              for (const msg of newMsgs) {
                pi.sendMessage(
                  {
                    customType: "dispatch",
                    content: msg.content || "(empty)",
                    display: true,
                    details: { from: msg.fromName ?? msg.from, type: msg.type, ts: msg.ts },
                  },
                  { triggerTurn: true },
                );
              }
              updateWidget();
            } catch {
              /* ignore watch errors */
            }
          });
        } catch {
          /* fs.watch not available */
        }
      }, 50);

      // Update label from Pi session name right away
      try {
        const piName = pi.getSessionName?.();
        const myEntry = readSessionState(myId);
        if (piName && myEntry && myEntry.label !== piName) {
          myEntry.label = piName;
          writeSessionState(myId, myEntry);
        }
      } catch {}

      if (ctx.hasUI) ctx.ui.notify(`Dispatch: ${myId.slice(0, 12)}`, "info");

      sessionCtx = ctx as typeof sessionCtx;
      updateWidget();
    } catch (error) {
      console.error("Dispatch session_start failed:", error);

      if (!myId || typeof myId !== "string") {
        myId = candidateId;
      }
      if (!myDir) {
        myDir = sessionDir(myId);
      }
      if (!inboxPath) {
        inboxPath = path.join(myDir, "inbox.jsonl");
      }
      if (!outboxPath) {
        outboxPath = path.join(myDir, "outbox.jsonl");
      }

      try {
        ensureDir(myDir);
        if (!fs.existsSync(inboxPath)) fs.writeFileSync(inboxPath, "");
        if (!fs.existsSync(outboxPath)) fs.writeFileSync(outboxPath, "");

        // Best-effort: register in registry so we're at least discoverable
        try {
          const fallbackEntry: RegistryEntry = {
            sessionId: myId,
            cwd: process.cwd(),
            pid: process.pid,
            startedAt: new Date().toISOString(),
            status: "active",
          };
          const itermId = process.env.DISPATCH_ITERM_ID;
          if (itermId) {
            const pfPath = path.join(DISPATCH_DIR, `_pending_iterm_${itermId}.json`);
            if (fs.existsSync(pfPath)) {
              const data = JSON.parse(fs.readFileSync(pfPath, "utf-8")) as { spawnedBy?: string; name?: string };
              fallbackEntry.itermSessionId = itermId;
              fallbackEntry.spawnedBy = data.spawnedBy;
              if (data.name) fallbackEntry.label = data.name;
              fs.unlinkSync(pfPath);
            }
          }
          writeSessionState(myId, fallbackEntry);
        } catch {}
      } catch (fallbackError) {
        console.error("Dispatch session_start fallback failed:", fallbackError);
      }
    }
  });

  pi.on("session_shutdown", async () => {
    if (sessionCtx?.hasUI) sessionCtx.ui.setWidget("dispatch-children", undefined);

    if (watcherTimeout) { clearTimeout(watcherTimeout); watcherTimeout = null; }
    watcher?.close();
    watcher = null;
    if (widgetInterval) { clearInterval(widgetInterval); widgetInterval = null; }

    // Save state to globalThis so a reload can recover identity
    try {
      const myEntry = readSessionState(myId);
      (globalThis as any)[DISPATCH_GLOBAL_KEY] = {
        myId,
        spawnedBy: myEntry?.spawnedBy,
        label: myEntry?.label,
        itermSessionId: myEntry?.itermSessionId,
        lastInboxCount,
      } as DispatchPersistedState;

      if (myEntry) {
        myEntry.status = "ended";
        myEntry.endedAt = new Date().toISOString();
        writeSessionState(myId, myEntry);
      }
    } catch {}
  });

  // --- Helper: resolve target ID ---
  function resolveTarget(target: string): string | undefined {
    if (target === "orchestrator") {
      const reg = readRegistry();
      const myEntry = reg[myId];

      // 1. If we know our parent, resolve to them if their inbox still exists
      // (even if they're "ended" — they may be reloading and will come back)
      if (myEntry?.spawnedBy) {
        const parentInbox = path.join(sessionDir(myEntry.spawnedBy), "inbox.jsonl");
        if (fs.existsSync(parentInbox)) {
          return myEntry.spawnedBy;
        }
      }

      // 2. Find by label containing "orchestrator"
      const match = Object.values(reg).find(
        (e) => e.sessionId !== myId
          && e.status === "active"
          && e.cwd === process.cwd()
          && e.label?.toLowerCase().includes("orchestrator"),
      );
      if (match) return match.sessionId;

      return undefined;
    }
    return target;
  }

  // --- Helper: sync our label in the registry ---
  function syncMyLabel() {
    try {
      const piName = pi.getSessionName?.();
      if (piName) {
        const entry = readSessionState(myId);
        if (entry && entry.label !== piName) {
          entry.label = piName;
          writeSessionState(myId, entry);
        }
      }
    } catch {}
  }

  // --- Helper: get our display name (session label or short ID) ---
  function myDisplayName(): string {
    // Prefer Pi's session label (set by set_session_label), then registry label, then short ID
    const piName = pi.getSessionName?.();
    if (piName) return piName;
    const reg = readRegistry();
    return reg[myId]?.label ?? myId.slice(0, 12);
  }

  // --- Helper: update widget showing active children ---
  function updateWidget() {
    try {
      if (!sessionCtx?.hasUI || !myId) return;
      const reg = readRegistry();
      const activeChildren = Object.values(reg).filter(
        (e) => e.sessionId !== myId && e.spawnedBy === myId && e.status === "active",
      );

      if (activeChildren.length === 0) {
        sessionCtx.ui.setWidget("dispatch-children", undefined);
        if (widgetInterval) {
          clearInterval(widgetInterval);
          widgetInterval = null;
        }
        return;
      }

      // Keep elapsed time ticking while children are active
      if (!widgetInterval) {
        widgetInterval = setInterval(updateWidget, 1000);
      }

      const lines: string[] = [];
      for (const child of activeChildren) {
        const name = child.label ?? child.sessionId.slice(0, 12);
        // Calculate elapsed time
        const elapsed = Math.floor((Date.now() - new Date(child.startedAt).getTime()) / 1000);
        const elapsedStr = elapsed >= 3600
          ? `${Math.floor(elapsed / 3600)}h ${Math.floor((elapsed % 3600) / 60)}m`
          : elapsed >= 60
            ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`
            : `${elapsed}s`;

        lines.push(`  🏃 ${name} — active (${elapsedStr})`);
      }

      lines.sort();
      sessionCtx.ui.setWidget("dispatch-children", [`🏃 Child agents (${activeChildren.length})`, ...lines]);
    } catch {
      /* widget update errors are non-fatal */
    }
  }

  // --- Helper: send message to a target ---
  function sendToTarget(targetInput: string, content: string, msgType: string): string {
    const targetId = resolveTarget(targetInput);
    const displayName = myDisplayName();

    // Also update our label in the registry while we're at it
    const myEntry = readSessionState(myId);
    if (myEntry) {
      const piName = pi.getSessionName?.();
      if (piName && myEntry.label !== piName) {
        myEntry.label = piName;
        writeSessionState(myId, myEntry);
      }
    }

    const msg: Message = {
      ts: new Date().toISOString(),
      from: myId,
      fromName: displayName,
      type: msgType || "message",
      content: content || "",
    };

    // Always write to our outbox
    appendMsg(outboxPath, msg);

    // Try target's inbox
    if (targetId) {
      const targetInbox = path.join(sessionDir(targetId), "inbox.jsonl");
      if (fs.existsSync(targetInbox)) {
        appendMsg(targetInbox, msg);
        return `Sent ${msgType} to ${targetId.slice(0, 12)}`;
      }
    }

    return `Written to outbox (target ${targetInput} inbox not found)`;
  }

  // --- Commands ---
  pi.registerCommand("dispatch", {
    description: "Inter-session messaging. /dispatch list | send <id> <msg> | read <id> | reply <msg>",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0];

      if (sub === "list") {
        cleanupStale();
        const reg = readRegistry();
        const entries = Object.values(reg);
        if (entries.length === 0) return ctx.ui.notify("No dispatch sessions", "info");
        const lines = entries.map((e) => {
          const self = e.sessionId === myId ? " ←" : "";
          const status = e.status === "ended" ? " [ended]" : "";
          return `${e.label ?? e.sessionId.slice(0, 12)}${self}${status} pid:${e.pid} ${e.cwd}`;
        });
        ctx.ui.notify(lines.join("\n"), "info");
      } else if (sub === "send" && parts[1]) {
        const result = sendToTarget(parts[1], parts.slice(2).join(" "), "message");
        ctx.ui.notify(result, "info");
      } else if (sub === "read" && parts[1]) {
        const msgs = readMsgs(path.join(sessionDir(parts[1]), "outbox.jsonl"));
        const recent = msgs.slice(-10);
        ctx.ui.notify(
          recent.length ? recent.map((m) => `[${m.type}] ${m.content}`).join("\n") : "No messages",
          "info",
        );
      } else if (sub === "reply") {
        const result = sendToTarget("orchestrator", parts.slice(1).join(" "), "status");
        ctx.ui.notify(result, "info");
      } else {
        ctx.ui.notify("/dispatch list | send <id> <msg> | read <id> | reply <msg>", "warning");
      }
    },
  });

  // --- Tools ---
  pi.registerTool({
    name: "dispatch_send",
    description:
      "Send a message to another Pi session. Use this to communicate with the orchestrator or other child sessions. Types: message (general), status (progress update), complete (task done), error (something failed), question (need input).",
    parameters: Type.Object({
      target: Type.String({
        description: "Target session ID (use 'orchestrator' for the parent session, or a specific session ID)",
      }),
      content: Type.String({ description: "Message content" }),
      type: Type.String({
        description: "Message type: 'message' (general), 'task' (action needed), 'status' (progress update), 'complete' (task done), 'error' (something failed), 'question' (need input). Default: 'message'",
      }),
    }),
    execute: async (_toolCallId, args) => {
      const result = sendToTarget(args.target, args.content, args.type ?? "message");
      updateWidget();
      return { content: [{ type: "text" as const, text: result }] };
    },
  });

  pi.registerTool({
    name: "dispatch_read",
    description: "Read messages from another session's outbox, or from your own inbox.",
    parameters: Type.Object({
      target: Type.Optional(
        Type.String({ description: "Session ID to read outbox from. Omit to read your own inbox." }),
      ),
      last: Type.Optional(Type.Number({ description: "Number of recent messages to read (default: 10)" })),
    }),
    execute: async (_toolCallId, args) => {
      const n = args.last ?? 10;
      const file = args.target ? path.join(sessionDir(args.target), "outbox.jsonl") : inboxPath;
      const msgs = readMsgs(file).slice(-n);
      if (msgs.length === 0) return { content: [{ type: "text" as const, text: "No messages." }] };
      const out = msgs.map((m) => `[${m.ts}] [${m.type}] ${m.fromName ?? m.from}: ${m.content}`).join("\n");
      return { content: [{ type: "text" as const, text: out }] };
    },
  });

  pi.registerTool({
    name: "dispatch_list",
    description: "List all active Pi sessions registered with the dispatch system.",
    parameters: Type.Object({}),
    execute: async (_toolCallId) => {
      syncMyLabel();
      cleanupStale(); // Auto-cleanup sessions using default retention window
      const reg = readRegistry();
      const entries = Object.values(reg);
      if (entries.length === 0) {
        updateWidget();
        return { content: [{ type: "text" as const, text: "No dispatch sessions." }] };
      }

      const active = entries.filter((e) => e.status === "active");
      const ended = entries.filter((e) => e.status === "ended");

      const lines: string[] = [];
      if (active.length > 0) {
        lines.push("ACTIVE:");
        for (const e of active) {
          const self = e.sessionId === myId ? " ← (this)" : "";
          const parent = e.spawnedBy ? ` [child of ${e.spawnedBy.slice(0, 8)}]` : "";
          lines.push(`  - ${e.sessionId.slice(0, 12)} | ${e.label ?? "unnamed"} | pid:${e.pid} | ${e.cwd}${self}${parent}`);
        }
      }
      if (ended.length > 0) {
        lines.push("ENDED (outbox readable):");
        for (const e of ended) {
          const ago = e.endedAt ? ` (${Math.round((Date.now() - new Date(e.endedAt).getTime()) / 60000)}m ago)` : "";
          lines.push(`  - ${e.sessionId.slice(0, 12)} | ${e.label ?? "unnamed"}${ago}`);
        }
      }
      updateWidget();
      return { content: [{ type: "text" as const, text: lines.join("\n") }] };
    },
  });

  // --- Spawn: create a new iTerm2 tab with a Pi session ---

  pi.registerTool({
    name: "dispatch_spawn",
    description:
      "Spawn a new Pi session in a new iTerm2 tab. The child session gets the dispatch extension auto-loaded so it can communicate back. Returns immediately — the child will send a message to your inbox when it's ready.",
    parameters: Type.Object({
      task: Type.String({ description: "The task/prompt to give the new Pi session" }),
      cwd: Type.Optional(Type.String({ description: "Working directory for the new session (default: current directory)" })),
      name: Type.Optional(Type.String({ description: "Human-readable name for this child session (shown in messages and dispatch_list)" })),
      model: Type.Optional(Type.String({ description: "Model to use (e.g. 'sonnet', 'opus'). Default: agent default" })),
      extensions: Type.Optional(Type.String({ description: "Comma-separated additional extensions to load (e.g. 'slack,gworkspace')" })),
      skills: Type.Optional(Type.String({ description: "Comma-separated skills to load (e.g. 'graphite,stack')" })),
    }),
    execute: async (_toolCallId, args) => {
      const shellEscape = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
      const taskDir = args.cwd ?? process.cwd();

      // Prepend child agent guidelines to the task
      const preamble = [
        "You were dispatched as a child session by an orchestrator. Follow these guidelines:",
        "",
        "ROLE: You are a middle-level manager. You receive projects/tasks from the orchestrator and break them into smaller pieces.",
        "",
        "WORKFLOW:",
        "1. On startup: FIRST use set_session_label to give yourself a short descriptive name. THEN use dispatch_list to see active sessions, then send a status to the orchestrator (dispatch_send target=orchestrator type=status) confirming you are ready.",
        "2. Default to using subagents (scout, planner, executor, reviewer) for all substantial work. You orchestrate — you don't implement inline.",
        "3. Report progress back to the orchestrator with dispatch_send (type=status for updates, type=complete when done, type=error if stuck, type=question if you need input).",
        "4. When your task is fully complete, send a final dispatch_send with type=complete summarizing what was accomplished.",
        "",
        "COMMUNICATION:",
        "- The orchestrator's session ID is your spawnedBy parent. Use target=orchestrator to reach it.",
        "- Be concise in status updates. The orchestrator is managing multiple children.",
        "- If you need the orchestrator's input, use type=question. Don't block silently.",
        "",
        "YOUR TASK:",
      ].join("\n");

      const task = preamble + "\n" + args.task;

      // Build the pi command — launch normally so all extensions/MCPs/skills auto-discover
      // dispatch.ts is in ~/.pi/agent/extensions/ so it loads automatically
      let piCmd = "pi";
      if (args.model) piCmd += ` --model ${shellEscape(args.model)}`;

      if (args.extensions) {
        for (const ext of args.extensions.split(",").map((s) => s.trim()).filter(Boolean)) {
          piCmd += ` -e ${shellEscape(ext)}`;
        }
      }

      if (args.skills) {
        for (const s of args.skills.split(",").map((s) => s.trim()).filter(Boolean)) {
          piCmd += ` --skill ${shellEscape(s)}`;
        }
      }

      piCmd += ` ${shellEscape(task)}`;

      // Write Python script to temp file to avoid shell escaping issues
      const tmpScript = path.join(DISPATCH_DIR, `_spawn_${Date.now()}.py`);
      const taskDirEscaped = shellEscape(taskDir);
      const piCmdStr = piCmd;
      const childName = args.name || undefined;

      // Pass spawn metadata to Python so it can write the pending file
      // BEFORE sending the pi command (avoids race condition where child
      // starts before the pending file exists)
      const spawnMeta = JSON.stringify({ spawnedBy: myId, name: childName });

      const pyScript = [
        "import iterm2",
        "import json",
        "import os",
        "",
        "async def main(connection):",
        "    app = await iterm2.async_get_app(connection)",
        "    window = app.current_window",
        "    if not window:",
        '        print("ERROR: No iTerm2 window found")',
        "        return",
        "    tab = await window.async_create_tab()",
        "    session = tab.current_session",
        "",
        "    # Write pending file BEFORE sending the pi command",
        "    # so the child can pick it up during session_start",
        `    meta = json.loads(${JSON.stringify(spawnMeta)})`,
        "    meta['itermSessionId'] = session.session_id",
        `    pending_path = os.path.join(${JSON.stringify(DISPATCH_DIR)}, f'_pending_iterm_{session.session_id}.json')`,
        "    with open(pending_path, 'w') as f:",
        "        json.dump(meta, f)",
        "",
        `    task_dir = ${JSON.stringify(taskDirEscaped)}`,
        `    pi_cmd = ${JSON.stringify(piCmdStr)}`,
        `    cmd = f"cd {task_dir} && DISPATCH_ITERM_ID='{session.session_id}' {pi_cmd}" + chr(13)`,
        "    await session.async_send_text(cmd)",
        "    print(f'SPAWNED:{session.session_id}')",
        "",
        "iterm2.run_until_complete(main)",
      ].join("\n");

      fs.writeFileSync(tmpScript, pyScript);

      try {
        const result = execSync(`${ITERM_PY} ${tmpScript}`, {
          timeout: 30000,
          encoding: "utf-8",
        }).trim();

        // Clean up temp script
        try { fs.unlinkSync(tmpScript); } catch {}

        const match = result.match(/SPAWNED:(.+)/);
        if (match) {
          const itermId = match[1];

          // Widget will update when child registers and sends its first message
          updateWidget();

          return {
            content: [
              {
                type: "text" as const,
                text: `Spawned new Pi session in iTerm2 tab.\niTerm session: ${itermId}\nDirectory: ${taskDir}\nTask: ${task}\n\nThe child session will register with dispatch and send a message when ready.`,
              },
            ],
          };
        }

        return { content: [{ type: "text" as const, text: `iTerm2 output: ${result}` }] };
      } catch (err: any) {
        try { fs.unlinkSync(tmpScript); } catch {}
        return {
          content: [{ type: "text" as const, text: `Failed to spawn: ${err.message ?? err}` }],
          isError: true,
        };
      }
    },
  });

  // --- Close: terminate a child session's iTerm2 tab ---

  pi.registerTool({
    name: "dispatch_close",
    description:
      "Close a child Pi session by terminating its iTerm2 tab. Use the session ID from dispatch_list.",
    parameters: Type.Object({
      target: Type.String({ description: "Session ID to close" }),
    }),
    execute: async (_toolCallId, args) => {
      const entry = readSessionState(args.target);

      if (!entry) {
        return { content: [{ type: "text" as const, text: `Session ${args.target} not found in registry.` }], isError: true };
      }

      const itermId = entry.itermSessionId;

      if (!itermId) {
        // No iTerm session ID — try killing by PID as fallback
        try {
          process.kill(entry.pid, "SIGTERM");
          entry.status = "ended";
          entry.endedAt = new Date().toISOString();
          writeSessionState(args.target, entry);
          updateWidget();
          return { content: [{ type: "text" as const, text: `Sent SIGTERM to pid ${entry.pid}. No iTerm session ID was recorded.` }] };
        } catch {
          return { content: [{ type: "text" as const, text: `No iTerm session ID and could not kill pid ${entry.pid}.` }], isError: true };
        }
      }

      // Close via iTerm2 Python API
      const tmpScript = path.join(DISPATCH_DIR, `_close_${Date.now()}.py`);
      const pyScript = [
        "import iterm2",
        "",
        "async def main(connection):",
        "    app = await iterm2.async_get_app(connection)",
        "    for window in app.terminal_windows:",
        "        for tab in window.tabs:",
        "            for session in tab.sessions:",
        `                if session.session_id == ${JSON.stringify(itermId)}:`,
        "                    await session.async_close(force=True)",
        `                    print("CLOSED:${itermId}")`,
        "                    return",
        `    print("NOT_FOUND:${itermId}")`,
        "",
        "iterm2.run_until_complete(main)",
      ].join("\n");

      fs.writeFileSync(tmpScript, pyScript);

      try {
        const result = execSync(`${ITERM_PY} ${tmpScript}`, {
          timeout: 30000,
          encoding: "utf-8",
        }).trim();

        try { fs.unlinkSync(tmpScript); } catch {}

        // Mark as ended in registry
        entry.status = "ended";
        entry.endedAt = new Date().toISOString();
        writeSessionState(args.target, entry);
        updateWidget();

        if (result.includes("CLOSED:")) {
          return { content: [{ type: "text" as const, text: `Closed session ${args.target.slice(0, 12)} (iTerm tab closed).` }] };
        }
        return { content: [{ type: "text" as const, text: `Session iTerm tab not found (may have already been closed). Marked as ended.` }] };
      } catch (err: any) {
        try { fs.unlinkSync(tmpScript); } catch {}
        return { content: [{ type: "text" as const, text: `Failed to close: ${err.message ?? err}` }], isError: true };
      }
    },
  });
}
