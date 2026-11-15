#!/bin/sh
# Instalação do Swap Plus Servidor no Contabo — 14/11/2026. Roda no servidor, como root, a partir do código copiado em
# /opt/swap-plus/app (este arquivo fica em /opt/swap-plus/app/server/deploy/instalar.sh).
#
# Faz, na ordem, só o que ainda falta. Pode rodar quantas vezes quiser: cada etapa confere antes de fazer, e o script
# para no primeiro erro.
#   1. a rede própria `swap-plus` (172.26.0.0/24), em que o Caddy também vai entrar;
#   2. pastas e donos: /opt/swap-plus/data (1000:1000, 700), /etc/swap-plus (root, 700) e /etc/swap-plus/secrets
#      (1000:1000, 700). O /etc/swap-plus fica só do root para que ninguém do host com uid 1000 chegue aos segredos;
#      o container não precisa dele (vê só a pasta secrets, montada em /run/secrets);
#   3. a chave mestra do cofre, se ainda não existir (openssl rand -hex 32; 1000:1000, 400). NUNCA sobrescreve uma
#      chave que existe, e não gera chave nova se já houver um cofre (ele ficaria ilegível);
#   4. confere os arquivos do cliente Google (google_client_id, google_client_secret): se faltarem, só avisa;
#   5. constrói a imagem swap-plus:<versão> (a versão é a do server/src/server.js, ou a do --versao). Uma etiqueta =
#      uma imagem: se ela já existe, não reconstrói por cima;
#   6. confere o compose (docker compose config -q);
#   7. lembra os passos que ficam à mão, dizendo quais já estão feitos: criar a stack pelo Portainer, DNS, o bloco do
#      Caddy, a rede no compose do proxy (e recriar o Caddy), o alvo novo do backup, testes.
# A stack NÃO é criada aqui: stack só pela API do Portainer (regra do Paulo, 09/11/2026: criada pela linha de comando
# ela fica "Limited"). Nunca mostra segredo na tela.
#
# Uso (root, no servidor):
#   sh /opt/swap-plus/app/server/deploy/instalar.sh                            # simulação: só mostra o que faria
#   sh /opt/swap-plus/app/server/deploy/instalar.sh --apply
#   sh /opt/swap-plus/app/server/deploy/instalar.sh --apply --versao 2.0.0-2   # outra imagem do mesmo código
set -eu

APP=/opt/swap-plus/app
DEPLOY=$APP/server/deploy
COMPOSE=$DEPLOY/compose.yaml
BASE=/opt/swap-plus
DATA=$BASE/data
ETC=/etc/swap-plus
SEC=$ETC/secrets
CHAVE=$SEC/swap_plus_master_key
DONO=1000:1000
REDE=swap-plus
SUBREDE=172.26.0.0/24
GATEWAY=172.26.0.1
PORTA_LOCAL=14950
CONTAINER=swap-plus
# Do servidor (repositório server-contabo):
PROXY_DIR=/opt/server-contabo/stacks/proxy
CADDYFILE=$PROXY_DIR/Caddyfile
PROXY_COMPOSE=$PROXY_DIR/compose.yaml
STACK_UPDATE=/opt/server-contabo/scripts/hermes/portainer_stack_update.py
BACKUP=/usr/local/sbin/contabo-backup

APPLY=0
VERSAO=""
while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --versao) [ $# -ge 2 ] || { echo "faltou o valor de --versao" >&2; exit 2; }; VERSAO=$2; shift ;;
    --versao=*) VERSAO=${1#--versao=} ;;
    -h|--help) sed -n '2,/^set -eu$/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "opção desconhecida: $1 (use --apply e, se precisar, --versao X.Y.Z)" >&2; exit 2 ;;
  esac
  shift
done

etapa() { printf '\n== %s\n' "$*"; }
ok() { echo "  ok: $*"; }
aviso() { echo "  AVISO: $*"; }
die() { echo "  ERRO: $*" >&2; echo "  (parei aqui; nada depois disso foi feito)" >&2; exit 1; }
# Executa com --apply; sem ele, só mostra o comando.
faz() {
  if [ "$APPLY" = 1 ]; then
    echo "  fazendo: $*"
    "$@" || die "falhou: $*"
  else
    echo "  faria: $*"
  fi
}
dono_modo() { stat -c '%u:%g %a' "$1"; }

