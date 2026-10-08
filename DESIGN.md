# Design: Challenge Solving Workflow

## Goals

`ctf-agent-wrapper` is a single-VM CTF workstation. The webapp stores challenges, starts one or more AI agents, streams agent output to authenticated browsers, and persists enough metadata to resume or audit runs after restarts.

The important design constraints are:

- agents should have a rich local toolchain and permissive execution environment;
- uploaded challenge files should not be able to masquerade as provider config, tools, hooks, or repository files;
- multiple agents should be able to work independently but share validated breakthroughs;
- runtime data should survive webapp restarts and deploy syncs.

## Solving Modes

### Single

One agent works on the challenge. New single-mode challenges still use a clean per-run working directory:

```text
challenges/{id}/
  _files/                  # uploaded/imported challenge files
  _runs/{run_id}/          # provider cwd
    challenge_files/       # symlink tree to ../../_files
```

Legacy single challenges that predate `_runs/{run_id}` are still supported by falling back to the challenge root.

### Parallel

Multiple agents work on the same challenge simultaneously. Each agent works in its own isolated run directory, maintains its own notes, and shares validated breakthroughs with teammates via the `notify_teammates` tool and shared notes symlinks.

When any run is marked solved or submits a correct flag, the solved run is stopped if still active, sibling runs are stopped, status is persisted, and all connected clients receive run/challenge status updates.

Unsolved challenges can be expanded after creation by adding one or more new runs from the web UI. Adding a run can promote a single challenge to parallel mode, creates a fresh run workspace, assigns parallel notes labels, syncs selected skills, and starts only the new run(s). Each active run can also be stopped independently without stopping the whole challenge.

## Agent Collaboration Model

Parallel mode collaboration has two channels:

1. **`notify_teammates` tool** — agents call this for validated breakthroughs.
2. **Working notes** — agents maintain markdown notes that teammates can read through symlinks.

### Working Notes

Each parallel agent maintains a structured notes file:

```markdown
# Working Notes — {agent}
## Challenge Understanding
## Hypotheses
[ ] untested  [x] failed  [>] active
## Key Findings
## Tools & Techniques Tried
## Dead Ends
## Next Steps
```

Agents update this file continuously. It serves as persistent memory that survives context compaction and as a reference for teammates.

### `notify_teammates` Tool

Provider implementations expose collaboration as follows:

- **Claude**: in-process MCP tool via `create_sdk_mcp_server`.
- **Codex**: dynamic tool in `thread/start` `dynamicTools`.

When an agent calls `notify_teammates`:

1. The tool handler writes to an in-memory queue.
2. The receiving provider poller picks up the message.
3. The message is injected into teammates' sessions as a teammate breakthrough.
4. Delivery happens at natural turn boundaries where possible, rather than interrupting an active tool call.

Users can also broadcast a message from the web UI or Discord. User broadcasts are injected into all active runs as `[User]` breakthrough messages.

## File System Layout

Uploaded/imported files are stored under `_files/` for **all new challenges**. Provider working directories are under `_runs/{run_id}/`. Agents should use `./challenge_files/` for challenge data.

### Single Mode

```text
challenges/{id}/
  _files/
    chall.bin
    nested/input.txt
  _runs/
    {run_id}/
      challenge_files/
        chall.bin -> ../../_files/chall.bin
        nested/
          input.txt -> ../../../_files/nested/input.txt
      WORKING_NOTES.md
      solver.py
      extracted-output.txt
```

### Parallel Mode

```text
challenges/{id}/
  _files/
    chall.bin
  _shared/
  _runs/
    {run_id_1}/
      challenge_files/
        chall.bin -> ../../_files/chall.bin
      _shared -> ../../_shared
      WORKING_NOTES_claude.md
      WORKING_NOTES_codex.md -> ../{run_id_2}/WORKING_NOTES_codex.md
    {run_id_2}/
      challenge_files/
        chall.bin -> ../../_files/chall.bin
      _shared -> ../../_shared
      WORKING_NOTES_codex.md
      WORKING_NOTES_claude.md -> ../{run_id_1}/WORKING_NOTES_claude.md
```

### File Access Rules

- Web file listing defaults to original challenge files.
- Selecting a run in the Files tab shows that run's workspace.
- Single-run challenges default to the run workspace so generated artifacts are visible.
- File view/download paths are resolved server-side and must stay under allowed roots.
- Symlink targets are resolved and filtered so a symlink cannot expose unrelated system paths.
- Discord `/files` uses the same safe path-resolution model and enforces a display-size cap.

## Agent Execution

