"""Local 9router discovery, catalog policy, and private native runtime metadata."""

from __future__ import annotations

import asyncio
import copy
import json
import os
import pwd
import re
import shutil
import tempfile
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlsplit

import httpx

DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1"
POSITIVE_LEVELS = ("low", "medium", "high", "xhigh", "max")


class GatewayError(RuntimeError):
    def __init__(self, public_message: str, status_code: int = 503):
        super().__init__(public_message)
        self.status_code = status_code
        self.public_message = public_message


@dataclass(frozen=True)
class GatewayConfig:
    base_url: str
    api_key: str = field(repr=False)
    claude_cli: str = ""
    codex_command: tuple[str, ...] = ()
    codex_catalog_source: str = ""


@dataclass(frozen=True)
class GatewayRuntime:
    config: GatewayConfig
    model: str
    effort: str
    codex_catalog_path: str


def _json(path: Path) -> dict:
    try:
        value = json.loads(path.read_text())
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError):
        return {}


def _base_url(value: str) -> str:
    value = value.strip().rstrip("/") or DEFAULT_BASE_URL
    try:
        parsed = urlsplit(value)
        _ = (
            parsed.port
        )  # Validate malformed/out-of-range ports as configuration errors.
        valid = (
            parsed.scheme in ("http", "https")
            and parsed.hostname
            and not (
                parsed.query or parsed.fragment or parsed.username or parsed.password
            )
        )
    except ValueError:
        valid = False
    if not valid:
        raise GatewayError("Invalid 9router base URL", 400)
    return value


def _executable(path: Path) -> bool:
    return path.is_file() and os.access(path, os.X_OK)


def _client_roots() -> list[Path]:
    roots = []
    for name in ("claude", "codex"):
        command = shutil.which(name)
        if command:
            target = Path(command).resolve()
            if (
                target.parent.name == "wrappers"
                and target.parent.parent.name == "9router-clients"
            ):
                roots.append(target.parent.parent)
    roots.append(Path.home() / "Documents/Codex/runtime/9router-clients")
    roots.extend(
        sorted(Path("/home").glob("*/Documents/Codex/runtime/9router-clients"))
    )
    return list(dict.fromkeys(roots))


def _key_candidates(entry: dict) -> list[Path]:
    paths = [Path(entry["key_file"])] if entry.get("key_file") else []
    paths.extend(root / "api-key" for root in _client_roots())
    return list(dict.fromkeys(paths))


def _read_key(path: Path) -> str:
    try:
        return path.read_text().strip()
    except OSError:
        return ""


def normalize_gateway_models(rows: list[dict]) -> list[dict]:
    if not isinstance(rows, list):
        raise GatewayError("9router returned an invalid model catalog")
    seen = set()
    models = []
    for row in rows:
        if (
            not isinstance(row, dict)
            or not isinstance(row.get("id"), str)
            or not row["id"].strip()
            or row["id"] in seen
        ):
            raise GatewayError("9router returned an invalid model catalog")
        seen.add(row["id"])
        caps = row.get("capabilities", {})
        if not isinstance(caps, dict):
            raise GatewayError("9router returned an invalid model catalog")
        if (
            caps.get("tools") is False
            or row.get("type", "llm") not in ("llm", "chat", "language", "text")
            or caps.get("imageOutput")
            or caps.get("audioOutput")
        ):
            continue
        models.append(
            {
                "id": row["id"],
                "owned_by": row.get("owned_by", ""),
                "capabilities": dict(caps),
                "context_length": row.get("context_length"),
            }
        )
    return sorted(models, key=lambda row: row["id"])


