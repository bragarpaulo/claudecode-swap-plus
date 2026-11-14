#!/bin/bash
# Agenda (ou remove) a atualização diária do Swap Plus via launchd.
#   schedule.sh            instala/atualiza o agendamento (todo dia às 10:15)
#   schedule.sh --remove   remove o agendamento
set -euo pipefail
LABEL="local.swap-plus.update"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
SCRIPT="$(cd "$(dirname "$0")" && pwd)/swap-plus-update.sh"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
if [ "${1:-}" = "--remove" ]; then rm -f "$PLIST"; echo "Agendamento removido."; exit 0; fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$SCRIPT</string></array>
  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>10</integer><key>Minute</key><integer>15</integer></dict>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/swap-plus-update.out.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/swap-plus-update.out.log</string>
</dict>
</plist>
PLIST
launchctl bootstrap "$DOMAIN" "$PLIST"
echo "Agendado: todo dia às 10:15 ($PLIST). Log: ~/Library/Logs/swap-plus-update.log"
