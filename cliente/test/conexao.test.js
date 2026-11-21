"use strict";
// Testes de src/conexao.js direto (sem a linha de comando): o que o "entrar" faz enquanto espera o login com
// Google (pedidos demais, rede caindo, prazo, cancelamento) e os detalhes de conectar de novo e de desconectar.
// O caminho feliz pela linha de comando está em cli.test.js. Aqui nada mexe no login do Claude Code.
// Rodar:  node --test cliente/test/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { servidorFalso, pastaTemp, lib } = require("./apoio");
const { Estado } = require("../src/estado");
const conexao = require("../src/conexao");

const SEG = 1000;
const MIN = 60 * SEG;

/**
 * Servidor de mentira + pasta de dados temporária. A espera não dorme: só anota e faz o relógio do teste andar.
 * `atrasoDoServidor`: quanto o relógio do servidor está atrás do relógio do teste (encurta o prazo do login).
 */
async function cenario(t, { atrasoDoServidor = 0 } = {}) {
  const relogio = { t: Date.now() };
  const servidor = await servidorFalso(() => relogio.t - atrasoDoServidor);
  servidor.google = { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789", respostas: [] };
  const dir = pastaTemp("swap-plus-conexao-");
  const estado = new Estado(dir);
  const esperas = [];
  const ganchos = { aoEsperar: null };
  const deps = {
    lib,
    estado,
    cfg: { nome: "cliente-de-teste" },
    agora: () => relogio.t,
    espera: async (ms, parar) => {
      esperas.push(ms);
      relogio.t += ms;
      if (ganchos.aoEsperar) await ganchos.aoEsperar(esperas.length, parar);
    },
  };
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await servidor.fechar();
  });
  const mostrados = [];
  const entrar = (extra = {}) => conexao.entrarComGoogle(deps, { url: servidor.url, mostrar: (authUrl, ate) => void mostrados.push([authUrl, ate]), ...extra });
  const consultas = () => servidor.chamadas.filter((c) => c.caminho === "/v1/login/poll").length;
  return { servidor, dir, estado, relogio, esperas, ganchos, deps, mostrados, entrar, consultas };
}

const conexaoDe = (servidor, extra = {}) => ({ url: servidor.url, fp: null, deviceId: servidor.deviceId, token: servidor.token, nome: "cliente-de-teste", via: "codigo", conectadoEm: 1, ...extra });

// ------------------------------------------------------------------ entrar com Google

test("entrarComGoogle: mostra o endereço uma vez, com o prazo (10 min, ou o do servidor se for antes), e guarda a conexão", async (t) => {
  const a = await cenario(t);
  const t0 = a.relogio.t;
  a.servidor.google.respostas = [{ status: "pending" }, { status: "pending" }, { status: "ok" }];
  const con = await a.entrar();
  assert.deepEqual(a.mostrados, [[`${a.servidor.url}/auth/google/start?s=sessao-0123456789`, t0 + 10 * MIN]]);
  assert.deepEqual(a.esperas, [2000, 2000]);
  assert.deepEqual(con, { url: a.servidor.url, fp: null, deviceId: a.servidor.deviceId, token: a.servidor.token, nome: "cliente-de-teste", via: "google", conectadoEm: t0 + 4000 });
  assert.deepEqual(a.estado.conexao(), { versao: 1, ...con });

  // O servidor dá um prazo mais curto (o login já estava aberto há 9 min): vale o dele.
  const b = await cenario(t, { atrasoDoServidor: 9 * MIN });
  b.servidor.google.respostas = [{ status: "ok" }];
  await b.entrar();
  assert.equal(b.mostrados.length, 1);
  assert.equal(b.mostrados[0][1], b.relogio.t + 1 * MIN);
});

test("entrarComGoogle sem endereço do servidor: recusa na hora (sem_url)", async (t) => {
  const c = await cenario(t);
  await assert.rejects(c.entrar({ url: null }), { code: "sem_url" });
  await assert.rejects(c.entrar({ url: "" }), { code: "sem_url" });
  assert.equal(c.servidor.chamadas.length, 0);
  assert.deepEqual(c.mostrados, []);
});

