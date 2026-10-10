# Kali Linux CTF Workstation Enhancements & Default Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure default 9router provider endpoint and key, add built-in Codex catalog template fallback, expand tool environment with Web/Pwn/Cracking detection, add 3 CTF skills and 2 CTF MCP servers, and provide an automated Kali Linux workstation setup script.

**Architecture:** Extend `webapp/model_gateway.py` with default endpoint `https://rr28qzu.abc-tunnel.us/v1` and fallback key `sk-fde312a734f0b56f-ybksbs-09716010` alongside built-in template fallback for Codex. Broaden `webapp/tool_environment.py` and `webapp/target_inspector.py` to probe Kali Web/Pwn/Cracking tooling and auto-detect remote network targets. Provide two dedicated stdio MCP servers in `mcps/` (`ctf_decoder` and `ctf_binary`) auto-injected into `.ctf-mcp.json`. Automate system setup via `install_scripts/kali_setup.sh`.

**Tech Stack:** Python 3.12+, Starlette, MCP (Model Context Protocol 2.x), Rizin, GDB, Pwntools, Uvicorn, Kali Linux apt tooling.

**Spec:** `docs/superpowers/specs/2026-10-10-kali-ctf-enhancements-design.md`

## Global Constraints

- API endpoint default: `https://rr28qzu.abc-tunnel.us/v1`
- API key default: `sk-fde312a734f0b56f-ybksbs-09716010`
- Claude default model: `ag/claude-sonnet-4-6`, effort: `high`
- Codex default model: `cx/gpt-6.1-sol`, effort: `medium`
- Workstation Python venv: `~/.local/share/ctf-agent-workstation/venv`
- Target OS: Kali Linux Rolling 2026.1 x86_64
- Zero regression on existing offline / mock unit tests.

## Review Focus

1. Gateway configuration when no auth file exists: must cleanly return default endpoint and key without raising 400/503.
2. Codex launch when neither `codex-models.json` nor `models_cache.json` exists on disk: must successfully generate valid `gateway-codex-models.json` from built-in template without raising "Codex model metadata is unavailable".
3. Pre-flight inspector on description containing `nc 10.10.10.1 1337` or `http://ctf.local:8080`: must extract and present the target endpoint in prompt context.
4. Binary MCP tools when invoked on invalid or non-ELF files: must return structured error string instead of crashing or hanging the stdio MCP loop.
5. Workstation Python environment: `webapp/start.sh` must execute with `~/.local/share/ctf-agent-workstation/venv/bin/python` without requiring system-level package breaks.

---

### Task 1: Model Gateway Defaults & Codex Catalog Fallback

**Files:**
- Modify: `webapp/model_gateway.py:21-65`, `webapp/model_gateway.py:300-385`
- Modify: `webapp/app.py:2334-2355`
- Modify: `webapp/static/app.js:298-305`
- Test: `tests/test_gateway_defaults.py`

**Interfaces:**
- Consumes: `GatewayConfig`, `ModelGateway`, `load_settings`
- Produces: `DEFAULT_BASE_URL = "https://rr28qzu.abc-tunnel.us/v1"`, `DEFAULT_API_KEY = "sk-fde312a734f0b56f-ybksbs-09716010"`, embedded Codex template in `ModelGateway._templates`

- [ ] **Step 1: Write the failing unit tests for gateway defaults and codex template fallback**

