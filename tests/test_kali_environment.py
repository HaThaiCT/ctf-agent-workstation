"""Unit tests for Kali Linux CTF solving enhancements."""
from __future__ import annotations

import os
import tempfile

# Set isolated APP_ROOT_DIR before importing webapp.app to avoid permission errors on /root
if "APP_ROOT_DIR" not in os.environ:
    os.environ["APP_ROOT_DIR"] = tempfile.mkdtemp(prefix="ctf-test-app-root-")

import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

from webapp.app import (
    _build_standard_prompt,
    build_prompt,
    load_instruction_prompt,
)
from webapp.runtime_resources import (
    _resolve_category_skills,
    select_automatic_skills,
)
from webapp.target_inspector import (
    build_preflight_prompt,
    inspect_archive,
    inspect_challenge_files,
    inspect_elf_binary,
)
from webapp.tool_environment import (
    HostEnvironment,
    ToolCapability,
    detect_os_distro,
    probe_host_environment,
    scan_available_wordlists,
)


class ToolEnvironmentTests(unittest.TestCase):
    def test_detect_os_distro_parses_kali(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write('ID=kali\nID_LIKE=debian\nPRETTY_NAME="Kali GNU/Linux Rolling"\n')
            temp_path = Path(f.name)
        try:
            self.assertEqual(detect_os_distro(temp_path), "kali")
        finally:
            temp_path.unlink(missing_ok=True)

    def test_detect_os_distro_parses_ubuntu_and_unknown(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write('ID=ubuntu\nVERSION_ID="24.04"\n')
            temp_path = Path(f.name)
        try:
            self.assertEqual(detect_os_distro(temp_path), "ubuntu")
        finally:
            temp_path.unlink(missing_ok=True)

        nonexistent = Path("/nonexistent/os-release-test")
        self.assertEqual(detect_os_distro(nonexistent), "unknown")

    def test_probe_host_environment_parses_os_release(self):
        with tempfile.NamedTemporaryFile("w", delete=False) as f:
            f.write('ID="kali"\nVERSION="2024.1"\n')
            temp_path = Path(f.name)
        try:
            env = probe_host_environment(force_refresh=True, os_release_path=temp_path)
            self.assertEqual(env.os_distro, "kali")
            self.assertIn("gdb", env.tools)
            self.assertIn("ghidra", env.tools)
            self.assertIn("rizin", env.tools)
            self.assertIn("sage", env.tools)
            self.assertIn("checksec", env.tools)
            env_dict = env.to_dict()
            self.assertEqual(env_dict["os_distro"], "kali")
            self.assertIsInstance(env_dict["tools"], dict)
        finally:
            temp_path.unlink(missing_ok=True)

    def test_scan_available_wordlists(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            rockyou = p / "rockyou.txt"
            rockyou.write_text("password123\n")
            found = scan_available_wordlists([rockyou, p / "absent.txt"])
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0], rockyou.resolve())


class TargetInspectorTests(unittest.TestCase):
    def test_target_inspector_detects_elf_protections(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            # Create a symlink to /bin/ls if it exists
            ls_path = Path("/bin/ls")
            if ls_path.exists():
                (p / "chall.bin").symlink_to(ls_path)
                inspection = inspect_challenge_files(p)
                self.assertGreaterEqual(len(inspection.file_summaries), 1)
                self.assertIn("chall.bin", inspection.binary_protections)
                prot = inspection.binary_protections["chall.bin"]
                self.assertTrue(prot.get("arch"))
                self.assertIn(prot.get("nx"), ("Enabled", "Disabled"))
                self.assertIn("[Pre-flight Target Inspection]:", inspection.prompt_context)
                self.assertIn("chall.bin", inspection.prompt_context)
                self.assertIn("Protections:", inspection.prompt_context)

    def test_inspect_archive_lists_contents(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            zpath = p / "archive.zip"
            with zipfile.ZipFile(zpath, "w") as zf:
                zf.writestr("entry1.txt", "content1")
                zf.writestr("entry2.bin", b"\x00\x01\x02")
            contents = inspect_archive(zpath)
            self.assertEqual(contents, ["entry1.txt", "entry2.bin"])

    def test_build_preflight_prompt_formatting(self):
        summaries = [
            {"name": "vuln.elf", "size": 1024, "magic_type": "ELF 64-bit LSB executable"},
            {"name": "notes.txt", "size": 42, "magic_type": "ASCII text"},
        ]
        protections = {
            "vuln.elf": {
                "arch": "x86-64",
                "nx": "Enabled",
                "canary": "Disabled",
                "pie": "Enabled",
                "relro": "Full RELRO",
                "stripped": "No",
            }
        }
        archives = {}
        prompt = build_preflight_prompt(summaries, protections, archives, [Path("/usr/share/wordlists/rockyou.txt")])
        self.assertIn("[Pre-flight Target Inspection]:", prompt)
        self.assertIn("- `vuln.elf`: ELF 64-bit LSB executable", prompt)
        self.assertIn("NX: Enabled", prompt)
        self.assertIn("Canary: Disabled", prompt)
        self.assertIn("- `notes.txt`: ASCII text", prompt)
        self.assertIn("Wordlists available on host:", prompt)


class CapabilitySkillRoutingTests(unittest.TestCase):
    def setUp(self):
        names = (
            "ground-your-findings",
            "ctf-methodology",
            "ctf-crypto",
            "ctf-web",
            "ctf-pwn",
            "ctf-reverse",
            "ctf-forensics",
            "ctf-misc",
            "pcap-extraction",
            "file-repair-and-stego",
            "tsk-disk-recovery",
            "volatility3-memdump",
            "kernel-gef-debugging",
            "craft-rop-chains-with-angrop",
            "analyze-with-ida-domain-api",
            "ghidra-headless-decompilation",
            "rizin-disassembly",
            "sagemath-crypto-solvers",
            "apk-analysis",
        )
        self.catalog = [{"name": name} for name in names]

    def test_skill_selection_falls_back_when_ida_missing(self):
        # Case 1: IDA licensed -> analyze-with-ida-domain-api
        env_ida = HostEnvironment(
            os_distro="kali",
            has_ida_license=True,
            has_ghidra=True,
            tools={"rizin": ToolCapability(name="rizin", available=True)},
        )
        sel_ida = select_automatic_skills({"category": "reverse", "files": []}, self.catalog, env=env_ida)
        self.assertIn("analyze-with-ida-domain-api", sel_ida)
        self.assertIn("ctf-reverse", sel_ida)
        self.assertNotIn("ghidra-headless-decompilation", sel_ida)

        # Case 2: No IDA license, Ghidra + Rizin available -> fallback to Ghidra & Rizin
        env_fallback = HostEnvironment(
            os_distro="kali",
            has_ida_license=False,
            has_ghidra=True,
            tools={"rizin": ToolCapability(name="rizin", available=True)},
        )
        sel_fallback = select_automatic_skills({"category": "reverse", "files": []}, self.catalog, env=env_fallback)
        self.assertNotIn("analyze-with-ida-domain-api", sel_fallback)
        self.assertIn("ghidra-headless-decompilation", sel_fallback)
        self.assertIn("rizin-disassembly", sel_fallback)
        self.assertIn("ctf-reverse", sel_fallback)

        # Case 3: No IDA, no Ghidra, only Rizin
        env_rizin_only = HostEnvironment(
            os_distro="kali",
            has_ida_license=False,
            has_ghidra=False,
            tools={"rizin": ToolCapability(name="rizin", available=True)},
        )
        sel_rizin = select_automatic_skills({"category": "reverse", "files": []}, self.catalog, env=env_rizin_only)
        self.assertNotIn("analyze-with-ida-domain-api", sel_rizin)
        self.assertNotIn("ghidra-headless-decompilation", sel_rizin)
        self.assertIn("rizin-disassembly", sel_rizin)

    def test_crypto_skill_selects_sagemath_when_available(self):
        env_sage = HostEnvironment(os_distro="kali", has_sagemath=True)
        sel = select_automatic_skills({"category": "crypto", "files": []}, self.catalog, env=env_sage)
        self.assertIn("sagemath-crypto-solvers", sel)
        self.assertIn("ctf-crypto", sel)

        env_no_sage = HostEnvironment(os_distro="kali", has_sagemath=False)
        sel_no = select_automatic_skills({"category": "crypto", "files": []}, self.catalog, env=env_no_sage)
        self.assertNotIn("sagemath-crypto-solvers", sel_no)
        self.assertIn("ctf-crypto", sel_no)

    def test_pwn_skill_selects_kernel_debugging_on_kernel_files(self):
        env = HostEnvironment(os_distro="kali", has_gdb_enhanced=False)
        sel_kernel = select_automatic_skills({"category": "pwn", "files": ["bzImage", "rootfs.cpio"]}, self.catalog, env=env)
        self.assertIn("kernel-gef-debugging", sel_kernel)
        self.assertIn("craft-rop-chains-with-angrop", sel_kernel)

    def test_backward_compatibility_when_env_none(self):
        # Baseline calls without env behave as before
        sel_rev = select_automatic_skills({"category": "reverse", "files": []}, self.catalog)
        self.assertIn("analyze-with-ida-domain-api", sel_rev)
        self.assertIn("ctf-reverse", sel_rev)

        sel_crypto = select_automatic_skills({"category": "crypto", "files": []}, self.catalog)
        self.assertEqual(sel_crypto, ["ctf-crypto", "ctf-methodology", "ground-your-findings"])


class InstructionPromptTests(unittest.TestCase):
    def test_instruction_prompt_retains_evidence_loop(self):
        prompt = load_instruction_prompt()
        self.assertTrue(bool(prompt), "instruction.txt must not be empty")
        self.assertIn("Evidence-Based CTF", prompt)
        self.assertIn("Phase 1: Initial Analysis & Hypothesis Formulation", prompt)
        self.assertIn("Phase 2: Falsifiable Tests", prompt)
        self.assertIn("Phase 3: Controlled Exploitation", prompt)
        self.assertIn("Phase 4: Flag Extraction & Verification", prompt)
        self.assertIn("Phase 5: Anti-Rabbit Hole Rule", prompt)


class PromptIntegrationTests(unittest.TestCase):
    def test_prompt_includes_preflight_inspection_context(self):
        challenge = {
            "id": "chall1",
            "name": "Buffer Overflow 101",
            "description": "Exploit the binary to get the flag.",
            "mode": "single",
            "files": ["chall.bin"],
        }
        run = {
            "id": "run1",
            "agent": "codex",
            "model": "gpt-6.1",
            "effort": "high",
            "status": "solving",
        }
        inspection_snippet = "[Pre-flight Target Inspection]:\n- `chall.bin`: ELF 64-bit. Protections: NX: Enabled."
        prompt = build_prompt(challenge, run, inspection_context=inspection_snippet)
        self.assertIn("[Pre-flight Target Inspection]:", prompt)
        self.assertIn("NX: Enabled", prompt)
        self.assertIn("Buffer Overflow 101", prompt)


class ApiEnvironmentTests(unittest.TestCase):
    def test_get_api_environment_returns_host_environment_json(self):
        from starlette.testclient import TestClient
        from webapp.app import app

        client = TestClient(app)
        response = client.get("/api/environment")
        self.assertEqual(response.status_code, 200)
        data = response.json()
        self.assertIn("os_distro", data)
        self.assertIn("tools", data)
        self.assertIn("wordlists", data)
        self.assertIn("has_ida_license", data)
        self.assertIn("has_ghidra", data)
        self.assertIn("has_sagemath", data)
        self.assertIn("has_gdb_enhanced", data)
        self.assertIsInstance(data["tools"], dict)

if __name__ == "__main__":
    unittest.main()
