# Repository Guidelines

## Project Overview

A disposable cloud CTF workstation with reverse-engineering, forensics, crypto, pwn, and web tooling. Claude Code and Codex solve challenges through a web UI, optionally Discord, with local parallel runs or remote GCP swarm workers.

## Architecture & Data Flow

- **Backend:** Starlette ASGI/Uvicorn. `webapp/app.py` owns routes, challenge/run lifecycle, persistence, streaming, and integrations. It is a large module; read targeted sections rather than the whole file. The local dashboard has no web login or session requirement.
- **Solve pipeline:** local requests validate gateway tuples and automatically check browser mutation origins before creating per-run workspaces and async provider tasks. Provider messages become normalized event dictionaries, append to disk JSONL, enter a bounded in-memory tail, and stream over WebSockets. Keep backend and client event schemas synchronized.
- **Providers/platforms:** `webapp/agents/` adapts Claude SDK sessions and Codex app-server JSON-RPC threads; `webapp/plugins/` adapts CTF platforms. `webapp/swarm.py` manages workers, `webapp/gcp.py` wraps Compute REST, and `webapp/swarm_exec.py`/`webapp/swarm_runner.py` transport provider-compatible events over SSH.
- **Persistence:** beneath `APP_ROOT_DIR`, inputs are `challenges/<id>/_files/`, workspaces are `challenges/<id>/_runs/<run_id>/`, and metadata/transcripts are `state/<id>/challenge.json` and `state/<id>/<run_id>.jsonl`. Settings are exceptionally `challenges/settings.json`. Workspaces expose inputs, shared files, and selected skills through symlinks.
- **State invariants:** completed does not mean solved. Resume preserves session/transcript; fresh retry resets them. Interrupted solving runs reload as failed. Disk transcripts are authoritative: preserve non-empty JSONL line indices, including gaps from malformed lines, because tool-output references depend on them. WebSocket catch-up ends with `run_status`; reconnection uses an `after` event count.

## Key Directories

| Path | Purpose |
| --- | --- |
| `webapp/` | Backend, provider/platform adapters, Discord and swarm integrations. |
| `webapp/static/` | Directly served HTML/CSS and plain browser JavaScript; no frontend build. |
| `install_scripts/` | Numbered workstation installers, validation, shared shell helpers, and custom tooling under `artefacts/`. |
| `infra/{hetzner,digitalocean,gcp}/` | Independent Terraform deployments; run provider commands from the selected directory. |
| `skills/` | Version-controlled `SKILL.md` directories with accompanying scripts/references. |
| `mcps/` | GDB MCP 2.x stdio server; one debugger session per native run. |

## Development Commands

Run source checks from the repository root. There is no application build command, package-script test command, or configured lint pipeline.

```sh
# Python syntax only: no application imports or bytecode writes.
python3 - <<'PY'
from pathlib import Path
for root in ('webapp', 'mcps'):
    for path in Path(root).rglob('*.py'):
        compile(path.read_bytes(), str(path), 'exec')
PY

node --check webapp/static/app.js
for file in install_scripts/*.sh install_scripts/lib/*.sh infra/*/*.sh webapp/*.sh skills/forensics/volatility3-memdump/scripts/*.sh; do
    bash -n "$file" || exit 1
done
```

- **Optional lint, not an established clean baseline:** `ruff check --no-cache webapp mcps`; `shellcheck -x install_scripts/run.sh install_scripts/lib/common.sh webapp/start.sh`; `terraform fmt -check -recursive infra`. Install the corresponding tools first.
- **Provision workstation:** `bash install_scripts/run.sh` as root on the target VM. `INSTALL_SCRIPTS_PARALLEL=0` selects sequential mode. This installs/downloads tools and changes the host; it is not a build or test.
- **Run:** `(cd webapp && ./start.sh)` binds `127.0.0.1:8000` without login, password/TLS generation, or global orphan-process kills. Root deployed service: `systemctl restart ctf-solver`; local user service: `systemctl --user restart ctf-solver`. Startup loads/migrates runtime state, so use an isolated `APP_ROOT_DIR` for smoke checks.
- **Workstation validation:** `bash install_scripts/990_validate.sh`, optionally prefixed with `VALIDATE_TIMEOUT_SECONDS=120`. See Testing & QA for its limits.

## Code Conventions & Common Patterns

