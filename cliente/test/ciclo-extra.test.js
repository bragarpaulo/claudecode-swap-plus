"use strict";
// Mais testes do ciclo do cliente (src/ciclo.js), o que o ciclo.test.js não cobre: limite visto nas transcrições,
// modelos em uso, falha de rede, falhas de gravação, bloqueios, batimento avulso, troca pedida, aviso de limite,
// rodar() e resposta estranha do servidor. Mesmo servidor de mentira e mesmas bibliotecas de verdade.
// Rodar:  node --test cliente/test/*.test.js     (TEST_LOG=1 mostra os logs do cliente)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  servidorFalso,
  montar,
  pastaTemp,
  logTeste,
  authEspiao,
  definirMtime,
  gravarTranscricao,
  linhaDeLimite,
  linhaDeModelo,
  guardarAmbiente,
  lib,
  auth,
  regras,
  modelSwitch,
  atividade,
  config,
} = require("./apoio");
const { Estado } = require("../src/estado");
const { Cliente, CICLO_MS, OCIOSO_MS, PROMOVER_MS, REGRAVAR_MS, PAUSA_403_MS, juntarModelos, mesmaIdentidade } = require("../src/ciclo");

const SEG = 1000;
const MIN = 60 * SEG;

const TXT_SESSAO = "You've hit your session limit · resets 3pm";
const TXT_SEMANAL = "You've hit your weekly limit · resets Mon 9am";
const TXT_FABLE = "You've hit your Fable limit · resets Nov 25, 12pm (America/Sao_Paulo). Switch to another model to continue.";
const TXT_PASSAGEIRO = "API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited";

async function cenario(t, opcoes = {}) {
  const servidor = await servidorFalso();
  servidor.novaConta(1);
  servidor.novaConta(2);
  servidor.atribuida = 1;
  const m = await montar({ servidor, ...opcoes });
  t.after(async () => {
    m.limpar();
    await servidor.fechar();
  });
  return { servidor, ...m };
}

const corpos = (servidor, metodo, caminho) => servidor.chamadas.filter((c) => c.metodo === metodo && c.caminho === caminho).map((c) => c.corpo);
const eventos = (servidor) => corpos(servidor, "POST", "/v1/events");
const batimentos = (servidor) => corpos(servidor, "POST", "/v1/heartbeat");

/** O Claude Code bateu num limite agora: o erro aparece numa transcrição alterada agora. */
function baterLimite(c, texto, tipo = null, nome = "sessao-1") {
  return gravarTranscricao(c.pastaClaude, { nome, linhas: [linhaDeLimite(texto, c.relogio.t, tipo)], mtime: c.relogio.t });
}

function falha(code, mensagem = `falha de teste (${code})`) {
  return Object.assign(new Error(mensagem), { code });
}

/** Log que guarda tudo o que o cliente registrou. */
function logGuardado() {
  const linhas = [];
  const guardar = (nivel) => (texto) => void linhas.push(`${nivel}: ${texto}`);
  return { linhas, debug: guardar("debug"), info: guardar("info"), warn: guardar("warn"), error: guardar("error") };
}

// ------------------------------------------------------------------ limite visto nas transcrições

test("limite da sessão visto na transcrição: avisa o servidor e, se ele trocou, grava a conta nova no mesmo ciclo", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio, lerCredencial, lerGlobal, estado } = c;
  await cliente.ciclo({ forcar: true });
  servidor.aoLimite = () => {
    servidor.atribuida = 2;
    return { switched: true, text: "trocou para a conta 2" };
  };

  relogio.t += 30 * SEG;
  baterLimite(c, TXT_SESSAO);
  const s = await cliente.ciclo();

  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite da sessão de 5h" }]);
  assert.equal(s.estado, "ok");
  assert.equal(s.presenca.ativo, true, "transcrição mexida agora = Claude Code em uso");
  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken, "a conta nova é gravada no mesmo ciclo");
  assert.equal(lerGlobal().oauthAccount.emailAddress, "conta2@exemplo.com");
  assert.equal(estado.aplicado().number, 2);
  assert.equal(servidor.contar("GET", "/v1/credential"), 2);
  const ordem = servidor.chamadas.map((x) => `${x.metodo} ${x.caminho}`).slice(-3);
  assert.deepEqual(ordem, ["POST /v1/heartbeat", "POST /v1/events", "GET /v1/credential"]);
});

test("limite visto e o servidor não trocou: avisa uma vez só e não regrava o login", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio, lerCredencial } = c;
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  const arquivo = baterLimite(c, TXT_SESSAO);
  let s = await cliente.ciclo();
  assert.equal(eventos(servidor).length, 1);
  assert.equal(s.estado, "ok");
  assert.equal(s.conta.numero, 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 1, "sem troca, nada a gravar");

  // O mesmo erro continua na transcrição nos ciclos seguintes.
  relogio.t += 30 * SEG;
  await cliente.ciclo();
  assert.equal(eventos(servidor).length, 1, "o mesmo erro não é avisado duas vezes");

  // A conversa segue (a transcrição cresce e muda de data), com o erro antigo ainda lá dentro.
  relogio.t += 30 * SEG;
  fs.appendFileSync(arquivo, JSON.stringify(linhaDeModelo("claude-opus-5-5", relogio.t)) + "\n");
  definirMtime(arquivo, relogio.t);
  await cliente.ciclo();
  assert.equal(eventos(servidor).length, 1, "o erro antigo não volta a ser avisado quando a transcrição muda");

  // Um erro novo, mais tarde, é outro aviso.
  relogio.t += 30 * SEG;
  fs.appendFileSync(arquivo, JSON.stringify(linhaDeLimite(TXT_SEMANAL, relogio.t)) + "\n");
  definirMtime(arquivo, relogio.t);
  await cliente.ciclo();
  assert.deepEqual(
    eventos(servidor).map((e) => e.label),
    ["limite da sessão de 5h", "limite semanal"]
  );
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("erro de limite anterior à subida do cliente não conta", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio, pastaClaude } = c;
  const antesDeSubir = relogio.t - MIN;
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  // A transcrição foi alterada agora, mas o erro que está nela é de antes de o cliente subir.
  gravarTranscricao(pastaClaude, { linhas: [linhaDeLimite(TXT_SESSAO, antesDeSubir)], mtime: relogio.t });
  const s = await cliente.ciclo();
  assert.equal(s.presenca.ativo, true);
  assert.deepEqual(eventos(servidor), []);
});

