"use strict";
// Testes da API do servidor (server.js): cofre de verdade numa pasta temporária
// (chave gerada aqui) e um Engine de mentira que só registra as chamadas.
// Rodar no servidor:  node --test server/test/*.test.js     (TEST_LOG=1 mostra os logs)

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { Store, decrypt, loadKey } = require("../src/store");
const { createApp, loadConfig, MAX_BODY } = require("../src/server");

const REFRESH_SECRETO = "sk-ant-ort01-REFRESH-SECRETO-de-teste";
const ACESSO = "sk-ant-oat01-ACESSO-de-teste";
const PUBLIC_URL = "https://swap.exemplo.com:8443";
const TOKEN_FALSO = "y".repeat(43);

const silentLog = { log() {}, info() {}, debug() {}, warn() {}, error() {} };
const testLog = process.env.TEST_LOG ? console : silentLog;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------------------
// Engine de mentira: mesmos métodos da SPEC, só registra o que recebeu.
// ---------------------------------------------------------------------------

class FakeEngine {
  constructor(store) {
    this.store = store;
    this.calls = [];
    this.loginError = null;
    this.credential = {
      number: 1,
      gen: 3,
      claudeAiOauth: {
        accessToken: ACESSO,
        refreshToken: REFRESH_SECRETO, // engine "com defeito": o servidor não pode deixar sair
        expiresAt: 1,
        scopes: ["user:inference"],
        subscriptionType: "team",
        rateLimitTier: "default_claude_max_5x",
      },
      oauthAccount: { emailAddress: "a@exemplo.com", organizationUuid: "org-1" },
    };
  }
  rec(name, ...args) {
    this.calls.push({ name, args });
  }
  last(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i].name === name) return this.calls[i];
    return null;
  }
  count(name) {
    return this.calls.filter((c) => c.name === name).length;
  }
  start() {}
  stop() {}
  rulesEffective() {
    return { sessionPct: 90, weeklyPct: 80, modelPct: 95, strategy: "max" };
  }
  publicList() {
    return { schemaVersion: 1, activeAccountNumber: null, accounts: [] };
  }
  records() {
    return {};
  }
  stateFor(deviceId) {
    this.rec("stateFor", deviceId);
    const d = this.store.state.devices[deviceId];
    return {
      serverTime: Date.now(),
      version: "teste",
      device: d ? { id: d.id, name: d.name, assigned: d.assigned, lastSwitchAt: d.lastSwitchAt } : null,
      list: this.publicList(deviceId),
      records: this.records(),
      rules: this.rulesEffective(),
      autoSwitch: true,
      credential: { number: 1, gen: 3, expiresAt: 1 },
      history: [],
      devices: [],
      diag: {},
      vazamento: { refreshToken: REFRESH_SECRETO }, // idem: tem de ser filtrado
    };
  }
  async heartbeat(deviceId, payload) {
    this.rec("heartbeat", deviceId, payload);
  }
  async credentialFor(deviceId) {
    this.rec("credentialFor", deviceId);
    return this.credential;
  }
  async switchDevice(deviceId, number, by) {
    this.rec("switchDevice", deviceId, number, by);
  }
  async limitHit(deviceId, label) {
    this.rec("limitHit", deviceId, label);
    return { switched: true, text: "trocou para a conta 2" };
  }
  async addLogin(body) {
    this.rec("addLogin", body);
    if (this.loginError) {
      const e = new Error("o e-mail do login não bate com o perfil");
      e.code = this.loginError;
      throw e;
    }
    return { number: 3, created: true };
  }
  async updateAccount(number, patch) {
    this.rec("updateAccount", number, patch);
  }
  async removeAccount(number) {
    this.rec("removeAccount", number);
  }
  async setRules(arg) {
    this.rec("setRules", arg);
  }
  pushHistory(kind, text, deviceId) {
    this.rec("pushHistory", kind, text, deviceId);
  }
  // Presença: o servidor avisa o motor de cada pedido autenticado (touch) e de cada serviço desconectado.
  touch(deviceId) {
    this.rec("touch", deviceId);
  }
  forgetContact(deviceId) {
    this.rec("forgetContact", deviceId);
  }
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