All providers currently use SDK/integration paths:

| Provider | Integration | Protocol |
|----------|-------------|----------|
| Claude | `claude-agent-sdk` | Native Python client, typed messages |
| Codex | `codex app-server` | JSON-RPC 2.0 over stdio |

Provider modules retain command builders and event normalizers, but normal webapp runs use the SDK-style `run_agent` path. Both SDK and CLI fallback require resolved 9router runtime context; neither launches direct account inference.

### Shared Model Gateway

`webapp/model_gateway.py` owns discovery, catalog caching, model/effort policy,
selection resolution, and private Codex metadata. Import/constructor perform no I/O.
Default URL: `http://127.0.0.1:20128/v1`. Credentials come from the private saved
`9router` entry in `state/agent-env-auth.json`, then `NINEROUTER_API_KEY`, then
readable discovered key files. Only auto-file authentication failures try another
file. Explicit saved/env credentials never silently switch accounts. Old private
provider credential entries are retained but are not inference fallback paths.

Catalog GETs use an eight-second timeout, no environment proxy, a 30-second cache,
and a manager lock shared with configuration/native metadata writes. Failed refresh
invalidates the old catalog for new starts. One resolver validates `(agent, model,
effort)` before workspaces, transcript resets, session mutation, or queuing at every
entrypoint. Exact opaque gateway IDs are preserved. Missing new-row fields receive
valid presets/defaults; explicit blank model is invalid and explicit blank effort
remains a harness/provider default. Resume never remaps stored tuples. Unknown
effort profiles remain provider-managed.

Claude uses child environment plus session settings to prevent global settings
from overriding its endpoint/model aliases; token stays in child environment only.
Codex uses a custom `ctf_9router` Responses provider, HTTP-SSE, no native OpenAI auth
requirement, and native local compaction. Atomic `state/gateway-codex-models.json`
preserves native instruction/tool metadata and contains the common catalog, not
selected-run defaults. Missing metadata disables Codex without disabling Claude
or the dashboard. Neither harness writes global native config.

Settings/Usage separate catalog readiness from native launcher availability;
readiness does not claim successful inference or account quota. Host-local routing
rejects swarm targets before assignment/launch. Model selection performs no gateway
installation/restart, global synchronization, or remote tunneling.

Each run stores provider session state in challenge metadata, for example:

- Claude session id;
- Codex thread id.

Resume uses this state when possible. Retry clears run output and session state.

Fresh runs receive the full challenge prompt. Resume, steer, Discord resume, and skill-change resumes send short continuation prompts into the existing provider session when possible. The wrapper records these prompts in the chat feed for auditability.

Before a fresh agent starts, the webapp performs a silent `ctfgrep` preflight over `_files/` or `challenge_files/` when challenge files exist. It searches derived flag prefixes or the defaults `flag{`, `ctf{`, `picoCTF{`, and `HTB{` with:

```bash
ctfgrep -i -m 4 -t 4 <target_dir> <term>
```

Each term has a 60 second timeout. Bounded matches are added as detected flag candidates, optionally auto-submitted if global auto-submit is enabled, and are not included in the agent prompt.

## Skill Catalog and Loading

`runtime_resources.py` provides source discovery/bootstrap, deterministic category/file
skill selection, and per-workspace MCP configuration. App startup discovers the
checkout skills independently of `APP_ROOT_DIR`, caches the external category library
once, and prefers app-root uploaded/catalog skills on duplicate names. No installer
or global skill/config rewrite runs during startup; download errors remain visible.

Settings/challenges have Auto or Manual policy. Auto recomputes the base/category/file
skills at runtime; an unknown category exposes workflows for native discovery.
Manual keeps the exact operator list, including explicit none. Runs default to
Inherit and can override Auto/Manual. Metadata persists policy and manual lists,
never an automatic result as a manual snapshot. Legacy nonempty Settings presets
and explicit challenge/run lists retain manual semantics.

Every solve/resume, skill-change continuation, Advisor turn, idle goal process and
CLI fallback materializes skills and MCP context in its own workspace. Claude enables
project/user settings and named Skill controls. Codex refreshes its inventory but
filters canonical paths against selected workspace inputs before attaching them.

The bundled debugger MCP is added under `ctf_gdb` through session-only configuration,
using the app Python and absolute server source path; native global MCPs remain
inherited and are not overwritten. GDB sessions are independent per native process
and clean up on MCP EOF/cancellation. The server uses MCP 2.x `MCPServer`.

