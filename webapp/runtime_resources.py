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
    "pwn": ("ctf-pwn", "kernel-gef-debugging", "craft-rop-chains-with-angrop", "pwntools-exploit-crafting"),
    "reverse": ("ctf-reverse", "analyze-with-ida-domain-api"),
    "crypto": ("ctf-crypto",),
    "web": ("ctf-web", "web-exploitation-toolkit"),
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
def normalize_challenge_category(cat_str: str) -> str:
    """Normalize challenge category string into canonical CTF domain."""
    if not cat_str or not isinstance(cat_str, str):
        return ""
    clean = cat_str.strip().lower()
    if not clean:
        return ""
    if clean in _CATEGORY_ALIASES:
        return _CATEGORY_ALIASES[clean]

    # Token and keyword matching for non-standard categories
    if any(k in clean for k in ("pwn", "exploit", "binary", "heap", "bof", "rop", "kernel")):
        return "pwn"
    if any(k in clean for k in ("web", "http", "api", "xss", "sqli", "injection")):
        return "web"
    if any(k in clean for k in ("rev", "revers", "crack", "decompile")):
        return "reverse"
    if any(k in clean for k in ("crypto", "cipher", "rsa", "ecc")):
        return "crypto"
    if any(k in clean for k in ("forensic", "stego", "pcap", "memory", "disk")):
        return "forensics"
    if "osint" in clean:
        return "osint"
    if "malware" in clean:
        return "malware"
    if any(k in clean for k in ("ai", "ml")):
        return "ai"
    if "misc" in clean:
        return "misc"
    return ""


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

    if category == "web":
        skills = ["ctf-web"]
        if env is None or env.has_web_tools:
            skills.append("web-exploitation-toolkit")
        return tuple(skills)

    if category == "pwn":
        skills = ["ctf-pwn"]
        if env is None or env.has_gdb_enhanced:
            skills.append("kernel-gef-debugging")
        skills.append("craft-rop-chains-with-angrop")
        if env is None or (env.tools.get("pwntools") and env.tools["pwntools"].available):
            skills.append("pwntools-exploit-crafting")
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
    category = normalize_challenge_category(str(challenge.get("category", "")))
    if category:
        selected.update(_resolve_category_skills(category, env))

    files = [str(name).lower() for name in challenge.get("files", [])]
    has_kernel = any(any(kw in f for kw in ("vmlinuz", "bzimage", ".ko")) for f in files)
    if has_kernel:
        selected.add("kernel-gef-debugging")

    extensions = {Path(str(name)).suffix.lower() for name in challenge.get("files", [])}
    has_so_version = any(".so" in f for f in files)

    if extensions & {".apk", ".dex"}:
        selected.update(("apk-analysis", "ctf-reverse"))
    if extensions & {".pcap", ".pcapng", ".cap"}:
        selected.update(("pcap-extraction", "ctf-forensics"))

    # Binary/ELF detection: explicit binary extensions, .so versions, or files in pwn category
    is_binary_file = bool(
        extensions & {".elf", ".exe", ".dll", ".so", ".bin"}
        or has_so_version
        or (category in ("pwn", "reverse") and files)
    )
    if is_binary_file:
        selected.update(_resolve_category_skills("reverse", env))
        selected.update(_resolve_category_skills("pwn", env))

    if extensions & {".vmem", ".mem", ".dmp"}:
        selected.update(("volatility3-memdump", "ctf-forensics"))
    if extensions & {".img", ".vhd", ".vhdx", ".dd", ".e01"}:
        selected.update(("tsk-disk-recovery", "ctf-forensics"))
    if extensions & {".png", ".jpg", ".jpeg", ".gif", ".pdf", ".doc", ".docx", ".zip"}:
        selected.add("file-repair-and-stego")

    # Web file detection: web assets / node / python web
    is_web_file = bool(
        extensions & {".php", ".js", ".ts", ".html", ".css"}
        or any(f in ("package.json", "server.js", "requirements.txt", "docker-compose.yml", "dockerfile") for f in files)
    )
    if is_web_file and category not in ("pwn", "reverse", "crypto", "forensics"):
        selected.update(_resolve_category_skills("web", env))

    # Do NOT dump all categories when category is unknown.
    # Retain only base methodology skills unless specific file types above were detected.
    return sorted(selected & available)

def builtin_mcp_statuses(repo_root: Path) -> list[dict]:
    mcp_available = False
    try:
        if importlib.util.find_spec("mcp") is not None:
            if importlib.util.find_spec("mcp.server") is not None and importlib.util.find_spec("mcp.server.mcpserver") is not None:
                mcp_available = True
    except Exception:
        mcp_available = False

    statuses = []

    # 1. ctf_gdb
    gdb_script = repo_root / "mcps/gdb_mcp.py"
    gdb_err = ""
    if not gdb_script.is_file():
        gdb_err = "GDB MCP server source is unavailable"
    elif not shutil.which("gdb"):
        gdb_err = "GDB executable is unavailable"
    elif not mcp_available:
        gdb_err = "Python MCP 2.x dependency is unavailable"

    statuses.append({
        "name": "ctf_gdb",
        "source": "builtin",
        "transport": "stdio",
        "available": not gdb_err,
        "status": "available" if not gdb_err else "unavailable",
        "error": gdb_err,
    })

    # 2. ctf_decoder
    decoder_script = repo_root / "mcps/decoder_mcp.py"
    decoder_err = ""
    if not decoder_script.is_file():
        decoder_err = "Decoder MCP server source is unavailable"
    elif not mcp_available:
        decoder_err = "Python MCP 2.x dependency is unavailable"

    statuses.append({
        "name": "ctf_decoder",
        "source": "builtin",
        "transport": "stdio",
        "available": not decoder_err,
        "status": "available" if not decoder_err else "unavailable",
        "error": decoder_err,
    })

    # 3. ctf_binary
    binary_script = repo_root / "mcps/binary_mcp.py"
    binary_err = ""
    if not binary_script.is_file():
        binary_err = "Binary MCP server source is unavailable"
    elif not shutil.which("readelf"):
        binary_err = "readelf executable is unavailable"
    elif not shutil.which("strings"):
        binary_err = "strings executable is unavailable"
    elif not shutil.which("rizin"):
        binary_err = "rizin executable is unavailable"
    elif not mcp_available:
        binary_err = "Python MCP 2.x dependency is unavailable"

    statuses.append({
        "name": "ctf_binary",
        "source": "builtin",
        "transport": "stdio",
        "available": not binary_err,
        "status": "available" if not binary_err else "unavailable",
        "error": binary_err,
    })

    return statuses


def _builtin_mcp_servers(repo_root: Path) -> dict:
    statuses = builtin_mcp_statuses(repo_root)
    script_map = {
        "ctf_gdb": "mcps/gdb_mcp.py",
        "ctf_decoder": "mcps/decoder_mcp.py",
        "ctf_binary": "mcps/binary_mcp.py",
    }
    servers = {}
    for row in statuses:
        if row["available"]:
            script_rel = script_map.get(row["name"])
            if script_rel:
                servers[row["name"]] = {
                    "type": "stdio",
                    "command": sys.executable,
                    "args": [str((repo_root / script_rel).resolve())],
                }
    return servers


def prepare_workspace_mcp(cwd: Path, repo_root: Path) -> list[dict]:
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
    return builtin_mcp_statuses(repo_root)


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