function conta(number, email) {
  const t = Date.now();
  return {
    number,
    email,
    orgUuid: "org-1",
    orgName: "Empresa",
    plan: { label: "Team" },
    alias: null,
    oauthAccount: { emailAddress: email, organizationUuid: "org-1" },
    cred: {
      accessToken: ACESSO,
      refreshToken: REFRESH_SECRETO,
      expiresAt: t + 3600 * 1000,
      scopes: ["user:inference"],
      subscriptionType: "team",
      rateLimitTier: "x",
    },
    gen: 1,
    dead: null,
    disabled: false,
    threshold: null,
    priority: 0,
    usage: { fiveHour: { pct: 34, resetsAt: null }, sevenDay: { pct: 61, resetsAt: null } },
    usageFetchedAt: t,
    usageError: null,
    lastGoodUsage: null,
    lastGoodAt: null,
    nextPollAt: 0,
    pollBackoffUntil: 0,
    refreshBackoffUntil: 0,
    refreshFailures: 0,
    addedAt: t,
    lastRefreshAt: null,
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

async function setup(t, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-api-"));
  const keyFile = path.join(dir, "chave-mestra");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "dados"), keyFile });
  store.load();
  store.state.accounts = { 1: conta(1, "a@exemplo.com"), 2: conta(2, "b@exemplo.com") };
  await store.save();
  const engine = new FakeEngine(store);
  const clock = { t: Date.now() };
  const config = loadConfig({ TLS_MODE: "off", DATA_DIR: dir, PUBLIC_URL, ...env });
  const app = createApp({ store, engine, config, now: () => clock.t, log: testLog });
  const api = await listen(app.api);
  const admin = await listen(app.admin);
  t.after(async () => {
    await close(api.server);
    await close(admin.server);
    store.close(); // solta a trava da pasta (store.lock)
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, keyFile, store, engine, clock, config, app, api: api.port, admin: admin.port };
}

/** O que está gravado no cofre em disco (sem abrir um segundo Store na mesma pasta: a trava store.lock não deixa). */
function cofreEmDisco(ctx) {
  return decrypt(loadKey(ctx.keyFile), fs.readFileSync(ctx.store.file));
}

