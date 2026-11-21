#!/usr/bin/env python3
"""Aviso de limite do Hermes para o Swap Plus (HERMES_CLAUDE_SWAP_LIMIT_NOTICE_V1).

Mexe em /opt/data/extra_pkgs/hermes_model_lock.py: ao armar a espera por limite no provedor do Claude Code, o Hermes
passa a deixar um recado em <pasta de login>/swap-plus/limite.json, que o Swap Plus Cliente (1.1.0+) lê e leva ao
servidor. Rodar DENTRO do contêiner do Hermes, como o usuário do gateway (uid 10000), com o Python do Hermes:

  docker exec -i -u 10000 -w /opt/hermes hermes /opt/hermes/.venv/bin/python - simular < hermes_aviso_limite.py
  docker exec -i -u 10000 -w /opt/hermes hermes /opt/hermes/.venv/bin/python - aplicar < hermes_aviso_limite.py

simular: monta o arquivo novo numa pasta temporária e o exercita contra o código de verdade do Hermes, num processo à
         parte (o gateway não é tocado; o recado vai para a pasta temporária). Não muda nada.
aplicar: guarda uma cópia do arquivo atual e grava o novo. Só vale depois de reiniciar o gateway.
"""
import hashlib
import importlib.util
import json
import os
import py_compile
import shutil
import sys
import tempfile
import time

ALVO = "/opt/data/extra_pkgs/hermes_model_lock.py"
COPIA = ALVO + ".antes-aviso-limite-20261121"
SHA_ANTES = "4c23f7e07bbb9b2f"  # começo do sha256 do arquivo sobre o qual esta mudança foi escrita
MARCA = "HERMES_CLAUDE_SWAP_LIMIT_NOTICE_V1"

TROCAS = [
    # 1) cabeçalho
    (
        '''  seguinte, se o login já é de OUTRA conta, a espera é encerrada e a conversa volta ao modelo principal.
"""
''',
        '''  seguinte, se o login já é de OUTRA conta, a espera é encerrada e a conversa volta ao modelo principal.

21/11/2026 à tarde (pedido do Paulo: o Hermes também tem de receber o "troquei, pode continuar"):
- HERMES_CLAUDE_SWAP_LIMIT_NOTICE_V1 (``_swap_limit_notice``): o Claude Code do Hermes roda sem
  transcrição, então o Swap Plus não ficava sabendo do limite e a conta só trocava quando outro serviço
  avisasse. Agora, ao armar a espera, o Hermes deixa um recado na pasta de login; o Swap Plus Cliente
  (1.1.0+) lê em até 30 s, avisa o servidor e grava a conta nova, e a regra acima devolve a conversa ao
  modelo principal.
"""
''',
    ),
    # 2) a pasta de login vira função própria; o recado
    (
        '''def _swap_account_id():
    """Identidade da conta do Claude Code que está no login mantido pelo Swap Plus Cliente (a pasta
    ``claude_config_dir`` do plugin), ou None quando não dá para saber."""
    try:
        from hermes_cli.config import load_config_readonly
        node = load_config_readonly()
        for segment in ("plugins", "entries", CLAUDE_CODE_PLUGIN_ID, "settings", "claude_config_dir"):
            node = node[segment]
        with open(os.path.join(str(node), ".claude.json"), encoding="utf-8") as handle:
            account = json.load(handle).get("oauthAccount") or {}
        return str(account.get("accountUuid") or account.get("emailAddress") or "") or None
    except Exception:
        return None
''',
        '''def _swap_login_dir():
    """Pasta de login do Claude Code mantida pelo Swap Plus Cliente (``claude_config_dir`` do plugin), ou None."""
    try:
        from hermes_cli.config import load_config_readonly
        node = load_config_readonly()
        for segment in ("plugins", "entries", CLAUDE_CODE_PLUGIN_ID, "settings", "claude_config_dir"):
            node = node[segment]
        return str(node) or None
    except Exception:
        return None


def _swap_account_id():
    """Identidade da conta do Claude Code que está no login mantido pelo Swap Plus Cliente (a pasta
    ``claude_config_dir`` do plugin), ou None quando não dá para saber."""
    try:
        with open(os.path.join(_swap_login_dir(), ".claude.json"), encoding="utf-8") as handle:
            account = json.load(handle).get("oauthAccount") or {}
        return str(account.get("accountUuid") or account.get("emailAddress") or "") or None
    except Exception:
        return None


def _swap_limit_notice(reset_at=None) -> bool:
    """HERMES_CLAUDE_SWAP_LIMIT_NOTICE_V1 — avisa o Swap Plus que a conta do Claude Code bateu o limite.

    O Claude Code do Hermes roda sem transcrição: o Swap Plus Cliente não vê o erro. Aqui o Hermes deixa um
    recado em ``<pasta de login>/swap-plus/limite.json``; o cliente (1.1.0+) lê a cada 30 s, avisa o servidor
    (``limit_hit``) e grava a conta nova. A volta ao modelo principal é ``apply_swap_account_recovery`` (a
    conta do login mudou). O recado não diz qual limite foi (o Hermes só sabe que bateu): o cliente decide
    pelo uso da conta. Nunca lança; True quando gravou."""
    try:
        base = _swap_login_dir()
        if not base:
            return False
        folder = os.path.join(base, "swap-plus")
        os.makedirs(folder, exist_ok=True)
        notice = {"at": int(time.time() * 1000), "text": "", "from": "hermes"}
        if isinstance(reset_at, (int, float)) and not isinstance(reset_at, bool) and reset_at > 0:
            notice["resetsAt"] = int(reset_at * 1000 if reset_at < 1e11 else reset_at)
        temp = os.path.join(folder, "limite.json.%d.tmp" % os.getpid())
        with open(temp, "w", encoding="utf-8") as handle:
            json.dump(notice, handle)
        os.replace(temp, os.path.join(folder, "limite.json"))
        return True
    except Exception:
        return False
''',
    ),
    # 3) ao armar a espera: deixa o recado
    (
        '''            if seconds is not None and _is_claude_code(primary):
                agent._swap_account_at_limit = _swap_account_id()
''',
        '''            if seconds is not None and _is_claude_code(primary):
                agent._swap_account_at_limit = _swap_account_id()
                if _swap_limit_notice(kwargs.get("reset_at", args[0] if args else None)):
                    logger.info("Swap limit notice written: the Swap Plus client reports the limit and the account switches")
''',
    ),
]


