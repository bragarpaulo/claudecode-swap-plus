"use strict";
// Testes do "modelo que o serviço usa" (servidor 2.7.0).
//
// O caso de 22/11/2026 11:17: o painel estava com o modelo preferido = Opus 5.5 (secundário = Fable 5.2), então o
// servidor não olhava o Fable ao escolher conta. Pela estratégia "aproveitar ao máximo" levou o Mac e o NoteWin
// juntos para a conta 4 (o semanal dela zerava antes) — e a conta 4 não tem o Fable no plano. Os dois VS Code
// estavam no Fable: as conversas pararam com "Fable 5.2 requires usage credits".
//
//   node --test server/test/want-model.test.js

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
const START = Date.parse("2026-11-22T14:17:00Z"); // 11:17 de Brasília

// As regras do dono naquela hora.
const OWNER_RULES = {
  strategy: "max",
  expiringHours: 168,
  weeklyPct: 96,
  preferMinFreePct: 20,
  onModelLimit: "switchAccount",
  devicePlacement: "together",
  primaryModel: "claude-opus-5-5",
  secondaryModel: "claude-fable-5-2",
};

function account(number, { session = 10, weekly = 20, weeklyResetIn = 5 * DAY, fable = 30, now = START } = {}) {
  const usage = {
    fiveHour: { pct: session, resetsAt: new Date(now + 3 * HOUR).toISOString() },
    sevenDay: { pct: weekly, resetsAt: new Date(now + weeklyResetIn).toISOString() },
    scoped: fable === null ? [] : [{ name: "Fable", pct: fable, resetsAt: new Date(now + weeklyResetIn).toISOString() }],
  };
  return { number, email: `c${number}@x.com`, usageStatus: "ok", usage, usageAgeSeconds: 60, lastGoodUsage: usage, lastGoodAgeSeconds: 60 };
}

function run(accounts, more = {}, rules = {}) {
  const r = { ...RULE_DEFAULTS, ...OWNER_RULES, preferModel: "Opus", ...rules };
  return decide({ list: { activeAccountNumber: 1, accounts }, records: {}, r, modelIds: [], now: START, lastSwitchAt: 0, ...more });
}

// ------------------------------------------------------------------ decide()

test("sem o modelo em uso (como antes): painel em Opus, a antecipação vai para a conta sem Fable", () => {
  const accounts = [account(1, { fable: 49, weekly: 59, weeklyResetIn: 3 * DAY }), account(4, { fable: null, weekly: 36, weeklyResetIn: 2 * DAY })];
  const d = run(accounts);
  assert.equal(d.action, "switch");
  assert.equal(d.to, 4, "é o que aconteceu às 11:17");
});

test("o serviço usa o Fable: a antecipação não vai para a conta sem Fable", () => {
  const accounts = [account(1, { fable: 49, weekly: 59, weeklyResetIn: 3 * DAY }), account(4, { fable: null, weekly: 36, weeklyResetIn: 2 * DAY })];
  const d = run(accounts, { want: ["Fable"] });
  assert.equal(d.action, "none");
  assert.equal(d.kind, "idle");
  // Havendo outra que zera antes e TEM Fable, vai para ela.
  const d2 = run([...accounts, account(18, { fable: 5, weekly: 9, weeklyResetIn: 2.5 * DAY })], { want: ["Fable"] });
  assert.equal(d2.action, "switch");
  assert.equal(d2.to, 18);
});

test("conta em uso sem o Fable e o serviço usa o Fable: troca na hora para uma conta com Fable", () => {
  const accounts = [account(1, { fable: null, weekly: 36 }), account(12, { fable: null, weekly: 0 }), account(18, { fable: 5, weekly: 9 }), account(23, { fable: 90 })];
  const d = run(accounts, { want: ["Fable"] });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 18, "nem a 12 (também sem Fable) nem a 23 (Fable na linha)");
  assert.equal(d.reason, "a conta 1 não tem o Fable");
  assert.equal(d.absent, "Fable");
  assert.notEqual(d.atLimit, true, "não é limite batido");
});

test("conta em uso sem o Fable, mas o serviço usa o Opus: fica", () => {
  const accounts = [account(1, { fable: null, weekly: 36, weeklyResetIn: 2 * DAY }), account(18, { fable: 5, weekly: 9 })];
  assert.equal(run(accounts, { want: ["Opus"] }).action, "none");
  assert.equal(run(accounts, { want: [] }).action, "none");
});

