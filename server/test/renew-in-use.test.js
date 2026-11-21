"use strict";
// Testes da renovação da conta em uso (server/src/engine.js: holders, refreshStep, drainStep, renewTarget, deliver).
//
// O caso de 21/11/2026 09:53: o servidor renovou o login da conta em uso, a Anthropic cancelou o acesso antigo na
// hora e o serviço só buscou o novo 19 s depois — três conversas do Claude Code pararam com "OAuth token revoked".
// A Anthropic de mentira daqui faz como a de verdade: renovar CANCELA o acesso anterior da conta. Os serviços de
// mentira fazem como a extensão e o cliente do Hermes: falam com o servidor de tempos em tempos e só então buscam
// o acesso novo. A pergunta de cada teste é a mesma: em algum momento um serviço presente ficou com um acesso
// cancelado na mão?
//
//   node --test server/test/renew-in-use.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { createAnthropic, CLIENT_ID } = require("../src/anthropic");
const { Engine, TICK_MS } = require("../src/engine");

const TOKEN_URL = "https://anthropic.falsa/v1/oauth/token";
const API = "https://api.anthropic.falsa";
const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-14T12:00:00Z");

// Os números da regra (do engine.js, com REFRESH_AHEAD_MIN = 120), conferidos aqui pelo comportamento.
const AHEAD = 120 * MIN; // conta que ninguém segura renova quando falta menos que isso
const DRAIN = 60 * MIN; // conta que alguém segura: abaixo disso o motor tira os serviços dela
const FLOOR = 30 * MIN; // ...e abaixo disso renova assim mesmo
const GRACE = 3 * MIN + 15 * SEC; // depois de buscar outra conta, a anterior segue segurada por 3 min (+ um ciclo)
const LIFE = 8 * HOUR; // vida do acesso

