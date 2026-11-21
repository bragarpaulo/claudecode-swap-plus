"use strict";
// Testes de server/src/access.js: quais serviços podem usar cada conta Claude
// (state.accountDevices["<n>"] = null | [deviceId...]; WEB-SPEC 2.3).
// Funções puras: o estado é montado à mão (mesmo formato do cofre), sem cofre, sem rede.
//
//   node --test server/test/access.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const access = require("../src/access");
const { emailKey } = require("../src/google");
const { decide, RULE_DEFAULTS } = require("../../plus/rules");

const {
  normalizeEmail,
  accountsAllowedFor,
  allowedAccountsList,
  accountDevicesFor,
  canUse,
  filterRecordsForDevice,
  setAccountDevices,
  onAccountRemoved,
  onDeviceRemoved,
  devicesLabel,
} = access;

const NOW = Date.parse("2026-11-14T12:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

function account(number, extra = {}) {
  return {
    number,
    email: `conta${number}@exemplo.com`,
    orgUuid: "org-1",
    orgName: "Org",
    plan: { label: "Max" },
    alias: null,
    disabled: false,
    threshold: null,
    priority: 0,
    dead: null,
    ...extra,
  };
}

function device(id, extra = {}) {
  return { id, name: id, platform: "darwin", googleEmail: null, tokenHash: "h", createdAt: 1, lastSeen: 1, assigned: null, lastSwitchAt: 0, models: [], ...extra };
}

/** Serviços do dono: Mac e Windows (Google), Linux (pareado por código). */
const MAC = () => device("mac", { name: "Mac", googleEmail: "donoexemplo@gmail.com" });
const WIN = () => device("win", { name: "Windows", platform: "win32", googleEmail: "donoexemplo@gmail.com" });
const LINUX = () => device("linux", { name: "Linux", platform: "linux" });

/** Estado no formato do cofre (só o que importa aqui). */
function makeState({ accounts = [1, 2, 3], devices = [MAC(), WIN(), LINUX()], accountDevices } = {}) {
  const st = { version: 1, nextNumber: Math.max(0, ...accounts) + 1, accounts: {}, devices: {}, allowedEmails: [], history: [] };
  for (const n of accounts) st.accounts[String(n)] = account(n);
  for (const d of devices) st.devices[d.id] = d;
  if (accountDevices !== undefined) st.accountDevices = accountDevices;
  return st;
}

/** Igual ao engine.records(). */
function recordsOf(st) {
  const out = {};
  for (const a of Object.values(st.accounts).sort((x, y) => x.number - y.number)) {
    out[String(a.number)] = { disabled: !!a.disabled, threshold: a.threshold ?? null, priority: Number(a.priority) || 0, alias: a.alias || null };
  }
  return out;
}

/** Igual ao engine.withDisabled(). */
function withDisabled(records, numbers) {
  const out = { ...records };
  for (const n of numbers) out[String(n)] = { ...(out[String(n)] || {}), disabled: true };
  return out;
}

/** PublicAccount com uso conhecido e recente. */
function pub(number, { session = 10, weekly = 20, active = false } = {}) {
  return {
    number,
    email: `conta${number}@exemplo.com`,
    organizationName: "Org",
    organizationUuid: "org-1",
    plan: { label: "Max" },
    alias: null,
    active,
    disabled: false,
    usageStatus: "ok",
    usage: {
      fiveHour: { pct: session, resetsAt: new Date(NOW + 2 * HOUR).toISOString() },
      sevenDay: { pct: weekly, resetsAt: new Date(NOW + 4 * DAY).toISOString() },
      scoped: [],
    },
    usageAgeSeconds: 10,
    lastGoodUsage: null,
    lastGoodAgeSeconds: null,
    dead: false,
    loginExpiresAt: null,
    accessExpiresAt: null,
    assignedDevices: [],
  };
}

/** Valida um erro: .code (e a mensagem, se pedida). */
const isErr = (code, re) => (e) => {
  assert.equal(e.code, code);
  if (re) assert.match(e.message, re);
  return true;
};

// ---------------------------------------------------------------------------------------------------

test("exporta as funções da regra (e nada de perfis/acessos por e-mail)", () => {
  for (const name of [
    "normalizeEmail",
    "accountsAllowedFor",
    "allowedAccountsList",
    "accountDevicesFor",
    "canUse",
    "filterRecordsForDevice",
    "setAccountDevices",
    "onAccountRemoved",
    "onDeviceRemoved",
    "devicesLabel",
  ]) {
    assert.equal(typeof access[name], "function", name);
  }
  for (const old of ["setEmailAccounts", "describe", "createProfile", "upsertAccess", "rulesFor"]) {
    assert.equal(access[old], undefined, old);
  }
});

test("normalizeEmail é a emailKey do google.js", () => {
  assert.equal(normalizeEmail("Dono.Exemplo+x@googlemail.com"), "donoexemplo@gmail.com");
  assert.equal(normalizeEmail(" DONOEXEMPLO@GMAIL.COM "), "donoexemplo@gmail.com");
  assert.equal(normalizeEmail("Ana.Souza+x@Empresa.com"), "ana.souza+x@empresa.com");
  for (const ruim of ["", "sem-arroba", "@gmail.com", "x@", "+x@gmail.com", "...@gmail.com", null, 42]) {
    assert.equal(normalizeEmail(ruim), "", String(ruim));
  }
  for (const s of ["b.r.a.g.a+1+2@gmail.com", "a.b@GoogleMail.com", "a@b", "a@b@gmail.com", "  ", `${"a".repeat(320)}@x.com`, undefined, {}]) {
    assert.equal(normalizeEmail(s), emailKey(s), String(s));
  }
});

test("canUse: padrão = todos os serviços; lista = só os da lista; [] = nenhum", () => {
  const st = makeState();
  const { mac, win, linux } = st.devices;
  for (const d of [mac, win, linux]) for (const n of [1, 2, 3]) assert.equal(canUse(st, d, n), true, "sem tabela no cofre");

  st.accountDevices = {};
  assert.equal(canUse(st, mac, 1), true, "tabela vazia");
  st.accountDevices = { 1: null };
  assert.equal(canUse(st, win, 1), true, "null = todos");

  st.accountDevices = { 1: ["mac"], 2: ["mac", "win"], 3: [] };
  assert.equal(canUse(st, mac, 1), true);
  assert.equal(canUse(st, win, 1), false);
  assert.equal(canUse(st, linux, 1), false, "pareado por código segue a mesma regra");
  assert.equal(canUse(st, mac, 2), true);
  assert.equal(canUse(st, win, 2), true);
  assert.equal(canUse(st, linux, 2), false);
  for (const d of [mac, win, linux]) assert.equal(canUse(st, d, 3), false, "lista vazia = nenhum serviço");
  assert.equal(canUse(st, mac, "1"), true, "número em texto (como vem da URL)");
  assert.equal(canUse(st, win, "1"), false);
});

test("canUse: só a permissão; número inválido = não; sem serviço = sem restrição", () => {
  const st = makeState({ accountDevices: { 1: ["mac"] } });
  const { mac, win } = st.devices;
  assert.equal(canUse(st, win, 99), true, "conta sem entrada (nem existe): não confere existência, isso é do motor");
  assert.equal(canUse(st, null, 1), true);
  assert.equal(canUse(st, undefined, 1), true);
  assert.equal(canUse(st, {}, 1), true, "objeto sem id");
  assert.equal(canUse(null, win, 1), true, "sem estado");
  for (const ruim of [0, -1, 1.5, NaN, Infinity, null, undefined, "", "abc", "01", "1.0", {}, [1]]) {
    assert.equal(canUse(st, mac, ruim), false, String(ruim));
    assert.equal(canUse(st, null, ruim), false, String(ruim));
  }
});

test("canUse: valor estragado fecha (ninguém); tabela estragada = sem restrição", () => {
  for (const lixo of ["mac", 3, true, { 0: "mac" }]) {
    const st = makeState({ accountDevices: { 1: lixo, 2: ["win"] } });
    for (const d of Object.values(st.devices)) assert.equal(canUse(st, d, 1), false, `${JSON.stringify(lixo)} / ${d.id}`);
    assert.equal(canUse(st, st.devices.win, 2), true, "as outras contas não são afetadas");
  }
  // itens que não são id (texto) são ignorados
  const st = makeState({ accountDevices: { 1: [1, null, "", {}, "mac"] } });
  assert.equal(canUse(st, st.devices.mac, 1), true);
  assert.equal(canUse(st, st.devices.win, 1), false);
  for (const lixo of [["mac"], "x", 5]) {
    const st2 = makeState({ accountDevices: lixo });
    assert.equal(canUse(st2, st2.devices.win, 1), true, JSON.stringify(lixo));
    assert.equal(accountsAllowedFor(st2, st2.devices.win), null, JSON.stringify(lixo));
  }
});

test("accountsAllowedFor: null quando nenhuma conta exclui o serviço; senão Set das contas do cofre", () => {
  const st = makeState();
  const { mac, win, linux } = st.devices;
  assert.equal(accountsAllowedFor(st, mac), null, "sem tabela");
  st.accountDevices = { 1: null, 2: ["mac", "win"] };
  assert.equal(accountsAllowedFor(st, mac), null, "o Mac está em todas");
  assert.deepEqual(accountsAllowedFor(st, linux), new Set([1, 3]));

  st.accountDevices = { 1: ["mac"], 2: ["mac"], 3: [] };
  assert.deepEqual(accountsAllowedFor(st, mac), new Set([1, 2]));
  assert.deepEqual(accountsAllowedFor(st, win), new Set(), "nenhuma conta para o Windows");

  // entrada de conta que não existe mais não conta
  const st2 = makeState({ accountDevices: { 9: ["mac"] } });
  assert.equal(accountsAllowedFor(st2, st2.devices.win), null);
  assert.equal(accountsAllowedFor(st2, null), null, "sem serviço");
  assert.equal(accountsAllowedFor(makeState({ accounts: [], accountDevices: {} }), st2.devices.win), null, "sem contas");
});

test("allowedAccountsList: lista em ordem para o painel (sempre lista)", () => {
  const st = makeState({ accounts: [3, 1, 2], accountDevices: { 1: ["mac"], 3: ["win", "mac"] } });
  const { mac, win, linux } = st.devices;
  assert.deepEqual(allowedAccountsList(st, mac), [1, 2, 3]);
  assert.deepEqual(allowedAccountsList(st, win), [2, 3]);
  assert.deepEqual(allowedAccountsList(st, linux), [2]);
  assert.deepEqual(allowedAccountsList(st, null), [1, 2, 3]);
  assert.deepEqual(allowedAccountsList(makeState({ accounts: [] }), mac), []);
  st.accountDevices = { 1: [], 2: [], 3: [] };
  assert.deepEqual(allowedAccountsList(st, mac), []);
});

test("accountDevicesFor: null = todos; lista só com serviços que existem; estragado = []", () => {
  const st = makeState({ accountDevices: { 1: ["win", "sumiu", "mac"], 2: null, 3: "lixo" } });
  assert.deepEqual(accountDevicesFor(st, 1), ["win", "mac"]);
  assert.deepEqual(accountDevicesFor(st, "1"), ["win", "mac"]);
  assert.equal(accountDevicesFor(st, 2), null);
  assert.deepEqual(accountDevicesFor(st, 3), []);
  assert.equal(accountDevicesFor(st, 4), null, "sem entrada");
  assert.equal(accountDevicesFor(st, "abc"), null);
  assert.equal(accountDevicesFor(makeState(), 1), null, "sem tabela");
  const v = accountDevicesFor(st, 1);
  v.push("x");
  assert.deepEqual(st.accountDevices["1"], ["win", "sumiu", "mac"], "devolve cópia e não limpa o cofre");
});

test("filterRecordsForDevice: cópia com disabled nas não permitidas; não muda o records recebido", () => {
  const st = makeState({ accountDevices: { 2: ["win"] } });
  Object.assign(st.accounts["2"], { alias: "Trabalho", threshold: 50 });
  Object.assign(st.accounts["3"], { threshold: 70, priority: 5 });
  const recs = recordsOf(st);
  const antes = JSON.stringify(recs);

  const out = filterRecordsForDevice(recs, st, st.devices.mac);
  assert.equal(JSON.stringify(recs), antes, "o records recebido não muda");
  assert.notEqual(out, recs);
  for (const k of Object.keys(out)) assert.notEqual(out[k], recs[k], `entrada ${k} é cópia`);
  assert.deepEqual(out, {
    1: { disabled: false, threshold: null, priority: 0, alias: null },
    2: { disabled: true, threshold: 50, priority: 0, alias: "Trabalho" },
    3: { disabled: false, threshold: 70, priority: 5, alias: null },
  });
  assert.deepEqual(filterRecordsForDevice(recs, st, st.devices.win), recs, "o Windows pode usar todas");
});

test("filterRecordsForDevice: sem restrição devolve cópia igual; fora da rotação continua fora", () => {
  const st = makeState({ accountDevices: { 2: ["win"] } });
  st.accounts["1"].disabled = true;
  const recs = recordsOf(st);
  for (const dev of [st.devices.win, null, undefined]) {
    const out = filterRecordsForDevice(recs, st, dev);
    assert.deepEqual(out, recs);
    assert.notEqual(out, recs);
    assert.notEqual(out["1"], recs["1"]);
  }
  const semTabela = makeState();
  assert.deepEqual(filterRecordsForDevice(recordsOf(semTabela), semTabela, semTabela.devices.mac), recordsOf(semTabela));
  const out = filterRecordsForDevice(recs, st, st.devices.mac);
  assert.equal(out["1"].disabled, true, "permitida mas fora da rotação: continua fora");
  assert.equal(out["2"].disabled, true);
  assert.equal(out["3"].disabled, false);
});

test("filterRecordsForDevice: conta do cofre que falta no records e não é permitida entra como disabled", () => {
  const st = makeState({ accountDevices: { 2: ["win"], 9: ["win"] } });
  const mac = st.devices.mac;
  assert.deepEqual(filterRecordsForDevice({}, st, mac), { 2: { disabled: true } });
  assert.deepEqual(filterRecordsForDevice(null, st, mac), { 2: { disabled: true } });
  assert.deepEqual(filterRecordsForDevice(undefined, makeState(), mac), {});
  // número no records que não está no cofre: vale a entrada dele (9 só para o Windows)
  assert.deepEqual(filterRecordsForDevice({ 9: { disabled: false } }, st, mac), { 2: { disabled: true }, 9: { disabled: true } });
  // chave que não é número de conta fica como veio
  assert.deepEqual(filterRecordsForDevice({ x: { a: 1 } }, st, mac), { x: { a: 1 }, 2: { disabled: true } });
  // nenhum serviço em nenhuma conta: todas desativadas
  st.accountDevices = { 1: [], 2: [], 3: [] };
  const out = filterRecordsForDevice(recordsOf(st), st, mac);
  assert.deepEqual(Object.keys(out).sort(), ["1", "2", "3"]);
  for (const k of ["1", "2", "3"]) assert.equal(out[k].disabled, true, k);
});

test("filterRecordsForDevice + decide() do rules.js: nunca troca para conta não permitida", () => {
  const st = makeState();
  const mac = st.devices.mac;
  mac.assigned = 1;
  const r = { ...RULE_DEFAULTS, strategy: "headroom" };
  // conta 1 (a do Mac) passou da linha da sessão; a 2 tem mais folga que a 3
  const list = { schemaVersion: 1, activeAccountNumber: 1, accounts: [pub(1, { session: 95, active: true }), pub(2, { session: 0, weekly: 5 }), pub(3, { session: 30, weekly: 40 })] };
  const args = { list, r, modelIds: [], now: NOW, lastSwitchAt: 0 };

  let d = decide({ ...args, records: filterRecordsForDevice(recordsOf(st), st, mac) });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 2, "sem restrição vai para a de mais folga");

  setAccountDevices(st, 2, ["win"]);
  d = decide({ ...args, records: filterRecordsForDevice(recordsOf(st), st, mac) });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 3, "a 2 é só do Windows");

  setAccountDevices(st, 3, []);
  d = decide({ ...args, records: filterRecordsForDevice(recordsOf(st), st, mac) });
  assert.equal(d.kind, "blocked", "nenhuma outra permitida: fica parado em vez de usar uma não permitida");

  // Como no engine.decideDevice: contas de outros serviços ativos bloqueadas e, se travar, a reserva
  // "dividir é melhor que parar" com o MESMO base filtrado → pode dividir a 3, nunca abrir a 2.
  setAccountDevices(st, 3, null);
  const base = filterRecordsForDevice(recordsOf(st), st, mac);
  const others = new Set([3]); // o Linux está na 3
  d = decide({ ...args, records: withDisabled(base, others) });
  assert.equal(d.kind, "blocked");
  d = decide({ ...args, records: base });
  assert.equal(d.action, "switch");
  assert.equal(d.to, 3);
});

