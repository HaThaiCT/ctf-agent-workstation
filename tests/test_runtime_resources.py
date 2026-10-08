import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from webapp.runtime_resources import (
    builtin_mcp_status,
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
            {"ground-your-findings", "ctf-methodology", "ctf-web"},
        )
        self.assertEqual(
            self.select(category="pwn", files=[]),
            {
                "ground-your-findings",
                "ctf-methodology",
                "ctf-pwn",
                "kernel-gef-debugging",
                "craft-rop-chains-with-angrop",
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

    def test_unknown_category_exposes_workflows_but_not_unrelated_upload(self):
        selected = self.select(category="", files=[])
        self.assertTrue({"ctf-web", "ctf-crypto", "ctf-pwn", "ctf-reverse"} <= selected)
        self.assertNotIn("my-unrelated-upload", selected)
        self.assertEqual(select_automatic_skills({}, []), [])

    def test_missing_workflow_never_creates_a_nonexistent_selection(self):
        catalog = [{"name": "ground-your-findings"}, {"name": "ctf-web"}]
        self.assertEqual(
            select_automatic_skills({"category": "pwn", "files": ["app.apk"]}, catalog),
            ["ground-your-findings"],
        )


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

    def test_missing_debugger_is_not_reported_available_or_connected(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / "mcps").mkdir()
            (directory / "mcps/gdb_mcp.py").write_text("# resource fixture\n")
            with patch("webapp.runtime_resources.shutil.which", return_value=None):
                status = builtin_mcp_status(directory)
            self.assertFalse(status["available"])
            self.assertEqual(status["status"], "unavailable")
            self.assertIn("GDB executable", status["error"])


if __name__ == "__main__":
    unittest.main()
