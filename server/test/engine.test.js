"use strict";
// Testes do motor (server/src/engine.js) com uma Anthropic de mentira (fetch falso, sem rede)
// e um cofre de verdade numa pasta temporária, com chave gerada aqui.
//
//   node --test server/test/engine.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, decrypt } = require("../src/store");
const { createAnthropic, CLIENT_ID } = require("../src/anthropic");
const { Engine, ERROR_STATUS } = require("../src/engine");
const { createNotifier } = require("../src/notify");
const access = require("../src/access");
const { linesFor, RULE_DEFAULTS } = require("../../plus/rules");

const TOKEN_URL = "https://anthropic.falsa/v1/oauth/token";
const API = "https://api.anthropic.falsa";
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-14T12:00:00Z");

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/** Erro de rede como o fetch do Node (undici) lança: TypeError com o código em `cause`. */
function netError(code) {
  return new TypeError("fetch failed", { cause: Object.assign(new Error(`${code} anthropic.falsa`), { code }) });
}

/** Tempo esgotado (AbortSignal.timeout). */
function timeoutError() {
  return new DOMException("The operation was aborted due to timeout", "TimeoutError");
}

/** Porta que segura uma resposta da Anthropic falsa até abrir. */
function gate() {
  let open;
  const p = new Promise((r) => (open = r));
  return { p, open };
}

/** Deixa as promessas pendentes andarem um pouco. */
async function settle(n = 10) {
  for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
}

const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

/**
 * Anthropic de mentira: emite tokens, gira o refresh token (uso único), responde uso e perfil.
 * Tokens têm cara de token de verdade para o teste de "nada de token no log" valer.
 */
class FakeAnthropic {
  constructor(now) {
    this.now = now;
    this.seq = 0;
    this.people = new Map(); // email → { uuid, email, orgUuid, usage (formato cru da API) }
    this.access = new Map(); // access token → { email, expiresAt, revoked }
    this.refreshTokens = new Map(); // refresh token → { email, spent }
    this.calls = []; // { kind: "refresh"|"usage"|"profile", email, token }
    this.events = []; // "refresh", "usage:<token>"
    // email → modo de falha da renovação:
    //   "invalid_grant"
    //   "transient"   conexão recusada (o pedido nunca saiu; nada gasto)
    //   "dns"         nome não resolve (nunca saiu; nada gasto)
    //   "overloaded"  503 (sem resposta útil: ambígua; nada gasto aqui)
    //   "timeout"     tempo esgotado antes de a Anthropic processar (ambígua; nada gasto)
    //   "lost"        a Anthropic renova (gasta o refresh token) mas a resposta não chega (ambígua; login perdido)
    //   "partial"     200 com refresh token novo e sem access token
    this.refreshFail = new Map();
    this.usageReplies = []; // respostas forçadas para as próximas leituras de uso: { status, body, headers }
    this.profileEmail = new Map(); // email → e-mail que o perfil devolve (simula login de outra pessoa)
    this.tokenExtra = {}; // campos a mais na resposta de renovação bem-sucedida (ex.: refresh_token_expires_in)
    this.expiresIn = 8 * 3600; // expires_in (s) das renovações
    this.omitTokenAccount = false; // true = a renovação não manda account/organization junto
    this.refreshGate = null; // Promise: segura cada renovação (antes de processar) até resolver
    this.onRefresh = null; // chamado quando uma renovação chega
    this.profileGate = null; // Promise: segura cada leitura de perfil até resolver
    this.onProfile = null; // chamado quando uma leitura de perfil chega
    this.onUsage = null;
    this.fetch = this.fetch.bind(this);
  }

  person(email, orgUuid = "org-1") {
    if (!this.people.has(email)) {
      const t = this.now();
      this.people.set(email, {
        uuid: `uuid-${email}`,
        email,
        orgUuid,
        usage: {
          five_hour: { utilization: 10, resets_at: new Date(t + 2 * HOUR).toISOString() },
          seven_day: { utilization: 20, resets_at: new Date(t + 4 * DAY).toISOString() },
          limits: [],
        },
      });
    }
    return this.people.get(email);
  }

  issue(email, expiresInMs = 8 * HOUR) {
    const n = ++this.seq;
    const accessToken = `sk-ant-oat01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const refreshToken = `sk-ant-ort01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const expiresAt = this.now() + expiresInMs;
    this.access.set(accessToken, { email, expiresAt, revoked: false });
    this.refreshTokens.set(refreshToken, { email, spent: false });
    return { accessToken, refreshToken, expiresAt };
  }

  /** Um login como o Claude Code guarda: { claudeAiOauth, oauthAccount }. */
  login(email, { orgUuid = "org-1", expiresInMs = 8 * HOUR, subscriptionType = "max" } = {}) {
    this.person(email, orgUuid);
    const tok = this.issue(email, expiresInMs);
    return {
      claudeAiOauth: { ...tok, scopes: ["user:inference", "user:profile"], subscriptionType, rateLimitTier: "default_claude_max_20x" },
      oauthAccount: { accountUuid: `uuid-${email}`, emailAddress: email, organizationUuid: orgUuid, organizationName: `Org de ${email}` },
    };
  }

  revoke(accessToken) {
    const a = this.access.get(accessToken);
    if (a) a.revoked = true;
  }

  refreshTokenList() {
    return [...this.refreshTokens.keys()];
  }

  allTokens() {
    return [...this.access.keys(), ...this.refreshTokens.keys()];
  }

  count(kind, email) {
    return this.calls.filter((c) => c.kind === kind && (!email || c.email === email)).length;
  }

  async fetch(url, init = {}) {
    const headers = init.headers || {};
    if (url === TOKEN_URL) {
      const body = JSON.parse(init.body);
      const rt = this.refreshTokens.get(body.refresh_token);
      this.calls.push({ kind: "refresh", email: rt ? rt.email : null });
      this.events.push("refresh");
      if (this.onRefresh) this.onRefresh();
      if (this.refreshGate) await this.refreshGate;
      const mode = rt ? this.refreshFail.get(rt.email) : null;
      if (mode === "transient") throw netError("ECONNREFUSED");
      if (mode === "dns") throw netError("ENOTFOUND");
      if (mode === "timeout") throw timeoutError();
      if (mode === "overloaded") return reply(503, { error: "overloaded" });
      if (!rt || rt.spent || mode === "invalid_grant" || body.client_id !== CLIENT_ID || body.grant_type !== "refresh_token") {
        return reply(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
      }
      rt.spent = true; // uso único
      const tok = this.issue(rt.email, this.expiresIn * 1000);
      if (mode === "lost") throw timeoutError(); // renovou lá, mas a resposta não chegou
      if (mode === "partial") {
        // Resposta incompleta: gasta o refresh token e manda um novo, mas sem access token.
        return reply(200, { token_type: "Bearer", refresh_token: tok.refreshToken, expires_in: this.expiresIn });
      }
      const p = this.people.get(rt.email);
      return reply(200, {
        token_type: "Bearer",
        access_token: tok.accessToken,
        refresh_token: tok.refreshToken,
        expires_in: this.expiresIn,
        scope: "user:inference user:profile",
        ...(this.omitTokenAccount ? {} : { account: { uuid: p.uuid, email_address: p.email }, organization: { uuid: p.orgUuid } }),
        ...this.tokenExtra,
      });
    }
    const token = String(headers.Authorization || "").replace(/^Bearer /, "");
    const a = this.access.get(token);
    const valid = !!a && !a.revoked && a.expiresAt > this.now();
    if (url === `${API}/api/oauth/usage`) {
      this.calls.push({ kind: "usage", email: a ? a.email : null, token });
      this.events.push(`usage:${token}`);
      if (this.onUsage) this.onUsage(token);
      if (this.usageReplies.length) {
        const r = this.usageReplies.shift();
        return reply(r.status, r.body || {}, r.headers || {});
      }
      if (!valid) return reply(401, { error: { type: "authentication_error" } });
      return reply(200, this.people.get(a.email).usage);
    }
    if (url === `${API}/api/oauth/profile`) {
      this.calls.push({ kind: "profile", email: a ? a.email : null });
      if (this.onProfile) this.onProfile();
      if (this.profileGate) await this.profileGate;
      if (!valid) return reply(401, {});
      const p = this.people.get(a.email);
      return reply(200, { account: { uuid: p.uuid, email: this.profileEmail.get(a.email) || p.email }, organization: { uuid: p.orgUuid } });
    }
    throw new Error(`rede de verdade bloqueada no teste: ${url}`);
  }
}

/**
 * wrap(anthropic) → anthropic: para mexer no resultado das chamadas (ex.: data inválida).
 * notify: avisos por e-mail ao dono (notify.js); sem ele, o motor não avisa (como antes).
 */
function setup(t, { env = {}, wrap = null, notify = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-motor-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "master.key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "data"), keyFile });
  store.load();
  t.after(() => store.close()); // solta a trava da pasta (store.lock)
  const clock = { t: START };
  const now = () => clock.t;
  const fake = new FakeAnthropic(now);
  const real = createAnthropic({ tokenUrl: TOKEN_URL, apiBase: API, fetchImpl: fake.fetch, now });
  const anthropic = wrap ? wrap(real) : real;
  const logs = [];
  const put = (...a) => logs.push(a.map(String).join(" "));
  const log = { info: put, warn: put, error: put, log: put };
  const engine = new Engine({ store, anthropic, now, log, env: { USAGE_MAX_PER_HOUR: "24", REFRESH_AHEAD_MIN: "120", ...env }, notify });
  const disk = () => decrypt(store.key, fs.readFileSync(store.file));
  return { store, clock, fake, engine, logs, disk, st: () => store.state };
}

let deviceSeq = 0;
function addDevice(engine, id, extra = {}) {
  const d = {
    id,
    name: `PC ${id}`,
    platform: "linux",
    tokenHash: "0".repeat(64),
    createdAt: START + ++deviceSeq,
    lastSeen: 0,
    assigned: null,
    lastSwitchAt: 0,
    models: [],
    ...extra,
  };
  engine.store.state.devices[id] = d;
  return d;
}

/** Uso lido "agora" para a conta n (sem passar pela API). */
function setUsage(engine, n, { session = 10, weekly = 20, weeklyResetIn = 4 * DAY } = {}) {
  const t = engine.now();
  const u = {
    fiveHour: { pct: session, resetsAt: new Date(t + 2 * HOUR).toISOString() },
    sevenDay: { pct: weekly, resetsAt: new Date(t + weeklyResetIn).toISOString() },
  };
  Object.assign(engine.store.state.accounts[String(n)], { usage: u, usageFetchedAt: t, usageError: null, lastGoodUsage: u, lastGoodAt: t });
}

function assertNoTokens(tokens, value, label) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  for (const tok of tokens) assert.ok(!s.includes(tok), `${label} contém um token`);
}

/** "DD/MM HH:MM" no fuso local, como o motor escreve os avisos. */
function dayTime(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const RELOGIN_TAIL = "entre de novo com ela no Claude Code de qualquer serviço conectado.";

// ------------------------------------------------------------------ renovação

test("renovação: grava o cofre antes de usar o token novo e sobe o gen", async (t) => {
  const { engine, fake, clock, store, disk, logs } = setup(t);
  const login = fake.login("ana@x.com");
  assert.deepEqual(await engine.addLogin(login), { number: 1, created: true }); // já entra renovado (vale 8 h)
  const acc = store.state.accounts["1"];
  assert.equal(acc.gen, 1);
  clock.t += 6 * HOUR + MIN; // agora vence antes de REFRESH_AHEAD_MIN (120 min)
  const oldAccess = acc.cred.accessToken;
  const oldRefresh = acc.cred.refreshToken;

  const events = [];
  fake.events = events;
  const realSave = store.save.bind(store);
  store.save = () => {
    events.push("save");
    return realSave();
  };
  let diskWhenUsed = null;
  fake.onUsage = (token) => {
    if (token !== oldAccess) diskWhenUsed = disk().accounts["1"];
  };

  await engine.tick();
  assert.equal(acc.gen, 2);
  assert.equal(acc.lastRefreshAt, clock.t);
  assert.notEqual(acc.cred.refreshToken, oldRefresh);
  assert.equal(acc.cred.expiresAt, clock.t + 8 * HOUR);
  const iRefresh = events.indexOf("refresh");
  const iSave = events.indexOf("save", iRefresh);
  assert.ok(iRefresh >= 0 && iSave > iRefresh, `ordem: ${events.join(", ")}`);
  const onDisk = disk().accounts["1"];
  assert.equal(onDisk.gen, 2);
  assert.equal(onDisk.cred.refreshToken, acc.cred.refreshToken);

  // Diagnóstico único com o access token ANTIGO (a Anthropic falsa ainda aceita o antigo).
  assert.equal(store.state.diag.oldTokenValidAfterRefresh, true);
  assert.equal(typeof store.state.diag.checkedAt, "number");
  assert.ok(logs.some((l) => l.includes("acesso antigo continua valendo depois de renovar: sim")));

  // Primeiro uso do token novo: o cofre no disco já tinha o refresh token novo.
  clock.t += 21 * MIN;
  await engine.tick();
  const iUse = events.indexOf(`usage:${acc.cred.accessToken}`);
  assert.ok(iUse > iSave, `ordem: ${events.join(", ")}`);
  assert.ok(diskWhenUsed, "o token novo foi usado");
  assert.equal(diskWhenUsed.cred.refreshToken, acc.cred.refreshToken);
  assert.equal(diskWhenUsed.gen, 2);

  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

test("renovação: refresh token novo vindo numa falha (200 sem access_token) é gravado antes de tudo", async (t) => {
  const { engine, fake, clock, store, disk, logs } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const acc = store.state.accounts["1"];
  const oldRefresh = acc.cred.refreshToken;
  const oldAccess = acc.cred.accessToken;
  const gen = acc.gen;
  clock.t += 7 * HOUR; // o acesso vence em 1 h → hora de renovar
  fake.refreshFail.set("ana@x.com", "partial");

  await engine.tick();
  assert.notEqual(acc.cred.refreshToken, oldRefresh, "guardou o refresh token novo");
  assert.equal(fake.refreshTokens.get(acc.cred.refreshToken).spent, false, "é o novo, ainda vivo");
  assert.equal(fake.refreshTokens.get(oldRefresh).spent, true);
  assert.equal(acc.cred.accessToken, oldAccess, "sem acesso novo");
  assert.equal(acc.cred.expiresAt, 0, "acesso vencido: renova de novo");
  assert.equal(acc.gen, gen);
  assert.equal(acc.dead, null);
  assert.equal(acc.refreshFailures, 1);
  assert.equal(acc.refreshBackoffUntil, clock.t + 1 * MIN);
  assert.ok(engine.isSpent(oldRefresh), "o antigo entra na lista dos gastos");
  const onDisk = disk().accounts["1"];
  assert.equal(onDisk.cred.refreshToken, acc.cred.refreshToken, "o novo já está no cofre em disco");
  assert.equal(onDisk.cred.expiresAt, 0);

  // Depois da espera renova com o novo, e a conta segue viva.
  fake.refreshFail.delete("ana@x.com");
  clock.t += 1 * MIN;
  await engine.tick();
  assert.equal(acc.dead, null);
  assert.equal(acc.gen, gen + 1);
  assert.ok(acc.cred.expiresAt > clock.t);
  assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

test("renovação: refresh token novo vindo numa falha é guardado mesmo se a 1ª gravação falhar (vai no ciclo seguinte)", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const acc = store.state.accounts["1"];
  clock.t += 7 * HOUR;
  fake.refreshFail.set("ana@x.com", "partial");
  const realSave = store.save.bind(store);
  let failSave = true;
  store.save = () => (failSave ? Promise.reject(new Error("disco cheio")) : realSave());

  assert.deepEqual(await engine.refreshAccount(1), { ok: false, error: "save_failed" });
  const novo = acc.cred.refreshToken;
  assert.equal(fake.refreshTokens.get(novo).spent, false, "o novo ficou na memória");
  failSave = false;
  fake.refreshFail.delete("ana@x.com");
  await engine.tick(); // grava primeiro (saveFailed) e só então renova com o novo
  assert.equal(acc.dead, null);
  assert.ok(acc.cred.expiresAt > clock.t);
  assert.equal(fake.refreshTokens.get(novo).spent, true, "renovou com o novo");
  assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken);
});

test("addLogin: renovação incompleta (refresh token novo sem acesso) guarda o login novo em vez de perdê-lo", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  const login = fake.login("ana@x.com");
  fake.refreshFail.set("ana@x.com", "partial");
  assert.deepEqual(await engine.addLogin(login), { number: 1, created: true });
  const acc = store.state.accounts["1"];
  assert.notEqual(acc.cred.refreshToken, login.claudeAiOauth.refreshToken);
  assert.equal(fake.refreshTokens.get(acc.cred.refreshToken).spent, false);
  assert.equal(acc.cred.expiresAt, 0);
  assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken, "gravado no cofre");
  assert.ok(engine.isSpent(login.claudeAiOauth.refreshToken), "o enviado foi gasto");

  fake.refreshFail.delete("ana@x.com");
  await engine.tick(); // renova no ciclo seguinte
  assert.equal(acc.dead, null);
  assert.ok(acc.cred.expiresAt > clock.t);
});

test("renovação: invalid_grant marca a conta como morta e tira o dispositivo dela", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  addDevice(engine, "d1", { assigned: 1, lastSwitchBy: "assign" });
  fake.refreshFail.set("ana@x.com", "invalid_grant");

  clock.t += 7 * HOUR; // as duas vencem em 1 h → hora de renovar
  await engine.heartbeat("d1", { models: [] });
  await engine.tick();

  const ana = store.state.accounts["1"];
  assert.deepEqual(ana.dead, { reason: "relogin_required", at: clock.t });
  assert.ok(store.state.history.some((h) => h.kind === "alert" && h.text.includes("conta 1")));
  const pub = engine.publicList("d1").accounts.find((a) => a.number === 1);
  assert.equal(pub.usageStatus, "relogin_required");
  assert.equal(pub.dead, true);
  assert.equal(store.state.accounts["2"].dead, null);
  assert.equal(store.state.devices.d1.assigned, 2, "o dispositivo saiu da conta morta");
  assert.equal((await engine.credentialFor("d1")).number, 2);

  // Conta morta não é mais renovada nem consultada.
  const refreshes = fake.count("refresh", "ana@x.com");
  const usages = fake.count("usage", "ana@x.com");
  clock.t += 30 * MIN;
  await engine.tick();
  await engine.tick();
  assert.equal(fake.count("refresh", "ana@x.com"), refreshes);
  assert.equal(fake.count("usage", "ana@x.com"), usages);
  await assert.rejects(engine.switchDevice("d1", 1), (e) => e.code === "dead_account");
});

test("renovação: falha temporária espera 1 min, depois 2 min, e não mata a conta", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  clock.t += 7 * HOUR; // o acesso vence em 1 h → hora de renovar
  fake.refreshFail.set("ana@x.com", "transient");
  const r0 = fake.count("refresh"); // a renovação do próprio addLogin

  await engine.tick();
  const acc = store.state.accounts["1"];
  assert.equal(acc.refreshFailures, 1);
  assert.equal(acc.refreshBackoffUntil, clock.t + 1 * MIN);
  assert.equal(acc.dead, null);
  await engine.tick();
  assert.equal(fake.count("refresh"), r0 + 1, "dentro da espera não tenta");

  clock.t += 61 * SEC;
  await engine.tick();
  assert.equal(fake.count("refresh"), r0 + 2);
  assert.equal(acc.refreshBackoffUntil, clock.t + 2 * MIN);

  fake.refreshFail.delete("ana@x.com");
  clock.t += 2 * MIN + SEC;
  await engine.tick();
  assert.equal(acc.gen, 2);
  assert.equal(acc.refreshFailures, 0);
});

