"use strict";
// Testes das leituras de uso do motor (server/src/engine.js: usageStep, dueAt, nearLine e o balde do orçamento):
// quem é lida primeiro, de quanto em quanto tempo, o piso das contas que não estão em uso e o teto do balde.
// Mesma montagem do engine.test.js: uma Anthropic de mentira (fetch falso, sem rede), um cofre de verdade numa
// pasta temporária, com chave gerada aqui, e um relógio manual que anda de 15 em 15 s (o ciclo do motor).
//
//   node --test server/test/usage-poll.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, decrypt } = require("../src/store");
const { createAnthropic, normalizeUsage, CLIENT_ID } = require("../src/anthropic");
const { Engine, TICK_MS } = require("../src/engine");
const { windows, STALE_USAGE_SEC, CAND_STALE_SEC } = require("../../plus/rules");

const TOKEN_URL = "https://anthropic.falsa/v1/oauth/token";
const API = "https://api.anthropic.falsa";
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-14T12:00:00Z");

// Os números da regra (constantes do engine.js que não são exportadas), conferidos aqui pelo comportamento.
const NEAR = 150 * SEC; // conta em uso perto de uma linha de troca: a cada 2,5 min
const FAR = 10 * MIN; // conta em uso longe das linhas, ou com uma linha já passada
const IDLE = 20 * MIN; // as outras
const BUDGET = 24; // USAGE_MAX_PER_HOUR destes testes (o padrão)
const BURST = 6; // leituras que o balde do orçamento guarda
const SLOT = HOUR / BUDGET; // uma leitura do orçamento: 2,5 min

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

const email = (n) => `c${String(n).padStart(2, "0")}@x.com`;
const numberOf = (e) => Number(String(e).slice(1, 3));

/**
 * Anthropic de mentira, reduzida da do engine.test.js: emite tokens, gira o refresh token (uso único), responde uso
 * e perfil. Cada chamada fica em `calls`, com a hora (`t`).
 */
class FakeAnthropic {
  constructor(now) {
    this.now = now;
    this.seq = 0;
    this.people = new Map(); // email → { uuid, email, orgUuid, usage (formato cru da API) }
    this.access = new Map(); // access token → { email, expiresAt }
    this.refreshTokens = new Map(); // refresh token → { email, spent }
    this.calls = []; // { kind: "refresh"|"usage"|"profile", email, t }
    this.usageReplies = []; // respostas forçadas para as próximas leituras de uso: { status, body, headers }
    this.expiresIn = 8 * 3600; // expires_in (s) das renovações
    this.fetch = this.fetch.bind(this);
  }

  person(email, orgUuid = "org-1") {
    if (!this.people.has(email)) this.people.set(email, { uuid: `uuid-${email}`, email, orgUuid, usage: rawUsage() });
    return this.people.get(email);
  }

  issue(email, expiresInMs = 8 * HOUR) {
    const n = ++this.seq;
    const accessToken = `sk-ant-oat01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const refreshToken = `sk-ant-ort01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const expiresAt = this.now() + expiresInMs;
    this.access.set(accessToken, { email, expiresAt });
    this.refreshTokens.set(refreshToken, { email, spent: false });
    return { accessToken, refreshToken, expiresAt };
  }

