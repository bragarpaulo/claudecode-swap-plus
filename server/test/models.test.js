"use strict";
// Testes do catálogo de modelos e das regras "modelo preferido / modelo secundário" (2.6.0):
//   - anthropic.js: models() — o pedido que sai e o que volta normalizado;
//   - engine.js: o catálogo no cofre (uma leitura por dia, com o acesso de uma conta viva, fora do orçamento das
//     leituras de uso), a lista embutida enquanto não leu, e as regras primaryModel / secondaryModel / *Effort.
// Anthropic de mentira (fetch falso, sem rede) e cofre de verdade numa pasta temporária, como no engine.test.js.
//
//   node --test server/test/models.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, decrypt } = require("../src/store");
const { createAnthropic, normalizeModels, CLIENT_ID, OAUTH_BETA, API_VERSION } = require("../src/anthropic");
const { Engine, MODELS_EVERY_MS, MODELS_RETRY_MS, BUILTIN_MODELS } = require("../src/engine");
const { RULE_DEFAULTS, MODEL_EFFORTS, modelLine, limitNameOf } = require("../../plus/rules");

const TOKEN_URL = "https://anthropic.falsa/v1/oauth/token";
const API = "https://api.anthropic.falsa";
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-21T12:00:00Z");

const reply = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const eff = (...levels) => ({ supported: levels.length > 0, ...Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((k) => [k, { supported: levels.includes(k) }])) });
const model = (id, name, line, created, efforts) => ({ type: "model", id, display_name: name, line, created_at: created, max_tokens: 128000, capabilities: { batch: { supported: true }, effort: efforts } });

/** O que a Anthropic responde hoje, encolhido: os quatro da linha 5.5/5.2 e dois antigos (um sem esforço). */
const RAW = [
  model("claude-opus-5-5", "Claude Opus 5.5", "opus", "2026-10-20T00:00:00Z", eff("low", "medium", "high", "xhigh", "max")),
  model("claude-fable-5-2", "Claude Fable 5.2", "fable", "2026-11-09T18:30:00Z", eff("low", "medium", "high", "xhigh", "max")),
  model("claude-haiku-5-5", "Claude Haiku 5.5", "haiku", "2026-10-21T00:00:00Z", eff("low", "medium", "high")),
  model("claude-sonnet-5-5", "Claude Sonnet 5.5", "sonnet", "2026-10-22T00:00:00Z", eff("low", "medium", "high", "xhigh")),
  model("claude-haiku-4-5-20251001", "Claude Haiku 4.5", "haiku", "2025-10-01T00:00:00Z", eff()),
  model("claude-opus-4-6", "Claude Opus 4.6", "opus", "2026-02-01T00:00:00Z", eff("low", "medium", "high", "max")),
];

// ------------------------------------------------------------------ anthropic.models()

test("models(): pede /v1/models com o acesso da conta e devolve a lista normalizada, o mais novo primeiro", async () => {
  const seen = [];
  const anthropic = createAnthropic({
    tokenUrl: TOKEN_URL,
    apiBase: API,
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return reply(200, { data: [...RAW, { id: "gpt-6", display_name: "outro" }, null, RAW[0]], has_more: false });
    },
  });
  const r = await anthropic.models("sk-ant-oat01-ACESSO");
  assert.equal(r.ok, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].url, `${API}/v1/models?limit=100`);
  assert.equal(seen[0].init.method, "GET");
  assert.equal(seen[0].init.redirect, "error");
  assert.equal(seen[0].init.headers.Authorization, "Bearer sk-ant-oat01-ACESSO");
  assert.equal(seen[0].init.headers["anthropic-beta"], OAUTH_BETA);
  assert.equal(seen[0].init.headers["anthropic-version"], API_VERSION);
  assert.deepEqual(
    r.models.map((m) => m.id),
    ["claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-4-6", "claude-haiku-4-5-20251001"],
    "o mais novo primeiro; o que não é modelo Claude e o repetido ficam de fora"
  );
  assert.deepEqual(r.models[0], { id: "claude-fable-5-2", name: "Claude Fable 5.2", line: "fable", createdAt: "2026-11-09T18:30:00Z", efforts: ["low", "medium", "high", "xhigh", "max"] });
  assert.deepEqual(r.models[2].efforts, ["low", "medium", "high"]);
  assert.deepEqual(r.models[5].efforts, [], "modelo sem esforço: lista vazia");
});