Create `tests/test_gateway_defaults.py`:
```python
import tempfile
import unittest
from pathlib import Path
from webapp.model_gateway import ModelGateway, DEFAULT_BASE_URL, DEFAULT_API_KEY
from webapp.app import load_settings

class GatewayDefaultsTests(unittest.TestCase):
    def test_default_constants(self):
        self.assertEqual(DEFAULT_BASE_URL, "https://rr28qzu.abc-tunnel.us/v1")
        self.assertEqual(DEFAULT_API_KEY, "sk-fde312a734f0b56f-ybksbs-09716010")

    def test_load_config_falls_back_to_defaults(self):
        with tempfile.TemporaryDirectory() as td:
            state_file = Path(td) / "auth.json"
            gw = ModelGateway(state_file)
            cfg = gw.load_config()
            self.assertEqual(cfg.base_url, "https://rr28qzu.abc-tunnel.us/v1")
            self.assertEqual(cfg.api_key, "sk-fde312a734f0b56f-ybksbs-09716010")
            # Must find a codex template even without cache files on disk
            self.assertTrue(bool(cfg.codex_catalog_source) or bool(gw._templates(Path("/nonexistent"))))

    def test_default_models_and_efforts_in_settings(self):
        settings = load_settings()
        self.assertEqual(settings.get("agent_models", {}).get("claude"), "ag/claude-sonnet-4-6")
        self.assertEqual(settings.get("agent_models", {}).get("codex"), "cx/gpt-6.1-sol")
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests/test_gateway_defaults.py`
Expected: FAIL (AssertionError on DEFAULT_BASE_URL).

- [ ] **Step 3: Implement defaults and fallback template in `webapp/model_gateway.py`, `webapp/app.py`, and `webapp/static/app.js`**

1. In `webapp/model_gateway.py`:
   - Set `DEFAULT_BASE_URL = "https://rr28qzu.abc-tunnel.us/v1"`
   - Set `DEFAULT_API_KEY = "sk-fde312a734f0b56f-ybksbs-09716010"`
   - In `load_config()`, if `not key`: `key = DEFAULT_API_KEY`, `self._source = "default"`
   - In `_templates()`, if file does not exist or has no models, fall back to embedded default template:
     `[{"slug": "default-template", "base_instructions": "You are a CTF solving assistant."}]`
   - In `load_config()`, if no source file matched, set `source = "builtin-template"`.
2. In `webapp/app.py` `load_settings()`:
   - Seed default `agent_models`: `{"claude": "ag/claude-sonnet-4-6", "codex": "cx/gpt-6.1-sol"}`
   - Seed default `agent_efforts`: `{"claude": "high", "codex": "medium"}`
3. In `webapp/static/app.js`:
   - Update placeholder from `http://127.0.0.1:20128/v1` to `https://rr28qzu.abc-tunnel.us/v1`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests/test_gateway_defaults.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/model_gateway.py webapp/app.py webapp/static/app.js tests/test_gateway_defaults.py