  /** Um login como o Claude Code guarda: { claudeAiOauth, oauthAccount }. */
  login(email, { orgUuid = "org-1" } = {}) {
    this.person(email, orgUuid);
    const tok = this.issue(email);
    return {
      claudeAiOauth: { ...tok, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
      oauthAccount: { accountUuid: `uuid-${email}`, emailAddress: email, organizationUuid: orgUuid, organizationName: `Org de ${email}` },
    };
  }

  async fetch(url, init = {}) {
    const headers = init.headers || {};
    if (url === TOKEN_URL) {
      const body = JSON.parse(init.body);
      const rt = this.refreshTokens.get(body.refresh_token);
      this.calls.push({ kind: "refresh", email: rt ? rt.email : null, t: this.now() });
      if (!rt || rt.spent || body.client_id !== CLIENT_ID || body.grant_type !== "refresh_token") {
        return reply(400, { error: "invalid_grant", error_description: "Invalid refresh token" });
      }
      rt.spent = true; // uso único
      const tok = this.issue(rt.email, this.expiresIn * 1000);
      const p = this.people.get(rt.email);
      return reply(200, {
        token_type: "Bearer",
        access_token: tok.accessToken,
        refresh_token: tok.refreshToken,
        expires_in: this.expiresIn,
        scope: "user:inference user:profile",
        account: { uuid: p.uuid, email_address: p.email },
        organization: { uuid: p.orgUuid },
      });
    }
    const token = String(headers.Authorization || "").replace(/^Bearer /, "");
    const a = this.access.get(token);
    const valid = !!a && a.expiresAt > this.now();
    if (url === `${API}/api/oauth/usage`) {
      this.calls.push({ kind: "usage", email: a ? a.email : null, t: this.now() });
      if (this.usageReplies.length) {
        const r = this.usageReplies.shift();
        return reply(r.status, r.body || {}, r.headers || {});
      }
      if (!valid) return reply(401, { error: { type: "authentication_error" } });
      return reply(200, this.people.get(a.email).usage);
    }
    if (url === `${API}/api/oauth/profile`) {
      this.calls.push({ kind: "profile", email: a ? a.email : null, t: this.now() });
      if (!valid) return reply(401, {});
      const p = this.people.get(a.email);
      return reply(200, { account: { uuid: p.uuid, email: p.email }, organization: { uuid: p.orgUuid } });
    }
    throw new Error(`rede de verdade bloqueada no teste: ${url}`);
  }
}

/**
 * Uso no formato cru da API. session null = sem janela de 5 h aberta; models = { nome: % } (limites por modelo).
 * As datas de virada são as mesmas em todas as contas (a estratégia "aproveitar ao máximo" não tem por que trocar).
 */
function rawUsage({ session = 10, weekly = 20, models = {} } = {}) {
  return {
    five_hour: session === null ? null : { utilization: session, resets_at: new Date(START + 5 * HOUR).toISOString() },
    seven_day: { utilization: weekly, resets_at: new Date(START + 4 * DAY).toISOString() },
    limits: Object.entries(models).map(([name, pct]) => ({ scope: { model: { display_name: name } }, percent: pct, resets_at: new Date(START + 4 * DAY).toISOString() })),
  };
}

/**
 * env: variáveis do motor por cima das dos testes (USAGE_MAX_PER_HOUR=24, REFRESH_AHEAD_MIN=120).
 * → { store, clock, fake, engine, newEngine(env), logs, disk() }
 */
function setup(t, { env = {} } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-uso-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "master.key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "data"), keyFile });
  store.load();
  t.after(() => store.close()); // solta a trava da pasta (store.lock)
  const clock = { t: START };
  const now = () => clock.t;
  const fake = new FakeAnthropic(now);
  const anthropic = createAnthropic({ tokenUrl: TOKEN_URL, apiBase: API, fetchImpl: fake.fetch, now });
  const logs = [];
  const put = (...a) => logs.push(a.map(String).join(" "));
  const log = { info: put, warn: put, error: put, log: put };
  // Um motor novo sobre o mesmo cofre = o servidor reiniciando (o balde e as contagens ficam só na memória).
  const newEngine = (more = {}) => new Engine({ store, anthropic, now, log, env: { USAGE_MAX_PER_HOUR: String(BUDGET), REFRESH_AHEAD_MIN: "120", ...env, ...more } });
  const engine = newEngine();
  // O diagnóstico único do acesso antigo gastaria uma leitura no meio das contagens: aqui ele já foi feito.
  store.state.diag.oldTokenValidAfterRefresh = true;
  const disk = () => decrypt(store.key, fs.readFileSync(store.file));
  return { store, clock, fake, engine, newEngine, logs, disk };
}

/** Cria as contas 1..n. Cada login entra marcado para ler o uso logo (pollSoon), como todo login novo. */
async function addAccounts(ctx, n) {
  for (let i = 1; i <= n; i++) assert.deepEqual(await ctx.engine.addLogin(ctx.fake.login(email(i))), { number: i, created: true });
}

/** Servidor que já estava no ar: nenhuma conta marcada para ler logo (as marcas dos logins novos já foram lidas). */
function settled(ctx) {
  ctx.engine.pollSoon.clear();
}

/** Rodadas de milhares de ciclos: o cofre para de ir ao disco (a ordem das leituras não depende dele). */
function fastSave(ctx) {
  ctx.store.save = async () => {};
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

/** O que a Anthropic responde nas próximas leituras de uso da conta n. */
function setRemote(ctx, n, usage = {}) {
  ctx.fake.people.get(email(n)).usage = rawUsage(usage);
}

/** Uso da conta n lido há `ago` ms (sem passar pela API); a Anthropic passa a responder o mesmo. */
function setUsage(ctx, n, { ago = 0, ...usage } = {}) {
  setRemote(ctx, n, usage);
  const at = ctx.clock.t - ago;
  const u = normalizeUsage(rawUsage(usage));
  Object.assign(ctx.store.state.accounts[String(n)], { usage: u, usageFetchedAt: at, usageError: null, lastGoodUsage: u, lastGoodAt: at });
}

/**
 * Anda o relógio por `ms`, de 15 em 15 s, rodando um ciclo do motor a cada passo. Os dispositivos de `devs` ficam
 * ativos (lastSeen a cada 30 s, como o batimento). before(t) roda antes de cada ciclo; after(t), depois.
 */
async function run(ctx, ms, devs = [], { before = null, after = null } = {}) {
  const steps = Math.round(ms / TICK_MS);
  for (let i = 0; i < steps; i++) {
    ctx.clock.t += TICK_MS;
    if (i % 2 === 0) for (const d of devs) d.lastSeen = ctx.clock.t;
    if (before) await before(ctx.clock.t);
    await ctx.engine.tick();
    if (after) await after(ctx.clock.t);
  }
}

/** As leituras de uso feitas até agora, na ordem: [{ n: número da conta, t }]. */
const reads = (ctx) => ctx.fake.calls.filter((c) => c.kind === "usage").map((c) => ({ n: numberOf(c.email), t: c.t }));
const readOrder = (ctx) => reads(ctx).map((r) => r.n);
/** Intervalos (ms) entre leituras seguidas da conta n; só os que terminam depois de `from`. */
function gapsOf(ctx, n, from = 0) {
  const ts = reads(ctx).filter((r) => r.n === n).map((r) => r.t);
  const out = [];
  for (let i = 1; i < ts.length; i++) if (ts[i] > from) out.push(ts[i] - ts[i - 1]);
  return out;
}

/** O maior número de leituras em qualquer janela corrida de `windowMs`. */
function maxRolling(times, windowMs = HOUR) {
  let best = 0;
  let j = 0;
  for (let i = 0; i < times.length; i++) {
    while (times[i] - times[j] >= windowMs) j++;
    best = Math.max(best, i - j + 1);
  }
  return best;
}

const blockedTexts = (ctx) => ctx.store.state.history.filter((h) => h.kind === "blocked").map((h) => h.text);

// ------------------------------------------------------------------ ordem

test("uso: ordem das leituras — a marcada para ler logo, depois a conta em uso que está na vez, depois as outras pela mais atrasada", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 8);
  settled(ctx);
  setUsage(ctx, 1, { ago: 30 * MIN });
  setUsage(ctx, 2, { ago: 50 * MIN }); // a mais atrasada de todas
  setUsage(ctx, 3, { ago: 11 * MIN }); // em uso, longe das linhas: na vez há 1 min
  setUsage(ctx, 4, { ago: 2 * MIN }); // lida há pouco, mas marcada para ler logo
  setUsage(ctx, 5, { ago: 5 * MIN }); // lida há pouco: não está na vez
  setUsage(ctx, 6, { ago: 40 * MIN });
  setUsage(ctx, 7, { ago: 40 * MIN }); // empata com a 6: a de menor número primeiro
  setUsage(ctx, 8, { ago: 12 * MIN }); // em uso, na vez há 2 min: antes da 3
  const devs = [
    addDevice(ctx.engine, "d1", { assigned: 3, lastSeen: ctx.clock.t, lastSwitchBy: "manual" }),
    addDevice(ctx.engine, "d2", { assigned: 8, lastSeen: ctx.clock.t, lastSwitchBy: "manual" }),
  ];
  ctx.engine.pollSoon.add(4); // como fazem o limite batido (limitHit) e o login novo

  await run(ctx, 2 * MIN, devs);
  assert.deepEqual(readOrder(ctx), [4, 8, 3, 2, 6, 7], "as 6 leituras guardadas, na ordem");
  assert.equal(ctx.engine.pollSoon.size, 0, "a marca sai quando a conta é lida");
  await run(ctx, 2 * MIN, devs);
  assert.deepEqual(readOrder(ctx), [4, 8, 3, 2, 6, 7, 1], "a seguinte, quando o orçamento deixa: a que sobrou na vez");
  assert.deepEqual(devs.map((d) => d.assigned), [3, 8]);
});

