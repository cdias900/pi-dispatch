/**
 * Dispatch Extension — Bidirectional inter-session messaging for Pi
 *
 * Enables an orchestrator session to communicate with child sessions
 * and vice versa, using file-based message passing.
 *
 * Architecture:
 *   ~/.pi/dispatch/
 *     registry.json              # All active sessions
 *     <session-id>/
 *       inbox.jsonl              # Messages TO this session
 *       outbox.jsonl             # Messages FROM this session
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { Box, Container, Text } from "@mariozechner/pi-tui";

const DISPATCH_DIR = path.join(process.env.HOME ?? "/tmp", ".pi", "dispatch");
const ITERM_PY = path.join(process.env.HOME ?? "/tmp", ".local", "iterm2-env", "bin", "python3");

const STALE_HOURS = 24; // Keep ended sessions for 24h before cleanup

interface RegistryEntry {
  sessionId: string;
  cwd: string;
  pid: number;
  startedAt: string;
  endedAt?: string; // Set when session shuts down
  status: "active" | "ended";
  label?: string;
  itermSessionId?: string; // iTerm2 session ID for tab management
  spawnedBy?: string; // Session ID of the parent that spawned this
}

interface Message {
  ts: string;
  from: string;
  fromName?: string;
  type: string; // message | task | status | complete | error | question
  content: string;
}

function ensureDir(dir: string) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function sessionDir(id: string) {
  return path.join(DISPATCH_DIR, id);
}

function readRegistry(): Record<string, RegistryEntry> {
  try {
    return JSON.parse(fs.readFileSync(path.join(DISPATCH_DIR, "registry.json"), "utf-8"));
  } catch {
    return {};
  }
}

function writeRegistry(reg: Record<string, RegistryEntry>) {
  ensureDir(DISPATCH_DIR);
  fs.writeFileSync(path.join(DISPATCH_DIR, "registry.json"), JSON.stringify(reg, null, 2));
}

/** Remove ended sessions older than STALE_HOURS and their directories */
function cleanupStale(reg: Record<string, RegistryEntry>, staleHours?: number): Record<string, RegistryEntry> {
  const cutoff = Date.now() - (staleHours ?? STALE_HOURS) * 60 * 60 * 1000;
  let changed = false;
  for (const [id, entry] of Object.entries(reg)) {
    if (entry.status === "ended" && entry.endedAt && new Date(entry.endedAt).getTime() < cutoff) {
      delete reg[id];
      changed = true;
      try {
        const dir = sessionDir(id);
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
      } catch {}
    }
  }
  if (changed) writeRegistry(reg);
  return reg;
}

function appendMsg(filePath: string, msg: Message) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(msg) + "\n");
}

function readMsgs(filePath: string): Message[] {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
}

