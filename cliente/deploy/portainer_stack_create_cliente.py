#!/usr/bin/env python3
"""Cria a stack `swap-plus-cliente-hermes` (Swap Plus Cliente do Hermes) no Portainer local (127.0.0.1:9443) pela API.

Feito a partir do server/deploy/portainer_stack_create_swap_plus.py. Uma stack criada pela API fica com controle total
no Portainer; criada pela linha de comando fica "Limited". Para mudar uma stack que já existe (versão nova, compose
novo) use scripts/hermes/portainer_stack_update.py do repositório do servidor; este script recusa se a stack existir.

Antes de criar, confere o que o compose espera no host (o preparar.sh e o entrar.sh/parear.sh, nesta pasta, fazem):
  · a imagem swap-plus-cliente:<versão> construída no host (a stack não baixa imagem: pull_policy never);
  · a rede externa swap-plus-cliente com a faixa 10.88.3.0/24;
  · /opt/swap-plus-cliente/hermes/dados (10000:10000, 700) com o conexao.json do cliente já conectado (10000, 600) —
    o conteúdo nunca é lido nem impresso;
  · a pasta de login (10000:10000, 700; pasta de verdade, não atalho);
  · nenhum contêiner swap-plus-cliente-hermes solto (o nome é fixo no compose).

Lê a senha admin em /etc/server-contabo/secrets/portainer-admin-password. Nunca imprime senha, token nem segredo.
Sem --apply é só simulação.

Uso (root, no servidor):
  python3 /opt/swap-plus/app/cliente/deploy/portainer_stack_create_cliente.py --versao 1.0.0            # simulação
  python3 /opt/swap-plus/app/cliente/deploy/portainer_stack_create_cliente.py --versao 1.0.0 --apply
  ... --login-dir /srv/hermes-personal/data/swap-plus-login     # pasta de login dentro dos dados do Hermes
  ... --presenca sempre                                         # padrão: auto
"""
import argparse
import hashlib
import json
import os
import re
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
DADOS = "/opt/swap-plus-cliente/hermes/dados"
LOGIN_PADRAO = "/opt/swap-plus-cliente/hermes/login"
REDE = "swap-plus-cliente"
SUBREDE = "10.88.3.0/24"
CONTAINER = "swap-plus-cliente-hermes"
DONO = (10000, 10000)  # o usuário do Hermes


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
    """(ok, texto) conferindo tipo (sem seguir atalho), dono 10000:10000 e modo."""
    try:
        st = os.lstat(caminho)
    except FileNotFoundError:
        return False, f"{caminho}: NÃO existe"
    if stat.S_ISLNK(st.st_mode):
        return False, f"{caminho}: é um atalho (link simbólico); tem de ser {'pasta' if pasta else 'arquivo'} de verdade"
    if pasta != stat.S_ISDIR(st.st_mode):
        return False, f"{caminho}: devia ser {'pasta' if pasta else 'arquivo'}"
    atual = (st.st_uid, st.st_gid), stat.S_IMODE(st.st_mode)
    if atual != (DONO, modo):
        return False, (f"{caminho}: dono {st.st_uid}:{st.st_gid}, modo {stat.S_IMODE(st.st_mode):o}"
                       f" (esperava {DONO[0]}:{DONO[1]}, {modo:o})")
    return True, f"{caminho}: ok ({DONO[0]}:{DONO[1]}, {modo:o})"


def conferir_host(versao, login):
    """Lista de (ok, texto)."""
    itens = []
    rc, _ = docker("image", "inspect", f"swap-plus-cliente:{versao}")
    itens.append((rc == 0, f"imagem swap-plus-cliente:{versao}: " + ("ok" if rc == 0 else "NÃO existe (preparar.sh --apply)")))

    rc, sub = docker("network", "inspect", "-f", "{{range .IPAM.Config}}{{.Subnet}} {{end}}", REDE)
    if rc != 0:
        itens.append((False, f"rede {REDE}: NÃO existe (preparar.sh --apply)"))
    else:
        itens.append((sub.split() == [SUBREDE], f"rede {REDE}: faixa {sub or '?'}" + ("" if sub.split() == [SUBREDE] else f" (esperava {SUBREDE})")))

    itens.append(dono_modo(DADOS, 0o700, pasta=True))
    ok, txt = dono_modo(os.path.join(DADOS, "conexao.json"), 0o600, pasta=False)
    itens.append((ok, txt if ok else txt + " — conecte o cliente antes (entrar.sh ou parear.sh)"))
    itens.append(dono_modo(login, 0o700, pasta=True))

    rc, _ = docker("container", "inspect", CONTAINER)
    itens.append((rc != 0, f"contêiner {CONTAINER}: " + ("nenhum ainda (ok)" if rc != 0 else "JÁ EXISTE fora da stack; remova-o antes (o nome é fixo no compose)")))
    return itens