/** Requisição HTTP crua. Toda resposta passa pelas checagens de segredo e de formato de erro. */
function request(port, method, p, { token, body, raw, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
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
          // O campo refreshToken nunca sai (refreshTokenExpiresAt, a data do fim do login, pode sair).
          assert.ok(!/"refreshToken"\s*:/.test(text), `resposta de ${method} ${p} contém o campo "refreshToken"`);
          assert.ok(!text.includes(REFRESH_SECRETO), `resposta de ${method} ${p} contém o refresh token`);
          assert.ok(!text.includes("tokenHash"), `resposta de ${method} ${p} contém "tokenHash"`);
          if (res.statusCode >= 400) {
            assert.ok(json && typeof json.error === "string" && typeof json.message === "string", `erro sem {error, message}: ${text}`);
            assert.ok(!("stack" in json) && !/\n\s+at /.test(text), `erro com stack: ${text}`);
          }
        } catch (e) {
          reject(e);
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

async function pairCode(ctx) {
  const r = await request(ctx.admin, "POST", "/admin/pair-code");
  assert.equal(r.status, 200, r.text);
  return r.json;
}

async function pairDevice(ctx, name = "Notebook") {
  const { code } = await pairCode(ctx);
  const r = await request(ctx.api, "POST", "/v1/pair", { body: { code, name, platform: "darwin" } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

const outro = (code) => (code[0] === "A" ? "B" : "A") + code.slice(1);

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test("health responde sem autenticação (API e admin)", async (t) => {
  const ctx = await setup(t);
  const r = await request(ctx.api, "GET", "/v1/health");
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true);
  assert.equal(typeof r.json.version, "string");
  const a = await request(ctx.admin, "GET", "/v1/health");
  assert.equal(a.status, 200);
  assert.equal(a.json.ok, true);
});

test("sem token ou com token inválido → 401; rota desconhecida → 404; método errado → 405", async (t) => {
  const ctx = await setup(t);
  let r = await request(ctx.api, "GET", "/v1/state");
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "unauthorized");
  assert.match(String(r.headers["www-authenticate"]), /Bearer/);

  r = await request(ctx.api, "GET", "/v1/state", { token: TOKEN_FALSO });
  assert.equal(r.status, 401);
  r = await request(ctx.api, "GET", "/v1/credential", { headers: { authorization: "Basic dXNlcjpzZW5oYQ==" } });
  assert.equal(r.status, 401);
  r = await request(ctx.api, "POST", "/v1/heartbeat", { body: { models: [] } });
  assert.equal(r.status, 401);
  assert.equal(ctx.engine.count("heartbeat"), 0);
  assert.equal(ctx.engine.count("credentialFor"), 0);
  assert.equal(ctx.engine.count("touch"), 0, "pedido sem token válido não conta como contato de ninguém");

  r = await request(ctx.api, "GET", "/v1/nao-existe");
  assert.equal(r.status, 404);
  r = await request(ctx.api, "GET", "/v1/pair");
  assert.equal(r.status, 405);
  assert.match(String(r.headers.allow), /POST/);
});

test("pareamento: código de conexão, token do dispositivo e uso único", async (t) => {
  const ctx = await setup(t);
  const pc = await pairCode(ctx);
  assert.match(pc.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  assert.ok(pc.connect.startsWith("swapplus1:"));
  const dec = JSON.parse(Buffer.from(pc.connect.slice("swapplus1:".length), "base64url").toString("utf8"));
  assert.deepEqual(dec, { url: PUBLIC_URL, code: pc.code, fp: null });
  assert.ok(ctx.store.state.pairing);
  assert.equal(ctx.store.state.pairing.codeHash, sha256(pc.code)); // só o hash fica no cofre
  assert.ok(pc.expiresAt > ctx.clock.t);

  // Digitado em minúsculas e com hífen também vale.
  const digitado = `${pc.code.slice(0, 5)}-${pc.code.slice(5)}`.toLowerCase();
  const r = await request(ctx.api, "POST", "/v1/pair", { body: { code: digitado, name: "Notebook do Paulo", platform: "darwin" } });
  assert.equal(r.status, 200, r.text);
  assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/); // 32 bytes em base64url
  const dev = ctx.store.state.devices[r.json.deviceId];
  assert.ok(dev);
  assert.equal(dev.name, "Notebook do Paulo");
  assert.equal(dev.platform, "darwin");
  assert.equal(dev.tokenHash, sha256(r.json.token));
  assert.ok(!JSON.stringify(dev).includes(r.json.token), "o token em claro não pode ficar no cofre");
  assert.equal(ctx.store.state.pairing, null);

  // Foi gravado no cofre em disco.
  const doDisco = { state: cofreEmDisco(ctx) };
  assert.ok(doDisco.state.devices[r.json.deviceId]);
  assert.equal(doDisco.state.pairing, null);

  // O token funciona.
  const s = await request(ctx.api, "GET", "/v1/state", { token: r.json.token });
  assert.equal(s.status, 200);
  assert.equal(s.json.device.id, r.json.deviceId);
  assert.deepEqual(ctx.engine.last("stateFor").args, [r.json.deviceId]);

  // Uso único: o mesmo código não serve de novo.
  const r2 = await request(ctx.api, "POST", "/v1/pair", { body: { code: pc.code, name: "Outro" } });
  assert.equal(r2.status, 401);
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);
});

test("pareamento: o código vence em 10 minutos", async (t) => {
  const ctx = await setup(t);
  // Quase no fim ainda vale.
  const pc1 = await pairCode(ctx);
  ctx.clock.t += 10 * 60 * 1000 - 1000;
  let r = await request(ctx.api, "POST", "/v1/pair", { body: { code: pc1.code, name: "No limite" } });
  assert.equal(r.status, 200, r.text);

  // Depois de 10 min, não.
  const pc2 = await pairCode(ctx);
  ctx.clock.t += 10 * 60 * 1000 + 1;
  r = await request(ctx.api, "POST", "/v1/pair", { body: { code: pc2.code, name: "Atrasado" } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "code_expired");
  assert.equal(ctx.store.state.pairing, null);
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);
});

test("pareamento: 5 erros descartam o código; 4 ainda deixam usar", async (t) => {
  const ctx = await setup(t);
  const pc = await pairCode(ctx);
  for (let i = 1; i <= 5; i++) {
    const r = await request(ctx.api, "POST", "/v1/pair", { body: { code: outro(pc.code), name: "x" } });
    assert.equal(r.status, 401);
    assert.equal(r.json.error, "invalid_code");
  }
  assert.equal(ctx.store.state.pairing, null);
  let r = await request(ctx.api, "POST", "/v1/pair", { body: { code: pc.code, name: "x" } });
  assert.equal(r.status, 401, "o código certo não vale mais depois de 5 erros");
  assert.equal(Object.keys(ctx.store.state.devices).length, 0);

  const pc2 = await pairCode(ctx);
  for (let i = 1; i <= 4; i++) {
    r = await request(ctx.api, "POST", "/v1/pair", { body: { code: outro(pc2.code), name: "x" } });
    assert.equal(r.status, 401);
  }
  assert.equal(ctx.store.state.pairing.attempts, 4);
  r = await request(ctx.api, "POST", "/v1/pair", { body: { code: pc2.code, name: "Depois de 4 erros" } });
  assert.equal(r.status, 200, r.text);
});

test("token revogado deixa de valer (pela API e pelo admin)", async (t) => {
  const ctx = await setup(t);
  const a = await pairDevice(ctx, "Notebook");
  const b = await pairDevice(ctx, "iMac");

  const l = await request(ctx.api, "GET", "/v1/devices", { token: a.token });
  assert.equal(l.status, 200);
  assert.equal(l.json.length, 2);
  assert.equal(l.json.find((d) => d.id === a.deviceId).current, true);
  assert.equal(l.json.find((d) => d.id === b.deviceId).current, false);
  for (const d of l.json) {
    assert.deepEqual(Object.keys(d).sort(), ["assigned", "createdAt", "current", "googleEmail", "id", "lastSeen", "name", "platform"]);
    assert.equal(d.googleEmail, null, "pareado por código: sem conta Google");
  }

  // a revoga b pela API
  let r = await request(ctx.api, "DELETE", `/v1/devices/${b.deviceId}`, { token: a.token });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { ok: true });
  assert.deepEqual(ctx.engine.calls.filter((c) => c.name === "forgetContact").map((c) => c.args), [[b.deviceId]], "o contato do desconectado sai da memória do motor");
  const contatos = ctx.engine.count("touch");
  r = await request(ctx.api, "GET", "/v1/state", { token: b.token });
  assert.equal(r.status, 401);
  assert.equal(ctx.engine.count("touch"), contatos, "token revogado: 401 antes de contar como contato");

  // o admin revoga a
  r = await request(ctx.admin, "DELETE", `/admin/devices/${a.deviceId}`);
  assert.equal(r.status, 200);
  assert.deepEqual(ctx.engine.last("forgetContact").args, [a.deviceId]);
  r = await request(ctx.api, "GET", "/v1/state", { token: a.token });
  assert.equal(r.status, 401);
  assert.equal(ctx.engine.count("touch"), contatos);

  r = await request(ctx.admin, "DELETE", `/admin/devices/${a.deviceId}`);
  assert.equal(r.status, 404);
  assert.deepEqual(ctx.store.state.devices, {});
  assert.ok(ctx.engine.count("pushHistory") >= 4, "conectar/desconectar vai para o histórico");
});

test("ALLOW_IPS (IPv4 e CIDR) e TRUST_PROXY", async (t) => {
  // 127.0.0.1 fora da lista → 403 (o admin local continua respondendo)
  const c1 = await setup(t, { ALLOW_IPS: "10.0.0.0/8, 203.0.113.7" });
  let r = await request(c1.api, "GET", "/v1/health");
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "forbidden");
  r = await request(c1.api, "POST", "/v1/pair", { body: { code: "x" } });
  assert.equal(r.status, 403);
  r = await request(c1.admin, "GET", "/v1/health");
  assert.equal(r.status, 200);

  // dentro da lista → passa
  const c2 = await setup(t, { ALLOW_IPS: "127.0.0.0/8" });
  r = await request(c2.api, "GET", "/v1/health");
  assert.equal(r.status, 200);
  const c2b = await setup(t, { ALLOW_IPS: "127.0.0.1" });
  r = await request(c2b.api, "GET", "/v1/health");
  assert.equal(r.status, 200);

  // atrás do proxy vale o 1º IP do X-Forwarded-For
  const c3 = await setup(t, { ALLOW_IPS: "203.0.113.0/24", TRUST_PROXY: "1" });
  r = await request(c3.api, "GET", "/v1/health", { headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" } });
  assert.equal(r.status, 200);
  r = await request(c3.api, "GET", "/v1/health", { headers: { "x-forwarded-for": "198.51.100.1, 203.0.113.9" } });
  assert.equal(r.status, 403);
  r = await request(c3.api, "GET", "/v1/health");
  assert.equal(r.status, 403);
  // token bom vindo de um endereço fora da lista: 403 antes de conferir o token (não conta como contato do serviço)
  const pc3 = await pairCode(c3);
  const dev3 = await request(c3.api, "POST", "/v1/pair", { body: { code: pc3.code, name: "Notebook" }, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(dev3.status, 200, dev3.text);
  r = await request(c3.api, "GET", "/v1/state", { token: dev3.json.token });
  assert.equal(r.status, 403);
  assert.equal(c3.engine.count("touch"), 0);
  r = await request(c3.api, "GET", "/v1/state", { token: dev3.json.token, headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(c3.engine.last("touch").args, [dev3.json.deviceId]);
  assert.equal(c3.engine.count("touch"), 1);

  // sem TRUST_PROXY o cabeçalho é ignorado
  const c4 = await setup(t, { ALLOW_IPS: "203.0.113.0/24" });
  r = await request(c4.api, "GET", "/v1/health", { headers: { "x-forwarded-for": "203.0.113.9" } });
  assert.equal(r.status, 403);

  // entrada inválida derruba a configuração (em vez de liberar tudo)
  assert.throws(() => loadConfig({ ALLOW_IPS: "300.1.1.1" }), /ALLOW_IPS/);
  assert.throws(() => loadConfig({ ALLOW_IPS: "10.0.0.0/33" }), /ALLOW_IPS/);
  assert.throws(() => loadConfig({ ALLOW_IPS: "servidor.exemplo.com" }), /ALLOW_IPS/);
});

test("corpo maior que 256 KB → 413; JSON inválido → 400", async (t) => {
  const ctx = await setup(t);
  const d = await pairDevice(ctx);
  const grande = JSON.stringify({ models: ["x".repeat(MAX_BODY)] });
  assert.ok(Buffer.byteLength(grande) > MAX_BODY);

  let r = await request(ctx.api, "POST", "/v1/heartbeat", { token: d.token, raw: grande });
  assert.equal(r.status, 413);
  assert.equal(r.json.error, "too_large");
  assert.equal(ctx.engine.count("heartbeat"), 0);

  r = await request(ctx.api, "POST", "/v1/pair", { raw: grande });
  assert.equal(r.status, 413);

  r = await request(ctx.api, "POST", "/v1/heartbeat", { token: d.token, raw: "{quebrado" });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "bad_json");
  r = await request(ctx.api, "POST", "/v1/heartbeat", { token: d.token, raw: "[1,2]" });
  assert.equal(r.status, 400);

  // logo abaixo do limite passa
  const cabe = JSON.stringify({ models: ["claude-fable-5"], live: null, folga: "x".repeat(MAX_BODY - 200) });
  r = await request(ctx.api, "POST", "/v1/heartbeat", { token: d.token, raw: cabe });
  assert.equal(r.status, 200, r.text);
});

test("cada rota chama o método certo do engine", async (t) => {
  const ctx = await setup(t);
  const E = ctx.engine;
  const { token, deviceId: id } = await pairDevice(ctx, "Notebook");
  assert.equal(E.count("touch"), 0, "parear não é um pedido autenticado");
  let pedidos = 0; // pedidos com o token deste serviço: cada um conta como contato, mesmo os recusados depois
  const call = (method, p, body) => {
    pedidos++;
    return request(ctx.api, method, p, { token, body });
  };

  // heartbeat → heartbeat + stateFor (campos filtrados)
  let r = await call("POST", "/v1/heartbeat", {
    models: ["claude-fable-5", 42],
    live: { email: "a@exemplo.com", orgUuid: "org-1", expiresAt: 123, extra: "x" },
  });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.id, id);
  assert.deepEqual(E.last("heartbeat").args, [id, { models: ["claude-fable-5"], live: { email: "a@exemplo.com", orgUuid: "org-1", expiresAt: 123 } }]);
  r = await call("POST", "/v1/heartbeat", { live: null });
  assert.deepEqual(E.last("heartbeat").args, [id, { models: [], live: null }]);
  r = await call("POST", "/v1/heartbeat", { models: "não é lista" });
  assert.equal(r.status, 400);

  // state
  const antes = E.count("stateFor");
  r = await call("GET", "/v1/state");
  assert.equal(r.status, 200);
  assert.equal(E.count("stateFor"), antes + 1);
  assert.equal(r.json.vazamento && r.json.vazamento.refreshToken, undefined);

  // credential → credentialFor, sem refreshToken
  r = await call("GET", "/v1/credential");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("credentialFor").args, [id]);
  assert.deepEqual(r.json, {
    number: 1,
    gen: 3,
    claudeAiOauth: {
      accessToken: ACESSO,
      expiresAt: 1,
      scopes: ["user:inference"],
      subscriptionType: "team",
      rateLimitTier: "default_claude_max_5x",
    },
    oauthAccount: { emailAddress: "a@exemplo.com", organizationUuid: "org-1" },
  });
  // até quando vale o login (refreshTokenExpiresAt) passa quando o motor sabe; o refreshToken continua de fora
  E.credential.claudeAiOauth.refreshTokenExpiresAt = 1764622800000;
  r = await call("GET", "/v1/credential");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.claudeAiOauth.refreshTokenExpiresAt, 1764622800000);
  assert.equal(r.json.claudeAiOauth.refreshToken, undefined);
  assert.ok(!r.text.includes(REFRESH_SECRETO));
  delete E.credential.claudeAiOauth.refreshTokenExpiresAt;
  E.credential = null;
  r = await call("GET", "/v1/credential");
  assert.equal(r.status, 409);
  assert.equal(r.json.error, "no_account");

  // logins → addLogin (o engine recebe o refresh token; a resposta não)
  const login = {
    claudeAiOauth: { accessToken: "a", refreshToken: "sk-ant-ort01-OUTRO", expiresAt: 1 },
    oauthAccount: { emailAddress: "c@exemplo.com", organizationUuid: "org-2" },
    plan: { label: "Max" },
  };
  r = await call("POST", "/v1/logins", login);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { number: 3, created: true });
  // o servidor diz ao engine qual serviço mandou o login (vai para o histórico)
  assert.deepEqual(E.last("addLogin").args, [{ ...login, deviceId: id, number: null }]);
  E.loginError = "identity_mismatch";
  r = await call("POST", "/v1/logins", login);
  assert.equal(r.status, 422);
  assert.equal(r.json.error, "identity_mismatch");
  assert.equal(r.json.message, "o e-mail do login não bate com o perfil");
  r = await call("POST", "/v1/logins", {});
  assert.equal(r.status, 400);

  // switch → switchDevice(id, n|null, "manual")
  r = await call("POST", "/v1/switch", { number: 2 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("switchDevice").args, [id, 2, "manual"]);
  r = await call("POST", "/v1/switch", { number: null });
  assert.equal(r.status, 200);
  assert.deepEqual(E.last("switchDevice").args, [id, null, "manual"]);
  r = await call("POST", "/v1/switch", { number: 99 });
  assert.equal(r.status, 404);
  r = await call("POST", "/v1/switch", { number: "dois" });
  assert.equal(r.status, 400);

  // events → limitHit
  r = await call("POST", "/v1/events", { kind: "limit_hit", label: "5h" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("limitHit").args, [id, "5h"]);
  assert.equal(r.json.switched, true);
  assert.equal(r.json.text, "trocou para a conta 2");
  assert.equal(r.json.state.device.id, id);
  r = await call("POST", "/v1/events", { kind: "outro" });
  assert.equal(r.status, 400);

  // PATCH conta → updateAccount (só os campos aceitos)
  r = await call("PATCH", "/v1/accounts/2", { disabled: true, alias: "Trabalho", threshold: "85", campoEstranho: 1 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("updateAccount").args, [2, { disabled: true, threshold: 85, alias: "Trabalho" }]);
  r = await call("PATCH", "/v1/accounts/2", { threshold: null, priority: 3, alias: "" });
  assert.deepEqual(E.last("updateAccount").args, [2, { threshold: null, priority: 3, alias: null }]);
  r = await call("PATCH", "/v1/accounts/2", { weeklyThreshold: "75", modelThreshold: 90 });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("updateAccount").args, [2, { weeklyThreshold: 75, modelThreshold: 90 }]);
  r = await call("PATCH", "/v1/accounts/2", { weeklyThreshold: null, modelThreshold: null });
  assert.deepEqual(E.last("updateAccount").args, [2, { weeklyThreshold: null, modelThreshold: null }]);
  for (const body of [{ weeklyThreshold: 40 }, { modelThreshold: 101 }, { threshold: 10 }]) {
    r = await call("PATCH", "/v1/accounts/2", body);
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  r = await call("PATCH", "/v1/accounts/99", { disabled: true });
  assert.equal(r.status, 404);
  r = await call("PATCH", "/v1/accounts/2", { disabled: "sim" });
  assert.equal(r.status, 400);
  r = await call("PATCH", "/v1/accounts/2", {});
  assert.equal(r.status, 400);

  // DELETE conta → removeAccount
  r = await call("DELETE", "/v1/accounts/2");
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("removeAccount").args, [2]);
  r = await call("DELETE", "/v1/accounts/99");
  assert.equal(r.status, 404);

  // regras → setRules (chaves desconhecidas ignoradas; o que não veio segue como está)
  r = await call("PUT", "/v1/rules", { rules: { sessionPct: 85, desconhecida: 1 }, autoSwitch: false });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("setRules").args, [{ rules: { sessionPct: 85 }, autoSwitch: false }]);
  r = await call("PUT", "/v1/rules", { autoSwitch: true });
  assert.deepEqual(E.last("setRules").args, [{ rules: null, autoSwitch: true }]);
  r = await call("PUT", "/v1/rules", { rules: { sessionPct: "muito" } });
  assert.equal(r.status, 400);
  r = await call("PUT", "/v1/rules", {});
  assert.equal(r.status, 400);

  // erro inesperado do engine → 500 genérico, sem detalhes nem stack
  E.removeAccount = async () => {
    throw new Error("falha interna com sk-ant-oat01-NAO-PODE-SAIR");
  };
  r = await call("DELETE", "/v1/accounts/1");
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: "internal", message: "erro interno no servidor" });
  assert.ok(!r.text.includes("NAO-PODE-SAIR"));

  // Presença: cada pedido com o token aceito avisou o motor (touch) uma vez — os que deram certo e os recusados
  // depois (400, 404, 409, 422, 500) —, sempre com o id do serviço e antes de a rota rodar.
  const contatos = E.calls.filter((c) => c.name === "touch");
  assert.ok(pedidos >= 30, `o teste fez ${pedidos} pedidos`);
  assert.equal(contatos.length, pedidos);
  assert.ok(contatos.every((c) => c.args.length === 1 && c.args[0] === id));
  assert.ok(E.calls.findIndex((c) => c.name === "touch") < E.calls.findIndex((c) => c.name === "heartbeat"), "o contato é marcado na entrada, antes da rota");
});