test("uso: conta em uso que ainda não tem leitura nenhuma é lida antes das outras que também não têm", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 4);
  settled(ctx); // sem as marcas de login novo: a ordem aqui é só "em uso" contra "as outras"
  const acc = ctx.store.state.accounts["3"];
  assert.equal(ctx.engine.nearLine(acc), true, "sem leitura conta como perto da linha (não se sabe onde ela está)");
  assert.equal(ctx.engine.dueAt(acc, true), 0, "e está na vez desde já");
  const d1 = addDevice(ctx.engine, "d1", { assigned: 3, lastSeen: ctx.clock.t, lastSwitchBy: "manual" });

  await run(ctx, MIN, [d1]);
  assert.deepEqual(readOrder(ctx), [3, 1, 2, 4]);
});

// ------------------------------------------------------------------ intervalos

test("uso: conta em uso longe das linhas é lida a cada 10 min; perto de uma linha, a cada 2,5 min; as outras, a cada 20 min", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  settled(ctx);
  for (const n of [1, 2, 3]) setUsage(ctx, n, { session: 50 });
  const d1 = addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "manual" });
  const T0 = ctx.clock.t;
  const at = (n) => reads(ctx).filter((r) => r.n === n).map((r) => (r.t - T0) / MIN);

  // Longe da linha (sessão em 50%, linha em 90%): só aos 10 min.
  await run(ctx, FAR - TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [], "antes dos 10 min ninguém está na vez");
  setRemote(ctx, 1, { session: 80 }); // a leitura dos 10 min já mostra a conta a 10 pontos da linha
  await run(ctx, TICK_MS, [d1]);
  assert.deepEqual(reads(ctx), [{ n: 1, t: T0 + FAR }]);

  // Perto da linha: de 2,5 em 2,5 min.
  await run(ctx, NEAR - TICK_MS, [d1]);
  assert.equal(reads(ctx).length, 1, "antes dos 2,5 min não");
  await run(ctx, 3 * NEAR, [d1]); // até um ciclo antes dos 20 min
  assert.deepEqual(at(1), [10, 12.5, 15, 17.5]);
  assert.deepEqual([at(2), at(3)], [[], []], "as outras só aos 20 min");

  // Aos 20 min a 1, a 2 e a 3 estão na vez ao mesmo tempo. A 1 já foi lida 4 vezes seguidas: a vez é de outra conta
  // (a 2), depois a 1 de novo, depois a 3 — com leitura guardada no balde, a conta em uso só espera um ciclo.
  setRemote(ctx, 1, { session: 50 }); // ...e a leitura seguinte mostra a 1 longe da linha de novo
  await run(ctx, 3 * TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx).slice(4), [2, 1, 3]);
  assert.deepEqual(at(2), [20]);
  assert.deepEqual(at(1).slice(4), [20.25]);
  assert.deepEqual(at(3), [20.5]);

  // Longe de novo: a 1 só volta 10 min depois; a 2 e a 3, 20 min depois da leitura delas.
  await run(ctx, 20 * MIN, [d1]);
  assert.deepEqual(at(1).slice(5), [30.25, 40.25]);
  assert.deepEqual(at(2), [20, 40]);
  assert.deepEqual(at(3), [20.5, 40.5]);
  assert.equal(d1.assigned, 1, "nenhuma troca no caminho");
});

