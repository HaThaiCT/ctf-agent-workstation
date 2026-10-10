# Specification: Kali Linux CTF Workstation Enhancements & Default Provider Configuration

**Date:** 2026-10-10  
**Status:** Draft  
**Target Environment:** Kali Linux Rolling 2026.1 (x86_64), Python 3.12+, Claude Code 2.1.286, Codex CLI 0.162.0.

---

## 1. Background & Problem Statement

The CTF Agent Workstation is deployed on a Kali Linux Rolling system. The user requires:
1. Default provider configuration pointing to API endpoint `https://rr28qzu.abc-tunnel.us/v1` with API key `sk-fde312a734f0b56f-ybksbs-09716010`.
2. Verifying and activating settings for provider, model, and effort out-of-the-box.
3. Leveraging Kali Linux's extensive CTF tool ecosystem (Web, Pwn, Reverse, Crypto, Forensics, Cracking) to solve challenges effectively.
4. Seamless installation and execution on this machine.

### Key Gaps Identified in Current Codebase:
1. **Model Gateway hardcoded defaults**: `webapp/model_gateway.py` hardcodes `DEFAULT_BASE_URL = "http://127.0.0.1:20128/v1"` with no fallback API key.
2. **Codex model catalog dependency**: `model_gateway.py` requires an external file `~/.codex/models_cache.json` or `codex-models.json`. On this machine, neither exists, causing Codex to fail with *"Codex model metadata is unavailable"*.
3. **Web CTF capability gap**: Despite Kali having industry-standard Web CTF tools (`sqlmap`, `ffuf`, `gobuster`, `dirsearch`, `nikto`), `webapp/tool_environment.py` does not probe them, `webapp/target_inspector.py` does not detect web service targets, and there is no dedicated Web exploitation skill in `skills/`.
4. **Pwn & Cracking tooling gap**: Missing probes and skills for standard binary exploitation (`pwntools`, `one_gadget`, `seccomp-tools`) and hash cracking (`john`, `hashcat`, compressed `rockyou.txt.gz`).
5. **Workstation installation on Kali**: Webapp Python virtual environment is not yet created, `node` is not in standard PATH, and `install_scripts/run.sh` lacks a unified Kali installer.

---

## 2. Architecture & Design

### Component 1: Default Provider, Model & Effort Configuration
- **File**: `webapp/model_gateway.py`
  - Update `DEFAULT_BASE_URL` to `"https://rr28qzu.abc-tunnel.us/v1"`.
  - Add `DEFAULT_API_KEY = "sk-fde312a734f0b56f-ybksbs-09716010"`.
  - In `load_config()`: If no API key is in `agent-env-auth.json` or `NINEROUTER_API_KEY`, fall back to `DEFAULT_API_KEY`.
  - Provide a fallback template in `ModelGateway._templates()`: When no template file exists on disk, use an embedded template dictionary (supporting standard instruction and slug format) so Codex native launcher works immediately.
- **File**: `webapp/app.py`
  - In `load_settings()`, establish sensible defaults for `agent_models` (`{"claude": "ag/claude-sonnet-4-6", "codex": "cx/gpt-6.1-sol"}`) and `agent_efforts` (`{"claude": "high", "codex": "medium"}`).
- **File**: `webapp/static/app.js`
  - Update Gateway URL input placeholder from `http://127.0.0.1:20128/v1` to `https://rr28qzu.abc-tunnel.us/v1`.

### Component 2: Tool Environment Probing (`webapp/tool_environment.py`)
Extend `HostEnvironment` and `probe_host_environment()`:
- **Web Tools Probing**:
  - `sqlmap`: `["sqlmap", "/usr/bin/sqlmap"]` (`--version`)
  - `ffuf`: `["ffuf", "/usr/bin/ffuf"]` (`-V`)
  - `gobuster`: `["gobuster", "/usr/bin/gobuster"]` (`version`)
  - `dirsearch`: `["dirsearch", "/usr/bin/dirsearch"]` (`--version`)
  - `nikto`: `["nikto", "/usr/bin/nikto"]` (`-Version`)
  - `has_web_tools`: Boolean flag when at least one web fuzzer/scanner is present.
- **Pwn Tools Probing**:
  - `one_gadget`: `["one_gadget", "/usr/bin/one_gadget"]` (`--version`)
  - `seccomp-tools`: `["seccomp-tools", "/usr/bin/seccomp-tools"]` (`--version`)
  - `has_pwn_tools`: Boolean flag when gdb, checksec, or pwntools are available.
- **Password & Hash Cracking Probing**:
  - `john`: `["john", "/usr/bin/john"]`
  - `hashcat`: `["hashcat", "/usr/bin/hashcat"]` (`--version`)
  - `has_cracking_tools`: Boolean flag.
- **Wordlists Auto-handling**:
  - Check `/usr/share/wordlists/rockyou.txt`. If missing but `/usr/share/wordlists/rockyou.txt.gz` exists, recognize the gz file and allow runtime access or transparent decompression.

### Component 3: Target Inspector Enhancements (`webapp/target_inspector.py`)
- **Remote Target & Service Extraction**:
  - Parse challenge text/description for network targets:
    - Netcat commands (`nc <host> <port>` or `ncat <host> <port>`)
    - Web URLs (`http://...`, `https://...`)
    - IP addresses and port pairs (`<ip>:<port>`)
  - Include detected service endpoints in `[Pre-flight Target Inspection]`.
- **Host Tools Summary in Pre-flight Prompt**:
  - In `build_preflight_prompt()`, append a concise section listing available Kali tools:
    `"- Available Kali Tools: sqlmap, ffuf, ghidra, rizin, gdb (GEF), pwntools, sage, john, hashcat."`
  - This informs LLM agents upfront of exactly which capabilities they can leverage without trial-and-error.

