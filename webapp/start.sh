#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if [ "$(id -u)" -eq 0 ]; then
  DEFAULT_ROOT="/root/ctf-agent-wrapper"
else
  DEFAULT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ctf-agent-workstation/data"
fi
export APP_ROOT_DIR="${APP_ROOT_DIR:-$DEFAULT_ROOT}"

PYTHON_BIN="${XDG_DATA_HOME:-$HOME/.local/share}/ctf-agent-workstation/venv/bin/python"
if [ ! -x "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi
VENV_BIN="${XDG_DATA_HOME:-$HOME/.local/share}/ctf-agent-workstation/venv/bin"
RUBY_GEM_BIN=""
if command -v ruby >/dev/null 2>&1; then
  GEM_DIR="$(ruby -e 'puts Gem.user_dir' 2>/dev/null || true)"
  if [ -n "$GEM_DIR" ]; then
    RUBY_GEM_BIN="$GEM_DIR/bin:"
  fi
fi
export PATH="$HOME/.local/bin:$VENV_BIN:${RUBY_GEM_BIN}${PATH}"


printf 'CTF Solver: http://127.0.0.1:8000 (no login)\n'
exec "$PYTHON_BIN" "$SCRIPT_DIR/app.py"
