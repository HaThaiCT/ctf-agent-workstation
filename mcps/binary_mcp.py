#!/usr/bin/env python3
"""Binary Analysis MCP Server — offline CTF binary inspection and disassembly."""

from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import signal
import sys
from pathlib import Path

# Script mode for isolated ELF inspection without app dependencies
if len(sys.argv) >= 3 and sys.argv[1] == "--inspect-elf":
    repo_root = Path(__file__).resolve().parents[1]
    if str(repo_root) not in sys.path:
        sys.path.insert(0, str(repo_root))
    try:
        from webapp.target_inspector import inspect_elf_binary
        elf_path = Path(sys.argv[2])
        protections = inspect_elf_binary(elf_path)
        print(json.dumps(protections))
        sys.exit(0)
    except Exception as exc:
        sys.stderr.write(f"ELF inspection error: {exc}\n")
        sys.exit(1)

import anyio
from mcp.server import MCPServer

mcp = MCPServer("binary")

MAX_FILE_SIZE = 100 * 1024 * 1024  # 100 MiB
MAX_OUTPUT_BYTES = 65536  # 64 KiB
ANALYSIS_TIMEOUT = 30.0

_analysis_sem = asyncio.Semaphore(1)
TARGET_RE = re.compile(r"^(?:0x[0-9a-fA-F]+|[0-9]+|[A-Za-z_.$][A-Za-z0-9_.$]*)$")


def _validate_file(path_str: str, *, elf_only: bool = False) -> tuple[Path | None, str | None]:
    if not path_str or not path_str.strip():
        return None, "Path is required"

    # Make absolute if path starts with - to prevent option misinterpretation
    raw_path = Path(path_str.strip())
    if not raw_path.is_absolute():
        resolved = (Path.cwd() / raw_path).resolve()
    else:
        resolved = raw_path.resolve()

    if not resolved.exists():
        return None, f"File does not exist: {path_str}"

    if not resolved.is_file():
        return None, f"Path is not a regular file: {path_str}"

    try:
        size = resolved.stat().st_size
    except OSError as exc:
        return None, f"Failed accessing file: {exc}"

    if size > MAX_FILE_SIZE:
        return None, "File exceeds 100 MiB limit"

    if elf_only:
        try:
            with open(resolved, "rb") as f:
                magic = f.read(4)
            if magic != b"\x7fELF":
                return None, "File is not an ELF binary"
        except OSError as exc:
            return None, f"Failed reading file: {exc}"

    return resolved, None


async def _run_analysis(
    args: list[str],
    *,
    timeout: float = ANALYSIS_TIMEOUT,
    max_output: int = MAX_OUTPUT_BYTES,
) -> tuple[int, str, str, bool]:
    """Execute analysis command in its own process group with strict timeouts and output bounds."""
    if not args:
        return -1, "", "No command specified", False

    bin_name = args[0]
    if not Path(bin_name).is_file() and not shutil.which(bin_name):
        return -1, "", f"Tool '{bin_name}' is unavailable on host", False

    async with _analysis_sem:
        proc = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            start_new_session=True,
        )

        stdout_buf = bytearray()
        stderr_buf = bytearray()
        truncated = False

        async def _read_stream(stream, buf):
            nonlocal truncated
            while True:
                chunk = await stream.read(4096)
                if not chunk:
                    break
                remaining = max_output - len(buf)
                if remaining > 0:
                    buf.extend(chunk[:remaining])
                if len(buf) >= max_output or len(chunk) > remaining:
                    truncated = True
                    # Terminate process group if output exceeded
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    except (ProcessLookupError, PermissionError):
                        pass
                    break

        timed_out = False
        try:
            with anyio.move_on_after(timeout) as scope:
                async with anyio.create_task_group() as tg:
                    tg.start_soon(_read_stream, proc.stdout, stdout_buf)
                    tg.start_soon(_read_stream, proc.stderr, stderr_buf)
                    await proc.wait()
            if scope.cancel_called:
                timed_out = True
        except asyncio.CancelledError:
            with anyio.CancelScope(shield=True):
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                    await asyncio.sleep(0.5)
                    if proc.returncode is None:
                        os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                    await proc.wait()
                except (ProcessLookupError, PermissionError):
                    pass
            raise
        finally:
            with anyio.CancelScope(shield=True):
                if proc.returncode is None:
                    try:
                        os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
                        await asyncio.sleep(0.5)
                        if proc.returncode is None:
                            os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                        await proc.wait()
                    except (ProcessLookupError, PermissionError):
                        pass

        if timed_out:
            return -1, stdout_buf.decode("utf-8", errors="replace"), f"Command timed out after {timeout}s", True

        stdout_str = stdout_buf.decode("utf-8", errors="replace")
        stderr_str = stderr_buf.decode("utf-8", errors="replace")
        return (proc.returncode or 0), stdout_str, stderr_str, truncated