test("setAccountDevices: grava em ordem; devolve cópia; null apaga; [] = nenhum", () => {
  const st = makeState();
  assert.equal(st.accountDevices, undefined);

  const v = setAccountDevices(st, 2, ["win", "mac"]);
  assert.deepEqual(v, ["mac", "win"]);
  assert.deepEqual(st.accountDevices, { 2: ["mac", "win"] });
  v.push("linux");
  assert.deepEqual(st.accountDevices["2"], ["mac", "win"], "a lista devolvida é cópia");

  assert.deepEqual(setAccountDevices(st, "2", ["linux"]), ["linux"], "número da conta em texto (URL)");
  assert.deepEqual(Object.keys(st.accountDevices), ["2"]);

  assert.deepEqual(setAccountDevices(st, 1, []), []);
  assert.deepEqual(st.accountDevices["1"], []);
  assert.equal(canUse(st, st.devices.mac, 1), false);

  assert.equal(setAccountDevices(st, 1, null), null);
  assert.equal(hasOwn(st.accountDevices, "1"), false, "null apaga a entrada");
  assert.equal(canUse(st, st.devices.mac, 1), true);
  assert.deepEqual(st.accountDevices, { 2: ["linux"] });
});

test("setAccountDevices: null sem tabela não cria nada; tabela estragada é refeita", () => {
  const st = makeState();
  assert.equal(setAccountDevices(st, 1, null), null);
  assert.equal(st.accountDevices, undefined);
  for (const lixo of ["lixo", ["mac"], 7]) {
    const st2 = makeState({ accountDevices: lixo });
    assert.deepEqual(setAccountDevices(st2, 1, ["mac"]), ["mac"]);
    assert.deepEqual(st2.accountDevices, { 1: ["mac"] }, JSON.stringify(lixo));
  }
});