### Component 4: Skills Catalog Expansion
Add three version-controlled skills in `skills/tools/`:
1. `skills/tools/web-exploitation/SKILL.md` (`web-exploitation-toolkit`):
   - Fast workflows for `sqlmap`, `ffuf` (directory & parameter fuzzing), `gobuster`, `curl`/`requests` python scripts, and common web vulnerability exploits.
2. `skills/tools/pwntools-exploit/SKILL.md` (`pwntools-exploit-crafting`):
   - Structured methodology for binary exploitation: checksec review, crash offset calculation (`cyclic`), gadget searching (`ROPgadget`/`ropper`), libc leak calculation, and interactive/remote exploit templates.
3. `skills/tools/hash-cracking/SKILL.md` (`hash-cracking-kali`):
   - Workflows for `john` (zip2john, pdf2john, ssh2john, keepass2john), `hashcat` common hash modes (MD5, SHA1, NTLM, bcrypt, etc.), and `rockyou.txt` dictionary attacks.

Update `webapp/runtime_resources.py`:
- In `_resolve_category_skills(category, env)`:
  - If `category == "web"`, include `web-exploitation-toolkit`.
  - If `category == "pwn"`, include `pwntools-exploit-crafting` and `craft-rop-chains-with-angrop`.
  - If `category in ("forensics", "crypto", "misc")` and challenge involves hashes/archives, include `hash-cracking-kali`.

### Component 5: CTF Model Context Protocol (MCP) Expansion
In addition to the existing `ctf_gdb` server (`mcps/gdb_mcp.py`), provide dedicated stdio MCP servers in `mcps/` to give agents structured tool calls for repetitive CTF tasks:

1. **Activation of `ctf_gdb`**:
   - Install `mcp` and `anyio` into the Python virtual environment alongside `gdb` via apt. This activates `ctf_gdb` automatically for Claude Code and Codex.
2. **New `ctf_decoder` MCP Server (`mcps/decoder_mcp.py`)**:
   - `decode_multiformat(data)`: Detects and decodes Base64, Base32, Base85, Hex, URL, HTML, Binary.
   - `xor_bruteforce(data_hex, key_length=1)`: Brute-forces single-byte XOR keys and scores candidate outputs using ASCII frequency and flag regex.
   - `rot_cipher(data, shift=13, mode="all")`: Solves Caesar / ROT rotations.
   - `hash_identify(hash_str)`: Identifies hash type, bit length, and known format hints.
3. **New `ctf_binary` MCP Server (`mcps/binary_mcp.py`)**:
   - `binary_info(path)`: Binary architecture, endianness, bitness, and checksec protections.
   - `binary_functions(path)`: Lists functions, entry points, and addresses using `rizin -q -c "aaa; aflj"`.
   - `binary_disasm(path, target)`: Disassembles requested function or address via `rizin -q -c "aaa; pdf @ <target>"`.
   - `binary_strings(path, min_len=4)`: Extracts printable strings from binary.
4. **Registration in `webapp/runtime_resources.py`**:
   - Extend `_builtin_mcp_servers()` to register `ctf_gdb`, `ctf_decoder`, and `ctf_binary`.
   - Materialize these servers in each run's `.ctf-mcp.json` so Claude Code and Codex automatically load them.

### Component 6: Kali Workstation Provisioning Script (`install_scripts/kali_setup.sh`)
Create an idempotent, robust setup script specifically for Kali Linux:
1. Ensure `node` and `npm` symlinks exist at `/usr/local/bin/node` and `~/.local/bin/node`.
2. Install Kali CTF apt packages:
   `build-essential gdb ltrace strace binutils rizin radare2 ghidra sqlmap ffuf gobuster dirsearch john hashcat tshark binwalk foremost steghide ruby-dev wordlists python3-pwntools python3-venv python3-pip jq ripgrep tmux`.
3. Auto-decompress `/usr/share/wordlists/rockyou.txt.gz` if `/usr/share/wordlists/rockyou.txt` does not exist.
4. Set up Python virtual environment at `~/.local/share/ctf-agent-workstation/venv` using `uv venv`.
5. Install webapp dependencies into the venv:
   `starlette uvicorn python-multipart itsdangerous websockets httpx requests mcp anyio claude-agent-sdk pwntools z3-solver pycryptodome gmpy2 sympy scapy`.
6. Compile `ctfgrep` at `/usr/local/bin/ctfgrep`.
7. Verify installation and print readiness summary.
## 3. Verification & Testing Plan

1. **Unit Tests**:
   - Update `tests/test_kali_environment.py` to cover:
     - Web tools probing (`sqlmap`, `ffuf`, `has_web_tools`).
     - Cracking tools probing (`john`, `hashcat`, `has_cracking_tools`).
     - Pre-flight prompt inclusion of detected service endpoints and host tool summary.
     - Skill routing for `web` and `pwn` categories with new skills.
   - Run unit test suite: `python3 -m unittest tests/test_kali_environment.py`.
2. **Provider & Gateway Integration Smoke Check**:
   - Run isolated probe with `ModelGateway`:
     - Verify default config loads endpoint `https://rr28qzu.abc-tunnel.us/v1` and key `sk-fde312a734f0b56f-ybksbs-09716010`.
     - Fetch model catalog and assert models (`cx/gpt-6.1-sol`, `ag/claude-sonnet-4-6`) are returned.
     - Verify Codex model catalog generation works without requiring external cache files.
3. **Webapp Startup Smoke Check**:
   - Run `python3 -c "import webapp.app"` with an isolated `APP_ROOT_DIR` to verify imports, routes, and startup without exceptions.
   - Verify syntax checks: `python3 -m py_compile webapp/*.py` and `node --check webapp/static/app.js`.
