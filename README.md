# pi-dispatch

Multi-session orchestration extension for [Pi](https://pi.dev). Spawn, message, and manage child Pi sessions across iTerm2 tabs with bidirectional communication.

## What it does

Pi is a powerful coding agent, but a single session can get cluttered when managing many tasks. pi-dispatch lets any session become an **orchestrator** that spawns child sessions in separate iTerm2 tabs — each with its own context, tools, and interactive TUI that you can jump into at any time.

```
┌─────────────────────────────────────────────────┐
│ iTerm2                                           │
├──────────┬──────────────┬───────────────────────┤
│ Tab 0    │ Tab 1        │ Tab 2                 │
│ 🎯 Orch  │ 🛠️ PR fixes  │ 📊 Experiments        │
│          │              │                       │
│ dispatch │ Working on   │ Checking metrics...   │
│ _spawn() │ tests...     │                       │
│          │              │ dispatch_send(        │
│ [✅ DONE │              │   "orchestrator",     │
│  from    │ dispatch_send│   "All clear!")       │
│  PR fix] │ ("orch",     │                       │
│          │  "Done!")    │                       │
└──────────┴──────────────┴───────────────────────┘
```

### Key features

- **Spawn sessions** → `dispatch_spawn` creates a new iTerm2 tab with a Pi session
- **Bidirectional messaging** → orchestrator and children communicate via `dispatch_send`
- **Instant delivery** → messages arrive in real-time via filesystem watchers
- **Visual distinction** → incoming messages render as `[🎯 TASK]`, `[✅ DONE]`, `[📊 STATUS]` etc.
- **Auto-triggers** → task/question messages automatically wake the LLM to respond
- **Session registry** → `dispatch_list` shows active/ended sessions with parent-child relationships
- **Clean lifecycle** → `dispatch_close` terminates child tabs, sessions marked as ended with readable outboxes
- **You stay in control** → switch to any tab and interact with child sessions directly

## Requirements

- [Pi](https://pi.dev) coding agent
- iTerm2 (macOS)
- iTerm2 Python API: `python3 -m venv ~/.local/iterm2-env && ~/.local/iterm2-env/bin/pip install iterm2`
- Enable "Python API" in iTerm2 → Preferences → General → Magic

## Install

```bash
pi install git:github.com/cdias900/pi-dispatch
```

Or manually copy `dispatch.ts` to `~/.pi/agent/extensions/`.

## Tools

### dispatch_spawn

Spawn a new Pi session in a new iTerm2 tab. The child gets all your extensions, MCPs, and skills automatically.

```
dispatch_spawn(
  task: "Fix the failing tests in PR #123",
  cwd: "~/world/trees/root/src"
)
```

Children are automatically instructed to:
1. Register and send a "ready" status back
2. Use subagents (scout/planner/executor/reviewer) for work
3. Report progress via `dispatch_send`

### dispatch_send

Send a message to another session. Types: `message`, `task`, `status`, `complete`, `error`, `question`.

```
dispatch_send(
  target: "orchestrator",  // or a specific session ID
  content: "Tests fixed, CI green",
  type: "complete"
)
```

`target=orchestrator` automatically resolves to the session that spawned you.

### dispatch_read

Read messages from another session's outbox, or your own inbox.

```
dispatch_read()                          // read your inbox
dispatch_read(target: "anon-12345")      // read a child's outbox
```

### dispatch_list

List all active and recently ended sessions with parent-child relationships.

```
dispatch_list()

ACTIVE:
  - anon-44637 | 🎯 orchestrator | pid:44637 | ~/cortex ← (this)
  - anon-14629 | 🛠️ PR fixes | pid:14629 | ~/world [child of anon-446]
  - anon-15811 | 📊 experiments | pid:15811 | ~/world [child of anon-446]
ENDED (outbox readable):
  - anon-99780 | 🧹 cleanup | (5m ago)
```

### dispatch_close

Close a child session's iTerm2 tab.

```
dispatch_close(target: "anon-14629")
```

## How it works

File-based message bus at `~/.pi/dispatch/`:

```
~/.pi/dispatch/
  registry.json              # All sessions (active + recently ended)
  <session-id>/
    inbox.jsonl              # Messages TO this session
    outbox.jsonl             # Messages FROM this session
```

- **Orchestrator → Child**: writes to child's `inbox.jsonl`
- **Child → Orchestrator**: writes to orchestrator's `inbox.jsonl` + own `outbox.jsonl`
- **Delivery**: `fs.watch` on inbox files → near-instant delivery → triggers LLM turn
- **Registry**: sessions register on start, mark as "ended" on shutdown, auto-cleanup after 24h

## Message types

| Type | Prefix | Auto-triggers turn? | Use for |
|------|--------|-------------------|---------|
| `task` | 🎯 TASK | ✅ Yes | Assigning work |
| `question` | ❓ QUESTION | ✅ Yes | Asking for input |
| `status` | 📊 STATUS | ✅ Yes | Progress updates |
| `complete` | ✅ DONE | ✅ Yes | Task finished |
| `error` | ❌ ERROR | ✅ Yes | Something failed |
| `message` | 💬 MSG | ✅ Yes | General messages |

## License

MIT
