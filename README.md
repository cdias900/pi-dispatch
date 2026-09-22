# pi-dispatch

Multi-session orchestration extension for [Pi](https://pi.dev). Spawn, message, and manage child Pi sessions across Herdr or iTerm2 tabs with bidirectional communication.

## What it does

Pi is a powerful coding agent, but a single session can get cluttered when managing many tasks. pi-dispatch lets any session become an **orchestrator** that spawns child sessions in separate terminal tabs — each with its own context, tools, and interactive TUI that you can jump into at any time.

```
┌─────────────────────────────────────────────────┐
│ Herdr workspace or iTerm2 window                │
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

- **Spawn sessions** → `dispatch_spawn` creates a new Herdr or iTerm2 tab with a Pi session
- **Bidirectional messaging** → orchestrator and children communicate via `dispatch_send`
- **Instant delivery** → messages arrive in real-time via filesystem watchers
- **Visual distinction** → incoming messages render as `[🎯 TASK]`, `[✅ DONE]`, `[📊 STATUS]` etc.
- **Auto-triggers** → task/question messages automatically wake the LLM to respond
- **Session registry** → `dispatch_list` shows active/ended sessions with parent-child relationships
- **Clean lifecycle** → `dispatch_close` terminates child tabs, sessions marked as ended with readable outboxes
- **You stay in control** → switch to any tab and interact with child sessions directly

## Requirements

- [Pi](https://pi.dev) coding agent
- One supported terminal backend:
  - **Herdr:** run Pi inside a Herdr-managed pane (`HERDR_ENV=1`). The injected `HERDR_BIN_PATH` and `HERDR_SOCKET_PATH` are used automatically.
  - **iTerm2 (macOS):** install the Python API with `python3 -m venv ~/.local/iterm2-env && ~/.local/iterm2-env/bin/pip install iterm2`, then enable Python API in iTerm2 → Preferences → General → Magic.

When Herdr and host-terminal variables coexist, Herdr takes precedence. A broken Herdr connection fails explicitly instead of silently opening a tab in the outer iTerm2 window.

## Install

```bash
pi install git:github.com/cdias900/pi-dispatch
```

For local development, install the repository as a local Pi package. The extension has multiple source modules, so copying only `dispatch.ts` is not supported.

## Tools

### dispatch_spawn

Spawn a new Pi session in a terminal tab. The child gets all your extensions, MCPs, and skills automatically.

- **Inside Herdr:** the extension resolves the parent's live pane through the Herdr API, creates an unfocused tab in that same workspace, and launches the child there. This remains correct if the parent pane moved after Pi started.
- **Outside Herdr:** the existing iTerm2 Python API flow is used.

Inside Herdr, `dispatch_spawn` waits until Herdr detects Pi as ready and then submits the task through the agent API; in iTerm2 it preserves the existing command-submission behavior. In both cases the child confirms dispatch readiness through `dispatch_send`, and provider/model failures can still surface in the child.

```
dispatch_spawn(
  task: "Fix the failing tests in PR #123",
  cwd: "~/world/trees/root/src"
)
```

#### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `task` | **Yes** | The task/prompt to give the new Pi session. |
| `cwd` | No | Working directory for the new session (default: current directory). |
| `name` | No | Human-readable name for this child session (shown in messages and `dispatch_list`). |
| `model` | No | Optional model override. Must be an **exact native `provider/model`** reference (e.g. `anthropic/claude-sonnet-5`, `openai/gpt-5.6-sol`). Bare or fuzzy aliases like `sonnet` or `*sonnet*` are rejected. Do **not** append a thinking suffix (`provider/model:high`) — use the `thinking` field instead. Omit to inherit the agent default. Registry existence is still checked by Pi at launch. |
| `thinking` | No | Optional thinking/reasoning level. Exactly one of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Omit to inherit the agent default. |
| `extensions` | No | Comma-separated additional extensions to load (e.g. `slack,gworkspace`). |
| `skills` | No | Comma-separated skills to load (e.g. `graphite,stack`). |

`model` and `thinking` are both optional. Omitting either inherits the agent default; an explicit empty string is invalid and fails validation rather than silently falling back. The native `provider/model:level` shorthand is **not** accepted — use the separate `thinking` field.

#### Thinking compatibility

Pi exposes a **global** set of thinking levels (`off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`), but individual models/providers may support only a subset. `dispatch_spawn` validates the `thinking` enum and `model` syntax, but it **cannot reliably preflight model-specific compatibility** — Pi registry metadata can itself be stale or wrong.

When `thinking` is provided **without** `model`, the spawned child uses its normal default model, and that inherited model determines which levels actually work. Herdr waits for Pi's startup handshake before submitting the task, while iTerm2 keeps the existing asynchronous launch behavior. Provider compatibility errors can therefore surface either during Herdr startup or later inside the child.

> **Recommendation:** when choosing a `thinking` override, explicitly provide `model` and use a thinking level known to be supported by that model. This improves predictability because the child uses the model you named to determine compatibility — but it does **not** guarantee preflight validation, since compatibility is enforced by the provider, not by this tool.

#### Examples

```
// Default model and thinking
dispatch_spawn(task: "Fix the failing tests in PR #123")

// Override the model only (thinking inherits the default)
dispatch_spawn(
  task: "Refactor the auth module",
  model: "anthropic/claude-sonnet-5"
)

// Override thinking only (model inherits the default)
dispatch_spawn(
  task: "Investigate the flaky CI",
  thinking: "xhigh"
)

// Override both
dispatch_spawn(
  task: "Design the new caching layer",
  model: "openai/gpt-5.6-sol",
  thinking: "high"
)
```

Valid `thinking` levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`.

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

Close a child session's recorded Herdr or iTerm2 tab. Herdr closure targets the exact recorded socket and tab; it never substitutes whichever workspace or tab is currently focused. Closing a Herdr child closes that whole tab, including panes later added to it. Herdr also closes a workspace when its last tab closes, so only dispatch-owned child tabs should be targeted.

```
dispatch_close(target: "anon-14629")
```

## How it works

File-based message bus at `~/.pi/dispatch/`:

```
~/.pi/dispatch/
  _pending_spawn_<token>.json # Exact transient parent/child correlation
  <session-id>/
    state.json                # Session, parent, label, pid, terminal location
    inbox.jsonl               # Messages TO this session
    outbox.jsonl              # Messages FROM this session
```

- **Orchestrator → Child**: writes to child's `inbox.jsonl`
- **Child → Orchestrator**: writes to orchestrator's `inbox.jsonl` + own `outbox.jsonl`
- **Delivery**: `fs.watch` on inbox files → near-instant delivery → triggers LLM turn
- **Registry**: each session atomically owns its own `state.json`, marks itself ended on shutdown, and is cleaned up after 24h
- **Terminal location**: dispatched children persist the exact Herdr socket/workspace/tab/pane or iTerm session handle used by `dispatch_close`
- **Correlation**: Herdr children claim a unique spawn token only after their state is durably registered

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
