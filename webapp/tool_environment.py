"""Host environment and capability discovery for CTF tooling."""
from __future__ import annotations

import logging
import os
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

log = logging.getLogger(__name__)

DEFAULT_OS_RELEASE = Path("/etc/os-release")
FALLBACK_OS_RELEASE = Path("/usr/lib/os-release")

DEFAULT_WORDLIST_CANDIDATES = [
    Path("/usr/share/seclists/Discovery/Web-Content/common.txt"),
    Path("/usr/share/dirb/wordlists/common.txt"),
    Path("/usr/share/dirbuster/wordlists/directory-list-2.3-small.txt"),
]


@dataclass
class ToolCapability:
    name: str
    available: bool
    path: str = ""
    version: str = ""
    notes: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass
class HostEnvironment:
    os_distro: str
    tools: dict[str, ToolCapability] = field(default_factory=dict)
    wordlists: list[Path] = field(default_factory=list)
    has_ida_license: bool = False
    has_ghidra: bool = False
    has_sagemath: bool = False
    has_gdb_enhanced: bool = False
    has_web_tools: bool = False
    has_pwn_tools: bool = False

    def to_dict(self) -> dict[str, Any]:
        return {
            "os_distro": self.os_distro,
            "tools": {k: v.to_dict() for k, v in self.tools.items()},
            "wordlists": [str(p) for p in self.wordlists],
            "has_ida_license": self.has_ida_license,
            "has_ghidra": self.has_ghidra,
            "has_sagemath": self.has_sagemath,
            "has_gdb_enhanced": self.has_gdb_enhanced,
            "has_web_tools": self.has_web_tools,
            "has_pwn_tools": self.has_pwn_tools,
        }


_cached_env: HostEnvironment | None = None


def detect_os_distro(os_release_path: Path | None = None) -> str:
    """Detect OS distribution from /etc/os-release or specified path."""
    paths_to_check = [os_release_path] if os_release_path else [DEFAULT_OS_RELEASE, FALLBACK_OS_RELEASE]
    content = ""
    for p in paths_to_check:
        if p and p.is_file():
            try:
                content = p.read_text(encoding="utf-8", errors="replace")
                break
            except OSError:
                continue

    if not content:
        return "unknown"

    fields: dict[str, str] = {}
    for line in content.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        fields[k.strip()] = v.strip().strip('"').strip("'")

    distro_id = fields.get("ID", "").lower()
    id_like = fields.get("ID_LIKE", "").lower()

    if "kali" in distro_id or "kali" in id_like:
        return "kali"
    if "ubuntu" in distro_id:
        return "ubuntu"
    if "debian" in distro_id:
        return "debian"
    if distro_id:
        return distro_id
    return "unknown"


def _probe_binary_tool(
    name: str,
    candidates: list[str],
    version_args: list[str] | None = None,
    timeout: float = 3.0,
    *,
    probe_version: bool = True,
) -> ToolCapability:
    """Probe binary existence and version safely with timeout."""
    binary_path: str | None = None
    for cand in candidates:
        found = shutil.which(cand)
        if found:
            binary_path = found
            break
        cand_p = Path(cand)
        if cand_p.is_file() and os.access(cand_p, os.X_OK):
            binary_path = str(cand_p)
            break

    if not binary_path:
        return ToolCapability(
            name=name,
            available=False,
            path="",
            version="",
            notes="Not found in PATH or standard locations",
        )
    if not probe_version:
        return ToolCapability(
            name=name,
            available=True,
            path=binary_path,
            version="",
            notes="",
        )

    args = [binary_path] + (version_args if version_args is not None else ["--version"])
    version_str = ""
    notes_str = ""
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        combined = (proc.stdout or proc.stderr or "").strip()
        first_line = combined.splitlines()[0] if combined else ""
        version_str = first_line[:120]
        if proc.returncode != 0 and not version_str:
            notes_str = f"Exited with code {proc.returncode}"
    except subprocess.TimeoutExpired:
        notes_str = f"Timed out after {timeout}s"
    except Exception as exc:
        notes_str = f"Execution error: {exc}"

    return ToolCapability(
        name=name,
        available=True,
        path=binary_path,
        version=version_str,
        notes=notes_str,
    )