test("setAccountDevices: validação e nada muda com erro", () => {
  const st = makeState({ accountDevices: { 1: ["mac"] } });
  const antes = JSON.stringify(st);

  for (const n of [9, "9", 0, -1, 1.5, "abc", null, undefined, {}]) {
    assert.throws(() => setAccountDevices(st, n, ["mac"]), isErr("not_found", /a conta .* não existe/), String(n));
    assert.throws(() => setAccountDevices(st, n, null), isErr("not_found"), String(n));
  }
  for (const ruim of [undefined, "mac", 1, {}, { 0: "mac" }, true, new Set(["mac"])]) {
    assert.throws(() => setAccountDevices(st, 1, ruim), isErr("invalid", /lista de ids de serviços/), String(ruim));
  }
  for (const item of ["", 1, null, undefined, true, ["mac"], {}]) {
    assert.throws(() => setAccountDevices(st, 1, ["mac", item]), isErr("invalid", /id de serviço inválido/), String(item));
  }
  assert.throws(() => setAccountDevices(st, 1, ["mac", "sumiu"]), isErr("invalid", /o serviço "sumiu" não existe/));
  assert.throws(() => setAccountDevices(st, 1, ["__proto__"]), isErr("invalid", /não existe/));
  assert.throws(() => setAccountDevices(st, 1, ["win", "mac", "win"]), isErr("invalid", /o serviço "win" aparece repetido/));
  assert.equal(JSON.stringify(st), antes, "com erro nada muda");

  assert.throws(() => setAccountDevices(null, 1, null), isErr("invalid"));
  assert.throws(() => setAccountDevices("estado", 1, null), isErr("invalid"));
  // conta/serviço com a chave mas sem objeto (estragado) não contam como existentes
  const st2 = makeState();
  st2.accounts["4"] = null;
  st2.devices.velho = null;
  assert.throws(() => setAccountDevices(st2, 4, ["mac"]), isErr("not_found"));
  assert.throws(() => setAccountDevices(st2, 1, ["velho"]), isErr("invalid", /não existe/));
});