test("entrarComGoogle: pedidos demais na consulta (429) → espera 15 s e continua", async (t) => {
  const c = await cenario(t);
  c.servidor.google.respostas = [{ http: 429 }, { status: "pending" }, { status: "ok" }];
  const con = await c.entrar();
  assert.deepEqual(c.esperas, [15 * SEG, 2 * SEG]);
  assert.equal(con.via, "google");
  assert.equal(c.estado.conexao().token, c.servidor.token);
});

test("entrarComGoogle: rede caindo ou servidor reiniciando (5xx) por pouco tempo → continua consultando e conecta", async (t) => {
  const c = await cenario(t);
  c.servidor.google.respostas = [{ http: 503 }, { status: "pending" }, { http: 500 }, { status: "ok" }];
  const con = await c.entrar({
    mostrar: () => {
      c.servidor.derrubar = 2; // as duas primeiras consultas caem no meio
    },
  });
  assert.equal(c.consultas(), 6);
  assert.deepEqual(c.esperas, [2000, 2000, 2000, 2000, 2000]);
  assert.equal(con.deviceId, c.servidor.deviceId);
});

test("entrarComGoogle: sem rede por mais de 1 min seguido → desiste com o erro de rede, nada guardado", async (t) => {
  const c = await cenario(t);
  await assert.rejects(
    c.entrar({
      mostrar: () => {
        c.servidor.derrubar = 1000;
      },
    }),
    { code: "network" }
  );
  assert.equal(c.esperas.length, 31, "insiste a cada 2 s por 1 min; na primeira consulta depois disso, desiste");
  assert.equal(c.consultas(), 32);
  assert.equal(c.estado.conexao(), null);
});

test("entrarComGoogle: o minuto sem rede recomeça a contar quando uma consulta dá certo", async (t) => {
  const c = await cenario(t);
  c.servidor.google.respostas = [{ status: "pending" }, { status: "ok" }];
  c.ganchos.aoEsperar = (n) => {
    if (n === 21) c.servidor.derrubar = 20; // depois da consulta que deu certo, mais 40 s sem rede
  };
  const con = await c.entrar({
    mostrar: () => {
      c.servidor.derrubar = 20; // 40 s sem rede
    },
  });
  assert.equal(c.consultas(), 42);
  assert.equal(con.deviceId, c.servidor.deviceId);
});

test("entrarComGoogle: o prazo passou sem a pessoa entrar → google_expirou, nada guardado", async (t) => {
  const c = await cenario(t, { atrasoDoServidor: 9 * MIN }); // prazo de 1 min
  await assert.rejects(c.entrar(), { code: "google_expirou" });
  assert.equal(c.esperas.length, 30, "consulta a cada 2 s até o prazo");
  assert.equal(c.consultas(), 30);
  assert.equal(c.estado.conexao(), null);
});

test("entrarComGoogle: cancelado pelo sinal → para de consultar (cancelado), nada guardado", async (t) => {
  const c = await cenario(t);
  const controle = new AbortController();
  const sinais = [];
  c.ganchos.aoEsperar = (n, parar) => {
    sinais.push(parar);
    if (n === 2) controle.abort();
  };
  await assert.rejects(c.entrar({ parar: controle.signal }), { code: "cancelado" });
  assert.equal(c.consultas(), 2);
  assert.ok(sinais.every((s) => s === controle.signal), "a espera recebe o sinal, para terminar na hora");
  assert.equal(c.estado.conexao(), null);

  // Sinal já disparado: mostra o endereço, mas não chega a consultar.
  const d = await cenario(t);
  await assert.rejects(d.entrar({ parar: AbortSignal.abort() }), { code: "cancelado" });
  assert.equal(d.consultas(), 0);
});