# Pasta com dono e modo certos: cria se falta, acerta se está diferente.
garante_pasta() {  # caminho dono(uid:gid) modo
  if [ -d "$1" ]; then
    atual=$(dono_modo "$1")
    if [ "$atual" = "$2 $3" ]; then
      ok "$1 ($2, $3)"
    else
      echo "  $1 está com $atual; acertando para $2 $3"
      faz chown "$2" "$1"
      faz chmod "$3" "$1"
    fi
  elif [ -e "$1" ]; then
    die "$1 existe e não é uma pasta"
  else
    faz install -d -o "${2%%:*}" -g "${2##*:}" -m "$3" "$1"
  fi
}

# Arquivo de segredo: acerta dono e modo (1000:1000, 400) sem ler nem mostrar o conteúdo.
garante_segredo() {  # caminho
  atual=$(dono_modo "$1")
  if [ "$atual" = "$DONO 400" ]; then
    ok "$1 ($DONO, 400)"
  else
    echo "  $1 está com $atual; acertando para $DONO 400"
    faz chown "$DONO" "$1"
    faz chmod 400 "$1"
  fi
}

if [ "$APPLY" = 1 ]; then echo "Swap Plus Servidor — instalação (APLICANDO)"; else echo "Swap Plus Servidor — instalação (SIMULAÇÃO: nada muda; use --apply)"; fi

# ---------------------------------------------------------------------------------------------------------------------
etapa "0. pré-requisitos"
[ "$(id -u)" = 0 ] || die "rode como root"
for c in docker openssl stat ss grep sed; do
  command -v "$c" >/dev/null 2>&1 || die "falta o comando $c"
done
docker info >/dev/null 2>&1 || die "o Docker não responde"
docker compose version >/dev/null 2>&1 || die "falta o plugin docker compose"
[ -f "$APP/server/Dockerfile" ] || die "não achei $APP/server/Dockerfile: copie o código para $APP antes (LEIA-ME.md, Instalação, passo 1)"
[ -f "$APP/plus/rules.js" ] || die "não achei $APP/plus/rules.js (a imagem precisa dele)"
[ -f "$COMPOSE" ] || die "não achei $COMPOSE"
[ -f "$APP/.dockerignore" ] || aviso "sem $APP/.dockerignore: o build manda a pasta inteira para o Docker (funciona, só demora mais)"
if [ -z "$VERSAO" ]; then
  VERSAO=$(sed -n 's/^const VERSION = "\([^"]*\)";.*$/\1/p' "$APP/server/src/server.js" | head -n 1)
fi
echo "$VERSAO" | grep -Eqx '[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' || die "versão inválida: '$VERSAO' (use X.Y.Z ou X.Y.Z-N; nunca latest)"
IMAGEM=swap-plus:$VERSAO
ok "versão: $VERSAO (imagem $IMAGEM)"
if ss -ltnH "sport = :$PORTA_LOCAL" | grep -q .; then
  if docker container inspect "$CONTAINER" >/dev/null 2>&1; then
    ok "porta 127.0.0.1:$PORTA_LOCAL em uso pelo próprio $CONTAINER"
  else
    die "a porta $PORTA_LOCAL já está em uso por outro programa (ss -ltnp 'sport = :$PORTA_LOCAL')"
  fi
else
  ok "porta 127.0.0.1:$PORTA_LOCAL livre"
fi

# ---------------------------------------------------------------------------------------------------------------------
etapa "1. rede $REDE ($SUBREDE)"
if docker network inspect "$REDE" >/dev/null 2>&1; then
  sub=$(docker network inspect -f '{{range .IPAM.Config}}{{.Subnet}} {{end}}' "$REDE" | sed 's/ *$//')
  [ "$sub" = "$SUBREDE" ] || die "a rede $REDE já existe com outra faixa ($sub); esperava $SUBREDE. Não mexo nela."
  ok "a rede $REDE já existe ($SUBREDE)"
else
  # A faixa não pode ser de outra rede (o Docker recusaria de qualquer jeito; aqui a mensagem diz qual).
  outra=$(docker network ls -q | xargs docker network inspect -f '{{.Name}} {{range .IPAM.Config}}{{.Subnet}} {{end}}' \
    | awk -v s="$SUBREDE" '{ for (i = 2; i <= NF; i++) if ($i == s) print $1 }')
  [ -z "$outra" ] || die "a faixa $SUBREDE já é da rede $outra"
  faz docker network create --subnet "$SUBREDE" --gateway "$GATEWAY" --label io.servidor.managed=true "$REDE"
fi

