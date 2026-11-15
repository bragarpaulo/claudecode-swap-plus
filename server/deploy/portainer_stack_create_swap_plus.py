#!/usr/bin/env python3
"""Cria a stack `swap-plus` (Swap Plus Servidor) no Portainer local (127.0.0.1:9443) pela API — 14/11/2026.

Feito a partir do scripts/openbot/portainer_stack_create.py do servidor. Serve para a primeira instalação e para a
RECUPERAÇÃO (stack perdida ou servidor novo): uma stack criada pela API fica com controle total no Portainer, e uma
criada pela linha de comando fica "Limited" (regra do Paulo, 09/11/2026). Para mudar uma stack que já existe (versão
nova, compose novo) use scripts/hermes/portainer_stack_update.py do repositório do servidor; este script recusa se a
stack existir.

Antes de criar, confere o que o compose espera no host (o instalar.sh, nesta mesma pasta, prepara tudo):
  · a imagem swap-plus:<versão> construída no host (a stack não baixa imagem: pull_policy never);
  · a rede externa swap-plus com a faixa 172.26.0.0/24;
  · /opt/swap-plus/data (1000:1000, 700) e /etc/swap-plus/secrets (1000:1000, 700) com a chave mestra
    swap_plus_master_key (1000:1000, 400; 64 caracteres hex) — o formato é conferido, o conteúdo nunca é impresso;
  · nenhum container swap-plus solto (o nome é fixo no compose) e a porta 127.0.0.1:14950 livre.
Os arquivos do cliente Google (google_client_id, google_client_secret) faltando só dão aviso: o servidor sobe sem eles,
mas o login com Google só funciona depois que existirem e o container for reiniciado.

Lê a senha admin em /etc/server-contabo/secrets/portainer-admin-password. Nunca imprime senha, token nem segredo.
Sem --apply é só simulação.

Uso (root, no servidor):
  python3 /opt/swap-plus/app/server/deploy/portainer_stack_create_swap_plus.py --versao 2.0.0            # simulação
  python3 /opt/swap-plus/app/server/deploy/portainer_stack_create_swap_plus.py --versao 2.0.0 --apply

Na recuperação, a versão do --versao não pode ser mais antiga que a do backup restaurado (o imagem.txt do snapshot
diz qual era). Passos em server/deploy/LEIA-ME.md.
"""
import argparse
import base64
import binascii
import errno
import hashlib
import json
import os
import re
import socket
import ssl
import stat
import subprocess
import sys
import time
import urllib.error
import urllib.request

BASE = "https://127.0.0.1:9443"
SECRET = "/etc/server-contabo/secrets/portainer-admin-password"
APP = "/opt/swap-plus/app"
DATA_DIR = "/opt/swap-plus/data"
SECRETS_DIR = "/etc/swap-plus/secrets"
MASTER_KEY = os.path.join(SECRETS_DIR, "swap_plus_master_key")
GOOGLE_FILES = ("google_client_id", "google_client_secret")
REDE = "swap-plus"
SUBREDE = "172.26.0.0/24"
CONTAINER = "swap-plus"
PORTA_LOCAL = 14950
DONO = (1000, 1000)  # usuário node da imagem


def api(token, method, path, body=None, timeout=600):
    ctx = ssl._create_unverified_context()
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, method=method, headers=headers)
    with urllib.request.urlopen(req, context=ctx, timeout=timeout) as r:
        raw = r.read()
        return json.loads(raw) if raw else None


def docker(*args):
    r = subprocess.run(["docker", *args], capture_output=True, text=True)
    return r.returncode, r.stdout.strip()


