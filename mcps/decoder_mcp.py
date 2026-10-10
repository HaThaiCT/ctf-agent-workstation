#!/usr/bin/env python3
"""Decoder MCP Server — offline CTF decoding and cipher analysis."""

from __future__ import annotations

import asyncio
import base64
import html
import json
import re
import signal
import sys
import urllib.parse
from mcp.server import MCPServer

mcp = MCPServer("decoder")

MAX_INPUT_BYTES = 4096
FLAG_PATTERN = re.compile(r"(?:flag|ctf|picoctf|htb)\{[^}\r\n]{1,128}\}", re.IGNORECASE)


def _check_len(data: str) -> str | None:
    if len(data.encode("utf-8")) > MAX_INPUT_BYTES:
        return "Input exceeds 4096 bytes"
    return None


@mcp.tool()
async def decode_multiformat(data: str) -> str:
    """Attempt single-layer decoding in order: hex, base64, base32, base85, url, html, binary.

    Returns a JSON string containing decoded candidate results.
    """
    err = _check_len(data)
    if err:
        return json.dumps({"error": err})
    results = []
    # 1. Hex
    clean_hex = data.strip()
    if len(clean_hex) >= 2 and len(clean_hex) % 2 == 0 and re.fullmatch(r"[0-9a-fA-F]+", clean_hex):
        try:
            raw = bytes.fromhex(clean_hex)
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        except Exception:
            raw = None
        if raw is not None:
            results.append({"format": "hex", "data_hex": raw.hex(), "text": text})

    # 2. Base64
    clean_b64 = data.strip()
    if len(clean_b64) >= 4 and len(clean_b64) % 4 == 0 and re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", clean_b64):
        try:
            raw = base64.b64decode(clean_b64, validate=True)
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        except Exception:
            raw = None
        if raw is not None:
            results.append({"format": "base64", "data_hex": raw.hex(), "text": text})

    # 3. Base32
    clean_b32 = data.strip().upper()
    if len(clean_b32) >= 8 and len(clean_b32) % 8 == 0 and re.fullmatch(r"[A-Z2-7]+=*", clean_b32):
        try:
            raw = base64.b32decode(clean_b32)
            text = raw.decode("utf-8")
        except UnicodeDecodeError:
            text = None
        except Exception:
            raw = None
        if raw is not None:
            results.append({"format": "base32", "data_hex": raw.hex(), "text": text})

    # 4. Base85
    clean_b85 = data.strip()
    if clean_b85 and re.fullmatch(r"[0-9a-zA-Z!#$%&()*+-;<=>?@^_`{|}~]+", clean_b85):
        try:
            raw = base64.b85decode(clean_b85.encode("ascii"))
            # Strict canonical round-trip check
            if base64.b85encode(raw).decode("ascii") == clean_b85:
                text = raw.decode("utf-8")
            else:
                raw = None
                text = None
        except UnicodeDecodeError:
            text = None
        except Exception:
            raw = None
            text = None
        if raw is not None:
            results.append({"format": "base85", "data_hex": raw.hex(), "text": text})

    # 5. URL
    if "%" in data:
        try:
            raw = urllib.parse.unquote_to_bytes(data)
            if raw != data.encode("utf-8"):
                try:
                    text = raw.decode("utf-8")
                except UnicodeDecodeError:
                    text = None
                results.append({"format": "url", "data_hex": raw.hex(), "text": text})
        except Exception:
            pass

    # 6. HTML
    if "&" in data and ";" in data:
        try:
            unescaped = html.unescape(data)
            if unescaped != data:
                raw = unescaped.encode("utf-8")
                results.append({"format": "html", "data_hex": raw.hex(), "text": unescaped})
        except Exception:
            pass

    # 7. Binary (bits grouped in 8)
    clean_bin = re.sub(r"\s+", "", data)
    if clean_bin and len(clean_bin) % 8 == 0 and re.fullmatch(r"[01]+", clean_bin):
        try:
            byte_vals = [int(clean_bin[i:i + 8], 2) for i in range(0, len(clean_bin), 8)]
            raw = bytes(byte_vals)
            try:
                text = raw.decode("utf-8")
            except UnicodeDecodeError:
                text = None
            results.append({"format": "binary", "data_hex": raw.hex(), "text": text})
        except Exception:
            pass

    return json.dumps({"results": results})