def _effort_policy(model: dict) -> tuple[tuple[str, ...], str]:
    name = model["id"]
    caps = model.get("capabilities", {})
    profile = caps.get("thinkingFormat", "")
    if caps.get("reasoning") is False:
        return (), "No verified adjustable effort mapping"
    if re.match(r"cx/gpt-5\.5(?:-review)?(?:\[1m\])?$", name):
        return POSITIVE_LEVELS[:-1], ""
    if name.startswith("cx/") and (
        profile in ("openai", "reasoning") or re.match(r"cx/gpt-(6|5\.6)", name)
    ):
        return POSITIVE_LEVELS, ""
    if name == "cmc/xiaomi/mimo-v2.5-pro":
        return POSITIVE_LEVELS[:-1], ""
    if name.startswith("cmc/") and profile in ("commandcode", "reasoning"):
        return POSITIVE_LEVELS, ""
    if name.startswith("ag/"):
        if re.match(
            r"ag/gemini-3\.8-flash(?:-(?:high|medium|low))?$", name
        ) or re.match(r"ag/gemini-3\.[67]-flash-(?:high|medium|low)$", name):
            return (), "Effort is fixed by this model variant"
        if profile in ("claude-adaptive", "claude-budget", "openai"):
            return (
                (),
                "9router currently does not forward adjustable effort for this model",
            )
        if profile == "gemini-level":
            if name == "ag/gemini-3.1-pro-low":
                return ("low", "high"), ""
            if name in (
                "ag/gemini-3.5-flash-high",
                "ag/gemini-3-flash-agent",
                "ag/gemini-3.5-flash-low",
                "ag/gemini-3.5-flash-extra-low",
                "ag/gemini-3-flash",
            ):
                return ("low", "medium", "high"), ""
    return (), "No verified adjustable effort mapping"


def gateway_efforts(
    model: dict, agent: str, native_levels: tuple[str, ...]
) -> tuple[str, ...]:
    levels, _ = _effort_policy(model)
    return tuple(level for level in levels if level in native_levels)


def resolve_gateway_selection(
    entry: dict, *, models: list[dict], settings: dict, native_levels: tuple[str, ...]
) -> dict:
    agent = entry.get("agent", "")
    available = {model["id"]: model for model in models}
    presets = settings.get("agent_models", {})
    if "model" in entry:
        model = entry["model"]
    else:
        candidates = [
            presets.get(agent),
            settings.get("native_models", {}).get(agent),
            "ag/claude-sonnet-4-6" if agent == "claude" else "cx/gpt-6.1-sol",
        ]
        model = next(
            (candidate for candidate in candidates if candidate in available),
            next(iter(available), ""),
        )
    if not isinstance(model, str) or model not in available:
        raise GatewayError(f"Model '{model}' is unavailable in 9router", 400)
    levels = gateway_efforts(available[model], agent, native_levels)
    if "effort" in entry:
        effort = entry["effort"]
    else:
        preset = settings.get("agent_efforts", {}).get(agent)
        effort = (
            preset
            if preset == "" or preset in levels
            else "medium"
            if "medium" in levels
            else next(iter(levels), "")
        )
    if not isinstance(effort, str) or (effort and effort not in levels):
        raise GatewayError(f"Unsupported effort '{effort}' for model '{model}'", 400)
    return {"agent": agent, "model": model, "effort": effort}


def gateway_agent_metadata(provider, models: list[dict], settings: dict) -> dict:
    native = tuple(
        value[0] if isinstance(value, tuple) else value
        for value in provider.effort_levels
    )
    public_models = []
    for model in models:
        levels = gateway_efforts(model, provider.name, native)
        _, note = _effort_policy(model)
        public_models.append(
            {
                "value": model["id"],
                "label": model["id"],
                "owned_by": model["owned_by"],
                "effort_mode": "selectable" if levels else "managed",
                "effort_levels": [
                    {
                        "value": "",
                        "label": "Harness/provider default"
                        if levels
                        else "Provider-managed",
                    }
                ]
                + [
                    {
                        "value": level,
                        "label": "XHigh" if level == "xhigh" else level.capitalize(),
                    }
                    for level in levels
                ],
                "default_effort": "medium"
                if "medium" in levels
                else next(iter(levels), ""),
                "effort_note": note if not levels else "",
            }
        )
    selection = (
        resolve_gateway_selection(
            {"agent": provider.name},
            models=models,
            settings=settings,
            native_levels=native,
        )
        if models
        else {"model": "", "effort": ""}
    )
    return {
        "name": provider.name,
        "label": provider.label,
        "badge_mode": provider.badge_mode,
        "models": public_models,
        "default_model": selection["model"],
        "selected_effort": selection["effort"],
    }