test("limite de tentativas: 20 respostas 401 em 10 min → 429 por 10 min", async (t) => {
  const ctx = await setup(t);
  const d = await pairDevice(ctx);
  for (let i = 1; i <= 20; i++) {
    const r = await request(ctx.api, "GET", "/v1/state", { token: TOKEN_FALSO });
    assert.equal(r.status, 401, `tentativa ${i}`);
  }
  let r = await request(ctx.api, "GET", "/v1/state", { token: TOKEN_FALSO });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "too_many_attempts");
  assert.ok(Number(r.headers["retry-after"]) > 0);
  // bloqueia o IP inteiro, até com token bom
  r = await request(ctx.api, "GET", "/v1/state", { token: d.token });
  assert.equal(r.status, 429);
  assert.equal(ctx.engine.count("touch"), 0, "pedido barrado antes de conferir o token não conta como contato");
  // passados 10 min, volta
  ctx.clock.t += 10 * 60 * 1000 + 1;
  r = await request(ctx.api, "GET", "/v1/state", { token: d.token });
  assert.equal(r.status, 200);
  assert.deepEqual(ctx.engine.calls.filter((c) => c.name === "touch").map((c) => c.args), [[d.deviceId]]);
});

test("admin: status e dispositivos sem segredos; recusa navegador; exige PUBLIC_URL", async (t) => {
  const ctx = await setup(t);
  await pairDevice(ctx, "Notebook");

  let r = await request(ctx.admin, "GET", "/admin/status");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.accounts.length, 2);
  assert.equal(r.json.devices.length, 1);
  assert.equal(r.json.publicUrl, PUBLIC_URL);
  assert.ok(!r.text.includes(ACESSO), "o status não mostra access token");

  r = await request(ctx.admin, "GET", "/admin/devices");
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].name, "Notebook");

  r = await request(ctx.admin, "POST", "/admin/pair-code", { headers: { origin: "https://site.exemplo" } });
  assert.equal(r.status, 403);

  const semUrl = await setup(t, { PUBLIC_URL: "" });
  r = await request(semUrl.admin, "POST", "/admin/pair-code");
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "no_public_url");
  assert.equal(semUrl.store.state.pairing, null);
});

