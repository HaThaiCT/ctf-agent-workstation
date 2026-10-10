"""Unit and regression tests for decoder and binary MCP servers."""

import asyncio
import json
import os
import signal
import subprocess
import tempfile
import unittest
from pathlib import Path

from mcps.decoder_mcp import (
    decode_multiformat,
    hash_identify,
    rot_cipher,
    xor_bruteforce,
)
from mcps.binary_mcp import (
    _run_analysis,
    binary_disasm,
    binary_functions,
    binary_info,
    binary_strings,
)


class DecoderMCPTests(unittest.IsolatedAsyncioTestCase):
    async def test_decode_multiformat_base64_and_hex(self):
        # Base64 with valid flag
        b64_res = json.loads(await decode_multiformat("ZmxhZ3tva30="))
        self.assertIn("results", b64_res)
        b64_row = next(r for r in b64_res["results"] if r["format"] == "base64")
        self.assertEqual(b64_row["text"], "flag{ok}")
        self.assertEqual(b64_row["data_hex"], "666c61677b6f6b7d")

        # Hex binary data with non-utf8 bytes (text is None)
        hex_res = json.loads(await decode_multiformat("ff00"))
        self.assertIn("results", hex_res)
        hex_row = next(r for r in hex_res["results"] if r["format"] == "hex")
        self.assertEqual(hex_row["data_hex"], "ff00")
        self.assertIsNone(hex_row["text"])

        # Invalid format returns empty results, does not crash
        empty_res = json.loads(await decode_multiformat("not an encoded string with spaces"))
        self.assertEqual(empty_res, {"results": []})

    async def test_decode_multiformat_input_limit(self):
        large_input = "A" * 5000
        res = json.loads(await decode_multiformat(large_input))
        self.assertIn("error", res)
        self.assertEqual(res["error"], "Input exceeds 4096 bytes")

    async def test_rot_cipher_single_and_negative_wrap(self):
        # ROT13
        res = json.loads(await rot_cipher("synt{bx}", shift=13, mode="single"))
        self.assertEqual(res["results"][0]["text"], "flag{ok}")

        # Negative shift wrap (-13 % 26 == 13)
        res_neg = json.loads(await rot_cipher("synt{bx}", shift=-13, mode="single"))
        self.assertEqual(res_neg["results"][0]["text"], "flag{ok}")

        # All 25 shifts mode
        res_all = json.loads(await rot_cipher("abc", mode="all"))
        self.assertEqual(len(res_all["results"]), 25)
        self.assertEqual(res_all["results"][0]["shift"], 1)

        # Invalid mode
        err = json.loads(await rot_cipher("abc", mode="invalid"))
        self.assertIn("error", err)

    async def test_xor_bruteforce_flag_bonus_and_key_length(self):
        # Plaintext "flag{xor}", XOR with key 0x42 (66)
        plaintext = b"flag{xor}"
        ciphertext = bytes(b ^ 0x42 for b in plaintext).hex()

        res = json.loads(await xor_bruteforce(ciphertext, key_length=1))
        self.assertIn("results", res)
        top = res["results"][0]
        self.assertEqual(top["key"], 66)
        self.assertEqual(top["text"], "flag{xor}")

        # key_length != 1 returns error
        err = json.loads(await xor_bruteforce(ciphertext, key_length=2))
        self.assertIn("error", err)

        # Empty hex returns empty results
        empty = json.loads(await xor_bruteforce("", key_length=1))
        self.assertEqual(empty, {"results": []})

    async def test_hash_identify_ambiguity_and_crypt_formats(self):
        # 32 hex chars: returns MD5 and NTLM without arbitrarily picking one
        md5_res = json.loads(await hash_identify("5d41402abc4b2a76b9719d911017c592"))
        algos = [c["algorithm"] for c in md5_res["results"]]
        self.assertIn("MD5", algos)
        self.assertIn("NTLM", algos)

        # SHA256 (64 hex chars)
        sha_res = json.loads(await hash_identify("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"))
        self.assertEqual(len(sha_res["results"]), 1)
        self.assertEqual(sha_res["results"][0]["algorithm"], "SHA256")

        # bcrypt format
        bcrypt_res = json.loads(await hash_identify("$2b$12$e8O6V.jU9E1kY6kXqO0mNeZ9xV5sD4f.g8H7j6K5L4M3N2O1P0Q."))
        self.assertEqual(bcrypt_res["results"][0]["algorithm"], "bcrypt")


class BinaryMCPTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.work_dir = Path(self.td.name)

        # Create a simple C ELF fixture
        c_code = (
            '#include <stdio.h>\n'
            'const char *token = "ctf_binary_smoke";\n'
            'int main(void) {\n'
            '    printf("%s\\n", token);\n'
            '    return token[0] == 0;\n'
            '}\n'
        )
        src_path = self.work_dir / "fixture.c"
        src_path.write_text(c_code)
        self.elf_path = self.work_dir / "fixture"
        res = subprocess.run(
            ["gcc", "-g", "-O0", "-fstack-protector-all", "-fPIE", "-pie",
             "-Wl,-z,relro,-z,now", str(src_path), "-o", str(self.elf_path)],
            capture_output=True,
            text=True,
        )
        if res.returncode != 0:
            raise RuntimeError(f"Failed compiling test fixture: {res.stderr}")
    def tearDown(self):
        self.td.cleanup()

    async def test_binary_validation_rejects_missing_nonelf_and_directories(self):
        # Missing file
        missing_res = json.loads(await binary_info(str(self.work_dir / "missing")))
        self.assertIn("error", missing_res)
        self.assertIn("File does not exist", missing_res["error"])

        # Non-ELF file
        txt_path = self.work_dir / "not_elf.txt"
        txt_path.write_text("Hello plain text")
        non_elf_res = json.loads(await binary_info(str(txt_path)))
        self.assertIn("error", non_elf_res)
        self.assertIn("not an ELF binary", non_elf_res["error"])

        # Directory
        dir_res = json.loads(await binary_info(str(self.work_dir)))
        self.assertIn("error", dir_res)
        self.assertIn("not a regular file", dir_res["error"])

    async def test_binary_disasm_rejects_malicious_target(self):
        # Command injection attempts must be rejected before spawning
        bad_targets = [
            "main;!touch /tmp/pwn",
            "main | cat",
            "main`id`",
            "main $(whoami)",
            "main@something",
        ]
        for target in bad_targets:
            res = json.loads(await binary_disasm(str(self.elf_path), target))
            self.assertIn("error", res)
            self.assertEqual(res["error"], "Invalid disassembly target symbol/address")

    async def test_binary_tools_succeed_on_valid_fixture(self):
        # binary_info
        info_res = json.loads(await binary_info(str(self.elf_path)))
        self.assertIn("result", info_res)
        prot = info_res["result"]
        self.assertTrue(prot.get("arch"))
        self.assertEqual(prot.get("canary"), "Enabled")
        self.assertEqual(prot.get("pie"), "Enabled")

        # binary_functions
        func_res = json.loads(await binary_functions(str(self.elf_path)))
        self.assertIn("result", func_res)
        funcs = func_res["result"]
        func_names = [f.get("name") for f in funcs if isinstance(f, dict)]
        self.assertTrue(any("main" in name for name in func_names))

        # binary_disasm on "main"
        disasm_res = json.loads(await binary_disasm(str(self.elf_path), "main"))
        self.assertIn("result", disasm_res)
        self.assertIn("main", disasm_res["result"])

        # binary_strings
        strings_res = json.loads(await binary_strings(str(self.elf_path), min_len=4))
        self.assertIn("result", strings_res)
        self.assertIn("ctf_binary_smoke", strings_res["result"])

    async def test_run_analysis_terminates_process_group_on_timeout(self):
        # Create a Python script that spawns a child process and sleeps
        sleeper = self.work_dir / "sleeper.py"
        pid_file = self.work_dir / "child.pid"
        sleeper.write_text(f"""
import os, time, sys
with open("{pid_file}", "w") as f:
    f.write(str(os.getpid()))
time.sleep(30)
""")
        rc, out, err, truncated = await _run_analysis(
            ["python3", str(sleeper)],
            timeout=1.0,
        )
        self.assertTrue(truncated)
        self.assertIn("timed out", err)

        # Verify child process was killed
        self.assertTrue(pid_file.is_file())
        child_pid = int(pid_file.read_text())
        await asyncio.sleep(0.5)
        # Process should no longer exist
        try:
            os.kill(child_pid, 0)
            still_alive = True
        except ProcessLookupError:
            still_alive = False
        self.assertFalse(still_alive, "Child process was not terminated on timeout")


if __name__ == "__main__":
    unittest.main()
