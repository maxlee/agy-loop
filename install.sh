#!/bin/sh
# One-line installer for AGY Loop (agy-loop):
#   curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh -s -- --clean-shadow
#   ./install.sh [--clean-shadow]
set -eu

REPO_URL="${AGY_LOOP_REPO:-https://github.com/maxlee/agy-loop}"
CLEAN_SHADOW=0
DO_UNINSTALL=0

print_help() {
  cat <<'EOF'
AGY Loop (agy-loop) Installer

Usage:
  ./install.sh [--clean-shadow]
  curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh
  curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/install.sh | sh -s -- --clean-shadow

Options:
  --clean-shadow   Back up loose user-level loop customizations into
                   ~/.gemini/config/.agy-loop-backup-<timestamp>/
  --uninstall      Uninstall agy-loop via 'agy plugin uninstall agy-loop'
  -h, --help       Show this help message
EOF
}

for arg in "$@"; do
  case "$arg" in
    --clean-shadow)
      CLEAN_SHADOW=1
      ;;
    --uninstall|uninstall)
      DO_UNINSTALL=1
      ;;
    -h|--help|help)
      print_help
      exit 0
      ;;
    *)
      printf "Error: unknown option '%s'. Run with --help for usage.\n" "$arg" >&2
      exit 2
      ;;
  esac
done

if ! command -v agy >/dev/null 2>&1; then
  printf "Error: Antigravity CLI ('agy') was not found in PATH.\n" >&2
  printf "Install Antigravity CLI or ensure 'agy' is available on PATH, then retry.\n" >&2
  exit 1
fi

if [ "$DO_UNINSTALL" -eq 1 ]; then
  printf "==> Uninstalling agy-loop plugin...\n"
  agy plugin uninstall agy-loop
  printf "==> agy-loop has been cleanly uninstalled. (Run '/skills reload' if 'agy' is open.)\n"
  exit 0
fi

resolve_script_dir() {
  case "${0:-}" in
    ""|sh|-sh|dash|-dash|bash|-bash|zsh|-zsh|/bin/sh|/usr/bin/sh)
      return 1
      ;;
  esac
  if [ -f "$0" ]; then
    CDPATH= cd -- "$(dirname -- "$0")" && pwd
    return 0
  fi
  return 1
}

INSTALL_TARGET="$REPO_URL"
if SCRIPT_DIR=$(resolve_script_dir 2>/dev/null); then
  if [ -f "$SCRIPT_DIR/plugin.json" ] && grep -Eq '"name"[[:space:]]*:[[:space:]]*"agy-loop"' "$SCRIPT_DIR/plugin.json"; then
    INSTALL_TARGET="$SCRIPT_DIR"
  fi
fi

SHADOW_FOUND=0
for candidate in \
  "$HOME/.gemini/config/skills/loop" \
  "$HOME/.gemini/config/agents/loop-worker.md" \
  "$HOME/.gemini/antigravity-cli/skills/loop" \
  "$HOME/.gemini/skills/loop"
do
  if [ -e "$candidate" ] || [ -L "$candidate" ]; then
    SHADOW_FOUND=1
    break
  fi
done

INSTALLED_PLUGIN_DIR="$HOME/.gemini/config/plugins/agy-loop"
ALREADY_IN_PLACE=0
if [ -d "$INSTALL_TARGET" ] && [ -d "$INSTALLED_PLUGIN_DIR" ]; then
  SRC_REAL=$(CDPATH= cd -- "$INSTALL_TARGET" 2>/dev/null && pwd -P || true)
  DST_REAL=$(CDPATH= cd -- "$INSTALLED_PLUGIN_DIR" 2>/dev/null && pwd -P || true)
  if [ -n "$SRC_REAL" ] && [ "$SRC_REAL" = "$DST_REAL" ]; then
    ALREADY_IN_PLACE=1
  fi
fi

if [ "$ALREADY_IN_PLACE" -eq 1 ]; then
  if [ ! -f "$INSTALLED_PLUGIN_DIR/plugin.json" ] || ! grep -Eq '"name"[[:space:]]*:[[:space:]]*"agy-loop"' "$INSTALLED_PLUGIN_DIR/plugin.json"; then
    printf "Error: invalid or missing plugin.json in %s\n" "$INSTALLED_PLUGIN_DIR" >&2
    exit 1
  fi
  agy plugin validate "$INSTALLED_PLUGIN_DIR" >/dev/null
  printf "==> Verified agy-loop already installed at %s (skipping self-copy)...\n" "$INSTALLED_PLUGIN_DIR"
else
  printf "==> Installing agy-loop via Antigravity CLI (%s)...\n" "$INSTALL_TARGET"
  agy plugin install "$INSTALL_TARGET"
fi

BACKUP_DIR=""
if [ "$SHADOW_FOUND" -eq 1 ] && [ "$CLEAN_SHADOW" -eq 1 ]; then
  TS=$(date +%Y%m%d-%H%M%S)
  BACKUP_DIR="$HOME/.gemini/config/.agy-loop-backup-$TS"
  if [ -e "$BACKUP_DIR" ] || [ -L "$BACKUP_DIR" ]; then
    BACKUP_DIR="${BACKUP_DIR}-$$"
  fi
  mkdir -p "$BACKUP_DIR"

  move_shadow_item() {
    src_path="$1"
    rel_dest="$2"
    if [ -e "$src_path" ] || [ -L "$src_path" ]; then
      dest_path="$BACKUP_DIR/$rel_dest"
      mkdir -p "$(dirname -- "$dest_path")"
      mv "$src_path" "$dest_path"
    fi
  }

  move_shadow_item "$HOME/.gemini/config/skills/loop" "config/skills/loop"
  move_shadow_item "$HOME/.gemini/config/agents/loop-worker.md" "config/agents/loop-worker.md"
  move_shadow_item "$HOME/.gemini/antigravity-cli/skills/loop" "antigravity-cli/skills/loop"
  move_shadow_item "$HOME/.gemini/skills/loop" "skills/loop"
fi

if [ -n "$BACKUP_DIR" ]; then
  printf "==> Backed up shadowing user-level customizations to:\n    %s\n" "$BACKUP_DIR"
elif [ "$SHADOW_FOUND" -eq 1 ]; then
  printf "\nWarning: Detected user-level customization file(s) that take precedence over plugins and shadow agy-loop:\n" >&2
  for candidate in \
    "$HOME/.gemini/config/skills/loop" \
    "$HOME/.gemini/config/agents/loop-worker.md" \
    "$HOME/.gemini/antigravity-cli/skills/loop" \
    "$HOME/.gemini/skills/loop"
  do
    if [ -e "$candidate" ] || [ -L "$candidate" ]; then
      printf "  - %s\n" "$candidate" >&2
    fi
  done
  printf "To archive them safely into ~/.gemini/config/.agy-loop-backup-<timestamp>/, re-run with --clean-shadow:\n" >&2
  printf "  sh ~/.gemini/config/plugins/agy-loop/install.sh --clean-shadow\n" >&2
  printf "  # or: npx agy-loop doctor --clean-shadow\n\n" >&2
fi

printf "==> Done! AGY Loop (agy-loop) is installed.\n"
printf "    Run '/skills reload' in open 'agy' sessions, then invoke '/agy-loop:loop' (or '/agy-loop:loop help').\n"
printf "    - If 'agy' is already open, run: /skills reload\n"
printf "    - Try: /loop 1m check local build and tests\n"
printf "    - Try: /loop check current PR CI status and fix failures --stateful\n"
printf "    - Try: /loop status\n"