// ------------------------------------------------------------------ credencial

test("credentialFor: renova para valer ≥ 30 min, grava antes e nunca devolve refreshToken", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com")); // entra renovado: vale 8 h
  clock.t += 8 * HOUR - 10 * MIN; // agora vence em 10 min
  addDevice(engine, "d1");
  const st0 = await engine.heartbeat("d1", { models: ["claude-fable-5-1"], live: { email: "ana@x.com", orgUuid: "org-1", expiresAt: 1 } });
  assert.equal(st0.device.assigned, 1);
  assert.deepEqual(store.state.devices.d1.models, ["claude-fable-5-1"]);

  const cred = await engine.credentialFor("d1");
  assert.equal(cred.number, 1);
  assert.equal(cred.gen, 2);
  assert.ok(cred.claudeAiOauth.expiresAt - clock.t >= 30 * MIN);
  assert.deepEqual(Object.keys(cred.claudeAiOauth).sort(), ["accessToken", "expiresAt", "rateLimitTier", "scopes", "subscriptionType"]);
  assert.equal(cred.claudeAiOauth.accessToken, store.state.accounts["1"].cred.accessToken);
  assert.equal(cred.claudeAiOauth.subscriptionType, "max");
  assert.equal(cred.oauthAccount.emailAddress, "ana@x.com");
  const text = JSON.stringify(cred);
  assert.ok(!/"refreshToken"\s*:/.test(text));
  assertNoTokens(fake.refreshTokenList(), text, "a credencial");
  assert.equal(disk().accounts["1"].cred.accessToken, cred.claudeAiOauth.accessToken, "gravado antes de entregar");

  // Nem o estado nem a lista levam token nenhum.
  const state = engine.stateFor("d1");
  assertNoTokens(fake.allTokens(), state, "o StateResponse");
  assert.deepEqual(Object.keys(state).sort(), ["autoSwitch", "credential", "device", "devices", "diag", "history", "list", "records", "rules", "serverTime", "version", "warnings"].sort());
  assert.deepEqual(state.warnings, []);
  assert.deepEqual(state.device, { id: "d1", name: "PC d1", assigned: 1, lastSwitchAt: store.state.devices.d1.lastSwitchAt, canUploadLogins: true });
  assert.deepEqual(state.credential, { number: 1, gen: 2, expiresAt: cred.claudeAiOauth.expiresAt });
  assert.equal(state.list.schemaVersion, 1);
  assert.equal(state.list.activeAccountNumber, 1);
  assert.deepEqual(state.list.accounts[0].assignedDevices, ["PC d1"]);
  assert.equal(state.devices[0].current, true);

  // Ainda vale bastante: não renova de novo.
  const n = fake.count("refresh");
  const again = await engine.credentialFor("d1");
  assert.equal(fake.count("refresh"), n);
  assert.equal(again.claudeAiOauth.accessToken, cred.claudeAiOauth.accessToken);
});

test("credentialFor: duas pedidas ao mesmo tempo renovam uma vez só (trava por conta)", async (t) => {
  const { engine, fake, clock } = setup(t);
  await engine.addLogin(fake.login("ana@x.com")); // entra renovado: vale 8 h
  clock.t += 8 * HOUR - 10 * MIN; // agora vence em 10 min
  addDevice(engine, "d1");
  addDevice(engine, "d2");
  await engine.heartbeat("d1", {});
  await engine.heartbeat("d2", {}); // só existe a conta 1: os dois ficam nela
  const r0 = fake.count("refresh");
  const [a, b] = await Promise.all([engine.credentialFor("d1"), engine.credentialFor("d2")]);
  assert.equal(fake.count("refresh"), r0 + 1);
  assert.equal(a.claudeAiOauth.accessToken, b.claudeAiOauth.accessToken);
  assert.equal(a.gen, 2);
});

// ------------------------------------------------------------------ decisões

test("dois dispositivos ativos não ficam na mesma conta quando há outra livre", async (t) => {
  const { engine, fake, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  addDevice(engine, "d1");
  addDevice(engine, "d2");
  await engine.heartbeat("d1", { models: [] });
  await engine.heartbeat("d2", { models: [] });
  const d1 = store.state.devices.d1;
  const d2 = store.state.devices.d2;
  assert.ok(d1.assigned && d2.assigned);
  assert.notEqual(d1.assigned, d2.assigned, "atribuição inicial já separa");

  // Os dois caíram na mesma conta (troca de antes, por exemplo): o ciclo separa.
  Object.assign(d1, { assigned: 1, lastSwitchAt: 0, lastSwitchBy: "auto" });
  Object.assign(d2, { assigned: 1, lastSwitchAt: 0, lastSwitchBy: "auto" });
  await engine.tick();
  assert.equal(d1.assigned, 1);
  assert.equal(d2.assigned, 2);
  assert.equal(store.state.history[0].kind, "switch");
  assert.equal(store.state.history[0].device, "d2");
  assert.match(store.state.history[0].text, /já está em uso/);

  // Estável no ciclo seguinte.
  await engine.tick();
  assert.equal(d1.assigned, 1);
  assert.equal(d2.assigned, 2);
});

test("sem folga em conta livre (blocked): divide a conta de outro dispositivo", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1, { session: 95 }); // passou da linha de 90%
  setUsage(engine, 2, { session: 10 });
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "auto" });
  const d2 = addDevice(engine, "d2", { assigned: 2, lastSeen: clock.t, lastSwitchBy: "auto" });

  await engine.tick();
  assert.equal(d1.assigned, 2, "dividir é melhor que parar");
  assert.equal(d2.assigned, 2);
  const h = store.state.history.find((x) => x.device === "d1" && x.kind === "switch");
  assert.ok(h);
  assert.match(h.text, /^Trocou da conta 1 para a conta 2/);

  // Não fica indo e voltando.
  await engine.tick();
  clock.t += 6 * MIN;
  await engine.heartbeat("d1", {});
  await engine.heartbeat("d2", {});
  await engine.tick();
  assert.equal(d1.assigned, 2);
  assert.equal(d2.assigned, 2);
});

test("limitHit troca na hora", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1, { session: 40 }); // o dado ainda não mostra o limite
  setUsage(engine, 2);
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchAt: clock.t - MIN, lastSwitchBy: "auto" });

  const r = await engine.limitHit("d1", "limite da sessão de 5h");
  assert.equal(r.switched, true);
  assert.match(r.text, /^Trocou na hora da conta 1 para a conta 2: a conta 1 bateu o limite da sessão de 5h/);
  assert.equal(d1.assigned, 2);
  assert.equal(store.state.history[0].kind, "switch");
  assert.equal(disk().devices.d1.assigned, 2);
  assert.ok(engine.pollSoon.has(1), "relê o uso da conta que bateu o limite");

  // Troca automática desligada: só registra.
  await engine.setRules({ autoSwitch: false });
  const r2 = await engine.limitHit("d1", "limite semanal");
  assert.equal(r2.switched, false);
  assert.equal(r2.text, "A conta 2 bateu o limite semanal.");
  assert.equal(d1.assigned, 2);
  assert.equal(store.state.history[0].kind, "alert");
});

test("switchDevice: manual e melhor conta", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1, { session: 70 });
  setUsage(engine, 2, { session: 5 });
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t });

  let r = await engine.switchDevice("d1", null);
  assert.deepEqual([r.switched, r.from, r.to], [true, 1, 2]);
  assert.equal(store.state.history[0].kind, "manual");
  r = await engine.switchDevice("d1", 1);
  assert.deepEqual([r.switched, d1.assigned, d1.lastSwitchBy], [true, 1, "manual"]);
  r = await engine.switchDevice("d1", 1);
  assert.equal(r.switched, false);
  await assert.rejects(engine.switchDevice("d1", 9), (e) => e.code === "not_found");
});

// ------------------------------------------------------------------ logins

test("addLogin cria, atualiza e recusa identidade errada e login morto", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);

  const l1 = fake.login("ana@x.com", { subscriptionType: "max" });
  assert.deepEqual(await engine.addLogin(l1), { number: 1, created: true });
  const a = store.state.accounts["1"];
  assert.equal(a.email, "ana@x.com");
  assert.equal(a.orgUuid, "org-1");
  assert.equal(a.orgName, "Org de ana@x.com");
  assert.deepEqual(a.plan, { label: "Max" });
  assert.equal(a.gen, 1);
  assert.equal(a.dead, null);
  assert.equal(store.state.history[0].text, "Login da conta 1 recebido");
  // Guardado o token RENOVADO na hora (o enviado foi gasto ao renovar).
  assert.notEqual(a.cred.refreshToken, l1.claudeAiOauth.refreshToken);
  assert.equal(disk().accounts["1"].cred.refreshToken, a.cred.refreshToken, "gravado no cofre");

  // O mesmo login que o servidor já guarda: nada muda (nem renova).
  const n0 = fake.count("refresh");
  assert.deepEqual(await engine.addLogin({ claudeAiOauth: { ...a.cred }, oauthAccount: l1.oauthAccount }), { number: 1, created: false });
  assert.equal(a.gen, 1);
  assert.equal(fake.count("refresh"), n0);
  // O login enviado antes (o servidor já gastou o refresh token dele): recusado.
  await assert.rejects(engine.addLogin(l1), (e) => e.code === "stale_login");

  // Login novo da mesma conta (e-mail com maiúsculas) troca a credencial e revive a conta morta.
  a.dead = { reason: "relogin_required", at: clock.t };
  const l2 = fake.login("ana@x.com");
  l2.oauthAccount.emailAddress = "Ana@X.com";
  assert.deepEqual(await engine.addLogin({ ...l2, plan: { label: "Team" } }), { number: 1, created: false });
  assert.equal(a.dead, null);
  assert.equal(a.gen, 2);
  assert.notEqual(a.cred.refreshToken, l2.claudeAiOauth.refreshToken, "guarda o renovado, não o enviado");
  assert.equal(fake.refreshTokens.get(a.cred.refreshToken).email, "ana@x.com");
  assert.deepEqual(a.plan, { label: "Team" });

  // Outra conta: número novo; plano pelo subscriptionType.
  assert.deepEqual(await engine.addLogin(fake.login("bia@x.com", { subscriptionType: "pro" })), { number: 2, created: true });
  assert.deepEqual(store.state.accounts["2"].plan, { label: "Pro" });
  const biaCred = { ...store.state.accounts["2"].cred };

  // Identidade errada: o token é de caio, o oauthAccount diz bia. Recusa antes de gastar o login enviado.
  const l3 = fake.login("caio@x.com");
  l3.oauthAccount.emailAddress = "bia@x.com";
  await assert.rejects(engine.addLogin(l3), (e) => e.code === "identity_mismatch");
  assert.equal(fake.refreshTokens.get(l3.claudeAiOauth.refreshToken).spent, false, "nada gasto");
  // Organização errada.
  const l4 = fake.login("davi@x.com");
  l4.oauthAccount.organizationUuid = "org-outra";
  await assert.rejects(engine.addLogin(l4), (e) => e.code === "identity_mismatch");
  // Identidade errada que só aparece depois de renovar (acesso enviado já vencendo): recusa também,
  // e avisa que o login enviado foi gasto.
  const l7 = fake.login("ivo@x.com", { expiresInMs: 30 * SEC });
  l7.oauthAccount.emailAddress = "bia@x.com";
  await assert.rejects(engine.addLogin(l7), (e) => e.code === "identity_mismatch_spent");
  assert.deepEqual(store.state.accounts["2"].cred, biaCred, "a conta da bia não mudou");

  // Login morto: access vencido e a Anthropic recusa a renovação.
  const dead = {
    claudeAiOauth: { accessToken: "sk-ant-oat01-velho", refreshToken: "sk-ant-ort01-velho", expiresAt: clock.t - SEC, scopes: [] },
    oauthAccount: { emailAddress: "eva@x.com", organizationUuid: "org-1" },
  };
  await assert.rejects(engine.addLogin(dead), (e) => e.code === "dead_login");

  // Sem refreshToken ou sem e-mail.
  await assert.rejects(engine.addLogin({ claudeAiOauth: { accessToken: "x" }, oauthAccount: { emailAddress: "f@x.com" } }), (e) => e.code === "invalid_login");
  await assert.rejects(engine.addLogin({ claudeAiOauth: { refreshToken: "y" }, oauthAccount: {} }), (e) => e.code === "invalid_login");

  // Acesso enviado já revogado, mas o refresh token vive: renova na hora e aceita (vale o renovado).
  const l6 = fake.login("gil@x.com");
  fake.revoke(l6.claudeAiOauth.accessToken);
  assert.deepEqual(await engine.addLogin(l6), { number: 3, created: true });
  assert.notEqual(store.state.accounts["3"].cred.accessToken, l6.claudeAiOauth.accessToken);

  // Login vencendo em < 5 min: idem.
  const l5 = fake.login("hugo@x.com", { expiresInMs: 2 * MIN });
  const r5 = await engine.addLogin(l5);
  assert.equal(r5.created, true);
  const h = store.state.accounts[String(r5.number)];
  assert.notEqual(h.cred.refreshToken, l5.claudeAiOauth.refreshToken);
  assert.equal(h.lastRefreshAt, clock.t);
  assert.ok(h.cred.expiresAt - clock.t > HOUR);
  // Mandar de novo o login que o servidor já gastou é recusado (guardar mataria a conta).
  await assert.rejects(engine.addLogin(l5), (e) => e.code === "stale_login");

  assert.deepEqual(Object.keys(store.state.accounts).sort(), ["1", "2", "3", "4"]);
  assert.equal(store.state.nextNumber, 5);
});

test("canUploadLogins: pareado por código sim; com Google só o administrador (setAdminCheck); addLogin de quem não pode → not_admin sem falar com a Anthropic", async (t) => {
  const { engine, fake, store } = setup(t);
  addDevice(engine, "cod"); // sem googleEmail: pareado por código
  addDevice(engine, "adm", { googleEmail: "dono@x.com" });
  addDevice(engine, "bia", { googleEmail: "bia@x.com" });
  const pode = (id) => engine.stateFor(id).device.canUploadLogins;

  // sem setAdminCheck: ninguém com Google é administrador
  assert.deepEqual([pode("cod"), pode("adm"), pode("bia")], [true, false, false]);
  engine.setAdminCheck((email) => email === "dono@x.com");
  assert.deepEqual([pode("cod"), pode("adm"), pode("bia")], [true, true, false]);
  assert.equal(engine.stateFor("nao-existe").device, null);

  // quem não pode: not_admin (403) antes de tudo — o login enviado não é conferido nem gasto
  const lb = fake.login("bia@x.com");
  const calls = fake.calls.length;
  await assert.rejects(
    engine.addLogin({ ...lb, deviceId: "bia" }),
    (e) => e.code === "not_admin" && ERROR_STATUS[e.code] === 403 && /administrador/.test(e.message)
  );
  assert.equal(fake.calls.length, calls, "nada foi para a Anthropic");
  assert.equal(fake.refreshTokens.get(lb.claudeAiOauth.refreshToken).spent, false);
  assert.deepEqual(store.state.accounts, {});

  // administrador com Google e pareado por código enviam
  assert.deepEqual(await engine.addLogin({ ...fake.login("ana@x.com"), deviceId: "adm" }), { number: 1, created: true });
  assert.deepEqual(await engine.addLogin({ ...fake.login("caio@x.com"), deviceId: "cod" }), { number: 2, created: true });

  // a lista mudou (ADMIN_EMAILS sem o dono + reinício): o serviço dele com Google deixa de poder
  engine.setAdminCheck(null);
  assert.equal(pode("adm"), false);
  await assert.rejects(engine.addLogin({ ...fake.login("ana@x.com"), deviceId: "adm" }), (e) => e.code === "not_admin");
  // uma verificação que falha não libera ninguém com Google
  engine.setAdminCheck(() => {
    throw new Error("falhou");
  });
  assert.deepEqual([pode("cod"), pode("adm")], [true, false]);
});

test("addLogin renova o login recebido na hora (mesmo com o acesso valendo) e guarda o renovado", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  const l1 = fake.login("ana@x.com"); // acesso valendo 8 h: antes não renovava
  const r0 = fake.count("refresh");
  assert.deepEqual(await engine.addLogin(l1), { number: 1, created: true });
  assert.equal(fake.count("refresh"), r0 + 1, "renovou na hora");
  const acc = store.state.accounts["1"];
  assert.notEqual(acc.cred.accessToken, l1.claudeAiOauth.accessToken);
  assert.notEqual(acc.cred.refreshToken, l1.claudeAiOauth.refreshToken);
  assert.equal(fake.refreshTokens.get(l1.claudeAiOauth.refreshToken).spent, true, "o enviado deixou de valer");
  assert.equal(fake.refreshTokens.get(acc.cred.refreshToken).spent, false, "o guardado está vivo");
  assert.equal(acc.cred.expiresAt, clock.t + 8 * HOUR);
  assert.equal(acc.cred.subscriptionType, "max");
  assert.equal(acc.lastRefreshAt, clock.t);
  assert.equal(acc.gen, 1);
  const onDisk = disk().accounts["1"];
  assert.equal(onDisk.cred.refreshToken, acc.cred.refreshToken, "o cofre tem o token renovado");
  assert.equal(onDisk.cred.accessToken, acc.cred.accessToken);

  // Login novo da mesma conta: também renovado na hora; o gen sobe.
  clock.t += HOUR;
  const l2 = fake.login("ana@x.com");
  assert.deepEqual(await engine.addLogin(l2), { number: 1, created: false });
  assert.equal(acc.gen, 2);
  assert.equal(acc.lastRefreshAt, clock.t);
  assert.equal(fake.refreshTokens.get(l2.claudeAiOauth.refreshToken).spent, true);
  assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken);
  assert.equal(disk().accounts["1"].gen, 2);

  // Reenviar um login já gasto aqui: stale_login, nada muda.
  await assert.rejects(engine.addLogin(l1), (e) => e.code === "stale_login");
  await assert.rejects(engine.addLogin(l2), (e) => e.code === "stale_login");
  assert.equal(acc.gen, 2);
});

