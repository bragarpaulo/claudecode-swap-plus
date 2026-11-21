"use strict";
// Testes da regra "Mínimo de Fable sobrando no destino" (rules.preferMinFreePct, servidor 2.5.6):
// numa troca VOLUNTÁRIA a conta de destino precisa ter pelo menos isso do modelo preferido sobrando.
//
// O caso de 21/11/2026 14:03: pela estratégia "aproveitar ao máximo" o servidor levou todos os serviços para a
// conta 22 (a cota semanal dela zerava às 22:00), que tinha o Fable em 89% — 11% sobrando. Doze minutos depois o
// Fable dela acabou e duas conversas pararam com "You've hit your Fable limit".
//
//   node --test server/test/prefer-min.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store } = require("../src/store");
const { Engine } = require("../src/engine");
const { decide, RULE_DEFAULTS } = require("../../plus/rules");

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.parse("2026-11-21T17:03:00Z"); // 14:03 de Brasília

/** Uma conta no formato da lista pública (o que o decide() lê). fable null = a conta não tem a linha do modelo. */
function account(number, { session = 10, weekly = 20, weeklyResetIn = 5 * DAY, fable = 30, now = START } = {}) {
  const usage = {
    fiveHour: { pct: session, resetsAt: new Date(now + 3 * HOUR).toISOString() },
    sevenDay: { pct: weekly, resetsAt: new Date(now + weeklyResetIn).toISOString() },
    scoped: fable === null ? [] : [{ name: "Fable", pct: fable, resetsAt: new Date(now + weeklyResetIn).toISOString() }],
  };
  return { number, email: `c${number}@x.com`, usageStatus: "ok", usage, usageAgeSeconds: 60, lastGoodUsage: usage, lastGoodAgeSeconds: 60 };
}

/** decide() com a conta 1 ativa. rules por cima das regras do dono (max, 168 h, Fable preferido, trocar de conta). */
function run(accounts, rules = {}, more = {}) {
  const r = { ...RULE_DEFAULTS, strategy: "max", expiringHours: 168, weeklyPct: 96, onModelLimit: "switchAccount", ...rules };
  return decide({ list: { activeAccountNumber: 1, accounts }, records: {}, r, modelIds: [], now: START, lastSwitchAt: 0, ...more });
}

// ------------------------------------------------------------------ decide()

test("padrão: preferMinFreePct = 10", () => {
  assert.equal(RULE_DEFAULTS.preferMinFreePct, 10);
});

test("o caso de 21/11 14:03: destino com a cota semanal zerando antes e o Fable em 89% — com o mínimo em 10 troca, em 20 não", () => {
  // Conta 1 (em uso): Fable folgado, semanal zera em 2 dias. Conta 22: semanal zera em 5 h, 36% sobrando, Fable 89%.
  const accounts = [account(1, { fable: 23, weekly: 26, weeklyResetIn: 2 * DAY }), account(22, { fable: 89, weekly: 64, weeklyResetIn: 5 * HOUR })];
  for (const onModelLimit of ["switchAccount", "sameAccount"]) {
    let d = run(accounts, { onModelLimit }); // padrão: 10
    assert.equal(d.action, "switch", `${onModelLimit}: 11% sobrando passa no mínimo de 10`);
    assert.equal(d.to, 22);
    assert.match(d.reason, /^a cota semanal dela zera .* com 36% sobrando$/);
    assert.equal(run(accounts, { onModelLimit, preferMinFreePct: 11 }).action, "switch", "11% sobrando: no limite ainda vale");
    d = run(accounts, { onModelLimit, preferMinFreePct: 12 });
    assert.equal(d.action, "none", `${onModelLimit}: com 12 já não troca`);
    d = run(accounts, { onModelLimit, preferMinFreePct: 20 });
    assert.equal(d.action, "none");
    assert.equal(d.kind, "idle", "não é falta de conta: só não vale a pena trocar");
  }
  // Havendo outra conta que também zera antes e tem Fable de sobra, é para ela que vai.
  const withBetter = [...accounts, account(9, { fable: 6, weekly: 4, weeklyResetIn: 20 * HOUR })];
  const d = run(withBetter, { preferMinFreePct: 20 });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 9);
});

