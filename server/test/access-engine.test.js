"use strict";
// Integração da regra "cada conta Claude → em quais serviços pode ser usada" (access.js, WEB-SPEC 2.3)
// com o motor de verdade (engine.js) e a API (server.js): cofre de verdade numa pasta temporária (chave gerada
// aqui), pedidos HTTP de verdade em 127.0.0.1 e uma Anthropic que não pode ser chamada (as contas têm acesso
// valendo 8 h: nada precisa renovar).
//
//   node --test server/test/access-engine.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { Store, decrypt, loadKey } = require("../src/store");
const { createApp, loadConfig } = require("../src/server");
const { Engine } = require("../src/engine");

const PUBLIC_URL = "https://swap.exemplo.com";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const silentLog = { log() {}, info() {}, debug() {}, warn() {}, error() {} };
const testLog = process.env.TEST_LOG ? console : silentLog;

/** Anthropic que só conta as chamadas (nenhuma é esperada neste teste). */
function noAnthropic() {
  return {
    calls: 0,
    async refresh() {
      this.calls++;
      return { ok: false, error: "transient" };
    },
    async usage() {
      this.calls++;
      return { ok: false, error: "transient" };
    },
    async profile() {
      this.calls++;
      return null;
    },
  };
}

function conta(number, email, t) {
  const rnd = () => crypto.randomBytes(6).toString("hex");
  return {
    number,
    email,
    orgUuid: "org-1",
    orgName: "Empresa",
    plan: { label: "Max" },
    alias: null,
    oauthAccount: { emailAddress: email, organizationUuid: "org-1" },
    cred: {
      accessToken: `sk-ant-oat01-teste-${number}-${rnd()}`,
      refreshToken: `sk-ant-ort01-teste-${number}-${rnd()}`,
      expiresAt: t + 8 * HOUR,
      scopes: ["user:inference"],
      subscriptionType: "max",
      rateLimitTier: "x",
    },
    gen: 1,
    dead: null,
    disabled: false,
    threshold: null,
    priority: 0,
    usage: null,
    usageFetchedAt: null,
    usageError: null,
    lastGoodUsage: null,
    lastGoodAt: null,
    nextPollAt: 0,
    pollBackoffUntil: 0,
    pollFailures: 0,
    refreshBackoffUntil: 0,
    refreshFailures: 0,
    spentRefresh: [],
    addedAt: t,
    lastRefreshAt: t,
  };
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** clock ({ t: ms }, opcional): relógio do motor e do servidor, para o teste andar no tempo; sem ele, o de verdade. */
async function setup(t, { clock = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-acesso-"));
  const keyFile = path.join(dir, "chave-mestra");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "dados"), keyFile });
  store.load();
  const now = clock ? () => clock.t : Date.now;
  const t0 = now();
  store.state.accounts = { 1: conta(1, "ana@exemplo.com", t0), 2: conta(2, "bia@exemplo.com", t0) };
  await store.save();
  const anthropic = noAnthropic();
  const engine = new Engine({ store, anthropic, now, log: testLog, env: {} });
  const config = loadConfig({ TLS_MODE: "off", DATA_DIR: dir, PUBLIC_URL });
  const app = createApp({ store, engine, config, now, log: testLog });
  const api = await listen(app.api);
  const admin = await listen(app.admin);
  t.after(async () => {
    await engine.stop();
    await close(api.server);
    await close(admin.server);
    store.close(); // solta a trava da pasta (store.lock)
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, keyFile, store, engine, anthropic, app, api: api.port, admin: admin.port };
}

/** O que está gravado no cofre em disco (sem abrir um segundo Store na mesma pasta). */
function cofreEmDisco(ctx) {
  return decrypt(loadKey(ctx.keyFile), fs.readFileSync(ctx.store.file));
}

