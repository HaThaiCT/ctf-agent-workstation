#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Runtime user & privilege handling
if [ "$(id -u)" -eq 0 ]; then
  if [ -n "${SUDO_USER:-}" ] && [ "$SUDO_USER" != "root" ]; then
    exec sudo -u "$SUDO_USER" -H bash "$0" "$@"
  fi
  RUNTIME_USER="root"
  DEFAULT_ROOT="/root/ctf-agent-wrapper"
else
  RUNTIME_USER="$(id -un)"
  DEFAULT_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/ctf-agent-workstation/data"
fi

export APP_ROOT_DIR="${APP_ROOT_DIR:-$DEFAULT_ROOT}"

# Require passwordless sudo for nonroot APT operations
if [ "$(id -u)" -ne 0 ]; then
  if ! sudo -n true 2>/dev/null; then
    echo "ERROR: Passwordless sudo is required for APT package installation." >&2
    exit 1
  fi
fi

# User lock root
USER_LOCK_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/ctf-agent-workstation/locks"
mkdir -p "$USER_LOCK_ROOT"
export CTF_AGENT_LOCK_ROOT="$USER_LOCK_ROOT"

# shellcheck source=install_scripts/lib/common.sh
source "$SCRIPT_DIR/lib/common.sh"

log "Starting Kali CTF Workstation provisioning for user $RUNTIME_USER..."

# APT candidates check and installation
log "Updating APT package lists..."
sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq

APT_PACKAGES=(
  build-essential binutils file gdb checksec ltrace strace rizin radare2 ghidra
  sqlmap ffuf gobuster dirsearch nikto dirb tshark tcpflow binwalk foremost
  libimage-exiftool-perl steghide pngcheck sleuthkit bulk-extractor jq ripgrep
  unzip ca-certificates ruby ruby-dev python3-venv
)

# Handle p7zip-full vs 7zip in Kali rolling
CAND_P7ZIP=$(apt-cache policy p7zip-full 2>/dev/null | awk '/Candidate:/ {print $2}')
if [ -n "$CAND_P7ZIP" ] && [ "$CAND_P7ZIP" != "(none)" ]; then
  APT_PACKAGES+=(p7zip-full)
else
  CAND_7ZIP=$(apt-cache policy 7zip 2>/dev/null | awk '/Candidate:/ {print $2}')
  if [ -n "$CAND_7ZIP" ] && [ "$CAND_7ZIP" != "(none)" ]; then
    APT_PACKAGES+=(7zip)
  else
    warn "Candidate missing for 7zip/p7zip-full archiver package"
    exit 1
  fi
fi

log "Verifying APT candidates..."
for pkg in "${APT_PACKAGES[@]}"; do
  cand=$(apt-cache policy "$pkg" 2>/dev/null | awk '/Candidate:/ {print $2}')
  if [ -z "$cand" ] || [ "$cand" = "(none)" ]; then
    warn "APT package missing candidate: $pkg"
    exit 1
  fi
done

# Non-interactive wireshark configuration
echo "wireshark-common wireshark-common/install-setuid boolean false" | sudo debconf-set-selections

log "Installing required APT packages..."
sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y "${APT_PACKAGES[@]}"

if ! have_cmd node; then
  log "Installing nodejs..."
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
fi
if ! have_cmd npm; then
  log "Installing npm..."
  sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y npm
fi

# Ensure uv is installed for runtime user
if ! have_cmd uv; then
  log "Installing uv for $RUNTIME_USER..."
  curl -fsSL https://astral.sh/uv/install.sh | bash
  export PATH="$HOME/.local/bin:$PATH"
fi

# Canonical venv path
VENV="${XDG_DATA_HOME:-$HOME/.local/share}/ctf-agent-workstation/venv"