def novo_texto(atual):
    if MARCA in atual:
        raise SystemExit("o arquivo já tem a mudança (%s); nada a fazer" % MARCA)
    texto = atual
    for i, (de, para) in enumerate(TROCAS, 1):
        if texto.count(de) != 1:
            raise SystemExit("trecho %d: esperava achar 1 vez, achei %d — o arquivo não é o que eu li; não mexo" % (i, texto.count(de)))
        texto = texto.replace(de, para)
    return texto


def simular(caminho):
    """Exercita o arquivo novo contra o código de verdade do Hermes, neste processo (o gateway é outro processo)."""
    from agent import agent_runtime_helpers as helpers
    from agent import fallback_cooldown as cooldown

    # Se este processo já carregou a trava de verdade, tira os embrulhos dela antes (só aqui, na memória).
    atual = helpers._primary_quota_reopened_early
    if getattr(atual, "_livia_swap_recovery", False):
        helpers._primary_quota_reopened_early = atual._livia_swap_recovery_original
        cooldown._arm_rate_limit_cooldown = cooldown._arm_rate_limit_cooldown._livia_swap_recovery_original
        print("  (a trava de verdade já estava carregada neste processo: desfeita só na memória daqui)")

    spec = importlib.util.spec_from_file_location("hermes_model_lock_simulado", caminho)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)

    pasta = tempfile.mkdtemp(prefix="aviso-limite-")
    conta = {"id": "conta-A"}
    mod._swap_login_dir = lambda: pasta  # o recado vai para a pasta temporária, nunca para a de verdade
    mod._swap_account_id = lambda: conta["id"]
    assert mod.apply_swap_account_recovery() is True

    razao = next(iter(cooldown._RATE_LIMIT_FAILOVER_REASONS))
    recado = os.path.join(pasta, "swap-plus", "limite.json")

    class Agente:
        pass

    def agente(provedor):
        a = Agente()
        a.provider = provedor
        a._primary_runtime = {"provider": provedor}
        a._fallback_activated = False
        a._rate_limit_backoff_count = 0
        return a

    # a) Claude Code bate o limite: a espera é armada e o recado é gravado
    a = agente("claude-subscription-directsdk-experimental")
    antes = int(time.time() * 1000)
    renova = time.time() + 3600
    segundos = cooldown._arm_rate_limit_cooldown(a, razao, reset_at=renova)
    assert segundos is not None and segundos > 0, segundos
    assert a._swap_account_at_limit == "conta-A"
    dados = json.load(open(recado, encoding="utf-8"))
    assert antes <= dados["at"] <= int(time.time() * 1000) + 1, dados
    assert dados["text"] == "" and dados["from"] == "hermes", dados
    assert abs(dados["resetsAt"] - renova * 1000) < 2000, dados
    assert sorted(os.listdir(os.path.dirname(recado))) == ["limite.json"], os.listdir(os.path.dirname(recado))
    print("  a) limite no Claude Code: espera de %d s armada e recado gravado: %s" % (segundos, json.dumps(dados)))

    # b) a conta do login muda: a espera acaba (regra que já existia)
    assert helpers._primary_quota_reopened_early(a, "claude-subscription-directsdk-experimental", "m", None, None) is False
    conta["id"] = "conta-B"
    assert helpers._primary_quota_reopened_early(a, "claude-subscription-directsdk-experimental", "m", None, None) is True
    print("  b) a conta do login mudou: a espera é encerrada e a conversa volta ao modelo principal")

    # c) outro provedor (Codex): nada de recado
    os.remove(recado)
    b = agente("openai-codex")
    assert cooldown._arm_rate_limit_cooldown(b, razao, reset_at=renova) is not None
    assert not os.path.exists(recado)
    assert not hasattr(b, "_swap_account_at_limit")
    print("  c) limite em outro provedor (Codex): nenhum recado")

    # d) motivo que não é limite: nada armado, nada gravado
    c = agente("claude-subscription-directsdk-experimental")
    assert cooldown._arm_rate_limit_cooldown(c, None) is None
    assert not os.path.exists(recado)
    print("  d) falha que não é limite: nada armado, nenhum recado")

    # e) sem pasta de login (config sem o plugin) ou pasta que não dá para gravar: não lança, a espera arma igual
    mod._swap_login_dir = lambda: None
    d = agente("claude-subscription-directsdk-experimental")
    assert cooldown._arm_rate_limit_cooldown(d, razao) is not None
    mod._swap_login_dir = lambda: "/proc/nao-existe/aqui"
    e = agente("claude-subscription-directsdk-experimental")
    assert cooldown._arm_rate_limit_cooldown(e, razao) is not None
    assert mod._swap_limit_notice() is False
    print("  e) sem pasta de login, ou sem poder gravar: a espera arma igual e nada quebra")

    # f) a pasta de login de verdade (só leitura, para conferir que a função a encontra)
    spec2 = importlib.util.spec_from_file_location("hermes_model_lock_simulado2", caminho)
    mod2 = importlib.util.module_from_spec(spec2)
    spec2.loader.exec_module(mod2)
    real = mod2._swap_login_dir()
    assert real and os.path.isdir(real), real
    assert os.access(real, os.W_OK), "o usuário do gateway não grava na pasta de login"
    print("  f) pasta de login de verdade encontrada e gravável por este usuário: %s (nada foi gravado nela)" % real)
    shutil.rmtree(pasta, ignore_errors=True)