- Match neighboring code: Python uses four-space indentation, `snake_case`, `PascalCase` classes, uppercase constants, private `_helpers`, type annotations/dataclasses, and module loggers. Browser JS uses two-space indentation, `camelCase`, `const`/`let`, Maps/Sets, shared state, and explicit DOM updates—not React.
- **Dependency injection:** frozen `AgentProvider` in `webapp/agents/base.py` carries native command/event/runner/goal callables and effort wire allowlists. Register providers explicitly in `webapp/agents/__init__.py`; `webapp/model_gateway.py` owns the shared 9router catalog, selection policy, and resolved native runtime. Do not add native account/model fallback paths.
- **Platform extensions:** subclass `CTFPlatformPlugin` in `webapp/plugins/base.py`; implement async test/fetch/download/submit methods and `config_schema`-driven forms. Modules are auto-discovered; import/constructor errors can hide plugins. Preserve `read_limited_response` byte limits and sync/async progress callbacks.
- **HTTP errors/security:** reuse `require_same_origin`, `read_json_object`, and `str_field`; endpoints return `JSONResponse` with an `error` field. There is no login/session/CSRF token flow. Browser mutations and WebSockets retain automatic Origin checks; headerless local CLI requests are accepted. Keep the passwordless native-agent UI loopback-only.
- **Async/state:** use async I/O, existing per-run/per-challenge `asyncio.Lock` instances, and `asyncio.to_thread` for blocking operations. Preserve cancellation, stop-reason ordering, and process-group TERM/KILL cleanup. Keep live task/process/socket handles out of serialized metadata; package/direct-script import fallbacks are established patterns.
- **Installers/skills:** shell scripts use `set -euo pipefail`, resolve `SCRIPT_DIR`, and source locked package helpers. New numbered installers must enter the explicit `run.sh` graph. App startup uses `runtime_resources.py` to discover repo/category/uploaded skills and prepare session-local MCP; never run the destructive skill installer as a runtime refresh. Auto/Manual/Inherit policy lives in app metadata; native adapters consume the selected workspace, not global catalog snapshots.

## Important Files

- `webapp/start.sh` and `webapp/ctf-solver.service`: production launch/environment assumptions.
- `install_scripts/015_install-python-tooling.sh`: Python dependency installation; `install_scripts/990_validate.sh`: provisioned-tool/import checks.
- Read `DESIGN.md` when changing lifecycle, collaboration, persistence, plugins, settings, or security; `SWARM.md` for remote-worker credentials, images, networking, and lifecycle.
- Read `infra/README.md` before deployment and `skills/README.md` before skill/catalog changes. Update affected usage/design docs and `CHANGELOG.md`'s `Unreleased` section for behavior changes. Some older descriptions in `webapp/README.md` are stale; verify against current source.

## Runtime/Tooling Preferences

- Target Python **3.12+**, root-run Ubuntu **24.04 x86_64**, Bash, apt, and systemd. Provisioning uses `uv pip install --system --break-system-packages` and `uv tool install`, not `uv sync`. There is no Python/JS project manifest or dependency lockfile.
- Node/npm support the global Codex CLI and workstation tools, not a frontend package/build pipeline. Bun is not required. The GDB MCP server additionally needs the Python MCP package and GDB; licensed IDA is a bring-your-own prerequisite.
- Importing `webapp/app.py` needs no web password/secret but creates/loads/migrates runtime state. Do not import it merely to inspect code. Its `APP_ROOT_DIR` default is `/root/ctf-agent-wrapper`; the non-root launcher selects `~/.local/share/ctf-agent-workstation/data`, and smoke runs must select an isolated root.
- Preserve single-process deployment: run state, locks, broadcast queues, and WebSocket sets are process-local, not coordinated across ASGI workers.
- Keep `challenges/`, `state/`, `all-skills/`, credentials, transcripts, installer logs, and Terraform variables/state out of commits. Runtime metadata can contain session and submission tokens.

## Testing & QA

- No automated test suite/framework, CI workflows, or coverage threshold is configured. Syntax checks above do not prove imports, async behavior, browser rendering, or integrations.
- For behavioral changes, exercise the affected local UI/API path without web credentials: upload/solve, inspect streaming, stop, resume/retry, and reconnect as applicable. Do not treat integration “Test” buttons as isolated tests: they can contact CTF platforms/GCP or send Discord messages.
- `990_validate.sh` checks executable presence and Python imports, not application behavior. Missing commands/imports fail; failed version/help probes for present tools only warn and can still print OK. The validator requires `idapro`, which normal provisioning does not supply without licensed IDA.
- Terraform formatting checks are local; `terraform validate` requires prior provider initialization. Provisioning, `terraform apply`, and service startup are operational actions, not harmless QA checks.