test('erro passageiro ("not your usage limit") não é limite da conta: nada é enviado', async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  baterLimite(c, TXT_PASSAGEIRO);
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), []);

  relogio.t += 30 * SEG;
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [], "continua sem avisar nos ciclos seguintes");

  // Um limite de verdade depois do passageiro é avisado normalmente.
  relogio.t += 30 * SEG;
  baterLimite(c, TXT_SESSAO, null, "sessao-2");
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite da sessão de 5h" }]);
});

test('limite semanal: o rótulo enviado é "limite semanal"; limite sem tipo reconhecido: "limite de uso"', async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  baterLimite(c, TXT_SEMANAL);
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite semanal" }]);

  relogio.t += 30 * SEG;
  baterLimite(c, "You've hit your limit · resets 3pm", null, "sessao-2");
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor)[1], { kind: "limit_hit", label: "limite de uso" });
});

test('limite do Fable: só avisa ("limite do Fable") quando a regra do servidor é trocar de conta', async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  await cliente.ciclo({ forcar: true });
  assert.notEqual(servidor.regras.onModelLimit, "switchAccount", "a regra padrão do servidor não é trocar de conta");

  relogio.t += 30 * SEG;
  baterLimite(c, TXT_FABLE, "seven_day_overage_included");
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [], 'regra "mesma conta": o limite do Fable não troca de conta');

  // A regra muda depois: o erro que já passou não é avisado com atraso.
  servidor.regras.onModelLimit = "switchAccount";
  relogio.t += 30 * SEG;
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), []);

  // Um erro novo, com a regra de trocar de conta, é avisado.
  servidor.aoLimite = () => {
    servidor.atribuida = 2;
    return { switched: true, text: "o Fable da conta 1 acabou" };
  };
  relogio.t += 30 * SEG;
  baterLimite(c, TXT_FABLE, "seven_day_overage_included", "sessao-2");
  const s = await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite do Fable" }]);
  assert.equal(s.conta.numero, 2);
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
});

test("limite do Fable reconhecido só pelo texto (sem o tipo gravado) segue a mesma regra", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  servidor.regras.onModelLimit = "switchAccount";
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  baterLimite(c, TXT_FABLE);
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite do Fable" }]);
});

test("limite do Opus e do Sonnet: nada é enviado, nem com a regra de trocar de conta", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  servidor.regras.onModelLimit = "switchAccount";
  await cliente.ciclo({ forcar: true });

  const casos = [
    ["You've hit your Opus limit · resets Nov 25, 12pm", "seven_day_opus"],
    ["You've hit your Sonnet limit · resets Nov 25, 12pm", "seven_day_sonnet"],
    ["You've hit your Opus limit · resets Nov 25, 12pm", null],
    ["You've reached your weekly Sonnet limit", null],
  ];
  for (const [i, [texto, tipo]] of casos.entries()) {
    relogio.t += 30 * SEG;
    baterLimite(c, texto, tipo, `sessao-${i}`);
    const s = await cliente.ciclo();
    assert.equal(s.estado, "ok");
    assert.deepEqual(eventos(servidor), [], `"${texto}" (${tipo}) não é limite da conta`);
  }
  assert.equal(servidor.contar("GET", "/v1/credential"), 1);
});

test("erro de limite na transcrição de um subagente também é avisado", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio, pastaClaude } = c;
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  gravarTranscricao(pastaClaude, { sessao: "sessao-1", nome: "agente-a1", linhas: [linhaDeLimite(TXT_SESSAO, relogio.t)], mtime: relogio.t });
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite da sessão de 5h" }]);
});

// ------------------------------------------------------------------ modelos em uso

test("modelos vistos nas transcrições vão no batimento junto com os declarados: mais recente primeiro, sem repetir", async (t) => {
  const c = await cenario(t, { modelos: "claude-opus-5-5, claude-fable-5-2" });
  const { servidor, cliente, relogio, pastaClaude } = c;
  await cliente.ciclo({ forcar: true });
  assert.deepEqual(batimentos(servidor)[0].models, ["claude-opus-5-5", "claude-fable-5-2"], "sem transcrição: só os declarados");

  relogio.t += 30 * SEG;
  gravarTranscricao(pastaClaude, { nome: "antiga", linhas: [linhaDeModelo("claude-sonnet-5")], mtime: relogio.t - 2 * MIN });
  gravarTranscricao(pastaClaude, { nome: "nova", linhas: [linhaDeModelo("claude-fable-5-2")], mtime: relogio.t });
  await cliente.ciclo();

  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2);
  assert.deepEqual(batimentos(servidor)[1].models, ["claude-fable-5-2", "claude-sonnet-5", "claude-opus-5-5"]);
});

test("juntarModelos: vistos antes dos declarados, sem repetir, só texto, no máximo 20", () => {
  assert.deepEqual(juntarModelos(["a", "b"], ["c", "a"]), ["c", "a", "b"]);
  assert.deepEqual(juntarModelos(null, undefined), []);
  assert.deepEqual(juntarModelos(["a", "", null, 7, "a"], [{}, "b"]), ["b", "a"]);
  const muitos = Array.from({ length: 30 }, (_, i) => `claude-m${i}`);
  assert.deepEqual(juntarModelos(muitos, ["claude-visto"]), ["claude-visto", ...muitos.slice(0, 19)]);
});

test("mesmaIdentidade: e-mail sem diferenciar maiúsculas; organização só conta quando os dois lados informam", () => {
  assert.equal(mesmaIdentidade({ email: "a@x.com", orgUuid: "o1" }, { email: "A@X.com", orgUuid: "o1" }), true);
  assert.equal(mesmaIdentidade({ email: "a@x.com", orgUuid: "o1" }, { email: "a@x.com", orgUuid: "o2" }), false);
  assert.equal(mesmaIdentidade({ email: "a@x.com", orgUuid: null }, { email: "a@x.com", orgUuid: "o2" }), true);
  assert.equal(mesmaIdentidade({ email: "a@x.com", orgUuid: "o1" }, { email: "a@x.com", orgUuid: null }), true);
  assert.equal(mesmaIdentidade({ email: "a@x.com", orgUuid: "o1" }, { email: "b@x.com", orgUuid: "o1" }), false);
  assert.equal(mesmaIdentidade(null, { email: "a@x.com" }), false);
  assert.equal(mesmaIdentidade({ email: "a@x.com" }, null), false);
  assert.equal(mesmaIdentidade({ email: "a@x.com" }, { email: "" }), false);
});

// ------------------------------------------------------------------ rede