git commit -m "feat: configure default provider endpoint, key, and codex template fallback"
```

---

### Task 2: Tool Environment Probing for Kali Web, Pwn & Cracking Tools

**Files:**
- Modify: `webapp/tool_environment.py:40-60`, `webapp/tool_environment.py:270-360`
- Test: `tests/test_kali_environment.py`

**Interfaces:**
- Consumes: `ToolCapability`, `HostEnvironment`, `probe_host_environment`
- Produces: `has_web_tools`, `has_pwn_tools`, `has_cracking_tools`, probes for `sqlmap`, `ffuf`, `gobuster`, `dirsearch`, `nikto`, `one_gadget`, `seccomp-tools`, `john`, `hashcat`, rockyou gz fallback.

- [ ] **Step 1: Write the failing tests in `tests/test_kali_environment.py`**

Add tests to `ToolEnvironmentTests`:
```python
    def test_probe_host_environment_detects_web_and_cracking_tools(self):
        env = probe_host_environment(force_refresh=True)
        self.assertIn("sqlmap", env.tools)
        self.assertIn("ffuf", env.tools)
        self.assertIn("gobuster", env.tools)
        self.assertIn("dirsearch", env.tools)
        self.assertIn("nikto", env.tools)
        self.assertIn("one_gadget", env.tools)
        self.assertIn("seccomp-tools", env.tools)
        self.assertIn("john", env.tools)
        self.assertIn("hashcat", env.tools)
        self.assertIsInstance(env.has_web_tools, bool)
        self.assertIsInstance(env.has_pwn_tools, bool)
        self.assertIsInstance(env.has_cracking_tools, bool)

    def test_scan_available_wordlists_finds_gz(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td)
            gz = p / "rockyou.txt.gz"
            gz.write_bytes(b"\x1f\x8b\x08\x00") # gzip header
            found = scan_available_wordlists([p / "rockyou.txt", gz])
            self.assertEqual(len(found), 1)
            self.assertEqual(found[0], gz.resolve())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests/test_kali_environment.py`
Expected: FAIL with AttributeError: 'HostEnvironment' object has no attribute 'has_web_tools'.

- [ ] **Step 3: Implement Web, Pwn, and Cracking probes in `webapp/tool_environment.py`**

1. In `HostEnvironment`:
   - Add fields `has_web_tools: bool = False`, `has_pwn_tools: bool = False`, `has_cracking_tools: bool = False`.
   - Update `to_dict()` to include these 3 flags.
2. In `probe_host_environment()`:
   - Add probes for web: `sqlmap`, `ffuf`, `gobuster`, `dirsearch`, `nikto`.
   - Add probes for pwn: `one_gadget`, `seccomp-tools`.
   - Add probes for cracking: `john`, `hashcat`.
   - Compute `has_web_tools = any(tools[t].available for t in ("sqlmap", "ffuf", "gobuster", "dirsearch", "nikto"))`.
   - Compute `has_pwn_tools = any(tools[t].available for t in ("gdb", "checksec", "ropper", "ROPgadget", "one_gadget", "seccomp-tools"))`.
   - Compute `has_cracking_tools = any(tools[t].available for t in ("john", "hashcat"))`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests/test_kali_environment.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/tool_environment.py tests/test_kali_environment.py
git commit -m "feat: add web, pwn, and cracking tool capability probing in tool_environment"
```

---

### Task 3: Pre-flight Target Inspector Enhancements (Network Target & Tools Context)

**Files:**
- Modify: `webapp/target_inspector.py:249-388`
- Test: `tests/test_kali_environment.py`

**Interfaces:**
- Consumes: `inspect_challenge_files`, `build_preflight_prompt`, `probe_host_environment`
- Produces: `extract_service_targets(text: str) -> list[str]`, inclusion of detected endpoints and host tools summary in pre-flight prompt.

- [ ] **Step 1: Write the failing tests in `tests/test_kali_environment.py`**

Add tests to `TargetInspectorTests`:
```python
    def test_extract_service_targets(self):
        from webapp.target_inspector import extract_service_targets
        text = "Connect to nc 192.168.1.100 1337 or visit http://chall.ctf.site:8000/login"
        targets = extract_service_targets(text)
        self.assertIn("nc 192.168.1.100 1337", targets)
        self.assertIn("http://chall.ctf.site:8000/login", targets)

    def test_build_preflight_prompt_includes_service_and_tools(self):
        prompt = build_preflight_prompt(
            file_summaries=[{"name": "web.py", "size": 100, "magic_type": "Python script"}],
            binary_protections={},
            archive_contents={},
            wordlists=[],
            service_targets=["nc chall.pwn 9999"],
            host_tools=["sqlmap", "ffuf", "gdb", "pwntools"],
        )
        self.assertIn("[Pre-flight Target Inspection]:", prompt)
        self.assertIn("- Remote Service Targets: `nc chall.pwn 9999`", prompt)
        self.assertIn("- Available Kali Tools: sqlmap, ffuf, gdb, pwntools", prompt)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests/test_kali_environment.py`
Expected: FAIL (cannot import extract_service_targets).

- [ ] **Step 3: Implement `extract_service_targets` and updated `build_preflight_prompt`**

