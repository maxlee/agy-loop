#!/bin/sh
# One-line clean uninstaller for AGY Loop (agy-loop):
#   curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/uninstall.sh | sh
#   ./uninstall.sh
set -eu

for arg in "$@"; do
  case "$arg" in
    -h|--help|help)
      cat <<'EOF'
AGY Loop (agy-loop) Uninstaller

Usage:
  ./uninstall.sh
  curl -fsSL https://raw.githubusercontent.com/maxlee/agy-loop/main/uninstall.sh | sh
EOF
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

printf "==> Uninstalling agy-loop plugin...\n"
agy plugin uninstall agy-loop
printf "==> agy-loop has been cleanly uninstalled. (If 'agy' is open, run '/skills reload'.)\n"