test("servidor fora do ar: uma segunda tentativa depois de 2 s, situação offline, nada gravado; quando volta, o ciclo seguinte se recupera", async (t) => {
  const { servidor, cliente, relogio, esperas, lerCredencial, estado, dir } = await cenario(t);
  await servidor.fechar();

  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "offline");
  assert.equal(s.erro, "network");
  assert.ok(s.mensagem, "a situação diz o que houve");
  assert.deepEqual(esperas, [2000], "uma segunda tentativa, 2 s depois");
  assert.equal(servidor.chamadas.length, 0);
  assert.equal(lerCredencial(), null, "nada gravado na pasta de login");
  assert.equal(estado.aplicado(), null);
  assert.equal(s.ultimoContatoEm, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "situacao.json"), "utf8")).estado, "offline");

  await servidor.reabrir();
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(s.erro, null);
  assert.equal(s.ultimoContatoEm, relogio.t);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.deepEqual(esperas, [2000], "com o servidor de volta não há segunda tentativa");
});

test("a rede cai com o login já gravado: offline sem pausa, o login fica como está e a situação mostra a validade dele", async (t) => {
  const { servidor, cliente, relogio, esperas, lerCredencial } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  const antes = JSON.stringify(lerCredencial());
  servidor.foraDoAr = true; // toda conexão cai

  relogio.t += OCIOSO_MS;
  let s = await cliente.ciclo();
  assert.equal(s.estado, "offline");
  assert.equal(s.erro, "network");
  assert.deepEqual(esperas, [2000]);
  assert.equal(JSON.stringify(lerCredencial()), antes);
  assert.equal(s.acessoExpiraEm, servidor.contas[1].expiresAt);
  assert.equal(s.conta, null);

  // Falha de rede não põe o cliente em pausa: o ciclo seguinte (30 s depois) já tenta de novo.
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "offline");
  assert.deepEqual(esperas, [2000, 2000]);

  servidor.foraDoAr = false;
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(servidor.contar("GET", "/v1/state"), 1);
});

test("a rede falha uma vez e a segunda tentativa dá certo: o ciclo termina em dia", async (t) => {
  const { servidor, cliente, esperas, lerCredencial } = await cenario(t);
  servidor.derrubar = 1;
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok");
  assert.deepEqual(esperas, [2000]);
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2, "o batimento que caiu e o que deu certo");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("403: pausa de 5 min sem chamar o servidor; um ciclo forçado não espera a pausa", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.proximaFalha = { status: 403, corpo: { error: "ip_not_allowed", message: "Endereço não liberado." } };
  relogio.t += OCIOSO_MS;
  let s = await cliente.ciclo();
  assert.equal(s.estado, "offline");
  assert.equal(s.erro, "ip_not_allowed");
  assert.match(s.mensagem, /403/);
  assert.match(s.mensagem, /Endereço não liberado\./);

  const antes = servidor.chamadas.length;
  relogio.t += PAUSA_403_MS - SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "offline");
  assert.equal(servidor.chamadas.length, antes, "em pausa: não chama");

  s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok", "forçado (uma-vez, conectar) ignora a pausa");
  assert.ok(servidor.chamadas.length > antes);

  // E a pausa acabou: o ciclo normal seguinte volta a consultar.
  relogio.t += OCIOSO_MS;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(servidor.contar("GET", "/v1/state"), 2);
});

test("resposta estranha do servidor (estado sem a lista de contas): offline com erro bad_response, nada gravado", async (t) => {
  const { servidor, cliente, relogio, esperas, lerCredencial, estado } = await cenario(t);
  servidor.proximaFalha = { status: 200, corpo: { serverTime: Date.now(), version: "9.9.9", credential: { number: 1, gen: 1, expiresAt: servidor.contas[1].expiresAt }, list: { schemaVersion: 1 } } };
  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "offline");
  assert.equal(s.erro, "bad_response");
  assert.match(s.mensagem, /inesperado/);
  assert.equal(servidor.contar("GET", "/v1/credential"), 0);
  assert.equal(lerCredencial(), null);
  assert.equal(estado.aplicado(), null);
  assert.deepEqual(esperas, [], "não é falha de rede: sem segunda tentativa");

  // A resposta seguinte vem certa e o cliente segue normalmente (sem pausa).
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("credencial incompleta do servidor: offline com erro bad_response, nada gravado", async (t) => {
  const { servidor, cliente, lerCredencial, estado } = await cenario(t);
  servidor.interceptar = (rota) => (rota === "GET /v1/credential" ? { status: 200, corpo: { number: 1, gen: 1, claudeAiOauth: { accessToken: "", expiresAt: servidor.contas[1].expiresAt } } } : null);
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "offline");
  assert.equal(s.erro, "bad_response");
  assert.equal(lerCredencial(), null);
  assert.equal(estado.aplicado(), null);
});

test("o servidor ficou sem conta entre o estado e a credencial (409): situação sem_conta, nada gravado", async (t) => {
  const { servidor, cliente, lerCredencial } = await cenario(t);
  servidor.interceptar = (rota) => (rota === "GET /v1/credential" ? { status: 409, corpo: { error: "no_account", message: "Sem conta." } } : null);
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "sem_conta");
  assert.equal(lerCredencial(), null);
});

test("credencial que chega com refresh token (o servidor nunca deveria mandar): o cliente não grava o refresh token", async (t) => {
  const { servidor, cliente, lerCredencial, pastaClaude } = await cenario(t);
  servidor.interceptar = (rota) =>
    rota === "GET /v1/credential"
      ? {
          status: 200,
          corpo: {
            number: 1,
            gen: 1,
            claudeAiOauth: { accessToken: servidor.contas[1].accessToken, refreshToken: "sk-ant-ort01-NAO-GRAVAR", expiresAt: servidor.contas[1].expiresAt, scopes: ["user:inference"], outroCampo: "x" },
            oauthAccount: { emailAddress: "conta1@exemplo.com", organizationUuid: "org-1" },
          },
        }
      : null;
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok");
  assert.deepEqual(Object.keys(lerCredencial().claudeAiOauth).sort(), ["accessToken", "expiresAt", "scopes"]);
  assert.ok(!fs.readFileSync(path.join(pastaClaude, ".credentials.json"), "utf8").includes("sk-ant-ort01"));
});

// ------------------------------------------------------------------ falhas de gravação

