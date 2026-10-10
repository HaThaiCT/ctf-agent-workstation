import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from webapp.runtime_resources import (
    builtin_mcp_statuses,
    prepare_workspace_mcp,
    select_automatic_skills,
    workspace_mcp_servers,
)


class AutomaticSkillsTests(unittest.TestCase):
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
            "web-exploitation-toolkit",
            "pwntools-exploit-crafting",
            "apk-analysis",
            "my-unrelated-upload",
        )
        self.catalog = [{"name": name} for name in names]

    def select(self, **challenge):
        return set(select_automatic_skills(challenge, self.catalog))

    def test_explicit_category_adds_base_without_unrelated_tool_workflows(self):
        self.assertEqual(
            self.select(category=" Cryptography ", files=[]),
            {"ground-your-findings", "ctf-methodology", "ctf-crypto"},
        )
        self.assertEqual(
            self.select(category="WEB", files=[]),
            {"ground-your-findings", "ctf-methodology", "ctf-web", "web-exploitation-toolkit"},
        )
        self.assertEqual(
            self.select(category="pwn", files=[]),
            {
                "ground-your-findings",
                "ctf-methodology",
                "ctf-pwn",
                "kernel-gef-debugging",
                "craft-rop-chains-with-angrop",
                "pwntools-exploit-crafting",
            },
        )

    def test_file_evidence_combines_with_category(self):
        selection = self.select(
            category="web", files=["captures/TRACE.PCAPNG", "mobile/app.APK"]
        )
        self.assertTrue(
            {
                "ctf-web",
                "pcap-extraction",
                "ctf-forensics",
                "apk-analysis",
                "ctf-reverse",
            }
            <= selection
        )
        self.assertNotIn("ctf-crypto", selection)
        self.assertNotIn("my-unrelated-upload", selection)

    def test_unknown_category_retains_baseline_only(self):
        selected = self.select(category="", files=[])
        self.assertEqual(selected, {"ground-your-findings", "ctf-methodology"})
        self.assertNotIn("ctf-web", selected)
        self.assertNotIn("ctf-pwn", selected)
        self.assertNotIn("ctf-crypto", selected)
        self.assertNotIn("my-unrelated-upload", selected)
        self.assertEqual(select_automatic_skills({}, []), [])

    def test_pwn_category_does_not_select_web_skills(self):
        selected = self.select(category="PWN#001", files=["vault", "libc.so.6"])
        self.assertIn("ctf-pwn", selected)
        self.assertIn("pwntools-exploit-crafting", selected)
        self.assertNotIn("ctf-web", selected)
        self.assertNotIn("web-exploitation-toolkit", selected)
        self.assertNotIn("ctf-crypto", selected)

    def test_fuzzy_category_matching(self):
        from webapp.runtime_resources import normalize_challenge_category
        self.assertEqual(normalize_challenge_category("Binary Exploitation"), "pwn")
        self.assertEqual(normalize_challenge_category("intro-to-pwn"), "pwn")
        self.assertEqual(normalize_challenge_category("Web Security"), "web")
        self.assertEqual(normalize_challenge_category("Reversing 101"), "reverse")
        self.assertEqual(normalize_challenge_category("Crypto-math"), "crypto")
        self.assertEqual(normalize_challenge_category("Disk Forensics"), "forensics")
        self.assertEqual(normalize_challenge_category("out context"), "")
    def test_missing_workflow_never_creates_a_nonexistent_selection(self):
        catalog = [{"name": "ground-your-findings"}, {"name": "ctf-web"}]
        self.assertEqual(
            select_automatic_skills({"category": "pwn", "files": ["app.apk"]}, catalog),
            ["ground-your-findings"],
        )

    def test_web_and_pwn_cookbooks_selected_by_capabilities(self):
        from webapp.tool_environment import HostEnvironment, ToolCapability
        env_with = HostEnvironment(
            os_distro="kali",
            has_web_tools=True,
            tools={"pwntools": ToolCapability(name="pwntools", available=True)},
        )
        web_sel = select_automatic_skills({"category": "web", "files": []}, self.catalog, env=env_with)
        self.assertIn("web-exploitation-toolkit", web_sel)
        pwn_sel = select_automatic_skills({"category": "pwn", "files": []}, self.catalog, env=env_with)
        self.assertIn("pwntools-exploit-crafting", pwn_sel)

        env_without = HostEnvironment(
            os_distro="kali",
            has_web_tools=False,
            tools={"pwntools": ToolCapability(name="pwntools", available=False)},
        )
        web_no = select_automatic_skills({"category": "web", "files": []}, self.catalog, env=env_without)
        self.assertNotIn("web-exploitation-toolkit", web_no)
        pwn_no = select_automatic_skills({"category": "pwn", "files": []}, self.catalog, env=env_without)
        self.assertNotIn("pwntools-exploit-crafting", pwn_no)


