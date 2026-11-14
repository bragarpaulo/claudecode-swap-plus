#!/bin/bash
# Mantém os forks Swap Plus em dia com os originais e reinstala o que mudou.
#
#   swap-plus-update.sh           sincroniza; reinstala só se houver versão nova
#   swap-plus-update.sh --check   só informa se há versão nova (não altera nada)
#
# Regra: só entram versões ESTÁVEIS do original (tags vX.Y.Z; betas ficam de fora).
#   - motor (swap-plus, fork do claude-swap): merge da tag no branch plus → push →
#     build de teste num ambiente isolado → reinstala → roda o teste da extensão.
#   - extensão (swap-plus-vscode, fork do claude-swap-status): merge da tag no
#     branch plus → push. A versão Plus vive em plus/ e não muda sozinha: o
#     script só avisa que o original mudou, para avaliar se vale portar.
set -u
export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

EXT_DIR="${SWAP_PLUS_EXT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
CLI_DIR="${SWAP_PLUS_CLI_DIR:-$(dirname "$EXT_DIR")/swap-plus}"
LOG="${SWAP_PLUS_LOG:-$HOME/Library/Logs/swap-plus-update.log}"
CHECK=0; [ "${1:-}" = "--check" ] && CHECK=1
UV="${SWAP_PLUS_UV:-uv}"
NEW_TAG=""

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" | tee -a "$LOG"; }
notify() { [ -n "${SWAP_PLUS_QUIET:-}" ] && return 0; /usr/bin/osascript -e "display notification \"$2\" with title \"$1\"" >/dev/null 2>&1 || true; }
latest_stable() { git -C "$1" tag -l 'v[0-9]*' --sort=-v:refname | grep -E '^v[0-9]+\.[0-9]+\.[0-9]+$' | head -1; }

# sync <dir> → 0 = trouxe versão nova (NEW_TAG), 1 = já em dia, 2+ = erro
sync() {
  local dir="$1" tag
  NEW_TAG=""
  [ -d "$dir/.git" ] || { log "ERRO: $dir não é um repositório git"; return 2; }
  git -C "$dir" fetch -q upstream --tags 2>>"$LOG" || { log "ERRO: não consegui buscar o original de $dir"; return 2; }
  tag="$(latest_stable "$dir")"
  [ -n "$tag" ] || { log "ERRO: nenhuma tag estável em $dir"; return 2; }
  if git -C "$dir" merge-base --is-ancestor "$tag" plus; then return 1; fi
  NEW_TAG="$tag"
  [ "$CHECK" = 1 ] && return 0
  [ "$(git -C "$dir" rev-parse --abbrev-ref HEAD)" = "plus" ] || { log "ERRO: $dir não está no branch plus"; return 3; }
  [ -z "$(git -C "$dir" status --porcelain --untracked-files=no)" ] || { log "ERRO: $dir tem alterações não commitadas"; return 3; }
  git -C "$dir" pull -q --ff-only origin plus 2>>"$LOG" || true
  if ! git -C "$dir" merge -q -X ours --no-edit -m "Merge upstream $tag into plus" "$tag" >>"$LOG" 2>&1; then
    git -C "$dir" merge --abort >/dev/null 2>&1
    log "ERRO: o merge de $tag em $dir deu conflito; nada foi alterado"
    return 4
  fi
  git -C "$dir" push -q origin plus 2>>"$LOG" || log "AVISO: push de $dir falhou (o merge ficou só na máquina)"
  git -C "$dir" push -q origin "refs/remotes/upstream/main:refs/heads/main" 2>>"$LOG" || true
  return 0
}

install_cli() {
  local tmp spec
  tmp="$(mktemp -d)"
  # 1) build de teste isolado: só troca a instalação real se o comando novo roda
  if ! { "$UV" venv -q "$tmp/venv" && "$UV" pip install -q --python "$tmp/venv/bin/python" "$CLI_DIR" && "$tmp/venv/bin/swap-plus" --version; } >>"$LOG" 2>&1; then
    rm -rf "$tmp"; log "ERRO: a versão nova do motor não passou no build de teste; instalação atual mantida"; return 1
  fi
  rm -rf "$tmp"
  spec="git+$(git -C "$CLI_DIR" remote get-url origin | sed 's/\.git$//')@plus"
  "$UV" tool install -q --force --reinstall "$spec" >>"$LOG" 2>&1 || { log "ERRO: uv tool install falhou ($spec)"; return 1; }
  log "motor reinstalado: $(swap-plus --version 2>&1)"
  # 2) a extensão ainda entende a saída do motor novo?
  if command -v node >/dev/null 2>&1 && ! node "$EXT_DIR/plus/test/smoke.js" --readonly >>"$LOG" 2>&1; then
    log "AVISO: o teste da extensão falhou com o motor novo — veja o log"
    return 2
  fi
  return 0
}

status=0

sync "$CLI_DIR"; rc=$?
if [ $rc -eq 0 ]; then
  if [ "$CHECK" = 1 ]; then
    log "motor: versão nova disponível no original ($NEW_TAG)"
  else
    tag="$NEW_TAG"; log "motor: $tag trazido para o fork"
    install_cli; irc=$?
    if [ $irc -eq 0 ]; then notify "Swap Plus" "Motor atualizado para $tag."
    elif [ $irc -eq 2 ]; then notify "Swap Plus" "Motor atualizado para $tag, mas o teste da extensão falhou. Veja o log."; status=1
    else notify "Swap Plus" "Não consegui instalar o motor $tag. A versão anterior continua. Veja o log."; status=1; fi
  fi
elif [ $rc -eq 1 ]; then log "motor: em dia ($(latest_stable "$CLI_DIR"))"
else notify "Swap Plus" "Falha ao sincronizar o motor com o original. Veja o log."; status=1; fi

sync "$EXT_DIR"; rc=$?
if [ $rc -eq 0 ]; then
  if [ "$CHECK" = 1 ]; then
    log "extensão: versão nova disponível no original ($NEW_TAG)"
  else
    log "extensão: o original mudou ($NEW_TAG). O Plus (plus/) segue igual; ver: git -C $EXT_DIR log -p ORIG_HEAD..HEAD -- src"
    notify "Swap Plus" "A extensão original lançou $NEW_TAG. Sua versão continua funcionando; vale pedir ao Claude para avaliar se há algo a portar."
  fi
elif [ $rc -eq 1 ]; then log "extensão: em dia ($(latest_stable "$EXT_DIR"))"
else notify "Swap Plus" "Falha ao sincronizar a extensão com o original. Veja o log."; status=1; fi

exit $status