test("gravação do login falhou: situação pendente; a mesma credencial só é tentada de novo depois de 1 min, ou na hora com forcar", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio, lerCredencial, estado } = await cenario(t, { auth: espiao });
  espiao.trocas.writeLive = async () => {
    throw falha("EACCES", "EACCES: permission denied");
  };

  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "pendente");
  assert.match(s.mensagem, /Não consegui gravar o login do Claude Code/);
  assert.match(s.mensagem, /EACCES/);
  assert.equal(espiao.chamadas.writeLive, 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 1);
  assert.equal(lerCredencial(), null);
  assert.equal(estado.aplicado(), null);

  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "pendente");
  assert.match(s.mensagem, /Não consegui gravar o login do Claude Code/, "enquanto espera, a situação continua dizendo o motivo");
  assert.equal(espiao.chamadas.writeLive, 1, "antes de 1 min não tenta a mesma credencial");
  assert.equal(servidor.contar("GET", "/v1/credential"), 1, "nem busca a credencial de novo");

  relogio.t += REGRAVAR_MS - 30 * SEG - 1;
  await cliente.ciclo();
  assert.equal(espiao.chamadas.writeLive, 1, "a 1 ms de completar 1 min ainda espera");

  relogio.t += 1;
  s = await cliente.ciclo();
  assert.equal(espiao.chamadas.writeLive, 2, "passado 1 min, tenta de novo");
  assert.equal(s.estado, "pendente");

  relogio.t += SEG;
  s = await cliente.ciclo({ forcar: true });
  assert.equal(espiao.chamadas.writeLive, 3, "forçado tenta na hora");
  assert.equal(s.estado, "pendente");

  // A gravação volta a funcionar: o ciclo normal ainda espera 1 min desde a última falha, depois grava.
  delete espiao.trocas.writeLive;
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "pendente");
  assert.equal(espiao.chamadas.writeLive, 3);
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(espiao.chamadas.writeLive, 4);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(estado.aplicado().gen, 1);
});

test("gravação falhou e o servidor renovou o acesso (gen novo): a credencial nova é tentada sem esperar 1 min", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio } = await cenario(t, { auth: espiao, presenca: "sempre" });
  espiao.trocas.writeLive = async () => {
    throw falha("ENOSPC", "ENOSPC: no space left on device");
  };
  await cliente.ciclo();
  assert.equal(espiao.chamadas.writeLive, 1);

  relogio.t += 10 * SEG;
  await cliente.ciclo();
  assert.equal(espiao.chamadas.writeLive, 1, "mesma credencial: espera");

  servidor.renovar(1);
  relogio.t += 10 * SEG;
  const s = await cliente.ciclo();
  assert.equal(espiao.chamadas.writeLive, 2, "credencial nova: tenta já");
  assert.equal(s.estado, "pendente");
});

test("gravação falhou: a troca pedida à mão (trocar) não espera 1 min", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio, lerCredencial } = await cenario(t, { auth: espiao });
  espiao.trocas.writeLive = async () => {
    throw falha("EACCES");
  };
  await cliente.ciclo({ forcar: true });
  assert.equal(espiao.chamadas.writeLive, 1);

  delete espiao.trocas.writeLive;
  relogio.t += 5 * SEG;
  const s = await cliente.trocar(1);
  assert.equal(espiao.chamadas.writeLive, 2);
  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("o login mudou durante a gravação (live_changed): pula este ciclo e tenta no seguinte, sem esperar 1 min", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio, lerCredencial } = await cenario(t, { auth: espiao });
  espiao.trocas.writeLive = async () => {
    throw falha("live_changed");
  };
  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "pendente");
  assert.match(s.mensagem, /mudou durante a gravação/);
  assert.equal(lerCredencial(), null);

  delete espiao.trocas.writeLive;
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(espiao.chamadas.writeLive, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("a identidade (.claude.json) não pôde ser gravada: o acesso fica gravado, aplicado.noIdentity, e os ciclos seguintes não regravam", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio, lerCredencial, lerGlobal, estado } = await cenario(t, { auth: espiao });
  espiao.trocas.writeOauthAccount = async () => {
    throw falha("lock_timeout", "O Claude Code está mexendo no login agora.");
  };

  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok", "o acesso foi gravado: o Claude Code funciona");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(lerGlobal(), null);
  assert.equal(estado.aplicado().noIdentity, true);
  assert.equal(estado.aplicado().number, 1);
  assert.equal(espiao.chamadas.writeLive, 1);
  assert.equal(espiao.chamadas.writeOauthAccount, 1);

  // Ciclos seguintes (parado, forçado, e com consulta ao servidor): nada mudou, não regrava a cada vez.
  for (const [passo, forcar] of [
    [30 * SEG, false],
    [30 * SEG, true],
    [OCIOSO_MS, false],
  ]) {
    relogio.t += passo;
    s = await cliente.ciclo({ forcar });
    assert.equal(s.estado, "ok");
  }
  assert.equal(espiao.chamadas.writeLive, 1, "sem a identidade gravada, e nada tendo mudado, o login não é regravado a cada ciclo");
  assert.equal(espiao.chamadas.writeOauthAccount, 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 1);

  // Mudou (gen novo): grava de novo e, desta vez, a identidade também.
  delete espiao.trocas.writeOauthAccount;
  servidor.renovar(1);
  relogio.t += OCIOSO_MS;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(espiao.chamadas.writeLive, 2);
  assert.equal(estado.aplicado().noIdentity, false);
  assert.equal(estado.aplicado().gen, 2);
  assert.equal(lerGlobal().oauthAccount.emailAddress, "conta1@exemplo.com");
});

test(".claude.json quebrado na pasta (o claudeAuth de verdade recusa gravar por cima): acesso gravado, arquivo intacto, sem regravar a cada ciclo", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio, lerCredencial, estado, pastaClaude } = await cenario(t, { auth: espiao });
  fs.mkdirSync(pastaClaude, { recursive: true });
  const global = path.join(pastaClaude, ".claude.json");
  fs.writeFileSync(global, "{ quebrado");

  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(estado.aplicado().noIdentity, true);
  assert.equal(fs.readFileSync(global, "utf8"), "{ quebrado", "o arquivo quebrado não é sobrescrito");

  relogio.t += OCIOSO_MS;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(espiao.chamadas.writeLive, 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 1);
});

test("troca de conta tira o dispositivo confiável da conta anterior; renovação da mesma conta mantém; o resto da credencial fica", async (t) => {
  const { servidor, cliente, relogio, lerCredencial, pastaClaude } = await cenario(t);
  await cliente.ciclo({ forcar: true });

  // O Claude Code guarda, na mesma credencial, coisas que não são o login (e o dispositivo confiável, que é da conta).
  const arq = path.join(pastaClaude, ".credentials.json");
  const cred = lerCredencial();
  cred.mcpOAuth = { "servidor-mcp": { accessToken: "mcp-1" } };
  cred.trustedDeviceToken = "dispositivo-da-conta-1";
  fs.writeFileSync(arq, JSON.stringify(cred));

  servidor.renovar(1);
  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(lerCredencial().trustedDeviceToken, "dispositivo-da-conta-1", "mesma conta: mantém");
  assert.deepEqual(lerCredencial().mcpOAuth, { "servidor-mcp": { accessToken: "mcp-1" } });

  servidor.atribuida = 2;
  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
  assert.ok(!("trustedDeviceToken" in lerCredencial()), "conta nova: o dispositivo confiável da anterior sai");
  assert.deepEqual(lerCredencial().mcpOAuth, { "servidor-mcp": { accessToken: "mcp-1" } });
});