@mcp.tool()
async def rot_cipher(data: str, shift: int = 13, mode: str = "single") -> str:
    """Caesar/ROT cipher on ASCII letters (single shift or all 25 shifts)."""
    err = _check_len(data)
    if err:
        return json.dumps({"error": err})

    if mode not in ("single", "all"):
        return json.dumps({"error": "Invalid mode: must be 'single' or 'all'"})

    def _rotate(text: str, s: int) -> str:
        s = s % 26
        res = []
        for ch in text:
            if "a" <= ch <= "z":
                res.append(chr((ord(ch) - ord("a") + s) % 26 + ord("a")))
            elif "A" <= ch <= "Z":
                res.append(chr((ord(ch) - ord("A") + s) % 26 + ord("A")))
            else:
                res.append(ch)
        return "".join(res)

    if mode == "single":
        eff_shift = shift % 26
        return json.dumps({"results": [{"shift": eff_shift, "text": _rotate(data, eff_shift)}]})

    results = [{"shift": s, "text": _rotate(data, s)} for s in range(1, 26)]
    return json.dumps({"results": results})


@mcp.tool()
async def xor_bruteforce(data_hex: str, key_length: int = 1) -> str:
    """Single-byte XOR bruteforce on hex ciphertext (keys 0..255, top 5 ranked)."""
    if key_length != 1:
        return json.dumps({"error": "Only single-byte XOR (key_length=1) is supported"})

    clean_hex = re.sub(r"\s+", "", data_hex)
    if not clean_hex:
        return json.dumps({"results": []})

    if len(clean_hex) % 2 != 0 or not re.fullmatch(r"[0-9a-fA-F]+", clean_hex):
        return json.dumps({"error": "Invalid hex input"})

    if len(clean_hex) > MAX_INPUT_BYTES * 2:
        return json.dumps({"error": "Input exceeds 4096 bytes"})

    try:
        raw_bytes = bytes.fromhex(clean_hex)
    except Exception as exc:
        return json.dumps({"error": f"Hex decode error: {exc}"})

    candidates = []
    n = len(raw_bytes)
    for k in range(256):
        xored = bytes(b ^ k for b in raw_bytes)
        printable = sum(1 for b in xored if 32 <= b <= 126 or b in (9, 10, 13))
        letters_spaces = sum(1 for b in xored if (65 <= b <= 90) or (97 <= b <= 122) or b == 32)
        score = (printable / n) + (letters_spaces / n)

        try:
            text = xored.decode("utf-8")
        except UnicodeDecodeError:
            text = None

        if text and FLAG_PATTERN.search(text):
            score += 2.0

        candidates.append({
            "key": k,
            "score": round(score, 4),
            "data_hex": xored.hex(),
            "text": text,
        })

    # Sort descending by score, then ascending by key for determinism
    candidates.sort(key=lambda c: (-c["score"], c["key"]))
    return json.dumps({"results": candidates[:5]})


@mcp.tool()
async def hash_identify(hash_str: str) -> str:
    """Identify potential hash algorithms by digest length and format."""
    err = _check_len(hash_str)
    if err:
        return json.dumps({"error": err})

    h = hash_str.strip()
    if not h:
        return json.dumps({"results": []})

    candidates = []

    # Hex digests
    if re.fullmatch(r"[0-9a-fA-F]+", h):
        length = len(h)
        if length == 32:
            candidates.append({"algorithm": "MD5", "encoding": "hex", "bit_length": 128})
            candidates.append({"algorithm": "NTLM", "encoding": "hex", "bit_length": 128})
        elif length == 40:
            candidates.append({"algorithm": "SHA1", "encoding": "hex", "bit_length": 160})
        elif length == 64:
            candidates.append({"algorithm": "SHA256", "encoding": "hex", "bit_length": 256})
        elif length == 128:
            candidates.append({"algorithm": "SHA512", "encoding": "hex", "bit_length": 512})

    # Modular crypt format
    if h.startswith(("$2a$", "$2b$", "$2y$")):
        candidates.append({"algorithm": "bcrypt", "encoding": "modular_crypt", "bit_length": None})
    elif h.startswith("$1$"):
        candidates.append({"algorithm": "md5crypt", "encoding": "modular_crypt", "bit_length": None})
    elif h.startswith("$5$"):
        candidates.append({"algorithm": "sha256crypt", "encoding": "modular_crypt", "bit_length": None})
    elif h.startswith("$6$"):
        candidates.append({"algorithm": "sha512crypt", "encoding": "modular_crypt", "bit_length": None})

    return json.dumps({"results": candidates})


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