test("uso: perto da linha = até 15 pontos abaixo da linha da sessão ou da do modelo, ou 5 abaixo da semanal; linha já passada e conta longe ficam nos 10 min", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 2);
  settled(ctx);
  const acc = ctx.store.state.accounts["1"];
  const near = (n, usage) => {
    setUsage(ctx, n, usage);
    return ctx.engine.nearLine(ctx.store.state.accounts[String(n)]);
  };

  // Regras padrão: sessão 90%, semanal 80%, modelo 95%.
  assert.equal(near(1, { session: 74 }), false);
  assert.equal(near(1, { session: 75 }), true);
  assert.equal(near(1, { session: 89.9 }), true);
  assert.equal(near(1, { session: 90 }), false, "na linha = já passou");
  assert.equal(near(1, { session: 100 }), false);
  assert.equal(near(1, { weekly: 74 }), false, "o semanal anda devagar: só os últimos 5 pontos");
  assert.equal(near(1, { weekly: 75 }), true);
  assert.equal(near(1, { weekly: 80 }), false);
  assert.equal(near(1, { session: 80, weekly: 85 }), false, "perto de uma linha mas com outra já passada: não adianta reler esta conta");
  assert.equal(near(1, { session: null, weekly: 50 }), false, "sem janela de 5 h aberta = sessão em 0%");

  // O limite por modelo só conta na regra "trocar de conta para continuar no modelo". Desde a 2.5.6 a faixa dele é a
  // da sessão (15 pontos), não a do semanal (5): o limite do Fable anda rápido com várias conversas.
  assert.equal(near(1, { models: { Fable: 92 } }), false);
  await ctx.engine.setRules({ rules: { onModelLimit: "switchAccount" } });
  assert.equal(near(1, { models: { Fable: 79 } }), false);
  assert.equal(near(1, { models: { Fable: 80 } }), true);
  assert.equal(near(1, { models: { Fable: 89 } }), true, "o caso de 21/11 14:03: a conta chegou com o Fable em 89%");
  assert.equal(near(1, { models: { Fable: 92 } }), true);
  assert.equal(near(1, { models: { Fable: 95 } }), false, "na linha = já passou");
  assert.equal(near(1, { weekly: 74, models: { Fable: 50 } }), false, "o semanal continua com a faixa de 5");
  await ctx.engine.setRules({ rules: { onModelLimit: "switchAccount", modelPct: 70 } });
  assert.equal(near(1, { models: { Fable: 54 } }), false, "a faixa acompanha a linha do modelo");
  assert.equal(near(1, { models: { Fable: 55 } }), true);
  await ctx.engine.setRules({ rules: null });

  // Linha geral mudada e linhas próprias da conta: "perto" acompanha a linha de cada conta.
  await ctx.engine.setRules({ rules: { sessionPct: 70 } });
  assert.equal(near(1, { session: 54 }), false);
  assert.equal(near(1, { session: 55 }), true);
  await ctx.engine.setRules({ rules: null });
  await ctx.engine.updateAccount(1, { threshold: 60, weeklyThreshold: 90 });
  assert.equal(near(1, { session: 44 }), false);
  assert.equal(near(1, { session: 45 }), true);
  assert.equal(near(1, { session: 60 }), false);
  assert.equal(near(1, { weekly: 84 }), false);
  assert.equal(near(1, { weekly: 86 }), true);
  assert.equal(near(2, { session: 45 }), false, "a linha própria da conta 1 não vale para a 2");
  assert.equal(near(2, { session: 80 }), true);
  await ctx.engine.updateAccount(1, { threshold: null, weeklyThreshold: null });

  // Leitura que falhou (usage vazio): vale a última boa. Sem nenhuma: perto.
  setUsage(ctx, 1, { session: 80 });
  acc.usage = null;
  assert.equal(ctx.engine.nearLine(acc), true);
  setUsage(ctx, 1, { session: 30 });
  acc.usage = null;
  assert.equal(ctx.engine.nearLine(acc), false);
  acc.lastGoodUsage = null;
  assert.equal(ctx.engine.nearLine(acc), true);

  // dueAt: a última leitura mais 2,5 min (em uso, perto), 10 min (em uso, longe ou com a linha já passada) ou 20 min (as outras).
  const T = ctx.clock.t;
  const due = (usage, active) => {
    setUsage(ctx, 1, { ...usage, ago: MIN });
    return ctx.engine.dueAt(acc, active) - (T - MIN);
  };
  assert.equal(due({ session: 80 }, true), NEAR);
  assert.equal(due({ session: 50 }, true), FAR);
  assert.equal(due({ session: 95 }, true), FAR);
  assert.equal(due({ session: 80 }, false), IDLE, "fora de uso, perto ou longe: 20 min");
  assert.equal(due({ session: 50 }, false), IDLE);
  acc.pollBackoffUntil = T + 30 * MIN; // a espera depois de uma leitura que falhou vale mais
  assert.equal(ctx.engine.dueAt(acc, true), T + 30 * MIN);
  ctx.engine.pollSoon.add(1); // marcada para ler logo: assim que a espera acabar
  assert.equal(ctx.engine.dueAt(acc, true), T + 30 * MIN);
  acc.pollBackoffUntil = 0;
  assert.equal(ctx.engine.dueAt(acc, false), 0);
});

test("uso: linha já passada e nenhuma outra conta com folga — a conta em uso fica nos 10 min e as outras seguem nos 20", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 4);
  settled(ctx);
  setUsage(ctx, 1, { session: 95 }); // passou da linha de 90%...
  for (const n of [2, 3, 4]) setUsage(ctx, n, { weekly: 85 }); // ...e nenhuma outra tem folga (linha semanal de 80%)
  const d1 = addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "auto" });
  const T0 = ctx.clock.t;
  const at = (n) => reads(ctx).filter((r) => r.n === n).map((r) => (r.t - T0) / MIN);

  await run(ctx, HOUR, [d1]);
  assert.equal(d1.assigned, 1);
  assert.deepEqual(blockedTexts(ctx), ["Conta 1 com sessão em 95% (linha 90%), mas nenhuma outra conta tem folga"]);
  // Perto da linha ela seria lida 24 vezes nesta hora; com a linha já passada, 6 — e sobra orçamento para as outras.
  assert.deepEqual(at(1), [10, 20, 30, 40, 50, 60]);
  assert.deepEqual([at(2), at(3), at(4)], [[20.25, 40.25], [20.5, 40.5], [20.75, 40.75]]);
});

// ------------------------------------------------------------------ piso das outras