// ------------------------------------------------------------------ bloqueios

test("Windows lendo o login do Gerenciador de Credenciais: não busca nem grava, situação bloqueado; outros avisos não bloqueiam", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, relogio, lerCredencial, estado } = await cenario(t, { auth: espiao });
  const avisoChave = "A variável de ambiente ANTHROPIC_API_KEY está definida: ela passa na frente do login guardado.";
  const avisoCredman = "O Claude Code está lendo o login primeiro do Gerenciador de Credenciais do Windows (CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1). A gravação seria ignorada.";
  espiao.trocas.credentialStoreWarnings = () => [avisoChave, avisoCredman];

  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "bloqueado");
  assert.equal(s.mensagem, avisoCredman);
  assert.equal(s.conta.numero, 1, "a situação ainda diz qual conta o servidor atribuiu");
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 0);
  assert.equal(espiao.chamadas.writeLive, 0);
  assert.equal(lerCredencial(), null);
  assert.equal(estado.aplicado(), null);

  espiao.trocas.credentialStoreWarnings = () => [avisoChave];
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok", "aviso que não é o do Gerenciador de Credenciais não impede a gravação");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);

  // credentialStoreWarnings que lança não derruba o ciclo.
  espiao.trocas.credentialStoreWarnings = () => {
    throw new Error("falhou ao conferir");
  };
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
});

test("o aviso de verdade do claudeAuth (Windows com CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1) bloqueia a gravação", async (t) => {
  const { servidor, cliente, lerCredencial } = await cenario(t);
  t.after(guardarAmbiente(["CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"]));
  process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
  auth._test.setPlatform("win32"); // o limpar() do cenário desfaz

  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "bloqueado");
  assert.match(s.mensagem, /Gerenciador de Credenciais/);
  assert.equal(servidor.contar("GET", "/v1/credential"), 0);
  assert.equal(lerCredencial(), null);
});

test("login atual ilegível (arquivo quebrado → live_unreadable): não busca nem grava nada, situação pendente; consertado, grava", async (t) => {
  const { servidor, cliente, relogio, pastaClaude, lerCredencial, estado } = await cenario(t);
  fs.mkdirSync(pastaClaude, { recursive: true });
  const arq = path.join(pastaClaude, ".credentials.json");
  fs.writeFileSync(arq, "{ isto não é JSON");

  let s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "pendente");
  assert.match(s.mensagem, /Não consegui ler o login atual do Claude Code/);
  assert.equal(servidor.contar("GET", "/v1/credential"), 0, "nada é buscado");
  assert.equal(servidor.contar("POST", "/v1/logins"), 0);
  assert.equal(fs.readFileSync(arq, "utf8"), "{ isto não é JSON", "o arquivo ilegível não é sobrescrito");
  assert.equal(estado.aplicado(), null);
  assert.deepEqual(batimentos(servidor)[0].live, null);

  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "pendente", "continua pendente enquanto o arquivo estiver quebrado");
  assert.equal(servidor.contar("GET", "/v1/credential"), 0);

  fs.rmSync(arq);
  relogio.t += 30 * SEG;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("readLive lançando live_unreadable (ex.: sem permissão): nada buscado nem gravado, situação pendente com o motivo", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente } = await cenario(t, { auth: espiao });
  espiao.trocas.readLive = async () => {
    throw Object.assign(falha("live_unreadable", "Não consegui ler o arquivo (EACCES)."), { reason: "EACCES" });
  };
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "pendente");
  assert.match(s.mensagem, /EACCES/);
  assert.equal(servidor.contar("GET", "/v1/credential"), 0);
  assert.equal(espiao.chamadas.writeLive, 0);
  assert.equal(espiao.chamadas.writeOauthAccount, 0);
});

// ------------------------------------------------------------------ parado: batimento avulso

test("parado e a conta deste cliente morreu: batimento avulso; o servidor decide e a conta nova é gravada no mesmo ciclo", async (t) => {
  const { servidor, cliente, relogio, lerCredencial } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 1);

  servidor.contas[1].publica.dead = true; // o estado passa a vir sem credencial
  servidor.aoBatimento = () => {
    servidor.atribuida = 2; // o servidor só decide quando o cliente conta como ativo
  };
  relogio.t += OCIOSO_MS;
  const s = await cliente.ciclo();

  assert.equal(servidor.contar("GET", "/v1/state"), 1);
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2, "batimento avulso");
  assert.equal(s.presenca.ativo, false, "continua parado: o batimento foi só para o servidor decidir");
  assert.equal(s.estado, "ok");
  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
});

test("parado e a conta foi desativada (ou pede login de novo): batimento avulso, no máximo um a cada 5 min", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });

  servidor.contas[1].publica.disabled = true;
  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2, "conta desativada: pede decisão");

  servidor.contas[1].publica.disabled = false;
  servidor.contas[1].publica.usageStatus = "relogin_required";
  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2, "menos de 5 min desde o último avulso: espera");

  relogio.t += PROMOVER_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 3, "login que precisa ser refeito: pede decisão");
});

test("parado e sem conta atribuída: batimento avulso", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.atribuida = null;
  relogio.t += OCIOSO_MS;
  const s = await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2);
  assert.equal(s.estado, "sem_conta");
});

test("parado, conta acima da linha, mas a troca automática está desligada no servidor: nenhum batimento avulso", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.trocaAutomatica = false;
  servidor.contas[1].publica.usage.fiveHour.pct = 99;
  servidor.contas[1].publica.usage.sevenDay.pct = 99;

  relogio.t += OCIOSO_MS;
  const s = await cliente.ciclo();
  assert.equal(servidor.contar("GET", "/v1/state"), 1);
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 1, "sem troca automática não há o que o servidor decidir");
  assert.equal(s.estado, "ok");

  // Mesmo com a troca automática desligada, conta desativada pede decisão.
  servidor.contas[1].publica.disabled = true;
  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2);
});