def _probe_python_module(
    module_name: str,
    import_expr: str,
    version_attr: str = "__version__",
    timeout: float = 3.0,
) -> ToolCapability:
    """Probe a Python module safely via a subprocess."""
    code = f"import {import_expr} as m; print(getattr(m, '{version_attr}', 'available'))"
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        if proc.returncode == 0:
            version_str = proc.stdout.strip().splitlines()[0] if proc.stdout else "available"
            return ToolCapability(
                name=module_name,
                available=True,
                path=sys.executable,
                version=version_str[:80],
                notes="",
            )
        return ToolCapability(
            name=module_name,
            available=False,
            path=sys.executable,
            version="",
            notes=f"Import failed (exit {proc.returncode}): {proc.stderr.strip()[:100]}",
        )
    except subprocess.TimeoutExpired:
        return ToolCapability(
            name=module_name,
            available=False,
            path=sys.executable,
            version="",
            notes=f"Timed out after {timeout}s",
        )
    except Exception as exc:
        return ToolCapability(
            name=module_name,
            available=False,
            path=sys.executable,
            version="",
            notes=f"Error checking module: {exc}",
        )


def _check_ida_license(timeout: float = 3.0) -> bool:
    """Check if IDA Pro with idapro/ida_domain is installed and licensed."""
    code = (
        "try:\n"
        "    import ida_domain\n"
        "    print('LICENSED')\n"
        "except Exception:\n"
        "    try:\n"
        "        import idapro\n"
        "        print('LICENSED')\n"
        "    except Exception:\n"
        "        pass\n"
    )
    try:
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return "LICENSED" in proc.stdout
    except Exception:
        return False