`GET /api/resources` exposes catalog status and prerequisite availability, not a
connection claim. `runtime_resources` events persist/stream effective skills and
actual native MCP status. Settings show Auto as default, Manual under advanced
controls, resource source errors, and debugger availability. Missing GDB/dependencies
are reported rather than disguised as connected servers. Licensed IDA and other
CTF binary dependencies are still workstation prerequisites.

## Status and Solve Lifecycle

Challenge status is derived from run statuses:

- `solved` if any run is solved;
- `solving` if any run is solving;
- `pending` if any run is pending;
- `failed` if all runs failed;
- `completed` if all non-failed terminal runs completed.

Solve paths are centralized so web, Discord, plugin submit, and auto-submit behave consistently:

1. mark the target run solved;
2. persist the correct flag if present;
3. stop the solved run if it is still active;
4. stop sibling parallel runs;
5. save metadata;
6. broadcast run and challenge status updates;
7. notify Discord when enabled.

Stop paths similarly set affected runs to `failed`, append a stop event, persist metadata, and broadcast updates.

## CTF Platform Plugins

Platform plugins are discovered from `webapp/plugins/`:

| Plugin | Auth | Features |
|--------|------|----------|
| CTFd | API token or username/password | Fetch challenges, download files, submit flags |
| rCTF | Auth token or team token | Fetch challenges, download files, submit flags |
| HTB CTF | JWT Bearer token | Fetch challenges, download files, submit flags, on-demand instance management |
| CDDC | Platform credentials | Fetch challenges, download files, submit flags |
| Cywaria/Cympire | Username/password | Fetch challenges, scrape/download files, start instances, submit flags |
| SAS CTF | Session cookie, username/password best effort | Fetch challenges, download files, start instances, submit flags |

CTFd and rCTF verify TLS by default. They expose an explicit `insecure_tls` checkbox for self-signed/local deployments. HTB uses normal certificate verification. SAS CTF exposes the same TLS checkbox and defaults it on because the current event endpoint may not validate against the host trust store.

HTB, Cywaria, and SAS CTF challenges with Docker/machine instances are started at solve time, not import time, to respect concurrent instance limits. Connection info (`url`, `host`, `port`, `connection`) is injected into the agent prompt.

HTB multi-answer challenge metadata (`flagsInfo`) is preserved as `_flag_questions`. The prompt lists each question and run workspaces include `submit_answer.py`, which calls a local token-protected endpoint to submit arbitrary answers by question number or platform `flag_id`.

Connections are persisted to `state/connections.json` and can be synced to fetch new challenges from already-imported platforms.

## WireGuard VPN

The webapp can configure a single `wg0` server interface from Settings. Environment setup installs WireGuard and generates the server keypair; the web UI generates a client keypair, writes `/etc/wireguard/wg0.conf`, and downloads a ready-to-run Linux client config after the user provides optional client-side internal CIDRs.

The reverse routing model is:

- server peer `AllowedIPs` includes `10.13.37.2/32` and any internal CIDRs reachable from the client;
- generated client `AllowedIPs` includes only `10.13.37.0/24`, so the client keeps its local routes for those internal CIDRs;
- if internal CIDRs are configured, the downloaded Linux client config includes `wg-quick` `PostUp`/`PostDown` rules using `sysctl` and `iptables` to forward/NAT traffic from the VPN subnet to those client-side networks.

VPN status exposes peer endpoint, transfer counters, and latest handshake age. DNS forwarding, when enabled, runs `dnsmasq` on the server's WireGuard address and forwards to public resolvers.

## Discord Integration

When enabled, the Discord bot connects via the Discord gateway WebSocket and registers slash commands.

Features:

- per-challenge Discord destinations created when challenges are created/imported with Discord enabled;
- layout setting for either one thread per challenge in the selected announcement channel or one text channel per challenge under a Discord category matching the challenge category;
- destination rename on completion (`[solved]` thread prefix or `solved-` channel prefix);
- notifications for starts, stops, solves, flag detections, and breakthroughs;
- flag review buttons on detected candidates for submit, reject, mark correct, and broadcast;
- challenge action buttons for status, stats, tail, flags, submit flag, mark solved, stop, and resume;
- slash commands: `/broadcast`, `/submit`, `/status`, `/flags`, `/stop`, `/resume`, `/solved`, `/ctf`, `/files`.

Changing Discord settings in the web UI reconciles the gateway: it starts when enabled, stops when disabled, and restarts when token/channel/guild settings change.

## Web Security Model

The webapp is a local, passwordless tool. There is no Basic/session authentication,
web password, session cookie, login/logout endpoint, or CSRF-token exchange. Both
the direct launcher and local service bind `127.0.0.1:8000`; the dashboard and APIs
work immediately. Native agents can execute commands, so the UI must not be
published on an untrusted network. Remote VM access uses SSH port forwarding.

