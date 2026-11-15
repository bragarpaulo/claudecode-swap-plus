#!/bin/bash
# Instala a extensão Swap Plus no VS Code (Mac ou Linux), a partir da release mais nova
# do GitHub. Não precisa clonar nada.
#
#   curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
#
# No Windows, use install.ps1 (veja o MANUAL.md).
#
# Rodar de novo reinstala a versão mais nova. Depois de instalada, a própria extensão
# se atualiza ao abrir e ao fechar o VS Code.
#
# A partir da 3.0 o Swap Plus é só a extensão + o servidor. O motor antigo das versões
# 1.x e 2.x (o comando swap-plus, instalado pelo uv) não é mais usado: se ele estiver
# nesta máquina, este script o remove.
#
#   --dry-run   mostra o que faria, sem instalar nem remover nada
#               (pelo curl: ... | bash -s -- --dry-run)
set -euo pipefail

EXT_REPO="bragarpaulo/swap-plus-vscode"
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

DRY=""
[ "${1:-}" = "--dry-run" ] && DRY=1
[ "${SWAP_PLUS_DRY_RUN:-}" = "1" ] && DRY=1

say() { printf '\n==> %s\n' "$*"; }
run() { if [ -n "$DRY" ]; then echo "    (simulação) $*"; else "$@"; fi; }
fail() { printf '\nERRO: %s\n' "$*" >&2; exit 1; }

# Tag da release mais nova (plus-vX.Y.Z) pelo link /releases/latest do GitHub,
# que redireciona para ela. Não usa a API, que tem limite de consultas por hora.
latest_tag() {
  curl -fsSI "https://github.com/$1/releases/latest" 2>/dev/null | tr -d '\r' |
    awk 'tolower($1) == "location:" { print $2 }' |
    sed -n 's#.*/releases/tag/\(plus-v[0-9][0-9.]*\)$#\1#p' | tail -1
}

# Reserva: primeiro arquivo de release (plus-vX.Y.Z) cujo nome termina com $2,
# pela API (lista as releases da mais nova para a mais antiga).
latest_asset() {
  curl -fsSL -H "Accept: application/vnd.github+json" "https://api.github.com/repos/$1/releases?per_page=20" |
    grep -o '"browser_download_url": *"[^"]*"' | cut -d'"' -f4 |
    grep -E "/releases/download/plus-v[0-9]+\.[0-9]+\.[0-9]+/[^/]*$2\$" | head -1
}

command -v curl >/dev/null || fail "curl não encontrado."

# ------------------------------------------------------------------ extensão
say "Extensão Swap Plus (VS Code)"
CODE=""
for c in "$(command -v code || true)" \
  "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "$HOME/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" \
  "/usr/bin/code" "/snap/bin/code"; do
  if [ -n "$c" ] && [ -x "$c" ]; then CODE="$c"; break; fi
done
[ -n "$CODE" ] || fail "VS Code não encontrado. Instale o VS Code (https://code.visualstudio.com) e rode este comando de novo."
echo "    VS Code: $CODE"

TAG=$(latest_tag "$EXT_REPO") || true
if [ -n "$TAG" ]; then
  VSIX_URL="https://github.com/$EXT_REPO/releases/download/$TAG/swap-plus.vsix"
else
  VSIX_URL=$(latest_asset "$EXT_REPO" '\.vsix') || true
fi
[ -n "$VSIX_URL" ] || fail "não achei a release da extensão em https://github.com/$EXT_REPO/releases"
echo "    $VSIX_URL"

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
run curl -fsSL -o "$TMP/swap-plus.vsix" "$VSIX_URL" || fail "não consegui baixar a extensão."
run "$CODE" --install-extension "$TMP/swap-plus.vsix" --force || fail "o VS Code não instalou a extensão."

EXTS=$("$CODE" --list-extensions --show-versions 2>/dev/null || true)
if [ -z "$DRY" ]; then
  INSTALADA=$(printf '%s\n' "$EXTS" | grep -i '^paulo-local\.swap-plus@' | head -1 || true)
  [ -n "$INSTALADA" ] && echo "    instalada: $INSTALADA"
fi
# A extensão original (de onde o Swap Plus começou) mostraria uma segunda barra de status.
if printf '%s\n' "$EXTS" | grep -qi '^smith89k\.claude-swap-status@'; then
  echo "    removendo a extensão original (smith89k.claude-swap-status)"
  run "$CODE" --uninstall-extension smith89k.claude-swap-status || echo "    (não consegui remover; desinstale pela aba Extensões do VS Code)"
fi

# ------------------------------------------------------------------ motor antigo
# O motor das versões 1.x e 2.x é o pacote do uv que traz o comando swap-plus
# (o pacote se chama claude-swap). Acha pelo comando, não pelo nome, para não
# mexer num claude-swap instalado por outro motivo. Nada aqui faz o script falhar.
say "Motor antigo (comando swap-plus)"
if command -v uv >/dev/null 2>&1; then
  PKGS=$(uv tool list 2>/dev/null | awk '
    /^- / { if (($2 == "swap-plus") && pkg != "") print pkg; next }
    /^[^ -]/ { pkg = $1; if (pkg == "swap-plus") print pkg }' | sort -u || true)
  if [ -n "$PKGS" ]; then
    for p in $PKGS; do
      echo "    o Swap Plus 3.0 não usa mais o motor: removendo (uv tool uninstall $p)"
      run uv tool uninstall "$p" || echo "    (não consegui remover; siga em frente: a extensão não usa o motor)"
    done
  elif command -v swap-plus >/dev/null 2>&1; then
    echo "    o comando swap-plus existe ($(command -v swap-plus)), mas não foi instalado pelo uv; não mexi nele."
  else
    echo "    não está instalado (nada a remover)."
  fi
elif command -v swap-plus >/dev/null 2>&1; then
  echo "    o comando swap-plus existe ($(command -v swap-plus)), mas o uv não foi encontrado; não mexi nele."
else
  echo "    não está instalado (nada a remover)."
fi

say "Pronto. Abra o VS Code, clique no Swap Plus na barra de baixo → Configurações… → Entrar com Google."
echo "    (Se o VS Code já estava aberto, feche e abra de novo.)"