@mcp.tool()
async def binary_info(path: str) -> str:
    """Inspect ELF binary architecture, bitness, and security protections."""
    resolved, err = _validate_file(path, elf_only=True)
    if err:
        return json.dumps({"error": err})

    cmd = [sys.executable, str(Path(__file__).resolve()), "--inspect-elf", str(resolved)]
    rc, out, err_msg, truncated = await _run_analysis(cmd)
    if rc != 0 or not out.strip():
        return json.dumps({"error": err_msg or "ELF inspection failed"})

    try:
        data = json.loads(out)
        return json.dumps({"result": data, "truncated": False})
    except Exception as exc:
        return json.dumps({"error": f"Failed parsing ELF inspection: {exc}"})


@mcp.tool()
async def binary_functions(path: str) -> str:
    """Extract discovered functions from ELF binary using Rizin analysis."""
    resolved, err = _validate_file(path, elf_only=True)
    if err:
        return json.dumps({"error": err})

    cmd = ["rizin", "-N", "-2", "-q", "-e", "scr.color=0", "-c", "aaa; aflj; q", str(resolved)]
    rc, out, err_msg, truncated = await _run_analysis(cmd)
    if truncated:
        return json.dumps({"error": "Functions output exceeded limit and was truncated"})

    out_clean = out.strip()
    if not out_clean:
        if rc != 0:
            return json.dumps({"error": err_msg or "Rizin analysis failed"})
        return json.dumps({"result": [], "truncated": False})

    try:
        funcs = json.loads(out_clean)
        return json.dumps({"result": funcs, "truncated": False})
    except json.JSONDecodeError:
        return json.dumps({"error": err_msg or out_clean or "Failed parsing functions JSON"})


@mcp.tool()
async def binary_disasm(path: str, target: str) -> str:
    """Disassemble function or address in ELF binary using Rizin (e.g. 'main', '0x401000')."""
    resolved, err = _validate_file(path, elf_only=True)
    if err:
        return json.dumps({"error": err})

    target_clean = target.strip()
    if len(target_clean) > 128 or not TARGET_RE.match(target_clean):
        return json.dumps({"error": "Invalid disassembly target symbol/address"})

    cmd = ["rizin", "-N", "-2", "-q", "-e", "scr.color=0", "-c", f"aaa; pdf @ {target_clean}; q", str(resolved)]
    rc, out, err_msg, truncated = await _run_analysis(cmd)
    if rc != 0 and not out.strip():
        return json.dumps({"error": err_msg or "Disassembly failed"})

    return json.dumps({"result": out.strip(), "truncated": truncated})


@mcp.tool()
async def binary_strings(path: str, min_len: int = 4) -> str:
    """Extract printable strings from binary (regular file <= 100 MiB)."""
    resolved, err = _validate_file(path, elf_only=False)
    if err:
        return json.dumps({"error": err})

    if not isinstance(min_len, int) or min_len < 4 or min_len > 128:
        return json.dumps({"error": "min_len must be an integer between 4 and 128"})

    cmd = ["strings", "-a", "-n", str(min_len), str(resolved)]
    rc, out, err_msg, truncated = await _run_analysis(cmd)
    if rc != 0 and not out.strip():
        return json.dumps({"error": err_msg or "strings command failed"})

    lines = out.splitlines()
    return json.dumps({"result": lines, "truncated": truncated})


async def main():
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    try:
        await mcp.run_stdio_async()
    finally:
        for sig in (signal.SIGTERM, signal.SIGINT):
            loop.remove_signal_handler(sig)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (asyncio.CancelledError, KeyboardInterrupt):
        pass