test("addLogin: refresh token morto não substitui um login bom; falha temporária não muda nada", async (t) => {
  const { engine, fake, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const acc = store.state.accounts["1"];
  const good = { ...acc.cred };
  const gen = acc.gen;
  const hist = store.state.history.length;

  // Login de outro serviço com o acesso ainda valendo, mas o refresh token já morreu
  // (renovado em outro lugar). Antes passava, porque só renovava quando o acesso estava vencendo.
  const morto = fake.login("ana@x.com");
  fake.refreshTokens.get(morto.claudeAiOauth.refreshToken).spent = true;
  await assert.rejects(engine.addLogin(morto), (e) => e.code === "dead_login");
  assert.deepEqual(acc.cred, good, "o login bom ficou");
  assert.equal(acc.gen, gen);
  assert.equal(acc.dead, null);
  assert.equal(disk().accounts["1"].cred.refreshToken, good.refreshToken);
  assert.equal(store.state.history.length, hist, "nada no histórico");

  // Conta nova com login morto: nada é criado.
  const outro = fake.login("bia@x.com");
  fake.refreshTokens.get(outro.claudeAiOauth.refreshToken).spent = true;
  await assert.rejects(engine.addLogin(outro), (e) => e.code === "dead_login");
  assert.deepEqual(Object.keys(store.state.accounts), ["1"]);
  assert.equal(store.state.nextNumber, 2);

  // Falha temporária ao renovar: refresh_failed, nada muda e o login enviado não é gasto.
  const l3 = fake.login("ana@x.com");
  fake.refreshFail.set("ana@x.com", "transient");
  await assert.rejects(engine.addLogin(l3), (e) => e.code === "refresh_failed");
  assert.deepEqual(acc.cred, good);
  assert.equal(acc.gen, gen);
  assert.equal(fake.refreshTokens.get(l3.claudeAiOauth.refreshToken).spent, false);

  // A Anthropic voltou: o mesmo login entra (renovado na hora).
  fake.refreshFail.delete("ana@x.com");
  assert.deepEqual(await engine.addLogin(l3), { number: 1, created: false });
  assert.equal(acc.gen, gen + 1);
  assert.notEqual(acc.cred.refreshToken, l3.claudeAiOauth.refreshToken);
  assert.notEqual(acc.cred.refreshToken, good.refreshToken);
});

test("addLogin não troca o login de uma conta que o servidor renovou depois (login antigo reenviado)", async (t) => {
  const { engine, fake, store } = setup(t);
  const l1 = fake.login("ana@x.com");
  await engine.addLogin(l1);
  const r = await engine.refreshAccount(1, { minValidMs: Infinity }); // força uma renovação
  assert.deepEqual(r, { ok: true, refreshed: true });
  const good = store.state.accounts["1"].cred.refreshToken;
  await assert.rejects(engine.addLogin(l1), (e) => e.code === "stale_login");
  assert.equal(store.state.accounts["1"].cred.refreshToken, good);
});

// ------------------------------------------------------------------ uso

test("uso: orçamento de consultas por hora é respeitado", async (t) => {
  const { engine, fake, clock } = setup(t, { env: { USAGE_MAX_PER_HOUR: "3" } });
  for (const e of ["a", "b", "c", "d", "e"]) await engine.addLogin(fake.login(`${e}@x.com`));
  for (let i = 0; i < 6; i++) await engine.tick();
  assert.equal(fake.count("usage"), 3, "3 por hora: o balde começa cheio com 3");

  clock.t += 21 * MIN; // recarrega pouco mais de 1
  await engine.tick();
  await engine.tick();
  assert.equal(fake.count("usage"), 4);
});

test("uso: 429 pausa todas as consultas pelo Retry-After (mínimo 10 min)", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  fake.usageReplies.push({ status: 429, headers: { "retry-after": "60" }, body: { error: { type: "rate_limit_error" } } });

  await engine.tick();
  assert.equal(fake.count("usage"), 1);
  assert.equal(engine.pausedUntil, clock.t + 10 * MIN);
  assert.equal(store.state.accounts["1"].usageError, null, "429 é do orçamento, não da conta");

  clock.t += 5 * MIN;
  await engine.tick();
  await engine.tick();
  assert.equal(fake.count("usage"), 1, "pausado");

  clock.t += 5 * MIN + SEC;
  await engine.tick();
  assert.equal(fake.count("usage"), 2);
  assert.equal(engine.usageStatusOf(store.state.accounts["1"]), "ok");

  // Retry-After maior que 10 min vale como está.
  fake.usageReplies.push({ status: 429, headers: { "retry-after": "1800" } });
  await engine.tick();
  assert.equal(engine.pausedUntil, clock.t + 30 * MIN);
});

test("uso: 401 renova e tenta de novo uma vez; outros erros esperam 2, 5, 10 min", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  fake.calls = []; // só conta o que o ciclo faz (o addLogin já renovou uma vez)
  const acc = store.state.accounts["1"];
  const old = acc.cred.accessToken;
  fake.revoke(old);
  clock.t += 16 * MIN; // o token já tem mais de 15 min: um 401 renova

  await engine.tick();
  assert.notEqual(acc.cred.accessToken, old);
  assert.equal(acc.gen, 2);
  assert.equal(acc.usageError, null);
  assert.equal(acc.usage.sevenDay.pct, 20);
  assert.deepEqual(
    fake.calls.filter((c) => c.kind !== "profile").map((c) => c.kind),
    ["usage", "refresh", "usage"]
  );

  // Erro do servidor: conta fica "unavailable" (com o último uso bom guardado) e espera.
  clock.t += 21 * MIN;
  fake.usageReplies.push({ status: 500 }, { status: 500 });
  store.state.diag.oldTokenValidAfterRefresh = false; // sem diagnóstico pendente atrapalhando a contagem
  engine.diagPending = null;
  await engine.tick();
  assert.equal(acc.usageError, "transient");
  assert.equal(acc.pollBackoffUntil, clock.t + 2 * MIN);
  const pub = engine.publicList(null).accounts[0];
  assert.equal(pub.usageStatus, "unavailable");
  assert.equal(pub.usage, null);
  assert.equal(pub.lastGoodUsage.sevenDay.pct, 20);
  const n = fake.count("usage");
  await engine.tick();
  assert.equal(fake.count("usage"), n, "dentro da espera");
  clock.t += 2 * MIN;
  await engine.tick();
  assert.equal(acc.pollBackoffUntil, clock.t + 5 * MIN);
});

// ------------------------------------------------------------------ ajustes

test("updateAccount, removeAccount e setRules", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t });

  assert.deepEqual(await engine.updateAccount(1, { alias: "  Trabalho ", threshold: 70, priority: 2 }), {
    disabled: false,
    threshold: 70,
    weeklyThreshold: null,
    modelThreshold: null,
    priority: 2,
    alias: "Trabalho",
  });
  await assert.rejects(engine.updateAccount(1, { threshold: 300 }), (e) => e.code === "invalid");
  await assert.rejects(engine.updateAccount(9, { alias: "x" }), (e) => e.code === "not_found");

  // Desativar a conta em uso tira o dispositivo dela na hora.
  await engine.updateAccount(1, { disabled: true });
  assert.equal(d1.assigned, 2);

  // Remover a única conta usável: o dispositivo fica sem conta.
  await engine.removeAccount(2);
  assert.equal(store.state.accounts["2"], undefined);
  assert.equal(d1.assigned, null);
  assert.equal(await engine.credentialFor("d1"), null);
  await assert.rejects(engine.removeAccount(2), (e) => e.code === "not_found");

  // Regras: mescla, ajusta para a faixa, null volta ao padrão.
  await engine.setRules({ rules: { sessionPct: 85, strategy: "headroom", marginPct: 99, desconhecida: 1 } });
  let r = engine.rulesEffective();
  assert.equal(r.sessionPct, 85);
  assert.equal(r.strategy, "headroom");
  assert.equal(r.marginPct, 30);
  assert.equal(r.weeklyPct, 80);
  assert.equal("desconhecida" in r, false);
  await assert.rejects(engine.setRules({ rules: { strategy: "xyz" } }), (e) => e.code === "invalid_rules");
  await engine.setRules({ rules: { sessionPct: null } });
  r = engine.rulesEffective();
  assert.equal(r.sessionPct, 90);
  assert.equal(r.strategy, "headroom");
  await engine.setRules({ rules: null, autoSwitch: false });
  assert.equal(store.state.rules, null);
  assert.equal(store.state.autoSwitch, false);
  assert.equal(engine.stateFor("d1").autoSwitch, false);
});

test("linesFor: linhas próprias da conta (sessão, semanal, modelo); null, ausente ou inválida = regra geral", () => {
  const r = { ...RULE_DEFAULTS, sessionPct: 90, weeklyPct: 80, modelPct: 95 };
  const acc = { number: 2 };
  const geral = { session: 90, weekly: 80, model: 95 };
  assert.deepEqual(linesFor(acc, r, {}), geral);
  assert.deepEqual(linesFor(acc, r, null), geral);
  assert.deepEqual(linesFor(acc, r, { 2: { threshold: 70, weeklyThreshold: 60, modelThreshold: 85 } }), { session: 70, weekly: 60, model: 85 });
  assert.deepEqual(linesFor(acc, r, { 2: { threshold: null, weeklyThreshold: 75, modelThreshold: null } }), { session: 90, weekly: 75, model: 95 });
  assert.deepEqual(linesFor(acc, r, { 2: { modelThreshold: 88 } }), { session: 90, weekly: 80, model: 88 }, "campo ausente = regra geral");
  assert.deepEqual(linesFor(acc, r, { 2: { weeklyThreshold: "66" } }), { session: 90, weekly: 66, model: 95 }, "texto numérico vale");
  assert.deepEqual(linesFor(acc, r, { 2: { weeklyThreshold: "", modelThreshold: "abc" } }), geral, "vazio ou inválido = regra geral");
  assert.deepEqual(linesFor(acc, r, { 1: { threshold: 60, weeklyThreshold: 60, modelThreshold: 60 } }), geral, "a linha de outra conta não vale");
});

test("linhas próprias por conta: o semanal próprio muda a decisão; null volta à regra geral", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1, { session: 10, weekly: 70 });
  setUsage(engine, 2, { session: 10, weekly: 10 });
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "auto" });

  // Regra geral (semanal 80%): 70% não troca.
  engine.decideDevice(d1);
  assert.equal(d1.assigned, 1);

  // Linha própria do semanal em 65%: troca.
  assert.deepEqual(await engine.updateAccount(1, { weeklyThreshold: 65 }), {
    disabled: false,
    threshold: null,
    weeklyThreshold: 65,
    modelThreshold: null,
    priority: 0,
    alias: null,
  });
  assert.equal(store.state.history[0].text, "Regras próprias da conta 1: sessão 90% (geral) · semanal 65% · modelo 95% (geral)");
  assert.equal(engine.stateFor("d1").records["1"].weeklyThreshold, 65, "StateResponse leva a linha própria");
  assert.equal(engine.decideDevice(d1), true);
  assert.equal(d1.assigned, 2);
  assert.equal(store.state.history[0].kind, "switch");
  assert.match(store.state.history[0].text, /^Trocou da conta 1 para a conta 2: semanal em 70% \(linha 65%\)/);

  // null (os três null) = de volta à regra geral: 70% não troca mais.
  Object.assign(d1, { assigned: 1, lastSwitchAt: 0, lastSwitchBy: "auto" });
  await engine.updateAccount(1, { weeklyThreshold: null });
  assert.equal(store.state.history[0].text, "Conta 1 voltou às regras gerais");
  assert.equal(engine.records()["1"].weeklyThreshold, null);
  engine.decideDevice(d1);
  assert.equal(d1.assigned, 1);
});

test("linhas próprias por conta: a linha do modelo própria muda a decisão (conta ativa e conta de destino)", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  const setFable = (n, pct) => {
    store.state.accounts[String(n)].usage.scoped = [{ name: "Fable", pct, resetsAt: new Date(clock.t + 3 * DAY).toISOString() }];
  };
  setFable(1, 90);
  setFable(2, 60);
  await engine.setRules({ rules: { onModelLimit: "switchAccount" } });
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "auto", models: ["claude-fable-5"] });

  // Regra geral do modelo (95%): 90% não troca.
  engine.decideDevice(d1);
  assert.equal(d1.assigned, 1);

  // Linha própria do modelo em 85% na conta 1; a conta 2 também com linha própria (50%) abaixo do uso dela (60%):
  // nenhuma conta serve → fica (bloqueado).
  await engine.updateAccount(1, { modelThreshold: 85 });
  assert.equal(store.state.history[0].text, "Regras próprias da conta 1: sessão 90% (geral) · semanal 80% (geral) · modelo 85%");
  await engine.updateAccount(2, { modelThreshold: 50 });
  engine.decideDevice(d1);
  assert.equal(d1.assigned, 1);
  assert.equal(store.state.history[0].kind, "blocked");

  // A conta 2 volta à regra geral (95%): 60% serve → troca.
  await engine.updateAccount(2, { modelThreshold: null });
  assert.equal(store.state.history[0].text, "Conta 2 voltou às regras gerais");
  assert.equal(engine.decideDevice(d1), true);
  assert.equal(d1.assigned, 2);
  assert.match(store.state.history[0].text, /^Trocou da conta 1 para a conta 2: Fable em 90% \(linha 85%\)/);
});

test("linhas próprias por conta: validação (50–100 ou null), nada muda quando recusa, histórico só quando muda", async (t) => {
  const { engine, fake, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const own = () => {
    const rec = engine.records()["1"];
    return [rec.threshold, rec.weeklyThreshold, rec.modelThreshold];
  };
  assert.deepEqual(own(), [null, null, null], "conta nova: regra geral");

  for (const patch of [
    { weeklyThreshold: 49 },
    { weeklyThreshold: 101 },
    { modelThreshold: 0 },
    { modelThreshold: "abc" },
    { weeklyThreshold: "" },
    { modelThreshold: true },
    { threshold: 30 },
    { weeklyThreshold: 70, modelThreshold: 20 }, // um campo ruim recusa o pedido inteiro
  ]) {
    await assert.rejects(engine.updateAccount(1, patch), (e) => e.code === "invalid", JSON.stringify(patch));
  }
  assert.deepEqual(own(), [null, null, null]);
  assert.ok(!store.state.history.some((h) => /Regras próprias|voltou às regras gerais/.test(h.text)), "recusado não vai para o histórico");

  await engine.updateAccount(1, { threshold: 50, weeklyThreshold: "75", modelThreshold: 100 });
  assert.deepEqual(own(), [50, 75, 100]);
  assert.equal(store.state.history[0].text, "Regras próprias da conta 1: sessão 50% · semanal 75% · modelo 100%");
  const n = store.state.history.length;
  await engine.updateAccount(1, { weeklyThreshold: 75 });
  assert.equal(store.state.history.length, n, "mesmo valor: sem entrada nova no histórico");
  await engine.updateAccount(1, { alias: "Trabalho" });
  assert.equal(store.state.history.length, n, "outro ajuste não fala das linhas");

  // Só uma de volta à regra geral: as outras continuam próprias.
  await engine.updateAccount(1, { threshold: null });
  assert.deepEqual(own(), [null, 75, 100]);
  assert.equal(store.state.history[0].text, "Regras próprias da conta 1: sessão 90% (geral) · semanal 75% · modelo 100%");
  await engine.updateAccount(1, { weeklyThreshold: null, modelThreshold: null });
  assert.deepEqual(own(), [null, null, null]);
  assert.equal(store.state.history[0].text, "Conta 1 voltou às regras gerais");
});

test("addLogin: número preferido (o mesmo do serviço) quando está livre; ocupado → próximo", async (t) => {
  const { engine, fake, store } = setup(t);
  assert.deepEqual(await engine.addLogin({ ...fake.login("um@x.com"), number: 4 }), { number: 4, created: true });
  assert.equal(store.state.nextNumber, 5);
  // Sem número: o próximo depois do maior.
  assert.deepEqual(await engine.addLogin(fake.login("dois@x.com")), { number: 5, created: true });
  // Número livre abaixo do maior também vale.
  assert.deepEqual(await engine.addLogin({ ...fake.login("tres@x.com"), number: 1 }), { number: 1, created: true });
  // Ocupado → próximo livre (não sobrescreve outra conta).
  assert.deepEqual(await engine.addLogin({ ...fake.login("quatro@x.com"), number: 4 }), { number: 6, created: true });
  assert.equal(store.state.accounts["4"].email, "um@x.com");
  // Conta que já existe mantém o número dela.
  const a = store.state.accounts["5"];
  assert.deepEqual(await engine.addLogin({ ...fake.login("dois@x.com"), number: 9 }), { number: 5, created: false });
  assert.equal(a.email, "dois@x.com");
});

// ------------------------------------------------------------------ fim do login (refreshTokenExpiresAt)

test("fim do login: addLogin guarda refreshTokenExpiresAt, as renovações mantêm e credentialFor entrega", async (t) => {
  const { engine, fake, clock, store, disk, logs } = setup(t);
  const END = START + 30 * DAY;
  const login = fake.login("ana@x.com");
  login.claudeAiOauth.refreshTokenExpiresAt = END;
  assert.deepEqual(await engine.addLogin(login), { number: 1, created: true });
  const acc = store.state.accounts["1"];
  assert.notEqual(acc.cred.refreshToken, login.claudeAiOauth.refreshToken, "renovou na hora");
  assert.equal(acc.cred.refreshTokenExpiresAt, END, "guardou e manteve depois da renovação feita na hora");
  assert.equal(disk().accounts["1"].cred.refreshTokenExpiresAt, END, "no cofre");

  // Renovações seguintes (forçada e pelo ciclo) mantêm a data.
  assert.deepEqual(await engine.refreshAccount(1, { minValidMs: Infinity }), { ok: true, refreshed: true });
  assert.equal(acc.cred.refreshTokenExpiresAt, END);
  clock.t += 7 * HOUR; // o acesso vence em 1 h → o ciclo renova
  await engine.tick();
  assert.equal(acc.gen, 3);
  assert.equal(acc.cred.refreshTokenExpiresAt, END);
  assert.equal(disk().accounts["1"].cred.refreshTokenExpiresAt, END);

  // credentialFor entrega a data (não é segredo), sem refresh token.
  addDevice(engine, "d1");
  await engine.heartbeat("d1", {});
  const cred = await engine.credentialFor("d1");
  assert.equal(cred.claudeAiOauth.refreshTokenExpiresAt, END);
  assert.deepEqual(Object.keys(cred.claudeAiOauth).sort(), ["accessToken", "expiresAt", "rateLimitTier", "refreshTokenExpiresAt", "scopes", "subscriptionType"]);
  assert.equal("refreshToken" in cred.claudeAiOauth, false);
  assertNoTokens(fake.refreshTokenList(), cred, "a credencial");

  // PublicAccount: loginExpiresAt e accessExpiresAt em ISO; faltam 30 dias → sem aviso.
  const pub = engine.publicList("d1").accounts[0];
  assert.equal(pub.loginExpiresAt, new Date(END).toISOString());
  assert.equal(pub.accessExpiresAt, new Date(acc.cred.expiresAt).toISOString());
  assert.deepEqual(engine.stateFor("d1").warnings, []);

  // Renovação que traz refresh_token_expires_in troca a data.
  fake.tokenExtra = { refresh_token_expires_in: 10 * 24 * 3600 };
  await engine.refreshAccount(1, { minValidMs: Infinity });
  assert.equal(acc.cred.refreshTokenExpiresAt, clock.t + 10 * DAY);
  assert.equal((await engine.credentialFor("d1")).claudeAiOauth.refreshTokenExpiresAt, clock.t + 10 * DAY);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

test("fim do login: login sem refreshTokenExpiresAt (ou com valor inválido) fica desconhecido e não gera aviso", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  const bad = [undefined, null, 0, -1, NaN, Infinity, 1e300, "2026-11-15", "1795000000000", {}];
  for (const [i, v] of bad.entries()) {
    const l = fake.login(`p${i}@x.com`);
    if (v !== undefined) l.claudeAiOauth.refreshTokenExpiresAt = v;
    const { number } = await engine.addLogin(l);
    assert.equal("refreshTokenExpiresAt" in store.state.accounts[String(number)].cred, false, `valor ${String(v)}`);
  }
  addDevice(engine, "d1");
  await engine.heartbeat("d1", {});
  const cred = await engine.credentialFor("d1");
  assert.equal("refreshTokenExpiresAt" in cred.claudeAiOauth, false, "desconhecido não vai (nem como null)");
  for (const p of engine.publicList("d1").accounts) {
    assert.equal(p.loginExpiresAt, null);
    assert.equal(p.accessExpiresAt, new Date(store.state.accounts[String(p.number)].cred.expiresAt).toISOString());
  }

  // Dias depois (renovando no caminho): nenhum aviso de login vencendo e nenhuma data inventada.
  for (let d = 0; d < 4; d++) {
    clock.t += DAY;
    await engine.tick();
  }
  assert.equal(store.state.history.some((h) => h.text.includes(") vence")), false);
  assert.deepEqual(engine.stateFor("d1").warnings, []);
  for (const a of Object.values(store.state.accounts)) assert.equal("refreshTokenExpiresAt" in a.cred, false);
});

test("fim do login: faltando < 3 dias avisa no histórico 1x por dia e em stateFor().warnings; conta morta vira aviso dead", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  const END = START + 4 * DAY;
  const l1 = fake.login("ana@x.com");
  l1.claudeAiOauth.refreshTokenExpiresAt = END;
  await engine.addLogin(l1);
  await engine.addLogin(fake.login("bia@x.com")); // sem a data: nunca avisa
  addDevice(engine, "d1");
  const expiring = () => store.state.history.filter((h) => h.kind === "alert" && h.text.includes(") vence"));

  await engine.tick();
  assert.equal(expiring().length, 0, "faltam 4 dias");
  assert.deepEqual(engine.stateFor("d1").warnings, []);

  clock.t = END - 3 * DAY + MIN; // agora faltam menos de 3 dias
  await engine.tick();
  const text = `O login da conta 1 (ana) vence ${dayTime(END)} — ${RELOGIN_TAIL}`;
  assert.equal(expiring().length, 1);
  assert.equal(expiring()[0].text, text);
  assert.equal(expiring()[0].device, null);
  assert.deepEqual(engine.stateFor("d1").warnings, [{ kind: "login_expiring", account: 1, text }]);
  const warnedOn = store.state.accounts["1"].loginWarnedOn;
  assert.equal(typeof warnedOn, "string");
  assert.equal(disk().accounts["1"].loginWarnedOn, warnedOn, "o dia avisado fica no cofre");

  // Mesmo dia: o histórico não repete (o aviso em warnings continua).
  clock.t += 30 * SEC;
  await engine.tick();
  await engine.tick();
  assert.equal(expiring().length, 1);
  assert.equal(engine.stateFor("d1").warnings.length, 1);

  // O apelido entra no texto.
  await engine.updateAccount(1, { alias: "Trabalho" });
  const withAlias = `O login da conta 1 (Trabalho) vence ${dayTime(END)} — ${RELOGIN_TAIL}`;
  assert.deepEqual(engine.stateFor("d1").warnings, [{ kind: "login_expiring", account: 1, text: withAlias }]);

  // Dia seguinte: avisa de novo, uma vez só.
  clock.t += DAY;
  await engine.tick();
  await engine.tick();
  assert.equal(expiring().length, 2);
  assert.equal(expiring()[0].text, withAlias);

  // Conta morta: aviso "dead" no lugar do "vence", e o histórico para de avisar que vence.
  fake.refreshFail.set("ana@x.com", "invalid_grant");
  assert.equal((await engine.refreshAccount(1, { minValidMs: Infinity })).error, "invalid_grant");
  assert.deepEqual(engine.stateFor("d1").warnings, [{ kind: "dead", account: 1, text: `O login da conta 1 (Trabalho) não vale mais — ${RELOGIN_TAIL}` }]);
  clock.t += DAY;
  await engine.tick();
  assert.equal(expiring().length, 2);

  // Login novo (com data longe): sem avisos, e o dia avisado recomeça.
  fake.refreshFail.delete("ana@x.com");
  const l2 = fake.login("ana@x.com");
  l2.claudeAiOauth.refreshTokenExpiresAt = clock.t + 60 * DAY;
  assert.deepEqual(await engine.addLogin(l2), { number: 1, created: false });
  assert.equal(store.state.accounts["1"].cred.refreshTokenExpiresAt, clock.t + 60 * DAY);
  assert.equal(store.state.accounts["1"].loginWarnedOn, null);
  assert.deepEqual(engine.stateFor("d1").warnings, []);
});

test("setLoginExpiresAt: preenche a data de conta enviada antes, grava e registra; recusa data inválida e conta inexistente", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com")); // login de antes da mudança: sem a data
  const acc = store.state.accounts["1"];
  assert.equal(engine.publicList(null).accounts[0].loginExpiresAt, null);

  const END = START + 2 * DAY;
  const cred0 = acc.cred;
  assert.deepEqual(await engine.setLoginExpiresAt(1, END), { number: 1, loginExpiresAt: new Date(END).toISOString() });
  assert.equal(acc.cred, cred0, "muda no lugar (a renovação compara o objeto cred)");
  assert.equal(acc.cred.refreshTokenExpiresAt, END);
  assert.equal(disk().accounts["1"].cred.refreshTokenExpiresAt, END, "gravado no cofre");
  assert.equal(store.state.history[0].kind, "info");
  assert.equal(store.state.history[0].text, "Validade do login da conta 1 preenchida");
  assert.equal(engine.publicList(null).accounts[0].loginExpiresAt, new Date(END).toISOString());

  // Faltam 2 dias: o ciclo avisa; a renovação mantém a data; credentialFor entrega.
  await engine.tick();
  assert.ok(store.state.history.some((h) => h.kind === "alert" && h.text.startsWith("O login da conta 1 (ana) vence")));
  await engine.refreshAccount(1, { minValidMs: Infinity });
  assert.equal(acc.cred.refreshTokenExpiresAt, END);
  addDevice(engine, "d1");
  await engine.heartbeat("d1", {});
  assert.equal((await engine.credentialFor("d1")).claudeAiOauth.refreshTokenExpiresAt, END);

  // Número em texto vale (vem da rota de admin).
  await engine.setLoginExpiresAt(1, String(END + HOUR));
  assert.equal(acc.cred.refreshTokenExpiresAt, END + HOUR);

  // Inválidos: nada muda.
  const hist = store.state.history.length;
  const bad = [undefined, null, "", "abc", {}, NaN, Infinity, -1, 0, clock.t - DAY, clock.t - 2 * DAY, Math.floor(END / 1000) /* em segundos */, clock.t + 6 * 365 * DAY];
  for (const v of bad) await assert.rejects(engine.setLoginExpiresAt(1, v), (e) => e.code === "invalid", String(v));
  assert.equal(acc.cred.refreshTokenExpiresAt, END + HOUR);
  assert.equal(store.state.history.length, hist);
  await assert.rejects(engine.setLoginExpiresAt(9, END), (e) => e.code === "not_found");
});