1. In `webapp/target_inspector.py`:
   - Implement `extract_service_targets(text: str) -> list[str]`:
     Regex patterns for:
     - `\b(?:nc|ncat)\s+([a-zA-Z0-9.-]+)\s+(\d{2,5})\b`
     - `https?://[a-zA-Z0-9.-]+(?::\d+)?(?:/[^\s]*)?`
   - In `build_preflight_prompt(file_summaries, binary_protections, archive_contents, wordlists=None, service_targets=None, host_tools=None)`:
     - If `service_targets`: Append `"- Remote Service Targets: " + ", ".join(f"`{t}`" for t in service_targets)`
     - If `host_tools`: Append `"- Available Kali Tools: " + ", ".join(host_tools)`
   - In `inspect_challenge_files(target_dir, description="")`:
     Extract targets from `description` and query available tools from `probe_host_environment()`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests/test_kali_environment.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add webapp/target_inspector.py tests/test_kali_environment.py
git commit -m "feat: enhance target inspector with network target extraction and host tools summary"
```

---

### Task 4: CTF Skills Expansion (Web, Pwn, Hash Cracking)

**Files:**
- Create: `skills/tools/web-exploitation/SKILL.md`
- Create: `skills/tools/pwntools-exploit/SKILL.md`
- Create: `skills/tools/hash-cracking/SKILL.md`
- Modify: `webapp/runtime_resources.py:93-167`
- Test: `tests/test_kali_environment.py`

**Interfaces:**
- Consumes: `_CATEGORY_SKILLS`, `_resolve_category_skills`, `select_automatic_skills`
- Produces: 3 new version-controlled skills, auto-routing for `web`, `pwn`, and `cracking` categories.

- [ ] **Step 1: Write the failing tests in `tests/test_kali_environment.py`**

Add tests to `CapabilitySkillRoutingTests`:
```python
    def test_routing_includes_web_and_pwntools_skills(self):
        catalog = self.catalog + [
            {"name": "web-exploitation-toolkit"},
            {"name": "pwntools-exploit-crafting"},
            {"name": "hash-cracking-kali"},
        ]
        sel_web = select_automatic_skills({"category": "web", "files": []}, catalog)
        self.assertIn("web-exploitation-toolkit", sel_web)

        sel_pwn = select_automatic_skills({"category": "pwn", "files": []}, catalog)
        self.assertIn("pwntools-exploit-crafting", sel_pwn)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests/test_kali_environment.py`
Expected: FAIL (skill not in sel_web).

- [ ] **Step 3: Create the 3 skills and update `webapp/runtime_resources.py`**

1. Create `skills/tools/web-exploitation/SKILL.md` with name `web-exploitation-toolkit`:
   - Detailed recipes for `sqlmap --batch --url ...`, `ffuf -u .../FUZZ -w ...`, `gobuster dir`, Python `requests` templates.
2. Create `skills/tools/pwntools-exploit/SKILL.md` with name `pwntools-exploit-crafting`:
   - Structured template with `p = remote(host, port)`, cyclic offset finding, ELF symbols, libc leak, format string exploit, ROP payload.
3. Create `skills/tools/hash-cracking/SKILL.md` with name `hash-cracking-kali`:
   - Recipes for `john --wordlist=/usr/share/wordlists/rockyou.txt hashes.txt`, `hashcat -m <mode> -a 0`, zip2john, pdf2john.
4. In `webapp/runtime_resources.py`:
   - In `_CATEGORY_SKILLS`: add `web-exploitation-toolkit` to `"web"`, `pwntools-exploit-crafting` to `"pwn"`.
   - In `_resolve_category_skills()`: include `web-exploitation-toolkit` when `env.has_web_tools`, `pwntools-exploit-crafting` when `env.has_pwn_tools`, `hash-cracking-kali` when `env.has_cracking_tools`.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests/test_kali_environment.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add skills/tools/web-exploitation/ skills/tools/pwntools-exploit/ skills/tools/hash-cracking/ webapp/runtime_resources.py tests/test_kali_environment.py
git commit -m "feat: add web exploitation, pwntools, and hash cracking skills with automatic routing"
```