test("parado: a linha semanal, a linha própria da conta e as regras do servidor contam; abaixo da linha ou sem leitura de uso, nada de avulso", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  const uso = servidor.contas[1].publica.usage;
  let esperado = 1;
  const passo = async (texto, avulso) => {
    relogio.t += PROMOVER_MS; // longe o bastante do avulso anterior e da última consulta
    await cliente.ciclo();
    if (avulso) esperado += 1;
    assert.equal(servidor.contar("POST", "/v1/heartbeat"), esperado, texto);
  };

  uso.fiveHour.pct = 89; // linha geral da sessão: 90
  uso.sevenDay.pct = 79; // linha geral semanal: 80
  await passo("abaixo das duas linhas: nada", false);

  uso.sevenDay.pct = 80;
  await passo("semanal na linha (80): pede decisão", true);

  uso.sevenDay.pct = 20;
  uso.fiveHour.pct = 60;
  await passo("sessão em 60 com a linha geral em 90: nada", false);

  servidor.registros = { 1: { threshold: 50 } };
  await passo("linha própria da conta (50): pede decisão", true);

  servidor.registros = {};
  servidor.regras.sessionPct = 55;
  await passo("regra geral do servidor mudou para 55: pede decisão", true);

  servidor.contas[1].publica.usageStatus = "error";
  servidor.contas[1].publica.usage = null;
  await passo("sem leitura de uso: nada a decidir", false);
});

// ------------------------------------------------------------------ troca pedida e aviso de limite

test("trocar(2): POST /v1/switch { number: 2 } e a credencial da conta 2 gravada", async (t) => {
  const { servidor, cliente, lerCredencial, lerGlobal, estado } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  const s = await cliente.trocar(2);

  assert.deepEqual(corpos(servidor, "POST", "/v1/switch"), [{ number: 2 }]);
  assert.equal(s.estado, "ok");
  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
  assert.equal(lerGlobal().oauthAccount.emailAddress, "conta2@exemplo.com");
  assert.equal(estado.aplicado().number, 2);
  assert.equal(estado.situacao().conta.numero, 2);
});

test("trocar(null): POST /v1/switch { number: null } e a credencial da conta que o servidor escolheu gravada", async (t) => {
  const { servidor, cliente, lerCredencial } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.melhorConta = 2;
  let s = await cliente.trocar(null);
  assert.deepEqual(corpos(servidor, "POST", "/v1/switch"), [{ number: null }]);
  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);

  // Sem argumento é o mesmo pedido; número em texto vira número.
  servidor.melhorConta = 1;
  s = await cliente.trocar();
  assert.equal(s.conta.numero, 1);
  await cliente.trocar("2");
  assert.deepEqual(corpos(servidor, "POST", "/v1/switch"), [{ number: null }, { number: null }, { number: 2 }]);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
});

test("trocar para a conta em que já está: o login é gravado de novo mesmo assim", async (t) => {
  const { servidor, cliente, lerCredencial, pastaClaude } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  fs.rmSync(path.join(pastaClaude, ".credentials.json"));
  const s = await cliente.trocar(1);
  assert.equal(s.estado, "ok");
  assert.equal(servidor.contar("GET", "/v1/credential"), 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("trocar sem estar conectado: nenhuma chamada, situação desconectado", async (t) => {
  const servidor = await servidorFalso();
  const m = await montar({ servidor, conectar: false });
  t.after(async () => {
    m.limpar();
    await servidor.fechar();
  });
  const s = await m.cliente.trocar(2);
  assert.equal(s.estado, "desconectado");
  assert.equal(servidor.chamadas.length, 0);
});

test('informarLimite("x"): POST /v1/events com o rótulo; devolve se o servidor trocou e o texto dele', async (t) => {
  const { servidor, cliente, lerCredencial } = await cenario(t);
  await cliente.ciclo({ forcar: true });

  let s = await cliente.informarLimite("x");
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "x" }]);
  assert.deepEqual(s.limite, { trocou: false, texto: "nada a fazer" });
  assert.equal(s.estado, "ok");
  assert.equal(s.conta.numero, 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 1, "o servidor não trocou: nada a gravar");

  servidor.aoLimite = () => {
    servidor.atribuida = 2;
    return { switched: true, text: "conta 1 no limite; agora na conta 2" };
  };
  s = await cliente.informarLimite("limite da sessão de 5h");
  assert.deepEqual(s.limite, { trocou: true, texto: "conta 1 no limite; agora na conta 2" });
  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
});

test("informarLimite: sem rótulo vale \"limite de uso\"; rótulo comprido é cortado em 80 caracteres", async (t) => {
  const { servidor, cliente } = await cenario(t);
  await cliente.informarLimite();
  await cliente.informarLimite("L".repeat(200));
  assert.deepEqual(
    eventos(servidor).map((e) => e.label),
    ["limite de uso", "L".repeat(80)]
  );
});

test("informarLimite sem estar conectado: nenhuma chamada, limite nulo", async (t) => {
  const servidor = await servidorFalso();
  const m = await montar({ servidor, conectar: false });
  t.after(async () => {
    m.limpar();
    await servidor.fechar();
  });
  const s = await m.cliente.informarLimite("x");
  assert.equal(s.estado, "desconectado");
  assert.equal(s.limite, null);
  assert.equal(servidor.chamadas.length, 0);
});

// ------------------------------------------------------------------ situação e log

test("avisos do servidor: só os da conta deste cliente entram na situação", async (t) => {
  const { servidor, cliente } = await cenario(t);
  servidor.avisos = [
    { kind: "login_expiring", account: 1, text: "o login da conta 1 vence amanhã" },
    { kind: "dead", account: 2, text: "a conta 2 precisa de login" },
    { kind: "dead", account: 1 },
  ];
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok");
  assert.deepEqual(s.avisos, ["o login da conta 1 vence amanhã"]);
});

test("o token do cliente e os tokens de acesso nunca vão para o log, nem em troca, limite, falha de gravação ou 401", async (t) => {
  const log = logGuardado();
  const espiao = authEspiao();
  const c = await cenario(t, { auth: espiao, log, presenca: "sempre" });
  const { servidor, cliente, relogio } = c;

  await cliente.ciclo();
  servidor.renovar(1);
  relogio.t += 30 * SEG;
  await cliente.ciclo();
  servidor.aoLimite = () => {
    servidor.atribuida = 2;
    return { switched: true, text: "trocou" };
  };
  relogio.t += 30 * SEG;
  baterLimite(c, TXT_SESSAO);
  await cliente.ciclo();
  espiao.trocas.writeLive = async () => {
    throw falha("EACCES", "EACCES: permission denied");
  };
  await cliente.trocar(1);
  delete espiao.trocas.writeLive;
  servidor.avisos = [{ kind: "login_expiring", account: 1, text: "o login da conta 1 vence amanhã" }];
  await cliente.trocar(1);
  servidor.proximaFalha = { status: 429 };
  relogio.t += 30 * SEG;
  await cliente.ciclo();
  servidor.token = "token-trocado"; // 401 no próximo pedido
  await cliente.ciclo({ forcar: true });
  assert.ok(c.estado.conexao().revogadoEm > 0);

  const texto = log.linhas.join("\n");
  assert.match(texto, /conta trocada: agora na conta 2/, "o log conta o que aconteceu");
  assert.match(texto, /aviso do servidor: o login da conta 1 vence amanhã/);
  assert.match(texto, /revogado/);
  assert.ok(!texto.includes(c.estado.conexao().token), "o token do cliente não aparece");
  assert.ok(!texto.includes("sk-ant-"), "nenhum token de acesso aparece");
  assert.ok(!/tok-[A-Za-z0-9_-]{20,}/.test(texto));
});

