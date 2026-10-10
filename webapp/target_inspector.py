"""Pre-flight target inspection for CTF challenge files.

Extracts file summaries, binary protections (checksec/readelf), network capture metadata,
and archive contents before agent initialization, producing a structured prompt context.
"""
from __future__ import annotations
import ipaddress
import logging
import os
import re
import shutil
import subprocess
import tarfile
import zipfile
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit
try:
    from .tool_environment import probe_host_environment
    from .runtime_resources import normalize_challenge_category
except ImportError:
    from tool_environment import probe_host_environment
    try:
        from runtime_resources import normalize_challenge_category
    except ImportError:
        normalize_challenge_category = lambda c: c.strip().lower()
log = logging.getLogger(__name__)

MAX_INSPECT_FILES = 20
MAX_INSPECT_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
SUBPROCESS_TIMEOUT = 5.0


@dataclass
class TargetInspection:
    file_summaries: list[dict[str, Any]] = field(default_factory=list)
    binary_protections: dict[str, dict[str, Any]] = field(default_factory=dict)
    archive_contents: dict[str, list[str]] = field(default_factory=list)
    service_targets: list[str] = field(default_factory=list)
    host_tools: list[str] = field(default_factory=list)
    prompt_context: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


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


def _is_valid_hostname(host: str) -> bool:
    if not host or len(host) > 253:
        return False
    try:
        ipaddress.ip_address(host)
        return True
    except ValueError:
        pass
    labels = host.split(".")
    for label in labels:
        if not label or len(label) > 63:
            return False
        if not re.match(r"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$", label):
            return False
    return True


def extract_service_targets(text: str) -> list[str]:
    """Extract up to 10 service target endpoints from challenge text."""
    if not text:
        return []
    candidates_with_span: list[tuple[int, int, str]] = []

    # 1. URLs (keep scheme, host, port, path; drop userinfo, query, fragment)
    for m in re.finditer(r"https?://[^\s<>\"'`\)]+", text):
        raw = m.group(0).rstrip(".,;:!?)`'\"")
        end = m.start() + len(raw)
        try:
            parts = urlsplit(raw)
            if parts.scheme in ("http", "https") and parts.hostname:
                if _is_valid_hostname(parts.hostname):
                    port = parts.port
                    if port is not None and not (1 <= port <= 65535):
                        continue
                    host_part = parts.hostname
                    if ":" in host_part and not host_part.startswith("["):
                        host_part = f"[{host_part}]"
                    netloc = f"{host_part}:{port}" if port is not None else host_part
                    path = parts.path or "/"
                    url_clean = f"{parts.scheme}://{netloc}{path}"
                    candidates_with_span.append((m.start(), end, url_clean))
        except Exception:
            pass

    # 2. nc / ncat HOST PORT
    for m in re.finditer(r"\b(nc|ncat)\s+([A-Za-z0-9_.-]+)\s+(\d{1,5})\b", text):
        cmd, host, port_str = m.group(1), m.group(2).strip("`'\".,;:"), m.group(3)
        try:
            port = int(port_str)
            if 1 <= port <= 65535 and _is_valid_hostname(host):
                candidates_with_span.append((m.start(), m.end(), f"{cmd} {host} {port}"))
        except Exception:
            pass

    # 3. Standalone IPv4:port
    for m in re.finditer(r"\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})\b", text):
        ip_str, port_str = m.group(1), m.group(2)
        try:
            ipaddress.IPv4Address(ip_str)
            port = int(port_str)
            if 1 <= port <= 65535:
                candidates_with_span.append((m.start(), m.end(), f"{ip_str}:{port}"))
        except Exception:
            pass

    # 4. Standalone [IPv6]:port
    for m in re.finditer(r"\[([0-9a-fA-F:]+)\]:(\d{1,5})\b", text):
        ip_str, port_str = m.group(1), m.group(2)
        try:
            ipaddress.IPv6Address(ip_str)
            port = int(port_str)
            if 1 <= port <= 65535:
                candidates_with_span.append((m.start(), m.end(), f"[{ip_str}]:{port}"))
        except Exception:
            pass

    # Filter out spans enclosed within another span
    filtered: list[tuple[int, str]] = []
    for s1, e1, t1 in candidates_with_span:
        enclosed = False
        for s2, e2, _ in candidates_with_span:
            if s2 <= s1 and e1 <= e2 and (s1 != s2 or e1 != e2):
                enclosed = True
                break
        if not enclosed:
            filtered.append((s1, t1))

    filtered.sort(key=lambda x: x[0])
    targets: list[str] = []
    seen: set[str] = set()
    for _, target in filtered:
        if len(target) <= 256 and target not in seen and len(targets) < 10:
            seen.add(target)
            targets.append(target)
    return targets