class ModelGateway:
    def __init__(self, state_file: Path):
        self.state_file = state_file
        self._models: list[dict] = []
        self._expiry = 0.0
        self._lock = asyncio.Lock()
        self._source = ""
        self._key_file = ""
        self._error = ""

    def _entry(self) -> dict:
        value = _json(self.state_file).get("9router", {})
        return value if isinstance(value, dict) else {}

    def load_config(self) -> GatewayConfig:
        entry = self._entry()
        base_url = _base_url(str(entry.get("base_url", "")))
        key = str(entry.get("api_key", "")).strip()
        self._source, self._key_file = ("saved", "") if key else ("", "")
        if not key:
            key = os.environ.get("NINEROUTER_API_KEY", "").strip()
            if key:
                self._source = "env"
        roots = _client_roots()
        if not key:
            for path in _key_candidates(entry):
                key = _read_key(path)
                if key:
                    self._source, self._key_file = "file", str(path)
                    if path.parent.name == "9router-clients":
                        roots.insert(0, path.parent)
                    break
        root = next((root for root in roots if root.is_dir()), None)
        owner = Path(pwd.getpwuid(root.stat().st_uid).pw_dir) if root else Path.home()
        claude = str(entry.get("claude_cli", ""))
        if not claude:
            native = (
                root / "native/claude"
                if root
                else Path(shutil.which("claude") or "/nonexistent")
            )
            if _executable(native) and "wrappers" not in native.resolve().parts:
                claude = str(native)
        elif not _executable(Path(claude)):
            claude = ""
        command = entry.get("codex_command", [])
        command = (
            tuple(command)
            if isinstance(command, list)
            and all(isinstance(item, str) for item in command)
            else ()
        )
        if not command:
            if root:
                node = owner / ".local/bin/node"
                if not _executable(node):
                    node = Path(shutil.which("node") or "/nonexistent")
                js = owner / ".local/lib/node_modules/@openai/codex/bin/codex.js"
                if _executable(node) and js.is_file():
                    command = (str(node), str(js))
            else:
                native = Path(shutil.which("codex") or "/nonexistent")
                if _executable(native) and "wrappers" not in native.resolve().parts:
                    command = (str(native),)
        if command and (
            not _executable(Path(command[0]))
            or (len(command) > 1 and not Path(command[1]).is_file())
        ):
            command = ()
        sources = (
            [Path(entry["codex_catalog_source"])]
            if entry.get("codex_catalog_source")
            else []
        )
        if root:
            sources.append(root / "codex-models.json")
        sources.append(
            Path(os.environ.get("CODEX_HOME", str(owner / ".codex")))
            / "models_cache.json"
        )
        source = next((str(path) for path in sources if self._templates(path)), "")
        return GatewayConfig(base_url, key, claude, command, source)

    @staticmethod
    def _templates(path: Path) -> list[dict]:
        rows = _json(path).get("models", [])
        return (
            [
                row
                for row in rows
                if isinstance(row, dict)
                and isinstance(row.get("base_instructions"), str)
                and row["base_instructions"].strip()
                and isinstance(row.get("slug"), str)
            ]
            if isinstance(rows, list)
            else []
        )

    def save_config(self, values: dict) -> None:
        data = _json(self.state_file)
        entry = self._entry().copy()
        base_url = values.get("base_url", "")
        if not isinstance(base_url, str):
            raise GatewayError("Invalid 9router base URL", 400)
        entry["base_url"] = base_url.strip().rstrip("/") or DEFAULT_BASE_URL
        key = values.get("api_key", "")
        if not isinstance(key, str):
            raise GatewayError("Invalid 9router API key", 400)
        if key.strip():
            entry["api_key"] = key.strip()
        elif not (
            entry.get("api_key")
            or os.environ.get("NINEROUTER_API_KEY", "").strip()
            or any(_read_key(path) for path in _key_candidates(entry))
        ):
            raise GatewayError("9router API key is required", 400)
        elif self._source == "file" and self._key_file:
            entry["key_file"] = self._key_file
        data["9router"] = entry
        self._save(data)
        self._models, self._expiry = [], 0.0

    async def configure(self, values: dict) -> None:
        """Serialize Web configuration writes with catalog refresh and runtime I/O."""
        async with self._lock:
            await asyncio.to_thread(self.save_config, values)

    def _save(self, data: dict) -> None:
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        self.state_file.write_text(json.dumps(data, indent=2))

    async def catalog(self, *, force_refresh: bool = False) -> list[dict]:
        requested_at = time.monotonic()
        async with self._lock:
            if self._expiry > requested_at and (
                not force_refresh or self._expiry - 30 >= requested_at
            ):
                return copy.deepcopy(self._models)
            try:
                config = await asyncio.to_thread(self.load_config)
                candidates = [(config.api_key, self._key_file)]
                if self._source == "file":
                    candidates = [
                        (await asyncio.to_thread(_read_key, path), str(path))
                        for path in _key_candidates(self._entry())
                    ]
                if not config.api_key:
                    raise GatewayError("9router API key is required", 400)
                async with httpx.AsyncClient(timeout=8.0, trust_env=False) as client:
                    response = None
                    selected_path = ""
                    for key, path in candidates:
                        if not key:
                            continue
                        response = await client.get(
                            config.base_url + "/models",
                            headers={"Authorization": "Bearer " + key},
                        )
                        if (
                            response.status_code in (401, 403)
                            and self._source == "file"
                        ):
                            continue
                        selected_path = path
                        break
                    if response is None:
                        raise GatewayError("9router API key is required", 400)
                    if response.status_code in (401, 403):
                        raise GatewayError("9router authentication failed")
                    if not response.is_success:
                        raise GatewayError("9router catalog unavailable")
                    payload = response.json()
                    if not isinstance(payload, dict):
                        raise GatewayError("9router returned an invalid model catalog")
                    models = normalize_gateway_models(payload.get("data"))
                if selected_path:
                    data = await asyncio.to_thread(_json, self.state_file)
                    entry = data.setdefault("9router", {})
                    if entry.get("key_file") != selected_path:
                        entry["key_file"] = selected_path
                        await asyncio.to_thread(self._save, data)
                self._models, self._expiry, self._error = (
                    models,
                    time.monotonic() + 30,
                    "",
                )
                return copy.deepcopy(models)
            except (httpx.HTTPError, OSError) as exc:
                self._models, self._expiry, self._error = (
                    [],
                    0.0,
                    "9router catalog unavailable",
                )
                raise GatewayError(self._error) from exc
            except (ValueError, GatewayError) as exc:
                self._models, self._expiry = [], 0.0
                self._error = (
                    exc.public_message
                    if isinstance(exc, GatewayError)
                    else "9router returned an invalid model catalog"
                )
                raise GatewayError(
                    self._error,
                    exc.status_code if isinstance(exc, GatewayError) else 503,
                ) from exc

    def native_models(self) -> dict[str, str]:
        roots = _client_roots()
        root = next((root for root in roots if root.is_dir()), None)
        owner = Path(pwd.getpwuid(root.stat().st_uid).pw_dir) if root else Path.home()
        result = {"claude": _json(owner / ".claude/settings.json").get("model", "")}
        try:
            config = tomllib.loads(
                (
                    Path(os.environ.get("CODEX_HOME", str(owner / ".codex")))
                    / "config.toml"
                ).read_text()
            )
            result["codex"] = (
                config.get("profiles", {}).get("ninerouter", {}).get("model", "")
            )
        except (OSError, ValueError):
            pass
        return result

    async def public_status(self, *, force_refresh: bool = False) -> dict:
        error = ""
        models = []
        try:
            models = await self.catalog(force_refresh=force_refresh)
        except GatewayError as exc:
            error = exc.public_message
        try:
            config = await asyncio.to_thread(self.load_config)
        except GatewayError as exc:
            return {
                "provider": "9router",
                "base_url": self._entry().get("base_url", DEFAULT_BASE_URL),
                "key_configured": False,
                "source": "",
                "status": "error",
                "error": exc.public_message,
                "harnesses": {
                    name: {
                        "available": False,
                        "ready": False,
                        "error": exc.public_message,
                    }
                    for name in ("claude", "codex")
                },
            }
        status = "error" if error else "ready" if models else "empty"
        harnesses = {}
        for name, available, native_error in (
            (
                "claude",
                bool(config.claude_cli),
                "Claude native launcher is unavailable",
            ),
            (
                "codex",
                bool(config.codex_command and config.codex_catalog_source),
                "Codex model metadata is unavailable"
                if not config.codex_catalog_source
                else "Codex native launcher is unavailable",
            ),
        ):
            harnesses[name] = {
                "available": available,
                "ready": available and status == "ready",
                "error": native_error if not available else error,
            }
        return {
            "provider": "9router",
            "base_url": config.base_url,
            "key_configured": bool(config.api_key),
            "source": self._source,
            "status": status,
            "error": error,
            "harnesses": harnesses,
        }

    async def runtime(
        self,
        agent: str,
        selection: dict,
        models: list[dict],
        native_levels: tuple[str, ...],
    ) -> GatewayRuntime:
        selection = resolve_gateway_selection(
            selection, models=models, settings={}, native_levels=native_levels
        )
        async with self._lock:
            config = await asyncio.to_thread(self.load_config)
            if not config.api_key:
                raise GatewayError("9router API key is required", 400)
            catalog_path = ""
            if agent == "claude" and not config.claude_cli:
                raise GatewayError("Claude native launcher is unavailable")
            if agent == "codex":
                if not config.codex_command:
                    raise GatewayError("Codex native launcher is unavailable")
                if not config.codex_catalog_source:
                    raise GatewayError("Codex model metadata is unavailable")
                catalog_path = await asyncio.to_thread(
                    self._write_codex_catalog, config, models, native_levels
                )
            return GatewayRuntime(
                config, selection["model"], selection["effort"], catalog_path
            )

    def _write_codex_catalog(
        self, config: GatewayConfig, models: list[dict], native_levels: tuple[str, ...]
    ) -> str:
        templates = self._templates(Path(config.codex_catalog_source))
        if not templates:
            raise GatewayError("Codex model metadata is unavailable")
        by_slug = {row["slug"]: row for row in templates}
        rows = []
        for model in models:
            row = copy.deepcopy(by_slug.get(model["id"], templates[0]))
            levels = gateway_efforts(model, "codex", native_levels)
            row.update(
                slug=model["id"],
                display_name=model["id"],
                description="9Router · " + str(model["owned_by"]),
                default_reasoning_level="medium"
                if "medium" in levels
                else next(iter(levels), None),
                supported_reasoning_levels=[
                    {"effort": level, "description": level.capitalize()}
                    for level in levels
                ],
                supports_reasoning_effort_updates=bool(levels),
                input_modalities=["text"]
                + (["image"] if model["capabilities"].get("vision") else []),
            )
            context = model.get("context_length") or model["capabilities"].get(
                "contextWindow"
            )
            if (
                isinstance(context, int)
                and not isinstance(context, bool)
                and context > 0
            ):
                row["context_window"] = context
            rows.append(row)
        content = json.dumps({"models": rows}, ensure_ascii=False, indent=2) + "\n"
        path = self.state_file.parent / "gateway-codex-models.json"
        try:
            if path.read_text() == content:
                return str(path)
        except OSError:
            pass
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".gateway-models-", dir=path.parent)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
        return str(path)
