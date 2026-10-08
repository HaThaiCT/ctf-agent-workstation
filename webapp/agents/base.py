from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Protocol

try:
    from ..model_gateway import GatewayRuntime
except ImportError:  # Direct webapp/app.py execution imports agents as a package.
    from model_gateway import GatewayRuntime


NormalizeLiveEvent = Callable[[dict, dict], dict | None]
NormalizeSavedEvents = Callable[[list[dict]], list[dict]]
BuildCommand = Callable[[dict, str, bool], list[str]]

# Type for SDK-based run_agent: yields normalized events
RunAgent = Callable[..., AsyncIterator[dict]]
class SetThreadGoal(Protocol):
    def __call__(
        self, thread_id: str, objective: str, cwd: str | Path = ".",
        *, gateway: GatewayRuntime,
    ) -> Awaitable[dict | None]: ...


class ClearThreadGoal(Protocol):
    def __call__(
        self, thread_id: str, cwd: str | Path = ".",
        *, gateway: GatewayRuntime,
    ) -> Awaitable[bool]: ...


@dataclass(frozen=True)
class AgentProvider:
    name: str
    label: str
    badge_mode: str
    build_command: BuildCommand
    normalize_saved_events: NormalizeSavedEvents
    normalize_live_event: NormalizeLiveEvent
    effort_levels: tuple[str, ...] = ()
    # SDK-based agent runner. If set, run_agent_task uses this instead
    # of build_command + subprocess. Signature:
    #   async def run_agent(prompt, model, effort, cwd, continue_session, session_state, **kw) -> AsyncIterator[dict]
    run_agent: RunAgent | None = None
    set_thread_goal: SetThreadGoal | None = None
    clear_thread_goal: ClearThreadGoal | None = None

    @property
    def supports_sdk(self) -> bool:
        return self.run_agent is not None