test("vale também com o uso da conta em uso desatualizado (a falta do modelo não muda com o tempo)", () => {
  const a1 = account(1, { fable: null });
  a1.usageStatus = "error";
  a1.lastGoodAgeSeconds = 3 * 3600;
  const d = run([a1, account(18, { fable: 5 })], { want: ["Fable"] });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 18);
});

test("o serviço viu “requires usage credits” na conta (missing), mesmo com a linha do Fable no uso dela: troca", () => {
  const accounts = [account(1, { fable: 10 }), account(18, { fable: 5 })];
  assert.equal(run(accounts, { want: ["Fable"] }).action, "none", "sem o aviso: a conta 1 serve");
  const d = run(accounts, { want: ["Fable"], missing: [1] });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 18);
  // E conta de destino que deu o erro não serve de destino.
  const d2 = run([account(1, { fable: null }), account(18, { fable: 5 }), account(19, { fable: 15 })], { want: ["Fable"], missing: [18] });
  assert.equal(d2.to, 19);
});

test("nenhuma conta com Fable: fica, com noModel (o VS Code pergunta se quer mudar)", () => {
  const accounts = [account(1, { fable: null }), account(12, { fable: null }), account(23, { fable: 97 })];
  const d = run(accounts, { want: ["Fable"] });
  assert.equal(d.action, "none");
  assert.equal(d.kind, "blocked");
  assert.equal(d.noModel, "Fable");
  assert.match(d.text, /nenhuma outra conta tem o Fable disponível/);
});

test("conta em uso sem o Fable E na linha da sessão: sem conta com Fable, sai mesmo assim (sessão vem antes)", () => {
  const accounts = [account(1, { fable: null, session: 95 }), account(12, { fable: null, session: 0 }), account(23, { fable: 97, session: 0 })];
  const d = run(accounts, { want: ["Fable"] });
  assert.equal(d.action, "switch");
  assert.ok([12, 23].includes(d.to));
  assert.equal(d.noModel, undefined);
});

test("limite do Fable na conta em uso (trocar de conta): nunca vai para conta sem Fable — sem nenhuma, noModel", () => {
  const accounts = [account(1, { fable: 97 }), account(4, { fable: null, weekly: 0 })];
  const d = run(accounts, {}, { preferModel: "Fable" });
  assert.equal(d.action, "none");
  assert.equal(d.noModel, "Fable");
  const d2 = run([...accounts, account(18, { fable: 5 })], {}, { preferModel: "Fable" });
  assert.equal(d2.to, 18);
});

test("limite batido com o Fable em uso: contas com Fable primeiro", () => {
  const accounts = [account(1, { fable: 30 }), account(4, { fable: null, weekly: 0, session: 0 }), account(18, { fable: 5, weekly: 40, session: 50 })];
  const d = run(accounts, { want: ["Fable"], limitHit: "limite da sessão de 5h" });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 18);
  assert.equal(d.atLimit, true);
});

// ------------------------------------------------------------------ motor

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-modelo-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const keyFile = path.join(dir, "master.key");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "data"), keyFile });
  store.load();
  t.after(() => store.close());
  const clock = { t: START };
  const logs = [];
  const put = (...a) => logs.push(a.map(String).join(" "));
  const engine = new Engine({ store, anthropic: {}, now: () => clock.t, log: { info: put, warn: put, error: put, log: put }, env: { REFRESH_AHEAD_MIN: "120" } });
  return { store, clock, engine, logs };
}

