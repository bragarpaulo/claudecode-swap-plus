#!/bin/sh
# Swap Plus Cliente do Hermes — prepara o host do Contabo: rede, pastas e imagem. NÃO cria a stack, NÃO pareia e
# NÃO mexe no Hermes (isso é o LEIA-ME.md, passo a passo). Sem --apply só diz o que faria.
#
# Uso (root, no servidor, depois de atualizar /opt/swap-plus/app):
#   sh /opt/swap-plus/app/cliente/deploy/preparar.sh                 # simulação
#   sh /opt/swap-plus/app/cliente/deploy/preparar.sh --apply
#   sh /opt/swap-plus/app/cliente/deploy/preparar.sh --versao 1.0.0-2 --apply   # mesmo código, imagem nova
#   sh /opt/swap-plus/app/cliente/deploy/preparar.sh --login-dir /srv/hermes-personal/data/swap-plus-login --apply
#
# --login-dir: a pasta de login fica em outro lugar (dentro da área de dados do Hermes, para ele enxergá-la sem um
# bind novo). Essa pasta este script NÃO cria: o root do host não grava em pasta que o Hermes controla. Crie antes,
# de dentro do contêiner, como o usuário dele:
#   docker exec -u 10000 hermes mkdir -m 0700 /opt/data/swap-plus-login
set -eu

APP=/opt/swap-plus/app
BASE=/opt/swap-plus-cliente/hermes
REDE=swap-plus-cliente
FAIXA=10.88.3.0/24
DONO=10000          # o usuário do Hermes (hermes, uid 10000): ele e o cliente gravam a mesma pasta de login

APLICAR=0
VERSAO=""
LOGIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APLICAR=1 ;;
    --versao) shift; VERSAO="${1:-}" ;;
    --login-dir) shift; LOGIN="${1:-}" ;;
    *) echo "Opção desconhecida: $1" >&2; exit 2 ;;
  esac
  shift
done

[ "$(id -u)" = 0 ] || { echo "Rode como root." >&2; exit 1; }
[ -f "$APP/cliente/deploy/Dockerfile" ] || { echo "Não achei $APP/cliente/deploy/Dockerfile: atualize o código em $APP antes." >&2; exit 1; }
if [ -z "$VERSAO" ]; then
  VERSAO=$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$APP/cliente/package.json")
fi
case "$VERSAO" in *[!A-Za-z0-9._-]*|"") echo "Versão inválida: $VERSAO" >&2; exit 2 ;; esac
IMAGEM="swap-plus-cliente:$VERSAO"

fazer() {
  if [ "$APLICAR" = 1 ]; then echo "+ $*"; "$@"; else echo "(simulação) $*"; fi
}

echo "== 1. rede $REDE ($FAIXA)"
if docker network inspect "$REDE" >/dev/null 2>&1; then
  atual=$(docker network inspect "$REDE" --format '{{range .IPAM.Config}}{{.Subnet}}{{end}}')
  [ "$atual" = "$FAIXA" ] || { echo "A rede $REDE existe com outra faixa ($atual). Confira antes de continuar." >&2; exit 1; }
  echo "já existe"
else
  # A faixa não pode estar em uso por outra rede do servidor.
  for n in $(docker network ls --format '{{.Name}}'); do
    s=$(docker network inspect "$n" --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}')
    case " $s" in *" $FAIXA "*) echo "A faixa $FAIXA já é da rede $n. Escolha outra (aqui e no compose.yaml)." >&2; exit 1 ;; esac
  done
  fazer docker network create --subnet "$FAIXA" --label io.servidor.managed=true "$REDE"
fi

echo "== 2. pastas ($DONO:$DONO, 700)"
PASTAS="$BASE $BASE/dados"
[ -n "$LOGIN" ] || PASTAS="$PASTAS $BASE/login"
for d in $PASTAS; do
  if [ -d "$d" ]; then
    echo "já existe: $(stat -c '%a %u:%g %n' "$d")"
  else
    fazer install -d -o "$DONO" -g "$DONO" -m 0700 "$d"
  fi
done
if [ -n "$LOGIN" ]; then
  # Pasta de login fora daqui (dentro dos dados do Hermes): só confere. Tem de ser uma pasta de verdade (não um
  # atalho), do usuário do Hermes e só dele.
  if [ -L "$LOGIN" ] || [ ! -d "$LOGIN" ]; then
    echo "A pasta de login $LOGIN não existe (ou é um atalho). Crie de dentro do contêiner do Hermes, como o usuário dele (veja o começo deste arquivo)." >&2
    exit 1
  fi
  atual=$(stat -c '%a %u:%g' "$LOGIN")
  [ "$atual" = "700 $DONO:$DONO" ] || { echo "A pasta de login $LOGIN está com $atual; esperava 700 $DONO:$DONO." >&2; exit 1; }
  echo "pasta de login (não criada por este script): $atual $LOGIN"
fi

echo "== 3. imagem $IMAGEM"
if docker image inspect "$IMAGEM" >/dev/null 2>&1; then
  echo "já existe (uma etiqueta = uma imagem: para código novo, use --versao com outra etiqueta)"
else
  fazer docker build -f "$APP/cliente/deploy/Dockerfile" -t "$IMAGEM" "$APP"
  # A imagem responde? (só imprime a versão; não fala com ninguém)
  fazer docker run --rm --network none --read-only --cap-drop ALL "$IMAGEM" versao
fi

echo
if [ "$APLICAR" = 1 ]; then
  EXTRA=""
  [ -z "$LOGIN" ] || EXTRA=" --login-dir $LOGIN"
  echo "Pronto. Faltam, nesta ordem (cliente/deploy/LEIA-ME.md):"
  echo "  1. conectar:      bash $APP/cliente/deploy/entrar.sh --versao $VERSAO$EXTRA      (login com Google)"
  echo "                    ou bash $APP/cliente/deploy/parear.sh --versao $VERSAO$EXTRA   (código, sem navegador)"
  echo "  2. criar a stack: python3 $APP/cliente/deploy/portainer_stack_create_cliente.py --versao $VERSAO$EXTRA [--apply]"
else
  echo "Nada foi feito (simulação). Para valer: acrescente --apply."
fi