function reply(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const email = (n) => `c${String(n).padStart(2, "0")}@x.com`;

/** Anthropic de mentira em que renovar cancela o acesso anterior da conta (como a de verdade). */
class FakeAnthropic {
  constructor(now) {
    this.now = now;
    this.seq = 0;
    this.people = new Map(); // email → { uuid, email, orgUuid, usage }
    this.access = new Map(); // access token → { email, expiresAt, revoked }
    this.refreshTokens = new Map(); // refresh token → { email, spent }
    this.refreshes = []; // { email, t }
    this.fetch = this.fetch.bind(this);
  }

  person(e) {
    if (!this.people.has(e)) this.people.set(e, { uuid: `uuid-${e}`, email: e, orgUuid: "org-1", usage: rawUsage() });
    return this.people.get(e);
  }

  issue(e) {
    const n = ++this.seq;
    const accessToken = `sk-ant-oat01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const refreshToken = `sk-ant-ort01-falso-${n}-${crypto.randomBytes(6).toString("hex")}`;
    const expiresAt = this.now() + LIFE;
    for (const a of this.access.values()) if (a.email === e) a.revoked = true; // o acesso antigo morre aqui
    this.access.set(accessToken, { email: e, expiresAt, revoked: false });
    this.refreshTokens.set(refreshToken, { email: e, spent: false });
    return { accessToken, refreshToken, expiresAt };
  }

  login(e) {
    this.person(e);
    const tok = this.issue(e);
    return {
      claudeAiOauth: { ...tok, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x" },
      oauthAccount: { accountUuid: `uuid-${e}`, emailAddress: e, organizationUuid: "org-1", organizationName: `Org de ${e}` },
    };
  }

  /** O acesso ainda serve para chamar o Claude agora? */
  works(token) {
    const a = this.access.get(token);
    return !!a && !a.revoked && a.expiresAt > this.now();
  }

  async fetch(url, init = {}) {
    if (url === TOKEN_URL) {
      const body = JSON.parse(init.body);
      const rt = this.refreshTokens.get(body.refresh_token);
      if (!rt || rt.spent || body.client_id !== CLIENT_ID) return reply(400, { error: "invalid_grant" });
      rt.spent = true;
      this.refreshes.push({ email: rt.email, t: this.now() });
      const tok = this.issue(rt.email);
      const p = this.people.get(rt.email);
      return reply(200, {
        token_type: "Bearer",
        access_token: tok.accessToken,
        refresh_token: tok.refreshToken,
        expires_in: LIFE / 1000,
        scope: "user:inference user:profile",
        account: { uuid: p.uuid, email_address: p.email },
        organization: { uuid: p.orgUuid },
      });
    }
    const token = String((init.headers || {}).Authorization || "").replace(/^Bearer /, "");
    const a = this.access.get(token);
    if (url === `${API}/api/oauth/usage`) {
      if (!this.works(token)) return reply(401, { error: { type: "authentication_error" } });
      return reply(200, this.people.get(a.email).usage);
    }
    if (url === `${API}/api/oauth/profile`) {
      if (!this.works(token)) return reply(401, {});
      const p = this.people.get(a.email);
      return reply(200, { account: { uuid: p.uuid, email: p.email }, organization: { uuid: p.orgUuid } });
    }
    throw new Error(`rede de verdade bloqueada no teste: ${url}`);
  }
}

/** Uso cru da API: sem janela de 5 h aberta, semanal baixo e a mesma virada em todas (nada pede troca por uso). */
function rawUsage({ session = null, weekly = 20, weeklyResetIn = 6 * DAY } = {}) {
  return {
    five_hour: session === null ? null : { utilization: session, resets_at: new Date(START + 2 * DAY).toISOString() },
    seven_day: { utilization: weekly, resets_at: new Date(START + weeklyResetIn).toISOString() },
    limits: [],
  };
}

function setup(t, { rules = {}, autoSwitch = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-renova-"));
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
  const newEngine = () => new Engine({ store, anthropic, now, log, env: { USAGE_MAX_PER_HOUR: "24", REFRESH_AHEAD_MIN: "120" } });
  const ctx = { store, clock, fake, logs, newEngine, engine: newEngine(), services: [], broken: [] };
  store.state.diag.oldTokenValidAfterRefresh = false; // o que o servidor de verdade mediu em 15/11/2026
  store.state.rules = { devicePlacement: "together", cooldownMin: 0, ...rules };
  store.state.autoSwitch = autoSwitch;
  return ctx;
}

async function addAccounts(ctx, n) {
  for (let i = 1; i <= n; i++) assert.deepEqual(await ctx.engine.addLogin(ctx.fake.login(email(i))), { number: i, created: true });
}

let deviceSeq = 0;
/**
 * Um serviço de mentira. every = de quanto em quanto tempo ele fala com o servidor; beats = manda batimento (a
 * extensão do VS Code, a cada 30 s) ou só lê o estado (o cliente do Hermes parado, a cada 2 min). Como os de
 * verdade, só busca o acesso quando o estado diz que a conta ou o gen mudaram.
 */
function addService(ctx, id, { every = 30 * SEC, beats = true, offset = 0 } = {}) {
  ctx.store.state.devices[id] = {
    id,
    name: `PC ${id}`,
    platform: "linux",
    tokenHash: "0".repeat(64),
    createdAt: START + ++deviceSeq,
    lastSeen: 0,
    assigned: null,
    lastSwitchAt: 0,
    models: [],
  };
  const s = { id, every, beats, next: ctx.clock.t + offset, token: null, applied: null, on: true };
  ctx.services.push(s);
  return s;
}

/** Um contato do serviço: batimento (ou só o estado) e, se a conta ou o gen mudaram, busca o acesso. */
async function contact(ctx, s) {
  const { engine } = ctx;
  engine.touch(s.id);
  const st = s.beats ? await engine.heartbeat(s.id, { models: [] }) : engine.stateFor(s.id);
  const c = st.credential;
  if (!c) return;
  const a = s.applied;
  if (a && a.number === c.number && a.gen === c.gen && a.expiresAt === c.expiresAt) return;
  const got = await engine.credentialFor(s.id);
  if (!got) return;
  s.token = got.claudeAiOauth.accessToken;
  s.applied = { number: got.number, gen: got.gen, expiresAt: got.claudeAiOauth.expiresAt };
}

/** Anota todo serviço ligado que está, neste instante, com um acesso que não serve mais. */
function checkTokens(ctx, when) {
  for (const s of ctx.services) {
    if (!s.on || !s.token) continue;
    if (!ctx.fake.works(s.token)) ctx.broken.push({ id: s.id, account: s.applied.number, t: ctx.clock.t, when });
  }
}

/**
 * Anda o relógio de 15 em 15 s (o ciclo do motor) por `ms`. A cada passo: o ciclo do motor, a conferência dos
 * acessos (logo depois do ciclo é o pior momento: é nele que as renovações acontecem) e os contatos da vez.
 */
async function run(ctx, ms) {
  const end = ctx.clock.t + ms;
  while (ctx.clock.t < end) {
    ctx.clock.t += TICK_MS;
    await ctx.engine.tick();
    checkTokens(ctx, "depois do ciclo");
    for (const s of ctx.services) {
      if (!s.on || ctx.clock.t < s.next) continue;
      await contact(ctx, s);
      s.next = ctx.clock.t + s.every;
    }
    checkTokens(ctx, "depois dos contatos");
  }
}

/** Anda de ciclo em ciclo até `done()`; se não acontecer em `max`, o teste falha (nunca gira sem fim). */
async function runUntil(ctx, done, max = 9 * HOUR) {
  const end = ctx.clock.t + max;
  while (!done()) {
    assert.ok(ctx.clock.t < end, "o que o teste esperava não aconteceu no prazo");
    await run(ctx, TICK_MS);
  }
}

const acc = (ctx, n) => ctx.store.state.accounts[String(n)];
const dev = (ctx, id) => ctx.store.state.devices[id];
const left = (ctx, n) => acc(ctx, n).cred.expiresAt - ctx.clock.t;
const history = (ctx) => ctx.store.state.history.map((h) => h.text);
const renewals = (ctx, n) => ctx.fake.refreshes.filter((r) => r.email === email(n));

// ------------------------------------------------------------------ o caso de 21/11

test("juntos: em 20 h de uso ninguém fica com acesso cancelado — a conta em uso só renova depois que os serviços saem dela", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  addService(ctx, "vscode"); // batimento a cada 30 s
  addService(ctx, "cameras", { every: 4 * MIN, offset: 45 * SEC }); // batimento a cada 4 min (ainda ativo)
  addService(ctx, "hermes", { every: 2 * MIN, beats: false, offset: 20 * SEC }); // parado: só lê o estado
  await ctx.engine.heartbeat("hermes", { models: [] }); // esteve ativo uma vez (ganhou conta); daqui em diante, parado

  await run(ctx, 20 * HOUR);

  assert.deepEqual(ctx.broken, [], "nenhum serviço ficou com acesso cancelado ou vencido");
  // Todas as contas renovaram pelo menos duas vezes em 20 h (fora a renovação da entrada) e nenhuma ficou para trás.
  for (const n of [1, 2, 3]) {
    assert.ok(renewals(ctx, n).length >= 3, `conta ${n} renovou ${renewals(ctx, n).length}x`);
    assert.ok(left(ctx, n) > FLOOR, `conta ${n} com o acesso longe de vencer`);
  }
  // As trocas para renovar ficaram no histórico, com o motivo.
  const moves = history(ctx).filter((x) => x.includes("vai ser renovado"));
  assert.ok(moves.length >= 2, `trocas para renovar: ${moves.length}`);
  assert.ok(moves.some((x) => /^Serviços trocados juntos para a conta \d+: o login da conta \d+ vai ser renovado — PC vscode e PC cameras$/.test(x)), moves.join(" | "));
  assert.ok(moves.some((x) => /^Trocou da conta \d+ para a conta \d+: o login da conta \d+ vai ser renovado$/.test(x)), "o serviço parado troca sozinho");
  // Os três terminam na mesma conta (o parado acompanha o grupo).
  assert.equal(dev(ctx, "cameras").assigned, dev(ctx, "vscode").assigned);
  assert.equal(dev(ctx, "hermes").assigned, dev(ctx, "vscode").assigned);
  assert.ok(!ctx.logs.some((l) => l.includes("renovo assim mesmo")), "nunca precisou renovar com serviço na conta");
});

test("a conta em uso não renova na antecedência normal; as paradas renovam como sempre", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 2);
  const s = addService(ctx, "a");
  await run(ctx, MIN);
  assert.equal(s.applied.number, 1);
  const gen1 = acc(ctx, 1).gen;
  const gen2 = acc(ctx, 2).gen;

  await run(ctx, 6 * HOUR + MIN); // faltam menos de 120 min para as duas
  assert.ok(left(ctx, 1) < AHEAD && left(ctx, 1) > DRAIN);
  assert.equal(acc(ctx, 1).gen, gen1, "a conta 1 (em uso) não renovou");
  assert.equal(acc(ctx, 2).gen, gen2 + 1, "a conta 2 (parada) renovou na antecedência");
  assert.equal(dev(ctx, "a").assigned, 1, "e ninguém trocou ainda: até faltar 60 min, espera");
  const said = ctx.logs.filter((l) => l.includes("conta 1: adiada"));
  assert.equal(said.length, 1, "o log diz uma vez que adiou");
  assert.match(said[0], /PC a está com o acesso dela/);
  assert.deepEqual(ctx.broken, []);
});

test("faltando menos de 60 min o motor tira o serviço da conta; ela renova quando ele busca a conta nova, e até lá não é destino", async (t) => {
  // Conta 1 com a cota semanal zerando em menos de um dia: "aproveitar ao máximo" quer ficar nela, e voltar para
  // ela assim que puder (intervalo mínimo entre trocas zerado).
  const ctx = setup(t);
  await addAccounts(ctx, 2);
  ctx.fake.person(email(1)).usage = rawUsage({ weeklyResetIn: 20 * HOUR });
  const s = addService(ctx, "a");
  await run(ctx, 2 * MIN);
  assert.equal(s.applied.number, 1);
  const gen = acc(ctx, 1).gen;

  // Até 60 min antes de vencer: fica.
  await runUntil(ctx, () => left(ctx, 1) <= DRAIN + TICK_MS);
  assert.equal(dev(ctx, "a").assigned, 1);
  assert.equal(acc(ctx, 1).gen, gen);

  // Passou dos 60 min: sai no ciclo seguinte. (O serviço para de falar com o servidor por um instante, para dar
  // para ver o que acontece entre a troca e a busca do acesso novo. Segue ativo: o batimento vale 5 min.)
  s.next = Infinity;
  await run(ctx, 2 * TICK_MS);
  assert.equal(dev(ctx, "a").assigned, 2);
  assert.equal(history(ctx)[0], "Trocou da conta 1 para a conta 2: o login da conta 1 vai ser renovado");
  assert.equal(s.applied.number, 1, "ainda com o acesso da conta 1 na mão");
  // Enquanto ele não busca a conta 2, a conta 1 não renova e ninguém volta para ela — nem a regra "aproveitar ao
  // máximo", nem um pedido de "melhor conta".
  await run(ctx, MIN);
  assert.equal(acc(ctx, 1).gen, gen, "ainda segura a conta 1: não renova");
  assert.equal(dev(ctx, "a").assigned, 2, "e a regra de sempre não o leva de volta");
  assert.equal(ctx.engine.bestAccountFor(dev(ctx, "a")), 2, "a conta 1 não é destino enquanto não renovar");
  assert.ok(ctx.fake.works(s.token));

  // Buscou a conta nova: a conta 1 ainda fica segurada por 3 min (buscar não prova que ele gravou) e então renova.
  s.next = ctx.clock.t;
  await run(ctx, 2 * TICK_MS);
  assert.equal(s.applied.number, 2);
  assert.equal(acc(ctx, 1).gen, gen, "nos 3 min seguintes à busca, ainda não");
  assert.deepEqual(ctx.engine.holders(acc(ctx, 1)).map((d) => d.id), ["a"]);
  await run(ctx, GRACE);
  assert.equal(acc(ctx, 1).gen, gen + 1, "só então a conta 1 renovou");
  assert.ok(left(ctx, 1) > LIFE - MIN);
  // Renovada, ela volta a ser destino: a regra de sempre leva o serviço de volta, agora com acesso novo.
  await run(ctx, 25 * MIN);
  assert.equal(dev(ctx, "a").assigned, 1);
  assert.match(history(ctx)[0], /^Trocou da conta 2 para a conta 1: a cota semanal dela zera/);
  assert.equal(s.applied.gen, gen + 1);
  assert.deepEqual(ctx.broken, [], "em nenhum momento ficou com acesso cancelado");
});

test("serviço trocado que ainda não buscou a conta nova continua segurando a antiga", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 2);
  const s = addService(ctx, "a");
  await run(ctx, MIN);
  const gen = acc(ctx, 1).gen;
  await run(ctx, 6 * HOUR + 5 * MIN); // a conta 1 está na vez de renovar e o serviço está nela
  assert.equal(acc(ctx, 1).gen, gen);

  // Troca manual para a conta 2 (renovada há pouco). O serviço só vai buscar no próximo contato.
  s.next = Infinity;
  const r = await ctx.engine.switchDevice("a", 2);
  assert.equal(r.switched, true);
  assert.equal(s.applied.number, 1, "ainda com o acesso da conta 1 na mão");
  await ctx.engine.tick();
  await ctx.engine.tick();
  assert.equal(acc(ctx, 1).gen, gen, "a conta 1 não renova enquanto ele não buscar a 2");
  assert.ok(ctx.fake.works(s.token));

  await contact(ctx, s);
  assert.equal(s.applied.number, 2);
  assert.equal(dev(ctx, "a").heldBefore.number, 1, "a conta anterior fica anotada");
  await ctx.engine.tick();
  assert.equal(acc(ctx, 1).gen, gen, "buscou, mas por 3 min a conta 1 ainda conta como segurada");
  ctx.clock.t += GRACE;
  await ctx.engine.tick();
  assert.equal(acc(ctx, 1).gen, gen + 1, "passados os 3 min, a conta 1 renova");
  assert.ok(ctx.fake.works(s.token));
});

test("serviço sem contato (desligado) não segura a conta: ela renova na antecedência normal", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 2);
  const s = addService(ctx, "a");
  await run(ctx, MIN);
  assert.equal(s.applied.number, 1);
  const gen = acc(ctx, 1).gen;
  s.on = false; // fechou o VS Code
  await run(ctx, 6 * HOUR + MIN);
  assert.equal(acc(ctx, 1).gen, gen + 1, "sem ninguém presente nela, renova quando faltam 120 min");
  assert.equal(dev(ctx, "a").assigned, 1, "e ele continua atribuído à conta");
  // Ao voltar, o primeiro contato já busca o acesso novo.
  s.on = true;
  await contact(ctx, s);
  assert.equal(s.applied.gen, gen + 1);
  assert.ok(ctx.fake.works(s.token));
});

test("serviço calado há pouco (até 15 min) ainda segura a conta, mesmo já aparecendo como sem contato", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 1);
  const s = addService(ctx, "a");
  await run(ctx, MIN);
  const gen = acc(ctx, 1).gen;
  await runUntil(ctx, () => left(ctx, 1) <= AHEAD + 4 * MIN); // 4 min antes da hora de renovar
  s.next = Infinity; // o cliente pausou (ex.: depois de um 429): para de falar, mas segue com o acesso na mão
  await run(ctx, 12 * MIN);
  assert.equal(ctx.engine.presenceOf(dev(ctx, "a")).presence, "none", "na tela, já está sem contato");
  assert.ok(left(ctx, 1) < AHEAD);
  assert.equal(acc(ctx, 1).gen, gen, "calado há 12 min: ainda segura");
  await run(ctx, 4 * MIN);
  assert.equal(acc(ctx, 1).gen, gen + 1, "calado há mais de 15 min: a conta renova");
});

// ------------------------------------------------------------------ quando não dá para tirar

test("sem outra conta para onde ir: renova no piso de 30 min, com serviço nela, e o log avisa", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 1);
  const s = addService(ctx, "a");
  await run(ctx, MIN);
  const gen = acc(ctx, 1).gen;

  await runUntil(ctx, () => left(ctx, 1) <= FLOOR + TICK_MS);
  assert.equal(acc(ctx, 1).gen, gen, "até o piso, espera");
  assert.deepEqual(ctx.broken, []);
  assert.ok(!history(ctx).some((x) => x.includes("vai ser renovado")), "não há para onde trocar");

  await run(ctx, MIN);
  assert.equal(acc(ctx, 1).gen, gen + 1, "no piso renova assim mesmo");
  const warn = ctx.logs.filter((l) => l.includes("renovo assim mesmo"));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /conta 1: faltam 30 min para o acesso vencer e PC a ainda está com ele/);
  // É o buraco de sempre (o teste enxerga): o serviço ficou com o acesso cancelado até o contato seguinte.
  assert.ok(ctx.broken.length >= 1 && ctx.broken.every((b) => b.id === "a" && b.account === 1));
  assert.ok(ctx.fake.works(s.token), "e já buscou o novo");
  assert.equal(s.applied.gen, gen + 1);
});

test("as outras contas sem folga, com leitura velha ou também para renovar não servem de destino: ninguém sai", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 4);
  addService(ctx, "a");
  await run(ctx, 2 * MIN);
  const e = ctx.engine;
  const d = dev(ctx, "a");
  assert.equal(d.assigned, 1);
  const u = (n) => acc(ctx, n);
  const good = { fiveHour: null, sevenDay: { pct: 20, resetsAt: new Date(START + 6 * DAY).toISOString() } };
  const fresh = (n, usage = good) => Object.assign(u(n), { usage, usageFetchedAt: ctx.clock.t, usageError: null, lastGoodUsage: usage, lastGoodAt: ctx.clock.t });
  const target = () => e.renewTarget(d, e.recordsFor(d));
  // Acesso de 8 h que vence daqui a `ms` (renovado há 8 h - ms).
  const expiresIn = (n, ms) => {
    u(n).cred.expiresAt = ctx.clock.t + ms;
    u(n).lastRefreshAt = ctx.clock.t + ms - LIFE;
  };
  // A conta 1 (a do serviço) vence em 50 min; as outras três estão boas: vai para a de menor número.
  for (const n of [1, 2, 3, 4]) fresh(n);
  expiresIn(1, 50 * MIN);
  assert.equal(target(), 2);

  // 2: semanal acima da linha; 3: leitura de 2 h atrás; 4: acesso também para renovar (faltam 100 min).
  fresh(2, { fiveHour: null, sevenDay: { pct: 99, resetsAt: good.sevenDay.resetsAt } });
  Object.assign(u(3), { usageFetchedAt: ctx.clock.t - 2 * HOUR, lastGoodAt: ctx.clock.t - 2 * HOUR });
  expiresIn(4, 100 * MIN);
  assert.equal(target(), null, "nenhuma serve");
  assert.equal(e.drainStep(), false, "e ninguém sai da conta 1");
  assert.equal(d.assigned, 1);

  // Acesso que não está na vez de renovar já serve; mas a preferência é por quem tem mais de 4 h pela frente.
  expiresIn(4, 3 * HOUR);
  assert.equal(target(), 4);
  fresh(3);
  assert.equal(target(), 3, "a 3 tem quase 8 h pela frente; a 4, só 3 h");
  assert.equal(e.drainStep(), true);
  assert.equal(d.assigned, 3);
});

test("troca automática desligada: o motor não troca ninguém; a conta renova no piso", async (t) => {
  const ctx = setup(t, { autoSwitch: false });
  await addAccounts(ctx, 2);
  addService(ctx, "a");
  await run(ctx, MIN);
  const gen = acc(ctx, 1).gen;
  await run(ctx, 7 * HOUR + 20 * MIN); // faltam ~40 min
  assert.equal(dev(ctx, "a").assigned, 1, "ninguém trocou");
  assert.equal(acc(ctx, 1).gen, gen, "e ainda não renovou");
  await run(ctx, 12 * MIN);
  assert.equal(acc(ctx, 1).gen, gen + 1, "no piso renova");
  assert.equal(dev(ctx, "a").assigned, 1);
  assert.ok(!history(ctx).some((x) => x.includes("vai ser renovado")));
});

// ------------------------------------------------------------------ modos e papéis

test("separados: cada serviço sai da sua conta para uma livre, sem cancelar o acesso de ninguém", async (t) => {
  const ctx = setup(t, { rules: { devicePlacement: "separate" } });
  await addAccounts(ctx, 4);
  const a = addService(ctx, "a");
  const b = addService(ctx, "b", { offset: 10 * SEC });
  await run(ctx, 2 * MIN);
  assert.notEqual(a.applied.number, b.applied.number, "cada um numa conta");

  await run(ctx, 20 * HOUR);
  assert.deepEqual(ctx.broken, []);
  assert.notEqual(dev(ctx, "a").assigned, dev(ctx, "b").assigned, "continuam separados");
  const moves = history(ctx).filter((x) => x.includes("vai ser renovado"));
  assert.ok(moves.length >= 2 && moves.every((x) => /^Trocou da conta \d+ para a conta \d+: o login da conta \d+ vai ser renovado$/.test(x)), moves.join(" | "));
  for (const n of [1, 2, 3, 4]) assert.ok(left(ctx, n) > FLOOR, `conta ${n} com o acesso valendo`);
  assert.ok(!ctx.logs.some((l) => l.includes("renovo assim mesmo")));
});

test("juntos: serviço parado (só conectado) é tirado da conta sem virar quem define a conta do grupo", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  const h = addService(ctx, "hermes", { every: 2 * MIN, beats: false });
  // Sem ninguém ativo: o parado precisa de uma conta para começar (um batimento, como ao conectar).
  await ctx.engine.heartbeat("hermes", { models: [] });
  await run(ctx, 6 * MIN); // o batimento sai da janela de 5 min: fica só "conectado"
  assert.equal(ctx.engine.presenceOf(dev(ctx, "hermes")).presence, "connected");
  const first = h.applied.number;
  const gen = acc(ctx, first).gen;

  await run(ctx, 7 * HOUR + 10 * MIN);
  assert.notEqual(dev(ctx, "hermes").assigned, first, "saiu da conta que ia renovar");
  assert.equal(dev(ctx, "hermes").lastSwitchBy, "renew");
  assert.equal(acc(ctx, first).gen, gen + 1, "e ela renovou");
  assert.deepEqual(ctx.broken, []);

  // Chega um serviço ativo que já estava em outra conta por troca própria: é ele quem define a conta do grupo, e o
  // parado, quando volta a trabalhar, entra nela (a troca "renew" dele, mais nova, não puxa o grupo).
  const other = [1, 2, 3].find((n) => n !== dev(ctx, "hermes").assigned && n !== first);
  addService(ctx, "vscode");
  Object.assign(dev(ctx, "vscode"), { assigned: other, lastSwitchAt: ctx.clock.t - 2 * HOUR, lastSwitchBy: "auto" });
  await run(ctx, MIN);
  assert.equal(dev(ctx, "vscode").assigned, other, "o ativo fica onde estava");
  await ctx.engine.heartbeat("hermes", { models: [] });
  assert.equal(dev(ctx, "hermes").assigned, other, "o parado, ao voltar, entra na conta do grupo");
  assert.deepEqual(ctx.broken, []);
});

// ------------------------------------------------------------------ parecido com a instalação de verdade

test("23 contas, uso pesado por 36 h (troca por uso a cada ~45 min), quatro serviços juntos: ninguém fica com acesso cancelado e as trocas para renovar são poucas", async (t) => {
  const N = 23;
  const ctx = setup(t, { rules: { sessionPct: 90, weeklyPct: 96, cooldownMin: 5 } });
  await addAccounts(ctx, N);
  const vscode = addService(ctx, "vscode"); // batimento a cada 30 s: é ele que gasta a conta
  addService(ctx, "cameras", { every: 4 * MIN, offset: 45 * SEC });
  addService(ctx, "hermes", { every: 2 * MIN, beats: false, offset: 20 * SEC });
  addService(ctx, "stafy", { every: 150 * SEC, beats: false, offset: 70 * SEC });
  await ctx.engine.heartbeat("hermes", { models: [] });
  await ctx.engine.heartbeat("stafy", { models: [] });

  // Uso de mentira: a conta que o VS Code tem na mão gasta 0,5 ponto da sessão de 5 h a cada 15 s (90% em 45 min) e
  // um pouco do semanal. A sessão zera 5 h depois de abrir; o semanal zera na data de cada conta (espalhadas).
  const use = new Map();
  for (let n = 1; n <= N; n++) use.set(n, { sess: 0, since: null, weekly: 10 + n, reset: START + DAY + n * 6 * HOUR });
  const model = () => {
    const now = ctx.clock.t;
    for (const [n, u] of use) {
      if (u.since !== null && now - u.since >= 5 * HOUR) Object.assign(u, { sess: 0, since: null });
      if (now >= u.reset) Object.assign(u, { weekly: 0, reset: u.reset + 7 * DAY });
      if (vscode.applied && vscode.applied.number === n) {
        if (u.since === null) u.since = now;
        u.sess = Math.min(100, u.sess + 0.5);
        u.weekly = Math.min(100, u.weekly + 0.02);
      }
      ctx.fake.person(email(n)).usage = {
        five_hour: u.since === null ? null : { utilization: u.sess, resets_at: new Date(u.since + 5 * HOUR).toISOString() },
        seven_day: { utilization: u.weekly, resets_at: new Date(u.reset).toISOString() },
        limits: [],
      };
    }
  };

  const end = ctx.clock.t + 36 * HOUR;
  while (ctx.clock.t < end) {
    model();
    await run(ctx, TICK_MS);
  }

  assert.deepEqual(ctx.broken, [], "nenhum serviço ficou com acesso cancelado ou vencido");
  assert.ok(!ctx.logs.some((l) => l.includes("renovo assim mesmo")), "nunca precisou renovar com serviço na conta");
  const hist = ctx.logs.filter((l) => l.includes("[histórico] switch"));
  const byUse = hist.filter((l) => /sessão em \d+%/.test(l));
  const toRenew = hist.filter((l) => l.includes("Serviços trocados juntos") && l.includes("vai ser renovado"));
  assert.ok(byUse.length >= 30, `trocas por uso: ${byUse.length} (a simulação gastou as contas de verdade)`);
  assert.ok(toRenew.length <= 6, `trocas do grupo só para renovar: ${toRenew.length} em 36 h`);
  for (let n = 1; n <= N; n++) {
    assert.ok(left(ctx, n) > FLOOR, `conta ${n} com o acesso valendo`);
    assert.ok(acc(ctx, n).gen >= 5, `conta ${n} renovou ${acc(ctx, n).gen - 1}x em 36 h`);
  }
  t.diagnostic(`trocas por uso: ${byUse.length}; do grupo para renovar: ${toRenew.length}; individuais para renovar: ${hist.filter((l) => l.includes("vai ser renovado")).length - toRenew.length}; renovações: ${ctx.fake.refreshes.length}`);
});

// ------------------------------------------------------------------ reinício e atualização

test("reinício: quem segura cada conta está no cofre — o motor novo continua sem renovar a conta em uso", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 1); // uma conta só: sem troca possível, o que se vê é só o adiamento
  const s = addService(ctx, "a", { every: 2 * MIN, beats: false });
  await ctx.engine.heartbeat("a", { models: [] });
  await run(ctx, 6 * HOUR + 10 * MIN);
  const gen = acc(ctx, 1).gen;
  assert.equal(s.applied.gen, gen, "a conta em uso não renovou");
  assert.deepEqual(dev(ctx, "a").held, { number: 1, gen });

  // Servidor reinicia: motor novo no mesmo cofre. O contato fica só na memória, então o serviço volta como
  // "aguardando contato" — e mesmo assim conta como presente.
  await ctx.engine.stop();
  ctx.engine = ctx.newEngine();
  assert.equal(ctx.engine.presenceOf(dev(ctx, "a")).presence, "waiting");
  await ctx.engine.tick();
  assert.equal(acc(ctx, 1).gen, gen, "logo depois de subir, não renova a conta que o serviço segura");
  assert.ok(ctx.fake.works(s.token));
  await run(ctx, 10 * MIN);
  assert.equal(acc(ctx, 1).gen, gen);
  assert.deepEqual(ctx.broken, []);
});

test("atualização a partir da 2.5.4: start() dá por certo que cada serviço está com o acesso da conta dele", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  const mk = (id, more) => {
    ctx.store.state.devices[id] = { id, name: `PC ${id}`, platform: "linux", tokenHash: "0".repeat(64), createdAt: START + ++deviceSeq, lastSeen: 0, assigned: null, lastSwitchAt: 0, models: [], ...more };
  };
  mk("antigo", { assigned: 2, lastSeen: ctx.clock.t });
  mk("semconta", {});
  mk("jatinha", { assigned: 1, held: { number: 3, gen: 1 } });
  mk("morta", { assigned: 3 });
  acc(ctx, 3).dead = { reason: "relogin_required", at: ctx.clock.t };

  // É o start() que faz (sem ele a primeira renovação depois de atualizar ainda cancelaria o acesso de alguém).
  ctx.engine.start();
  assert.deepEqual(dev(ctx, "antigo").held, { number: 2, gen: acc(ctx, 2).gen });
  assert.equal(dev(ctx, "semconta").held, undefined);
  assert.deepEqual(dev(ctx, "jatinha").held, { number: 3, gen: 1 }, "quem já tem a marca fica como está");
  assert.equal(dev(ctx, "morta").held, undefined, "conta morta não entra");
  assert.deepEqual(ctx.engine.holders(acc(ctx, 2)).map((d) => d.id), ["antigo"]);
  assert.deepEqual(ctx.engine.holders(acc(ctx, 1)), []);
  await ctx.engine.stop();
  ctx.engine = ctx.newEngine(); // o relógio daqui é manual: os ciclos seguintes são chamados à mão

  // E vale de fato: a conta 2 não renova na antecedência enquanto o serviço antigo estiver presente.
  const gen = acc(ctx, 2).gen;
  ctx.clock.t += 6 * HOUR + MIN;
  dev(ctx, "antigo").lastSeen = ctx.clock.t;
  await ctx.engine.tick();
  assert.equal(acc(ctx, 2).gen, gen);
  assert.equal(acc(ctx, 1).gen, 2, "a conta 1, que ninguém segura, renovou");
});

test("deliver: o serviço fica marcado com a conta e o gen do acesso que recebeu, e a marca vai para o cofre", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 2);
  addService(ctx, "a");
  await ctx.engine.heartbeat("a", { models: [] });
  assert.equal(dev(ctx, "a").held, undefined, "antes de buscar o acesso, não segura nada");
  const c1 = await ctx.engine.credentialFor("a");
  assert.deepEqual(dev(ctx, "a").held, { number: c1.number, gen: c1.gen });
  // Já está no disco, sem esperar o ciclo: se o servidor cair agora, o motor novo sabe quem segura o quê.
  const { decrypt } = require("../src/store");
  const disk = () => decrypt(ctx.store.key, fs.readFileSync(ctx.store.file));
  assert.deepEqual(disk().devices.a.held, { number: c1.number, gen: c1.gen });
  // O estado mandado ao serviço não ganha campo novo, e a credencial continua sem refresh token.
  assert.equal(JSON.stringify(ctx.engine.stateFor("a")).includes("held"), false);
  assert.equal(JSON.stringify(c1).includes("refreshToken\""), false);

  // Acesso com menos de 30 min: o credentialFor renova antes de entregar, e a marca é a do acesso NOVO.
  const a = acc(ctx, c1.number);
  a.cred.expiresAt = ctx.clock.t + 10 * MIN;
  a.lastRefreshAt = ctx.clock.t + 10 * MIN - LIFE;
  const c2 = await ctx.engine.credentialFor("a");
  assert.equal(c2.gen, c1.gen + 1);
  assert.deepEqual(dev(ctx, "a").held, { number: c1.number, gen: c2.gen });
  assert.deepEqual(disk().devices.a.held, { number: c1.number, gen: c2.gen });
  assert.equal(dev(ctx, "a").heldBefore, undefined, "mesma conta: não há conta anterior para segurar");
});

// ------------------------------------------------------------------ quem pode sair e quem puxa o grupo

test("ou saem todos, ou ninguém: serviço que só pode usar esta conta faz a troca para renovar não acontecer", async (t) => {
  for (const restrictedIsActive of [false, true]) {
    const ctx = setup(t);
    await addAccounts(ctx, 3);
    addService(ctx, "a");
    const b = addService(ctx, "b", restrictedIsActive ? { offset: 10 * SEC } : { every: 2 * MIN, beats: false, offset: 10 * SEC });
    ctx.store.state.accountDevices = { 2: ["a"], 3: ["a"] }; // o serviço b só pode usar a conta 1
    await ctx.engine.heartbeat("b", { models: [] });
    await run(ctx, 2 * MIN);
    assert.equal(dev(ctx, "a").assigned, 1);
    assert.equal(b.applied.number, 1);
    const gen = acc(ctx, 1).gen;

    await runUntil(ctx, () => left(ctx, 1) <= DRAIN - 5 * MIN);
    const label = restrictedIsActive ? "b ativo" : "b parado";
    assert.equal(dev(ctx, "a").assigned, 1, `${label}: ninguém saiu`);
    assert.equal(dev(ctx, "b").assigned, 1);
    assert.ok(!history(ctx).some((x) => x.includes("vai ser renovado")), label);
    assert.equal(ctx.engine.leaving.size, 0, `${label}: a conta não ficou marcada como saindo`);
    assert.equal(ctx.engine.bestAccountFor(dev(ctx, "b")), 1, `${label}: e continua sendo a conta de b`);
    assert.ok(await ctx.engine.credentialFor("b"), `${label}: b continua recebendo o acesso`);
    assert.equal(acc(ctx, 1).gen, gen);
    // Sem saída, ela renova no piso.
    await runUntil(ctx, () => acc(ctx, 1).gen === gen + 1, HOUR);
    assert.ok(left(ctx, 1) > LIFE - MIN);
    assert.equal(ctx.logs.filter((l) => l.includes("renovo assim mesmo")).length, 1, label);
  }
});

test("quem sai sozinho para a renovação (“renew”) não vira quem define a conta do grupo", async (t) => {
  const ctx = setup(t);
  await addAccounts(ctx, 3);
  addService(ctx, "a");
  addService(ctx, "b");
  await run(ctx, MIN);
  const now = ctx.clock.t;
  // a trocou há 2 h por uso; b acabou de ser tirado de outra conta para ela renovar. Os dois ativos agora.
  Object.assign(dev(ctx, "a"), { assigned: 2, lastSwitchAt: now - 2 * HOUR, lastSwitchBy: "auto", lastSeen: now });
  Object.assign(dev(ctx, "b"), { assigned: 3, lastSwitchAt: now - MIN, lastSwitchBy: "renew", lastSeen: now });
  assert.equal(ctx.engine.togetherStep(), true);
  assert.equal(dev(ctx, "a").assigned, 2, "a conta do grupo é a de a (a troca mais nova, de b, não conta)");
  assert.equal(dev(ctx, "b").assigned, 2, "e b entra nela");
});