test("uso: piso das outras — com duas contas em uso perto da linha, de cada 3 leituras uma é de outra conta e nenhuma fica sem ser lida", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 8);
  settled(ctx);
  fastSave(ctx);
  for (let n = 1; n <= 8; n++) setUsage(ctx, n, n <= 2 ? { session: 80 } : {});
  const devs = [
    addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "manual" }),
    addDevice(ctx.engine, "d2", { assigned: 2, lastSeen: ctx.clock.t, lastSwitchBy: "manual" }),
  ];
  const idle = [3, 4, 5, 6, 7, 8];

  await run(ctx, 2 * HOUR, devs); // até entrar em regime
  const from = ctx.clock.t;
  let oldestIdle = 0; // a leitura mais velha de uma conta que não está em uso, em qualquer ciclo
  await run(ctx, 3 * HOUR, devs, {
    after: (now) => {
      for (const n of idle) oldestIdle = Math.max(oldestIdle, now - ctx.store.state.accounts[String(n)].usageFetchedAt);
    },
  });
  const rs = reads(ctx).filter((r) => r.t > from);

  assert.equal(rs.length, 3 * BUDGET, "o orçamento inteiro é usado: 24 por hora");
  for (let i = 0; i + 3 <= rs.length; i++) {
    const trio = rs.slice(i, i + 3).map((r) => r.n);
    assert.ok(trio.some((n) => n > 2), `três leituras seguidas de contas em uso: ${trio.join(", ")}`);
  }
  // As duas em uso ficam com 2 de cada 3 leituras: cada uma a cada 7,5 min.
  for (const n of [1, 2]) assert.deepEqual([...new Set(gapsOf(ctx, n, from))], [3 * SLOT]);
  // As outras 6 dividem 1 de cada 3 leituras (8 por hora): cada uma a cada 45 min, e nunca mais que isso.
  for (const n of idle) {
    const gaps = gapsOf(ctx, n, from);
    assert.ok(gaps.length >= 3, `a conta ${n} foi lida ${gaps.length} vezes em 3 h`);
    assert.deepEqual([...new Set(gaps)], [3 * idle.length * SLOT]);
  }
  assert.ok(oldestIdle <= 3 * idle.length * SLOT, `leitura mais velha de uma conta fora de uso: ${oldestIdle / MIN} min`);
  assert.ok(oldestIdle < CAND_STALE_SEC * SEC, "todas continuam servindo de destino (leitura com menos de 1 h)");
  assert.deepEqual(devs.map((d) => d.assigned), [1, 2]);
});

// ------------------------------------------------------------------ conta que acabou de receber um dispositivo

test("uso: conta que acabou de receber o dispositivo, com leitura velha, é lida logo (no máximo uma leitura de outra conta antes)", async (t) => {
  // 1) O caso comum: a leitura da conta em uso mostra a linha passada, o dispositivo troca, e a conta nova (lida
  //    pela última vez há 40 min) é lida no ciclo seguinte.
  let ctx = setup(t);
  await addAccounts(ctx, 4);
  settled(ctx);
  setUsage(ctx, 1, { session: 50, ago: FAR }); // em uso e na vez...
  setRemote(ctx, 1, { session: 95 }); // ...e a leitura vai mostrar a linha de 90% passada
  setUsage(ctx, 2, { ago: 40 * MIN }); // a de mais folga: é para ela que o dispositivo vai
  setUsage(ctx, 3, { weekly: 60, ago: 5 * MIN });
  setUsage(ctx, 4, { weekly: 60, ago: 5 * MIN });
  let d1 = addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "auto" });

  await run(ctx, TICK_MS, [d1]);
  assert.deepEqual([readOrder(ctx), d1.assigned], [[1], 2]);
  assert.match(ctx.store.state.history[0].text, /^Trocou da conta 1 para a conta 2: sessão em 95% \(linha 90%\)/);
  await run(ctx, TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [1, 2], "a conta nova é lida no ciclo seguinte, não aos 20 min das contas paradas");
  assert.equal(ctx.store.state.accounts["2"].usageFetchedAt, ctx.clock.t);

  // 2) O pior caso: a troca sai depois de duas leituras seguidas da conta em uso e há outra conta na vez — essa
  //    passa na frente (é o piso das outras) e a conta nova vem em seguida.
  ctx = setup(t);
  await addAccounts(ctx, 4);
  settled(ctx);
  setUsage(ctx, 1, { session: 80, ago: NEAR }); // em uso, perto da linha, na vez
  setUsage(ctx, 2, { ago: 15 * MIN }); // o destino: leitura de 15 min (velha para uma conta em uso)
  setUsage(ctx, 3, { weekly: 60, ago: 5 * MIN });
  setUsage(ctx, 4, { weekly: 60, ago: IDLE - NEAR - 2 * TICK_MS }); // entra na vez logo depois da 2ª leitura da conta 1
  d1 = addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "auto" });

  await run(ctx, TICK_MS, [d1]); // 1ª leitura da conta 1: 80%
  setRemote(ctx, 1, { session: 95 });
  await run(ctx, NEAR, [d1]); // 2ª leitura, 2,5 min depois: 95% → troca
  assert.deepEqual([readOrder(ctx), d1.assigned], [[1, 1], 2]);
  const switchedAt = ctx.clock.t;
  await run(ctx, 2 * TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [1, 1, 4, 2]);
  assert.equal(ctx.store.state.accounts["2"].usageFetchedAt, switchedAt + 2 * TICK_MS);
});

// ------------------------------------------------------------------ 23 contas

/**
 * 23 contas, um dispositivo ativo na conta 12 com a sessão parada em `session`%: 3 h para entrar em regime e 3 h
 * medidas. → o que foi visto nas 3 h.
 */
async function steady23(t, session) {
  const ctx = setup(t);
  await addAccounts(ctx, 23);
  settled(ctx);
  fastSave(ctx);
  for (let n = 1; n <= 23; n++) setUsage(ctx, n, n === 12 ? { session } : {});
  const d1 = addDevice(ctx.engine, "d1", { assigned: 12, lastSeen: ctx.clock.t, lastSwitchBy: "manual" });
  const acc = ctx.store.state.accounts["12"];
  const others = Object.values(ctx.store.state.accounts).filter((a) => a.number !== 12);

  await run(ctx, 3 * HOUR, [d1]);
  const from = ctx.clock.t;
  const seen = { oldestInUse: 0, staleCycles: 0, oldestIdle: 0, fewestFresh: others.length };
  await run(ctx, 3 * HOUR, [d1], {
    after: (now) => {
      seen.oldestInUse = Math.max(seen.oldestInUse, now - acc.usageFetchedAt);
      // O mesmo teste do decide(): leitura "stale" da conta ativa = "sem decisão por enquanto".
      if (windows(ctx.engine.publicList("d1").accounts.find((a) => a.number === 12)).stale) seen.staleCycles += 1;
      const ages = others.map((a) => now - a.usageFetchedAt);
      seen.oldestIdle = Math.max(seen.oldestIdle, ...ages);
      seen.fewestFresh = Math.min(seen.fewestFresh, ages.filter((ms) => ms <= CAND_STALE_SEC * SEC).length);
    },
  });
  const rs = reads(ctx).filter((r) => r.t > from);
  const perHour = [0, 1, 2].map((h) => rs.filter((r) => r.t > from + h * HOUR && r.t <= from + (h + 1) * HOUR).length);
  assert.equal(d1.assigned, 12, "nenhuma troca: a conta ficou abaixo da linha o tempo todo");
  return { ...seen, perHour, inUse: rs.filter((r) => r.n === 12).length, gaps: gapsOf(ctx, 12, from), neverRead: others.filter((a) => !rs.some((r) => r.n === a.number)).length };
}

