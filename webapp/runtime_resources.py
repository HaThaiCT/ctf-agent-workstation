"""Automatic CTF skill sources and per-workspace native MCP configuration.

No import-time I/O. Native clients keep their existing global MCP configuration;
only the workstation-owned debugger is added to each child session.
"""

from __future__ import annotations

import asyncio
import importlib.util
import json
import os
import shutil
import sys
import tempfile
from pathlib import Path
try:
    from .tool_environment import HostEnvironment
except ImportError:
    try:
        from tool_environment import HostEnvironment
    except ImportError:
        HostEnvironment = None  # type: ignore


EXTERNAL_SKILLS_URL = "https://github.com/ljagiello/ctf-skills.git"
MCP_CONFIG_FILE = ".ctf-mcp.json"


def skill_source_roots(app_root: Path, repo_root: Path) -> tuple[Path, ...]:
    """Ordered sources; runtime/uploaded names take precedence over bundled names."""
    roots = (
        repo_root / "skills",
        app_root / "cache/ctf-skills",
        app_root / "skills",
        app_root / "all-skills",
    )
    return tuple(dict.fromkeys(path.resolve() for path in roots))


async def bootstrap_skill_sources(app_root: Path) -> dict:
    """Fetch the established category library once, without replacing user skills."""
    destination = app_root / "cache/ctf-skills"
    if destination.is_dir() and any(destination.rglob("SKILL.md")):
        return {"status": "ready", "error": ""}
    git = shutil.which("git")
    if not git:
        return {
            "status": "error",
            "error": "Category skill download requires git; bundled skills remain available",
        }
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = Path(tempfile.mkdtemp(prefix=".ctf-skills-", dir=destination.parent))
    process = None
    try:
        process = await asyncio.create_subprocess_exec(
            git,
            "clone",
            "--depth",
            "1",
            EXTERNAL_SKILLS_URL,
            str(temporary),
            stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.PIPE,
        )
        async with asyncio.timeout(60):
            _, _ = await process.communicate()
        if process.returncode != 0 or not any(temporary.rglob("SKILL.md")):
            return {
                "status": "error",
                "error": "Category skill download failed; bundled skills remain available",
            }
        if destination.exists():
            return {
                "status": "error",
                "error": "Category skill cache already exists; existing contents were preserved",
            }
        os.replace(temporary, destination)
        return {"status": "ready", "error": ""}
    except (OSError, TimeoutError):
        return {
            "status": "error",
            "error": "Category skill download unavailable; bundled skills remain available",
        }
    finally:
        if process is not None and process.returncode is None:
            process.kill()
            await process.wait()
        if temporary.exists():
            await asyncio.to_thread(shutil.rmtree, temporary)


_CATEGORY_SKILLS = {
    "pwn": ("ctf-pwn", "kernel-gef-debugging", "craft-rop-chains-with-angrop"),
    "reverse": ("ctf-reverse", "analyze-with-ida-domain-api"),
    "crypto": ("ctf-crypto",),
    "web": ("ctf-web",),
    "forensics": (
        "ctf-forensics",
        "tsk-disk-recovery",
        "file-repair-and-stego",
        "volatility3-memdump",
        "pcap-extraction",
    ),
    "osint": ("ctf-osint",),
    "malware": ("ctf-malware", "analyze-with-ida-domain-api"),
    "ai": ("ctf-ai-ml",),
    "misc": ("ctf-misc",),
}
_CATEGORY_ALIASES = {
    "pwn": "pwn",
    "binary exploitation": "pwn",
    "exploitation": "pwn",
    "kernel": "pwn",
    "rev": "reverse",
    "reverse": "reverse",
    "reversing": "reverse",
    "reverse engineering": "reverse",
    "crypto": "crypto",
    "cryptography": "crypto",
    "web": "web",
    "web exploitation": "web",
    "forensic": "forensics",
    "forensics": "forensics",
    "stego": "forensics",
    "steganography": "forensics",
    "osint": "osint",
    "malware": "malware",
    "ai": "ai",
    "ml": "ai",
    "ai/ml": "ai",
    "ai-ml": "ai",
    "misc": "misc",
    "miscellaneous": "misc",
}

def _resolve_category_skills(category: str, env: HostEnvironment | None = None) -> tuple[str, ...]:
    """Resolve skills for a category based on available host environment capabilities."""
    if env is None:
        return _CATEGORY_SKILLS.get(category, ())

    if category in ("reverse", "malware"):
        skills = ["ctf-reverse"] if category == "reverse" else ["ctf-malware"]
        if env.has_ida_license:
            skills.append("analyze-with-ida-domain-api")
        else:
            if env.has_ghidra:
                skills.append("ghidra-headless-decompilation")
            if env.tools.get("rizin") and env.tools["rizin"].available:
                skills.append("rizin-disassembly")
        return tuple(skills)

    if category == "crypto":
        skills = ["ctf-crypto"]
        if env.has_sagemath:
            skills.append("sagemath-crypto-solvers")
        return tuple(skills)

    if category == "pwn":
        skills = ["ctf-pwn"]
        if env.has_gdb_enhanced:
            skills.append("kernel-gef-debugging")
        skills.append("craft-rop-chains-with-angrop")
        return tuple(skills)

    return _CATEGORY_SKILLS.get(category, ())