function addAccount(ctx, number, { weekly = 20, weeklyResetIn = 5 * DAY, fable = 30 } = {}) {
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
    cred: { accessToken: `acesso-${number}`, refreshToken: `login-${number}`, expiresAt: t + 8 * HOUR },
    gen: 1,
    lastRefreshAt: t,
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

function addDevice(ctx, id, assigned, extra = {}) {
  const d = { id, name: `PC ${id}`, platform: "linux", tokenHash: "0".repeat(64), createdAt: START, lastSeen: ctx.clock.t, assigned, lastSwitchAt: 0, lastSwitchBy: "auto", models: [], held: { number: assigned, gen: 1 }, ...extra };
  ctx.store.state.devices[id] = d;
  return d;
}

async function ownerRules(engine) {
  await engine.setRules({ rules: OWNER_RULES });
}

test("motor, juntos: o grupo na conta 24 e um VS Code no Fable — não vai para a conta 4", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await ownerRules(engine);
  assert.equal(engine.rulesEffective().preferModel, "Opus");
  addAccount(ctx, 24, { fable: 49, weekly: 59, weeklyResetIn: 3 * DAY });
  addAccount(ctx, 4, { fable: null, weekly: 36, weeklyResetIn: 2 * DAY });
  const mac = addDevice(ctx, "mac", 24);
  const hermes = addDevice(ctx, "hermes", 24);
  // Sem o modelo: o caso de 11:17.
  engine.decideAll();
  assert.equal(mac.assigned, 4, "sem saber do Fable, vai para a 4 (como aconteceu)");
  // Volta e o Mac conta que usa o Fable.
  mac.assigned = 24;
  hermes.assigned = 24;
  mac.lastSwitchAt = hermes.lastSwitchAt = 0;
  await engine.heartbeat("mac", { models: ["claude-fable-5-2"], defaultModel: "opus" });
  assert.deepEqual(engine.wantOf([mac]), ["Fable", "Opus"], "o Fable das conversas e o padrão (opus) do Claude Code");
  assert.equal(mac.assigned, 24, "com o Fable em uso: fica na 24");
  assert.equal(hermes.assigned, 24);
  assert.deepEqual(engine.stateFor("mac").device.want, ["Fable", "Opus"]);
  assert.ok(engine.stateFor("mac").features.includes("model_missing"));
});

test("motor, juntos: grupo na conta sem Fable e o Mac passa a usar o Fable — o grupo inteiro sai na hora", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await ownerRules(engine);
  addAccount(ctx, 4, { fable: null, weekly: 36, weeklyResetIn: 2 * DAY });
  addAccount(ctx, 18, { fable: 5, weekly: 9, weeklyResetIn: 5 * DAY });
  const mac = addDevice(ctx, "mac", 4, { lastSwitchAt: START - MIN }); // acabou de trocar: o intervalo mínimo não segura
  const win = addDevice(ctx, "win", 4, { lastSwitchAt: START - MIN });
  await engine.heartbeat("mac", { models: ["claude-fable-5-2"] });
  assert.equal(mac.assigned, 18);
  assert.equal(win.assigned, 18, "juntos: o NoteWin vai junto");
  assert.match(ctx.store.state.history[0].text, /a conta 4 não tem o Fable/);
});

test("motor: modelo padrão do Claude Code no Fable conta como uso (antes da primeira mensagem)", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await ownerRules(engine);
  addAccount(ctx, 4, { fable: null });
  addAccount(ctx, 18, { fable: 5 });
  const mac = addDevice(ctx, "mac", 4);
  await engine.heartbeat("mac", { models: [], defaultModel: "claude-fable-5-2" });
  assert.equal(mac.assigned, 18);
});

test("motor: o serviço trocou o Fable por outro modelo há mais de 30 min — deixa de exigir o Fable; parado, vale por 12 h", async (t) => {
  const ctx = setup(t);
  const { engine, clock } = ctx;
  await ownerRules(engine);
  addAccount(ctx, 18, { fable: 5 });
  const mac = addDevice(ctx, "mac", 18);
  await engine.heartbeat("mac", { models: ["claude-fable-5-2"] });
  clock.t += 6 * HOUR; // parado 6 h (nenhum modelo em uso)
  await engine.heartbeat("mac", { models: [] });
  assert.deepEqual(engine.wantOf([mac]), ["Fable"], "parado: ainda vale");
  // Passa a usar o Opus: por 30 min ainda vale o Fable; depois, não.
  await engine.heartbeat("mac", { models: ["claude-opus-5-5"] });
  assert.deepEqual(engine.wantOf([mac]).sort(), ["Fable", "Opus"].sort());
  clock.t += 6 * HOUR + 31 * MIN;
  await engine.heartbeat("mac", { models: ["claude-opus-5-5"] });
  assert.deepEqual(engine.wantOf([mac]), ["Opus"]);
  // E 12 h sem uso nenhum: some.
  const pc = addDevice(ctx, "pc", 18);
  await engine.heartbeat("pc", { models: ["claude-fable-5-2"] });
  clock.t += 12 * HOUR + MIN;
  assert.deepEqual(engine.wantOf([pc]), []);
});