def _format_size(size_bytes: int) -> str:
    """Format byte count into human-readable size."""
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.1f} MB"


def _run_cmd(args: list[str], timeout: float = SUBPROCESS_TIMEOUT) -> tuple[int, str, str]:
    """Execute command safely with a timeout."""
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=timeout,
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return -1, "", f"Timeout after {timeout}s"
    except Exception as exc:
        return -1, "", str(exc)

def _get_file_magic_and_mime(file_path: Path) -> tuple[str, str]:
    """Determine file magic description and mime type using `file` command."""
    magic_type = ""
    mime_type = ""
    if shutil.which("file"):
        rc, out, _ = _run_cmd(["file", "-b", "-L", str(file_path)])
        if rc == 0 and out.strip():
            magic_type = out.strip().splitlines()[0]

        rc_mime, out_mime, _ = _run_cmd(["file", "-b", "-L", "--mime-type", str(file_path)])
        if rc_mime == 0 and out_mime.strip():
            mime_type = out_mime.strip().splitlines()[0]

    if not magic_type:
        ext = file_path.suffix.lower()
        magic_type = f"File with extension {ext}" if ext else "Binary or data file"
    if not mime_type:
        mime_type = "application/octet-stream"

    return magic_type, mime_type


def _parse_checksec_output(output: str) -> dict[str, Any]:
    """Parse output from `checksec --file=...`."""
    protections: dict[str, Any] = {
        "arch": "",
        "bitness": "",
        "endian": "",
        "nx": "Unknown",
        "canary": "Unknown",
        "pie": "Unknown",
        "relro": "Unknown",
        "stripped": "Unknown",
    }
    for line in output.splitlines():
        line = line.strip()
        if line.startswith("Arch:"):
            arch_str = line.split("Arch:", 1)[1].strip()
            protections["arch"] = arch_str
            if "64" in arch_str:
                protections["bitness"] = "64"
            elif "32" in arch_str:
                protections["bitness"] = "32"
            if "little" in arch_str.lower():
                protections["endian"] = "little"
            elif "big" in arch_str.lower():
                protections["endian"] = "big"
        elif line.startswith("Stack:"):
            val = line.split("Stack:", 1)[1].strip()
            protections["canary"] = "Enabled" if "canary found" in val.lower() else "Disabled"
        elif line.startswith("NX:"):
            val = line.split("NX:", 1)[1].strip()
            protections["nx"] = "Enabled" if "nx enabled" in val.lower() else "Disabled"
        elif line.startswith("PIE:"):
            val = line.split("PIE:", 1)[1].strip()
            protections["pie"] = "Enabled" if "pie enabled" in val.lower() else ("DSO" if "dso" in val.lower() else "Disabled")
        elif line.startswith("RELRO:"):
            protections["relro"] = line.split("RELRO:", 1)[1].strip()

    return protections


def _parse_elf_with_readelf(file_path: Path) -> dict[str, Any]:
    """Fallback ELF inspection using `readelf`."""
    protections: dict[str, Any] = {
        "arch": "",
        "bitness": "",
        "endian": "",
        "nx": "Unknown",
        "canary": "Unknown",
        "pie": "Unknown",
        "relro": "Unknown",
        "stripped": "Unknown",
    }
    if not shutil.which("readelf"):
        return protections

    # Header check
    rc, out, _ = _run_cmd(["readelf", "-h", str(file_path)])
    if rc == 0:
        for line in out.splitlines():
            line = line.strip()
            if line.startswith("Class:"):
                protections["bitness"] = "64" if "ELF64" in line else ("32" if "ELF32" in line else "")
            elif line.startswith("Data:"):
                protections["endian"] = "little" if "little endian" in line else ("big" if "big endian" in line else "")
            elif line.startswith("Machine:"):
                protections["arch"] = line.split("Machine:", 1)[1].strip()
            elif line.startswith("Type:"):
                if "DYN" in line:
                    protections["pie"] = "Enabled"
                elif "EXEC" in line:
                    protections["pie"] = "Disabled"

    # Program headers check (NX, RELRO)
    rc_l, out_l, _ = _run_cmd(["readelf", "-l", str(file_path)])
    if rc_l == 0:
        has_relro = "GNU_RELRO" in out_l
        protections["relro"] = "Partial/Full RELRO" if has_relro else "No RELRO"
        for line in out_l.splitlines():
            if "GNU_STACK" in line:
                protections["nx"] = "Disabled" if "RWE" in line else "Enabled"

    # Symbols check (Canary, Stripped)
    rc_s, out_s, _ = _run_cmd(["readelf", "-S", str(file_path)])
    if rc_s == 0:
        protections["stripped"] = "No" if ".symtab" in out_s else "Yes"

    rc_sym, out_sym, _ = _run_cmd(["readelf", "-s", str(file_path)])
    if rc_sym == 0:
        if "__stack_chk_fail" in out_sym:
            protections["canary"] = "Enabled"
        elif protections["canary"] == "Unknown":
            protections["canary"] = "Disabled"

    return protections