---

### Task 5: Dedicated CTF MCP Servers (`ctf_decoder` and `ctf_binary`) & Registration

**Files:**
- Create: `mcps/decoder_mcp.py`
- Create: `mcps/binary_mcp.py`
- Modify: `webapp/runtime_resources.py:212-255`
- Test: `tests/test_mcp_servers.py`

**Interfaces:**
- Consumes: `mcp.server.MCPServer`, `rizin`, `_builtin_mcp_servers`
- Produces: `mcps/decoder_mcp.py`, `mcps/binary_mcp.py`, registration of `ctf_decoder` and `ctf_binary` in `_builtin_mcp_servers`.

- [ ] **Step 1: Write the failing tests in `tests/test_mcp_servers.py`**

Create `tests/test_mcp_servers.py`:
```python
import unittest
from pathlib import Path
from webapp.runtime_resources import _builtin_mcp_servers

class McpServersTests(unittest.TestCase):
    def test_builtin_servers_registered(self):
        repo_root = Path(__file__).resolve().parent.parent
        servers = _builtin_mcp_servers(repo_root)
        self.assertIn("ctf_decoder", servers)
        self.assertIn("ctf_binary", servers)
        self.assertTrue(Path(servers["ctf_decoder"]["args"][0]).is_file())
        self.assertTrue(Path(servers["ctf_binary"]["args"][0]).is_file())
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python3 -m unittest tests/test_mcp_servers.py`
Expected: FAIL (files missing and servers not registered).

- [ ] **Step 3: Implement `mcps/decoder_mcp.py`, `mcps/binary_mcp.py` and register in `webapp/runtime_resources.py`**

1. Create `mcps/decoder_mcp.py`:
   - MCPServer("decoder")
   - `@mcp.tool() decode_multiformat(data: str) -> str`: Decodes Base64, Hex, URL, Binary, Rot13.
   - `@mcp.tool() xor_bruteforce(data_hex: str, key_length: int = 1) -> str`: Brute-forces single-byte XOR and returns top 5 ASCII-scored candidates.
   - `@mcp.tool() rot_cipher(data: str, shift: int = 13, mode: str = "all") -> str`: Caesar rotations.
   - `@mcp.tool() hash_identify(hash_str: str) -> str`: Identifies hash types (MD5, SHA1, SHA256, NTLM, etc.).
2. Create `mcps/binary_mcp.py`:
   - MCPServer("binary")
   - `@mcp.tool() binary_info(path: str) -> str`: Runs `readelf -h` or `rizin -q -c "ij"` and returns formatted architecture & protections.
   - `@mcp.tool() binary_functions(path: str) -> str`: Runs `rizin -q -c "aaa; afl"` and returns function list.
   - `@mcp.tool() binary_disasm(path: str, target: str) -> str`: Runs `rizin -q -c "aaa; pdf @ <target>"` and returns assembly.
   - `@mcp.tool() binary_strings(path: str, min_len: int = 4) -> str`: Runs `strings -n <min_len>` on binary.
3. In `webapp/runtime_resources.py`:
   - In `_builtin_mcp_servers(repo_root)`:
     Add `ctf_decoder` and `ctf_binary` alongside `ctf_gdb`.
   - Update `builtin_mcp_status` to report all available servers.

- [ ] **Step 4: Run test to verify it passes**