test("sem a regra (rules de quem não a conhece, como o modo local da extensão) não há corte; 0 também desliga", () => {
  const accounts = [account(1, { weeklyResetIn: 2 * DAY }), account(2, { fable: 90, weeklyResetIn: 5 * HOUR })];
  const { preferMinFreePct, ...old } = RULE_DEFAULTS;
  assert.equal(preferMinFreePct, 10);
  const r = { ...old, strategy: "max", expiringHours: 168 };
  const d = decide({ list: { activeAccountNumber: 1, accounts }, records: {}, r, modelIds: [], now: START, lastSwitchAt: 0 });
  assert.equal(d.action, "switch", "10% sobrando, sem a regra: como sempre foi");
  assert.equal(run(accounts, { preferMinFreePct: 0 }).action, "switch");
  assert.equal(run(accounts, { preferMinFreePct: 11 }).action, "none");
  assert.equal(run(accounts, { preferMinFreePct: "x" }).action, "switch", "valor inválido = sem corte");
});

test("conta sem a linha do modelo não entra na conta: a regra não aperta nem afrouxa", () => {
  const noFable = account(2, { fable: null, weeklyResetIn: 5 * HOUR });
  // Conta em uso ainda com Fable: nunca troca por vontade própria para uma sem ele (regra antiga) — com ou sem o mínimo.
  const withFable = [account(1, { fable: 30, weeklyResetIn: 2 * DAY }), noFable, account(3)]; // a 3 só põe "Fable" na lista de modelos
  assert.equal(run(withFable, { preferMinFreePct: 0 }).action, "none");
  assert.equal(run(withFable, { preferMinFreePct: 50 }).action, "none");
  // Conta em uso já sem Fable (96% na regra "seguir na mesma conta"): a troca antecipada para a sem linha continua valendo.
  const outOfFable = [account(1, { fable: 96, weeklyResetIn: 2 * DAY }), noFable];
  for (const preferMinFreePct of [0, 10, 50]) {
    const d = run(outOfFable, { onModelLimit: "sameAccount", preferMinFreePct });
    assert.equal(d.action, "switch", `mínimo ${preferMinFreePct}`);
    assert.equal(d.to, 2);
  }
  // Já a conta COM a linha e pouco Fable é cortada, mesmo com a conta em uso sem Fable nenhum.
  const lowFable = [account(1, { fable: 96, weeklyResetIn: 2 * DAY }), account(2, { fable: 60, weeklyResetIn: 5 * HOUR })];
  assert.equal(run(lowFable, { onModelLimit: "sameAccount", preferMinFreePct: 40 }).action, "switch", "40% sobrando");
  assert.equal(run(lowFable, { onModelLimit: "sameAccount", preferMinFreePct: 41 }).action, "none");
});

test("troca obrigatória não olha o mínimo: conta na linha, limite do modelo passado e limite batido", () => {
  const low = account(2, { fable: 89 }); // 11% de Fable: abaixo de um mínimo de 50
  const rules = { preferMinFreePct: 50 };
  // Sessão na linha.
  let d = run([account(1, { session: 93 }), low], rules);
  assert.equal(d.action, "switch");
  assert.equal(d.to, 2);
  assert.match(d.reason, /^sessão em 93% \(linha 90%\)$/);
  // Fable da conta em uso na linha (regra "trocar de conta para continuar no modelo").
  d = run([account(1, { fable: 97 }), low], rules);
  assert.equal(d.action, "switch");
  assert.match(d.reason, /^Fable em 97% \(linha 95%\)$/);
  // Limite batido (o Claude Code avisou).
  d = run([account(1), low], rules, { limitHit: "limite do Fable" });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 2);
  assert.equal(d.atLimit, true);
  // E a mesma conta de destino, sem obrigação nenhuma, não é escolhida.
  assert.equal(run([account(1, { weeklyResetIn: 2 * DAY }), account(2, { fable: 89, weeklyResetIn: 5 * HOUR })], rules).action, "none");
});