// ------------------------------------------------------------------ encerramento (stop)

test("stop(): espera a renovação em andamento fora do ciclo (credentialFor) e ela já está no cofre quando resolve", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  clock.t += 8 * HOUR - 10 * MIN; // vence em 10 min: credentialFor renova
  addDevice(engine, "d1");
  await engine.heartbeat("d1", {});
  const g = gate();
  let arrived;
  const seen = new Promise((r) => (arrived = r));
  fake.onRefresh = arrived;
  fake.refreshGate = g.p;

  const pc = engine.credentialFor("d1");
  await seen; // a renovação saiu e está esperando a resposta
  let stopped = false;
  const sp = engine.stop().then(() => {
    stopped = true;
  });
  await settle();
  assert.equal(stopped, false, "stop() espera a renovação que está no ar");
  g.open();
  await sp;
  const acc = store.state.accounts["1"];
  assert.equal(acc.gen, 2);
  assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken, "o refresh token novo já estava no cofre quando stop() resolveu");
  const c = await pc;
  assert.equal(c.claudeAiOauth.accessToken, acc.cred.accessToken);
});

test("stop() no meio do ciclo: termina a renovação em andamento e não começa outra; depois nada gasta refresh token", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  clock.t += 7 * HOUR; // as duas vencem em 1 h → o ciclo renovaria as duas
  const g = gate();
  let arrived;
  const seen = new Promise((r) => (arrived = r));
  fake.onRefresh = arrived;
  fake.refreshGate = g.p;
  const r0 = fake.count("refresh");

  const tp = engine.tick();
  await seen;
  const sp = engine.stop();
  g.open();
  await sp;
  await tp;
  assert.equal(fake.count("refresh"), r0 + 1, "a 2ª conta não começou a renovar");
  assert.equal(store.state.accounts["1"].gen, 2);
  assert.equal(store.state.accounts["2"].gen, 1);

  // Depois do stop: nenhuma renovação começa.
  assert.deepEqual(await engine.refreshAccount(2, { minValidMs: Infinity }), { ok: false, error: "stopping" });
  await engine.tick();
  assert.equal(fake.count("refresh"), r0 + 1, "o ciclo depois do stop não renova");

  // credentialFor não renova: entrega o acesso atual enquanto vale mais de 1 min.
  addDevice(engine, "d1", { assigned: 2, lastSeen: clock.t, lastSwitchBy: "manual" });
  clock.t += 40 * MIN; // a conta 2 vale só mais 20 min (abaixo dos 30 min de sempre)
  const c = await engine.credentialFor("d1");
  assert.equal(c.number, 2);
  assert.equal(c.claudeAiOauth.accessToken, store.state.accounts["2"].cred.accessToken);
  clock.t += 19 * MIN + 30 * SEC; // vale só mais 30 s
  assert.equal(await engine.credentialFor("d1"), null);
  assert.equal(fake.count("refresh"), r0 + 1);

  // addLogin recusa sem gastar o login enviado.
  const l = fake.login("caio@x.com");
  await assert.rejects(engine.addLogin(l), (e) => e.code === "refresh_failed" && /reiniciando/.test(e.message));
  assert.equal(fake.refreshTokens.get(l.claudeAiOauth.refreshToken).spent, false);
  assert.equal(fake.count("refresh"), r0 + 1);
  assert.equal(engine.status().stopping, true);
});

test("stop(): espera o envio de login em andamento (o login renovado é gravado antes de resolver)", async (t) => {
  const { engine, fake, store, disk } = setup(t);
  const g = gate();
  let arrived;
  const seen = new Promise((r) => (arrived = r));
  fake.onRefresh = arrived;
  fake.refreshGate = g.p;
  const l = fake.login("ana@x.com");

  const pl = engine.addLogin(l);
  await seen;
  let stopped = false;
  const sp = engine.stop().then(() => {
    stopped = true;
  });
  await settle();
  assert.equal(stopped, false, "stop() espera o envio de login");
  g.open();
  await sp;
  assert.deepEqual(await pl, { number: 1, created: true });
  assert.equal(disk().accounts["1"].cred.refreshToken, store.state.accounts["1"].cred.refreshToken, "gravado antes de stop() resolver");
  assert.equal(engine.inflight.size, 0);
});

test("stop() durante a conferência de identidade de um envio de login: recusa antes de gastar o login", async (t) => {
  const { engine, fake } = setup(t);
  const g = gate();
  let arrived;
  const seen = new Promise((r) => (arrived = r));
  fake.onProfile = arrived;
  fake.profileGate = g.p;
  const l = fake.login("ana@x.com"); // acesso valendo: confere o perfil antes de renovar
  const r0 = fake.count("refresh");

  const pl = engine.addLogin(l);
  await seen;
  const sp = engine.stop();
  g.open();
  await assert.rejects(pl, (e) => e.code === "refresh_failed" && /reiniciando/.test(e.message));
  await sp;
  assert.equal(fake.count("refresh"), r0, "não renovou");
  assert.equal(fake.refreshTokens.get(l.claudeAiOauth.refreshToken).spent, false, "o login enviado continua valendo");
});

// ------------------------------------------------------------------ 401 na leitura de uso

test("uso: 401 com token renovado há menos de 15 min só vai para o log; 401 sem fim renova no máximo ~1x a cada 15 min e respeita a espera", async (t) => {
  const { engine, fake, clock, store, logs } = setup(t);
  await engine.addLogin(fake.login("ana@x.com")); // renovado agora
  store.state.diag.oldTokenValidAfterRefresh = true; // sem diagnóstico no meio da contagem
  const acc = store.state.accounts["1"];
  for (let i = 0; i < 200; i++) fake.usageReplies.push({ status: 401, body: { error: { type: "authentication_error" } } });
  const r0 = fake.count("refresh");

  await engine.tick();
  assert.equal(fake.count("usage"), 1);
  assert.equal(fake.count("refresh"), r0, "token de agora: um 401 não faz renovar");
  assert.ok(logs.some((l) => l.includes("(401)") && l.includes("não renovo")));
  assert.equal(acc.usageError, "unauthorized");

  // Uma hora de 401 seguidos (antes: uma renovação a cada leitura).
  for (let i = 0; i < 240; i++) {
    clock.t += 15 * SEC;
    await engine.tick();
  }
  const n = fake.count("refresh") - r0;
  assert.ok(n >= 1 && n <= 4, `renovações em 1 h de 401: ${n}`);
  assert.equal(acc.dead, null);

  // Token velho, mas dentro da espera de renovação: o 401 não ignora a espera.
  clock.t += 20 * MIN;
  acc.refreshBackoffUntil = clock.t + 10 * MIN;
  const r1 = fake.count("refresh");
  await engine.pollAccount(1);
  assert.equal(fake.count("refresh"), r1);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

// ------------------------------------------------------------------ antecedência e datas

test("renovação: token curto (1 h) renova na metade da vida, não a cada ciclo", async (t) => {
  const { engine, fake, clock } = setup(t);
  fake.expiresIn = 3600; // a Anthropic dá acesso de 1 h (menos que REFRESH_AHEAD_MIN = 2 h)
  await engine.addLogin(fake.login("ana@x.com"));
  const r0 = fake.count("refresh");
  for (let i = 0; i < 120; i++) {
    clock.t += MIN;
    await engine.tick();
  }
  // Renova quando faltam menos de 30 min: aos 31, 62 e 93 min.
  assert.equal(fake.count("refresh") - r0, 3);

  // A credencial entregue também segue a metade da vida: com acesso de 20 min (menos que os 30 min
  // de sempre), entrega o que tem em vez de renovar a cada pedido.
  fake.expiresIn = 20 * 60;
  assert.equal((await engine.refreshAccount(1, { minValidMs: Infinity })).refreshed, true);
  addDevice(engine, "d1");
  await engine.heartbeat("d1", {});
  const r1 = fake.count("refresh");
  for (let i = 0; i < 5; i++) {
    const c = await engine.credentialFor("d1");
    assert.ok(c && c.claudeAiOauth.expiresAt - clock.t >= 10 * MIN);
  }
  assert.equal(fake.count("refresh"), r1);
});

test("renovação: data de validade absurda ou inválida não lança no meio e vira uma data que serve", async (t) => {
  let forced = 1e17; // além do que o Date aceita
  const { engine, fake, clock, store, disk, logs } = setup(t, {
    wrap: (a) => ({
      ...a,
      async refresh(c) {
        const r = await a.refresh(c);
        if (r.ok) r.cred.expiresAt = forced;
        return r;
      },
    }),
  });
  assert.deepEqual(await engine.addLogin(fake.login("ana@x.com")), { number: 1, created: true });
  const acc = store.state.accounts["1"];
  assert.equal(acc.cred.expiresAt, clock.t + HOUR, "inválida no envio do login → 1 h");

  for (const [value, want] of [
    [1e17, clock.t + HOUR],
    [NaN, clock.t + HOUR],
    ["amanhã", clock.t + HOUR],
    [clock.t + 400 * DAY, clock.t + 24 * HOUR],
  ]) {
    forced = value;
    assert.deepEqual(await engine.refreshAccount(1, { minValidMs: Infinity }), { ok: true, refreshed: true }, String(value));
    assert.equal(acc.cred.expiresAt, want, String(value));
    assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken);
  }
  assert.equal(typeof engine.publicList(null).accounts[0].accessExpiresAt, "string");
  assert.ok(!logs.some((l) => l.includes("erro no ciclo")));
  assert.equal(engine.iso(1e17), "data inválida");
  assert.equal(engine.iso(NaN), "data inválida");
});

// ------------------------------------------------------------------ renovação sem resposta (ambígua)

test("renovação sem resposta (tempo esgotado, 503): tenta de novo em ~15 s mesmo com o acesso valendo; DNS (nunca saiu) espera o normal", async (t) => {
  const { engine, fake, clock, store, logs } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  store.state.diag.oldTokenValidAfterRefresh = true;
  const acc = store.state.accounts["1"];
  clock.t += 20 * MIN; // o acesso ainda vale mais de 7 h
  const r0 = fake.count("refresh");

  fake.refreshFail.set("ana@x.com", "timeout");
  assert.deepEqual(await engine.refreshAccount(1, { minValidMs: Infinity }), { ok: false, error: "transient" });
  assert.equal(acc.refreshBackoffUntil, clock.t + 15 * SEC);
  assert.equal(acc.lastAmbiguousAt, clock.t);
  assert.equal(acc.refreshRetry, true);
  assert.equal(acc.dead, null);
  assert.ok(logs.some((l) => l.includes("sem resposta") && l.includes("15 s")));
  fake.refreshFail.delete("ana@x.com");
  await engine.tick();
  assert.equal(fake.count("refresh"), r0 + 1, "dentro da espera não tenta");
  clock.t += 15 * SEC;
  await engine.tick(); // renova assim mesmo (a anterior ficou sem resposta)
  assert.equal(fake.count("refresh"), r0 + 2);
  assert.equal(acc.gen, 2);
  assert.equal(acc.lastAmbiguousAt, null);
  assert.equal(acc.refreshRetry, false);
  await engine.tick();
  assert.equal(fake.count("refresh"), r0 + 2, "resolvido: não renova de novo");

  // 503 também é "sem resposta".
  fake.refreshFail.set("ana@x.com", "overloaded");
  await engine.refreshAccount(1, { minValidMs: Infinity });
  assert.equal(acc.refreshBackoffUntil, clock.t + 15 * SEC);
  // Falhou de novo sem resposta: daí em diante a espera normal (2 min), não a cada 15 s.
  clock.t += 15 * SEC;
  await engine.tick();
  assert.equal(acc.refreshFailures, 2);
  assert.equal(acc.refreshBackoffUntil, clock.t + 2 * MIN);
  fake.refreshFail.delete("ana@x.com");
  clock.t += 2 * MIN;
  await engine.tick();
  assert.equal(acc.gen, 3);

  // DNS: o pedido nunca saiu → espera normal (1 min) e nada de "ambígua".
  fake.refreshFail.set("ana@x.com", "dns");
  await engine.refreshAccount(1, { minValidMs: Infinity });
  assert.equal(acc.refreshBackoffUntil, clock.t + MIN);
  assert.equal(acc.lastAmbiguousAt, null);
  assert.equal(acc.refreshRetry, false);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

test("renovação sem resposta que gastou o login: o invalid_grant seguinte é confirmado 2 min depois antes de dar a conta como morta", async (t) => {
  const { engine, fake, clock, store, logs } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  store.state.diag.oldTokenValidAfterRefresh = true;
  const acc = store.state.accounts["1"];
  clock.t += 7 * HOUR; // hora de renovar
  fake.refreshFail.set("ana@x.com", "lost"); // a Anthropic renova (gasta) mas a resposta não chega
  await engine.tick();
  assert.equal(acc.refreshBackoffUntil, clock.t + 15 * SEC);
  assert.equal(acc.dead, null);
  fake.refreshFail.delete("ana@x.com");

  clock.t += 15 * SEC;
  await engine.tick(); // invalid_grant logo depois de uma sem resposta: ainda não marca morta
  assert.equal(acc.dead, null);
  assert.equal(acc.invalidGrantAt, clock.t);
  assert.equal(acc.refreshBackoffUntil, clock.t + 2 * MIN);
  assert.ok(logs.some((l) => l.includes("invalid_grant") && l.includes("confirmo")));
  const r1 = fake.count("refresh");
  clock.t += MIN;
  await engine.tick();
  assert.equal(fake.count("refresh"), r1, "espera os 2 min");

  clock.t += MIN;
  await engine.tick(); // confirmou: morta, e o aviso diz por quê
  assert.equal(fake.count("refresh"), r1 + 1);
  assert.deepEqual(acc.dead, { reason: "relogin_required", at: clock.t, cause: "no_response" });
  const alert = store.state.history.find((h) => h.kind === "alert" && h.text.includes("conta 1"));
  assert.match(alert.text, /a renovação anterior ficou sem resposta e o login foi gasto/);
  const w = engine.stateFor(null).warnings.find((x) => x.kind === "dead");
  assert.match(w.text, /ficou sem resposta/);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

test("renovação: invalid_grant sem renovação sem resposta recente (ou de mais de 10 min) marca a conta como morta na hora", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const acc = store.state.accounts["1"];
  acc.lastAmbiguousAt = clock.t - 11 * MIN;
  fake.refreshFail.set("ana@x.com", "invalid_grant");
  assert.equal((await engine.refreshAccount(1, { minValidMs: Infinity })).error, "invalid_grant");
  assert.deepEqual(acc.dead, { reason: "relogin_required", at: clock.t });
  const alert = store.state.history.find((h) => h.kind === "alert");
  assert.match(alert.text, /a Anthropic recusou a renovação/);
});

// ------------------------------------------------------------------ cofre sem gravar

test("cofre sem gravar: aviso save_failed em warnings e no status, e nada mais renova até voltar a gravar", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const acc = store.state.accounts["1"];
  clock.t += 7 * HOUR;
  const realSave = store.save.bind(store);
  let failSave = true;
  store.save = () => (failSave ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })) : realSave());

  assert.deepEqual(await engine.refreshAccount(1), { ok: false, error: "save_failed" }, "renovou, mas o cofre não gravou");
  const warn = { kind: "save_failed", text: "O cofre não está gravando (disco cheio?). NÃO reinicie o servidor: há login renovado só na memória." };
  assert.deepEqual(engine.stateFor(null).warnings, [warn]);
  const st = engine.status();
  assert.equal(st.saveFailed, true);
  assert.deepEqual(st.warnings, [warn]);

  const r0 = fake.count("refresh");
  assert.deepEqual(await engine.refreshAccount(1, { minValidMs: Infinity }), { ok: false, error: "save_failed" });
  assert.equal(fake.count("refresh"), r0, "não gasta outro refresh token com o cofre sem gravar");

  failSave = false;
  await engine.tick();
  assert.equal(engine.saveFailed, false);
  assert.deepEqual(engine.stateFor(null).warnings, []);
  assert.equal(engine.status().saveFailed, false);
  assert.equal(disk().accounts["1"].cred.refreshToken, acc.cred.refreshToken, "o login renovado chegou ao disco");
});