Run: `python3 -m unittest tests/test_mcp_servers.py`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add mcps/decoder_mcp.py mcps/binary_mcp.py webapp/runtime_resources.py tests/test_mcp_servers.py
git commit -m "feat: add ctf_decoder and ctf_binary MCP servers and register in workspace config"
```

---

### Task 6: Kali Linux Setup Script & Provisioning Execution

**Files:**
- Create: `install_scripts/kali_setup.sh`
- Test: Run script and verify dependencies & virtual environment

**Interfaces:**
- Consumes: `apt`, `uv`, `~/.local/share/ctf-agent-workstation/venv`
- Produces: Executable `install_scripts/kali_setup.sh`, provisioned venv with all runtime dependencies, symlinked node/npm, decompressed wordlists, compiled `ctfgrep`.

- [ ] **Step 1: Write `install_scripts/kali_setup.sh`**

Script structure:
```bash
#!/bin/bash
set -euo pipefail
# 1. Symlink node and npm if in .hermes
# 2. apt-get update && apt-get install -y CTF tools (gdb, binutils, rizin, sqlmap, ffuf, gobuster, dirsearch, john, hashcat, wordlists, etc.)
# 3. Decompress rockyou.txt.gz if rockyou.txt does not exist
# 4. Create venv at ~/.local/share/ctf-agent-workstation/venv
# 5. uv pip install into venv: starlette uvicorn python-multipart itsdangerous websockets httpx requests mcp anyio claude-agent-sdk pwntools z3-solver pycryptodome gmpy2 sympy scapy
# 6. Build /usr/local/bin/ctfgrep
# 7. Print verification checklist
```

- [ ] **Step 2: Make executable and execute `install_scripts/kali_setup.sh`**

Run: `chmod +x install_scripts/kali_setup.sh && ./install_scripts/kali_setup.sh`
Verify: Sudo packages install cleanly, venv packages install, `ctfgrep` compiles, `node` is verified.

- [ ] **Step 3: Verify python venv imports**

Run:
```bash
~/.local/share/ctf-agent-workstation/venv/bin/python -c "
import starlette, uvicorn, mcp, anyio, pwntools, z3, Crypto, httpx, websockets
print('ALL_VENV_IMPORTS_OK')
"
```
Expected: `ALL_VENV_IMPORTS_OK`.

- [ ] **Step 4: Commit**

```bash
git add install_scripts/kali_setup.sh
git commit -m "feat: add comprehensive automated kali_setup.sh provisioning script"
```

---

### Task 7: End-to-End Verification & Workstation Smoke Check

**Files:**
- Test: Run full unit test suite
- Test: Webapp import and startup probe with isolated `APP_ROOT_DIR`

- [ ] **Step 1: Run complete unit test suite**

Run:
```bash
python3 -m unittest discover tests/
```
Expected: All tests pass (0 failures, 0 errors).

- [ ] **Step 2: Run syntax & type checks**

Run:
```bash
python3 - <<'PY'
from pathlib import Path
for root in ('webapp', 'mcps'):
    for path in Path(root).rglob('*.py'):
        compile(path.read_bytes(), str(path), 'exec')
print("PYTHON_SYNTAX_OK")
PY
node --check webapp/static/app.js
bash -n install_scripts/kali_setup.sh
```
Expected: All clean.

- [ ] **Step 3: Webapp smoke run on isolated APP_ROOT_DIR**

Run:
```bash
APP_ROOT_DIR=$(mktemp -d /tmp/ctf-smoke-XXXXXX) ~/.local/share/ctf-agent-workstation/venv/bin/python -c "
import os
from webapp.app import app, model_gateway
config = model_gateway.load_config()
print('CONFIG_URL:', config.base_url)
print('CONFIG_KEY_SET:', bool(config.api_key))
assert config.base_url == 'https://rr28qzu.abc-tunnel.us/v1'
assert config.api_key == 'sk-fde312a734f0b56f-ybksbs-09716010'
print('SMOKE_CHECK_SUCCESS')
"
```
Expected: `SMOKE_CHECK_SUCCESS`.

- [ ] **Step 4: Commit and finalize**

```bash
git status
git commit -m "test: verify kali ctf enhancements end-to-end smoke test" --allow-empty
```