test("models(): falhas viram resultado (nunca exceção) — 401, 429 com Retry-After, 5xx, rede, corpo estranho, lista vazia", async () => {
  const withReply = (fn) => createAnthropic({ tokenUrl: TOKEN_URL, apiBase: API, fetchImpl: fn });
  assert.deepEqual(await withReply(async () => reply(401, { error: {} })).models("t"), { ok: false, error: "unauthorized", status: 401, retryAfterSec: null });
  assert.deepEqual(await withReply(async () => reply(429, {}, { "retry-after": "120" })).models("t"), { ok: false, error: "rate_limited", status: 429, retryAfterSec: 120 });
  assert.deepEqual(await withReply(async () => reply(503, {})).models("t"), { ok: false, error: "transient", status: 503, retryAfterSec: null });
  assert.deepEqual(
    await withReply(async () => {
      throw new TypeError("fetch failed");
    }).models("t"),
    { ok: false, error: "transient", status: 0, retryAfterSec: null }
  );
  assert.equal((await withReply(async () => new Response("<html>", { status: 200 })).models("t")).error, "bad_response");
  assert.equal((await withReply(async () => reply(200, { data: "não é lista" })).models("t")).error, "bad_response");
  assert.equal((await withReply(async () => reply(200, { data: [{ id: "gpt-6" }] })).models("t")).error, "bad_response", "nenhum modelo que sirva");
});

test("normalizeModels: família pelo campo `line` ou pelo ID; nome que falta vira o ID; `supported: false` zera os esforços", () => {
  const out = normalizeModels([
    { id: "claude-sonnet-9", created_at: "2030-01-01T00:00:00Z", capabilities: { effort: { supported: false, low: { supported: true } } } },
    { id: "claude-opus-5-5", display_name: "  Claude Opus 5.5 ", line: "OPUS", capabilities: {} },
    { id: "Claude-Maiusculo" },
    { id: "claude-" + "x".repeat(90) },
  ]);
  assert.deepEqual(out, [
    { id: "claude-sonnet-9", name: "claude-sonnet-9", line: "sonnet", createdAt: "2030-01-01T00:00:00Z", efforts: [] },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", line: "opus", createdAt: null, efforts: [] },
  ]);
  assert.equal(modelLine("claude-fable-5-2[1m]"), "fable");
  assert.equal(modelLine("opus"), "opus");
  assert.equal(limitNameOf("claude-haiku-5-5"), "Haiku");
  assert.equal(limitNameOf(""), "");
});

// ------------------------------------------------------------------ motor: catálogo