test("troca pedida (“melhor conta”, force) também respeita o mínimo", () => {
  // A conta 2 tem mais folga na sessão (0% contra 60%), mas só 11% de Fable. (Regra "seguir na mesma conta": a
  // folga compara sessão e semanal.)
  const accounts = [account(1, { session: 60 }), account(2, { session: 0, fable: 89 })];
  const base = { strategy: "headroom", onModelLimit: "sameAccount" };
  let d = run(accounts, base, { force: true });
  assert.equal(d.action, "switch", "mínimo 10: vale");
  assert.equal(d.to, 2);
  assert.equal(d.reason, "troca pedida pela melhor conta");
  d = run(accounts, { ...base, preferMinFreePct: 20 }, { force: true });
  assert.equal(d.action, "none");
  assert.equal(d.text, "a conta atual já é a que tem mais folga");
  // Com outra conta de mais folga e Fable de sobra, vai para ela.
  d = run([...accounts, account(3, { session: 20, fable: 10 })], { ...base, preferMinFreePct: 20 }, { force: true });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 3);
});

// ------------------------------------------------------------------ motor

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-minimo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "master.key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "data"), keyFile });
  store.load();
  t.after(() => store.close());
  const clock = { t: START };
  const logs = [];
  const put = (...a) => logs.push(a.map(String).join(" "));
  // A Anthropic não é chamada nestes testes (nenhum ciclo roda): um objeto vazio basta.
  const engine = new Engine({ store, anthropic: {}, now: () => clock.t, log: { info: put, warn: put, error: put, log: put }, env: { REFRESH_AHEAD_MIN: "120" } });
  return { store, clock, engine, logs };
}

/** Conta direto no cofre: acesso de 8 h renovado há `age`, uso lido agora. */
function addAccount(ctx, number, { age = 0, weekly = 20, weeklyResetIn = 5 * DAY, fable = 30 } = {}) {
  const t = ctx.clock.t;
  const usage = {
    fiveHour: null,
    sevenDay: { pct: weekly, resetsAt: new Date(t + weeklyResetIn).toISOString() },
    scoped: fable === null ? [] : [{ name: "Fable", pct: fable, resetsAt: new Date(t + weeklyResetIn).toISOString() }],
  };
  ctx.store.state.accounts[String(number)] = {
    number,
    email: `c${number}@x.com`,
    orgUuid: "org-1",
    cred: { accessToken: `acesso-${number}`, refreshToken: `login-${number}`, expiresAt: t - age + 8 * HOUR },
    gen: 1,
    lastRefreshAt: t - age,
    dead: null,
    disabled: false,
    priority: 0,
    usage,
    usageFetchedAt: t,
    usageError: null,
    lastGoodUsage: usage,
    lastGoodAt: t,
  };
}

function addDevice(ctx, id, assigned) {
  const d = { id, name: `PC ${id}`, platform: "linux", tokenHash: "0".repeat(64), createdAt: START, lastSeen: ctx.clock.t, assigned, lastSwitchAt: 0, lastSwitchBy: "auto", models: [], held: { number: assigned, gen: 1 } };
  ctx.store.state.devices[id] = d;
  return d;
}