def dono_modo(caminho, modo, pasta):
    """(ok, texto) conferindo tipo, dono 1000:1000 e modo."""
    try:
        st = os.stat(caminho)
    except FileNotFoundError:
        return False, f"{caminho}: NÃO existe"
    if pasta != stat.S_ISDIR(st.st_mode):
        return False, f"{caminho}: devia ser {'pasta' if pasta else 'arquivo'}"
    atual = (st.st_uid, st.st_gid), stat.S_IMODE(st.st_mode)
    if atual != (DONO, modo):
        return False, (f"{caminho}: dono {st.st_uid}:{st.st_gid}, modo {stat.S_IMODE(st.st_mode):o}"
                       f" (esperava {DONO[0]}:{DONO[1]}, {modo:o}; o instalar.sh --apply acerta)")
    return True, f"{caminho}: ok ({DONO[0]}:{DONO[1]}, {modo:o})"


def chave_valida(caminho):
    """Mesmo critério do server/src/store.js: 64 hex ou base64 de 32 bytes. Não guarda nem imprime o conteúdo."""
    with open(caminho, encoding="utf-8", errors="replace") as fh:
        bruto = fh.read().strip()
    if re.fullmatch(r"[0-9a-fA-F]{64}", bruto):
        return True
    try:
        return len(base64.b64decode(bruto, validate=True)) == 32
    except (binascii.Error, ValueError):
        return False


def porta_livre(porta):
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind(("127.0.0.1", porta))
        return True
    except OSError as e:
        if e.errno == errno.EADDRINUSE:
            return False
        raise
    finally:
        s.close()


def conferir_host(versao):
    """Lista de (obrigatório, ok, texto)."""
    itens = []

    rc, _ = docker("image", "inspect", f"swap-plus:{versao}")
    itens.append((True, rc == 0, f"imagem swap-plus:{versao}: " + ("ok" if rc == 0 else
                  "NÃO existe (construa com o instalar.sh --apply)")))

    rc, sub = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", REDE)
    if rc != 0:
        itens.append((True, False, f"rede {REDE}: NÃO existe (o instalar.sh --apply cria)"))
    else:
        itens.append((True, sub.split() == [SUBREDE], f"rede {REDE}: faixa {sub or '?'}"
                      + ("" if sub.split() == [SUBREDE] else f" (esperava {SUBREDE})")))

    ok, txt = dono_modo(DATA_DIR, 0o700, pasta=True)
    if ok and os.path.exists(os.path.join(DATA_DIR, "store.enc")):
        txt += "; já tem um cofre store.enc (recuperação: ele precisa abrir com a chave de agora)"
    itens.append((True, ok, txt))
    itens.append((True, *dono_modo(SECRETS_DIR, 0o700, pasta=True)))

    ok, txt = dono_modo(MASTER_KEY, 0o400, pasta=False)
    if ok:
        ok = chave_valida(MASTER_KEY)
        txt = (f"{MASTER_KEY}: ok (1000:1000, 400; formato válido)" if ok else
               f"{MASTER_KEY}: formato inválido (esperava 64 caracteres hex); conteúdo não mostrado")
    itens.append((True, ok, txt))

    for nome in GOOGLE_FILES:
        caminho = os.path.join(SECRETS_DIR, nome)
        ok, txt = dono_modo(caminho, 0o400, pasta=False)
        if ok and os.path.getsize(caminho) == 0:
            ok, txt = False, f"{caminho}: vazio"
        itens.append((False, ok, txt + ("" if ok else " — o login com Google não vai funcionar até existir")))

    rc, _ = docker("container", "inspect", CONTAINER)
    itens.append((True, rc != 0, f"container {CONTAINER}: " + ("nenhum ainda (ok)" if rc != 0 else
                  "JÁ EXISTE fora da stack; remova-o antes (o nome é fixo no compose)")))

    livre = porta_livre(PORTA_LOCAL)
    itens.append((True, livre, f"porta 127.0.0.1:{PORTA_LOCAL}: " + ("livre" if livre else "EM USO por outro programa")))
    return itens


