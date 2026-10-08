# CTF Solver Web App

A web application that uses AI coding agents (Claude Code and Codex) to solve CTF challenges. Upload challenge files, describe the problem, and watch an agent work through it in real time.

## Architecture

```
webapp/
  app.py              # Starlette backend (API + WebSocket)
  start.sh            # Passwordless local launcher
  ctf-solver.service  # systemd unit file
  static/
    index.html         # Single-page app
    app.js             # Frontend logic
    style.css          # Dark theme UI
```

The backend runs provider-specific SDK/CLI integrations, normalizes their event streams into a shared UI format, and persists challenge state to `/root/ctf-agent-wrapper/state` so solver metadata stays out of challenge working directories.

Skills are automatically discovered from the checkout, a one-time category cache,
and app-root uploads/catalogs. Auto is the new-install default; leave it enabled
to select related workflows by challenge category/file type. Manual remains an
advanced exact override. Each fresh/resumed run and Advisor turn receives selected
skills plus the bundled `ctf_gdb` MCP without editing global client configuration.
Settings → Runtime resources shows source errors and availability; the run feed
shows actual native MCP connection states. GDB/MCP 2.x must be installed; other
tool-specific skills still depend on the corresponding binary/licensed tools.

## Setup

### Prerequisites

- Python 3.12+ with `starlette` and `uvicorn`
- Claude Code CLI (`claude`) — install via `install_scripts/003_install-claude-code.sh`
- Codex CLI (`codex`) — install via `install_scripts/010_install-codex.sh`
- Local 9router daemon, API key, and native launcher/model metadata (auto-discovered from existing `9router-clients` installations); native account login is not required.

### Running

```bash
# Directly
./start.sh

# Via systemd
sudo cp ctf-solver.service /etc/systemd/system/
sudo systemctl enable --now ctf-solver
```

The app opens directly at `http://127.0.0.1:8000`, without login, a web password,
session cookies, or CSRF tokens. The launcher creates no credentials/TLS files and
does not kill unrelated native agents. Root deployments retain
`/root/ctf-agent-wrapper`; non-root launches default to
`~/.local/share/ctf-agent-workstation/data`. `APP_ROOT_DIR` can select existing data.

Do not expose this passwordless agent UI publicly: native agents execute shell
commands on the host. Browser writes/WebSockets retain automatic same-origin checks
and normal input validation remains. For a remote VM, forward SSH port 8000 instead.

## Features

### Agent Support

Both native harnesses use **9router** as their only model provider:

| Harness | Integration | Model catalog |
|---|---|---|
| Claude Code | `claude-agent-sdk`, native CLI | Gateway `GET /v1/models` |
| Codex | Native `codex app-server`, JSON-RPC over stdio | Same gateway catalog, private native metadata snapshot |

Settings → **Model provider: 9router** provides URL/key repair and model refresh.
The default endpoint is `http://127.0.0.1:20128/v1`. Saved keys take precedence over
`NINEROUTER_API_KEY`, then discovered key files. Blank key input keeps the current
source; refresh reads key files again for rotation. Keys stay out of public APIs
and run metadata. Old private credential entries are retained, not used as fallback.

Create, bulk upload, platform import, Add Agent, Settings, and Advisor share exact
model IDs and model-specific effort menus. Unsupported explicit effort is an error,
not silently dropped. Blank effort keeps the harness/provider default; managed
variants disable the selector and explain why caller control is unavailable.
Settings remember enabled harness presets; parallel rows independently choose
models and efforts on the same harness. Resume keeps the stored tuple.
Legacy IDs absent from 9router remain in history and cannot resume; use Add Agent
to create a new run with a valid gateway selection.

Launcher discovery avoids syncing wrappers and child settings never rewrite
`~/.claude/settings.json` or `~/.codex/config.toml`. Select **Local** for runs:
host-local 9router cannot be reached by swarm workers.

### Default Agent Toggle

A persistent toggle in the dashboard header sets the default agent for new challenges. The setting is stored in `challenges/settings.json` and pre-selects the agent dropdown when creating a challenge. Each challenge can still override the agent choice individually.

### Challenge Lifecycle

1. **Create** — Name, description, flag format, agent/model selection, file upload
2. **Solve** — Agent runs automatically on creation. Retry button available on failure.
3. **Steer** — Send guidance to a running agent. Stops the current process, then resumes the provider session with your message.
4. **Stop** — Terminate the agent process mid-solve.
5. **Delete** — Remove challenge and all associated files.

### Real-time Activity Stream

- WebSocket-based live streaming of agent output
- Structured rendering of thinking blocks, text, tool calls, and results
- Collapsible tool details with input/output display
- Subagent tabs for parallel agent work
- Auto-scroll with manual override
- Markdown rendering with syntax-highlighted code blocks
- Copy buttons on code blocks and tool outputs

### Flag Detection

Automatically scans agent output for flag patterns (`flag{...}`, `CTF{...}`, `HTB{...}`, `picoCTF{...}`, and custom formats). Displays a banner with copy button when a flag is found. HTB multi-answer imports also list each `flagsInfo` question in the prompt and provide `submit_answer.py` so agents can check arbitrary answers.

### File Browser

- Lists all files in the challenge directory (auto-refreshes every 8s)
- Inline viewer for images, text files (with syntax highlighting), and binary files (hexdump)
- Download button for any file

### Usage Page

Accessible via the "Usage" button in the dashboard header:

- **9router** — Catalog connectivity, key source/configuration repair, and Refresh.
- **Harnesses** — Launcher availability/catalog readiness, not inference proof or native account quota.
- **Challenges** — Per-harness attempted/solved/failed counts and average/total duration.

### Other Features

- **Timer and cost tracking** — Elapsed time counter and token/cost display in the header
- **Export** — Download a markdown report of the agent's activity
- **Keyboard shortcuts** — `Esc` (back/close), `/` (focus steer input), `1`/`2`/`3` (sidebar tabs)
- **Toast notifications** — Solve/fail alerts when viewing a different challenge
- **Responsive layout** — Collapsible sidebar on mobile
- **Session persistence** — Challenges survive app restarts (metadata + output log stored on disk)

## API Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/usage` | Gateway/harness readiness and per-harness challenge stats |
| GET | `/api/agents` | Dynamic model/effort metadata; `?refresh=1` refreshes |
| GET | `/api/agents/gateway` | Public gateway configuration/status (no raw key) |
| PUT | `/api/agents/gateway` | Save URL/key and refresh status (no login/token; same-origin browser writes) |
| GET | `/api/settings` | Get global settings |
| PUT | `/api/settings` | Update global settings (agents, theme, import size cap, Discord) |
| GET | `/api/challenges` | List all challenges |
| POST | `/api/challenges` | Create challenge (multipart form) |
| POST | `/api/challenges/{id}/solve` | Retry solving |
| POST | `/api/challenges/{id}/stop` | Stop agent |
| POST | `/api/challenges/{id}/steer` | Send guidance message |
| DELETE | `/api/challenges/{id}` | Delete challenge |
| GET | `/api/challenges/{id}/files` | List challenge files |
| GET | `/api/challenges/{id}/files/{path}` | View file content |
| GET | `/api/challenges/{id}/download/{path}` | Download file |
| WS | `/ws/{id}` | Real-time agent output stream |