# ---------------------------------------------------------------------------------------------------------------------
etapa "2. pastas e donos"
garante_pasta "$BASE" 0:0 755
garante_pasta "$DATA" "$DONO" 700
garante_pasta "$ETC" 0:0 700
garante_pasta "$SEC" "$DONO" 700
if [ -e "$DATA/store.enc" ]; then
  [ "$(stat -c '%u:%g' "$DATA/store.enc")" = "$DONO" ] || aviso "$DATA/store.enc não é de $DONO: o servidor não vai conseguir regravar o cofre (chown $DONO $DATA/store.enc*)"
  ok "já existe um cofre em $DATA/store.enc (reinstalação ou recuperação)"
fi

# ---------------------------------------------------------------------------------------------------------------------
etapa "3. chave mestra do cofre"
if [ -e "$CHAVE" ]; then
  [ -s "$CHAVE" ] || die "$CHAVE existe mas está vazio. Não apago nada sozinho: se ainda não há cofre ($DATA/store.enc), apague o arquivo vazio e rode de novo; se há, recupere a chave (LEIA-ME.md, 'Se a chave mestra se perder')"
  if grep -Eqx '[0-9a-fA-F]{64}' "$CHAVE"; then
    ok "a chave existe e tem o formato certo (conteúdo não mostrado); não mexo nela"
  else
    aviso "$CHAVE não está em 64 caracteres hex. O servidor também aceita base64 de 32 bytes; se ele não subir, é isso. Não mexo nela."
  fi
  garante_segredo "$CHAVE"
elif [ -e "$DATA/store.enc" ]; then
  die "há um cofre em $DATA/store.enc mas a chave $CHAVE sumiu. NÃO gero outra: o cofre ficaria ilegível. Recupere a chave (LEIA-ME.md, 'Se a chave mestra se perder')"
elif [ "$APPLY" = 1 ]; then
  # Gera num temporário e liga com `ln`, que falha se a chave já existir: nunca sobrescreve.
  tmp=$(mktemp "$SEC/.chave.XXXXXX")
  if ! openssl rand -hex 32 > "$tmp" || ! grep -Eqx '[0-9a-f]{64}' "$tmp"; then
    rm -f "$tmp"; die "não consegui gerar a chave com openssl rand -hex 32"
  fi
  chown "$DONO" "$tmp" && chmod 400 "$tmp" || { rm -f "$tmp"; die "não consegui acertar dono e modo da chave"; }
  ln "$tmp" "$CHAVE" || { rm -f "$tmp"; die "não consegui gravar $CHAVE (já existe?)"; }
  rm -f "$tmp"
  ok "chave nova gerada em $CHAVE ($DONO, 400)"
  aviso "GUARDE UMA CÓPIA DESTA CHAVE FORA DO SERVIDOR (cofre do Painel do Servidor ou gerenciador de senhas). Sem ela o cofre não abre. Para ver e copiar: cat $CHAVE"
else
  echo "  faria: gerar $CHAVE com openssl rand -hex 32 ($DONO, 400) — e aí guardar uma cópia fora do servidor"
fi

# ---------------------------------------------------------------------------------------------------------------------
etapa "4. cliente Google (login com Google)"
FALTA_GOOGLE=0
for f in google_client_id google_client_secret; do
  if [ -s "$SEC/$f" ]; then
    garante_segredo "$SEC/$f"
  else
    aviso "falta $SEC/$f. O servidor sobe sem ele, mas o login com Google não funciona até existir (LEIA-ME.md, 'Cliente Google')."
    FALTA_GOOGLE=1
  fi
done

# ---------------------------------------------------------------------------------------------------------------------
etapa "5. imagem $IMAGEM"
if docker image inspect "$IMAGEM" >/dev/null 2>&1; then
  ok "a imagem $IMAGEM já existe; não reconstruo por cima (para outra imagem do mesmo código: --versao $VERSAO-2)"
else
  faz docker build -f "$APP/server/Dockerfile" -t "$IMAGEM" "$APP"
fi

# ---------------------------------------------------------------------------------------------------------------------
etapa "6. compose"
if SWAP_PLUS_VERSAO=$VERSAO SWAP_PLUS_ADMIN_EMAILS=admin@exemplo.com docker compose -f "$COMPOSE" config -q; then
  ok "$COMPOSE válido (com SWAP_PLUS_VERSAO=$VERSAO; o e-mail do administrador vai na variável SWAP_PLUS_ADMIN_EMAILS da stack)"
