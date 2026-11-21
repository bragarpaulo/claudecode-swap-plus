"use strict";
// Testes do ciclo do cliente (src/ciclo.js) contra um servidor Swap Plus de mentira, com o serverClient.js e o
// claudeAuth.js de verdade gravando numa pasta temporária.
// Rodar:  node --test cliente/test/*.test.js     (TEST_LOG=1 mostra os logs do cliente)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { servidorFalso, montar } = require("./apoio");
const { OCIOSO_MS, PROMOVER_MS, JANELA_ATIVA_MS } = require("../src/ciclo");

const MIN = 60 * 1000;

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

test("primeiro ciclo (forçado): batimento, grava o acesso sem refresh token, a identidade e o registro do que aplicou", async (t) => {
  const { servidor, cliente, lerCredencial, lerGlobal, estado, pastaClaude } = await cenario(t);
  const s = await cliente.ciclo({ forcar: true });

  assert.equal(s.estado, "ok");
  assert.deepEqual(s.conta, { numero: 1, email: "conta1@exemplo.com", apelido: null, plano: "Max" });
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 1);
  assert.equal(servidor.contar("GET", "/v1/credential"), 1);
  assert.equal(servidor.contar("POST", "/v1/logins"), 0, "o cliente nunca envia logins");

  const cred = lerCredencial();
  assert.deepEqual(Object.keys(cred), ["claudeAiOauth"]);
  assert.equal(cred.claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(cred.claudeAiOauth.expiresAt, servidor.contas[1].expiresAt);
  assert.equal(cred.claudeAiOauth.subscriptionType, "max");
  assert.ok(!("refreshToken" in cred.claudeAiOauth), "nunca grava refresh token");
  assert.ok(!("refreshTokenExpiresAt" in cred.claudeAiOauth), "grava só o que a extensão grava");
  assert.equal(lerGlobal().oauthAccount.emailAddress, "conta1@exemplo.com");

  const aplicado = estado.aplicado();
  assert.equal(aplicado.number, 1);
  assert.equal(aplicado.gen, 1);
  assert.equal(aplicado.noIdentity, false);
  assert.equal(estado.situacao().estado, "ok");
  if (process.platform !== "win32") assert.equal(fs.statSync(path.join(pastaClaude, ".credentials.json")).mode & 0o777, 0o600);

  // O batimento diz ao servidor quem está logado (nesta primeira vez, ninguém ainda).
  assert.deepEqual(servidor.chamadas.find((c) => c.caminho === "/v1/heartbeat").corpo, { models: [], live: null });
  assert.match(servidor.chamadas[0].ua, /^SwapPlus-/);
});

test("parado (sem uso do Claude Code): só consulta o estado, e no máximo a cada 2 min", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  const batimentos = servidor.contar("POST", "/v1/heartbeat");

  relogio.t += 30 * 1000;
  let s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(s.presenca.ativo, false);
  assert.equal(servidor.contar("GET", "/v1/state"), 0, "consultou há menos de 2 min: não fala com o servidor");

  relogio.t += OCIOSO_MS;
  s = await cliente.ciclo();
  assert.equal(servidor.contar("GET", "/v1/state"), 1);
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), batimentos, "parado não manda batimento: não conta como ativo no servidor");
  assert.equal(servidor.contar("GET", "/v1/credential"), 1, "nada mudou: não busca a credencial de novo");
  assert.equal(s.estado, "ok");
});

test("Claude Code em uso (pasta mexida há pouco): batimento com a identidade e a validade do login", async (t) => {
  const { servidor, cliente, relogio, usarClaude } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  relogio.t += 30 * 1000;
  usarClaude();
  const s = await cliente.ciclo();

  assert.equal(s.presenca.ativo, true);
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2);
  const corpo = servidor.chamadas.filter((c) => c.caminho === "/v1/heartbeat")[1].corpo;
  assert.deepEqual(corpo.live, { email: "conta1@exemplo.com", orgUuid: "org-1", expiresAt: servidor.contas[1].expiresAt });

  // Passada a janela sem novo uso, volta a ficar parado.
  relogio.t += JANELA_ATIVA_MS + MIN;
  const depois = await cliente.ciclo();
  assert.equal(depois.presenca.ativo, false);
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2);
});

test('presença "sempre": batimento em todo ciclo; modelos declarados vão no batimento', async (t) => {
  const { servidor, cliente, relogio } = await cenario(t, { presenca: "sempre", modelos: "claude-fable-5-2, claude-opus-5-5" });
  await cliente.ciclo();
  relogio.t += 30 * 1000;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2);
  assert.deepEqual(servidor.chamadas.find((c) => c.caminho === "/v1/heartbeat").corpo.models, ["claude-fable-5-2", "claude-opus-5-5"]);
});

test("o servidor renovou o acesso (gen novo): o cliente busca e grava o novo, mesmo parado", async (t) => {
  const { servidor, cliente, relogio, lerCredencial, estado } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.renovar(1);
  relogio.t += OCIOSO_MS;
  const s = await cliente.ciclo();

  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(estado.aplicado().gen, 2);
  assert.equal(s.acessoExpiraEm, servidor.contas[1].expiresAt);
});