export default function (pi: ExtensionAPI) {
  let myId = "";
  let myDir = "";
  let inboxPath = "";
  let outboxPath = "";
  let lastInboxCount = 0;
  let watcher: fs.FSWatcher | null = null;
  let sessionCtx: { hasUI: boolean; ui: { setWidget: (key: string, content: string[] | undefined, opts?: { placement?: string }) => void; notify: (msg: string, type?: string) => void } } | null = null;

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
  pi.on("session_start", async (_event, ctx) => {
    // Determine our dispatch ID. On /resume, try to reclaim our previous ID
    // so children's spawnedBy references still work.
    const candidateId = `anon-${process.pid}`;
    const existingReg = readRegistry();

    // Check if there's a previous entry from this same cwd that children reference
    const previousEntry = Object.values(existingReg).find(
      (e) => e.status === "active" && e.cwd === process.cwd() && e.sessionId !== candidateId
        && Object.values(existingReg).some((child) => child.spawnedBy === e.sessionId && child.status === "active"),
    );

    if (previousEntry) {
      // Reclaim the old ID so children can still reach us
      myId = previousEntry.sessionId;
    } else {
      myId = candidateId;
    }
    myDir = sessionDir(myId);
    inboxPath = path.join(myDir, "inbox.jsonl");
    outboxPath = path.join(myDir, "outbox.jsonl");

    ensureDir(myDir);
    if (!fs.existsSync(inboxPath)) fs.writeFileSync(inboxPath, "");
    if (!fs.existsSync(outboxPath)) fs.writeFileSync(outboxPath, "");

    // Register in global registry + clean up stale sessions
    const reg = cleanupStale(readRegistry());
    const entry: RegistryEntry = { sessionId: myId, cwd: process.cwd(), pid: process.pid, startedAt: new Date().toISOString(), status: "active" };

    // Check if we were spawned by an orchestrator — pick up iTerm session ID
    try {
      const pendingFiles = fs.readdirSync(DISPATCH_DIR).filter((f) => f.startsWith("_pending_iterm_"));
      for (const pf of pendingFiles) {
        // We can't know which pending file is ours by iTerm ID alone,
        // so we claim the most recent one (there should only be one at a time in practice)
        const pfPath = path.join(DISPATCH_DIR, pf);
        const data = JSON.parse(fs.readFileSync(pfPath, "utf-8"));
        entry.itermSessionId = data.itermSessionId;
        entry.spawnedBy = data.spawnedBy;
        if (data.name) entry.label = data.name;
        fs.unlinkSync(pfPath);
        break;
      }
    } catch {}

    reg[myId] = entry;
    writeRegistry(reg);

    // Skip old inbox messages
    lastInboxCount = readMsgs(inboxPath).length;

    // Watch inbox for new messages — near-instant delivery
    // Delay watcher setup slightly to ensure renderer is fully registered
    setTimeout(() => {
      try {
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
    }, 500);

    // Update label from Pi session name right away
    try {
      const piName = pi.getSessionName?.();
      if (piName && reg[myId] && reg[myId].label !== piName) {
        reg[myId].label = piName;
        writeRegistry(reg);
      }
    } catch {}

    if (ctx.hasUI) ctx.ui.notify(`Dispatch: ${myId.slice(0, 12)}`, "info");

    sessionCtx = ctx as typeof sessionCtx;
    updateWidget();
  });

  pi.on("session_shutdown", async () => {
    if (sessionCtx?.hasUI) sessionCtx.ui.setWidget("dispatch", undefined);
    watcher?.close();
    watcher = null;
    // Mark as ended — keep for STALE_HOURS so orchestrator can read outbox
    try {
      const reg = readRegistry();
      if (reg[myId]) {
        reg[myId].status = "ended";
        reg[myId].endedAt = new Date().toISOString();
        writeRegistry(reg);
      }
    } catch {}
    // Don't delete the session dir — outbox may still have unread messages
  });

  // --- Helper: resolve target ID ---
  function resolveTarget(target: string): string | undefined {
    if (target === "orchestrator") {
      const reg = readRegistry();
      const myEntry = reg[myId];

      // 1. If we were spawned by someone, that's our orchestrator
      if (myEntry?.spawnedBy && reg[myEntry.spawnedBy]?.status === "active") {
        return myEntry.spawnedBy;
      }

      // 2. Find by label containing "orchestrator"
      const match = Object.values(reg).find(
        (e) => e.sessionId !== myId && e.status === "active" && e.label?.toLowerCase().includes("orchestrator"),
      );
      if (match) return match.sessionId;

      // 3. Last fallback: any other active session (only works for 2-session setups)
      const other = Object.values(reg).find((e) => e.sessionId !== myId && e.status === "active");
      return other?.sessionId;
    }
    return target;
  }

  // --- Helper: sync our label in the registry ---
  function syncMyLabel() {
    try {
      const piName = pi.getSessionName?.();
      if (piName) {
        const reg = readRegistry();
        if (reg[myId] && reg[myId].label !== piName) {
          reg[myId].label = piName;
          writeRegistry(reg);
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

  // --- Helper: update the belowEditor widget showing active children ---
  function updateWidget() {
    try {
      if (!sessionCtx?.hasUI || !myId) return;
      const reg = readRegistry();
      const activeChildren = Object.values(reg).filter(
        (e) => e.spawnedBy === myId && e.status === "active",
      );

      if (activeChildren.length === 0) {
        sessionCtx.ui.setWidget("dispatch", undefined);
        return;
      }

      const lines: string[] = [];
      for (const child of activeChildren) {
        const name = child.label ?? child.sessionId.slice(0, 12);
        // Read last message from child's outbox for status context
        const childOutbox = path.join(sessionDir(child.sessionId), "outbox.jsonl");
        const msgs = readMsgs(childOutbox);
        const lastMsg = msgs.length > 0 ? msgs[msgs.length - 1] : null;

        let statusText = "active";
        if (lastMsg) {
          const icon =
            lastMsg.type === "complete" ? "✅" :
            lastMsg.type === "error" ? "❌" :
            lastMsg.type === "question" ? "❓" :
            lastMsg.type === "status" ? "📡" : "📨";
          const truncated = lastMsg.content.length > 60
            ? lastMsg.content.slice(0, 57) + "..."
            : lastMsg.content;
          statusText = `${icon} ${truncated}`;
        }

        lines.push(`🏃 ${name} — ${statusText}`);
      }

      sessionCtx.ui.setWidget("dispatch", lines, { placement: "belowEditor" });
    } catch {
      /* widget update errors are non-fatal */
    }
  }

  // --- Helper: send message to a target ---
  function sendToTarget(targetInput: string, content: string, msgType: string): string {
    const reg = readRegistry();
    const targetId = resolveTarget(targetInput);
    const displayName = myDisplayName();

    // Also update our label in the registry while we're at it
    if (reg[myId]) {
      const piName = pi.getSessionName?.();
      if (piName && reg[myId].label !== piName) {
        reg[myId].label = piName;
        writeRegistry(reg);
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
        const reg = cleanupStale(readRegistry());
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
      const reg = cleanupStale(readRegistry(), 1); // Auto-cleanup sessions ended >1hr ago
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
      if (args.model) piCmd += ` --model '${args.model}'`;

      if (args.extensions) {
        for (const ext of args.extensions.split(",").map((s) => s.trim()).filter(Boolean)) {
          piCmd += ` -e '${ext}'`;
        }
      }

      if (args.skills) {
        for (const s of args.skills.split(",").map((s) => s.trim()).filter(Boolean)) {
          piCmd += ` --skill '${s}'`;
        }
      }

      // Escape the task for shell
      const escapedTask = task.replace(/'/g, "'\\''");
      piCmd += ` '${escapedTask}'`;

      // Write Python script to temp file to avoid shell escaping issues
      const tmpScript = path.join(DISPATCH_DIR, `_spawn_${Date.now()}.py`);
      const shellCmd = `cd ${taskDir} && ${piCmd}`;
      const pyScript = [
        "import iterm2",
        "",
        "async def main(connection):",
        "    app = await iterm2.async_get_app(connection)",
        "    window = app.current_window",
        "    if not window:",
        '        print("ERROR: No iTerm2 window found")',
        "        return",
        "    tab = await window.async_create_tab()",
        "    session = tab.current_session",
        `    cmd = ${JSON.stringify(shellCmd)} + chr(13)`,
        "    await session.async_send_text(cmd)",
        "    print(f'SPAWNED:{session.session_id}')",
        "",
        "iterm2.run_until_complete(main)",
      ].join("\n");

      fs.writeFileSync(tmpScript, pyScript);

      try {
        const result = execSync(`${ITERM_PY} ${tmpScript}`, {
          timeout: 10000,
          encoding: "utf-8",
        }).trim();

        // Clean up temp script
        try { fs.unlinkSync(tmpScript); } catch {}

        const match = result.match(/SPAWNED:(.+)/);
        if (match) {
          const itermId = match[1];
          const childName = args.name || undefined;
          // Save iTerm session ID + name so we can map it when the child registers
          const pendingFile = path.join(DISPATCH_DIR, `_pending_iterm_${itermId}.json`);
          fs.writeFileSync(pendingFile, JSON.stringify({ itermSessionId: itermId, spawnedBy: myId, name: childName }));

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
      const reg = readRegistry();
      const entry = reg[args.target];

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
          writeRegistry(reg);
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
          timeout: 10000,
          encoding: "utf-8",
        }).trim();

        try { fs.unlinkSync(tmpScript); } catch {}

        // Mark as ended in registry
        entry.status = "ended";
        entry.endedAt = new Date().toISOString();
        writeRegistry(reg);
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
