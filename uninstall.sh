#!/usr/bin/env bash
# Remove the CodeView service + CLI symlink. Leaves your files and backups untouched.
set -e
if command -v systemctl >/dev/null; then
  systemctl --user disable --now codeview.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/codeview.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "✓ service removed"
fi
rm -f "$HOME/.local/bin/codeview" && echo "✓ CLI symlink removed" || true
echo "Done. (The codeview folder, backups and config are left in place.)"