/** Anthropic de mentira: logins (renovação), uso, perfil e o catálogo de modelos. */
class FakeAnthropic {
  constructor(now) {
    this.now = now;
    this.seq = 0;
    this.people = new Map();
    this.access = new Map(); // access token → email
    this.refreshTokens = new Map();
    this.modelCalls = []; // { email, t }
    this.usageCalls = 0;
    this.modelsReply = () => reply(200, { data: RAW });
    this.fetch = this.fetch.bind(this);
  }
  issue(email) {
    const n = ++this.seq;
    const accessToken = `sk-ant-oat01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const refreshToken = `sk-ant-ort01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    this.access.set(accessToken, email);
    this.refreshTokens.set(refreshToken, { email, spent: false });
    return { accessToken, refreshToken, expiresAt: this.now() + 8 * HOUR };
  }
  login(email) {
    this.people.set(email, { uuid: `uuid-${email}`, email, orgUuid: "org-1" });
    return {
      claudeAiOauth: { ...this.issue(email), scopes: ["user:inference", "user:profile"], subscriptionType: "max" },
      oauthAccount: { accountUuid: `uuid-${email}`, emailAddress: email, organizationUuid: "org-1", organizationName: "Org" },
    };
  }
  allTokens() {
    return [...this.access.keys(), ...this.refreshTokens.keys()];
  }
  async fetch(url, init = {}) {
    if (url === TOKEN_URL) {
      const body = JSON.parse(init.body);
      const rt = this.refreshTokens.get(body.refresh_token);
      if (!rt || rt.spent || body.client_id !== CLIENT_ID) return reply(400, { error: "invalid_grant" });
      rt.spent = true;
      const tok = this.issue(rt.email);
      const p = this.people.get(rt.email);
      return reply(200, { access_token: tok.accessToken, refresh_token: tok.refreshToken, expires_in: 8 * 3600, account: { uuid: p.uuid, email_address: p.email }, organization: { uuid: p.orgUuid } });
    }
    const token = String((init.headers || {}).Authorization || "").replace(/^Bearer /, "");
    const email = this.access.get(token) || null;
    if (url === `${API}/api/oauth/usage`) {
      this.usageCalls++;
      if (!email) return reply(401, {});
      return reply(200, { five_hour: { utilization: 10, resets_at: new Date(this.now() + 2 * HOUR).toISOString() }, seven_day: { utilization: 20, resets_at: new Date(this.now() + 4 * DAY).toISOString() }, limits: [] });
    }
    if (url === `${API}/api/oauth/profile`) {
      if (!email) return reply(401, {});
      const p = this.people.get(email);
      return reply(200, { account: { uuid: p.uuid, email: p.email }, organization: { uuid: p.orgUuid } });
    }
    if (url.startsWith(`${API}/v1/models`)) {
      this.modelCalls.push({ email, t: this.now() });
      if (!email) return reply(401, {});
      return this.modelsReply();
    }
    throw new Error(`rede de verdade bloqueada no teste: ${url}`);
  }
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-modelos-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "master.key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "data"), keyFile });
  store.load();
  t.after(() => store.close());
  const clock = { t: START };
  const now = () => clock.t;
  const fake = new FakeAnthropic(now);
  const anthropic = createAnthropic({ tokenUrl: TOKEN_URL, apiBase: API, fetchImpl: fake.fetch, now });
  const logs = [];
  const put = (...a) => logs.push(a.map(String).join(" "));
  const log = { info: put, warn: put, error: put, log: put };
  const engine = new Engine({ store, anthropic, now, log, env: { USAGE_MAX_PER_HOUR: "24", REFRESH_AHEAD_MIN: "120" } });
  store.state.diag.oldTokenValidAfterRefresh = false;
  const disk = () => decrypt(store.key, fs.readFileSync(store.file));
  return { store, clock, fake, engine, logs, disk };
}

function addDevice(ctx, id, extra = {}) {
  ctx.store.state.devices[id] = { id, name: `PC ${id}`, platform: "linux", tokenHash: "0".repeat(64), createdAt: START, lastSeen: 0, assigned: null, lastSwitchAt: 0, models: [], ...extra };
  return ctx.store.state.devices[id];
}

