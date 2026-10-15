#!/usr/bin/env bash
# CodeView installer — provisions ripgrep, installs an always-on service (Linux/systemd),
# and symlinks the `codeview` CLI. Safe to re-run.
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8910}"
ROOT_DEFAULT="${ROOT:-$HOME}"

echo "CodeView installer  ($DIR)"

# --- 1. node ---
command -v node >/dev/null || { echo "✗ Node.js (>=18) is required — install it first."; exit 1; }
echo "✓ node $(node -v)"

# --- 2. ripgrep (fast search) ---
if command -v rg >/dev/null; then
  echo "✓ ripgrep on PATH ($(rg --version | head -1))"
else
  BUND="$(find / -name rg -type f -executable 2>/dev/null | grep -iE 'vscode/ripgrep|ripgrep' | head -1 || true)"
  if [ -n "$BUND" ]; then
    mkdir -p "$DIR/bin"; cp "$BUND" "$DIR/bin/rg"; chmod +x "$DIR/bin/rg"
    echo "✓ bundled ripgrep from: $BUND"
  else
    echo "⚠ ripgrep not found — search will fall back to grep (slower)."
    echo "  For fast search: 'sudo apt install ripgrep' (Debian/Ubuntu) or 'brew install ripgrep' (macOS)."
  fi
fi

# --- 3. CLI on PATH (optional, best-effort) ---
chmod +x "$DIR/cli.mjs" "$DIR/server.mjs" 2>/dev/null || true
if [ -d "$HOME/.local/bin" ]; then
  ln -sf "$DIR/cli.mjs" "$HOME/.local/bin/codeview"
  echo "✓ 'codeview' linked into ~/.local/bin (run: codeview [folder])"
fi

# --- 4. always-on service (Linux + systemd user) ---
if command -v systemctl >/dev/null && [ "$(uname)" = "Linux" ]; then
  SVC_DIR="$HOME/.config/systemd/user"; mkdir -p "$SVC_DIR"
  cat > "$SVC_DIR/codeview.service" <<EOF
[Unit]
Description=CodeView — local content viewer
After=default.target

[Service]
Type=simple
WorkingDirectory=$DIR
Environment=PORT=$PORT
Environment=ROOT=$ROOT_DEFAULT
ExecStart=$(command -v node) $DIR/server.mjs
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now codeview.service
  echo "✓ service installed & started (manage: systemctl --user restart|status codeview)"
  echo "  (optional: 'loginctl enable-linger $USER' keeps it running after logout)"
else
  echo "ℹ No systemd — run it on demand with:  codeview   (or: PORT=$PORT node server.mjs)"
fi

echo ""
echo "✅ CodeView ready →  http://localhost:$PORT"
