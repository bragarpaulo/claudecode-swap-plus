#!/bin/bash
# Empacota a extensão Swap Plus e instala no VS Code.
set -euo pipefail
cd "$(dirname "$0")/.."
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

CODE="${CODE_BIN:-}"
if [ -z "$CODE" ]; then
  for c in "$(command -v code || true)" "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
    if [ -n "$c" ] && [ -x "$c" ]; then CODE="$c"; break; fi
  done
fi
[ -n "$CODE" ] || { echo "CLI do VS Code não encontrado (defina CODE_BIN=/caminho/para/code)"; exit 1; }

npx --yes @vscode/vsce package --no-dependencies -o swap-plus.vsix
"$CODE" --install-extension swap-plus.vsix --force
echo
echo "Instalado. No VS Code: Cmd+Shift+P → \"Developer: Reload Window\" para carregar a versão nova."
