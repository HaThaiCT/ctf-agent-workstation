"""Claude provider — uses claude-agent-sdk for agent execution."""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import tempfile
from collections.abc import AsyncIterator
from pathlib import Path

from .base import AgentProvider, GatewayRuntime
try:
    from ..runtime_resources import workspace_mcp_servers
except ImportError:
    from runtime_resources import workspace_mcp_servers

log = logging.getLogger("ctf-solver.claude")


# Claude CLI `system` message subtypes that are internal status noise. These
# carry no useful human-readable text, so the parser would otherwise fall back
# to rendering the bare subtype string as a yellow status pill in the UI.
# Add new offenders here as they surface.
_DROP_SYSTEM_SUBTYPES = {
    "thinking_tokens",
}


def _session_wrapper_path(real_cli: str) -> str:
    """Return an executable wrapper that starts Claude in a new session."""
    digest = hashlib.sha256(real_cli.encode()).hexdigest()[:16]
    path = Path(tempfile.gettempdir()) / f"ctf-agent-claude-{digest}.py"
    content = (
        "#!/usr/bin/env python3\n"
        "import os\n"
        "import sys\n"
        f"REAL_CLI = {real_cli!r}\n"
        "os.setsid()\n"
        "os.execv(REAL_CLI, [REAL_CLI, *sys.argv[1:]])\n"
    )
    try:
        if not path.exists() or path.read_text() != content:
            path.write_text(content)
            path.chmod(0o700)
    except OSError:
        return real_cli
    return str(path)


def claude_gateway_env(runtime: GatewayRuntime) -> dict[str, str]:
    """Return child-only routing and alias overrides for native Claude."""
    return {
        "IS_SANDBOX": "1",
        "ANTHROPIC_BASE_URL": runtime.config.base_url,
        "ANTHROPIC_AUTH_TOKEN": runtime.config.api_key,
        "ANTHROPIC_API_KEY": "",
        "ANTHROPIC_MODEL": runtime.model,
        "ANTHROPIC_DEFAULT_SONNET_MODEL": runtime.model,
        "ANTHROPIC_DEFAULT_OPUS_MODEL": runtime.model,
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": runtime.model,
    }


def _workspace_skill_names(cwd: str | Path) -> list[str]:
    directory = Path(cwd) / ".claude" / "skills"
    if not directory.is_dir():
        return []
    return sorted(child.name for child in directory.iterdir()
                  if not child.name.startswith(".") and (child / "SKILL.md").is_file())


def _workspace_mcp_servers(cwd: str | Path) -> dict:
    # Native user/project servers remain inherited; never shadow a same-name server.
    names = set()
    for path in (Path.home() / ".claude.json", Path(cwd) / ".mcp.json"):
        try:
            data = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        names.update(data.get("mcpServers", {}))
        project = data.get("projects", {}).get(str(Path(cwd).resolve()), {})
        names.update(project.get("mcpServers", {}))
    return {name: server for name, server in workspace_mcp_servers(cwd).items()
            if name not in names}


def claude_workspace_cli_args(cwd: str | Path) -> list[str]:
    """Merge workspace MCPs without replacing inherited native server settings."""
    return ["--setting-sources", "user,project", "--mcp-config",
            json.dumps({"mcpServers": _workspace_mcp_servers(cwd)})]


# ---------------------------------------------------------------------------
# SDK-based agent runner
# ---------------------------------------------------------------------------