def _check_gdb_enhanced(gdb_cap: ToolCapability, timeout: float = 3.0) -> bool:
    """Check if gdb has GEF, pwndbg, or other enhanced features loaded."""
    if not gdb_cap.available or not gdb_cap.path:
        return False

    # Check ~/.gdbinit first without executing gdb
    gdbinit = Path.home() / ".gdbinit"
    if gdbinit.is_file():
        try:
            text = gdbinit.read_text(encoding="utf-8", errors="replace").lower()
            if "gef" in text or "pwndbg" in text or "peda" in text:
                return True
        except OSError:
            pass

    # Probe via gdb batch mode
    code = (
        "python\n"
        "try:\n"
        "    import gef\n"
        "    print('ENHANCED_GDB')\n"
        "except ImportError:\n"
        "    try:\n"
        "        import pwndbg\n"
        "        print('ENHANCED_GDB')\n"
        "    except ImportError:\n"
        "        pass\n"
        "end\n"
    )
    try:
        proc = subprocess.run(
            [gdb_cap.path, "-batch", "-ex", code],
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return "ENHANCED_GDB" in proc.stdout
    except Exception:
        return False


def scan_available_wordlists(
    candidates: list[Path] | None = None,
) -> list[Path]:
    """Scan and return accessible standard wordlists."""
    paths_to_check = candidates if candidates is not None else DEFAULT_WORDLIST_CANDIDATES
    found: list[Path] = []
    seen: set[str] = set()

    for p in paths_to_check:
        try:
            resolved = p.resolve()
            if resolved.is_file() and os.access(resolved, os.R_OK):
                key = str(resolved)
                if key not in seen:
                    seen.add(key)
                    found.append(resolved)
        except (OSError, PermissionError):
            continue

    return found


def probe_host_environment(
    *,
    force_refresh: bool = False,
    os_release_path: Path | None = None,
    wordlist_candidates: list[Path] | None = None,
) -> HostEnvironment:
    """Probe OS, tools, licenses, and wordlists on the host machine.
    
    Results are cached unless force_refresh is True.
    """
    global _cached_env
    if not force_refresh and _cached_env is not None and os_release_path is None:
        return _cached_env

    distro = detect_os_distro(os_release_path)
    tools: dict[str, ToolCapability] = {}

    # Reverse engineering
    tools["ghidra"] = _probe_binary_tool("ghidra", ["ghidra", "ghidraRun", "/usr/bin/ghidra", "/opt/ghidra/ghidraRun"], probe_version=False)
    tools["rizin"] = _probe_binary_tool("rizin", ["rizin", "/usr/bin/rizin"], ["-v"])
    tools["radare2"] = _probe_binary_tool("radare2", ["radare2", "r2", "/usr/bin/radare2", "/usr/bin/r2"], ["-v"])
    tools["objdump"] = _probe_binary_tool("objdump", ["objdump", "/usr/bin/objdump"], ["--version"])
    tools["readelf"] = _probe_binary_tool("readelf", ["readelf", "/usr/bin/readelf"], ["--version"])
    tools["idapro"] = _probe_binary_tool("idapro", ["idapro", "ida64", "ida"], ["-v"])

    # Pwn
    tools["gdb"] = _probe_binary_tool("gdb", ["gdb", "/usr/bin/gdb"], ["--version"])
    tools["ROPgadget"] = _probe_binary_tool("ROPgadget", ["ROPgadget"], ["--version"])
    tools["ropper"] = _probe_binary_tool("ropper", ["ropper"], ["--version"])
    tools["one_gadget"] = _probe_binary_tool("one_gadget", ["one_gadget"], ["--version"])
    tools["seccomp-tools"] = _probe_binary_tool("seccomp-tools", ["seccomp-tools"], ["--version"])
    tools["checksec"] = _probe_binary_tool("checksec", ["checksec"], ["--version"])
    tools["pwntools"] = _probe_python_module("pwntools", "pwn")

    # Web
    tools["sqlmap"] = _probe_binary_tool("sqlmap", ["sqlmap"], ["--version"])
    tools["ffuf"] = _probe_binary_tool("ffuf", ["ffuf"], ["-V"])
    tools["gobuster"] = _probe_binary_tool("gobuster", ["gobuster"], ["--version"])
    tools["dirsearch"] = _probe_binary_tool("dirsearch", ["dirsearch"], ["--version"])
    tools["nikto"] = _probe_binary_tool("nikto", ["nikto"], ["-Version"])
    # Crypto
    tools["sage"] = _probe_binary_tool("sage", ["sage", "/usr/bin/sage"], ["--version"])
    tools["z3"] = _probe_python_module("z3", "z3")
    tools["pycryptodome"] = _probe_python_module("pycryptodome", "Crypto")

    # Forensics
    tools["tshark"] = _probe_binary_tool("tshark", ["tshark", "/usr/bin/tshark"], ["--version"])
    tools["volatility"] = _probe_binary_tool("volatility", ["vol", "volatility", "volatility3"], ["--version"])
    tools["binwalk"] = _probe_binary_tool("binwalk", ["binwalk", "/usr/bin/binwalk"], ["--help"])
    tools["bulk_extractor"] = _probe_binary_tool("bulk_extractor", ["bulk_extractor"], ["--version"])
    tools["exiftool"] = _probe_binary_tool("exiftool", ["exiftool", "/usr/bin/exiftool"], ["-ver"])
    tools["steghide"] = _probe_binary_tool("steghide", ["steghide", "/usr/bin/steghide"], ["--version"])

    has_ida = _check_ida_license()
    has_ghidra = tools["ghidra"].available
    has_sage = tools["sage"].available
    has_gdb_enh = _check_gdb_enhanced(tools["gdb"])
    wordlists = scan_available_wordlists(wordlist_candidates)

    web_tool_names = ("sqlmap", "ffuf", "gobuster", "dirsearch", "nikto")
    has_web = any(tools.get(t) and tools[t].available for t in web_tool_names)

    pwn_tool_names = ("gdb", "checksec", "ROPgadget", "ropper", "one_gadget", "seccomp-tools", "pwntools")
    has_pwn = any(tools.get(t) and tools[t].available for t in pwn_tool_names)

    env = HostEnvironment(
        os_distro=distro,
        tools=tools,
        wordlists=wordlists,
        has_ida_license=has_ida,
        has_ghidra=has_ghidra,
        has_sagemath=has_sage,
        has_gdb_enhanced=has_gdb_enh,
        has_web_tools=has_web,
        has_pwn_tools=has_pwn,
    )

    return env
