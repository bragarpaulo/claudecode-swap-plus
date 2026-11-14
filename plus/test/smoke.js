"use strict";
// Teste de fumaça: carrega a extensão com a API do VS Code simulada e roda
// contra o cswap real da máquina. Leituras e simulação (--dry-run) sempre;
// as gravações são feitas e desfeitas numa conta que não está em uso.
//
//   node test/smoke.js            # tudo
//   node test/smoke.js --readonly # sem gravações
//   node test/smoke.js --dump <arquivo.json>  # salva o estado (e-mails trocados) p/ o preview

const Module = require("module");
const path = require("path");
const fs = require("fs");
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
    createStatusBarItem: (id) => { const it = { id, text: "", tooltip: "", shown: false, show() { this.shown = true; } }; items.push(it); return it; },
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
        store[`${ns}.${k}`] = v;
        const full = `${ns}.${k}`;
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
const home = require("os").homedir();
const cswapBin = ["swap-plus", "cswap"].map((n) => path.join(home, ".local/bin", n)).find((p) => fs.existsSync(p)) || "swap-plus";
const cswap = (...args) => execFileSync(cswapBin, args, { encoding: "utf8" });

(async () => {
  const context = {
    subscriptions: [],
    extensionUri: { fsPath: root },
    extensionPath: root,
    globalState: { get: (k) => globalState.get(k), update: async (k, v) => { globalState.set(k, v); } },
  };

  console.log("\n# 1. Ativação e barra de status");
  ext.activate(context);
  for (let i = 0; i < 60 && !items.every((it) => it.shown); i++) await sleep(250);
  const [mail, usage] = items;
  const raw = JSON.parse(cswap("list", "--json"));
  const active = raw.accounts.find((a) => a.number === raw.activeAccountNumber);
  console.log("     ícone :", JSON.stringify(mail.text));
  console.log("     uso   :", JSON.stringify(usage.text));
  check("ícone de e-mail sem endereço na barra", mail.text === "$(mail)");
  check("nenhum e-mail no texto da barra", !/@/.test(mail.text + usage.text));
  check("hover do ícone mostra o e-mail da conta ativa", String(mail.tooltip.value).includes(active.email));
  check("uso mostra 5h e 7d", /5h: /.test(usage.text) && /7d: /.test(usage.text));
  const scopedNames = ((active.usage || {}).scoped || []).map((s) => s.name);
  if (scopedNames.length) check(`barra mostra o semanal do ${scopedNames[0]}`, usage.text.includes(`${scopedNames[0]}:`));
  check("hover do uso lista renovação e estado da troca automática", /Semanal:/.test(usage.tooltip.value) && /Troca automática/.test(usage.tooltip.value));
  console.log("     hover do uso:\n" + redact(usage.tooltip.value).split("\n").map((l) => "       | " + l).join("\n"));

  console.log("\n# 1b. Clique na barra: lista de contas + Configurações");
  check("os dois itens da barra abrem a mesma lista", mail.command === "swapPlus.switchAccount" && usage.command === "swapPlus.switchAccount");
  await commands["swapPlus.switchAccount"]();
  const menu = vscodeMock.lastPick || [];
  check("“Configurações” é a primeira opção", /Configurações/.test(menu[0].label), menu[0].label);
  const accRows = menu.filter((m) => m.accountNum > 0);
  check("lista todas as contas", accRows.length === raw.accounts.length, `${accRows.length} contas`);
  check("só a conta em uso está marcada", accRows.filter((m) => m.label.startsWith("$(check)")).length === 1 && accRows.find((m) => m.label.startsWith("$(check)")).accountNum === raw.activeAccountNumber);
  check("tem atalho de liga/desliga e de adicionar conta", menu.some((m) => m.accountNum === -3) && menu.some((m) => m.accountNum === -1));
  accRows.slice(0, 3).forEach((m) => console.log("       › " + m.label + "  " + redact(m.description) + "  [" + m.detail + "]"));

  console.log("\n# 2. Tela de configuração");
  commands["swapPlus.openSettings"]();
  check("HTML sem marcadores pendentes", !/\{\{\w+\}\}/.test(panel.webview.html));
  await sendAndWait({ type: "ready" }, 300);
  for (let i = 0; i < 40 && !lastState(); i++) await sleep(250);
  let st = lastState();
  check("estado enviado para a tela", !!st);
  check("todas as contas presentes", st.accounts.length === raw.accounts.length, `${st.accounts.length} contas`);
  check("exatamente uma conta em uso", st.accounts.filter((a) => a.active).length === 1);
  check("regras do cswap carregadas", st.rules["autoswitch.threshold"] > 0 && !!st.rules["autoswitch.strategy"], `5h=${st.rules["autoswitch.threshold"]} estratégia=${st.rules["autoswitch.strategy"]}`);
  check("limites por modelo detectados", Array.isArray(st.modelNames), st.modelNames.join(", ") || "(nenhum)");
  check("alertas carregados", st.alerts.fiveHourPct === 80 && st.alerts.weeklyEnabled === true);
  check("renovação semanal com horário", st.accounts.some((a) => a.sevenDay && a.sevenDay.resetTs > Date.now()));

  console.log("\n# 3. Simulação de troca (cswap auto --once --dry-run)");
  const before = JSON.parse(cswap("list", "--json")).activeAccountNumber;
  await sendAndWait({ type: "checkNow", dryRun: true }, 200);
  const t = lastToast();
  check("simulação respondeu", !!t && /^Simulação: /.test(t.text), t && redact(t.text));
  check("simulação não trocou a conta", JSON.parse(cswap("list", "--json")).activeAccountNumber === before);
  check("simulação não entra no histórico", (globalState.get("swapPlus.autoHistory") || []).length === 0);

  console.log("\n# 4. Liga/desliga da troca automática");
  await sendAndWait({ type: "setAuto", enabled: true }, 150);
  check("barra mostra o indicador de automático", usage.text.includes("$(sync)"));
  check("tela recebe automático ligado", lastState().auto.enabled === true);
  await sendAndWait({ type: "setAuto", enabled: false }, 150); // desliga antes do 1º ciclo (5 s)
  check("desligou de novo", !usage.text.includes("$(sync)") && lastState().auto.enabled === false);

  console.log("\n# 5. Alertas (chegou a X% → avisar)");
  await sendAndWait({ type: "saveRules", values: {}, alerts: { ...st.alerts, fiveHourPct: 1, weeklyPct: 1, modelPct: 1 } }, 600);
  for (let i = 0; i < 40 && notifications.filter((n) => n[0] === "warn").length === 0; i++) await sleep(250);
  const warns = notifications.filter((n) => n[0] === "warn").map((n) => n[1]);
  const au = (active.usage || {});
  const expected = [au.fiveHour && au.fiveHour.pct >= 1, au.sevenDay && au.sevenDay.pct >= 1, ...(au.scoped || []).map((s) => s.pct >= 1)].filter(Boolean).length;
  check("alerta dispara ao cruzar a linha", warns.length === expected, `${warns.length} de ${expected} esperados`);
  warns.forEach((w) => console.log("       › " + redact(w)));
  const n0 = notifications.length;
  await commands["swapPlus.refreshStatus"]();
  await sleep(300);
  check("não repete o mesmo alerta no ciclo", notifications.length === n0);
  check("alerta registrado no histórico", (globalState.get("swapPlus.autoHistory") || []).filter((h) => h.kind === "alert").length === expected);
  await sendAndWait({ type: "saveRules", values: {}, alerts: st.alerts }, 300);
  check("alertas restaurados", lastState().alerts.fiveHourPct === 80);

  if (READONLY) {
    console.log("\n# 6-7. Gravações puladas (--readonly)");
  } else {
    const target = st.accounts.find((a) => !a.active && !a.disabled && a.threshold == null && !a.priority && !a.alias);
    console.log(`\n# 6. Ajustes por conta (ida e volta na conta #${target.number}, que não está em uso)`);
    const acc = () => lastState().accounts.find((a) => a.number === target.number);
    const op = async (o, value) => { await sendAndWait({ type: "account", number: target.number, op: o, value }, 300); };
    try {
      await op("threshold", 72); check("limite próprio gravado", acc().threshold === 72);
      await op("priority", 3); check("prioridade gravada", acc().priority === 3);
      await op("disabled", true); check("tirada da rotação", acc().disabled === true);
      await op("alias", "teste-smoke"); check("apelido gravado", acc().alias === "teste-smoke");
    } finally {
      await op("alias", ""); await op("disabled", false); await op("priority", 0); await op("threshold", null);
    }
    check("tudo desfeito", acc().threshold == null && acc().priority === 0 && acc().disabled === false && !acc().alias);

    console.log("\n# 7. Salvar regras (ida e volta)");
    const conf = () => Object.fromEntries(JSON.parse(cswap("config", "--json")).settings.map((s) => [s.key, s]));
    const orig = conf();
    const keys = ["autoswitch.threshold", "autoswitch.weeklyThreshold", "autoswitch.strategy", "autoswitch.model", "autoswitch.hysteresisPct", "autoswitch.cooldownSeconds"];
    try {
      await sendAndWait({ type: "saveRules", values: { "autoswitch.threshold": 88, "autoswitch.weeklyThreshold": 96, "autoswitch.strategy": "consume-first", "autoswitch.model": st.modelNames[0] || null, "autoswitch.hysteresisPct": 12, "autoswitch.cooldownSeconds": 600 } }, 400);
      const c = conf();
      check("linha de 5h gravada no cswap", c["autoswitch.threshold"].value === 88);
      check("linha semanal gravada", c["autoswitch.weeklyThreshold"].value === 96);
      check("estratégia “aproveitar ao máximo” gravada", c["autoswitch.strategy"].value === "consume-first");
      if (st.modelNames[0]) check(`limite do ${st.modelNames[0]} entra na troca`, c["autoswitch.model"].value === st.modelNames[0]);
      check("avançado gravado", c["autoswitch.hysteresisPct"].value === 12 && c["autoswitch.cooldownSeconds"].value === 600);
      check("sem erro ao salvar", lastToast().kind !== "error", lastToast().text);
    } finally {
      for (const k of keys) {
        if (orig[k].isSet) cswap("config", "set", k, String(orig[k].value));
        else { try { cswap("config", "unset", k); } catch {} }
      }
    }
    const back = conf();
    check("configuração original restaurada", keys.every((k) => back[k].value === orig[k].value && back[k].isSet === orig[k].isSet));
    check("conta em uso não mudou durante o teste", JSON.parse(cswap("list", "--json")).activeAccountNumber === before);
  }

  if (DUMP) {
    await commands["swapPlus.refreshStatus"]();
    const s = JSON.parse(JSON.stringify(lastState()));
    s.accounts.forEach((a) => { a.email = `conta${a.number}@exemplo.com`; a.org = a.org ? `Organização ${a.plan || ""}`.trim() : ""; });
    s.auto.history.forEach((hh) => (hh.text = redact(hh.text)));
    fs.writeFileSync(DUMP, JSON.stringify(s));
    console.log(`\nestado salvo em ${DUMP}`);
  }

  ext.deactivate();
  console.log(failed ? `\n${failed} verificação(ões) falharam.` : "\nTudo certo.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