test("addLogin e renovação conferem o cofre antes de gastar: sem gravar, trava perdida ou fechado → recusa sem renovar", async (t) => {
  const { engine, fake, store } = setup(t);
  const realSave = store.save.bind(store);
  let failSave = true;
  store.save = () => (failSave ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })) : realSave());
  await engine.saveQuiet();
  assert.equal(engine.saveFailed, true);

  const l = fake.login("ana@x.com");
  const r0 = fake.count("refresh");
  await assert.rejects(engine.addLogin(l), (e) => e.code === "refresh_failed" && /cofre/.test(e.message));
  assert.equal(fake.count("refresh"), r0, "não renovou");
  assert.equal(fake.refreshTokens.get(l.claudeAiOauth.refreshToken).spent, false, "o login enviado continua valendo");

  failSave = false; // voltou a gravar: grava primeiro e só então renova
  assert.deepEqual(await engine.addLogin(l), { number: 1, created: true });
  assert.equal(engine.saveFailed, false);

  for (const flag of ["lockLost", "closed"]) {
    store[flag] = true;
    const r1 = fake.count("refresh");
    const l2 = fake.login("bia@x.com");
    await assert.rejects(engine.addLogin(l2), (e) => e.code === "refresh_failed", flag);
    assert.deepEqual(await engine.refreshAccount(1, { minValidMs: Infinity }), { ok: false, error: "save_failed" }, flag);
    assert.equal(fake.count("refresh"), r1, flag);
    assert.equal(fake.refreshTokens.get(l2.claudeAiOauth.refreshToken).spent, false, flag);
    store[flag] = false;
  }
});

test("addLogin: com a identidade conferida antes de gastar, não pergunta o perfil de novo depois de renovar", async (t) => {
  const { engine, fake } = setup(t);
  fake.omitTokenAccount = true; // a renovação não diz de quem é: só o perfil diria
  const p0 = fake.count("profile");
  await engine.addLogin(fake.login("ana@x.com")); // acesso valendo: confere antes
  assert.equal(fake.count("profile"), p0 + 1, "só a conferência de antes");
  const kinds = fake.calls.map((c) => c.kind);
  assert.deepEqual(kinds.slice(-2), ["profile", "refresh"], "conferiu antes e não depois");

  // Sem conferência antes (acesso vencendo) e sem identidade na renovação: aí sim pergunta o perfil do token novo.
  const p1 = fake.count("profile");
  await engine.addLogin(fake.login("bia@x.com", { expiresInMs: 30 * SEC }));
  assert.equal(fake.count("profile"), p1 + 1);
  assert.deepEqual(fake.calls.map((c) => c.kind).slice(-2), ["refresh", "profile"]);
});

// ------------------------------------------------------------------ logins gastos

test("addLogin: o mesmo login enviado duas vezes ao mesmo tempo renova uma vez só", async (t) => {
  const { engine, fake, store } = setup(t);
  const l = fake.login("ana@x.com");
  const r0 = fake.count("refresh");
  const [a, b] = await Promise.allSettled([engine.addLogin(l), engine.addLogin({ claudeAiOauth: { ...l.claudeAiOauth }, oauthAccount: { ...l.oauthAccount } })]);
  assert.equal(fake.count("refresh"), r0 + 1, "renovou uma vez só");
  assert.equal(a.status, "fulfilled");
  assert.deepEqual(a.value, { number: 1, created: true });
  assert.equal(b.status, "rejected");
  assert.equal(b.reason.code, "stale_login", "o outro vê que o servidor já gastou esse login");
  assert.deepEqual(Object.keys(store.state.accounts), ["1"]);
  assert.equal(store.state.accounts["1"].dead, null);
});

test("refresh tokens gastos: a lista guarda muitos (um login reenviado depois de várias renovações continua stale_login)", async (t) => {
  const { engine, fake } = setup(t);
  const l1 = fake.login("ana@x.com");
  await engine.addLogin(l1);
  for (let i = 0; i < 15; i++) assert.equal((await engine.refreshAccount(1, { minValidMs: Infinity })).refreshed, true);
  const r0 = fake.count("refresh");
  await assert.rejects(engine.addLogin(l1), (e) => e.code === "stale_login");
  assert.equal(fake.count("refresh"), r0, "nem falou com a Anthropic");
});

test("addLogin: identidade errada descoberta depois de renovar → identity_mismatch_spent; o login gasto nunca mais vai para a Anthropic", async (t) => {
  const { engine, fake, store, disk, logs } = setup(t);
  fake.omitTokenAccount = true; // só o perfil do token novo revela de quem é
  const l = fake.login("ivo@x.com", { expiresInMs: 30 * SEC }); // acesso vencendo: sem conferência antes
  l.oauthAccount.emailAddress = "bia@x.com";
  const r0 = fake.count("refresh");
  await assert.rejects(engine.addLogin(l), (e) => e.code === "identity_mismatch_spent" && /não vale mais/.test(e.message));
  assert.equal(fake.count("refresh"), r0 + 1);
  assert.equal(fake.refreshTokens.get(l.claudeAiOauth.refreshToken).spent, true, "o enviado foi gasto");
  assert.deepEqual(Object.keys(store.state.accounts), [], "nenhuma conta criada");
  assert.ok(engine.isSpent(l.claudeAiOauth.refreshToken));
  assert.ok(disk().spentLogins.includes(sha256(l.claudeAiOauth.refreshToken)), "a lista dos gastos está no cofre");

  // Reenviar: stale_login, sem falar com a Anthropic.
  await assert.rejects(engine.addLogin(l), (e) => e.code === "stale_login");
  assert.equal(fake.count("refresh"), r0 + 1);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");

  // Identidade errada conferida ANTES de renovar continua identity_mismatch (nada gasto).
  const l2 = fake.login("caio@x.com");
  l2.oauthAccount.emailAddress = "bia@x.com";
  await assert.rejects(engine.addLogin(l2), (e) => e.code === "identity_mismatch");
  assert.equal(fake.refreshTokens.get(l2.claudeAiOauth.refreshToken).spent, false);
});

// ------------------------------------------------------------------ serviços permitidos por conta (access.js, WEB-SPEC 2.3)

test("serviços permitidos: conta restrita a outro serviço nunca é atribuída nem entregue (troca automática ligada ou desligada)", async (t) => {
  const { engine, fake, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1, { session: 5 }); // a 1 seria a escolhida (mais folga)...
  setUsage(engine, 2, { session: 50 });
  const d1 = addDevice(engine, "d1");
  const d2 = addDevice(engine, "d2");
  assert.deepEqual(await engine.setAccountDevices(1, ["d2"]), { number: 1, devices: ["d2"] }); // ...mas é só do d2
  assert.deepEqual(disk().accountDevices, { 1: ["d2"] });

  const st0 = await engine.heartbeat("d1", {});
  assert.equal(st0.device.assigned, 2, "conectou: recebeu a conta liberada, não a de mais folga");
  assert.equal(st0.records["1"].disabled, false, "records (extensão/painel) continua global: a 1 não vira 'fora da rotação'");
  assert.equal((await engine.credentialFor("d1")).number, 2);
  const best = await engine.switchDevice("d1", null); // "melhor conta": só entre as liberadas
  assert.deepEqual([best.switched, best.to], [false, 2]);

  // Serviço numa conta que não está liberada para ele (estado antigo): troca antes de entregar.
  d1.assigned = 1;
  assert.equal(engine.stateFor("d1").credential, null, "o estado não mostra a credencial da conta não liberada");
  const c = await engine.credentialFor("d1");
  assert.equal(c.number, 2);
  assert.equal(c.claudeAiOauth.accessToken, store.state.accounts["2"].cred.accessToken);
  assert.equal(d1.assigned, 2);
  assert.equal(store.state.history[0].text, "Trocou da conta 1 para a conta 2: a conta 1 não está liberada para este serviço");

  // Troca automática desligada: a permissão vale do mesmo jeito (é permissão, não preferência).
  await engine.setRules({ autoSwitch: false });
  Object.assign(d1, { assigned: 1, lastSwitchBy: "manual" });
  assert.equal((await engine.heartbeat("d1", {})).device.assigned, 2);

  // Nenhuma conta liberada para o d1: fica sem conta e nada é entregue.
  await engine.setAccountDevices(2, ["d2"]);
  assert.equal(d1.assigned, null);
  const alert = store.state.history.find((h) => h.kind === "alert" && h.device === "d1");
  assert.equal(alert.text, "Nenhuma conta disponível para PC d1 (a conta 2 não está liberada para este serviço)");
  assert.equal(await engine.credentialFor("d1"), null);
  assert.equal((await engine.heartbeat("d1", {})).device.assigned, null);
  assert.equal(engine.stateFor("d1").credential, null);
  // O d2 usa as duas (e pega a de mais folga).
  assert.equal((await engine.heartbeat("d2", {})).device.assigned, 1);
  assert.equal((await engine.credentialFor("d2")).number, 1);
  assert.equal(d2.assigned, 1);
});

test("serviços permitidos: troca automática (inclusive a reserva 'dividir') e limitHit só escolhem contas liberadas", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  await engine.addLogin(fake.login("caio@x.com"));
  setUsage(engine, 1, { session: 95 }); // passou da linha de 90%
  setUsage(engine, 2, { session: 10 });
  setUsage(engine, 3, { session: 5 }); // a mais livre, mas só do d2
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "auto" });
  const d2 = addDevice(engine, "d2", { assigned: 2, lastSeen: clock.t, lastSwitchBy: "auto" });
  await engine.setAccountDevices(3, ["d2"]);

  // Sem a regra o d1 iria para a 3 (livre). Com ela, a única liberada é a 2 (do d2): dividir é melhor que parar.
  await engine.tick();
  assert.equal(d1.assigned, 2, "a reserva 'dividir' não abre a conta não liberada");
  assert.equal(d2.assigned, 2);
  const h = store.state.history.find((x) => x.device === "d1" && x.kind === "switch");
  assert.match(h.text, /^Trocou da conta 1 para a conta 2/);

  // limitHit: a 3 continua fora para o d1.
  Object.assign(d1, { assigned: 1, lastSwitchAt: clock.t - MIN, lastSwitchBy: "auto" });
  setUsage(engine, 1, { session: 40 }); // o dado ainda não mostra o limite
  let r = await engine.limitHit("d1", "limite da sessão de 5h");
  assert.deepEqual([r.switched, r.to, d1.assigned], [true, 2, 2]);

  // A 3 liberada para todos de novo: o mesmo limitHit vai para a 3 (era a regra que a segurava).
  await engine.setAccountDevices(3, null);
  Object.assign(d1, { assigned: 1, lastSwitchAt: clock.t - MIN, lastSwitchBy: "auto" });
  r = await engine.limitHit("d1", "limite da sessão de 5h");
  assert.deepEqual([r.switched, r.to, d1.assigned], [true, 3, 3]);
});

test("serviços permitidos: switchDevice para conta não liberada → not_allowed (409) e nada muda", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t });
  const d2 = addDevice(engine, "d2", { assigned: 1, lastSeen: clock.t });
  await engine.setAccountDevices(2, ["d2"]);
  const h0 = store.state.history.length;
  for (const by of ["manual", "painel"]) {
    await assert.rejects(
      engine.switchDevice("d1", 2, by),
      (e) =>
        e.code === "not_allowed" &&
        ERROR_STATUS[e.code] === 409 &&
        e.message.startsWith("a conta 2 não está liberada para este serviço") &&
        e.message.includes('"PC d1"')
    );
  }
  assert.equal(d1.assigned, 1);
  assert.equal(store.state.history.length, h0, "nada no histórico");
  assert.equal(disk().devices.d1.assigned, 1);

  // Para o serviço liberado funciona; os erros de antes continuam.
  const r = await engine.switchDevice("d2", 2);
  assert.deepEqual([r.switched, r.to, d2.assigned], [true, 2, 2]);
  await assert.rejects(engine.switchDevice("d1", 9), (e) => e.code === "not_found");
  store.state.accounts["2"].dead = { reason: "relogin_required", at: clock.t };
  await assert.rejects(engine.switchDevice("d1", 2), (e) => e.code === "dead_account");
});

test("serviços permitidos: limitHit numa conta que deixou de ser liberada sai dela (mesmo com a troca automática desligada)", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "manual" });
  addDevice(engine, "d2");
  await engine.setRules({ autoSwitch: false });
  store.state.accountDevices = { 1: ["d2"] }; // a regra mudou sem o motor trocar o serviço (ex.: cofre mexido)

  const r = await engine.limitHit("d1", "limite semanal");
  assert.deepEqual([r.switched, r.to, d1.assigned], [true, 2, 2]);
  assert.equal(r.text, "Trocou da conta 1 para a conta 2: a conta 1 não está liberada para este serviço");

  store.state.accountDevices = { 1: ["d2"], 2: [] };
  const r2 = await engine.limitHit("d1", "limite semanal");
  assert.deepEqual([r2.switched, d1.assigned], [false, null]);
  assert.equal(r2.text, "Nenhuma conta disponível para PC d1 (a conta 2 não está liberada para este serviço)");
});

test("serviços permitidos: setAccountDevices grava, registra, troca na hora quem perdeu a permissão e tira a conta de quem está parado", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  const d1 = addDevice(engine, "d1", { name: "Mac", assigned: 1, lastSeen: clock.t, lastSwitchBy: "manual" });
  const d2 = addDevice(engine, "d2", { name: "Windows", assigned: 2, lastSeen: clock.t, lastSwitchBy: "auto" });
  const d3 = addDevice(engine, "d3", { name: "Antigo", assigned: 1, lastSeen: clock.t - HOUR }); // parado

  // Erros: nada muda.
  await assert.rejects(engine.setAccountDevices(9, null), (e) => e.code === "not_found");
  await assert.rejects(engine.setAccountDevices(1, "d2"), (e) => e.code === "invalid");
  await assert.rejects(engine.setAccountDevices(1, ["d2", "nao-existe"]), (e) => e.code === "invalid");
  await assert.rejects(engine.setAccountDevices(1, ["d2", "d2"]), (e) => e.code === "invalid");
  assert.equal(access.accountDevicesFor(store.state, 1), null);
  assert.deepEqual([d1.assigned, d2.assigned, d3.assigned], [1, 2, 1]);

  // Conta 1 só no Windows: o Mac (ativo; escolheu à mão) troca já; o parado fica sem conta.
  assert.deepEqual(await engine.setAccountDevices("1", ["d2"]), { number: 1, devices: ["d2"] });
  assert.equal(d1.assigned, 2, "ativo: trocou na hora (escolha manual não segura uma conta não liberada)");
  assert.equal(d3.assigned, null, "parado: recebe uma conta liberada na próxima conexão");
  assert.equal(d2.assigned, 2);
  assert.ok(store.state.history.some((h) => h.text === 'Conta 1 liberada para "Windows"'));
  const sw = store.state.history.find((h) => h.device === "d1" && h.kind === "switch");
  assert.equal(sw.text, "Trocou da conta 1 para a conta 2: a conta 1 não está liberada para este serviço");
  let onDisk = disk();
  assert.deepEqual(onDisk.accountDevices, { 1: ["d2"] });
  assert.equal(onDisk.devices.d1.assigned, 2);
  assert.equal(onDisk.devices.d3.assigned, null);

  // O parado volta: recebe uma conta liberada para ele.
  assert.equal((await engine.heartbeat("d3", {})).device.assigned, 2);

  // O mesmo valor de novo não repete no histórico.
  const n0 = store.state.history.length;
  await engine.setAccountDevices(1, ["d2"]);
  assert.equal(store.state.history.length, n0);

  // Nenhum serviço ([]): quem estava nela sai; a lista vazia fica gravada.
  await engine.switchDevice("d2", 1);
  assert.deepEqual(await engine.setAccountDevices(1, []), { number: 1, devices: [] });
  assert.equal(d2.assigned, 2);
  assert.ok(store.state.history.some((h) => h.text === "Conta 1 não está liberada para nenhum serviço"));
  assert.deepEqual(disk().accountDevices, { 1: [] });
  assert.equal(access.canUse(store.state, d2, 1), false);

  // Todos de novo (null): a entrada some; serviço que conectar depois também pode usar.
  assert.deepEqual(await engine.setAccountDevices(1, null), { number: 1, devices: null });
  onDisk = disk();
  assert.equal(Object.prototype.hasOwnProperty.call(onDisk.accountDevices || {}, "1"), false);
  assert.ok(store.state.history.some((h) => h.text === "Conta 1 liberada para todos os serviços"));
  const d4 = addDevice(engine, "d4");
  assert.equal(access.canUse(store.state, d4, 1), true);
});

