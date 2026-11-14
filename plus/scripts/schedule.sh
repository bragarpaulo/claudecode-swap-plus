#!/bin/bash
# Agenda (ou remove) a atualização diária do Swap Plus via launchd.
#   schedule.sh            instala/atualiza o agendamento (todo dia às 10:15)
#   schedule.sh --remove   remove o agendamento (as cópias em ~/.local/share/swap-plus ficam)
#
# O macOS não deixa tarefas em segundo plano lerem ~/Documents, ~/Desktop e
# ~/Downloads. Por isso o atualizador trabalha em cópias próprias dos dois
# forks em ~/.local/share/swap-plus, criadas aqui a partir do GitHub.
set -euo pipefail
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
LABEL="local.swap-plus.update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
BASE="${SWAP_PLUS_HOME:-$HOME/.local/share/swap-plus}"
REPO="$(cd "$(dirname "$0")/../.." && pwd)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if [ "${1:-}" = "--remove" ]; then rm -f "$PLIST"; echo "Agendamento removido."; exit 0; fi

EXT_URL="$(git -C "$REPO" remote get-url origin)"
CLI_URL="${SWAP_PLUS_CLI_URL:-$(echo "$EXT_URL" | sed -E 's#/swap-plus-vscode(\.git)?$#/swap-plus.git#')}"

# clone <pasta> <origin> <upstream>
clone() {
  local dir="$BASE/$1"
  if [ ! -d "$dir/.git" ]; then git clone -q --branch plus "$2" "$dir"; fi
  git -C "$dir" remote set-url origin "$2"
  git -C "$dir" remote get-url upstream >/dev/null 2>&1 || git -C "$dir" remote add upstream "$3"
  git -C "$dir" fetch -q upstream --tags
  git -C "$dir" checkout -q plus && git -C "$dir" pull -q --ff-only origin plus
}
mkdir -p "$BASE" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
clone swap-plus-vscode "$EXT_URL" "https://github.com/smith89k/claude-swap-status.git"
clone swap-plus "$CLI_URL" "https://github.com/realiti4/claude-swap.git"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$BASE/swap-plus-vscode/plus/scripts/swap-plus-update.sh</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/swap-plus-update.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/swap-plus-update.out.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Agendado: todo dia às 10:15."
echo "  cópias do atualizador: $BASE"
echo "  log: ~/Library/Logs/swap-plus-update.log"
