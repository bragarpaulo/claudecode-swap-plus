"use strict";
// Teste da extensão Swap Plus.
//   Parte A: regra de decisão de troca, com contas simuladas (não toca em nada).
//   Parte B: extensão carregada com a API do VS Code simulada, contra o
//            swap-plus real. Leituras e simulação sempre; as gravações por
//            conta são feitas e desfeitas numa conta que não está em uso.
//            A conta ativa nunca é trocada.
//
//   node test/smoke.js            # tudo
//   node test/smoke.js --readonly # sem gravações
//   node test/smoke.js --dump <arquivo.json>  # salva o estado (e-mails trocados) p/ o preview

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const READONLY = process.argv.includes("--readonly");
const dumpIdx = process.argv.indexOf("--dump");
const DUMP = dumpIdx > -1 ? process.argv[dumpIdx + 1] : null;
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// ------------------------------------------------------------ vscode falso
const defaults = {};
for (const [k, v] of Object.entries(manifest.contributes.configuration.properties)) defaults[k] = v.default;
const store = {};
const cfgListeners = [];
const commands = {};
const notifications = [];
const items = [];
let panel = null;

class MarkdownString {
  constructor() { this.value = ""; }
  appendMarkdown(s) { this.value += s; return this; }
  appendText(s) { this.value += s; return this; }
}
const globalState = new Map();
const vscodeMock = {
  MarkdownString,
  ThemeColor: class { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  Uri: { joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString() { return this.fsPath; } }) },
  window: {
    createStatusBarItem: (id) => { const it = { id, text: "", tooltip: "", shown: false, show() { this.shown = true; }, hide() { this.shown = false; } }; items.push(it); return it; },
    showInformationMessage: (m) => { notifications.push(["info", m]); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { notifications.push(["warn", m]); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { notifications.push(["error", m]); return Promise.resolve(undefined); },
    withProgress: (_o, fn) => fn(),
    showQuickPick: (list) => { vscodeMock.lastPick = list; return Promise.resolve(undefined); },
    createTerminal: () => ({ show() {}, sendText() {} }),
    createWebviewPanel: () => {
      panel = {
        messages: [],
        webview: {
          cspSource: "vscode-resource:",
          html: "",
          asWebviewUri: (u) => `webview://${u.fsPath}`,
          postMessage: (m) => { panel.messages.push(m); return Promise.resolve(true); },
          onDidReceiveMessage: (fn) => { panel.receive = fn; },
        },
        onDidDispose: () => {},
        reveal: () => {},
      };
      return panel;
    },
  },
  workspace: {
    getConfiguration: (ns) => ({
      get: (k) => { const key = `${ns}.${k}`; return key in store ? store[key] : defaults[key]; },
      update: async (k, v) => {
        const full = `${ns}.${k}`;
        store[full] = v;
        for (const fn of cfgListeners) fn({ affectsConfiguration: (q) => full === q || full.startsWith(q + ".") });
      },
    }),
    onDidChangeConfiguration: (fn) => { cfgListeners.push(fn); return { dispose() {} }; },
  },
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; } },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "vscode") return vscodeMock;
  return origLoad.apply(this, arguments);
};

// ------------------------------------------------------------ utilitários
const ext = require(path.join(root, manifest.main));
const T = ext._test;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log(`${cond ? "  ok  " : " FALHA"}  ${name}${extra ? `  — ${extra}` : ""}`);
}
const redact = (s) => String(s).replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/g, "<email>");
const lastState = () => [...panel.messages].reverse().find((m) => m.type === "state");
const lastToast = () => [...panel.messages].reverse().find((m) => m.type === "toast");
async function sendAndWait(msg, ms = 400) { await panel.receive(msg); await sleep(ms); }
const home = os.homedir();
const cswapBin = ["swap-plus", "cswap"].map((n) => path.join(home, ".local/bin", n)).find((p) => fs.existsSync(p)) || "swap-plus";
const cswap = (...args) => execFileSync(cswapBin, args, { encoding: "utf8" });