test("serviços permitidos: remover a conta apaga a lista dela; conta nova com o mesmo número começa liberada para todos", async (t) => {
  const { engine, fake, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  addDevice(engine, "d1");
  const d2 = addDevice(engine, "d2");
  await engine.setAccountDevices(1, ["d1"]);
  await engine.setAccountDevices(2, ["d1", "d2"]);

  await engine.removeAccount(1);
  assert.deepEqual(store.state.accountDevices, { 2: ["d1", "d2"] });
  assert.deepEqual(disk().accountDevices, { 2: ["d1", "d2"] });

  // Número 1 reaproveitado (o serviço que mandou o login conhecia a conta como 1): liberada para todos.
  assert.deepEqual(await engine.addLogin({ ...fake.login("caio@x.com"), number: 1 }), { number: 1, created: true });
  assert.equal(access.accountDevicesFor(store.state, 1), null);
  assert.equal(access.canUse(store.state, d2, 1), true);

  // Lista que sobrou de uma conta que não existe mais (cofre mexido à mão) não passa para a conta nova.
  store.state.accountDevices["7"] = ["d1"];
  assert.deepEqual(await engine.addLogin({ ...fake.login("davi@x.com"), number: 7 }), { number: 7, created: true });
  assert.equal(Object.prototype.hasOwnProperty.call(store.state.accountDevices, "7"), false);
  assert.equal(access.canUse(store.state, d2, 7), true);

  // Login novo de uma conta que já existe não mexe na lista dela.
  assert.deepEqual(await engine.addLogin(fake.login("bia@x.com")), { number: 2, created: false });
  assert.deepEqual(store.state.accountDevices["2"], ["d1", "d2"]);
});

test("serviços permitidos: credentialFor confere de novo depois da renovação (a conta deixou de ser liberada no meio)", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  clock.t += 8 * HOUR - 10 * MIN; // as duas vencem em 10 min: credentialFor renova
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "manual" });
  addDevice(engine, "d2");

  // 1) A regra muda enquanto a renovação da conta 1 está no ar (sem o motor trocar o serviço).
  const g = gate();
  let arrived;
  const seen = new Promise((r) => (arrived = r));
  fake.onRefresh = arrived;
  fake.refreshGate = g.p;
  const pc = engine.credentialFor("d1");
  await seen;
  store.state.accountDevices = { 1: ["d2"] };
  g.open();
  const c = await pc;
  assert.equal(c.number, 2, "não entrega a conta que deixou de estar liberada");
  assert.equal(c.claudeAiOauth.accessToken, store.state.accounts["2"].cred.accessToken);
  assert.equal(d1.assigned, 2);
  const acc1 = store.state.accounts["1"];
  assert.equal(acc1.gen, 2, "a renovação da conta 1 terminou");
  assert.equal(disk().accounts["1"].cred.refreshToken, acc1.cred.refreshToken, "e foi gravada");
  assert.ok(store.state.history.some((h) => h.device === "d1" && h.text === "Trocou da conta 1 para a conta 2: a conta 1 não está liberada para este serviço"));

  // 2) Pelo motor (setAccountDevices) durante a renovação da conta 2, sem outra conta liberada: nada é entregue.
  clock.t += 8 * HOUR - 10 * MIN;
  d1.lastSeen = clock.t;
  const g2 = gate();
  let arrived2;
  const seen2 = new Promise((r) => (arrived2 = r));
  fake.onRefresh = arrived2;
  fake.refreshGate = g2.p;
  const gen2 = store.state.accounts["2"].gen;
  const pc2 = engine.credentialFor("d1");
  await seen2;
  await engine.setAccountDevices(2, ["d2"]);
  assert.equal(d1.assigned, null, "ativo: saiu da conta na hora (nenhuma outra liberada)");
  g2.open();
  assert.equal(await pc2, null);
  assert.equal(d1.assigned, null);
  const acc2 = store.state.accounts["2"];
  assert.equal(acc2.gen, gen2 + 1);
  assert.equal(disk().accounts["2"].cred.refreshToken, acc2.cred.refreshToken, "o login renovado foi gravado mesmo sem entregar");
  assert.ok(store.state.history.some((h) => h.kind === "alert" && h.text === "Nenhuma conta disponível para PC d1 (a conta 2 não está liberada para este serviço)"));
});

// ------------------------------------------------------------------ storeFreshLogin (login recém-emitido pelo painel)

test("storeFreshLogin: guarda o login da troca do código SEM renovar, confere a identidade pelo perfil e grava antes de devolver", async (t) => {
  const { engine, fake, store, disk, logs } = setup(t);
  const l = fake.login("ana@x.com");
  l.claudeAiOauth.refreshTokenExpiresAt = START + 30 * DAY;
  const saves = [];
  const realSave = store.save.bind(store);
  store.save = () => {
    saves.push(JSON.stringify(Object.keys(store.state.accounts)));
    return realSave();
  };

  assert.deepEqual(await engine.storeFreshLogin(l), { number: 1, created: true });
  assert.equal(fake.count("refresh"), 0, "nada de renovação na hora");
  assert.equal(fake.count("profile"), 1, "conferiu a identidade");
  assert.equal(fake.refreshTokens.get(l.claudeAiOauth.refreshToken).spent, false, "o refresh token continua novinho");
  const acc = store.state.accounts["1"];
  assert.equal(acc.cred.refreshToken, l.claudeAiOauth.refreshToken);
  assert.equal(acc.cred.accessToken, l.claudeAiOauth.accessToken);
  assert.equal(acc.cred.expiresAt, l.claudeAiOauth.expiresAt);
  assert.equal(acc.cred.refreshTokenExpiresAt, START + 30 * DAY, "fim do login: o que veio com ele");
  assert.deepEqual([acc.gen, acc.dead, acc.email, acc.orgUuid], [1, null, "ana@x.com", "org-1"]);
  assert.deepEqual(acc.plan, { label: "Max" });
  assert.deepEqual(acc.spentRefresh, []);
  assert.ok(saves.length >= 1 && saves[saves.length - 1] === '["1"]', "gravou com a conta");
  assert.equal(disk().accounts["1"].cred.refreshToken, l.claudeAiOauth.refreshToken, "já estava no cofre quando devolveu");
  assert.equal(store.state.history[0].text, "Login da conta 1 recebido (login novo da assinatura, pelo painel)");
  assert.ok(engine.pollSoon.has(1), "lê o uso logo");

  // O mesmo login de novo: nada a fazer (nem perfil).
  assert.deepEqual(await engine.storeFreshLogin(l), { number: 1, created: false });
  assert.equal(fake.count("profile"), 1);

  // Login novo da mesma conta (conta morta, com espera): atualiza, gen++, revive, zera as esperas.
  Object.assign(acc, { dead: { reason: "relogin_required", at: START }, refreshBackoffUntil: START + HOUR, refreshFailures: 3, pollBackoffUntil: START + HOUR });
  const l2 = fake.login("ana@x.com");
  assert.deepEqual(await engine.storeFreshLogin(l2), { number: 1, created: false });
  assert.deepEqual([acc.gen, acc.dead, acc.refreshBackoffUntil, acc.refreshFailures, acc.pollBackoffUntil], [2, null, 0, 0, 0]);
  assert.equal(acc.cred.refreshToken, l2.claudeAiOauth.refreshToken);
  assert.equal(acc.cred.refreshTokenExpiresAt, undefined, "login novo sem data: fica desconhecido (não herda a do login antigo)");
  assert.equal(fake.count("refresh"), 0);
  assert.equal(disk().accounts["1"].cred.refreshToken, l2.claudeAiOauth.refreshToken);
  assertNoTokens(fake.allTokens(), logs.join("\n"), "o log");
});

test("storeFreshLogin: identidade errada recusa sem mudar nada; perfil indisponível aceita pela identidade da troca", async (t) => {
  const { engine, fake, store, logs } = setup(t);
  const l = fake.login("ivo@x.com");
  l.oauthAccount.emailAddress = "bia@x.com";
  await assert.rejects(engine.storeFreshLogin(l), (e) => e.code === "identity_mismatch" && /ivo@x\.com/.test(e.message));
  assert.deepEqual(Object.keys(store.state.accounts), []);
  assert.equal(fake.count("refresh"), 0);

  // Organização diferente também recusa.
  const l2 = fake.login("caio@x.com", { orgUuid: "org-9" });
  l2.oauthAccount.organizationUuid = "org-1";
  await assert.rejects(engine.storeFreshLogin(l2), (e) => e.code === "identity_mismatch");
  assert.deepEqual(Object.keys(store.state.accounts), []);

  // Perfil indisponível (401): aceita pelo oauthAccount, que veio da própria troca do código.
  const l3 = fake.login("davi@x.com");
  fake.revoke(l3.claudeAiOauth.accessToken);
  assert.deepEqual(await engine.storeFreshLogin(l3), { number: 1, created: true });
  assert.equal(store.state.accounts["1"].email, "davi@x.com");
  assert.ok(logs.some((x) => x.includes("perfil indisponível")));

  // Dados que faltam: invalid_login.
  await assert.rejects(engine.storeFreshLogin({ claudeAiOauth: { refreshToken: "x" }, oauthAccount: { emailAddress: "a@x.com" } }), (e) => e.code === "invalid_login");
  await assert.rejects(engine.storeFreshLogin({ claudeAiOauth: { accessToken: "a", refreshToken: "x" }, oauthAccount: {} }), (e) => e.code === "invalid_login");
  assert.equal(fake.count("refresh"), 0);
});

test("storeFreshLogin: refresh token já gasto → stale_login; cofre sem gravar ou servidor parando → refresh_failed (nada muda)", async (t) => {
  const { engine, fake, store } = setup(t);
  // addLogin renova na hora: o refresh token enviado vira gasto.
  const old = fake.login("ana@x.com");
  await engine.addLogin(old);
  await assert.rejects(engine.storeFreshLogin(old), (e) => e.code === "stale_login");

  // Cofre sem gravar.
  const realSave = store.save.bind(store);
  let failSave = true;
  store.save = () => (failSave ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })) : realSave());
  await engine.saveQuiet();
  const l = fake.login("bia@x.com");
  const p0 = fake.count("profile");
  await assert.rejects(engine.storeFreshLogin(l), (e) => e.code === "refresh_failed" && /cofre/.test(e.message));
  assert.equal(fake.count("profile"), p0, "nem conferiu o perfil");
  assert.equal(store.state.accounts["2"], undefined);
  failSave = false;
  for (const flag of ["lockLost", "closed"]) {
    store[flag] = true;
    await assert.rejects(engine.storeFreshLogin(fake.login("caio@x.com")), (e) => e.code === "refresh_failed", flag);
    store[flag] = false;
  }
  assert.deepEqual(Object.keys(store.state.accounts), ["1"]);

  // stop() durante a conferência do perfil: recusa antes de guardar; stop() espera.
  const g = gate();
  let arrived;
  const seen = new Promise((r) => (arrived = r));
  fake.onProfile = arrived;
  fake.profileGate = g.p;
  const pl = engine.storeFreshLogin(fake.login("davi@x.com"));
  await seen;
  let stopped = false;
  const sp = engine.stop().then(() => (stopped = true));
  await settle();
  assert.equal(stopped, false, "stop() espera o envio em andamento");
  g.open();
  await assert.rejects(pl, (e) => e.code === "refresh_failed" && /reiniciando/.test(e.message));
  await sp;
  assert.deepEqual(Object.keys(store.state.accounts), ["1"]);
  await assert.rejects(engine.storeFreshLogin(fake.login("eva@x.com")), (e) => e.code === "refresh_failed");
  assert.equal(fake.count("refresh"), 1, "só a renovação do addLogin do começo");
});

// ------------------------------------------------------------------ regra "Serviços" (devicePlacement)

test("modelo preferido (Fable): “aproveitar ao máximo” não troca uma conta com Fable por uma sem (caso de 18/11 00:29–00:34)", async (t) => {
  const { engine, fake, store, clock } = setup(t);
  await engine.addLogin(fake.login("sete@x.com")); // conta 1 = a “conta 7” do caso: semanal zera logo, Fable esgotado
  await engine.addLogin(fake.login("nove@x.com")); // conta 2 = a “conta 9”: semanal zera depois, Fable com folga
  const usar = () => {
    setUsage(engine, 1, { session: 7, weekly: 77, weeklyResetIn: 11 * HOUR });
    setUsage(engine, 2, { session: 0, weekly: 16, weeklyResetIn: 4 * DAY });
    store.state.accounts["1"].usage.scoped = [{ name: "Fable", pct: 100, resetsAt: new Date(engine.now() + 11 * HOUR).toISOString() }];
    store.state.accounts["2"].usage.scoped = [{ name: "Fable", pct: 15, resetsAt: new Date(engine.now() + 4 * DAY).toISOString() }];
  };
  usar();
  await engine.setRules({ rules: { strategy: "max", expiringHours: 168, preferModel: "Fable", onModelLimit: "sameAccount", devicePlacement: "together", cooldownMin: 5, sessionPct: 90, weeklyPct: 96, modelPct: 95 } }); // as regras dele
  addDevice(engine, "mac", { models: ["claude-opus-5-5"] });
  addDevice(engine, "win", { models: ["claude-fable-5-2"] });
  await engine.heartbeat("mac", { models: ["claude-opus-5-5"] });
  await engine.heartbeat("win", { models: ["claude-fable-5-2"] });
  const mac = store.state.devices.mac;
  const win = store.state.devices.win;
  assert.deepEqual([mac.assigned, win.assigned], [2, 2], "conta nova: a que tem Fable vem primeiro (mesmo zerando o semanal depois)");
  // Os dois serviços dão sinal a cada minuto (de verdade, a cada 30 s).
  const passar = async (min) => {
    for (let i = 0; i < min; i++) {
      clock.t += 60000;
      usar();
      await engine.heartbeat("mac", { models: ["claude-opus-5-5"] });
      await engine.heartbeat("win", { models: ["claude-fable-5-2"] });
    }
    await engine.tick();
  };

  // Troca manual para a conta sem Fable e de volta para a com Fable (como no Windows às 00:29).
  await engine.switchDevice("win", 1, "manual");
  await passar(6);
  await engine.switchDevice("win", 2, "manual");
  assert.deepEqual([mac.assigned, win.assigned], [2, 2]);
  // Passa o intervalo mínimo (5 min) e bem mais: o servidor não volta para a conta sem Fable.
  await passar(20);
  assert.deepEqual([mac.assigned, win.assigned], [2, 2], `fica na conta com Fable — histórico: ${store.state.history.slice(0, 8).map((h) => h.text).join(" | ")}`);
  assert.equal(store.state.history.some((h) => /para a conta 1: a cota semanal dela zera/.test(h.text)), false);
  assert.equal(engine.bestAccountFor(null), 2);

  // Sem o modelo preferido marcado, “aproveitar ao máximo” vai para a que zera antes (como sempre).
  await engine.setRules({ rules: { preferModel: "" } });
  await passar(1);
  assert.deepEqual([mac.assigned, win.assigned], [1, 1]);
  assert.match(store.state.history[0].text, /para a conta 1: a cota semanal dela zera .* com 23% sobrando/);
  assert.equal(engine.bestAccountFor(null), 1);
});

test("serviços juntos: os ativos ficam na mesma conta (a do topo da fila) e trocam juntos pela linha (modelos de todos)", async (t) => {
  const { engine, fake, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2, { weeklyResetIn: 2 * DAY }); // zera antes: topo da fila
  addDevice(engine, "d1");
  addDevice(engine, "d2");
  await engine.heartbeat("d1", {});
  await engine.heartbeat("d2", {});
  const d1 = store.state.devices.d1;
  const d2 = store.state.devices.d2;
  assert.equal(engine.rulesEffective().devicePlacement, "separate", "padrão");
  assert.deepEqual([d1.assigned, d2.assigned], [2, 1], "Separados (padrão): cada um numa conta");

  // Juntos: vale na hora (sem esperar o ciclo), todos na conta do topo da fila.
  await assert.rejects(engine.setRules({ rules: { devicePlacement: "misturado" } }), (e) => e.code === "invalid_rules");
  const res = await engine.setRules({ rules: { devicePlacement: "together" } });
  assert.equal(res.rules.devicePlacement, "together");
  assert.deepEqual([d1.assigned, d2.assigned], [2, 2]);
  assert.equal(store.state.history[0].text, "Trocou da conta 1 para a conta 2: serviços juntos na mesma conta");
  assert.equal(store.state.history[0].device, "d2");
  assert.equal(store.state.history[1].text, "Serviços juntos: todos na mesma conta (a do topo da fila), trocando juntos");
  assert.equal(engine.stateFor("d1").rules.devicePlacement, "together");

  // O ciclo não separa (nada de "conta ocupada" nem spreadOut).
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [2, 2]);

  // A conta do grupo passou da linha: os dois trocam juntos, num registro só.
  setUsage(engine, 2, { session: 95, weeklyResetIn: 2 * DAY });
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [1, 1]);
  const h = store.state.history[0];
  assert.equal(h.kind, "switch");
  assert.equal(h.device, null);
  assert.equal(h.text, "Serviços trocados juntos para a conta 1: sessão em 95% (linha 90%) — PC d1 e PC d2");
  assert.deepEqual([d1.lastSwitchBy, d2.lastSwitchBy], ["auto", "auto"]);
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [1, 1], "estável");

  // Limite de um modelo ("Trocar de conta para continuar no Fable"): vale mesmo com ninguém no Fable agora
  // (a conversa pode ter ido para o Opus porque o Fable acabou; a ideia é voltar para ele). O grupo troca junto.
  setUsage(engine, 2, { weeklyResetIn: 2 * DAY });
  store.state.accounts["1"].usage.scoped = [{ name: "Fable", pct: 97, resetsAt: null }];
  await engine.setRules({ rules: { onModelLimit: "switchAccount" } });
  d1.models = ["claude-opus-4-5"];
  d2.models = [];
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [2, 2], "Fable na linha: o grupo inteiro troca, mesmo com os dois no Opus");
  assert.equal(store.state.history[0].text, "Serviços trocados juntos para a conta 2: Fable em 97% (linha 95%) — PC d1 e PC d2");
});

test("serviços juntos: limitHit de um serviço troca o grupo inteiro na hora", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1, { session: 40 }); // o dado ainda não mostra o limite
  setUsage(engine, 2);
  await engine.setRules({ rules: { devicePlacement: "together" } });
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchAt: clock.t - MIN, lastSwitchBy: "auto" });
  const d2 = addDevice(engine, "d2", { assigned: 1, lastSeen: clock.t, lastSwitchAt: clock.t - MIN, lastSwitchBy: "auto" });
  const d3 = addDevice(engine, "d3", { assigned: 1, lastSeen: 0 }); // parado: não conta

  const r = await engine.limitHit("d1", "limite da sessão de 5h");
  assert.deepEqual([r.switched, r.to], [true, 2]);
  assert.equal(r.text, "Serviços trocados juntos na hora para a conta 2: a conta 1 bateu o limite da sessão de 5h — PC d1 e PC d2");
  assert.deepEqual([d1.assigned, d2.assigned, d3.assigned], [2, 2, 1]);
  assert.deepEqual([d1.lastSwitchBy, d2.lastSwitchBy], ["limit", "limit"]);
  assert.equal(store.state.history[0].kind, "switch");
  assert.equal(store.state.history[0].device, "d1");
  assert.ok(engine.pollSoon.has(1), "relê o uso da conta que bateu o limite");

  // Sozinho na conta: o texto de sempre.
  d2.lastSeen = 0;
  const r2 = await engine.limitHit("d1", "limite semanal");
  assert.equal(r2.switched, true);
  assert.equal(r2.text, "Trocou na hora da conta 2 para a conta 1: a conta 2 bateu o limite semanal");
  assert.deepEqual([d1.assigned, d2.assigned], [1, 2]);
});