test("o servidor trocou a conta deste cliente: grava o acesso e a identidade da conta nova", async (t) => {
  const { servidor, cliente, relogio, lerCredencial, lerGlobal } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.atribuida = 2;
  relogio.t += OCIOSO_MS;
  const s = await cliente.ciclo();

  assert.equal(s.conta.numero, 2);
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
  assert.equal(lerGlobal().oauthAccount.emailAddress, "conta2@exemplo.com");
});

test("alguém apagou o login da pasta: o cliente grava de novo no ciclo seguinte, sem esperar o servidor mudar", async (t) => {
  const { servidor, cliente, relogio, lerCredencial, pastaClaude } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  fs.rmSync(path.join(pastaClaude, ".credentials.json"));
  relogio.t += 30 * 1000;
  const s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("parado e a conta passou da linha de troca: um batimento avulso, no máximo a cada 5 min", async (t) => {
  const { servidor, cliente, relogio } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.contas[1].publica.usage.fiveHour.pct = 95; // linha da sessão: 90
  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2, "pede ao servidor para decidir");

  relogio.t += OCIOSO_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 2, "não insiste antes de 5 min");

  relogio.t += PROMOVER_MS;
  await cliente.ciclo();
  assert.equal(servidor.contar("POST", "/v1/heartbeat"), 3);
});

test("401: o cliente se dá por revogado, registra e não chama mais o servidor", async (t) => {
  const { servidor, cliente, relogio, estado } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.token = "outro-token"; // o servidor revogou este cliente
  relogio.t += OCIOSO_MS;
  let s = await cliente.ciclo();
  assert.equal(s.estado, "revogado");
  assert.ok(estado.conexao().revogadoEm > 0);

  const antes = servidor.chamadas.length;
  relogio.t += OCIOSO_MS;
  s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "revogado");
  assert.equal(servidor.chamadas.length, antes, "nenhuma chamada depois de revogado (cada 401 conta no bloqueio por IP)");
});

test("403 e 429: pausa antes de tentar de novo; o login gravado continua valendo", async (t) => {
  const { servidor, cliente, relogio, lerCredencial } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  servidor.proximaFalha = { status: 429 };
  relogio.t += OCIOSO_MS;
  let s = await cliente.ciclo();
  assert.equal(s.estado, "offline");
  assert.ok(s.acessoExpiraEm > relogio.t, "a situação mostra a validade do que está gravado");

  const antes = servidor.chamadas.length;
  relogio.t += OCIOSO_MS;
  s = await cliente.ciclo();
  assert.equal(s.estado, "offline");
  assert.equal(servidor.chamadas.length, antes, "em pausa: não chama");

  relogio.t += 10 * MIN;
  s = await cliente.ciclo();
  assert.equal(s.estado, "ok");
  assert.equal(lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("sem conta para este cliente: situação sem_conta, nada gravado", async (t) => {
  const { servidor, cliente, lerCredencial } = await cenario(t);
  servidor.atribuida = null;
  const s = await cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "sem_conta");
  assert.equal(lerCredencial(), null);
});

test("login feito à mão na pasta (com refresh token): o cliente não envia nem apaga; com substituirLogin, grava por cima", async (t) => {
  const manual = { claudeAiOauth: { accessToken: "sk-ant-oat01-MANUAL", refreshToken: "sk-ant-ort01-MANUAL", expiresAt: Date.now() + 3600000, scopes: [] } };

  const a = await cenario(t);
  fs.mkdirSync(a.pastaClaude, { recursive: true });
  fs.writeFileSync(path.join(a.pastaClaude, ".credentials.json"), JSON.stringify(manual));
  let s = await a.cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "bloqueado");
  assert.match(s.mensagem, /feito à mão/);
  assert.equal(a.lerCredencial().claudeAiOauth.refreshToken, "sk-ant-ort01-MANUAL", "o login manual fica intacto");
  assert.equal(a.servidor.contar("GET", "/v1/credential"), 0);
  assert.equal(a.servidor.contar("POST", "/v1/logins"), 0);

  const b = await cenario(t, { substituirLogin: true });
  fs.mkdirSync(b.pastaClaude, { recursive: true });
  fs.writeFileSync(path.join(b.pastaClaude, ".credentials.json"), JSON.stringify(manual));
  s = await b.cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "ok");
  assert.equal(b.lerCredencial().claudeAiOauth.accessToken, b.servidor.contas[1].accessToken);
  assert.ok(!("refreshToken" in b.lerCredencial().claudeAiOauth));
});

test("não conectado: nenhuma chamada, situação explica o que fazer", async (t) => {
  const servidor = await servidorFalso();
  const m = await montar({ servidor, conectar: false });
  t.after(async () => {
    m.limpar();
    await servidor.fechar();
  });
  const s = await m.cliente.ciclo({ forcar: true });
  assert.equal(s.estado, "desconectado");
  assert.match(s.mensagem, /conectar/);
  assert.equal(servidor.chamadas.length, 0);
});

test("o token do cliente e os tokens de acesso não aparecem na situação gravada", async (t) => {
  const { servidor, cliente, dir } = await cenario(t);
  await cliente.ciclo({ forcar: true });
  const txt = fs.readFileSync(path.join(dir, "situacao.json"), "utf8") + fs.readFileSync(path.join(dir, "aplicado.json"), "utf8");
  assert.ok(!txt.includes(servidor.token));
  assert.ok(!txt.includes(servidor.contas[1].accessToken));
});