def esperar_saude(segundos=150):
    """Espera o healthcheck da imagem (o comando `saude` do cliente) dizer healthy."""
    fim = time.monotonic() + segundos
    estado = "?"
    while time.monotonic() < fim:
        rc, estado = docker("inspect", "-f", "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{end}}", CONTAINER)
        if rc == 0 and estado.strip() == "running healthy":
            return True, "no ar: running healthy"
        time.sleep(3)
    return False, f"ainda não ficou saudável em {segundos} s (estado: {estado or '?'}); veja `docker logs {CONTAINER}`"


def main():
    ap = argparse.ArgumentParser(description="Cria a stack swap-plus-cliente-hermes no Portainer local pela API.")
    ap.add_argument("--stack", default="swap-plus-cliente-hermes")
    ap.add_argument("--compose", default=os.path.join(APP, "cliente", "deploy", "compose.yaml"))
    ap.add_argument("--versao", required=True, help="etiqueta da imagem, X.Y.Z ou X.Y.Z-N (vira SWAP_PLUS_CLIENTE_VERSAO)")
    ap.add_argument("--login-dir", default="", help="pasta de login no host, se não for a padrão (vira SWAP_PLUS_CLIENTE_LOGIN_DIR)")
    ap.add_argument("--presenca", default="", choices=["", "auto", "sempre"], help="vira SWAP_PLUS_CLIENTE_PRESENCA (padrão do compose: auto)")
    ap.add_argument("--modelos", default="", help="vira SWAP_PLUS_CLIENTE_MODELOS (opcional)")
    ap.add_argument("--apply", action="store_true")
    a = ap.parse_args()

    if not re.fullmatch(r"\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?", a.versao):
        sys.exit(f"versão inválida: {a.versao!r} (use X.Y.Z ou X.Y.Z-N; nunca `latest`)")
    login = os.path.normpath(a.login_dir) if a.login_dir else LOGIN_PADRAO
    if not os.path.isabs(login) or not re.fullmatch(r"[A-Za-z0-9._/-]+", login):
        sys.exit(f"pasta de login inválida: {login!r} (caminho absoluto, sem espaços)")
    if a.modelos and not re.fullmatch(r"[A-Za-z0-9._,\[\]-]+", a.modelos):
        sys.exit("modelos inválidos (ids separados por vírgula, sem espaços)")
    with open(a.compose, encoding="utf-8") as fh:
        compose = fh.read()
    if "${SWAP_PLUS_CLIENTE_VERSAO" not in compose or f"container_name: {CONTAINER}" not in compose:
        sys.exit(f"{a.compose} não usa a variável SWAP_PLUS_CLIENTE_VERSAO ou não cria o contêiner {CONTAINER}; é o compose errado?")
    if a.login_dir and "${SWAP_PLUS_CLIENTE_LOGIN_DIR" not in compose:
        sys.exit(f"{a.compose} não usa a variável SWAP_PLUS_CLIENTE_LOGIN_DIR; atualize o código antes")
    print(f"compose: {a.compose} (sha256 {hashlib.sha256(compose.encode()).hexdigest()[:12]})")

    faltas = []
    for ok, txt in conferir_host(a.versao, login):
        print(("  ok    " if ok else "  FALTA ") + txt)
        if not ok:
            faltas.append(txt)

    env = [{"name": "SWAP_PLUS_CLIENTE_VERSAO", "value": a.versao}]
    if a.login_dir:
        env.append({"name": "SWAP_PLUS_CLIENTE_LOGIN_DIR", "value": login})
    if a.presenca:
        env.append({"name": "SWAP_PLUS_CLIENTE_PRESENCA", "value": a.presenca})
    if a.modelos:
        env.append({"name": "SWAP_PLUS_CLIENTE_MODELOS", "value": a.modelos})

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
    print(f"vai criar a stack {a.stack} no ambiente {eid} ({endpoints[0]['Name']}) com " + ", ".join(f"{e['name']}={e['value']}" for e in env))

    if not a.apply:
        if faltas:
            print(f"simulação; nada criado. Com --apply eu recusaria: {len(faltas)} pendência(s) acima (FALTA)")
            sys.exit(1)
        print("simulação; nada criado")
        return
    if faltas:
        sys.exit(f"não crio a stack: {len(faltas)} pendência(s) acima (FALTA)")
    body = {"name": a.stack, "stackFileContent": compose, "env": env, "fromAppTemplate": False}
    try:
        s = api(token, "POST", f"/api/stacks/create/standalone/string?endpointId={eid}", body)
    except urllib.error.HTTPError as e:
        sys.exit(f"criação falhou: HTTP {e.code} {e.read().decode(errors='replace')[:800]}")
    print(f"stack criada: id {s['Id']}, status {s.get('Status')}")
    ok, txt = esperar_saude()
    print(txt)
    print(f"confira com `docker exec {CONTAINER} swap-plus-cliente status` e `docker logs {CONTAINER}`")
    if not ok:
        sys.exit(1)


if __name__ == "__main__":
    main()