test("uso: 23 contas, uma em uso longe da linha — a leitura dela nunca passa dos 10 min (antes: 42,5 min, velha demais para decidir metade do tempo)", async (t) => {
  const s = await steady23(t, 10);
  assert.deepEqual(s.perHour, [24, 24, 24], "o orçamento é o mesmo: 24 por hora");
  assert.deepEqual([...new Set(s.gaps)], [FAR]);
  assert.ok(s.oldestInUse < FAR, `leitura mais velha da conta em uso: ${s.oldestInUse / MIN} min`);
  assert.ok(s.oldestInUse < STALE_USAGE_SEC * SEC);
  assert.equal(s.staleCycles, 0, "em nenhum ciclo o decide() ficou sem decidir por leitura velha");
  // As outras 22 ficam com 18 leituras por hora: cada uma a cada ~73 min, e pelo menos 18 com leitura de menos de 1 h.
  assert.equal(s.inUse, 3 * 6);
  assert.equal(s.neverRead, 0);
  assert.ok(s.oldestIdle <= 75 * MIN, `leitura mais velha de uma conta fora de uso: ${s.oldestIdle / MIN} min`);
  assert.ok(s.fewestFresh >= 18, `contas fora de uso com leitura de menos de 1 h: ${s.fewestFresh}`);
});

test("uso: 23 contas, uma em uso perto da linha — a leitura dela nunca passa dos 5 min e as outras continuam sendo lidas", async (t) => {
  const s = await steady23(t, 80);
  assert.deepEqual(s.perHour, [24, 24, 24]);
  // Duas leituras dela, uma de outra conta: intervalos de 2,5 e 5 min.
  assert.deepEqual([...new Set(s.gaps)].sort((a, b) => a - b), [SLOT, 2 * SLOT]);
  assert.ok(s.oldestInUse < 2 * SLOT, `leitura mais velha da conta em uso: ${s.oldestInUse / MIN} min`);
  assert.equal(s.staleCycles, 0);
  // As outras 22 ficam com 8 leituras por hora: cada uma a cada 2 h 45 min — e as 8 mais recentes têm menos de 1 h.
  assert.equal(s.inUse, 3 * 16);
  assert.equal(s.neverRead, 0);
  assert.ok(s.oldestIdle <= 3 * 22 * SLOT, `leitura mais velha de uma conta fora de uso: ${s.oldestIdle / MIN} min`);
  assert.ok(s.fewestFresh >= 8, `contas fora de uso com leitura de menos de 1 h: ${s.fewestFresh}`);
});

test("uso: 23 contas e um serviço que não avisa o limite — a troca sai poucos minutos depois de a conta passar da linha, antes dos 100%", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 23);
  settled(ctx);
  fastSave(ctx);
  for (let n = 1; n <= 23; n++) setUsage(ctx, n, n === 12 ? { session: 60 } : {});
  const d1 = addDevice(ctx.engine, "hermes", { assigned: 12, lastSeen: ctx.clock.t, lastSwitchBy: "auto" });
  // Batimento de verdade a cada 30 s (serviço em uso) — e nunca um limitHit: quem troca é só a leitura de uso.
  let beats = 0;
  const beat = async () => {
    if (beats++ % 2 === 0) await ctx.engine.heartbeat("hermes", { models: [] });
  };
  await run(ctx, 2 * HOUR, [], { before: beat }); // regime, com a conta longe da linha
  assert.equal(d1.assigned, 12);

  // A sessão da conta sobe 1 ponto por minuto a partir de 60%: fica "perto" aos 75% (15 min) e passa da linha de 90% aos 30 min.
  const T0 = ctx.clock.t;
  const truth = (now) => Math.min(100, 60 + (now - T0) / MIN);
  const crossedAt = T0 + 30 * MIN;
  let staleCycles = 0;
  let switchedAt = null;
  await run(ctx, HOUR, [], {
    before: async (now) => {
      if (switchedAt === null) setRemote(ctx, 12, { session: truth(now) });
      await beat();
    },
    after: (now) => {
      if (switchedAt !== null) return;
      if (d1.assigned !== 12) switchedAt = now;
      else if (windows(ctx.engine.publicList("hermes").accounts.find((a) => a.number === 12)).stale) staleCycles += 1;
    },
  });

  assert.notEqual(switchedAt, null, "trocou de conta");
  assert.equal(staleCycles, 0, "a leitura da conta em uso nunca ficou velha demais para decidir");
  // Perto da linha a conta é lida a cada 2,5 ou 5 min: a troca sai no máximo 5 min depois de a linha passar.
  const delay = switchedAt - crossedAt;
  assert.ok(delay >= 0 && delay <= 2 * SLOT + TICK_MS, `a troca saiu ${delay / MIN} min depois da linha`);
  assert.ok(truth(switchedAt) < 100, `sessão de verdade na hora da troca: ${truth(switchedAt)}%`);
  assert.match(ctx.store.state.history.find((h) => h.kind === "switch").text, /^Trocou da conta 12 para a conta \d+: sessão em 9\d% \(linha 90%\)$/);
  // A conta nova (com leitura de até 1 h atrás) é lida logo: no máximo duas leituras do orçamento (5 min) depois da troca.
  const firstRead = reads(ctx).find((r) => r.n === d1.assigned && r.t > switchedAt);
  assert.ok(firstRead && firstRead.t - switchedAt <= 2 * SLOT + TICK_MS, `primeira leitura da conta nova: ${firstRead ? (firstRead.t - switchedAt) / MIN : "nunca"} min depois da troca`);
  assert.deepEqual(blockedTexts(ctx), [], "em nenhum momento faltou conta de destino");
});