test("entrarComGoogle: recusa do servidor que não é passageira (400, 403) → o erro sobe na hora", async (t) => {
  for (const http of [400, 403]) {
    const c = await cenario(t);
    c.servidor.google.respostas = [{ http, corpo: { error: "recusado", message: "O servidor recusou." } }];
    await assert.rejects(c.entrar(), { status: http, code: "recusado" });
    assert.deepEqual(c.esperas, []);
    assert.equal(c.consultas(), 1);
  }
});

// O servidor só entrega o acesso UMA vez (a consulta seguinte dá 404): um erro ao guardar a conexão não pode ser
// confundido com falha de rede, senão o cliente consultaria de novo e diria "O tempo para entrar acabou".
test("entrarComGoogle: se guardar a conexão falha, o erro que aparece é o da gravação, sem consultar de novo", async (t) => {
  const c = await cenario(t);
  c.servidor.google.respostas = [{ status: "ok" }, { status: "expired" }];
  c.estado.gravarConexao = async () => {
    throw Object.assign(new Error("EACCES: permission denied, open 'conexao.json'"), { code: "EACCES" });
  };
  c.ganchos.aoEsperar = (n) => assert.ok(n < 10, "não deveria continuar consultando");
  await assert.rejects(c.entrar(), { code: "EACCES" });
  assert.equal(c.consultas(), 1, "depois do ok não há outra consulta");
});

// ------------------------------------------------------------------ conectar de novo

test("conectarPorCodigo: guarda a conexão (via código) e esquece a credencial aplicada antes", async (t) => {
  const c = await cenario(t);
  await c.estado.gravarAplicado({ number: 7, gen: 3, expiresAt: 1, at: 1, noIdentity: false });
  const con = await conexao.conectarPorCodigo(c.deps, `  ${c.servidor.codigoDeConexao()}\n`);
  assert.deepEqual(con, { url: c.servidor.url, fp: null, deviceId: c.servidor.deviceId, token: c.servidor.token, nome: "cliente-de-teste", via: "codigo", conectadoEm: c.relogio.t });
  assert.deepEqual(c.estado.conexao(), { versao: 1, ...con });
  assert.equal(c.estado.aplicado(), null, "servidor (talvez) novo: o que foi aplicado antes não vale como referência");
  assert.deepEqual(c.servidor.pareado, { name: "cliente-de-teste", platform: process.platform });
});

test("conectar em outro servidor: a revogação do acesso antigo vai para o servidor antigo, com o token dele", async (t) => {
  const c = await cenario(t);
  const antigo = c.servidor;
  const novo = await servidorFalso();
  t.after(() => novo.fechar());
  await c.estado.gravarConexao(conexaoDe(antigo));

  const con = await conexao.conectarPorCodigo(c.deps, novo.codigoDeConexao());
  assert.equal(con.url, novo.url);
  assert.equal(c.estado.conexao().token, novo.token);
  assert.deepEqual(antigo.revogados, [antigo.deviceId]);
  assert.deepEqual(
    antigo.chamadas.map((x) => [x.metodo, x.caminho, x.autenticado]),
    [["DELETE", `/v1/devices/${antigo.deviceId}`, true]]
  );
  assert.deepEqual(
    novo.chamadas.map((x) => `${x.metodo} ${x.caminho}`),
    ["POST /v1/pair"],
    "o servidor novo não recebe o pedido de revogação (nem o token antigo)"
  );
});

test("conectar de novo com a conexão anterior já revogada, ou com o arquivo quebrado: não chama o servidor antigo", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.estado.gravarConexao(conexaoDe(servidor, { deviceId: "dev-antigo", revogadoEm: c.relogio.t - MIN }));
  let con = await conexao.conectarPorCodigo(c.deps, servidor.codigoDeConexao());
  assert.equal(con.deviceId, servidor.deviceId);
  assert.ok(!("revogadoEm" in c.estado.conexao()), "a conexão nova não herda a marca de revogada");
  assert.deepEqual(servidor.chamadas.map((x) => `${x.metodo} ${x.caminho}`), ["POST /v1/pair"]);

  fs.writeFileSync(c.estado.arqConexao, "{ quebrado");
  con = await conexao.conectarPorCodigo(c.deps, servidor.codigoDeConexao());
  assert.equal(c.estado.conexao().token, servidor.token, "conectar de novo conserta o arquivo quebrado");
  assert.equal(servidor.chamadas.filter((x) => x.metodo === "DELETE").length, 0);
});