def select_automatic_skills(
    challenge: dict,
    catalog: list[dict],
    env: HostEnvironment | None = None,
) -> list[str]:
    """Select base/category/file skills; uncertain challenges expose category skills."""
    available = {entry["name"] for entry in catalog}
    selected = {
        name
        for name in ("ctf-methodology", "ground-your-findings")
        if name in available
    }
    category = _CATEGORY_ALIASES.get(str(challenge.get("category", "")).strip().lower())
    if category:
        selected.update(_resolve_category_skills(category, env))

    files = [str(name).lower() for name in challenge.get("files", [])]
    has_kernel = any(any(kw in f for kw in ("vmlinuz", "bzimage", ".ko")) for f in files)
    if has_kernel:
        selected.add("kernel-gef-debugging")

    extensions = {Path(str(name)).suffix.lower() for name in challenge.get("files", [])}
    if extensions & {".apk", ".dex"}:
        selected.update(("apk-analysis", "ctf-reverse"))
    if extensions & {".pcap", ".pcapng", ".cap"}:
        selected.update(("pcap-extraction", "ctf-forensics"))
    if extensions & {".elf", ".exe", ".dll", ".so", ".bin"}:
        selected.update(_resolve_category_skills("reverse", env))
        selected.add("ctf-pwn")
        selected.add("craft-rop-chains-with-angrop")
    if extensions & {".vmem", ".mem", ".dmp"}:
        selected.update(("volatility3-memdump", "ctf-forensics"))
    if extensions & {".img", ".vhd", ".vhdx", ".dd", ".e01"}:
        selected.update(("tsk-disk-recovery", "ctf-forensics"))
    if extensions & {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".zip"}:
        selected.add("file-repair-and-stego")
    if not category and not (selected - {"ctf-methodology", "ground-your-findings"}):
        # Native skill descriptions permit on-demand discovery when category is unknown.
        for cat in _CATEGORY_SKILLS:
            selected.update(_resolve_category_skills(cat, env))
        selected.add("apk-analysis")
    return sorted(selected & available)

def builtin_mcp_status(repo_root: Path) -> dict:
    script = repo_root / "mcps/gdb_mcp.py"
    error = ""
    if not script.is_file():
        error = "GDB MCP server source is unavailable"
    elif not shutil.which("gdb"):
        error = "GDB executable is unavailable"
    elif (
        importlib.util.find_spec("mcp") is None
        or importlib.util.find_spec("mcp.server.mcpserver") is None
    ):
        error = "Python MCP 2.x dependency is unavailable"
    return {
        "name": "ctf_gdb",
        "source": "builtin",
        "transport": "stdio",
        "available": not error,
        "status": "available" if not error else "unavailable",
        "error": error,
    }


def _builtin_mcp_servers(repo_root: Path) -> dict:
    if not builtin_mcp_status(repo_root)["available"]:
        return {}
    return {
        "ctf_gdb": {
            "type": "stdio",
            "command": sys.executable,
            "args": [str((repo_root / "mcps/gdb_mcp.py").resolve())],
        }
    }


def prepare_workspace_mcp(cwd: Path, repo_root: Path) -> dict:
    """Materialize only workstation-owned MCP config; preserve native/global servers."""
    servers = _builtin_mcp_servers(repo_root)
    content = json.dumps({"mcpServers": servers}, indent=2) + "\n"
    path = cwd / MCP_CONFIG_FILE
    try:
        unchanged = path.read_text() == content
    except OSError:
        unchanged = False
    if not unchanged:
        cwd.mkdir(parents=True, exist_ok=True)
        fd, temporary = tempfile.mkstemp(prefix=".ctf-mcp-", dir=cwd)
        try:
            with os.fdopen(fd, "w") as stream:
                stream.write(content)
            os.replace(temporary, path)
        finally:
            Path(temporary).unlink(missing_ok=True)
    return builtin_mcp_status(repo_root)


def workspace_mcp_servers(cwd: str | Path) -> dict:
    """Read resolved child configuration; direct harness calls get the same builtin."""
    path = Path(cwd) / MCP_CONFIG_FILE
    if path.is_file():
        try:
            data = json.loads(path.read_text())
            servers = data.get("mcpServers")
            if isinstance(servers, dict):
                return servers
        except (OSError, ValueError, AttributeError):
            raise RuntimeError("Run MCP configuration is invalid") from None
        raise RuntimeError("Run MCP configuration is invalid")
    return _builtin_mcp_servers(Path(__file__).resolve().parent.parent)