test("uso: 23 contas e o Fable da conta em uso subindo rápido a partir de 89% (o caso de 21/11 14:03) — a troca sai na linha de 95%, antes dos 100%", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 23);
  settled(ctx);
  fastSave(ctx);
  await ctx.engine.setRules({ rules: { onModelLimit: "switchAccount" } }); // trocar de conta para continuar no modelo
  for (let n = 1; n <= 23; n++) setUsage(ctx, n, { models: { Fable: n === 12 ? 40 : 20 } });
  const d1 = addDevice(ctx.engine, "vscode", { assigned: 12, lastSeen: ctx.clock.t, lastSwitchBy: "auto" });
  let beats = 0;
  const beat = async () => {
    if (beats++ % 2 === 0) await ctx.engine.heartbeat("vscode", { models: [] });
  };
  await run(ctx, 2 * HOUR, [], { before: beat }); // regime, com a conta longe das linhas
  assert.equal(d1.assigned, 12);

  // A conta aparece com o Fable em 89% (lido agora) e ele sobe 1,2 ponto por minuto: passa da linha de 95% em 5 min
  // e bateria 100% em pouco mais de 9. Com a faixa de 5 pontos (até a 2.5.5), 89% era "longe": a leitura seguinte
  // só viria em 10 min, depois dos 100%.
  setUsage(ctx, 12, { models: { Fable: 89 } });
  const T0 = ctx.clock.t;
  const truth = (now) => Math.min(100, 89 + (1.2 * (now - T0)) / MIN);
  let switchedAt = null;
  await run(ctx, 30 * MIN, [], {
    before: async (now) => {
      if (switchedAt === null) setRemote(ctx, 12, { models: { Fable: truth(now) } });
      await beat();
    },
    after: (now) => {
      if (switchedAt === null && d1.assigned !== 12) switchedAt = now;
    },
  });

  assert.notEqual(switchedAt, null, "trocou de conta");
  assert.ok(truth(switchedAt) < 100, `Fable de verdade na hora da troca: ${truth(switchedAt)}%`);
  assert.ok(switchedAt - T0 <= 3 * SLOT + TICK_MS, `a troca saiu ${(switchedAt - T0) / MIN} min depois de a conta aparecer com 89%`);
  assert.match(ctx.store.state.history.find((h) => h.kind === "switch").text, /^Trocou da conta 12 para a conta \d+: Fable em 9\d% \(linha 95%\)$/);
  // Nesse tempo a conta foi lida a cada 2,5 min (perto da linha), não a cada 10.
  const mine = reads(ctx).filter((r) => r.n === 12 && r.t > T0 && r.t <= switchedAt);
  assert.ok(mine.length >= 2, `leituras da conta em uso até a troca: ${mine.length}`);
  assert.deepEqual(blockedTexts(ctx), [], "em nenhum momento faltou conta de destino");
});

// ------------------------------------------------------------------ orçamento

test("uso: nenhuma hora corrida passa do orçamento + 6 — nem a primeira depois de subir, nem depois de reiniciar", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 23); // servidor novo: as 23 marcadas para ler logo, nenhuma leitura ainda
  fastSave(ctx);
  const d1 = addDevice(ctx.engine, "d1", { assigned: 12, lastSeen: ctx.clock.t, lastSwitchBy: "manual" });
  const times = () => reads(ctx).map((r) => r.t);
  const count = (from, to) => times().filter((x) => x > from && x <= to).length;

  await run(ctx, 3 * HOUR, [d1]);
  const first = count(START, START + HOUR);
  assert.ok(first > BUDGET && first <= BUDGET + BURST, `leituras na primeira hora: ${first} (antes: 47)`);
  assert.equal(count(START, START + 2 * MIN), BURST, "de saída, só as 6 guardadas");
  assert.deepEqual([1, 2].map((h) => count(START + h * HOUR, START + (h + 1) * HOUR)), [24, 24], "depois, o orçamento: 24 por hora");
  assert.ok(maxRolling(times()) <= BUDGET + BURST, `maior janela de 60 min: ${maxRolling(times())}`);

  // Reinício (um deploy): motor novo sobre o mesmo cofre. O balde recomeça com as 6 guardadas, não com a hora inteira.
  const restartedAt = ctx.clock.t;
  ctx.engine = ctx.newEngine();
  await run(ctx, 2 * HOUR, [d1]);
  assert.ok(count(restartedAt, restartedAt + 10 * MIN) <= BURST + 4, `leituras nos 10 min depois do reinício: ${count(restartedAt, restartedAt + 10 * MIN)} (antes: 21)`);
  const after = count(restartedAt, restartedAt + HOUR);
  assert.ok(after > BUDGET && after <= BUDGET + BURST, `leituras na hora depois do reinício: ${after} (antes: 47)`);
  assert.ok(maxRolling(times()) <= BUDGET + BURST, `maior janela de 60 min, contando antes e depois do reinício: ${maxRolling(times())}`);
  // O reinício não mexe no ritmo da conta em uso: continua de 10 em 10 min.
  assert.deepEqual([...new Set(gapsOf(ctx, 12, restartedAt))], [FAR]);
});