test("serviço que conecta depois só usa as contas com 'Todos'", () => {
  const st = makeState();
  setAccountDevices(st, 1, ["mac"]);
  setAccountDevices(st, 2, ["mac", "win"]);
  st.devices.novo = device("novo", { googleEmail: "donoexemplo@gmail.com" });
  assert.deepEqual(allowedAccountsList(st, st.devices.novo), [3]);
  assert.deepEqual(accountsAllowedFor(st, st.devices.novo), new Set([3]));
  setAccountDevices(st, 3, ["mac"]);
  assert.deepEqual(allowedAccountsList(st, st.devices.novo), [], "nenhuma conta até o dono marcar");
});

test("regra do dono: conta 1 só no Mac, conta 2 no Mac e no Windows, conta 3 em todos", () => {
  const st = makeState();
  setAccountDevices(st, 1, ["mac"]);
  setAccountDevices(st, 2, ["mac", "win"]);
  const matriz = (dev) => [1, 2, 3].map((n) => canUse(st, dev, n));
  assert.deepEqual(matriz(st.devices.mac), [true, true, true]);
  assert.deepEqual(matriz(st.devices.win), [false, true, true]);
  assert.deepEqual(matriz(st.devices.linux), [false, false, true]);
  assert.deepEqual(allowedAccountsList(st, st.devices.win), [2, 3]);
  assert.deepEqual(accountDevicesFor(st, 2), ["mac", "win"]);
  assert.equal(accountDevicesFor(st, 3), null);
});

