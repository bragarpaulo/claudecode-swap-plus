#!/bin/bash
# Instala o Swap Plus nesta máquina: o motor (comando swap-plus) e a extensão
# do VS Code, a partir das releases dos forks no GitHub. Não precisa clonar nada.
#
#   curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
#
# No Windows, use install.ps1 (veja o MANUAL.md).
#
# Rodar de novo reinstala as versões mais novas. Depois de instalado, a própria
# extensão se atualiza ao abrir e ao fechar o VS Code.
#
#   --dry-run   mostra o que faria, sem instalar nada
set -euo pipefail

CLI_REPO="bragarpaulo/swap-plus"
EXT_REPO="bragarpaulo/swap-plus-vscode"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY=1

say() { printf '\n==> %s\n' "$*"; }
run() { if [ -n "$DRY" ]; then echo "    (simulação) $*"; else "$@"; fi; }
fail() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

# Primeiro arquivo de release (plus-vX.Y.Z) cujo nome termina com $2. A API
# lista as releases da mais nova para a mais antiga.
latest_asset() {
  curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$1/releases?per_page=20" |
    grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 |
    grep -E "/releases/download/plus-v[0-9]+\.[0-9]+\.[0-9]+/[^/]*$2\$" | head -1
}

command -v curl >/dev/null || fail "curl não encontrado."

# ------------------------------------------------------------------ uv
say "uv (gerenciador que instala o motor)"
if command -v uv >/dev/null; then
  echo "    já instalado: $(uv --version)"
else
  echo "    não encontrado; instalando pelo instalador oficial (https://astral.sh/uv)"
  if [ -n "$DRY" ]; then
    echo "    (simulação) curl -LsSf https://astral.sh/uv/install.sh | sh"
  else
    curl -LsSf https://astral.sh/uv/install.sh | sh
  fi
  command -v uv >/dev/null || [ -n "$DRY" ] || fail "o uv não ficou disponível. Abra um terminal novo e rode este script de novo."
fi

# ------------------------------------------------------------------ motor
say "Motor (swap-plus)"
WHEEL=$(latest_asset "$CLI_REPO" '\.whl') || true
[ -n "$WHEEL" ] || fail "não achei a release do motor em https://github.com/$CLI_REPO/releases"
echo "    $WHEEL"
run uv tool install --force --reinstall "$WHEEL"
if [ -z "$DRY" ]; then
  swap-plus --version || fail "o comando swap-plus não ficou disponível."
fi

# ------------------------------------------------------------------ extensão
say "Extensão Swap Plus (VS Code)"
CODE=""
for c in "$(command -v code || true)" "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CODE="$c"; break; fi
done
if [ -z "$CODE" ]; then
  echo "    VS Code não encontrado. Instale o VS Code e rode este script de novo."
else
  VSIX_URL=$(latest_asset "$EXT_REPO" '\.vsix') || true
  [ -n "$VSIX_URL" ] || fail "não achei a release da extensão em https://github.com/$EXT_REPO/releases"
  echo "    $VSIX_URL"
  TMP=$(mktemp -d)
  trap 'rm -rf "$TMP"' EXIT
  run curl -fsSL -o "$TMP/swap-plus.vsix" "$VSIX_URL"
  run "$CODE" --install-extension "$TMP/swap-plus.vsix" --force
  # A extensão original mostraria uma segunda barra de status.
  if "$CODE" --list-extensions 2>/dev/null | grep -qi '^smith89k\.claude-swap-status$'; then
    echo "    removendo a extensão original (smith89k.claude-swap-status)"
    run "$CODE" --uninstall-extension smith89k.claude-swap-status
  fi
fi

say "Pronto"
cat <<'MSG'
    1. No VS Code: Cmd+Shift+P → "Developer: Reload Window".
    2. Para trazer as contas de outro computador: clique na barra do Swap Plus
       (embaixo, à esquerda) → Configurações → Importar contas…
       Ou, para logar uma conta aqui: swap-plus add
MSG