def esperar_saude(segundos=60):
    """Espera o /v1/health responder pela porta local (sem proxy nenhum no caminho)."""
    abridor = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    fim = time.monotonic() + segundos
    while time.monotonic() < fim:
        try:
            with abridor.open(f"http://127.0.0.1:{PORTA_LOCAL}/v1/health", timeout=3) as r:
                info = json.loads(r.read() or b"{}")
            return f"no ar: /v1/health respondeu (versão {info.get('version', '?')})"
        except (OSError, ValueError):
            time.sleep(2)
    return "o /v1/health ainda não respondeu em 60 s; veja `docker logs swap-plus`"


def main():
    ap = argparse.ArgumentParser(description="Cria a stack swap-plus no Portainer local pela API.")
    ap.add_argument("--stack", default="swap-plus")
    ap.add_argument("--compose", default=os.path.join(APP, "server", "deploy", "compose.yaml"))
    ap.add_argument("--versao", required=True,
                    help="etiqueta da imagem, X.Y.Z ou X.Y.Z-N (vira a variável SWAP_PLUS_VERSAO da stack)")
    ap.add_argument("--admin", required=True,
                    help="e-mail(s) Google do administrador do painel, separados por vírgula (vira SWAP_PLUS_ADMIN_EMAILS; fica só no Portainer)")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", a.versao):
        sys.exit(f"versão inválida: {a.versao!r} (use X.Y.Z ou X.Y.Z-N; nunca `latest`)")
    with open(a.compose, encoding="utf-8") as fh:
        compose = fh.read()
    if "${SWAP_PLUS_VERSAO" not in compose or "container_name: swap-plus" not in compose:
        sys.exit(f"{a.compose} não usa a variável SWAP_PLUS_VERSAO ou não cria o container swap-plus; é o compose errado?")
    print(f"compose: {a.compose} (sha256 {hashlib.sha256(compose.encode()).hexdigest()[:12]})")

    faltas = []
    for obrigatorio, ok, txt in conferir_host(a.versao):
        print(("  ok    " if ok else ("  FALTA " if obrigatorio else "  aviso ")) + txt)
        if obrigatorio and not ok:
            faltas.append(txt)

    with open(SECRET) as fh:
        pw = fh.read().strip()
    token = api(None, "POST", "/api/auth", {"Username": "admin", "Password": pw})["jwt"]
    del pw

    if any(s["Name"] == a.stack for s in api(token, "GET", "/api/stacks")):
        sys.exit(f"a stack {a.stack} já existe; para mudá-la use scripts/hermes/portainer_stack_update.py")
    endpoints = api(token, "GET", "/api/endpoints")
    if len(endpoints) != 1:
        sys.exit(f"esperava um ambiente no Portainer e há {len(endpoints)}: {[e['Name'] for e in endpoints]}")
    eid = endpoints[0]["Id"]
    print(f"vai criar a stack {a.stack} no ambiente {eid} ({endpoints[0]['Name']}) com SWAP_PLUS_VERSAO={a.versao}")

    if not a.apply:
        if faltas:
            print(f"simulação; nada criado. Com --apply eu recusaria: {len(faltas)} pendência(s) acima (FALTA)")
            sys.exit(1)
        print("simulação; nada criado")
        return
    if faltas:
        sys.exit(f"não crio a stack: {len(faltas)} pendência(s) acima (FALTA); rode o instalar.sh --apply antes")
    body = {
        "name": a.stack,
        "stackFileContent": compose,
        "env": [{"name": "SWAP_PLUS_VERSAO", "value": a.versao}, {"name": "SWAP_PLUS_ADMIN_EMAILS", "value": a.admin}],
        "fromAppTemplate": False,
    }
    try:
        s = api(token, "POST", f"/api/stacks/create/standalone/string?endpointId={eid}", body)
    except urllib.error.HTTPError as e:
        sys.exit(f"criação falhou: HTTP {e.code} {e.read().decode(errors='replace')[:800]}")
    print(f"stack criada: id {s['Id']}, status {s.get('Status')}")
    print(esperar_saude())
    print("confira com `docker ps --filter name=swap-plus`, `docker logs swap-plus` e "
          "`docker exec swap-plus node /app/server/src/cli.js status`")


if __name__ == "__main__":
    main()