else
  die "o compose não passou no docker compose config"
fi

# ---------------------------------------------------------------------------------------------------------------------
# Conferências dos passos à mão (só leitura).
tem_stack() { docker container inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$CONTAINER" 2>/dev/null | grep -qx swap-plus; }
tem_bloco_caddy() { grep -q '^swap\.assistentes\.si' "$CADDYFILE" 2>/dev/null; }
tem_rede_no_proxy() { grep -q 'name: swap-plus' "$PROXY_COMPOSE" 2>/dev/null; }
caddy_na_rede() { docker container inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' contabo-caddy 2>/dev/null | tr ' ' '\n' | grep -qx "$REDE"; }
proxy_pronto() { tem_rede_no_proxy && caddy_na_rede; }
tem_alvo_backup() { grep -q 'stage_swap_plus' "$BACKUP" 2>/dev/null; }
backup_iniciado() { [ -s /etc/server-contabo/secrets/restic-swap-plus.pass ] && grep -q 'run swap-plus' /etc/cron.d/contabo-backup 2>/dev/null; }
backup_pronto() { tem_alvo_backup && backup_iniciado; }
estado() { if "$@"; then printf '[feito]'; else printf '[falta]'; fi; }

etapa "7. passos à mão, nesta ordem"
cat <<EOF
  $(estado tem_stack) a) criar a stack pelo Portainer (primeiro a simulação):
        python3 $DEPLOY/portainer_stack_create_swap_plus.py --versao $VERSAO
        python3 $DEPLOY/portainer_stack_create_swap_plus.py --versao $VERSAO --apply
      Versão nova depois de instalada: LEIA-ME.md, 'Atualizar a versão'.
  [confira] b) DNS na Cloudflare: swap.assistentes.si apontando para o IP do servidor, proxied (nuvem laranja),
      sem desafio de robô para esse nome (o cliente é o Node do VS Code, não um navegador).
  $(estado tem_bloco_caddy) c) Caddy: colar o bloco no fim do Caddyfile (>> mantém o mesmo arquivo) e validar:
        cat $DEPLOY/Caddyfile.bloco >> $CADDYFILE
        docker exec contabo-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
  $(estado proxy_pronto) d) proxy: a rede swap_plus no compose do Caddy e RECRIAR o Caddy (reload não vê o arquivo):
        patch -N --dry-run $PROXY_COMPOSE < $DEPLOY/proxy-compose.patch
        patch -N $PROXY_COMPOSE < $DEPLOY/proxy-compose.patch
        python3 $STACK_UPDATE --stack contabo-proxy --compose $PROXY_COMPOSE --backup-dir /var/backups/portainer-stacks
        python3 $STACK_UPDATE --stack contabo-proxy --compose $PROXY_COMPOSE --backup-dir /var/backups/portainer-stacks --apply
      Depois: docker logs --tail 50 contabo-caddy (certificado de swap.assistentes.si) e os outros sites no ar.
  $(estado backup_pronto) e) backup: alvo swap-plus no contabo-backup, repositório novo e cron das 03:55:
        patch -N --dry-run $BACKUP < $DEPLOY/contabo-backup.patch
        patch -N $BACKUP < $DEPLOY/contabo-backup.patch && sh -n $BACKUP
        contabo-backup init
        contabo-backup run swap-plus && contabo-backup status
      (aplique o mesmo patch na cópia do contabo-backup no repositório do servidor, se houver uma)
  [confira] f) testes:
        curl -s http://127.0.0.1:$PORTA_LOCAL/v1/health
        curl -s https://swap.assistentes.si/v1/health
        docker exec $CONTAINER node -e "fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r=>r.text()).then(t=>console.log(t.match(/^ip=.*$/m)[0]))"
          (tem de mostrar o IP do próprio servidor, não o do proxy residencial)
        docker exec $CONTAINER node /app/server/src/cli.js status
  [lembrete] g) uma cópia da chave mestra ($CHAVE) FORA do servidor.
EOF
[ "$FALTA_GOOGLE" = 0 ] || echo "  [falta] h) os arquivos do cliente Google (etapa 4) e depois: docker restart $CONTAINER"

echo
if [ "$APPLY" = 1 ]; then
  echo "Pronto: etapas 1 a 6 conferidas e feitas. Siga os passos à mão acima."
else
  echo "Simulação: nada foi mudado. Para fazer as etapas 1 a 6: sh $0 --apply"
fi