/** Requisição HTTP crua; nenhuma resposta pode levar refresh token. */
function request(ctx, port, method, p, { token, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (token) h.authorization = `Bearer ${token}`;
    if (data !== null) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        try {
          assert.ok(!/"refreshToken"\s*:/.test(text), `resposta de ${method} ${p} contém o campo "refreshToken"`);
          for (const a of Object.values(ctx.store.state.accounts)) {
            assert.ok(!text.includes(a.cred.refreshToken), `resposta de ${method} ${p} contém um refresh token`);
          }
        } catch (e) {
          reject(e);
          return;
        }
        resolve({ status: res.statusCode, text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function pairDevice(ctx, name) {
  const pc = await request(ctx, ctx.admin, "POST", "/admin/pair-code");
  assert.equal(pc.status, 200, pc.text);
  const r = await request(ctx, ctx.api, "POST", "/v1/pair", { body: { code: pc.json.code, name, platform: "darwin" } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

test("API + motor: conta só de um serviço — o outro não recebe nem troca para ela (409); desconectar e remover conta limpam as listas", async (t) => {
  const ctx = await setup(t);
  const mac = await pairDevice(ctx, "Mac");
  const win = await pairDevice(ctx, "Windows");
  const api = (method, p, opts) => request(ctx, ctx.api, method, p, opts);

  // Conta 1 só no Mac (o painel vai chamar engine.setAccountDevices).
  assert.deepEqual(await ctx.engine.setAccountDevices(1, [mac.deviceId]), { number: 1, devices: [mac.deviceId] });
  assert.deepEqual(cofreEmDisco(ctx).accountDevices, { 1: [mac.deviceId] });

  // O Windows conecta: recebe a 2 (a 1 não é liberada para ele); a credencial entregue é da 2.
  let r = await api("POST", "/v1/heartbeat", { token: win.token, body: { models: [] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.assigned, 2);
  assert.equal(r.json.records["1"].disabled, false, "records continua global (a extensão não mostra 'fora da rotação')");
  r = await api("GET", "/v1/credential", { token: win.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.number, 2);
  assert.equal(r.json.claudeAiOauth.accessToken, ctx.store.state.accounts["2"].cred.accessToken);

  // O Windows pede a conta 1 → 409 not_allowed; nada muda.
  r = await api("POST", "/v1/switch", { token: win.token, body: { number: 1 } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, "not_allowed");
  assert.match(r.json.message, /^a conta 1 não está liberada para este serviço/);
  assert.equal(ctx.store.state.devices[win.deviceId].assigned, 2);

  // O Mac pode.
  r = await api("POST", "/v1/heartbeat", { token: mac.token, body: {} });
  assert.equal(r.status, 200, r.text);
  r = await api("POST", "/v1/switch", { token: mac.token, body: { number: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.assigned, 1);

  // O Windows desconecta o Mac: o Mac sai da lista; a lista vazia continua vazia (ninguém — nunca "todos").
  r = await api("DELETE", `/v1/devices/${mac.deviceId}`, { token: win.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ctx.store.state.accountDevices, { 1: [] });
  assert.deepEqual(cofreEmDisco(ctx).accountDevices, { 1: [] }, "gravado no cofre");
  assert.ok(
    ctx.store.state.history.some((h) => h.kind === "alert" && h.text.startsWith('A conta 1 não está liberada para nenhum serviço agora ("Mac" era o único)')),
    "avisa no histórico que a conta ficou sem serviço"
  );
  r = await api("POST", "/v1/switch", { token: win.token, body: { number: 1 } });
  assert.equal(r.status, 409, r.text);

  // Nenhuma conta liberada para o Windows: fica sem conta e /v1/credential não entrega nada.
  assert.deepEqual(await ctx.engine.setAccountDevices(2, []), { number: 2, devices: [] });
  assert.equal(ctx.store.state.devices[win.deviceId].assigned, null);
  r = await api("GET", "/v1/credential", { token: win.token });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, "no_account");
  r = await api("GET", "/v1/state", { token: win.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.credential, null);

  // Liberada de novo só para ele: na próxima conexão recebe a 2.
  await ctx.engine.setAccountDevices(2, [win.deviceId]);
  r = await api("POST", "/v1/heartbeat", { token: win.token, body: {} });
  assert.equal(r.json.device.assigned, 2);

  // Remover a conta 1 (rota da API) apaga a lista dela.
  r = await api("DELETE", "/v1/accounts/1", { token: win.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ctx.store.state.accountDevices, { 2: [win.deviceId] });
  assert.deepEqual(cofreEmDisco(ctx).accountDevices, { 2: [win.deviceId] });

  // O admin local desconecta o Windows: a lista da 2 fica vazia (e fica assim).
  r = await request(ctx, ctx.admin, "DELETE", `/admin/devices/${win.deviceId}`);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ctx.store.state.accountDevices, { 2: [] });
  assert.deepEqual(cofreEmDisco(ctx).accountDevices, { 2: [] });
  assert.ok(ctx.store.state.history.some((h) => h.kind === "alert" && h.text.startsWith('A conta 2 não está liberada para nenhum serviço agora ("Windows" era o único)')));

  assert.equal(ctx.anthropic.calls, 0, "nada falou com a Anthropic");
});

test("API + motor: desconectar um serviço que não está em lista nenhuma não mexe nas listas nem avisa", async (t) => {
  const ctx = await setup(t);
  const mac = await pairDevice(ctx, "Mac");
  const win = await pairDevice(ctx, "Windows");
  await ctx.engine.setAccountDevices(1, [mac.deviceId]);
  const alerts = () => ctx.store.state.history.filter((h) => h.kind === "alert").length;
  const a0 = alerts();

  const r = await request(ctx, ctx.api, "DELETE", `/v1/devices/${win.deviceId}`, { token: mac.token });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(ctx.store.state.accountDevices, { 1: [mac.deviceId] });
  assert.equal(alerts(), a0);
});

// Presença de ponta a ponta: o token aceito na API (server.js) → engine.touch → engine.devicesList → PanelState (web.js).
test("API + motor: presença — ler o estado sem batimento marca contato; o painel vê ativo, conectado e sem contato; nada disso vai para o cofre", async (t) => {
  const clock = { t: Date.now() };
  const ctx = await setup(t, { clock });
  const api = (method, p, opts) => request(ctx, ctx.api, method, p, opts);
  const vscode = await pairDevice(ctx, "VS Code do Paulo");
  const hermes = await pairDevice(ctx, "Hermes (servidor)");
  const robo = await pairDevice(ctx, "Robô");
  const pareado = clock.t;
  // Os serviços como o painel recebe: o PanelState de verdade (web.js) em cima do motor de verdade.
  const painel = () => Object.fromEntries(ctx.app.web.panelState({ s: { email: "dono@exemplo.com" } }).devices.map((d) => [d.name, d]));
  const visto = (d) => [d.presence, d.active, d.connected, d.lastContact];

  // Quem acabou de conectar conta como ativo por 5 min (o pareamento marca o lastSeen). 10 min depois, sem falar nada:
  assert.deepEqual(visto(painel()["Hermes (servidor)"]), ["active", true, true, pareado]);
  clock.t += 10 * MIN;
  for (const nome of ["VS Code do Paulo", "Hermes (servidor)", "Robô"]) assert.deepEqual(visto(painel()[nome]), ["none", false, false, pareado], nome);

  // O VS Code em uso manda o batimento; o Hermes ocioso só lê o estado; o robô não fala.
  let r = await api("POST", "/v1/heartbeat", { token: vscode.token, body: { models: [] } });
  assert.equal(r.status, 200, r.text);
  r = await api("GET", "/v1/state", { token: hermes.token });
  assert.equal(r.status, 200, r.text);
  const eu = r.json.devices.find((d) => d.current);
  assert.deepEqual([eu.id, ...visto(eu)], [hermes.deviceId, "connected", false, true, clock.t], "a resposta do próprio pedido já traz a presença");
  let p = painel();
  assert.deepEqual(visto(p["VS Code do Paulo"]), ["active", true, true, clock.t]);
  assert.deepEqual(visto(p["Hermes (servidor)"]), ["connected", false, true, clock.t]);
  assert.deepEqual(visto(p["Robô"]), ["none", false, false, pareado]);
  assert.equal(p["Hermes (servidor)"].lastSeen, pareado, "ler o estado não mexe no lastSeen (uso)");
  assert.equal(ctx.store.state.devices[hermes.deviceId].assigned, null, "nem dá (ou ocupa) uma conta");
  assert.equal(ctx.engine.status().activeDevices, 1, "para as decisões só o VS Code está em uso");

  // Pedido com token bom que é recusado depois (404: a conta não existe) também é contato; token errado não é de ninguém.
  r = await api("POST", "/v1/switch", { token: robo.token, body: { number: 99 } });
  assert.equal(r.status, 404, r.text);
  assert.deepEqual(visto(painel()["Robô"]), ["connected", false, true, clock.t]);
  const contatos = ctx.engine.contacts.size;
  r = await api("GET", "/v1/state", { token: "x".repeat(43) });
  assert.equal(r.status, 401, r.text);
  assert.equal(ctx.engine.contacts.size, contatos);

  // No cofre: o lastSeen do Hermes continua o do pareamento e nenhum campo de presença foi gravado.
  await ctx.store.save();
  const disco = cofreEmDisco(ctx);
  assert.equal(disco.devices[hermes.deviceId].lastSeen, pareado);
  assert.ok(!/"(lastContact|presence|connected|contacts)"\s*:/.test(JSON.stringify(disco)));

  // Mais de 5 min sem o Hermes falar: sem contato, com a hora do último pedido dele.
  const ultimo = clock.t;
  clock.t += 5 * MIN + 1;
  assert.deepEqual(visto(painel()["Hermes (servidor)"]), ["none", false, false, ultimo]);

  // Desconectado: sai da lista do painel e o contato dele sai da memória do motor.
  assert.equal(ctx.engine.contacts.has(hermes.deviceId), true);
  r = await request(ctx, ctx.admin, "DELETE", `/admin/devices/${hermes.deviceId}`);
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.engine.contacts.has(hermes.deviceId), false);
  assert.deepEqual(Object.keys(painel()).sort(), ["Robô", "VS Code do Paulo"]);
  assert.equal(ctx.anthropic.calls, 0, "nada falou com a Anthropic");
});

test("API + motor (2.8.0): apelido com emoji pela API sai sem surrogate solto no estado e no cofre (critério 23)", async (t) => {
  const ctx = await setup(t);
  const mac = await pairDevice(ctx, "Mac");
  const alias = "x" + "😀".repeat(30);
  let r = await request(ctx, ctx.api, "PATCH", "/v1/accounts/1", { token: mac.token, body: { alias } });
  assert.equal(r.status, 200, r.text);
  r = await request(ctx, ctx.api, "GET", "/v1/state", { token: mac.token });
  const rec = r.json.records["1"] || {};
  const pub = r.json.list.accounts.find((a) => a.number === 1) || {};
  const visto = rec.alias !== undefined ? rec.alias : pub.alias;
  assert.equal(visto, alias, r.text.slice(0, 300)); // 31 pontos de código: cabe inteiro (antes: 40 unidades e meio emoji)
  assert.ok(!/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i.test(r.text), "a resposta JSON não leva surrogate solto (\\udXXX)");
  // Mais de 40 pontos de código: 40, sem meio emoji.
  r = await request(ctx, ctx.api, "PATCH", "/v1/accounts/1", { token: mac.token, body: { alias: "x" + "😀".repeat(50) } });
  assert.equal(r.status, 200, r.text);
  const gravado = cofreEmDisco(ctx).accounts["1"].alias;
  assert.equal(gravado, "x" + "😀".repeat(39));
  assert.ok(!/[\uD800-\uDFFF]/u.test(gravado), "surrogate solto no cofre");
});