test("401 e a revogação não pôde ser registrada no arquivo: mesmo assim o cliente não chama mais o servidor enquanto viver", async (t) => {
  const log = logGuardado();
  const { servidor, cliente, relogio, estado, lerCredencial } = await cenario(t, { log });
  await cliente.ciclo({ forcar: true });
  estado.gravarConexao = async () => {
    throw falha("EROFS", "EROFS: read-only file system");
  };
  servidor.token = "token-trocado"; // o servidor revogou este cliente

  relogio.t += OCIOSO_MS;
  let s = await cliente.ciclo();
  assert.equal(s.estado, "revogado");
  assert.ok(!estado.conexao().revogadoEm, "o arquivo ficou sem a marca (não deu para gravar)");
  assert.ok(log.linhas.some((l) => /^error: não consegui registrar a revogação/.test(l)));

  const antes = servidor.chamadas.length;
  for (const passo of [30 * SEG, OCIOSO_MS, 30 * MIN]) {
    relogio.t += passo;
    s = await cliente.ciclo();
    assert.match(s.mensagem, /revogado/);
    assert.notEqual(s.estado, "ok");
  }
  assert.equal(servidor.chamadas.length, antes, "nenhuma chamada depois do 401 (cada 401 conta no bloqueio por IP)");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken, "o login gravado fica como está");
  assert.ok(!log.linhas.join("\n").includes(estado.conexao().token));
});

// ------------------------------------------------------------------ suspeitas (ver o relatório dos testes)

// src/ciclo.js, falhou() (linhas 423-428): no 401 o cliente regrava a conexão que leu NO COMEÇO do ciclo, com
// revogadoEm. Se nesse meio-tempo outro processo conectou de novo (swap-plus-cliente conectar, com o serviço
// rodando), a conexão nova é trocada pela antiga já revogada e o cliente passa a pedir "conecte de novo".
test("401 de um token antigo não apaga a conexão nova feita por outro processo durante o ciclo", async (t) => {
  const espiao = authEspiao();
  const { servidor, cliente, estado, relogio } = await cenario(t, { auth: espiao });
  await cliente.ciclo({ forcar: true });

  const nova = { url: servidor.url, fp: null, deviceId: "dev-novo-0123456789", token: "tok-novo-0123456789abcdefghij", nome: "cliente-de-teste", via: "codigo", conectadoEm: relogio.t + 30 * SEG };
  espiao.trocas.readLive = async () => {
    // Entre o cliente ler a conexão e falar com o servidor: o "conectar" de outro processo revoga o acesso
    // antigo no servidor e guarda a conexão nova.
    delete espiao.trocas.readLive;
    servidor.token = nova.token;
    servidor.deviceId = nova.deviceId;
    await estado.gravarConexao(nova);
    return auth.readLive();
  };

  relogio.t += 30 * SEG;
  await cliente.ciclo({ forcar: true }); // o batimento vai com o token antigo: 401

  const con = estado.conexao();
  assert.equal(con.deviceId, nova.deviceId, "a conexão nova continua guardada");
  assert.equal(con.token, nova.token);
  assert.ok(!con.revogadoEm, "e não fica marcada como revogada");

  relogio.t += 30 * SEG;
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok", "o ciclo seguinte já usa a conexão nova");
});