def main():
    modo = sys.argv[1] if len(sys.argv) > 1 else ""
    if modo not in ("simular", "aplicar"):
        raise SystemExit("uso: python - simular|aplicar")
    atual = open(ALVO, encoding="utf-8").read()
    sha = hashlib.sha256(atual.encode("utf-8")).hexdigest()
    print("arquivo: %s (sha %s, uid do processo %d)" % (ALVO, sha[:16], os.getuid()))
    if not sha.startswith(SHA_ANTES):
        raise SystemExit("o arquivo mudou desde que a mudança foi escrita (esperava sha %s…); não mexo" % SHA_ANTES)
    novo = novo_texto(atual)
    tmp = tempfile.mkdtemp(prefix="trava-nova-")
    caminho = os.path.join(tmp, "hermes_model_lock.py")
    with open(caminho, "w", encoding="utf-8") as h:
        h.write(novo)
    py_compile.compile(caminho, doraise=True)
    print("arquivo novo: compila; %d linhas a mais; sha %s" % (novo.count("\n") - atual.count("\n"), hashlib.sha256(novo.encode("utf-8")).hexdigest()[:16]))
    print("simulação contra o código de verdade do Hermes:")
    simular(caminho)
    if modo == "simular":
        shutil.rmtree(tmp, ignore_errors=True)
        print("SIMULAÇÃO: tudo certo. Nada foi mudado.")
        return
    if not os.path.exists(COPIA):
        shutil.copy2(ALVO, COPIA)
    final = ALVO + ".novo"
    with open(final, "w", encoding="utf-8") as h:
        h.write(novo)
    os.chmod(final, 0o600)
    os.replace(final, ALVO)
    py_compile.compile(ALVO, doraise=True, cfile=os.path.join(tmp, "x.pyc"))
    shutil.rmtree(tmp, ignore_errors=True)
    print("APLICADO. Cópia de antes: %s. Só vale depois de reiniciar o gateway." % COPIA)


main()
