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

printf 'CTF Solver: http://127.0.0.1:8000 (no login)\n'
exec "$PYTHON_BIN" "$SCRIPT_DIR/app.py"