test("serviços juntos: switchDevice (painel ou serviço) troca o grupo inteiro", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  await engine.addLogin(fake.login("caio@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  setUsage(engine, 3);
  await engine.setRules({ rules: { devicePlacement: "together" } });
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "auto" });
  const d2 = addDevice(engine, "d2", { assigned: 1, lastSeen: clock.t, lastSwitchBy: "auto" });
  const d3 = addDevice(engine, "d3", { assigned: 1, lastSeen: 0 }); // parado: fica

  let r = await engine.switchDevice("d1", 3, "painel");
  assert.deepEqual([r.switched, r.from, r.to], [true, 1, 3]);
  assert.equal(r.text, "Serviços trocados juntos para a conta 3: troca manual pelo painel — PC d1 e PC d2");
  assert.deepEqual([d1.assigned, d2.assigned, d3.assigned], [3, 3, 1]);
  assert.deepEqual([d1.lastSwitchBy, d2.lastSwitchBy], ["painel", "group"]);
  assert.equal(store.state.history[0].kind, "switch");
  assert.equal(store.state.history[0].device, "d1");

  // O ciclo não desfaz a escolha.
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [3, 3]);

  // Pelo serviço (extensão).
  r = await engine.switchDevice("d2", 2);
  assert.equal(r.text, "Serviços trocados juntos para a conta 2: troca manual pelo serviço PC d2 — PC d1 e PC d2");
  assert.deepEqual([d1.assigned, d2.assigned], [2, 2]);
  assert.equal(store.state.history[0].kind, "manual");
  assert.equal(store.state.history[0].device, "d2");

  // Melhor conta: sem contas "ocupadas" no modo juntos.
  r = await engine.switchDevice("d1", null);
  assert.equal(r.to, 1);
  assert.equal(r.text, "Serviços trocados juntos para a conta 1: troca manual pelo serviço PC d1 (melhor conta) — PC d1 e PC d2");
  assert.deepEqual([d1.assigned, d2.assigned], [1, 1]);

  r = await engine.switchDevice("d1", 1);
  assert.deepEqual([r.switched, r.text], [false, "já está na conta 1"]);
});

test("serviços juntos: conta não liberada para um serviço nunca é forçada nele", async (t) => {
  const { engine, fake, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  await engine.addLogin(fake.login("caio@x.com"));
  setUsage(engine, 1, { weeklyResetIn: 2 * DAY }); // topo da fila, mas só do d1
  setUsage(engine, 2);
  setUsage(engine, 3);
  await engine.setRules({ rules: { devicePlacement: "together" } });
  const d1 = addDevice(engine, "d1");
  const d2 = addDevice(engine, "d2");
  await engine.setAccountDevices(1, ["d1"]);

  await engine.heartbeat("d1", {});
  await engine.heartbeat("d2", {});
  assert.equal(d1.assigned, 1, "o grupo está na conta do topo da fila");
  assert.equal(d2.assigned, 2, "o d2 não pode usar a 1: fica com a melhor liberada para ele");
  assert.equal((await engine.credentialFor("d2")).number, 2);
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [1, 2]);

  // A conta do grupo passou da linha: vai para uma que os dois podem usar; o d2 já está nela.
  setUsage(engine, 1, { session: 95, weeklyResetIn: 2 * DAY });
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [2, 2]);
  assert.equal(store.state.history[0].text, "Trocou da conta 1 para a conta 2: sessão em 95% (linha 90%)");

  // Troca manual do grupo para a 1: só o d1 vai; o d2 fica (e não consegue trocar para ela).
  setUsage(engine, 1, { weeklyResetIn: 2 * DAY });
  const r = await engine.switchDevice("d1", 1);
  assert.deepEqual([r.switched, r.text], [true, "Troca manual da conta 2 para a conta 1"]);
  assert.deepEqual([d1.assigned, d2.assigned], [1, 2]);
  await assert.rejects(engine.switchDevice("d2", 1), (e) => e.code === "not_allowed");
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [1, 2], "o ciclo também não força a 1 no d2");
  assert.ok(!store.state.history.some((h) => h.device === "d2" && /para a conta 1\b/.test(h.text)));
});

test("serviços juntos: quem volta a ficar ativo entra na conta do grupo; Separados volta a separar", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  await engine.addLogin(fake.login("caio@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  setUsage(engine, 3);
  await engine.setRules({ rules: { devicePlacement: "together" } });
  const d1 = addDevice(engine, "d1", { assigned: 2, lastSeen: clock.t, lastSwitchAt: clock.t - 10 * MIN, lastSwitchBy: "auto" });
  // Parado há 30 min, com uma troca mais nova que a do d1: ao voltar, entra no grupo (não puxa o grupo para a 3).
  const d2 = addDevice(engine, "d2", { assigned: 3, lastSeen: clock.t - 30 * MIN, lastSwitchAt: clock.t - MIN, lastSwitchBy: "auto" });
  await engine.heartbeat("d2", {});
  assert.deepEqual([d1.assigned, d2.assigned], [2, 2]);
  assert.equal(store.state.history[0].text, "Trocou da conta 3 para a conta 2: serviços juntos na mesma conta");
  assert.equal(store.state.history[0].device, "d2");

  // Serviço novo também entra na conta do grupo.
  const d3 = addDevice(engine, "d3");
  await engine.heartbeat("d3", {});
  assert.equal(d3.assigned, 2);
  assert.equal(store.state.history[0].text, "Conta 2 atribuída a PC d3");
  d3.lastSeen = 0; // desconectou

  // Separados (com intervalo mínimo 0 para não esperar): o que chegou por último sai da conta dividida.
  await engine.setRules({ rules: { devicePlacement: "separate", cooldownMin: 0 } });
  assert.equal(d1.assigned, 2);
  assert.equal(d2.assigned, 1);
  assert.match(store.state.history[0].text, /^Trocou da conta 2 para a conta 1: a conta 2 já está em uso em PC d1$/);
  assert.ok(store.state.history.some((h) => h.text === "Serviços separados: cada um na sua conta"));
  await engine.tick();
  assert.deepEqual([d1.assigned, d2.assigned], [2, 1], "estável, cada um na sua");
});

// ------------------------------------------------------------------ avisos por e-mail ao dono (notify)

/** Avisos de mentira: guarda o que o motor mandou (o notify.js de verdade tem os testes dele em notify.test.js). */
function noticeSpy() {
  const sent = [];
  const fn = (n) => {
    sent.push(n);
    return fn.fail ? { ok: false, error: "ENOSPC" } : { ok: true, id: `aviso-${sent.length}` };
  };
  fn.sent = sent;
  fn.fail = false; // true = a gravação do aviso falha (ex.: disco cheio)
  return fn;
}

const RENEW = (n, email) =>
  `Para renovar: abra https://swap.exemplo.com → Contas → conta ${n} → Entrar de novo, e entre com ${email} na página da Claude; ` +
  "copie o código e cole no painel. (Ou faça /login no Claude Code de um serviço do administrador.)";

/** O próximo horário marcado do resumo semanal (dia da semana e hora LOCAIS) depois de `from`. */
function nextWeekly(from, day = 1, hour = 8) {
  const d = new Date(from);
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour, 0, 0, 0);
  while (x.getDay() !== day || x.getTime() <= from) x.setDate(x.getDate() + 1);
  return x.getTime();
}

test("avisos por e-mail: login que vence → UM aviso por login, quando falta menos de 1 dia; o histórico avisa desde 3 dias antes", async (t) => {
  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify, env: { PUBLIC_URL: "https://swap.exemplo.com/", NOTICE_WEEKLY: "0" } });
  const END = START + 4 * DAY;
  const END2 = END + 2 * MIN;
  const l1 = fake.login("ana@x.com");
  l1.claudeAiOauth.refreshTokenExpiresAt = END;
  await engine.addLogin(l1);
  const l2 = fake.login("bia@x.com");
  l2.claudeAiOauth.refreshTokenExpiresAt = END2;
  await engine.addLogin(l2);
  await engine.addLogin(fake.login("caio@x.com")); // sem a data: nunca avisa
  await engine.updateAccount(1, { alias: "Trabalho" });
  const expiring = () => notify.sent.filter((n) => /^Swap Plus: login da conta \d+ vence/.test(n.subject));
  const historyAlerts = () => store.state.history.filter((h) => h.kind === "alert" && h.text.includes(") vence"));

  await engine.tick();
  assert.equal(notify.sent.length, 0, "faltam 4 dias: nada");

  clock.t = END - 3 * DAY + MIN; // conta 1: faltam menos de 3 dias → só o histórico (e o painel)
  await engine.tick();
  assert.equal(historyAlerts().length, 1);
  assert.equal(expiring().length, 0, "o e-mail só sai no último dia");

  clock.t = END - DAY - MIN; // ainda falta mais de 1 dia
  await engine.tick();
  assert.equal(expiring().length, 0);

  clock.t = END - DAY + MIN; // conta 1: falta menos de 1 dia; a conta 2 vence 2 min depois, ainda não
  await engine.tick();
  assert.equal(expiring().length, 1);
  const [n1] = expiring();
  assert.equal(n1.subject, `Swap Plus: login da conta 1 vence ${dayTime(END)}`);
  assert.ok(n1.text.startsWith(`O login da conta 1 (apelido “Trabalho”, e-mail ana@x.com) no Swap Plus vence em ${dayTime(END)} (faltam `), n1.text);
  assert.ok(n1.text.includes("Depois disso o servidor não consegue mais renovar o acesso dela, e os serviços deixam de usá-la.\n\n"), n1.text);
  assert.ok(n1.text.includes(RENEW(1, "ana@x.com")), n1.text);
  assert.deepEqual(Object.keys(n1).sort(), ["subject", "text"]);
  assert.equal(store.state.accounts["1"].loginMailedFor, END, "o vencimento avisado fica na conta (vai para o cofre)");

  // Não repete: nem nos ciclos seguintes, nem depois.
  clock.t += 30 * SEC;
  await engine.tick();
  await engine.tick();
  assert.equal(expiring().length, 1);

  // A conta 2 entra no último dia dela: o aviso dela (um por conta).
  clock.t += 2 * MIN;
  await engine.tick();
  assert.equal(expiring().length, 2);
  assert.equal(expiring()[1].subject, `Swap Plus: login da conta 2 vence ${dayTime(END2)}`);
  assert.ok(expiring()[1].text.startsWith("O login da conta 2 (e-mail bia@x.com) no Swap Plus vence em"), expiring()[1].text);
  assert.ok(expiring()[1].text.includes(RENEW(2, "bia@x.com")));
  clock.t += 6 * HOUR;
  await engine.tick();
  await engine.tick();
  assert.equal(expiring().length, 2, "um aviso por login, não um por dia");
  assert.ok(!notify.sent.some((n) => n.subject.includes("conta 3")), "conta sem data conhecida nunca avisa");
  assert.ok(!notify.sent.some((n) => /nesta semana/.test(n.subject)), "NOTICE_WEEKLY=0: sem resumo semanal");
});

test("avisos por e-mail: aviso do último dia que não gravou é tentado de novo em 10 min; data nova avisa de novo; conta morta não avisa", async (t) => {
  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify, env: { PUBLIC_URL: "https://swap.exemplo.com", NOTICE_WEEKLY: "0" } });
  const END = START + 2 * DAY;
  const l1 = fake.login("ana@x.com");
  l1.claudeAiOauth.refreshTokenExpiresAt = END;
  await engine.addLogin(l1);
  const l2 = fake.login("bia@x.com");
  l2.claudeAiOauth.refreshTokenExpiresAt = END;
  await engine.addLogin(l2);
  const de = (n) => notify.sent.filter((x) => x.subject.startsWith(`Swap Plus: login da conta ${n} vence`));

  // A conta 2 morre antes do último dia: o aviso dela é o de "parou de valer", não o de "vence".
  fake.refreshFail.set("bia@x.com", "invalid_grant");
  assert.equal((await engine.refreshAccount(2, { minValidMs: Infinity })).error, "invalid_grant");

  notify.fail = true; // a caixa de saída não grava (disco cheio)
  clock.t = END - DAY + MIN;
  await engine.tick();
  assert.equal(de(1).length, 1, "tentou");
  assert.equal(store.state.accounts["1"].loginMailedFor, undefined, "não gravou: não marca como avisado");
  clock.t += MIN;
  await engine.tick();
  assert.equal(de(1).length, 1, "não insiste a cada ciclo");
  notify.fail = false;
  clock.t += 10 * MIN;
  await engine.tick();
  assert.equal(de(1).length, 2, "tentou de novo depois de 10 min");
  assert.equal(store.state.accounts["1"].loginMailedFor, END);
  await engine.tick();
  assert.equal(de(1).length, 2);
  assert.equal(de(2).length, 0, "conta morta não avisa que vence");

  // O dono renovou o login (data nova): o aviso vale de novo para o vencimento novo.
  const NOVO = clock.t + 20 * DAY;
  await engine.setLoginExpiresAt(1, NOVO);
  await engine.tick();
  assert.equal(de(1).length, 2, "faltam 20 dias: nada");
  clock.t = NOVO - DAY + MIN;
  await engine.tick();
  assert.equal(de(1).length, 3);
  assert.equal(de(1)[2].subject, `Swap Plus: login da conta 1 vence ${dayTime(NOVO)}`);
});

test("resumo semanal: uma vez por semana no horário marcado, com as contas que vencem em 7 dias, as paradas e as sem data", async (t) => {
  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify, env: { PUBLIC_URL: "https://swap.exemplo.com" } });
  const DUE = nextWeekly(START); // a próxima segunda, 8h (hora do servidor)
  const EXP1 = DUE + 3 * DAY;
  const l1 = fake.login("ana@x.com");
  l1.claudeAiOauth.refreshTokenExpiresAt = EXP1;
  await engine.addLogin(l1);
  const l2 = fake.login("bia@x.com");
  l2.claudeAiOauth.refreshTokenExpiresAt = DUE + 10 * DAY; // fora dos 7 dias
  await engine.addLogin(l2);
  await engine.addLogin(fake.login("caio@x.com")); // sem data
  await engine.addLogin(fake.login("dora@x.com"));
  fake.refreshFail.set("dora@x.com", "invalid_grant");
  assert.equal((await engine.refreshAccount(4, { minValidMs: Infinity })).error, "invalid_grant");
  const weekly = () => notify.sent.filter((n) => /nesta semana/.test(n.subject));

  await engine.tick();
  assert.equal(weekly().length, 0, "primeira vez: só começa a contar");
  assert.equal(store.state.weeklyNoticeAt, START);

  clock.t = DUE - MIN;
  await engine.tick();
  assert.equal(weekly().length, 0, "antes da hora marcada");

  clock.t = DUE + MIN;
  await engine.tick();
  assert.equal(weekly().length, 1);
  const [w] = weekly();
  assert.equal(w.subject, `Swap Plus: 1 conta vence nesta semana (conta 1, ${dayTime(EXP1)})`);
  assert.ok(w.text.includes(`- conta 1 (e-mail ana@x.com): vence ${dayTime(EXP1)} (faltam `), w.text);
  assert.ok(!w.text.includes("conta 2"), "a conta 2 vence depois dos 7 dias");
  assert.ok(w.text.includes("Já parou de valer (precisa de login novo agora):\n- conta 4 (e-mail dora@x.com)"), w.text);
  assert.ok(w.text.includes("Sem data de vencimento conhecida (o servidor não tem como avisar desta): conta 3."), w.text);
  assert.ok(w.text.includes("Você recebe outro aviso de cada conta quando faltar menos de 1 dia para ela vencer."), w.text);
  assert.ok(w.text.includes("Para renovar: abra https://swap.exemplo.com → Contas → a conta → Entrar de novo"), w.text);
  assert.deepEqual(Object.keys(w).sort(), ["subject", "text"]);
  assert.equal(store.state.weeklyNoticeAt, DUE + MIN, "o instante do resumo fica no cofre");

  // Não repete na mesma semana.
  await engine.tick();
  clock.t += DAY;
  await engine.tick();
  clock.t = DUE + 7 * DAY - MIN;
  await engine.tick();
  assert.equal(weekly().length, 1);

  // Semana seguinte: de novo. Agora quem vence em 7 dias é a conta 2 (a 1 já passou da data).
  clock.t = nextWeekly(DUE + MIN) + MIN;
  await engine.tick();
  assert.equal(weekly().length, 2);
  assert.ok(weekly()[1].text.includes("- conta 2 (e-mail bia@x.com): vence "), weekly()[1].text);
});

test("resumo semanal: servidor parado na hora manda ao voltar (uma vez só); falha tenta de novo em 10 min; sem contas vencendo diz isso; dia e hora configuráveis", async (t) => {
  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify, env: { NOTICE_WEEKLY_DAY: "5", NOTICE_WEEKLY_HOUR: "18" } });
  await engine.addLogin(fake.login("ana@x.com")); // sem data
  const weekly = () => notify.sent.filter((n) => /nesta semana/.test(n.subject));
  const DUE = nextWeekly(START, 5, 18); // sexta, 18h
  await engine.tick();

  const SEGUNDA = nextWeekly(START, 1, 8) + MIN; // segunda 8h não é o horário marcado deste servidor
  if (SEGUNDA < DUE) {
    clock.t = SEGUNDA;
    await engine.tick();
    assert.equal(weekly().length, 0);
  }

  // O servidor ficou parado na sexta às 18h e voltou 2 dias depois: manda ao voltar. Mas a caixa de saída falha...
  notify.fail = true;
  clock.t = DUE + 2 * DAY;
  await engine.tick();
  assert.equal(weekly().length, 1, "tentou");
  assert.equal(store.state.weeklyNoticeAt, START, "não gravou: a marca não anda");
  clock.t += MIN;
  await engine.tick();
  assert.equal(weekly().length, 1, "não insiste a cada ciclo");
  notify.fail = false;
  clock.t += 10 * MIN;
  await engine.tick();
  assert.equal(weekly().length, 2);
  assert.equal(weekly()[1].subject, "Swap Plus: nenhuma conta vence nesta semana");
  assert.ok(weekly()[1].text.includes("Nenhuma conta vence nos próximos 7 dias."), weekly()[1].text);
  assert.ok(weekly()[1].text.includes("Sem data de vencimento conhecida"), weekly()[1].text);
  assert.ok(!weekly()[1].text.includes("Para renovar"), "nada a renovar: sem a instrução");
  await engine.tick();
  clock.t += DAY;
  await engine.tick();
  assert.equal(weekly().length, 2, "uma vez só por horário marcado");
});

test("resumo semanal: sem avisos configurados não faz nada; weeklySummary e noticeWeekly servem ao comando do admin", async (t) => {
  const semAvisos = setup(t, {});
  await semAvisos.engine.addLogin(semAvisos.fake.login("ana@x.com"));
  semAvisos.clock.t = nextWeekly(START) + MIN;
  await semAvisos.engine.tick();
  assert.equal(semAvisos.store.state.weeklyNoticeAt, undefined);
  assert.equal(semAvisos.engine.noticeWeekly().result, null, "sem notify: nada é enviado");

  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify });
  const l1 = fake.login("ana@x.com");
  l1.claudeAiOauth.refreshTokenExpiresAt = START + 2 * DAY;
  await engine.addLogin(l1);
  const l2 = fake.login("bia@x.com");
  l2.claudeAiOauth.refreshTokenExpiresAt = START + DAY;
  await engine.addLogin(l2);
  const s = engine.weeklySummary();
  assert.deepEqual(s.expiring, [2, 1], "a que vence antes vem primeiro");
  assert.equal(s.subject, "Swap Plus: 2 contas vencem nesta semana");
  assert.equal(notify.sent.length, 0, "weeklySummary só monta o texto");
  const r = engine.noticeWeekly();
  assert.equal(r.result.ok, true);
  assert.equal(notify.sent.length, 1);
  assert.equal(notify.sent[0].subject, s.subject);
  assert.equal(store.state.weeklyNoticeAt, undefined, "mandar à mão não mexe na marca do resumo automático");
  assert.equal(clock.t, START);
});

