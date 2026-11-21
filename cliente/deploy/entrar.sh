#!/usr/bin/env bash
# Conecta o cliente "Hermes (servidor)" ao Swap Plus com LOGIN DO GOOGLE — o mesmo jeito da extensão do VS Code.
# O script mostra um endereço; você abre no navegador (do computador ou do celular) e entra com a sua conta Google
# (a do administrador, ou uma liberada no painel em Usuários). O cliente passa a aparecer no painel, em Computadores,
# com esse e-mail.
#
# Rodar como root NO SERVIDOR, depois do preparar.sh --apply e ANTES de criar a stack:
#   bash /opt/swap-plus/app/cliente/deploy/entrar.sh --versao 1.0.0
#
# Nenhum segredo aparece na tela: o endereço mostrado só serve para ESTE login (vale 10 minutos) e o acesso do
# cliente é gravado direto em /opt/swap-plus-cliente/hermes/dados/conexao.json (0600).
# Sem navegador à mão ou com o login do Google desligado no servidor, use o parear.sh (código de conexão).
#
# Logo depois de conectar o cliente faz um primeiro ciclo: pede uma conta ao Swap e grava o login do Claude Code em
# /opt/swap-plus-cliente/hermes/login/claude. Isso não gasta uso de conta nenhuma (não chama a Anthropic).
set -euo pipefail

NOME="Hermes (servidor)"
DONO=10000
BASE=/opt/swap-plus-cliente/hermes
REDE=swap-plus-cliente
URL=https://swap.assistentes.si
VERSAO=""
LOGIN=""   # --login-dir: a pasta de login em outro lugar (ver preparar.sh)
while [ $# -gt 0 ]; do
  case "$1" in
    --versao) shift; VERSAO="${1:-}" ;;
    --login-dir) shift; LOGIN="${1:-}" ;;
    --url) shift; URL="${1:-}" ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$VERSAO" ] || { echo "Diga a versão da imagem: --versao <a mesma do preparar.sh>" >&2; exit 2; }
IMAGEM="swap-plus-cliente:$VERSAO"
[ -n "$LOGIN" ] || LOGIN="$BASE/login"

[ "$(id -u)" = 0 ] || { echo "Rode como root." >&2; exit 1; }
docker image inspect "$IMAGEM" >/dev/null 2>&1 || { echo "Não achei a imagem $IMAGEM: rode o preparar.sh --apply antes." >&2; exit 1; }
[ -d "$BASE/dados" ] && [ -d "$LOGIN" ] && [ ! -L "$LOGIN" ] || { echo "Faltam as pastas ($BASE/dados e $LOGIN): rode o preparar.sh --apply antes." >&2; exit 1; }
if docker ps -a --format '{{.Names}}' | grep -qx swap-plus-cliente-hermes; then
  echo "O contêiner swap-plus-cliente-hermes já existe. Para conectar de novo: pare a stack, desconecte o cliente antigo no painel do Swap e apague $BASE/dados/conexao.json." >&2
  exit 1
fi
[ ! -e "$BASE/dados/conexao.json" ] || { echo "Já existe $BASE/dados/conexao.json. Para conectar de novo: desconecte o cliente antigo no painel do Swap e apague o arquivo antes." >&2; exit 1; }

# O cliente mostra o endereço e espera você entrar (até 10 min; Ctrl+C cancela). Sai com erro se conectou mas o
# primeiro ciclo não fechou: nesse caso o conexao.json já existe e a conferência abaixo roda assim mesmo.
set +e
docker run --rm \
    --user "$DONO:$DONO" --network "$REDE" \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=16m,mode=1777 \
    --cpus 0.25 --memory 128m --pids-limit 32 \
    -e TZ=America/Sao_Paulo -e HOME=/dados -e SWAP_PLUS_NOME="$NOME" \
    -v "$BASE/dados:/dados" -v "$LOGIN:/login" \
    "$IMAGEM" entrar --url "$URL"
RESULTADO=$?
set -e
if [ ! -e "$BASE/dados/conexao.json" ]; then
  echo "O cliente não foi conectado (veja a mensagem acima). Nada foi gravado; pode rodar de novo." >&2
  exit 1
fi
[ "$RESULTADO" = 0 ] || echo "ATENÇÃO: o cliente conectou, mas o primeiro ciclo não fechou (mensagem acima). O acesso está gravado; siga e confira o status depois de criar a stack." >&2

# Conferir sem mostrar o acesso
python3 -I - "$BASE/dados/conexao.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("url", "").startswith("https://") and len(d.get("token", "")) >= 20 and d.get("deviceId"), "conexao.json incompleto"
print("ok:", d["url"], "| cliente", d["deviceId"], "| nome", d.get("nome"), "| via", d.get("via"), "| token com", len(d["token"]), "caracteres")
PY
stat -c '%a %u:%g %n' "$BASE/dados" "$BASE/dados/conexao.json" "$LOGIN"
[ ! -e "$LOGIN/claude/.credentials.json" ] || stat -c '%a %u:%g %n' "$LOGIN/claude/.credentials.json"
echo
echo "Agora crie a stack no Portainer (cliente/deploy/LEIA-ME.md). Se acima apareceu \"sem conta\": no painel do Swap,"
echo "Contas → Ajustes desta conta → Computadores permitidos, libere as contas para \"$NOME\"."