test("onAccountRemoved: apaga a lista da conta (número reaproveitado começa com 'todos')", () => {
  const st = makeState({ accountDevices: { 1: ["mac"], 2: null, 3: [] } });
  delete st.accounts["1"];
  assert.equal(onAccountRemoved(st, 1), true);
  assert.deepEqual(st.accountDevices, { 2: null, 3: [] });
  st.accounts["1"] = account(1); // addLogin com wantNumber
  assert.equal(canUse(st, st.devices.win, 1), true);

  assert.equal(onAccountRemoved(st, "2"), true, "número em texto; entrada null também sai");
  assert.deepEqual(st.accountDevices, { 3: [] });
  assert.equal(onAccountRemoved(st, 7), false);
  assert.equal(onAccountRemoved(st, "abc"), false);
  assert.equal(onAccountRemoved(st, null), false);
  assert.equal(onAccountRemoved(makeState(), 1), false);
  assert.equal(onAccountRemoved(null, 1), false);
  assert.deepEqual(st.accountDevices, { 3: [] });
});

test("onDeviceRemoved: tira o id de todas as listas; lista vazia continua vazia (nunca vira 'todos')", () => {
  const st = makeState({ accountDevices: { 1: ["mac"], 2: ["mac", "win"], 3: null, 4: "lixo", 5: ["win"] } });
  delete st.devices.mac;
  assert.deepEqual(onDeviceRemoved(st, "mac"), [1, 2]);
  assert.deepEqual(st.accountDevices, { 1: [], 2: ["win"], 3: null, 4: "lixo", 5: ["win"] });
  assert.equal(canUse(st, st.devices.win, 1), false, "a conta 1 ficou sem serviço");
  assert.equal(canUse(st, st.devices.linux, 1), false);

  // o Mac conecta de novo: é outro id, não herda nada
  st.devices.mac2 = device("mac2", { name: "Mac" });
  assert.equal(canUse(st, st.devices.mac2, 1), false);
  assert.equal(canUse(st, st.devices.mac2, 3), true);

  assert.deepEqual(onDeviceRemoved(st, "sumiu"), []);
  assert.deepEqual(onDeviceRemoved(st, ""), []);
  assert.deepEqual(onDeviceRemoved(st, null), []);
  assert.deepEqual(onDeviceRemoved(makeState(), "mac"), []);
  assert.deepEqual(onDeviceRemoved(null, "mac"), []);
  assert.deepEqual(onDeviceRemoved(st, "win"), [2, 5]);
  assert.deepEqual(st.accountDevices, { 1: [], 2: [], 3: null, 4: "lixo", 5: [] });
});

test("devicesLabel: texto para o histórico", () => {
  const st = makeState();
  assert.equal(devicesLabel(st, null), "todos os serviços");
  assert.equal(devicesLabel(st, undefined), "todos os serviços");
  assert.equal(devicesLabel(st, []), "nenhum serviço");
  assert.equal(devicesLabel(st, ["mac"]), '"Mac"');
  assert.equal(devicesLabel(st, ["mac", "win"]), '"Mac" e "Windows"');
  assert.equal(devicesLabel(st, ["mac", "win", "linux"]), '"Mac", "Windows" e "Linux"');
  assert.equal(devicesLabel(st, ["sumiu"]), '"sumiu"', "sem o serviço, mostra o id");
  assert.equal(devicesLabel(null, ["mac"]), '"mac"');
});