def inspect_elf_binary(file_path: Path, magic_type: str = "") -> dict[str, Any]:
    """Inspect binary protections via checksec or readelf fallback."""
    protections: dict[str, Any] = {}

    if shutil.which("checksec"):
        rc, out, _ = _run_cmd(["checksec", f"--file={file_path}"])
        if rc == 0 or "Arch:" in out:
            protections = _parse_checksec_output(out)

    if not protections or not protections.get("arch"):
        fallback = _parse_elf_with_readelf(file_path)
        for k, v in fallback.items():
            if not protections.get(k) or protections[k] == "Unknown":
                protections[k] = v

    # Infer stripped from magic_type if available
    if protections.get("stripped") in ("Unknown", ""):
        if "not stripped" in magic_type.lower():
            protections["stripped"] = "No"
        elif "stripped" in magic_type.lower():
            protections["stripped"] = "Yes"

    return protections


def inspect_archive(file_path: Path) -> list[str]:
    """Safely extract top file names from zip or tar archives without writing to disk."""
    entries: list[str] = []
    try:
        if zipfile.is_zipfile(file_path):
            with zipfile.ZipFile(file_path, "r") as zf:
                entries = [item.filename for item in zf.infolist()[:20]]
                return entries
    except Exception:
        pass

    try:
        if tarfile.is_tarfile(file_path):
            with tarfile.open(file_path, "r:*") as tf:
                entries = [member.name for member in tf.getmembers()[:20]]
                return entries
    except Exception:
        pass

    return entries


def inspect_network_capture(file_path: Path) -> str:
    """Inspect network capture file summary (packet count and top protocols)."""
    if shutil.which("capinfos"):
        rc, out, _ = _run_cmd(["capinfos", "-c", "-d", str(file_path)])
        if rc == 0:
            lines = [l.strip() for l in out.splitlines() if "Number of packets:" in l or "Capture duration:" in l]
            if lines:
                return "; ".join(lines)

    if shutil.which("tshark"):
        rc, out, _ = _run_cmd(["tshark", "-r", str(file_path), "-c", "5"])
        if rc == 0 and out.strip():
            count = len(out.strip().splitlines())
            return f"Contains readable packets (sampled {count}+)"

    return ""


def build_preflight_prompt(
    file_summaries: list[dict[str, Any]],
    binary_protections: dict[str, dict[str, Any]],
    archive_contents: dict[str, list[str]],
    wordlists: list[Path] | None = None,
    *,
    service_targets: list[str] | None = None,
    host_tools: list[str] | None = None,
) -> str:
    """Format pre-flight inspection findings into a concise markdown section."""
    if not file_summaries and not wordlists and not service_targets and not host_tools:
        return ""

    lines = [
        "[Pre-flight Target Inspection]:",
    ]

    for item in file_summaries:
        name = item["name"]
        magic = item["magic_type"]
        size_str = _format_size(item["size"])

        if name in binary_protections:
            prot = binary_protections[name]
            details = [
                f"Arch: {prot.get('arch', 'unknown')}",
                f"NX: {prot.get('nx', 'Unknown')}",
                f"Canary: {prot.get('canary', 'Unknown')}",
                f"PIE: {prot.get('pie', 'Unknown')}",
                f"RELRO: {prot.get('relro', 'Unknown')}",
                f"Stripped: {prot.get('stripped', 'Unknown')}",
            ]
            lines.append(f"- `{name}`: {magic} ({size_str}). Protections: {', '.join(details)}.")
        elif name in archive_contents and archive_contents[name]:
            contained = ", ".join(f"`{f}`" for f in archive_contents[name][:8])
            if len(archive_contents[name]) > 8:
                contained += f", and {len(archive_contents[name]) - 8} more"
            lines.append(f"- `{name}`: {magic} ({size_str}). Archive contains: {contained}.")
        else:
            lines.append(f"- `{name}`: {magic} ({size_str}).")

    if service_targets:
        targets_str = ", ".join(f"`{t}`" for t in service_targets)
        lines.append(f"- Service endpoints / targets: {targets_str}")

    if host_tools:
        tools_str = ", ".join(f"`{t}`" for t in host_tools)
        lines.append(f"- Relevant host tools available: {tools_str}")

    if wordlists:
        wl_str = ", ".join(f"`{w}`" for w in wordlists[:3])
        lines.append(f"- Web-content discovery wordlists available on host: {wl_str}")

    return "\n".join(lines)