test("conectar de novo com o servidor antigo fora do ar: não consegue revogar, mas conecta no novo", async (t) => {
  const c = await cenario(t);
  const antigo = c.servidor;
  const novo = await servidorFalso();
  t.after(() => novo.fechar());
  await c.estado.gravarConexao(conexaoDe(antigo));
  antigo.foraDoAr = true;

  const con = await conexao.conectarPorCodigo(c.deps, novo.codigoDeConexao());
  assert.equal(con.url, novo.url);
  assert.equal(c.estado.conexao().deviceId, novo.deviceId);
  assert.deepEqual(antigo.revogados, []);
});

// ------------------------------------------------------------------ desconectar e revogar

test("desconectar: revoga, apaga a conexão e a credencial aplicada; devolve o que aconteceu", async (t) => {
  const c = await cenario(t);
  assert.deepEqual(await conexao.desconectar(c.deps), { havia: false, revogou: false });
  assert.equal(c.servidor.chamadas.length, 0);

  await c.estado.gravarConexao(conexaoDe(c.servidor));
  await c.estado.gravarAplicado({ number: 1, gen: 1, expiresAt: 1, at: 1, noIdentity: false });
  assert.deepEqual(await conexao.desconectar(c.deps), { havia: true, revogou: true });
  assert.deepEqual(c.servidor.revogados, [c.servidor.deviceId]);
  assert.equal(fs.existsSync(c.estado.arqConexao), false);
  assert.equal(fs.existsSync(c.estado.arqAplicado), false);
});

test("desconectar com a conexão já revogada, ou com o arquivo quebrado: apaga aqui sem chamar o servidor", async (t) => {
  const c = await cenario(t);
  await c.estado.gravarConexao(conexaoDe(c.servidor, { revogadoEm: c.relogio.t }));
  assert.deepEqual(await conexao.desconectar(c.deps), { havia: true, revogou: false });
  assert.equal(c.servidor.chamadas.length, 0, "quem já foi revogado não é chamado (cada 401 conta no bloqueio por IP)");
  assert.equal(fs.existsSync(c.estado.arqConexao), false);

  fs.writeFileSync(c.estado.arqConexao, "{ quebrado");
  assert.deepEqual(await conexao.desconectar(c.deps), { havia: true, revogou: false });
  assert.equal(c.servidor.chamadas.length, 0);
  assert.equal(fs.existsSync(c.estado.arqConexao), false);
});

test("revogar: true só quando o servidor confirmou; id com caracteres especiais vai escapado no caminho", async (t) => {
  const c = await cenario(t);
  assert.equal(await conexao.revogar(lib, null), false);
  assert.equal(await conexao.revogar(lib, conexaoDe(c.servidor, { revogadoEm: 1 })), false);
  assert.equal(await conexao.revogar(lib, conexaoDe(c.servidor, { url: "isto não é endereço" })), false);
  assert.equal(c.servidor.chamadas.length, 0);

  assert.equal(await conexao.revogar(lib, conexaoDe(c.servidor, { deviceId: "dev/com barra?e=1" })), true);
  assert.deepEqual(c.servidor.revogados, ["dev/com barra?e=1"]);
  assert.equal(c.servidor.chamadas[0].caminho, "/v1/devices/dev%2Fcom%20barra%3Fe%3D1");

  assert.equal(await conexao.revogar(lib, conexaoDe(c.servidor, { token: "token-errado" })), false, "401 do servidor: não revogou");
});