test("logins: só os serviços do administrador enviam (Google com e-mail de ADMIN_EMAILS ou pareado por código); os outros → 403 not_admin sem chamar o engine", async (t) => {
  const NAO_ADMIN = "Só os serviços do administrador enviam logins ao servidor. Este serviço usa as contas do servidor.";
  const ctx = await setup(t, { ADMIN_EMAILS: "dono.exemplo@gmail.com" });
  const E = ctx.engine;
  const login = {
    claudeAiOauth: { accessToken: "a", refreshToken: "sk-ant-ort01-DO-COMPUTADOR", expiresAt: 1 },
    oauthAccount: { emailAddress: "c@exemplo.com", organizationUuid: "org-2" },
  };
  // Conectado com Google = dispositivo com googleEmail (o fluxo do Google em si está em google.test.js).
  const comGoogle = async (name, email) => {
    const d = await pairDevice(ctx, name);
    ctx.store.state.devices[d.deviceId].googleEmail = email;
    return d;
  };
  const codigo = await pairDevice(ctx, "Mac do dono"); // pareado por código: googleEmail null
  const admin = await comGoogle("Notebook do dono", "donoexemplo+vscode@gmail.com"); // mesma conta pela emailKey
  const bia = await comGoogle("PC da Bia", "bia@exemplo.com"); // liberada para conectar, mas não é administradora
  const estado = (d) => request(ctx.api, "GET", "/v1/state", { token: d.token });
  const envia = (d, body = login) => request(ctx.api, "POST", "/v1/logins", { token: d.token, body });

  // StateResponse: device.canUploadLogins (GET /v1/state e heartbeat)
  assert.equal((await estado(codigo)).json.device.canUploadLogins, true);
  assert.equal((await estado(admin)).json.device.canUploadLogins, true);
  assert.equal((await estado(bia)).json.device.canUploadLogins, false);
  let r = await request(ctx.api, "POST", "/v1/heartbeat", { token: bia.token, body: { models: [] } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.canUploadLogins, false);

  // administrador com Google envia
  r = await envia(admin);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { number: 3, created: true });
  assert.deepEqual(E.last("addLogin").args, [{ ...login, plan: undefined, deviceId: admin.deviceId, number: null }]);
  // pareado por código envia
  r = await envia(codigo);
  assert.equal(r.status, 200, r.text);
  assert.equal(E.last("addLogin").args[0].deviceId, codigo.deviceId);

  // Google sem ser administrador: 403 not_admin e o engine nem é chamado (nada vai para a Anthropic)
  const chamadas = E.count("addLogin");
  r = await envia(bia);
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, { error: "not_admin", message: NAO_ADMIN });
  assert.ok(!r.text.includes("sk-ant-ort01-DO-COMPUTADOR"));
  r = await envia(bia, {}); // a permissão vem antes da conferência do corpo
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "not_admin");
  assert.equal(E.count("addLogin"), chamadas);
  // o serviço continua conectado, usando as contas do servidor
  assert.equal((await estado(bia)).status, 200);

  // histórico: uma vez por serviço por dia
  const recusas = () => E.calls.filter((c) => c.name === "pushHistory" && /^Login recusado/.test(c.args[1]));
  assert.equal(recusas().length, 1);
  assert.deepEqual(recusas()[0].args, ["alert", 'Login recusado de "PC da Bia": só o administrador envia logins', bia.deviceId]);
  await envia(bia);
  assert.equal(recusas().length, 1, "no mesmo dia não repete");
  ctx.clock.t += 24 * 3600 * 1000;
  r = await envia(bia);
  assert.equal(r.status, 403);
  assert.equal(recusas().length, 2, "no dia seguinte registra de novo");
  assert.equal(E.count("addLogin"), chamadas);

  // ADMIN_EMAILS mudou (sem o dono) e o servidor reiniciou: os serviços dele com Google deixam de enviar;
  // o pareado por código continua (o código só sai da linha de comando/painel do administrador)
  const config2 = loadConfig({ TLS_MODE: "off", DATA_DIR: ctx.dir, PUBLIC_URL, ADMIN_EMAILS: "outra@exemplo.com" });
  const app2 = createApp({ store: ctx.store, engine: E, config: config2, now: () => ctx.clock.t, log: testLog });
  const api2 = await listen(app2.api);
  t.after(() => close(api2.server));
  r = await request(api2.port, "GET", "/v1/state", { token: admin.token });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.canUploadLogins, false);
  r = await request(api2.port, "POST", "/v1/logins", { token: admin.token, body: login });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.error, "not_admin");
  assert.equal(E.count("addLogin"), chamadas);
  r = await request(api2.port, "POST", "/v1/logins", { token: codigo.token, body: login });
  assert.equal(r.status, 200, r.text);
  assert.equal(E.count("addLogin"), chamadas + 1);

  // sem ADMIN_EMAILS nenhum serviço com Google envia; os pareados por código seguem enviando
  const config3 = loadConfig({ TLS_MODE: "off", DATA_DIR: ctx.dir, PUBLIC_URL, ADMIN_EMAILS: "" });
  const app3 = createApp({ store: ctx.store, engine: E, config: config3, now: () => ctx.clock.t, log: testLog });
  const api3 = await listen(app3.api);
  t.after(() => close(api3.server));
  r = await request(api3.port, "GET", "/v1/state", { token: admin.token });
  assert.equal(r.json.device.canUploadLogins, false);
  r = await request(api3.port, "GET", "/v1/state", { token: codigo.token });
  assert.equal(r.json.device.canUploadLogins, true);
});