# Check for running processes before any venv migration
log "Checking for running processes using application venv..."
for pid_dir in /proc/[0-9]*; do
  [ -d "$pid_dir" ] || continue
  pid=$(basename "$pid_dir")
  proc_user=$(stat -c '%U' "$pid_dir" 2>/dev/null || true)
  [ "$proc_user" = "$RUNTIME_USER" ] || continue

  cmdline=$(cat "$pid_dir/cmdline" 2>/dev/null | tr '\0' ' ' || true)
  environ=$(cat "$pid_dir/environ" 2>/dev/null | tr '\0' '\n' || true)
  virt_env=$(printf '%s\n' "$environ" | grep '^VIRTUAL_ENV=' | cut -d= -f2- || true)

  if printf '%s\n' "$cmdline" | grep -Fq "$VENV" || \
     printf '%s\n' "$cmdline" | grep -Fq "webapp/app.py" || \
     printf '%s\n' "$cmdline" | grep -Fq "webapp.app:app" || \
     [ "$virt_env" = "$VENV" ]; then
    warn "A process (PID $pid: $cmdline) is currently running and using $VENV or webapp. Stop the application before provisioning."
    exit 1
  fi
done
if [ -L "$VENV" ] || { [ -e "$VENV" ] && [ ! -d "$VENV" ]; }; then
  warn "$VENV exists and is a symlink or regular file, not a valid venv directory. Aborting."
  exit 1
fi

REUSE_VENV=0
BACKUP_VENV=""
if [ -d "$VENV" ] && [ -x "$VENV/bin/python" ]; then
  CUR_VER=$("$VENV/bin/python" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null || true)
  if [ "$CUR_VER" = "3.12" ]; then
    REUSE_VENV=1
    log "Existing venv is Python 3.12; reusing."
  else
    TIMESTAMP=$(date +%Y%m%d%H%M%S)
    BACKUP_VENV="${VENV}.pre-kali-${TIMESTAMP}"
    log "Existing venv is Python $CUR_VER; backing up to $BACKUP_VENV."
    mv "$VENV" "$BACKUP_VENV"
  fi
elif [ -d "$VENV" ]; then
  TIMESTAMP=$(date +%Y%m%d%H%M%S)
  BACKUP_VENV="${VENV}.pre-kali-${TIMESTAMP}"
  mv "$VENV" "$BACKUP_VENV"
fi

cleanup_on_failure() {
  local exit_code=$?
  warn "Kali setup failed with exit code $exit_code."
  if [ "$REUSE_VENV" -eq 0 ] && [ -d "$VENV" ]; then
    local FAIL_TIMESTAMP
    FAIL_TIMESTAMP=$(date +%Y%m%d%H%M%S)
    warn "Moving failed venv to ${VENV}.failed-${FAIL_TIMESTAMP} and restoring backup if available."
    mv "$VENV" "${VENV}.failed-${FAIL_TIMESTAMP}"
    if [ -n "$BACKUP_VENV" ] && [ -d "$BACKUP_VENV" ]; then
      mv "$BACKUP_VENV" "$VENV"
    fi
  fi
  exit "$exit_code"
}
trap cleanup_on_failure ERR

if [ "$REUSE_VENV" -eq 0 ]; then
  mkdir -p "$(dirname "$VENV")"
  log "Installing Python 3.12 via uv..."
  uv python install 3.12
  log "Creating Python 3.12 venv at $VENV..."
  uv venv --python 3.12 "$VENV"
fi

log "Installing Python packages in venv..."
uv pip install --python "$VENV/bin/python" \
  starlette uvicorn python-multipart itsdangerous websockets httpx requests \
  claude-agent-sdk google-auth "mcp>=2.3,<3" anyio pwntools ipython pycryptodome \
  sympy z3-solver gmpy2 angr angrop claripy unicorn ropper scapy volatility3 oletools "setuptools<72"

# Ruby user gems
RUBY_GEM_BIN=""
if have_cmd ruby; then
  GEM_DIR="$(ruby -e 'puts Gem.user_dir' 2>/dev/null || true)"
  if [ -n "$GEM_DIR" ]; then
    RUBY_GEM_BIN="$GEM_DIR/bin"
  fi
fi
export PATH="$HOME/.local/bin:$VENV/bin:${RUBY_GEM_BIN:+$RUBY_GEM_BIN:}$PATH"