def inspect_challenge_files(
    target_dir: Path,
    *,
    description: str = "",
    category: str = "",
) -> TargetInspection:
    """Perform pre-flight technical inspection on challenge files in target_dir."""
    inspection = TargetInspection()
    target_path = Path(target_dir)

    service_targets = extract_service_targets(description)
    inspection.service_targets = service_targets

    norm_cat = normalize_challenge_category(category)

    candidates: list[Path] = []
    if target_path.exists() and target_path.is_dir():
        try:
            for entry in sorted(target_path.iterdir()):
                if entry.name.startswith((".", "_")):
                    continue
                if entry.is_file():
                    candidates.append(entry)
                elif entry.is_symlink():
                    try:
                        if entry.resolve().is_file():
                            candidates.append(entry)
                    except OSError:
                        continue
        except OSError as exc:
            log.warning("Failed listing target_dir %s: %s", target_dir, exc)

    candidates = candidates[:MAX_INSPECT_FILES]

    for file_path in candidates:
        try:
            stat = file_path.stat()
            size = stat.st_size
        except OSError:
            continue

        if size > MAX_INSPECT_FILE_SIZE:
            inspection.file_summaries.append({
                "name": file_path.name,
                "size": size,
                "magic_type": "Large file (>100MB, skipped deep inspection)",
                "mime_type": "application/octet-stream",
            })
            continue

        magic_type, mime_type = _get_file_magic_and_mime(file_path)
        inspection.file_summaries.append({
            "name": file_path.name,
            "size": size,
            "magic_type": magic_type,
            "mime_type": mime_type,
        })

        resolved_file = file_path.resolve() if file_path.is_symlink() else file_path

        # ELF Binary analysis
        if "ELF" in magic_type or mime_type in ("application/x-executable", "application/x-pie-executable", "application/x-sharedlib"):
            try:
                protections = inspect_elf_binary(resolved_file, magic_type)
                if protections:
                    inspection.binary_protections[file_path.name] = protections
            except Exception as exc:
                log.debug("Error inspecting ELF %s: %s", file_path.name, exc)

        # Archive analysis
        if any(mime_type.startswith(p) for p in ("application/zip", "application/x-tar", "application/gzip")) or file_path.suffix.lower() in (".zip", ".tar", ".gz", ".tgz"):
            try:
                contents = inspect_archive(resolved_file)
                if contents:
                    inspection.archive_contents[file_path.name] = contents
            except Exception as exc:
                log.debug("Error inspecting archive %s: %s", file_path.name, exc)

        # Network capture analysis
        if file_path.suffix.lower() in (".pcap", ".pcapng", ".cap") or "pcap" in mime_type.lower():
            try:
                cap_summary = inspect_network_capture(resolved_file)
                if cap_summary:
                    inspection.file_summaries[-1]["network_summary"] = cap_summary
            except Exception as exc:
                log.debug("Error inspecting pcap %s: %s", file_path.name, exc)

    # Tool and wordlist context stage
    try:
        env = probe_host_environment()
        avail = {k: v.available for k, v in env.tools.items()}
    except Exception:
        avail = {}
        env = None

    if norm_cat == "web":
        tool_candidates = ["sqlmap", "ffuf", "gobuster", "dirsearch", "nikto"]
        host_tools = [t for t in tool_candidates if avail.get(t)]
    elif norm_cat == "pwn":
        tool_candidates = ["gdb", "checksec", "ROPgadget", "ropper", "one_gadget", "seccomp-tools", "pwntools"]
        host_tools = [t for t in tool_candidates if avail.get(t)]
    elif norm_cat in ("reverse", "malware"):
        tool_candidates = ["ghidra", "rizin", "radare2", "objdump", "readelf", "idapro"]
        host_tools = [t for t in tool_candidates if avail.get(t)]
    elif norm_cat == "crypto":
        tool_candidates = ["z3", "pycryptodome", "sage"]
        host_tools = [t for t in tool_candidates if avail.get(t)]
    elif norm_cat == "forensics":
        tool_candidates = ["tshark", "volatility", "binwalk", "bulk_extractor", "exiftool", "steghide"]
        host_tools = [t for t in tool_candidates if avail.get(t)]
    else:
        host_tools = sorted([k for k, v in avail.items() if v])[:12]

    inspection.host_tools = host_tools

    is_web_relevant = (norm_cat == "web") or any(t.startswith(("http://", "https://")) for t in service_targets)
    wordlists = env.wordlists if (env and is_web_relevant) else []

    inspection.prompt_context = build_preflight_prompt(
        inspection.file_summaries,
        inspection.binary_protections,
        inspection.archive_contents,
        wordlists=wordlists,
        service_targets=service_targets,
        host_tools=host_tools,
    )

    return inspection