// A pasta de dados DENTRO da pasta de login deixaria o acesso do cliente ao servidor à vista de quem usa o Claude
// Code, e o cliente tomaria as próprias gravações (situacao.json) por uso do Claude Code: nunca ficaria parado.
// O config.js recusa (o contrário, a pasta de login dentro da de dados, é o padrão e continua valendo).
test("pasta de dados dentro da pasta de login: recusada; pasta de login dentro da de dados: aceita", () => {
  const raiz = pastaTemp();
  try {
    const pastaClaude = path.join(raiz, "claude");
    assert.throws(
      () => config.resolver({ dir: path.join(pastaClaude, "swap-plus"), pastaClaude, nome: "x" }, {}),
      (e) => e.code === "pasta_dentro" && /não pode ficar dentro da pasta de login/.test(e.message)
    );
    assert.throws(() => config.resolver({ dir: path.join(pastaClaude, "a", "b"), pastaClaude, nome: "x" }, {}), (e) => e.code === "pasta_dentro");
    const cfg = config.resolver({ dir: raiz, pastaClaude, nome: "x" }, {});
    assert.equal(cfg.pastaClaude, path.resolve(pastaClaude));
    // Pastas vizinhas com nome parecido não são "dentro".
    assert.equal(config.resolver({ dir: path.join(raiz, "claude-dados"), pastaClaude, nome: "x" }, {}).dir, path.resolve(raiz, "claude-dados"));
  } finally {
    fs.rmSync(raiz, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ rodar()

test("rodar(): o primeiro ciclo é forçado e os seguintes não; a espera entre ciclos é de 30 s; para quando o sinal dispara", async (t) => {
  const controle = new AbortController();
  const sinais = [];
  let c = null;
  c = await cenario(t, {
    aoEsperar: (ms, parar) => {
      sinais.push(parar);
      c.relogio.t += ms; // o tempo "passa" sem dormir
      if (c.esperas.length === 3) controle.abort();
    },
  });
  const { servidor, cliente, esperas, estado, relogio } = c;
  const t0 = relogio.t;

  await cliente.rodar({ parar: controle.signal });

  assert.deepEqual(esperas, [CICLO_MS, CICLO_MS, CICLO_MS]);
  assert.ok(sinais.every((s) => s === controle.signal), "a espera recebe o sinal, para poder terminar na hora");
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 1, "só o primeiro ciclo é forçado (parado, os outros não batem)");
  assert.equal(servidor.contar("GET", "/v1/state"), 0, "os ciclos seguintes foram normais: estado consultado há menos de 2 min");
  assert.equal(servidor.contar("GET", "/v1/credential"), 1);
  assert.equal(estado.situacao().estado, "ok");
  assert.equal(estado.situacao().em, t0 + 2 * CICLO_MS, "três ciclos rodaram; depois do sinal, nenhum outro");
});

test("rodar() com o sinal já disparado: não faz ciclo nenhum", async (t) => {
  const { servidor, cliente, esperas, estado } = await cenario(t);
  await cliente.rodar({ parar: AbortSignal.abort() });
  assert.equal(servidor.chamadas.length, 0);
  assert.deepEqual(esperas, []);
  assert.equal(estado.situacao(), null);
});

test("rodar() para quando aCadaCiclo devolve false (a trava foi perdida), sem esperar mais", async (t) => {
  let c = null;
  c = await cenario(t, { aoEsperar: (ms) => void (c.relogio.t += ms) });
  const { servidor, cliente, esperas } = c;
  let ciclos = 0;
  await cliente.rodar({ aCadaCiclo: () => ++ciclos < 3 });
  assert.equal(ciclos, 3);
  assert.deepEqual(esperas, [CICLO_MS, CICLO_MS], "depois do false não há outra espera");
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 1);

  // aCadaCiclo que não devolve nada (undefined) não encerra: só o false.
  const controle = new AbortController();
  let chamadas = 0;
  await cliente.rodar({
    parar: controle.signal,
    aCadaCiclo: () => {
      if (++chamadas === 2) controle.abort();
    },
  });
  assert.equal(chamadas, 2);
});

test("rodar(): um ciclo que lança não derruba o laço; o erro vai para o log e o ciclo seguinte roda", async (t) => {
  const log = logGuardado();
  let falhar = 1;
  const atividadeQueFalha = {
    detectar: async (...args) => {
      if (falhar-- > 0) throw new Error("a pasta sumiu no meio da leitura");
      return atividade.detectar(...args);
    },
  };
  const controle = new AbortController();
  let c = null;
  c = await cenario(t, {
    log,
    atividade: atividadeQueFalha,
    aoEsperar: (ms) => {
      c.relogio.t += ms;
      if (c.esperas.length === 2) controle.abort();
    },
  });
  const { cliente, esperas, lerCredencial, servidor, estado } = c;

  await cliente.rodar({ parar: controle.signal });

  assert.deepEqual(esperas, [CICLO_MS, CICLO_MS]);
  assert.ok(
    log.linhas.some((l) => /^error: o ciclo falhou: a pasta sumiu no meio da leitura/.test(l)),
    "o erro do ciclo é registrado"
  );
  assert.equal(estado.situacao().estado, "ok", "o segundo ciclo rodou normalmente");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

// ------------------------------------------------------------------ aviso de limite deixado na pasta (1.1.0)

/** Quem chama o Claude Code (o Hermes, que não deixa transcrição) deixa o aviso na pasta de login. */
function avisarLimite(c, corpo = {}) {
  const dir = path.join(c.pastaClaude, "swap-plus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "limite.json"), JSON.stringify({ at: c.relogio.t, ...corpo }));
}

test("aviso de limite na pasta (Hermes): o cliente avisa o servidor no ciclo seguinte, grava a conta nova e não avisa de novo", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio, lerCredencial, lerGlobal } = c;
  await cliente.ciclo({ forcar: true });
  servidor.aoLimite = () => {
    servidor.atribuida = 2;
    return { switched: true, text: "trocou para a conta 2" };
  };

  relogio.t += 30 * SEG;
  avisarLimite(c);
  const s = await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite de uso" }]);
  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken, "a conta nova é gravada no mesmo ciclo");
  assert.equal(lerGlobal().oauthAccount.emailAddress, "conta2@exemplo.com", "é por aqui que o Hermes vê que a conta mudou");

  // O mesmo aviso não é mandado de novo; um aviso novo, sim.
  relogio.t += 30 * SEG;
  await cliente.ciclo();
  assert.equal(eventos(servidor).length, 1);
  servidor.aoLimite = () => ({ switched: false, text: "nenhuma outra conta tem folga" });
  relogio.t += 30 * SEG;
  avisarLimite(c);
  await cliente.ciclo();
  assert.equal(eventos(servidor).length, 2);
});

test("aviso de limite sem dizer qual: com o Fable da conta no fim (e sessão e semanal folgados) vai como limite do Fable; na regra “mesma conta”, não troca", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  servidor.regras.onModelLimit = "switchAccount";
  const usoFable = (pct) => ({ fiveHour: { pct: 10, resetsAt: null }, sevenDay: { pct: 20, resetsAt: null }, scoped: [{ name: "Fable", pct, resetsAt: null }] });
  servidor.contas[1].publica.usage = usoFable(97);
  await cliente.ciclo({ forcar: true });

  relogio.t += 30 * SEG;
  avisarLimite(c);
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor), [{ kind: "limit_hit", label: "limite do Fable" }]);

  // Fable com folga: é limite da conta (rótulo genérico).
  servidor.contas[1].publica.usage = usoFable(40);
  relogio.t += 3 * MIN;
  await cliente.ciclo({ forcar: true });
  relogio.t += 30 * SEG;
  avisarLimite(c);
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor)[1], { kind: "limit_hit", label: "limite de uso" });

  // Regra "seguir na mesma conta": limite do Fable não troca de conta — nada é mandado.
  servidor.regras.onModelLimit = "sameAccount";
  servidor.contas[1].publica.usage = usoFable(99);
  relogio.t += 3 * MIN;
  await cliente.ciclo({ forcar: true });
  relogio.t += 30 * SEG;
  avisarLimite(c);
  await cliente.ciclo();
  assert.equal(eventos(servidor).length, 2);
});

test("aviso de limite que traz o texto ou o tipo do erro: segue a mesma leitura das transcrições", async (t) => {
  const c = await cenario(t);
  const { servidor, cliente, relogio } = c;
  servidor.regras.onModelLimit = "switchAccount";
  await cliente.ciclo({ forcar: true });
  relogio.t += 30 * SEG;
  avisarLimite(c, { text: TXT_SESSAO });
  await cliente.ciclo();
  relogio.t += 30 * SEG;
  avisarLimite(c, { text: TXT_FABLE });
  await cliente.ciclo();
  relogio.t += 30 * SEG;
  avisarLimite(c, { rateLimitType: "seven_day_overage_included" });
  await cliente.ciclo();
  relogio.t += 30 * SEG;
  avisarLimite(c, { text: TXT_PASSAGEIRO });
  await cliente.ciclo();
  assert.deepEqual(eventos(servidor).map((e) => e.label), ["limite da sessão de 5h", "limite do Fable", "limite do Fable"], "o erro passageiro não é limite da conta");
});
