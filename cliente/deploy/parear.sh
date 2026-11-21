#!/usr/bin/env bash
# Pareia o cliente "Hermes (servidor)" no servidor do Swap Plus e deixa o acesso dele em
# /opt/swap-plus-cliente/hermes/dados/conexao.json. Rodar como root NO SERVIDOR, depois do preparar.sh --apply
# e ANTES de criar a stack:
#   bash /opt/swap-plus/app/cliente/deploy/parear.sh --versao 1.0.0
#
# Nada de segredo aparece na tela: o código de conexão nasce dentro do contêiner swap-plus e vai por um cano direto
# para o cliente, que pareia e grava o próprio acesso (0600). Feito a partir do parear-comando-ia.sh do servidor.
#
# Logo depois de parear o cliente faz um primeiro ciclo: pede uma conta ao Swap e grava o login do Claude Code em
# /opt/swap-plus-cliente/hermes/login/claude. Isso não gasta uso de conta nenhuma (não chama a Anthropic).
set -euo pipefail

NOME="Hermes (servidor)"
DONO=10000
BASE=/opt/swap-plus-cliente/hermes
REDE=swap-plus-cliente
VERSAO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --versao) shift; VERSAO="${1:-}" ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done
[ -n "$VERSAO" ] || { echo "Diga a versão da imagem: --versao <a mesma do preparar.sh>" >&2; exit 2; }
IMAGEM="swap-plus-cliente:$VERSAO"

[ "$(id -u)" = 0 ] || { echo "Rode como root." >&2; exit 1; }
docker image inspect "$IMAGEM" >/dev/null 2>&1 || { echo "Não achei a imagem $IMAGEM: rode o preparar.sh --apply antes." >&2; exit 1; }
[ -d "$BASE/dados" ] && [ -d "$BASE/login" ] || { echo "Faltam as pastas em $BASE: rode o preparar.sh --apply antes." >&2; exit 1; }
if docker ps -a --format '{{.Names}}' | grep -qx swap-plus-cliente-hermes; then
  echo "O contêiner swap-plus-cliente-hermes já existe. Para parear de novo: pare a stack, revogue o cliente antigo no Swap e apague $BASE/dados/conexao.json." >&2
  exit 1
fi

# 0) não criar um segundo cliente por engano nem atropelar um pareamento em andamento
[ ! -e "$BASE/dados/conexao.json" ] || { echo "Já existe $BASE/dados/conexao.json. Para parear de novo: revogue o cliente antigo no Swap e apague o arquivo antes." >&2; exit 1; }
docker exec swap-plus node -e '
const b = "http://127.0.0.1:" + (process.env.ADMIN_PORT || 8444);
(async () => {
  const s = await (await fetch(b + "/admin/status")).json();
  if (s.pairing) { console.error("Ha um codigo de conexao ativo (alguem pareando agora?): espere ele vencer e rode de novo"); process.exit(1); }
  const x = (s.devices || []).filter((d) => d.name === process.argv[1]);
  if (x.length) { console.error("Ja existe no Swap: " + x.map((d) => d.id).join(", ") + " (revogue com cli.js revoke <id> antes)"); process.exit(1); }
})().catch((e) => { console.error("Erro: " + e.message); process.exit(1); });
' "$NOME" < /dev/null

# 1) o código de conexão sai do admin local do Swap (127.0.0.1:8444, dentro do contêiner) e entra direto no cliente.
#    O cliente sai com erro se pareou mas o primeiro ciclo não fechou (sem contato, credencial não gravada...): nesse
#    caso o conexao.json já existe e a conferência abaixo roda assim mesmo; o serviço tenta de novo sozinho ao subir.
set +e
docker exec swap-plus node -e '
(async () => {
  const r = await fetch("http://127.0.0.1:" + (process.env.ADMIN_PORT || 8444) + "/admin/pair-code", {
    method: "POST", headers: { accept: "application/json" }, signal: AbortSignal.timeout(15000) });
  const pc = await r.json();
  if (!r.ok || !pc.connect) throw new Error("codigo de conexao: HTTP " + r.status);
  process.stdout.write(pc.connect + "\n");
})().catch((e) => { console.error("Erro: " + e.message); process.exit(1); });
' < /dev/null | docker run --rm -i \
    --user "$DONO:$DONO" --network "$REDE" \
    --read-only --cap-drop ALL --security-opt no-new-privileges:true --tmpfs /tmp:size=16m,mode=1777 \
    --cpus 0.25 --memory 128m --pids-limit 32 \
    -e TZ=America/Sao_Paulo -e HOME=/dados -e SWAP_PLUS_NOME="$NOME" \
    -v "$BASE/dados:/dados" -v "$BASE/login:/login" \
    "$IMAGEM" conectar -
RESULTADO=$?
set -e
if [ ! -e "$BASE/dados/conexao.json" ]; then
  echo "O pareamento não aconteceu (veja a mensagem acima). Nada foi gravado; pode rodar de novo." >&2
  exit 1
fi
[ "$RESULTADO" = 0 ] || echo "ATENÇÃO: o cliente pareou, mas o primeiro ciclo não fechou (mensagem acima). O acesso está gravado; siga e confira o status depois de criar a stack." >&2

# 2) conferir sem mostrar o acesso
python3 -I - "$BASE/dados/conexao.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
assert d.get("url", "").startswith("https://") and len(d.get("token", "")) >= 20 and d.get("deviceId"), "conexao.json incompleto"
print("ok:", d["url"], "| cliente", d["deviceId"], "| nome", d.get("nome"), "| token com", len(d["token"]), "caracteres")
PY
stat -c '%a %u:%g %n' "$BASE/dados" "$BASE/dados/conexao.json" "$BASE/login"
[ ! -e "$BASE/login/claude/.credentials.json" ] || stat -c '%a %u:%g %n' "$BASE/login/claude/.credentials.json"
echo
echo "Agora crie a stack no Portainer (cliente/deploy/LEIA-ME.md). Se acima apareceu \"sem conta\": no painel do Swap,"
echo "Contas → Computadores permitidos, libere as contas para \"$NOME\"."