async def _run_agent_sdk(
    prompt: str,
    model: str = "",
    effort: str = "",
    cwd: str | Path = ".",
    continue_session: bool = False,
    session_state: dict | None = None,
    challenge_id: str = "",
    run_id: str = "",
    **kwargs,
) -> AsyncIterator[dict]:
    """Run Claude via the agent SDK, yielding normalized events."""
    gateway = kwargs.get("_gateway")
    if not isinstance(gateway, GatewayRuntime):
        yield {"type": "error", "message": "9router runtime configuration is missing"}
        return
    model, effort = gateway.model, gateway.effort
    from claude_agent_sdk import (
        ClaudeSDKClient,
        ClaudeAgentOptions,
        AssistantMessage,
        UserMessage,
        SystemMessage,
        ResultMessage,
        StreamEvent,
        RateLimitEvent,
        TaskStartedMessage,
        TaskNotificationMessage,
        TaskProgressMessage,
        TextBlock,
        ThinkingBlock,
        ToolUseBlock,
        ToolResultBlock,
        ServerToolUseBlock,
        ServerToolResultBlock,
        create_sdk_mcp_server,
        tool,
    )
    from .broadcast import broadcast_to_teammates, get_pending_broadcast

    resume_session_id = None
    if continue_session and session_state:
        resume_session_id = session_state.get("claude_session_id")

    # Create notify_teammates MCP tool
    mcp_servers = _workspace_mcp_servers(cwd)
    if challenge_id and run_id:
        @tool(
            "notify_teammates",
            "Broadcast a validated breakthrough to all teammates. "
            "Only call this for confirmed, significant findings.",
            {"type": "object", "properties": {"message": {"type": "string", "description": "The breakthrough finding"}}, "required": ["message"]},
        )
        async def notify_teammates(params):
            msg = params.get("message", "")
            count = await broadcast_to_teammates(challenge_id, run_id, msg)
            return {"content": [{"type": "text", "text": f"Broadcast sent to {count} teammate(s)"}]}

        mcp_servers["ctf-collab"] = create_sdk_mcp_server(
            "ctf-collab", tools=[notify_teammates]
        )

    # Advisor tools: app.py passes a dict of name -> {description, schema, fn}.
    # Each is exposed as an MCP tool dispatched in-process (same pattern as
    # notify_teammates), giving the advisor read access to solver transcripts
    # and a relay to the broadcast bus.
    advisor_tools = kwargs.get("_advisor_tools") or {}
    if advisor_tools:
        adv_mcp_tools = []
        for tname, spec in advisor_tools.items():
            fn = spec["fn"]

            def _make(fn):
                async def _handler(params):
                    text = await fn(params or {})
                    return {"content": [{"type": "text", "text": str(text)}]}
                return _handler

            adv_mcp_tools.append(tool(
                tname, spec.get("description", ""),
                spec.get("schema", {"type": "object", "properties": {}}),
            )(_make(fn)))
        if adv_mcp_tools:
            mcp_servers["advisor"] = create_sdk_mcp_server(
                "advisor", tools=adv_mcp_tools)

    cli_path = _session_wrapper_path(gateway.config.claude_cli)

    _stderr_lines: list[str] = []

    def _stderr_handler(line: str) -> None:
        stripped = line.rstrip()
        log.warning("Claude CLI stderr: %s", stripped)
        _stderr_lines.append(stripped)

    claude_env = claude_gateway_env(gateway)
    available_models = kwargs.get("_gateway_models") or [model]
    selected_skills = _workspace_skill_names(cwd)

    options = ClaudeAgentOptions(
        permission_mode="bypassPermissions",
        cwd=str(cwd),
        model=model,
        effort=effort or None,
        resume=resume_session_id if resume_session_id else None,
        setting_sources=["user", "project"],
        skills=selected_skills,
        mcp_servers=mcp_servers if mcp_servers else {},
        cli_path=cli_path,
        stderr=_stderr_handler,
        env=claude_env,
        settings=json.dumps({
            "model": model,
            "availableModels": available_models,
            "env": {key: value for key, value in claude_env.items() if key != "ANTHROPIC_AUTH_TOKEN"},
        }),
    )

    def _normalize_msg(msg) -> dict | None:
        """Convert an SDK message to our normalized event dict."""
        if isinstance(msg, AssistantMessage):
            content = []
            for block in msg.content:
                if isinstance(block, ThinkingBlock):
                    content.append({"type": "thinking", "thinking": block.thinking})
                elif isinstance(block, TextBlock):
                    content.append({"type": "text", "text": block.text})
                elif isinstance(block, ToolUseBlock):
                    content.append({
                        "type": "tool_use", "id": block.id,
                        "name": block.name, "input": block.input,
                    })
                elif isinstance(block, ToolResultBlock):
                    content.append({
                        "type": "tool_result",
                        "tool_use_id": getattr(block, "tool_use_id", "") or getattr(block, "id", ""),
                        "content": str(getattr(block, "content", "")),
                        "is_error": getattr(block, "is_error", False),
                    })
                elif isinstance(block, ServerToolUseBlock):
                    content.append({
                        "type": "tool_use", "id": block.id,
                        "name": block.name, "input": block.input,
                        "server": True,
                    })
                elif isinstance(block, ServerToolResultBlock):
                    content.append({
                        "type": "tool_result",
                        "tool_use_id": getattr(block, "tool_use_id", ""),
                        "content": str(getattr(block, "content", "")),
                        "server": True,
                    })
            if msg.error:
                content.append({
                    "type": "text",
                    "text": f"[API Error: {msg.error}]",
                })
            if not content:
                return None
            event = {"type": "assistant", "message": {"content": content}}
            if msg.usage:
                event["message"]["usage"] = msg.usage
            if msg.parent_tool_use_id:
                event["parent_tool_use_id"] = msg.parent_tool_use_id
            if msg.session_id and session_state is not None:
                session_state["claude_session_id"] = msg.session_id
            return event

        elif isinstance(msg, UserMessage):
            # UserMessage.content is normally a list of blocks. The CLI also
            # echoes back user turns we sent with plain-string content (the
            # initial prompt and broadcast injections) as a raw str. Those
            # are already rendered in the UI by app.py (the "user_prompt" and
            # "teammate_broadcast" events), so drop the echo here. Guard
            # explicitly — iterating a str would yield characters, not blocks.
            if isinstance(msg.content, str):
                return None
            content = []
            for block in msg.content:
                if isinstance(block, ToolResultBlock):
                    content.append({
                        "type": "tool_result",
                        "tool_use_id": getattr(block, "tool_use_id", "") or getattr(block, "id", ""),
                        "content": str(getattr(block, "content", "")),
                        "is_error": getattr(block, "is_error", False),
                    })
                elif isinstance(block, TextBlock):
                    content.append({"type": "text", "text": block.text})
            if content:
                return {"type": "user", "message": {"content": content}}

        elif isinstance(msg, TaskStartedMessage):
            desc = getattr(msg, "description", "") or ""
            task_type = getattr(msg, "task_type", "") or ""
            label = desc or task_type or "background task"
            return {"type": "system", "message": f"Started {label}"}

        elif isinstance(msg, TaskNotificationMessage):
            status = getattr(msg, "status", "")
            summary = getattr(msg, "summary", "")
            return {"type": "system", "message": f"Task {status}: {summary}" if summary else f"Task {status}"}

        elif isinstance(msg, TaskProgressMessage):
            return None

        elif isinstance(msg, SystemMessage):
            subtype = getattr(msg, "subtype", "")
            data = getattr(msg, "data", {}) or {}
            if session_state is not None and data.get("session_id"):
                session_state["claude_session_id"] = data["session_id"]
            if subtype == "init":
                servers = []
                for server in data.get("mcp_servers", []):
                    if not isinstance(server, dict) or not isinstance(server.get("name"), str):
                        continue
                    status = server.get("status")
                    servers.append({"name": server["name"], "status": status if status in {"connected", "failed", "pending", "disabled"} else "unknown"})
                return {"type": "runtime_resources", "agent": "claude",
                        "skills": selected_skills, "mcp_servers": servers}
            # Skip internal status subtypes that would otherwise render as
            # yellow status pills in the UI (see _DROP_SYSTEM_SUBTYPES).
            if subtype in _DROP_SYSTEM_SUBTYPES:
                log.debug("Dropping blacklisted Claude system subtype: %s", subtype)
                return None
            text = data.get("message", "") or subtype
            if text:
                return {"type": "system", "message": text}

        elif isinstance(msg, ResultMessage):
            event: dict = {"type": "result", "subtype": msg.subtype}
            if msg.is_error:
                event["is_error"] = True
            if msg.errors:
                event["errors"] = msg.errors
            if msg.api_error_status:
                event["api_error_status"] = msg.api_error_status
            if msg.result:
                event["result"] = msg.result
            if msg.total_cost_usd:
                event["total_cost_usd"] = msg.total_cost_usd
            if msg.usage:
                event["usage"] = msg.usage
            if msg.num_turns:
                event["num_turns"] = msg.num_turns
            if msg.duration_ms:
                event["duration_ms"] = msg.duration_ms
            if msg.duration_api_ms:
                event["duration_api_ms"] = msg.duration_api_ms
            if msg.model_usage:
                event["model_usage"] = msg.model_usage
            if msg.session_id and session_state is not None:
                session_state["claude_session_id"] = msg.session_id
            return event

        elif isinstance(msg, RateLimitEvent):
            info = msg.rate_limit_info
            if not info:
                return None
            status = getattr(info, "status", "")
            resets_at = getattr(info, "resets_at", None)
            rate_type = getattr(info, "rate_limit_type", "")
            utilization = getattr(info, "utilization", None)
            event = {
                "type": "rate_limit_event",
                "rate_limit_info": {
                    "status": status,
                    "utilization": utilization,
                    "resets_at": resets_at,
                    "rate_limit_type": rate_type,
                },
            }
            if status == "rejected":
                import time as _time
                wait_msg = ""
                if resets_at:
                    wait_secs = max(0, resets_at - _time.time())
                    wait_msg = f" (resets in {int(wait_secs)}s)"
                event["_also_system"] = {
                    "type": "system",
                    "message": f"Rate limited{wait_msg} — waiting for capacity",
                }
            return event

        elif isinstance(msg, StreamEvent):
            event_data = msg.event or {}
            event_type = event_data.get("type", "")
            if event_type == "system" and event_data.get("subtype") == "init":
                if session_state is not None and event_data.get("session_id"):
                    session_state["claude_session_id"] = event_data["session_id"]
                return None
            return event_data

        return None

    # Queue for broadcast messages to inject via streaming input.
    # Messages yielded by the generator are queued by the SDK and
    # delivered after Claude finishes its current tool call — no
    # interruption, no lost work.
    _broadcast_queue: asyncio.Queue[str] = asyncio.Queue()
    _broadcast_ui_events: asyncio.Queue[dict] = asyncio.Queue()
    _poll_task: asyncio.Task | None = None

    async def _poll_broadcasts():
        while True:
            await asyncio.sleep(5)
            try:
                pending = await get_pending_broadcast(challenge_id, run_id)
            except asyncio.CancelledError:
                raise
            except Exception:
                continue
            if not pending:
                continue
            log.info("Queuing broadcast for Claude streaming input")
            _broadcast_ui_events.put_nowait({
                "type": "system",
                "subtype": "teammate_broadcast",
                "message": f"[Teammate breakthrough]: {pending}",
            })
            await _broadcast_queue.put(pending)

    async def _message_stream():
        """Async generator that yields the initial prompt and any broadcasts."""
        yield {
            "type": "user",
            "message": {"role": "user", "content": prompt},
        }
        while True:
            pending = await _broadcast_queue.get()
            yield {
                "type": "user",
                "message": {
                    "role": "user",
                    "content": (
                        f"[Teammate breakthrough received]:\n{pending}\n\n"
                        "Incorporate this into your approach if relevant. "
                        "Continue working on the challenge."
                    ),
                },
            }

    client = ClaudeSDKClient(options)
    try:
        # Store ref so caller can kill process if needed
        _run = kwargs.get("_run")
        if _run is not None:
            _run["_sdk_client"] = client

        if challenge_id and run_id:
            _poll_task = asyncio.create_task(_poll_broadcasts())

        # connect() with async generator spawns stream_input as a
        # background task — messages are delivered between tool calls.
        await client.connect(_message_stream())
        if _run is not None:
            transport = getattr(client, "_transport", None)
            proc = getattr(transport, "_process", None) if transport else None
            pid = getattr(proc, "pid", None)
            if pid:
                _run["_agent_root_pid"] = pid
                try:
                    _run["_agent_pgid"] = os.getpgid(pid)
                except OSError:
                    _run["_agent_pgid"] = None

        try:
            status = await client.get_mcp_status()
            yield {"type": "runtime_resources", "agent": "claude", "skills": selected_skills,
                   "mcp_servers": [{"name": row["name"], "status": row.get("status", "unknown")}
                                   for row in status.get("mcpServers", []) if isinstance(row.get("name"), str)]}
        except Exception as exc:
            log.warning("Claude MCP status unavailable: %s", exc)

        async for msg in client.receive_messages():
                # Drain broadcast UI events
                while not _broadcast_ui_events.empty():
                    yield _broadcast_ui_events.get_nowait()

                event = _normalize_msg(msg)
                if event:
                    also = event.pop("_also_system", None)
                    yield event
                    if also:
                        yield also

    except asyncio.CancelledError:
        raise
    except Exception as exc:
        log.error("Claude SDK error: %s", exc, exc_info=True)
        err_msg = str(exc)
        if _stderr_lines:
            err_msg += "\nstderr:\n" + "\n".join(_stderr_lines[-20:])
        yield {"type": "error", "message": err_msg}
    finally:
        if _poll_task and not _poll_task.done():
            _poll_task.cancel()
        try:
            await asyncio.wait_for(client.disconnect(), timeout=10)
        except (Exception, asyncio.CancelledError, asyncio.TimeoutError):
            pass


# ---------------------------------------------------------------------------
# CLI fallback (build_command for legacy/subprocess path)
# ---------------------------------------------------------------------------

def _build_command(
    challenge: dict, prompt: str, is_continue: bool
) -> list[str]:
    cmd = [
        "claude",
        "-p",
        "--dangerously-skip-permissions",
        "--output-format",
        "stream-json",
        "--verbose",
    ]
    if challenge.get("model"):
        cmd.extend(["--model", challenge["model"]])
    if challenge.get("effort"):
        cmd.extend(["--effort", challenge["effort"]])
    if is_continue:
        cmd.append("--continue")
    cmd.append(prompt)
    return cmd


def _normalize_saved_events(events: list[dict]) -> list[dict]:
    return events


def _normalize_live_event(event: dict, challenge: dict) -> dict | None:
    return event


provider = AgentProvider(
    name="claude",
    label="Claude",
    effort_levels=("low", "medium", "high", "xhigh", "max"),
    badge_mode="model",
    build_command=_build_command,
    normalize_saved_events=_normalize_saved_events,
    normalize_live_event=_normalize_live_event,
    run_agent=_run_agent_sdk,
)
