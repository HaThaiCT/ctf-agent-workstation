"""Pre-flight target inspection for CTF challenge files.

Extracts file summaries, binary protections (checksec/readelf), network capture metadata,
and archive contents before agent initialization, producing a structured prompt context.
"""
from __future__ import annotations

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

try:
    from .tool_environment import probe_host_environment
except ImportError:
    from tool_environment import probe_host_environment

log = logging.getLogger(__name__)

MAX_INSPECT_FILES = 20
MAX_INSPECT_FILE_SIZE = 100 * 1024 * 1024  # 100 MB
SUBPROCESS_TIMEOUT = 5.0


@dataclass
class TargetInspection:
    file_summaries: list[dict[str, Any]] = field(default_factory=list)
    binary_protections: dict[str, dict[str, Any]] = field(default_factory=dict)
    archive_contents: dict[str, list[str]] = field(default_factory=dict)
    prompt_context: str = ""

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


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
) -> str:
    """Format pre-flight inspection findings into a concise markdown section."""
    if not file_summaries and not wordlists:
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

    if wordlists:
        wl_str = ", ".join(f"`{w}`" for w in wordlists[:3])
        lines.append(f"- Wordlists available on host: {wl_str}")

    return "\n".join(lines)


def inspect_challenge_files(target_dir: Path) -> TargetInspection:
    """Perform pre-flight technical inspection on challenge files in target_dir."""
    inspection = TargetInspection()
    target_path = Path(target_dir)

    if not target_path.exists() or not target_path.is_dir():
        return inspection

    candidates: list[Path] = []
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
        return inspection

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

    # Get wordlists from host environment
    try:
        env = probe_host_environment()
        wordlists = env.wordlists
    except Exception:
        wordlists = []

    inspection.prompt_context = build_preflight_prompt(
        inspection.file_summaries,
        inspection.binary_protections,
        inspection.archive_contents,
        wordlists=wordlists,
    )

    return inspection