test("catálogo: antes de ler, a lista embutida; o primeiro ciclo lê na Anthropic com a conta em uso e guarda no cofre", async (t) => {
  const ctx = setup(t);
  const { engine, fake } = ctx;
  assert.deepEqual(engine.modelCatalog(), { fetchedAt: null, builtin: true, list: BUILTIN_MODELS });
  assert.deepEqual(
    BUILTIN_MODELS.map((m) => [m.id, m.efforts.join(",")]),
    [
      ["claude-fable-5-2", "low,medium,high,xhigh"],
      ["claude-opus-5-5", "low,medium,high,xhigh"],
      ["claude-sonnet-5-5", "low,medium,high,xhigh"],
      ["claude-haiku-5-5", "low,medium,high,xhigh"],
    ]
  );
  // Sem conta nenhuma: não há com que acesso perguntar.
  assert.deepEqual(await engine.refreshModels(), { ok: false, error: "no_account", status: 0 });
  assert.equal(fake.modelCalls.length, 0);

  await engine.addLogin(fake.login("a@x.com"));
  await engine.addLogin(fake.login("b@x.com"));
  ctx.clock.t += HOUR + MIN; // passou a espera de depois da tentativa sem conta
  addDevice(ctx, "pc", { assigned: 2, lastSeen: ctx.clock.t, lastSwitchAt: ctx.clock.t, lastSwitchBy: "manual" }); // a conta 2 é a que está em uso
  const tokensBefore = engine.bucket.tokens;
  const usageBefore = fake.usageCalls;
  await engine.tick();
  assert.deepEqual(fake.modelCalls.map((c) => c.email), ["b@x.com"], "uma leitura, com o acesso da conta em uso");
  const cat = engine.modelCatalog();
  assert.equal(cat.builtin, false);
  assert.equal(cat.fetchedAt, ctx.clock.t);
  assert.deepEqual(cat.list.map((m) => m.id), ["claude-fable-5-2", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5", "claude-opus-4-6", "claude-haiku-4-5-20251001"]);
  assert.deepEqual(cat.list.find((m) => m.id === "claude-haiku-5-5"), { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", line: "haiku", createdAt: "2026-10-21T00:00:00Z", efforts: ["low", "medium", "high"] });
  assert.deepEqual(ctx.disk().models, ctx.store.state.models, "está no cofre, no disco");
  assert.ok(ctx.logs.some((l) => l.includes("[modelos] catálogo atualizado com a conta 2: 6 modelo(s)")));
  // Fora do orçamento das leituras de uso: o balde só desceu pelo que o ciclo leu de uso.
  assert.equal(Math.round(tokensBefore - engine.bucket.tokens), fake.usageCalls - usageBefore);
  for (const tok of fake.allTokens()) assert.ok(!ctx.logs.join("\n").includes(tok), "o log não tem token");
  assert.equal(engine.modelLineOf("claude-opus-4-6"), "opus");
  assert.equal(engine.modelLineOf("claude-novo-9"), "novo", "fora do catálogo: o que o ID diz");
});

test("catálogo: uma leitura por dia; falhou, espera 1 h (um aviso só) e a lista de antes continua valendo", async (t) => {
  const ctx = setup(t);
  const { engine, fake } = ctx;
  await engine.addLogin(fake.login("a@x.com"));
  await engine.tick();
  assert.equal(fake.modelCalls.length, 1);
  const first = engine.modelCatalog();

  // No mesmo dia: não lê de novo.
  for (let i = 0; i < 20; i++) {
    ctx.clock.t += HOUR;
    await engine.tick();
  }
  assert.equal(fake.modelCalls.length, 1);
  // Passou um dia: lê de novo. A Anthropic falha: fica a lista de antes, e só tenta de novo depois de 1 h.
  ctx.clock.t = first.fetchedAt + MODELS_EVERY_MS + MIN;
  fake.modelsReply = () => reply(503, {});
  await engine.tick();
  assert.equal(fake.modelCalls.length, 2);
  assert.deepEqual(engine.modelCatalog(), first);
  ctx.clock.t += 30 * MIN;
  await engine.tick();
  assert.equal(fake.modelCalls.length, 2, "dentro da hora de espera: não insiste");
  ctx.clock.t += MODELS_RETRY_MS;
  await engine.tick();
  assert.equal(fake.modelCalls.length, 3);
  const warns = ctx.logs.filter((l) => l.includes("[modelos] não consegui ler o catálogo"));
  assert.equal(warns.length, 1, "avisa uma vez por sequência de falhas");
  assert.match(warns[0], /com a conta 1 \(transient, status 503\); tento de novo em 1 h/);
  // Voltou: lista nova (com um modelo a mais) e a data de agora.
  fake.modelsReply = () => reply(200, { data: [...RAW, model("claude-fable-6", "Claude Fable 6", "fable", "2027-01-01T00:00:00Z", eff("low", "high"))] });
  ctx.clock.t += MODELS_RETRY_MS + MIN;
  await engine.tick();
  assert.equal(engine.modelCatalog().list[0].id, "claude-fable-6");
  assert.equal(engine.modelCatalog().fetchedAt, ctx.clock.t);

  // O botão do painel: lê agora, mesmo dentro do dia.
  const n = fake.modelCalls.length;
  const r = await engine.refreshModels();
  assert.deepEqual(r, { ok: true, count: 7, fetchedAt: ctx.clock.t });
  assert.equal(fake.modelCalls.length, n + 1);
  // Conta sem acesso valendo (vencido) não serve para perguntar; morta também não.
  ctx.store.state.accounts["1"].cred.expiresAt = ctx.clock.t - MIN;
  assert.equal((await engine.refreshModels()).error, "no_account");
});

test("catálogo: motor com um cliente da Anthropic sem models() (antigo) segue como antes, com a lista embutida", async (t) => {
  const ctx = setup(t);
  const { models: _drop, ...old } = ctx.engine.anthropic;
  ctx.engine.anthropic = old;
  await ctx.engine.addLogin(ctx.fake.login("a@x.com"));
  await ctx.engine.tick();
  assert.equal(ctx.fake.modelCalls.length, 0);
  assert.equal(ctx.engine.modelCatalog().builtin, true);
  assert.deepEqual(await ctx.engine.refreshModels(), { ok: false, error: "unsupported", status: 0 });
});

// ------------------------------------------------------------------ motor: regras dos modelos

test("regras: os padrões são Fable 5.2 e Opus 5.5 sem esforço imposto, e vão para os serviços dentro de `rules`", async (t) => {
  const ctx = setup(t);
  const r = ctx.engine.rulesEffective();
  assert.deepEqual([r.primaryModel, r.primaryEffort, r.secondaryModel, r.secondaryEffort, r.preferModel], ["claude-fable-5-2", "", "claude-opus-5-5", "", "Fable"]);
  assert.deepEqual([RULE_DEFAULTS.primaryModel, RULE_DEFAULTS.secondaryModel], ["claude-fable-5-2", "claude-opus-5-5"]);
  assert.deepEqual(MODEL_EFFORTS, ["low", "medium", "high", "xhigh"]);
  addDevice(ctx, "pc");
  const st = ctx.engine.stateFor("pc");
  assert.equal(st.rules.primaryModel, "claude-fable-5-2");
  assert.equal(st.rules.secondaryModel, "claude-opus-5-5");
  assert.equal(st.models, undefined, "o catálogo é só do painel: os serviços recebem as regras");
});

test("regras: grava modelo e esforço; o nome do limite (preferModel) acompanha o modelo preferido", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  let r = (await engine.setRules({ rules: { primaryModel: "claude-fable-5-2", primaryEffort: "xhigh", secondaryModel: "claude-opus-5-5", secondaryEffort: "high" } })).rules;
  assert.deepEqual([r.primaryEffort, r.secondaryEffort, r.preferModel], ["xhigh", "high", "Fable"]);
  assert.deepEqual(ctx.store.state.rules, { primaryModel: "claude-fable-5-2", primaryEffort: "xhigh", secondaryModel: "claude-opus-5-5", secondaryEffort: "high" });
  assert.deepEqual(ctx.disk().rules, ctx.store.state.rules);

  // Preferido passa a ser o Opus (e o secundário, o Sonnet): o servidor procura nas contas o limite "Opus".
  r = (await engine.setRules({ rules: { primaryModel: "claude-opus-5-5", secondaryModel: "claude-sonnet-5-5" } })).rules;
  assert.deepEqual([r.primaryModel, r.secondaryModel, r.preferModel], ["claude-opus-5-5", "claude-sonnet-5-5", "Opus"]);
  assert.equal(ctx.store.state.rules.preferModel, "Opus");
  // Volta ao Fable: preferModel volta ao padrão (sai do cofre).
  r = (await engine.setRules({ rules: { primaryModel: "claude-fable-5-2", secondaryModel: "claude-opus-5-5" } })).rules;
  assert.equal(r.preferModel, "Fable");
  assert.equal(Object.prototype.hasOwnProperty.call(ctx.store.state.rules, "preferModel"), false);
  // O pedido diz o preferModel ele mesmo: vale o que ele disse.
  r = (await engine.setRules({ rules: { primaryModel: "claude-sonnet-5-5", preferModel: "" } })).rules;
  assert.deepEqual([r.primaryModel, r.preferModel], ["claude-sonnet-5-5", ""]);
  // Pedido antigo, só com preferModel: continua valendo e não mexe nos modelos.
  r = (await engine.setRules({ rules: { preferModel: "Fable" } })).rules;
  assert.deepEqual([r.primaryModel, r.preferModel], ["claude-sonnet-5-5", "Fable"]);
  // null = volta ao padrão, chave por chave; ID com maiúsculas e espaços é aceito e normalizado.
  r = (await engine.setRules({ rules: { primaryModel: null, primaryEffort: null, secondaryModel: "  Claude-Haiku-5-5 " } })).rules;
  assert.deepEqual([r.primaryModel, r.primaryEffort, r.secondaryModel, r.preferModel], ["claude-fable-5-2", "", "claude-haiku-5-5", "Fable"]);
  // Tudo de volta ao padrão.
  r = (await engine.setRules({ rules: null })).rules;
  assert.deepEqual([r.primaryModel, r.secondaryModel, r.primaryEffort, r.secondaryEffort, r.preferModel], ["claude-fable-5-2", "claude-opus-5-5", "", "", "Fable"]);
  assert.equal(ctx.store.state.rules, null);
});

test("regras: o modelo da família vem do catálogo quando o ID não diz (e do ID quando o modelo não está nele)", async (t) => {
  const ctx = setup(t);
  ctx.store.state.models = { fetchedAt: START, list: [{ id: "claude-5-nova", name: "Claude Nova 5", line: "nova", createdAt: null, efforts: ["low"] }] };
  let r = (await ctx.engine.setRules({ rules: { primaryModel: "claude-5-nova" } })).rules;
  assert.equal(r.preferModel, "Nova", "pela linha do catálogo");
  r = (await ctx.engine.setRules({ rules: { primaryModel: "claude-haiku-9" } })).rules;
  assert.equal(r.preferModel, "Haiku", "fora do catálogo: pelo ID");
});

test("regras: valores inválidos são recusados (invalid_rules) e nada muda", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await engine.setRules({ rules: { primaryEffort: "high" } });
  const before = JSON.stringify(ctx.store.state.rules);
  const bad = async (rules, re) => {
    await assert.rejects(engine.setRules({ rules }), (e) => e.code === "invalid_rules" && re.test(e.message), JSON.stringify(rules));
    assert.equal(JSON.stringify(ctx.store.state.rules), before, `nada mudou: ${JSON.stringify(rules)}`);
  };
  await bad({ primaryModel: "gpt-6" }, /primaryModel precisa ser o ID de um modelo/);
  await bad({ secondaryModel: "" }, /secondaryModel precisa ser o ID de um modelo/);
  await bad({ secondaryModel: 5 }, /secondaryModel precisa ser o ID/);
  await bad({ primaryModel: "claude-" + "x".repeat(90) }, /primaryModel precisa ser o ID/);
  await bad({ primaryEffort: "max" }, /primaryEffort precisa ser vazio \(não mexe no esforço\) ou low, medium, high, xhigh/);
  await bad({ secondaryEffort: "altíssimo" }, /secondaryEffort precisa ser vazio/);
  await bad({ secondaryEffort: 3 }, /secondaryEffort precisa ser vazio/);
  await bad({ secondaryModel: "claude-fable-5-2" }, /o modelo preferido e o secundário precisam ser diferentes/);
  await bad({ primaryModel: "claude-opus-5-5" }, /precisam ser diferentes/);
  // Esforço vazio é válido: "não mexe".
  const r = (await engine.setRules({ rules: { primaryEffort: "" } })).rules;
  assert.equal(r.primaryEffort, "");
});