Browser mutation requests are checked automatically by Origin/Sec-Fetch-Site
without tokens or configuration. Headerless local CLI callers are accepted.
WebSockets retain their same-origin/explicit `ALLOWED_ORIGINS` check without
authentication. Model/file validation and platform/run submission tokens are
independent of web login and remain in place.

Browser hardening headers are added by middleware:

- Content-Security-Policy;
- `X-Content-Type-Options: nosniff`;
- `Referrer-Policy: no-referrer`;
- `X-Frame-Options: DENY`;
- `Permissions-Policy`;
- `Cross-Origin-Opener-Policy`;
- HSTS when TLS is enabled.

## Deployment Model

Terraform supports Hetzner Cloud, DigitalOcean, and GCP.

Deploy syncs use a runtime allowlist instead of copying the entire repository. The copied paths are:

```text
install_scripts
webapp
skills
mcps
hooks
README.md
DESIGN.md
```

The deploy intentionally does **not** copy local `.git/`, `infra/`, Terraform state/vars, provider caches, or other local repo artifacts. Python bytecode/cache files are excluded from sync and sync hashing.

Remote runtime data is preserved during sync:

```text
/root/ctf-agent-wrapper/challenges
/root/ctf-agent-wrapper/state
```

DigitalOcean and GCP provisioners include a `sync_hash` trigger so runtime changes cause a new sync and service restart. Hetzner splits sync, install-script setup, and webapp restart into separate resources; skill changes are included in the install-script setup hash because skills are installed into agent skill directories.

## Install Scripts

Install scripts remain numbered and executable by `install_scripts/run.sh`, but share common helper functions from `install_scripts/lib/common.sh` for logging, retries, package installs, downloads, package-manager locks, and shell-profile updates. By default, `run.sh` uses a dependency-aware parallel plan: the base bootstrap runs first, independent tooling categories run concurrently, agent registration runs after the local MCP tooling is available, and validation runs last. Set `INSTALL_SCRIPTS_PARALLEL=0` to force the old sequential order.

Most Python dependencies are installed with:

```bash
uv pip install --system ...
```

This keeps the disposable VM's global Python workflow while improving install speed and resolver/cache behavior. `python3 -m pip` is retained only for vendor-local wheels such as IDA's `idapro*.whl`.

The last setup script, `install_scripts/990_validate.sh`, validates critical commands and Python imports. It catches incomplete provisioning before the webapp is used.

## Persistence

Runtime state locations:

| Data | Path |
|------|------|
| Challenge metadata | `state/{challenge_id}/challenge.json` |
| Per-run output log | `state/{challenge_id}/{run_id}.jsonl` |
| Platform connections | `state/connections.json` |
| Global settings | `challenges/settings.json` |
| Original challenge files | `challenges/{challenge_id}/_files/` |
| Per-run workspace | `challenges/{challenge_id}/_runs/{run_id}/` |

On startup, stale `solving` runs are reset to `failed` because agent subprocesses/tasks do not survive a webapp restart. Legacy challenge metadata/output locations are migrated into `state/` when possible.

## Settings

Settings persist to `challenges/settings.json`.

| Setting | Default | Description |
|---------|---------|-------------|
| `default_agent` | `claude` | Default agent for new challenges |
| `default_flag_format` | empty | Default flag format |
| `theme` | `dark` | UI theme |
| `auto_submit_flags` | `false` | Auto-submit detected flags to CTF platform |
| `chat_view_mode` | `split` | Agent view layout: `split` or `tabbed` |
| `enabled_agents` | empty | Initial empty means no preset yet; new rows use the valid default harness. Explicit empty saves are rejected. |
| `agent_models` | `{}` | Exact gateway model presets per harness; disabled presets are retained |
| `agent_efforts` | `{}` | Model-valid effort presets per harness; blank means harness/provider default |
| `enabled_skills` | catalog defaults | Global default skill list for new challenges |
| `max_platform_import_size_gb` | `2.0` | Per-challenge cap for platform-imported files; challenges exceeding it are skipped |
| `discord_enabled` | `false` | Enable Discord bot integration |
| `discord_bot_token` | empty | Discord bot token |
| `discord_channel_id` | empty | Discord announcement channel; also the parent channel for thread mode |
| `discord_guild_id` | empty | Discord guild for slash command registration |
| `discord_challenge_layout` | `threads` | Discord challenge destination mode: `threads` or `channels` |
