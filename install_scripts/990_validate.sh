#!/bin/bash
# Validate that the provisioned CTF workstation has critical tools installed.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=install_scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"
APP_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

if [ -n "${PYTHON_BIN:-}" ]; then
  if [ ! -x "$PYTHON_BIN" ]; then
    warn "Specified PYTHON_BIN not found or not executable: $PYTHON_BIN"
    exit 1
  fi
else
  LAUNCHER_VENV="${XDG_DATA_HOME:-$HOME/.local/share}/ctf-agent-workstation/venv/bin/python"
  if [ -x "$LAUNCHER_VENV" ]; then
    PYTHON_BIN="$LAUNCHER_VENV"
  else
    PYTHON_BIN="python3"
  fi
fi

VENV_BIN="$(dirname "$PYTHON_BIN")"
RUBY_GEM_BIN=""
if have_cmd ruby; then
  GEM_DIR="$(ruby -e 'puts Gem.user_dir' 2>/dev/null || true)"
  if [ -n "$GEM_DIR" ] && [ -d "$GEM_DIR/bin" ]; then
    RUBY_GEM_BIN="$GEM_DIR/bin:"
  fi
fi
export PATH="$HOME/.local/bin:$VENV_BIN:${RUBY_GEM_BIN}${PATH}"

failures=0
failure_messages=()
VALIDATE_TIMEOUT_SECONDS="${VALIDATE_TIMEOUT_SECONDS:-60}"

record_failure() {
  local msg="$1"
  warn "$msg"
  failure_messages+=("$msg")
  failures=$((failures + 1))
}

with_validation_timeout() {
  timeout "${VALIDATE_TIMEOUT_SECONDS}s" "$@"
}

check_cmd() {
  local name="$1"
  shift || true
  if have_cmd "$name"; then
    if [ "$#" -gt 0 ]; then
      if with_validation_timeout "$@" >/dev/null 2>&1; then
        log "OK command: $name"
      else
        record_failure "Command validation failed or timed out: $*"
      fi
    else
      log "OK command: $name"
    fi
  else
    record_failure "Missing command: $name"
  fi
}

check_path() {
  local path="$1"
  if [ -e "$path" ]; then
    log "OK path: $path"
  else
    record_failure "Missing path: $path"
  fi
}

check_py_import() {
  local module="$1"
  if with_validation_timeout "$PYTHON_BIN" -c "import ${module}" >/dev/null 2>&1; then
    log "OK python import: $module"
  else
    record_failure "Missing python import: $module"
  fi
}

check_py_optional_import() {
  local module="$1"
  if with_validation_timeout "$PYTHON_BIN" -c "import ${module}" >/dev/null 2>&1; then
    log "OK optional python import: $module"
  else
    warn "Optional capability not installed: $module"
  fi
}

IS_KALI=0
if [ -f /etc/os-release ] && grep -q '^ID=kali' /etc/os-release 2>/dev/null; then
  IS_KALI=1
fi

if [ "$IS_KALI" -eq 1 ]; then
  check_cmd python3 "$PYTHON_BIN" --version
  check_cmd node node --version
  check_cmd npm npm --version
  check_cmd uv uv --version
  check_cmd gdb gdb --version
  check_cmd readelf readelf -v
  check_cmd strings strings -v
  check_cmd rizin rizin -v
  check_cmd radare2 radare2 -v
  check_cmd ctfgrep ctfgrep -h
  check_cmd sqlmap sqlmap --version
  check_cmd ffuf ffuf -V
  check_cmd gobuster gobuster --version
  check_cmd dirsearch dirsearch -h
  check_cmd nikto nikto -Version
  check_cmd tshark tshark --version
  check_cmd tcpflow tcpflow -h
  check_cmd binwalk binwalk -h
  check_cmd foremost foremost -V
  check_cmd exiftool exiftool -ver
  check_cmd steghide steghide --version
  check_cmd pngcheck pngcheck -h
  check_cmd mmls mmls -V
  check_cmd bulk_extractor bulk_extractor -V
  check_cmd one_gadget one_gadget --version
  check_cmd seccomp-tools seccomp-tools --version
  check_cmd zsteg zsteg --help
  check_cmd claude claude --version
  check_cmd codex codex --version

  if have_cmd ghidra || [ -x /usr/share/ghidra/support/analyzeHeadless ]; then
    log "OK headless ghidra"
  else
    record_failure "Missing ghidra or analyzeHeadless"
  fi

  check_py_import starlette
  check_py_import uvicorn
  check_py_import multipart
  check_py_import itsdangerous
  check_py_import httpx
  check_py_import requests
  check_py_import websockets
  check_py_import claude_agent_sdk
  check_py_import google.auth
  check_py_import pwn
  check_py_import Crypto
  check_py_import z3
  check_py_import gmpy2
  check_py_import sympy
  check_py_import angr
  check_py_import angrop
  check_py_import unicorn
  check_py_import ropper
  check_py_import scapy
  check_py_import volatility3
  check_py_import oletools
  check_py_import mcp
  check_py_import anyio
else
  check_cmd python3 "$PYTHON_BIN" --version
  check_cmd node node --version
  check_cmd npm npm --version
  check_cmd uv uv --version
  check_cmd gdb gdb --version
  check_cmd rg rg --version
  check_cmd ctfgrep ctfgrep -h
  check_cmd rtk rtk --version
  check_cmd docker docker --version

  check_cmd claude claude --version
  check_cmd codex codex --version

  check_cmd apktool apktool --version
  check_cmd jadx jadx --version
  check_cmd sage sage --version
  check_cmd mquire mquire --version
  check_cmd bulk_extractor bulk_extractor -h
  check_cmd tshark tshark --version
  check_cmd vol vol --help

  check_py_import starlette
  check_py_import uvicorn
  check_py_import multipart
  check_py_import itsdangerous
  check_py_import httpx
  check_py_import requests
  check_py_import websockets
  check_py_import claude_agent_sdk
  check_py_import mcp
  check_py_import pwn
  check_py_import angr
  check_py_import angrop
  check_py_import volatility3
  check_py_import scapy
  check_py_import pytsk3
  check_py_import oletools
fi

check_py_optional_import idapro
check_py_optional_import ida_domain
if [ "$failures" -ne 0 ]; then
  warn "Environment validation failed with $failures missing requirement(s):"
  for msg in "${failure_messages[@]}"; do
    warn "  - $msg"
  done
  exit 1
fi

log "Environment validation completed successfully."