// ------------------------------------------------------------ parte A: decisão
const HOUR = 3600e3;
function acct(n, o = {}) {
  const now = Date.now();
  const at = (h) => new Date(now + h * HOUR).toISOString();
  return {
    number: n,
    email: `conta${n}@exemplo.com`,
    usageStatus: o.status || "ok",
    usageAgeSeconds: o.age ?? 30,
    usage: {
      ...(o.s === null ? {} : { fiveHour: { pct: o.s || 0, resetsAt: at(2) } }),
      sevenDay: { pct: o.w || 0, resetsAt: at(o.wReset ?? 48) },
      scoped: [{ name: "Fable", pct: o.f || 0, resetsAt: at(o.fReset ?? o.wReset ?? 48) }],
    },
  };
}
const R = { sessionPct: 90, weeklyPct: 80, modelPct: 95, preferModel: "Fable", strategy: "headroom", expiringHours: 24, cooldownMin: 5, marginPct: 5, intervalSec: 60 };
const OPUS = ["claude-opus-5-5"];
const FABLE = ["claude-fable-5-2"];
const run = (accounts, active, opts = {}) =>
  T.decide({ list: { activeAccountNumber: active, accounts }, records: opts.records || {}, r: { ...R, ...(opts.r || {}) }, modelIds: opts.models || OPUS, now: Date.now(), lastSwitchAt: opts.lastSwitchAt || 0, force: opts.force });

function partA() {
  console.log("\n# A. Regra de decisão (contas simuladas)");
  let d;
  d = run([acct(1, { w: 81 }), acct(2, { w: 10 }), acct(3, { w: 40 })], 1);
  check("semanal chegou a 80% → troca", d.action === "switch" && d.to === 2, d.text);
  d = run([acct(1, { w: 79 }), acct(2, { w: 10 })], 1);
  check("semanal em 79% → não troca", d.action === "none" && d.kind === "idle", d.text);
  d = run([acct(1, { w: 50, f: 96 }), acct(2, { w: 10, f: 97 }), acct(3, { w: 30, f: 20 })], 1, { models: FABLE });
  check("Fable em uso e em 96% → troca para conta com Fable livre", d.action === "switch" && d.to === 3, d.text);
  d = run([acct(1, { w: 50, f: 94 }), acct(2, { w: 10, f: 0 })], 1, { models: FABLE });
  check("Fable em uso e em 94% → não troca", d.action === "none", d.text);
  d = run([acct(1, { w: 50, f: 99 }), acct(2, { w: 10 })], 1, { models: OPUS });
  check("Fable em 99% mas usando Opus → não troca", d.action === "none", d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 5, f: 97 }), acct(3, { w: 40, f: 20 })], 1, { models: OPUS });
  check("na troca, prefere conta com Fable disponível", d.action === "switch" && d.to === 3, d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 5, f: 97 }), acct(3, { w: 40, f: 20 })], 1, { models: OPUS, r: { preferModel: "" } });
  check("sem preferência de modelo → vai para a de mais folga", d.action === "switch" && d.to === 2, d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 5 }), acct(3, { w: 40 })], 1, { records: { 2: { disabled: true } } });
  check("conta fora da rotação é ignorada", d.action === "switch" && d.to === 3, d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 90 }), acct(3, { w: 82 })], 1);
  check("todas no limite → bloqueado, sem troca", d.action === "none" && d.kind === "blocked", d.text);
  d = run([acct(1, { s: 91, w: 20 }), acct(2, { s: 10, w: 10 })], 1);
  check("sessão de 5h chegou a 90% → troca", d.action === "switch" && d.to === 2, d.text);
  d = run([acct(1, { s: 75, w: 20 }), acct(2, { w: 10 })], 1, { records: { 1: { threshold: 70 } } });
  check("linha própria da conta (70%) vale para a sessão", d.action === "switch", d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 20, wReset: 100 }), acct(3, { w: 60, wReset: 5 })], 1, { r: { strategy: "max" } });
  check("aproveitar ao máximo: vai para a que renova antes", d.action === "switch" && d.to === 3, d.text);
  d = run([acct(1, { w: 30, wReset: 120 }), acct(2, { w: 10, wReset: 6 })], 1, { r: { strategy: "max" } });
  check("aproveitar ao máximo: antecipa troca para cota que vai zerar", d.action === "switch" && d.to === 2, d.text);
  d = run([acct(1, { w: 30, wReset: 120 }), acct(2, { w: 10, wReset: 6 })], 1, { r: { strategy: "max" }, lastSwitchAt: Date.now() - 60e3 });
  check("antecipação respeita o tempo mínimo entre trocas", d.action === "none", d.text);
  d = run([acct(1, { w: 30, wReset: 120 }), acct(2, { w: 10, wReset: 6 })], 1);
  check("“mais folga” não antecipa troca", d.action === "none", d.text);
  d = run([acct(1, { w: 85, age: 3600 }), acct(2, { w: 10 })], 1);
  check("dados velhos da conta ativa → não decide", d.action === "none", d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 10, age: 3600 }), acct(3, { w: 50 })], 1);
  check("conta com dados velhos não é destino", d.action === "switch" && d.to === 3, d.text);

  check("nome do modelo: claude-fable-5-2 → Fable 5.2", T.modelLabel("claude-fable-5-2") === "Fable 5.2");
  check("limite do Fable reconhecido pelo id do modelo", T.watchedModels(["claude-fable-5-2"], ["Fable"]).join() === "Fable");
  check("Opus não liga o limite do Fable", T.watchedModels(["claude-opus-5-5"], ["Fable"]).length === 0);

  const a = acct(9, { s: 20, w: 71, f: 57, wReset: 6 });
  const det = T.pickerDetail(a, T.windows(a), { session: 90, weekly: 80, model: 95 }, false);
  console.log("     linha de baixo da lista: " + det);
  check("lista: sessão diz quanto sobra", /Sessão 5h sobra 80%/.test(det));
  check("lista: semanal e Fable com % usado e renovação", /Semanal 71%.*Fable 57% usados, renovam /.test(det));
  check("lista: semanal em 71% fica amarelo, Fable em 57% verde", /🟡 Semanal/.test(det) && /🟢 Fable/.test(det));
  const b = acct(9, { w: 81, f: 96 });
  const det2 = T.pickerDetail(b, T.windows(b), { session: 90, weekly: 80, model: 95 }, false);
  check("lista: na linha de troca fica vermelho", /🔴 Semanal/.test(det2) && /🔴 Fable/.test(det2));
}