for gem_cmd in one_gadget seccomp-tools zsteg; do
  if ! have_cmd "$gem_cmd"; then
    log "Installing Ruby gem $gem_cmd (--user-install)..."
    gem install --user-install "$gem_cmd"
  fi
done

# ctfgrep build
mkdir -p "$HOME/.local/bin"
CTFGREP_BIN="$HOME/.local/bin/ctfgrep"
if [ ! -x "$CTFGREP_BIN" ]; then
  log "Compiling ctfgrep to $CTFGREP_BIN..."
  gcc -O2 -pthread -o "$CTFGREP_BIN" "$SCRIPT_DIR/artefacts/ctfgrep.c"
else
  if ! "$CTFGREP_BIN" -h >/dev/null 2>&1; then
    warn "Existing $CTFGREP_BIN failed smoke check; conflict."
    exit 1
  fi
fi

if ! have_cmd codex; then
  log "Installing Codex CLI 0.162.0..."
  npm install --prefix "$HOME/.local" -g @openai/codex@0.162.0
fi

if ! claude --version >/dev/null 2>&1; then
  warn "Prerequisite claude failed version probe."
  exit 1
fi
if ! codex --version >/dev/null 2>&1; then
  warn "Prerequisite codex failed version probe."
  exit 1
fi

# Bootstrap gateway private config
log "Bootstrapping gateway private configuration..."
"$VENV/bin/python" - <<'PY'
import os
import sys
import json
from pathlib import Path
from urllib.parse import urlsplit

repo_root = Path(".").resolve()
sys.path.insert(0, str(repo_root))

from webapp.model_gateway import ModelGateway

app_root = Path(os.environ.get("APP_ROOT_DIR", "/root/ctf-agent-wrapper")).resolve()
cfg_file = app_root / "state" / "agent-env-auth.json"
gateway = ModelGateway(state_file=cfg_file)

if cfg_file.exists():
    try:
        with open(cfg_file, "r", encoding="utf-8") as f:
            existing_data = json.load(f)
    except Exception as e:
        sys.stderr.write(f"ERROR: Existing private auth config at {cfg_file} is malformed: {e}\n")
        sys.exit(1)
    if not isinstance(existing_data, dict):
        sys.stderr.write(f"ERROR: Existing private auth config at {cfg_file} is not a JSON object\n")
        sys.exit(1)

req_url = "https://rr28qzu.abc-tunnel.us/v1"
req_origin = urlsplit(req_url).netloc

token = os.environ.get("NINEROUTER_API_KEY", "").strip()
if not token:
    claude_cfg = Path(os.path.expanduser("~/.claude/settings.json"))
    if claude_cfg.exists():
        try:
            with open(claude_cfg, "r", encoding="utf-8") as f:
                cdata = json.load(f)
            c_env = cdata.get("env", {})
            c_url = c_env.get("ANTHROPIC_BASE_URL", "")
            if urlsplit(c_url).netloc == req_origin:
                candidate = c_env.get("ANTHROPIC_AUTH_TOKEN", "").strip()
                if candidate:
                    token = candidate
        except Exception:
            pass

if token:
    gateway.save_config({"base_url": req_url, "api_key": token})
    print("Gateway bootstrap completed.")
else:
    sys.stderr.write("PREREQUISITE: NINEROUTER_API_KEY is required for gateway bootstrap (or matching ANTHROPIC_BASE_URL in ~/.claude/settings.json).\n")
PY

# Verify imports
log "Verifying Python runtime imports..."
"$VENV/bin/python" -c 'from mcp.server import MCPServer; import starlette, uvicorn, multipart, httpx, claude_agent_sdk, google.auth, pwn, z3, Crypto, gmpy2, sympy, angr, angrop, scapy.all, volatility3, oletools; print("KALI_RUNTIME_IMPORTS_OK")'

# Clear trap before final validation run
trap - ERR

log "Running environment validation..."
PYTHON_BIN="$VENV/bin/python" bash "$SCRIPT_DIR/990_validate.sh"

log "Kali workstation provisioning completed successfully."