test("validação: preferMinFreePct de 0 a 50 (fora da faixa é ajustado), precisa ser número, null volta ao padrão", async (t) => {
  const { engine, store } = setup(t);
  assert.equal(engine.rulesEffective().preferMinFreePct, 10, "padrão");
  let r = await engine.setRules({ rules: { preferMinFreePct: 20 } });
  assert.equal(r.rules.preferMinFreePct, 20);
  assert.equal(store.state.rules.preferMinFreePct, 20);
  assert.equal(store.state.history[0].text, "Regras de troca atualizadas");
  r = await engine.setRules({ rules: { preferMinFreePct: 99 } });
  assert.equal(r.rules.preferMinFreePct, 50, "acima da faixa: 50");
  r = await engine.setRules({ rules: { preferMinFreePct: -3 } });
  assert.equal(r.rules.preferMinFreePct, 0, "abaixo da faixa: 0 (sem corte)");
  r = await engine.setRules({ rules: { preferMinFreePct: "25" } });
  assert.equal(r.rules.preferMinFreePct, 25, "número em texto (linha de comando) vale");
  await assert.rejects(engine.setRules({ rules: { preferMinFreePct: "muito" } }), (e) => e.code === "invalid_rules" && /preferMinFreePct precisa ser um número de 0 a 50/.test(e.message));
  assert.equal(engine.rulesEffective().preferMinFreePct, 25, "recusou: nada mudou");
  r = await engine.setRules({ rules: { preferMinFreePct: null } });
  assert.equal(r.rules.preferMinFreePct, 10, "null = volta ao padrão");
  assert.equal(store.state.rules, null);
});

test("troca para renovar o login (renewTarget) respeita o mínimo; sem conta assim, ninguém sai", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await engine.setRules({ rules: { strategy: "max", devicePlacement: "together", weeklyPct: 96 } });
  addAccount(ctx, 1, { age: 7 * HOUR + 10 * MIN }); // em uso; o acesso vence em 50 min: é hora de tirar os serviços
  addAccount(ctx, 2, { fable: 89, weekly: 64, weeklyResetIn: 5 * HOUR }); // zera antes, mas só 11% de Fable
  addAccount(ctx, 3, { fable: 60, weeklyResetIn: 5 * DAY }); // 40% de Fable
  addAccount(ctx, 4, { fable: null, weeklyResetIn: 6 * DAY }); // sem a linha do modelo
  const d = addDevice(ctx, "a", 1);
  const target = () => engine.renewTarget(d, engine.recordsFor(d));

  assert.equal(target(), 2, "mínimo 10 (padrão): a conta 2, que zera antes, serve (11% sobrando)");
  await engine.setRules({ rules: { preferMinFreePct: 20 } });
  assert.equal(target(), 3, "mínimo 20: a conta 2 fica de fora e vai para a 3");
  await engine.setRules({ rules: { preferMinFreePct: 0 } });
  assert.equal(target(), 2, "0 = sem corte");
  await engine.setRules({ rules: { preferMinFreePct: 40 } });
  assert.equal(target(), 3, "40% sobrando: no limite ainda vale");
  // Conta sem a linha do modelo não é cortada por esta regra: com as outras de fora, é ela.
  await engine.setRules({ rules: { preferMinFreePct: 50 } });
  assert.equal(target(), 4, "mínimo 50: a 2 (11%) e a 3 (40%) ficam de fora; a 4 não tem a linha");
  delete ctx.store.state.accounts["4"];
  assert.equal(target(), null, "sem a 4, não há destino");
});

test("troca para renovar: com o mínimo em 20 e só a conta de Fable no fim disponível, o grupo fica onde está", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await engine.setRules({ rules: { strategy: "max", devicePlacement: "together", weeklyPct: 96, preferMinFreePct: 20 } });
  addAccount(ctx, 1, { age: 7 * HOUR + 10 * MIN });
  addAccount(ctx, 2, { fable: 89, weekly: 64, weeklyResetIn: 5 * HOUR });
  const d = addDevice(ctx, "a", 1);
  assert.equal(engine.drainStep(), false, "ninguém sai");
  assert.equal(d.assigned, 1);
  assert.equal(engine.leaving.size, 0);
  // Com o mínimo de volta em 10 (padrão), a troca para renovar acontece.
  await engine.setRules({ rules: { preferMinFreePct: 10 } });
  assert.equal(engine.drainStep(), true);
  assert.equal(d.assigned, 2);
  assert.equal(ctx.store.state.history[0].text, "Trocou da conta 1 para a conta 2: o login da conta 1 vai ser renovado");
});