// ------------------------------------------------------------ parte B: integração
async function partB() {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: root },
    extensionPath: root,
    globalState: { get: (k) => globalState.get(k), update: async (k, v) => { globalState.set(k, v); } },
  };

  console.log("\n# B1. Barra de status (swap-plus real)");
  ext.activate(context);
  for (let i = 0; i < 80 && !(items[0] && items[0].shown && items[1] && items[1].text.startsWith("Sessão")); i++) await sleep(250);
  const raw = JSON.parse(cswap("list", "--json"));
  const active = raw.accounts.find((a) => a.number === raw.activeAccountNumber);
  const byId = (id) => items.find((it) => it.id === id);
  const mail = byId("swapPlus.mail"), sess = byId("swapPlus.session"), week = byId("swapPlus.weekly");
  const model = items.find((it) => it.id.startsWith("swapPlus.model."));
  const shown = items.filter((it) => it.shown).map((it) => it.text);
  console.log("     barra:", shown.map((t) => JSON.stringify(t)).join("  "));
  check("ícone de e-mail sem endereço", mail.text === "$(mail)");
  check("nenhum e-mail no texto da barra", !shown.some((t) => /@/.test(t)));
  check("hover do ícone mostra o e-mail em negrito", String(mail.tooltip.value).includes(`**${active.email}**`) || String(mail.tooltip.value).includes(active.email));
  check("sessão, semanal e Fable em itens separados", sess.text.startsWith("Sessão") && week.text.startsWith("Semanal") && !!model && model.text.startsWith("Fable"));
  const colorOk = (it, pct, line) => { const want = pct >= line ? "charts.red" : pct >= 70 ? "charts.yellow" : undefined; return (it.color && it.color.id) === want; };
  const u = active.usage || {};
  check("cor de cada item segue o uso", colorOk(week, u.sevenDay.pct, 80) && colorOk(sess, u.fiveHour ? u.fiveHour.pct : 0, 90), `semanal ${u.sevenDay.pct}% → ${week.color ? week.color.id : "normal"}`);
  check("hover sem “troca automática”", !/[Tt]roca automática/.test(sess.tooltip.value));
  console.log("     hover:\n" + redact(sess.tooltip.value).split("\n").map((l) => "       | " + l).join("\n"));

  console.log("\n# B2. Clique na barra: lista de contas");
  check("todos os itens abrem a lista", [mail, sess, week].every((it) => it.command === "swapPlus.switchAccount"));
  await commands["swapPlus.switchAccount"]();
  const menu = vscodeMock.lastPick || [];
  check("“Configurações” é a primeira opção", /Configurações/.test(menu[0].label));
  check("sem a opção de troca automática na lista", !menu.some((m) => /Troca automática/.test(m.label || "")));
  const accRows = menu.filter((m) => m.accountNum > 0);
  check("lista todas as contas", accRows.length === raw.accounts.length, `${accRows.length} contas`);
  check("só a conta em uso tem o check", accRows.filter((m) => m.label.startsWith("$(check)")).length === 1 && accRows.find((m) => m.label.startsWith("$(check)")).accountNum === raw.activeAccountNumber);
  check("linha de cima: conta e e-mail", accRows.every((m) => /Conta \d+.* — .+@/.test(m.label)));
  check("linha de baixo: sobra da sessão, semanal e renovação", accRows.every((m) => /Sessão 5h sobra \d+%/.test(m.detail) && /Semanal \d+%/.test(m.detail) && /renova/.test(m.detail)));
  accRows.slice(0, 3).forEach((m) => console.log("       › " + redact(m.label) + "\n         " + m.detail));

  console.log("\n# B3. Tela de configurações");
  commands["swapPlus.openSettings"]();
  check("HTML sem marcadores pendentes", !/\{\{\w+\}\}/.test(panel.webview.html));
  await sendAndWait({ type: "ready" }, 300);
  for (let i = 0; i < 40 && !lastState(); i++) await sleep(250);
  const st = lastState();
  check("estado enviado para a tela", !!st);
  check("todas as contas presentes", st.accounts.length === raw.accounts.length);
  check("regras padrão: semanal 80%, Fable 95%, sessão 90%", st.rules.weeklyPct === 80 && st.rules.modelPct === 95 && st.rules.sessionPct === 90);
  check("preferência pelo Fable ligada", st.rules.preferModel === "Fable");
  check("modelo em uso detectado", st.modelsInUse.length > 0, st.modelsInUse.map((m) => m.label).join(", "));
  check("avisos 10 pontos antes da troca", st.alerts.weeklyPct === 70 && st.alerts.modelPct === 85 && st.alerts.fiveHourPct === 80);

  console.log("\n# B4. Simulação (não troca)");
  const before = JSON.parse(cswap("list", "--json")).activeAccountNumber;
  await sendAndWait({ type: "checkNow", dryRun: true }, 200);
  const t = lastToast();
  check("simulação respondeu", !!t && /^Simulação: /.test(t.text), t && redact(t.text));
  check("simulação não trocou a conta", JSON.parse(cswap("list", "--json")).activeAccountNumber === before);

  console.log("\n# B5. Liga/desliga da troca automática");
  await sendAndWait({ type: "setAuto", enabled: true }, 150);
  check("tela recebe automático ligado", lastState().auto.enabled === true);
  check("barra continua sem indicador de automático", !items.some((it) => it.shown && /\$\(sync\)/.test(it.text)));
  await sendAndWait({ type: "setAuto", enabled: false }, 150); // desliga antes do 1º ciclo (5 s)
  check("desligou de novo", lastState().auto.enabled === false);

  console.log("\n# B6. Salvar regras (só configurações do VS Code)");
  await sendAndWait({ type: "saveRules", rules: { ...st.rules, weeklyPct: 77, modelPct: 93, strategy: "max", preferModel: "" }, alerts: st.alerts }, 200);
  const s2 = lastState();
  check("regras gravadas", s2.rules.weeklyPct === 77 && s2.rules.modelPct === 93 && s2.rules.strategy === "max" && s2.rules.preferModel === "");
  await sendAndWait({ type: "saveRules", rules: st.rules, alerts: st.alerts }, 200);
  check("regras restauradas", lastState().rules.weeklyPct === 80 && lastState().rules.preferModel === "Fable");

  console.log("\n# B7. Alertas (chegou a X% → avisar)");
  await sendAndWait({ type: "saveRules", rules: st.rules, alerts: { ...st.alerts, fiveHourPct: 1, weeklyPct: 1, modelPct: 1 } }, 200);
  await commands["swapPlus.refreshStatus"]();
  for (let i = 0; i < 40 && notifications.filter((n) => n[0] === "warn").length === 0; i++) await sleep(250);
  await sleep(1000); // os avisos chegam um depois do outro
  const warns = notifications.filter((n) => n[0] === "warn").map((n) => n[1]);
  const expected = [u.fiveHour && u.fiveHour.pct >= 1, u.sevenDay && u.sevenDay.pct >= 1, ...(u.scoped || []).map((s) => s.pct >= 1)].filter(Boolean).length;
  check("alerta dispara ao cruzar a linha", warns.length === expected, `${warns.length} de ${expected}`);
  const n0 = notifications.length;
  await commands["swapPlus.refreshStatus"]();
  await sleep(300);
  check("não repete o mesmo alerta", notifications.length === n0);
  await sendAndWait({ type: "saveRules", rules: st.rules, alerts: st.alerts }, 200);

  if (READONLY) {
    console.log("\n# B8. Gravações por conta puladas (--readonly)");
  } else {
    const target = st.accounts.find((a) => !a.active && !a.disabled && a.threshold == null && !a.priority && !a.alias);
    console.log(`\n# B8. Ajustes por conta (ida e volta na conta ${target.number}, que não está em uso)`);
    const accNow = () => lastState().accounts.find((a) => a.number === target.number);
    const op = async (o, value) => { await sendAndWait({ type: "account", number: target.number, op: o, value }, 300); };
    try {
      await op("threshold", 72); check("linha própria gravada", accNow().threshold === 72);
      await op("priority", 3); check("prioridade gravada", accNow().priority === 3);
      await op("disabled", true); check("tirada da rotação", accNow().disabled === true);
      await op("alias", "teste-smoke"); check("apelido gravado", accNow().alias === "teste-smoke");
    } finally {
      await op("alias", ""); await op("disabled", false); await op("priority", 0); await op("threshold", null);
    }
    check("tudo desfeito", accNow().threshold == null && accNow().priority === 0 && accNow().disabled === false && !accNow().alias);
  }
  check("conta em uso não mudou durante o teste", JSON.parse(cswap("list", "--json")).activeAccountNumber === before);

  if (DUMP) {
    await commands["swapPlus.refreshStatus"]();
    const s = JSON.parse(JSON.stringify(lastState()));
    s.accounts.forEach((a) => { a.email = `conta${a.number}@exemplo.com`; a.org = a.org ? `Organização ${a.plan || ""}`.trim() : ""; });
    s.auto.history.forEach((hh) => (hh.text = redact(hh.text)));
    fs.writeFileSync(DUMP, JSON.stringify(s));
    console.log(`\nestado salvo em ${DUMP}`);
  }
  ext.deactivate();
}

(async () => {
  partA();
  await partB();
  console.log(failed ? `\n${failed} verificação(ões) falharam.` : "\nTudo certo.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