test("uso: o balde guarda no máximo 6 leituras — ou o orçamento de 1 hora, se o USAGE_MAX_PER_HOUR for menor que 6", async (t) => {
  const budget = (ctx) => ctx.engine.status().usageBudget;

  // Padrão (24 por hora): 6 guardadas, mesmo depois de horas sem ter o que ler.
  let ctx = setup(t);
  assert.deepEqual(budget(ctx), { perHour: 24, available: 6 });
  ctx.clock.t += 5 * HOUR;
  assert.deepEqual(budget(ctx), { perHour: 24, available: 6 });
  await addAccounts(ctx, 8); // 8 contas marcadas para ler logo
  await run(ctx, 2 * MIN);
  assert.equal(reads(ctx).length, 6, "as 6 guardadas saem em seguida; a 7ª espera o orçamento");
  await run(ctx, 2 * SLOT);
  assert.equal(reads(ctx).length, 8);
  assert.deepEqual(readOrder(ctx), [1, 2, 3, 4, 5, 6, 7, 8]);

  // Orçamento menor que 6 (3 por hora): guarda só o de 1 hora, como antes.
  ctx = setup(t, { env: { USAGE_MAX_PER_HOUR: "3" } });
  assert.deepEqual(budget(ctx), { perHour: 3, available: 3 });
  ctx.clock.t += 5 * HOUR;
  assert.deepEqual(budget(ctx), { perHour: 3, available: 3 });
  await addAccounts(ctx, 8);
  await run(ctx, 19 * MIN);
  assert.equal(reads(ctx).length, 3);
  await run(ctx, 2 * MIN); // 3 por hora = uma a cada 20 min
  assert.equal(reads(ctx).length, 4);

  // Outros valores (motores novos sobre o mesmo cofre). 60 por hora: o teto continua em 6. 1,5 por hora: guarda 1,5.
  // Valor que não serve: vale o padrão (24 por hora, com 6 guardadas).
  const withBudget = (value) => {
    const engine = ctx.newEngine({ USAGE_MAX_PER_HOUR: value });
    const fresh = engine.status().usageBudget;
    ctx.clock.t += 5 * HOUR;
    assert.deepEqual(engine.status().usageBudget, fresh, `USAGE_MAX_PER_HOUR="${value}": depois de 5 h parado guarda o mesmo`);
    return fresh;
  };
  assert.deepEqual(withBudget("60"), { perHour: 60, available: 6 });
  assert.deepEqual(withBudget("1.5"), { perHour: 1.5, available: 1 });
  for (const bad of ["", "abc", "0", "-5"]) assert.deepEqual(withBudget(bad), { perHour: 24, available: 6 }, `USAGE_MAX_PER_HOUR="${bad}"`);
});

// ------------------------------------------------------------------ 429 e falhas

test("uso: o 429 continua parando todas as leituras (marcada, em uso e as outras), e a espera de uma falha vale para a conta em uso", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  settled(ctx);
  setUsage(ctx, 1, { session: 80, ago: 3 * MIN }); // em uso, perto da linha, na vez
  setUsage(ctx, 2); // lida agora: só a marca de "ler logo" a põe na vez
  setUsage(ctx, 3, { ago: 30 * MIN }); // na vez
  const d1 = addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "manual" });
  const acc = ctx.store.state.accounts["1"];
  ctx.engine.pollSoon.add(2);
  ctx.fake.usageReplies.push({ status: 429, headers: { "retry-after": "60" }, body: { error: { type: "rate_limit_error" } } });

  await run(ctx, TICK_MS, [d1]);
  const pausedAt = ctx.clock.t;
  assert.deepEqual(readOrder(ctx), [2]);
  assert.equal(ctx.engine.pausedUntil, pausedAt + 10 * MIN, "Retry-After de 60 s: vale o mínimo de 10 min");
  assert.equal(ctx.store.state.accounts["2"].usageError, null, "429 é do orçamento, não da conta");

  await run(ctx, 10 * MIN - TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [2], "pausado: nem a conta em uso perto da linha é lida");
  await run(ctx, 2 * TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [2, 1, 3], "acabou a pausa: a conta em uso primeiro, depois a mais atrasada");

  // Leitura da conta em uso que falha (erro do servidor): espera 2 min, depois 5 — a pressa de estar perto da linha
  // não passa por cima da espera.
  await run(ctx, NEAR - 2 * TICK_MS, [d1]); // um ciclo antes da próxima leitura da conta 1
  ctx.fake.usageReplies.push({ status: 500 }, { status: 500 });
  await run(ctx, TICK_MS, [d1]);
  const failedAt = ctx.clock.t;
  assert.deepEqual(readOrder(ctx), [2, 1, 3, 1]);
  assert.equal(acc.usageError, "transient");
  assert.equal(acc.pollBackoffUntil, failedAt + 2 * MIN);
  await run(ctx, 2 * MIN - TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [2, 1, 3, 1], "dentro da espera");
  await run(ctx, TICK_MS, [d1]);
  assert.deepEqual(readOrder(ctx), [2, 1, 3, 1, 1]);
  assert.equal(acc.pollBackoffUntil, ctx.clock.t + 5 * MIN);
  await run(ctx, 5 * MIN, [d1]);
  assert.deepEqual(readOrder(ctx).slice(5), [1], "depois da espera, lê e volta ao normal");
  assert.equal(acc.usageError, null);
  assert.equal(acc.usage.fiveHour.pct, 80);
});

// ------------------------------------------------------------------ só na memória

test("uso: a contagem das leituras seguidas e o balde ficam só na memória — nada novo vai para o cofre", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  const keysOf = (state) => ({ top: Object.keys(state).sort(), account: Object.keys(state.accounts["1"]).sort() });
  const before = keysOf(ctx.disk());
  for (const n of [1, 2, 3]) setUsage(ctx, n, n === 1 ? { session: 80 } : {});
  const d1 = addDevice(ctx.engine, "d1", { assigned: 1, lastSeen: ctx.clock.t, lastSwitchBy: "manual" });

  await run(ctx, 30 * MIN, [d1]); // o cofre grava de verdade a cada leitura
  assert.ok(reads(ctx).length > 10);
  assert.ok(ctx.engine.activeStreak > 0, "o motor está contando as leituras seguidas da conta em uso");
  const state = ctx.disk();
  assert.deepEqual(keysOf(state), before, "os mesmos campos de antes, no cofre e em cada conta");
  assert.doesNotMatch(JSON.stringify(state), /streak|burst|bucket/i);

  // Motor novo sobre o mesmo cofre (reinício): a contagem e o balde recomeçam.
  const again = ctx.newEngine();
  assert.equal(again.activeStreak, 0);
  assert.deepEqual(again.status().usageBudget, { perHour: 24, available: 6 });
});
