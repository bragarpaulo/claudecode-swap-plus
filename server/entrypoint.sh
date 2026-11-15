#!/bin/sh
# Ponto de entrada do container do Swap Plus Servidor.
# - TLS_MODE=self: gera o certificado próprio na primeira vez (EC P-256, 10 anos,
#   SAN = PUBLIC_HOST) e mostra a impressão digital que os computadores vão fixar.
#   Gera em *.tmp, confere e só então põe no lugar (nunca fica meio certificado).
# - Depois entrega o processo para o Node (exec: o tini repassa o SIGTERM direto).
set -eu

DATA_DIR="${DATA_DIR:-/data}"
TLS_MODE="${TLS_MODE:-self}"
MASTER_KEY_FILE="${MASTER_KEY_FILE:-/run/secrets/swap_plus_master_key}"
TLS_DIR="$DATA_DIR/tls"

umask 077
mkdir -p "$DATA_DIR"

if [ ! -r "$MASTER_KEY_FILE" ]; then
  echo "[início] não achei a chave mestra em $MASTER_KEY_FILE (ou ela não pode ser lida pelo usuário node, uid 1000)." >&2
  echo "[início] crie uma no servidor com:  (umask 077; openssl rand -hex 32 > swap_plus_master_key)" >&2
  echo "[início] e monte no container (secret do Docker ou -v ...:$MASTER_KEY_FILE:ro). Guarde uma cópia fora do servidor." >&2
  exit 1
fi

if [ "$TLS_MODE" = "self" ]; then
  if [ ! -s "$TLS_DIR/cert.pem" ] || [ ! -s "$TLS_DIR/key.pem" ]; then
    if [ -z "${PUBLIC_HOST:-}" ]; then
      echo "[tls] defina PUBLIC_HOST (IP ou nome do servidor) para gerar o certificado próprio" >&2
      exit 1
    fi
    case "$PUBLIC_HOST" in
      *:*) SAN="IP:$PUBLIC_HOST" ;;       # IPv6
      *[!0-9.]*) SAN="DNS:$PUBLIC_HOST" ;; # nome
      *) SAN="IP:$PUBLIC_HOST" ;;          # IPv4
    esac
    mkdir -p "$TLS_DIR"
    KEY_TMP="$TLS_DIR/key.pem.tmp"
    CERT_TMP="$TLS_DIR/cert.pem.tmp"
    rm -f "$KEY_TMP" "$CERT_TMP"
    if ! openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes \
      -keyout "$KEY_TMP" -out "$CERT_TMP" -days 3650 \
      -subj "/CN=swap-plus" -addext "subjectAltName=$SAN"; then
      rm -f "$KEY_TMP" "$CERT_TMP"
      echo "[tls] não consegui gerar o certificado próprio (openssl falhou)" >&2
      exit 1
    fi
    # Confere antes de pôr no lugar: os dois existem, o certificado lê e a chave é dele.
    CERT_PUB=$(openssl x509 -in "$CERT_TMP" -noout -pubkey 2>/dev/null || true)
    KEY_PUB=$(openssl pkey -in "$KEY_TMP" -pubout 2>/dev/null || true)
    if [ ! -s "$KEY_TMP" ] || [ ! -s "$CERT_TMP" ] || [ -z "$CERT_PUB" ] || [ "$CERT_PUB" != "$KEY_PUB" ]; then
      rm -f "$KEY_TMP" "$CERT_TMP"
      echo "[tls] o certificado gerado não confere (vazio, ilegível ou de outra chave); nada foi trocado" >&2
      exit 1
    fi
    # Um par incompleto não serve: tira o que sobrou antes de pôr o novo (se cair no meio, a próxima subida gera de novo).
    rm -f "$TLS_DIR/cert.pem" "$TLS_DIR/key.pem"
    mv -f "$KEY_TMP" "$TLS_DIR/key.pem"
    mv -f "$CERT_TMP" "$TLS_DIR/cert.pem"
    echo "[tls] certificado próprio gerado em $TLS_DIR ($SAN, válido por 10 anos)"
  fi
  FP=$(openssl x509 -in "$TLS_DIR/cert.pem" -noout -fingerprint -sha256 2>/dev/null | sed 's/^[^=]*=//' || true)
  # SHA-256 = 32 bytes em hex separados por ":" → 95 caracteres.
  case "$FP" in
    *[!0-9A-Fa-f:]*) FP="" ;;
  esac
  if [ -z "$FP" ] || [ "${#FP}" -ne 95 ]; then
    echo "[tls] não consegui ler a impressão digital de $TLS_DIR/cert.pem (certificado inválido?)." >&2
    echo "[tls] apague $TLS_DIR e reinicie para gerar outro (os computadores vão precisar de um código de conexão novo)." >&2
    exit 1
  fi
  echo "[tls] impressão digital (SHA-256) do certificado: $FP"
fi

exec node /app/server/src/server.js
