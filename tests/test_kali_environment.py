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
    extract_service_targets,
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
            common = p / "common.txt"
            common.write_text("admin\nlogin\n")
            sub_dir = p / "subdir"
            sub_dir.mkdir()
            link_common = p / "link_common.txt"
            link_common.symlink_to(common)
            unreadable = p / "unreadable.txt"
            unreadable.write_text("secret\n")
            unreadable.chmod(0o000)
            try:
                found = scan_available_wordlists([
                    common,
                    sub_dir,
                    link_common,
                    p / "absent.txt",
                    unreadable,
                ])
                # Only common.txt should be returned; directory and unreadable are excluded, symlink is deduped
                self.assertEqual(len(found), 1)
                self.assertEqual(found[0], common.resolve())
            finally:
                unreadable.chmod(0o644)

    def test_default_wordlist_candidates_no_password_corpus(self):
        from webapp.tool_environment import DEFAULT_WORDLIST_CANDIDATES
        for cand in DEFAULT_WORDLIST_CANDIDATES:
            cand_str = str(cand).lower()
            self.assertNotIn("rockyou", cand_str)
            self.assertNotEqual(cand_str, "/usr/share/wordlists")
            self.assertNotEqual(cand_str, "/usr/share/seclists")

    def test_setup_run_dir_wordlists_symlinks_narrow_web_dir(self):
        from webapp import app as app_module
        with tempfile.TemporaryDirectory() as td:
            root = Path(td)
            saved_challenges_dir = app_module.CHALLENGES_DIR
            try:
                app_module.CHALLENGES_DIR = root / "challenges"
                app_module.CHALLENGES_DIR.mkdir()
                run_dir = app_module.setup_run_dir("chall_1", "run_1")
                wl_link = run_dir / "wordlists"
                if wl_link.exists() or wl_link.is_symlink():
                    target = wl_link.resolve()
                    target_str = str(target)
                    self.assertNotIn("rockyou", target_str)
                    self.assertNotEqual(target_str, "/usr/share/wordlists")
                    self.assertNotEqual(target_str, "/usr/share/seclists")
                
                # Verify pre-existing user link/file is not overwritten
                run_2 = app_module.CHALLENGES_DIR / "chall_1" / "_runs" / "run_2"
                run_2.mkdir(parents=True)
                custom_file = run_2 / "wordlists"
                custom_file.write_text("custom user list")
                app_module.setup_run_dir("chall_1", "run_2")
                self.assertTrue(custom_file.is_file())
                self.assertEqual(custom_file.read_text(), "custom user list")
            finally:
                app_module.CHALLENGES_DIR = saved_challenges_dir

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

    def test_extract_service_targets_parsing_and_bounds(self):
        sample = "nc chall.example 1337; visit https://ctf.example:8443/login?token=secret#note and 10.10.10.1:9000 and [::1]:5000"
        targets = extract_service_targets(sample)
        self.assertEqual(
            targets,
            [
                "nc chall.example 1337",
                "https://ctf.example:8443/login",
                "10.10.10.1:9000",
                "[::1]:5000",
            ],
        )

        # Reject invalid ports, invalid IPs, malformed URLs, and dedup / 10-bound
        invalids = "nc bad.host 0 nc bad.host 65536 999.999.999.999:80 http://invalid:70000/ [invalid]:99999"
        self.assertEqual(extract_service_targets(invalids), [])

        # Dedup and max 10 bound
        many = " ".join([f"10.0.0.{i}:8080" for i in range(15)] + ["10.0.0.1:8080"])
        bounded = extract_service_targets(many)
        self.assertEqual(len(bounded), 10)
        self.assertEqual(len(set(bounded)), 10)

    def test_inspect_challenge_files_missing_dir_with_service_and_tool_context(self):
        with tempfile.TemporaryDirectory() as td:
            missing_dir = Path(td) / "missing"
            desc = "Find the flag at https://chall.web.ctf/login or nc pwn.chall 9999"
            inspection = inspect_challenge_files(missing_dir, description=desc, category="web")
            self.assertEqual(len(inspection.file_summaries), 0)
            self.assertEqual(
                inspection.service_targets,
                ["https://chall.web.ctf/login", "nc pwn.chall 9999"],
            )
            self.assertTrue(len(inspection.host_tools) > 0)
            self.assertIn("https://chall.web.ctf/login", inspection.prompt_context)
            self.assertIn("nc pwn.chall 9999", inspection.prompt_context)

    def test_inspect_challenge_files_probe_exception_retains_targets(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            desc = "Target service at 127.0.0.1:1337"
            with patch("webapp.target_inspector.probe_host_environment", side_effect=RuntimeError("probe failed")):
                inspection = inspect_challenge_files(p, description=desc, category="misc")
            self.assertEqual(inspection.service_targets, ["127.0.0.1:1337"])
            self.assertEqual(inspection.host_tools, [])
            self.assertIn("127.0.0.1:1337", inspection.prompt_context)

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
            "web-exploitation-toolkit",
            "pwntools-exploit-crafting",
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


class ChallengeRunDeletionTests(unittest.TestCase):
    def test_delete_challenge_run_frees_disk_and_updates_metadata(self):
        from starlette.testclient import TestClient
        from webapp import app as app_module

        client = TestClient(app_module.app)
        cid = "test_del_chall"
        run_a_id = "run_a"
        run_b_id = "run_b"

        chall_dir = app_module.CHALLENGES_DIR / cid
        run_a_dir = chall_dir / "_runs" / run_a_id
        run_b_dir = chall_dir / "_runs" / run_b_id
        run_a_dir.mkdir(parents=True, exist_ok=True)
        run_b_dir.mkdir(parents=True, exist_ok=True)
        (run_a_dir / "large_temp_file.bin").write_bytes(b"\x00" * 1024)

        state_dir = app_module.challenge_state_dir(cid)
        state_dir.mkdir(parents=True, exist_ok=True)
        jsonl_a = state_dir / f"{run_a_id}.jsonl"
        jsonl_a.write_text('{"type": "system", "message": "hello"}\n')

        run_a = app_module.make_run(run_a_id, "codex", "gpt-6.1", "medium", status="failed")
        run_b = app_module.make_run(run_b_id, "claude", "sonnet", "", status="solving")
        challenge = {
            "id": cid,
            "name": "Deletion Test Challenge",
            "description": "test",
            "category": "pwn",
            "flag_format": "",
            "mode": "parallel",
            "status": "solving",
            "created_at": "2026-10-10T00:00:00",
            "files": [],
            "runs": {run_a_id: run_a, run_b_id: run_b},
        }
        app_module.challenges[cid] = challenge
        app_module.save_metadata(challenge)

        try:
            # Verify run_a exists before deletion
            self.assertTrue(run_a_dir.exists())
            self.assertTrue(jsonl_a.exists())

            # Call DELETE endpoint
            resp = client.delete(f"/api/challenges/{cid}/runs/{run_a_id}")
            self.assertEqual(resp.status_code, 200)
            self.assertTrue(resp.json().get("ok"))

            # Verify run_a is removed from in-memory challenge
            self.assertNotIn(run_a_id, challenge["runs"])
            self.assertIn(run_b_id, challenge["runs"])

            # Verify workspace directory and JSONL log are removed from disk
            self.assertFalse(run_a_dir.exists())
            self.assertFalse(jsonl_a.exists())
            self.assertTrue(run_b_dir.exists())

            # Verify 404 for non-existent run
            resp_404 = client.delete(f"/api/challenges/{cid}/runs/nonexistent")
            self.assertEqual(resp_404.status_code, 404)
        finally:
            app_module.challenges.pop(cid, None)
            import shutil
            shutil.rmtree(chall_dir, ignore_errors=True)
            shutil.rmtree(state_dir, ignore_errors=True)
if __name__ == "__main__":
    unittest.main()