test("avisos por e-mail: conta que morre → 1 aviso na hora, com o motivo; morte depois de renovação sem resposta diz isso", async (t) => {
  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify, env: { PUBLIC_URL: "https://swap.exemplo.com" } });
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  store.state.diag.oldTokenValidAfterRefresh = true;
  const dead = () => notify.sent.filter((n) => / parou de valer$/.test(n.subject));

  fake.refreshFail.set("ana@x.com", "invalid_grant");
  assert.equal((await engine.refreshAccount(1, { minValidMs: Infinity })).error, "invalid_grant");
  assert.equal(dead().length, 1);
  const [d1] = dead();
  assert.equal(d1.subject, "Swap Plus: o login da conta 1 parou de valer");
  assert.ok(d1.text.startsWith(`O login da conta 1 (e-mail ana@x.com) parou de valer em ${dayTime(clock.t)}.`), d1.text);
  assert.match(d1.text, /Motivo: a Anthropic recusou a renovação/);
  assert.ok(!d1.text.includes("ficou sem resposta"));
  assert.ok(d1.text.includes("O servidor não renova mais esta conta, e os serviços que estavam nela passam para outra.\n\n"), d1.text);
  assert.ok(d1.text.includes(RENEW(1, "ana@x.com")), d1.text);

  // Já morta: nada de novo (nem renovando, nem no ciclo, nem marcando de novo).
  assert.equal((await engine.refreshAccount(1, { minValidMs: Infinity })).error, "dead");
  engine.markDead(store.state.accounts["1"]);
  clock.t += 7 * HOUR;
  await engine.tick(); // a conta 2 renova normalmente
  assert.equal(dead().length, 1);

  // Conta 2: renovação sem resposta que gastou o login → invalid_grant confirmado → morta com cause "no_response".
  clock.t += 7 * HOUR;
  fake.refreshFail.set("bia@x.com", "lost");
  await engine.tick();
  fake.refreshFail.delete("bia@x.com");
  clock.t += 15 * SEC;
  await engine.tick(); // invalid_grant logo depois: ainda confirma
  assert.equal(store.state.accounts["2"].dead, null);
  assert.equal(dead().length, 1);
  clock.t += 2 * MIN;
  await engine.tick();
  assert.equal(store.state.accounts["2"].dead.cause, "no_response");
  assert.equal(dead().length, 2);
  const d2 = dead()[1];
  assert.equal(d2.subject, "Swap Plus: o login da conta 2 parou de valer");
  assert.match(d2.text, /Motivo: a renovação anterior ficou sem resposta/);
  assert.ok(d2.text.includes(RENEW(2, "bia@x.com")));
  await engine.tick();
  assert.equal(dead().length, 2);
});

test("avisos por e-mail: cofre que para de gravar → 1 aviso por incidente; volta a gravar e para de novo → avisa de novo (no máximo 1 por hora)", async (t) => {
  const notify = noticeSpy();
  const { engine, fake, clock, store } = setup(t, { notify });
  await engine.addLogin(fake.login("ana@x.com"));
  const realSave = store.save.bind(store);
  let failSave = true;
  store.save = () => (failSave ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })) : realSave());
  const saveNotices = () => notify.sent.filter((n) => n.subject.startsWith("Swap Plus: o cofre não está gravando"));

  clock.t += 7 * HOUR;
  assert.deepEqual(await engine.refreshAccount(1), { ok: false, error: "save_failed" });
  assert.equal(engine.saveFailed, true);
  assert.equal(saveNotices().length, 1, "aviso na hora");
  const [n] = saveNotices();
  assert.equal(n.subject, "Swap Plus: o cofre não está gravando — NÃO reinicie o servidor");
  assert.match(n.text, /NÃO reinicie o servidor: há login renovado só na memória/);
  assert.match(n.text, /ENOSPC: no space left on device/);
  assert.match(n.text, /Veja o disco do servidor/);
  assert.match(n.text, new RegExp(`desde ${dayTime(clock.t)}`));

  // O mesmo incidente (ciclos que não gravam, renovação recusada): nada de novo.
  for (let i = 0; i < 5; i++) {
    clock.t += 2 * MIN;
    await engine.tick();
  }
  assert.deepEqual(await engine.refreshAccount(1, { minValidMs: Infinity }), { ok: false, error: "save_failed" });
  assert.equal(saveNotices().length, 1);

  // Voltou a gravar: fim do incidente.
  failSave = false;
  await engine.tick();
  assert.equal(engine.saveFailed, false);
  assert.equal(saveNotices().length, 1);

  // Parou de novo 20 min depois do aviso (vai e volta): não repete dentro de 1 h.
  failSave = true;
  engine.dirty = true;
  clock.t += 10 * MIN;
  await engine.tick();
  assert.equal(engine.saveFailed, true);
  assert.equal(saveNotices().length, 1);
  failSave = false;
  await engine.tick();
  assert.equal(engine.saveFailed, false);

  // Incidente novo, mais de 1 h depois: avisa de novo, uma vez.
  clock.t += 2 * HOUR;
  failSave = true;
  engine.dirty = true;
  await engine.tick();
  await engine.tick();
  assert.equal(engine.saveFailed, true);
  assert.equal(saveNotices().length, 2);
  failSave = false;
  await engine.tick();
  assert.equal(engine.saveFailed, false);
  assert.equal(notify.sent.length, 2, "nenhum outro aviso");
});

test("avisos por e-mail: aviso de cofre sem gravar que não deu para gravar (disco cheio) é tentado de novo a cada minuto até sair", async (t) => {
  const notify = noticeSpy();
  notify.fail = true;
  const { engine, clock, store } = setup(t, { notify });
  const realSave = store.save.bind(store);
  let failSave = true;
  store.save = () => (failSave ? Promise.reject(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })) : realSave());

  engine.dirty = true;
  await engine.tick();
  assert.equal(engine.saveFailed, true);
  assert.equal(notify.sent.length, 1, "tentou");
  clock.t += 30 * SEC;
  await engine.tick();
  assert.equal(notify.sent.length, 1, "espera 1 min antes de tentar de novo");
  clock.t += 31 * SEC;
  await engine.tick();
  assert.equal(notify.sent.length, 2);
  notify.fail = false;
  clock.t += 61 * SEC;
  await engine.tick();
  assert.equal(notify.sent.length, 3, "saiu");
  clock.t += 5 * MIN;
  await engine.tick();
  await engine.tick();
  assert.equal(notify.sent.length, 3, "saiu uma vez: não repete");
  failSave = false;
  await engine.tick();
  assert.equal(engine.saveFailed, false);
});

test("avisos por e-mail com o notify.js de verdade: o aviso vira arquivo em DATA_DIR/avisos; NOTICES_ENABLED=0 não grava nada", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-avisos-motor-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const folder = path.join(dataDir, "avisos");
  const quiet = { info() {}, warn() {}, error() {}, log() {} };
  let real = null;
  const { engine, fake, clock, store } = setup(t, { notify: (n) => real(n), env: { PUBLIC_URL: "https://swap.exemplo.com" } });
  real = createNotifier({ dir: dataDir, env: {}, now: () => clock.t, log: quiet });
  await engine.addLogin(fake.login("ana@x.com"));
  fake.refreshFail.set("ana@x.com", "invalid_grant");
  await engine.refreshAccount(1, { minValidMs: Infinity });

  const files = fs.readdirSync(folder);
  assert.equal(files.length, 1);
  assert.match(files[0], /^aviso-\d{8}-\d{6}-[0-9a-f]{8}\.json$/);
  const obj = JSON.parse(fs.readFileSync(path.join(folder, files[0]), "utf8"));
  assert.deepEqual(Object.keys(obj), ["id", "assunto", "texto", "criado_em"]);
  assert.equal(`${obj.id}.json`, files[0]);
  assert.equal(obj.assunto, "Swap Plus: o login da conta 1 parou de valer");
  assert.equal(obj.criado_em, Math.floor(clock.t / 1000));
  assert.ok(obj.texto.includes(RENEW(1, "ana@x.com")), obj.texto);
  assert.ok(Array.from(obj.texto).length <= 2000);
  assert.equal(engine.status().notices.enabled, true);

  // Desligado (NOTICES_ENABLED=0): o motor segue igual e nada vai para a pasta.
  real = createNotifier({ dir: dataDir, env: { NOTICES_ENABLED: "0" }, now: () => clock.t, log: quiet });
  await engine.addLogin(fake.login("bia@x.com"));
  fake.refreshFail.set("bia@x.com", "invalid_grant");
  await engine.refreshAccount(2, { minValidMs: Infinity });
  assert.ok(store.state.accounts["2"].dead);
  assert.deepEqual(fs.readdirSync(folder), files);

  // status() diz se os avisos estão ligados e onde ficam.
  const off = setup(t, { notify: createNotifier({ dir: dataDir, env: { NOTICES_ENABLED: "0" } }) }).engine;
  assert.deepEqual(off.status().notices, { enabled: false, dir: folder });
  const on = setup(t, { notify: createNotifier({ dir: dataDir, env: {} }) }).engine;
  assert.deepEqual(on.status().notices, { enabled: true, dir: folder });
  assert.deepEqual(setup(t).engine.status().notices, { enabled: false, dir: null }, "sem notify: desligado");
});

test("textos do motor para quem não tem registro ou não tem conta: “serviço desconhecido” e “nenhuma conta atribuída a este serviço”", async (t) => {
  const { engine } = setup(t);
  await assert.rejects(engine.heartbeat("nao-existe", {}), (e) => e.code === "unknown_device" && ERROR_STATUS[e.code] === 404 && e.message === "serviço desconhecido");
  addDevice(engine, "d1");
  assert.deepEqual(await engine.limitHit("d1", "limite semanal"), { switched: false, text: "nenhuma conta atribuída a este serviço" });
});

// ------------------------------------------------------------------ presença dos serviços (ativo / conectado / aguardando contato / sem contato)

/** Os campos de presença do serviço `id` na lista do motor (a mesma do painel e do GET /v1/state). */
function presenceRow(engine, id) {
  const d = engine.devicesList().find((x) => x.id === id);
  return { active: d.active, connected: d.connected, presence: d.presence, lastContact: d.lastContact };
}

test("presença: touch (um pedido autenticado qualquer) deixa o serviço conectado — sem ativar, sem sujar o motor e sem ir para o cofre", async (t) => {
  const { engine, fake, clock, store, disk } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const d1 = addDevice(engine, "d1", { assigned: 1, lastSeen: clock.t - HOUR }); // usou há 1 h
  addDevice(engine, "d2"); // nunca apareceu (lastSeen 0)
  clock.t += 10 * MIN; // o servidor já está no ar há mais de 5 min: ninguém está só "aguardando contato"
  await engine.save();
  const before = JSON.stringify(disk());
  const mem = JSON.stringify(store.state);
  assert.deepEqual(presenceRow(engine, "d1"), { active: false, connected: false, presence: "none", lastContact: d1.lastSeen });
  assert.deepEqual(presenceRow(engine, "d2"), { active: false, connected: false, presence: "none", lastContact: null });

  engine.touch("d1");
  assert.equal(engine.dirty, false, "o contato não suja o cofre");
  assert.equal(JSON.stringify(store.state), mem, "nem escreve no registro do serviço (o lastSeen fica como estava)");
  assert.deepEqual(presenceRow(engine, "d1"), { active: false, connected: true, presence: "connected", lastContact: clock.t });
  assert.equal(engine.isActive(d1), false, "contato não é uso: o serviço não conta como ativo");
  assert.equal(engine.status().activeDevices, 0);
  const mine = engine.stateFor("d1").devices.find((x) => x.id === "d1");
  assert.deepEqual([mine.active, mine.connected, mine.presence, mine.lastContact], [false, true, "connected", clock.t], "o StateResponse leva os mesmos campos");

  // Gravar o cofre inteiro de novo: nada do contato vai junto.
  await store.save();
  assert.equal(JSON.stringify(disk()), before);
  assert.ok(!/contact|presence/i.test(JSON.stringify(disk())), "nenhum campo de contato ou presença no disco");

  // Só de serviço que existe (o mapa não cresce com lixo); desconectado, o contato sai da memória.
  engine.touch("nao-existe");
  engine.touch(null);
  engine.touch(42);
  assert.deepEqual([...engine.contacts.keys()], ["d1"]);
  engine.forgetContact("d1");
  engine.forgetContact("nao-existe");
  assert.equal(engine.contacts.size, 0);
  assert.deepEqual(presenceRow(engine, "d1"), { active: false, connected: false, presence: "none", lastContact: d1.lastSeen });
});

test("presença: serviço só conectado (sem batimento) não ocupa conta e segue fora das decisões, como quem está sem contato", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  await engine.addLogin(fake.login("bia@x.com"));
  setUsage(engine, 1);
  setUsage(engine, 2);
  const d1 = addDevice(engine, "d1", { name: "Mac", assigned: 1, lastSeen: clock.t, lastSwitchBy: "manual" }); // em uso
  const d2 = addDevice(engine, "d2", { name: "Hermes", assigned: 2, lastSeen: clock.t - HOUR }); // ocioso: só lê o estado
  const idleSince = d2.lastSeen;
  engine.touch("d2");
  assert.equal(presenceRow(engine, "d1").presence, "active");
  assert.equal(presenceRow(engine, "d2").presence, "connected");

  // Para as decisões ele não está em uso: a conta dele não fica ocupada nem conta como "conta de serviço ativo".
  assert.deepEqual([...engine.othersAccounts("d1")], [], "a conta 2 (do Hermes ocioso) continua livre para o Mac");
  assert.deepEqual([...engine.activeAccountNumbers()], [1]);
  assert.equal(engine.status().activeDevices, 1);

  // Os ciclos decidem só para os ativos: nada muda para o conectado, mesmo com os contatos chegando.
  const h0 = store.state.history.length;
  for (let i = 0; i < 3; i++) {
    clock.t += 2 * MIN;
    d1.lastSeen = clock.t; // o Mac segue em uso (batimento)
    engine.touch("d2"); // o Hermes só lê o estado
    await engine.tick();
  }
  assert.deepEqual([d1.assigned, d2.assigned], [1, 2]);
  assert.equal(store.state.history.length, h0, "nada no histórico");
  assert.equal(d2.lastSeen, idleSince, "os contatos não mexem no lastSeen");
  assert.equal(presenceRow(engine, "d2").presence, "connected");

  // Perdeu a permissão da conta em que estava: um ativo trocaria na hora; o conectado só fica sem conta e recebe
  // outra quando voltar a usar (igual a quem está sem contato).
  await engine.setAccountDevices(2, ["d1"]);
  assert.equal(d2.assigned, null);
  assert.ok(!store.state.history.some((h) => h.device === "d2" && h.kind === "switch"), "não houve troca na hora");
  engine.touch("d2");
  assert.equal(d2.assigned, null, "contato não atribui conta: isso é do batimento (ou do pedido da credencial)");
  assert.equal((await engine.heartbeat("d2", {})).device.assigned, 1);
  assert.equal(presenceRow(engine, "d2").presence, "active");
});

test("presença: batimento → ativo; depois só contatos a cada 2 min → conectado (sem buraco na passagem); silêncio → sem contato", async (t) => {
  const { engine, fake, clock } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  const d1 = addDevice(engine, "d1");
  clock.t += 10 * MIN; // o servidor já está no ar há mais de 5 min
  assert.deepEqual(presenceRow(engine, "d1"), { active: false, connected: false, presence: "none", lastContact: null }, "ainda não apareceu");

  await engine.heartbeat("d1", {});
  const beat = clock.t;
  assert.deepEqual(presenceRow(engine, "d1"), { active: true, connected: true, presence: "active", lastContact: beat });

  // O uso acabou: daqui em diante o serviço só lê o estado, a cada 2 min (como o cliente do Hermes ocioso).
  const seen = [];
  let last = beat;
  for (let min = 1; min <= 20; min++) {
    clock.t += MIN;
    if (min % 2 === 0) {
      engine.touch("d1");
      last = clock.t;
    }
    const p = presenceRow(engine, "d1");
    assert.equal(p.lastContact, last, `minuto ${min}`);
    assert.equal(p.connected, true, `minuto ${min}: enquanto os contatos chegam, nunca fica "sem contato"`);
    seen.push(p.presence);
  }
  assert.deepEqual(seen, [...Array(5).fill("active"), ...Array(15).fill("connected")], "ativo até 5 min depois do batimento; daí em diante, conectado");
  assert.equal(d1.lastSeen, beat, "os contatos não mexem no lastSeen");

  // Silêncio: até 5 min depois do último contato ainda conta; passou disso, sem contato (com a hora do último).
  clock.t = last + 5 * MIN;
  assert.equal(presenceRow(engine, "d1").presence, "connected");
  clock.t += 1;
  assert.deepEqual(presenceRow(engine, "d1"), { active: false, connected: false, presence: "none", lastContact: last });

  // Voltou a usar: ativo de novo.
  await engine.heartbeat("d1", {});
  assert.deepEqual(presenceRow(engine, "d1"), { active: true, connected: true, presence: "active", lastContact: clock.t });
});

test("presença: depois de um reinício (motor novo no mesmo cofre) o contato recomeça do lastSeen; quem ainda não chamou fica “aguardando contato” por 5 min", async (t) => {
  const { engine, fake, clock, store } = setup(t);
  await engine.addLogin(fake.login("ana@x.com"));
  clock.t += HOUR;
  const idle = addDevice(engine, "ocioso", { lastSeen: clock.t - 30 * MIN }); // usou há 30 min; desde então só lê o estado
  const busy = addDevice(engine, "em-uso", { lastSeen: clock.t - MIN }); // batimento há 1 min
  const gone = addDevice(engine, "sumido", { lastSeen: clock.t - 3 * DAY }); // não fala com o servidor há dias
  addDevice(engine, "novo"); // nunca apareceu
  engine.touch("ocioso");
  assert.equal(presenceRow(engine, "ocioso").presence, "connected");
  assert.equal(presenceRow(engine, "sumido").presence, "none");
  await engine.save();

  // Reinício: os contatos estavam só na memória.
  clock.t += 20 * SEC;
  const boot = clock.t;
  const quiet = { info() {}, warn() {}, error() {}, log() {} };
  const e2 = new Engine({ store, anthropic: engine.anthropic, now: () => clock.t, log: quiet, env: {} });
  assert.deepEqual(presenceRow(e2, "ocioso"), { active: false, connected: false, presence: "waiting", lastContact: idle.lastSeen });
  assert.deepEqual(presenceRow(e2, "em-uso"), { active: true, connected: true, presence: "active", lastContact: busy.lastSeen });
  assert.deepEqual(presenceRow(e2, "sumido"), { active: false, connected: false, presence: "waiting", lastContact: gone.lastSeen }, "o servidor ainda não tem como saber: espera");
  assert.deepEqual(presenceRow(e2, "novo"), { active: false, connected: false, presence: "waiting", lastContact: null });

  // O ocioso lê o estado de 2 em 2 min: volta a "conectado" no primeiro pedido depois do reinício.
  clock.t = boot + 2 * MIN;
  e2.touch("ocioso");
  assert.deepEqual(presenceRow(e2, "ocioso"), { active: false, connected: true, presence: "connected", lastContact: clock.t });

  // O que estava em uso e parou sem chamar de novo deixa de ser ativo e, nos 5 min do reinício, também espera.
  clock.t = boot + 4 * MIN + 30 * SEC; // batimento há 5 min 50 s
  assert.equal(presenceRow(e2, "em-uso").presence, "waiting");

  // 5 min depois de subir, quem não chamou está sem contato.
  clock.t = boot + 5 * MIN - 1;
  assert.equal(presenceRow(e2, "sumido").presence, "waiting");
  clock.t = boot + 5 * MIN;
  assert.deepEqual(presenceRow(e2, "sumido"), { active: false, connected: false, presence: "none", lastContact: gone.lastSeen });
  assert.deepEqual(presenceRow(e2, "novo"), { active: false, connected: false, presence: "none", lastContact: null });
  assert.equal(presenceRow(e2, "em-uso").presence, "none");
  assert.equal(presenceRow(e2, "ocioso").presence, "connected", "o contato dele foi há 3 min");
});