test("motor: modelMissing (“requires usage credits”) — anota a conta, troca na hora e a conta não volta a ser destino", async (t) => {
  const ctx = setup(t);
  const { engine, store } = ctx;
  await ownerRules(engine);
  addAccount(ctx, 7, { fable: 10, weekly: 30, weeklyResetIn: 2 * DAY }); // a linha aparece, mas a conta deu o erro
  addAccount(ctx, 18, { fable: 5, weekly: 9, weeklyResetIn: 5 * DAY });
  const mac = addDevice(ctx, "mac", 7);
  const win = addDevice(ctx, "win", 7);
  const r = await engine.modelMissing("mac", "claude-fable-5-2");
  assert.equal(r.switched, true);
  assert.equal(r.to, 18);
  assert.equal(mac.assigned, 18);
  assert.equal(win.assigned, 18);
  assert.ok(store.state.accounts["7"].lacksModel.Fable);
  // Antecipação: a 7 zera antes, mas não serve (deu o erro).
  engine.decideAll();
  assert.equal(mac.assigned, 18);
  // A marca vale 24 h, mesmo com a linha do Fable no uso dela; depois, vale o uso (que mostra a linha): volta a servir.
  ctx.clock.t += 24 * HOUR + MIN;
  assert.deepEqual(engine.lackingAccounts(), []);
  assert.equal(store.state.accounts["7"].lacksModel, undefined);
});

test("motor: modelMissing sem nenhuma conta com Fable — fica, e o estado do serviço traz o modelBlock", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await ownerRules(engine);
  addAccount(ctx, 4, { fable: null });
  addAccount(ctx, 12, { fable: null });
  addAccount(ctx, 23, { fable: 97 });
  const mac = addDevice(ctx, "mac", 4);
  const r = await engine.modelMissing("mac", "claude-fable-5-2");
  assert.equal(r.switched, false);
  assert.equal(r.noModel, "Fable");
  assert.equal(mac.assigned, 4);
  const st = engine.stateFor("mac");
  assert.equal(st.device.modelBlock.model, "Fable");
  // Uma conta com Fable aparece (renovou): o grupo vai para ela e o modelBlock some.
  addAccount(ctx, 18, { fable: 0 });
  engine.decideAll();
  assert.equal(mac.assigned, 18);
  assert.equal(engine.stateFor("mac").device.modelBlock, null);
});

test("motor: renovação do login da conta do grupo leva para conta com Fable quando o grupo usa o Fable", async (t) => {
  const ctx = setup(t);
  const { engine } = ctx;
  await ownerRules(engine);
  addAccount(ctx, 18, { fable: 5 });
  addAccount(ctx, 4, { fable: null, weeklyResetIn: 1 * DAY });
  addAccount(ctx, 19, { fable: 15, weeklyResetIn: 4 * DAY });
  const mac = addDevice(ctx, "mac", 18);
  await engine.heartbeat("mac", { models: ["claude-fable-5-2"] });
  assert.equal(engine.renewTarget(null, engine.sharedRecords([mac]), engine.now(), [mac]), 19);
  assert.equal(engine.renewTarget(null, engine.sharedRecords([mac]), engine.now(), []), 4, "sem o Fable em uso: a 4, que zera antes");
});

test("limite batido “limite do Fable” (a conversa parou no Fable): só conta com Fable; sem nenhuma, noModel", () => {
  const accounts = [account(1, { fable: 60 }), account(4, { fable: null, weekly: 0 })];
  const d = run(accounts, { want: ["Fable"], limitHit: "limite do Fable" });
  assert.equal(d.action, "none");
  assert.equal(d.noModel, "Fable");
  const d2 = run([...accounts, account(18, { fable: 5 })], { want: ["Fable"], limitHit: "limite do Fable" });
  assert.equal(d2.to, 18);
  // Limite da sessão: sai mesmo para a sem Fable, se não houver outra.
  assert.equal(run(accounts, { want: ["Fable"], limitHit: "limite da sessão de 5h" }).to, 4);
});