class WorkspaceMCPTests(unittest.TestCase):
    def test_malformed_existing_configuration_does_not_silently_fallback(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / ".ctf-mcp.json"
            for content in ("invalid-json", "[]", '{"mcpServers": []}'):
                path.write_text(content)
                with (
                    self.subTest(content=content),
                    self.assertRaisesRegex(
                        RuntimeError, "MCP configuration is invalid"
                    ),
                ):
                    workspace_mcp_servers(root)
            path.write_text(json.dumps({"mcpServers": {}}))
            self.assertEqual(workspace_mcp_servers(root), {})

    def test_missing_debugger_does_not_disable_decoder(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "mcps").mkdir()
            (directory / "mcps/gdb_mcp.py").write_text("# gdb fixture\n")
            (directory / "mcps/decoder_mcp.py").write_text("# decoder fixture\n")
            (directory / "mcps/binary_mcp.py").write_text("# binary fixture\n")
            with patch("webapp.runtime_resources.shutil.which", side_effect=lambda cmd: None if cmd == "gdb" else f"/bin/{cmd}"):
                statuses = builtin_mcp_statuses(directory)
            by_name = {s["name"]: s for s in statuses}
            self.assertFalse(by_name["ctf_gdb"]["available"])
            self.assertIn("GDB executable", by_name["ctf_gdb"]["error"])
            self.assertTrue(by_name["ctf_decoder"]["available"])

    def test_missing_rizin_leaves_binary_unavailable(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "mcps").mkdir()
            (directory / "mcps/gdb_mcp.py").write_text("# gdb fixture\n")
            (directory / "mcps/decoder_mcp.py").write_text("# decoder fixture\n")
            (directory / "mcps/binary_mcp.py").write_text("# binary fixture\n")
            with patch("webapp.runtime_resources.shutil.which", side_effect=lambda cmd: None if cmd == "rizin" else f"/bin/{cmd}"):
                statuses = builtin_mcp_statuses(directory)
            by_name = {s["name"]: s for s in statuses}
            self.assertFalse(by_name["ctf_binary"]["available"])
            self.assertIn("rizin executable", by_name["ctf_binary"]["error"])
            self.assertTrue(by_name["ctf_decoder"]["available"])

    def test_missing_mcp_sdk_does_not_raise_and_marks_unavailable(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "mcps").mkdir()
            (directory / "mcps/gdb_mcp.py").write_text("# gdb fixture\n")
            with patch("importlib.util.find_spec", return_value=None):
                statuses = builtin_mcp_statuses(directory)
            for s in statuses:
                self.assertFalse(s["available"])
                self.assertEqual(s["status"], "unavailable")

    def test_prepare_workspace_mcp_materializes_available_subset(self):
        with tempfile.TemporaryDirectory() as root:
            repo = Path(root) / "repo"
            (repo / "mcps").mkdir(parents=True)
            (repo / "mcps/gdb_mcp.py").write_text("# gdb fixture\n")
            (repo / "mcps/decoder_mcp.py").write_text("# decoder fixture\n")
            (repo / "mcps/binary_mcp.py").write_text("# binary fixture\n")
            workspace = Path(root) / "workspace"
            with patch("webapp.runtime_resources.shutil.which", side_effect=lambda cmd: None if cmd == "gdb" else f"/bin/{cmd}"):
                statuses = prepare_workspace_mcp(workspace, repo)
            cfg_file = workspace / ".ctf-mcp.json"
            self.assertTrue(cfg_file.is_file())
            data = json.loads(cfg_file.read_text())
            servers = data.get("mcpServers", {})
            self.assertNotIn("ctf_gdb", servers)
            self.assertIn("ctf_decoder", servers)
            self.assertIn("ctf_binary", servers)

if __name__ == "__main__":
    unittest.main()
