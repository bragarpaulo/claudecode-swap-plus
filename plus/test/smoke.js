"use strict";
// Teste da extensão Swap Plus.
//   Parte A: regra de decisão de troca, com contas simuladas (não toca em nada).
//   Parte B: extensão carregada com a API do VS Code simulada, contra o
//            swap-plus real. Leituras e simulação sempre; as gravações por
//            conta são feitas e desfeitas numa conta que não está em uso.
//            A conta ativa nunca é trocada.
//
//   node test/smoke.js            # tudo
//   node test/smoke.js --unit     # só os testes com dados simulados (usado no GitHub Actions)
//   node test/smoke.js --readonly # sem gravações
//   node test/smoke.js --no-github # sem consultar o GitHub
//   node test/smoke.js --dump <arquivo.json>  # salva o estado (e-mails trocados) p/ o preview

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync } = require("child_process");

const READONLY = process.argv.includes("--readonly");
const UNIT = process.argv.includes("--unit");
const NO_GITHUB = process.argv.includes("--no-github");
const dumpIdx = process.argv.indexOf("--dump");
const DUMP = dumpIdx > -1 ? process.argv[dumpIdx + 1] : null;
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// ------------------------------------------------------------ vscode falso
const defaults = {};
for (const [k, v] of Object.entries(manifest.contributes.configuration.properties)) defaults[k] = v.default;
const store = { "swapPlus.updates.enabled": false }; // o teste chama o atualizador à mão
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
  env: { appRoot: "/nao-existe" },
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString() { return this.fsPath; } }),
    file: (p) => ({ fsPath: p, toString() { return p; } }),
  },
  window: {
    createStatusBarItem: (id) => { const it = { id, text: "", tooltip: "", shown: false, show() { this.shown = true; }, hide() { this.shown = false; } }; items.push(it); return it; },
    showInformationMessage: (m) => { notifications.push(["info", m]); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { notifications.push(["warn", m]); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { notifications.push(["error", m]); return Promise.resolve(undefined); },
    withProgress: (_o, fn) => fn(),
    showQuickPick: (list) => { vscodeMock.lastPick = list; return Promise.resolve(undefined); },
    showSaveDialog: () => Promise.resolve(vscodeMock.nextSave ? { fsPath: vscodeMock.nextSave } : undefined),
    showOpenDialog: () => Promise.resolve(vscodeMock.nextOpen ? [{ fsPath: vscodeMock.nextOpen }] : undefined),
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
  commands: { registerCommand: (id, fn) => { commands[id] = fn; return { dispose() {} }; }, executeCommand: () => Promise.resolve() },
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
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-test-"));
const EMOJI = /\p{Extended_Pictographic}/u;

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
const R = { sessionPct: 90, weeklyPct: 80, modelPct: 95, preferModel: "Fable", strategy: "headroom", expiringHours: 24, cooldownMin: 5, marginPct: 5, intervalSec: 60, onModelLimit: "switchAccount" };
const OPUS = ["claude-opus-5-5"];
const FABLE = ["claude-fable-5-2"];
const run = (accounts, active, opts = {}) =>
  T.decide({ list: { activeAccountNumber: active, accounts }, records: opts.records || {}, r: { ...R, ...(opts.r || {}) }, modelIds: opts.models || OPUS, now: Date.now(), lastSwitchAt: opts.lastSwitchAt || 0, force: opts.force, limitHit: opts.limitHit || null });

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
  d = run([acct(1, { w: 50, f: 100 }), acct(2, { w: 10, f: 0 })], 1, { models: FABLE, r: { onModelLimit: "sameAccount" } });
  check("“mesma conta”: Fable esgotado → não troca de conta (o Claude Code troca o modelo)", d.action === "none", d.text);
  d = run([acct(1, { w: 85, f: 100 }), acct(2, { w: 10, f: 0 }), acct(3, { w: 5, f: 99 })], 1, { models: FABLE, r: { onModelLimit: "sameAccount" } });
  check("“mesma conta”: semanal estourado ainda troca, preferindo conta com Fable", d.action === "switch" && d.to === 2, d.text);
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
  d = run([acct(1, { w: 85 }), acct(2, { w: 10, age: 7200 }), acct(3, { w: 50 })], 1);
  check("conta com dados de mais de 1 h não é destino", d.action === "switch" && d.to === 3, d.text);
  d = run([acct(1, { w: 85 }), acct(2, { w: 10, age: 1800 }), acct(3, { w: 50 })], 1);
  check("conta com dados de 30 min ainda vale como destino", d.action === "switch" && d.to === 2, d.text);
  // O print do Windows (14/11 18:19): conta 7 em uso; a 8 renova o semanal em 2h41 com 70% sobrando.
  const print = [acct(7, { s: 13, w: 10, f: 4, wReset: 89 }), acct(8, { s: 0, w: 30, f: 4, wReset: 2.7 }), acct(5, { s: 0, w: 31, f: 15, wReset: 67 }), acct(6, { s: 100, w: 40, f: 30, wReset: 50 })];
  d = run(print, 7, { r: { strategy: "max", onModelLimit: "sameAccount" }, models: FABLE, lastSwitchAt: Date.now() - 15 * 60e3 });
  check("print do Windows, “aproveitar ao máximo”: vai para a conta 8", d.action === "switch" && d.to === 8, d.text);
  d = run(print, 7, { r: { strategy: "headroom", onModelLimit: "sameAccount" }, models: FABLE });
  check("print do Windows, “mais folga”: fica (só troca na linha)", d.action === "none", d.text);

  // Ordem: quem participa primeiro, por renovação do semanal; quem não participa no fim, também por renovação.
  const ord = T.orderForDisplay(
    [acct(1, { w: 30, wReset: 50 }), acct(2, { w: 10, wReset: 5 }), acct(3, { w: 5, wReset: 1 }), acct(4, { w: 0, wReset: 20 }), acct(5, { w: 40, wReset: 20 }), acct(6, { w: 1, wReset: 3 })],
    { 3: { disabled: true }, 6: { disabled: true } }
  ).map((a) => a.number);
  check("ordem: participantes por renovação, depois os de fora", ord.join(",") === "2,4,5,1,3,6", ord.join(","));
  d = run([acct(1, { s: 70, w: 20, age: 3600 }), acct(2, { w: 10, age: 3600 }), acct(3, { w: 40, age: 3600 })], 1, { r: { onModelLimit: "sameAccount" }, limitHit: "limite da sessão de 5h" });
  check("limite estourado agora: troca mesmo com dados antigos", d.action === "switch" && d.to === 2 && d.atLimit === true, d.text);
  d = run([acct(1, { s: 70, w: 20 }), acct(2, { w: 95 })], 1, { limitHit: "limite da sessão de 5h" });
  check("limite estourado e nenhuma conta com folga → avisa, não troca", d.action === "none" && d.kind === "blocked", d.text);
  check("rótulos do erro", T.limitLabel("You've hit your 5-hour limit · resets 10:20pm") === "limite da sessão de 5h" && T.limitLabel("You've hit your weekly limit") === "limite semanal" && T.limitLabel("You've reached your Fable limit for this week") === null);
  check("nome do modelo: claude-fable-5-2 → Fable 5.2", T.modelLabel("claude-fable-5-2") === "Fable 5.2");
  check("limite do Fable reconhecido pelo id do modelo", T.watchedModels(["claude-fable-5-2"], ["Fable"]).join() === "Fable");
  check("Opus não liga o limite do Fable", T.watchedModels(["claude-opus-5-5"], ["Fable"]).length === 0);

  const a = acct(9, { s: 20, w: 71, f: 57, wReset: 6 });
  const pt = T.pickerTexts(a, T.windows(a), false);
  console.log("     ao lado do nome: " + pt.description);
  console.log("     linha de baixo : " + pt.detail);
  check("lista: sessão no formato “X% usado — renova …”", /^Sessão \(5h\): 20% usado — renova (hoje|amanhã) \d+h/.test(pt.description));
  check("lista: semanal e Fable no mesmo formato", /^Semanal: 71% usado — renova .+ {2}· {2}Fable: 57% usado — renova /.test(pt.detail));
  check("lista: sem emojis", !EMOJI.test(pt.description + pt.detail));
  const idle = acct(9, { s: null, w: 3 });
  check("lista: sessão sem uso não mostra renovação", T.pickerTexts(idle, T.windows(idle), false).description === "Sessão (5h): 0% usado");
}

// ------------------------------------------------------------ parte I: leitura do arquivo de import
function partI() {
  console.log("\n# I. Leitura do arquivo de import (transferências entre Mac e Windows)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-read-"));
  const good = { version: 1, accounts: [{ email: "a@exemplo.com", credentials: {}, config: {} }], swapPlus: { hideEmails: true } };
  const json = JSON.stringify(good, null, 2);
  const put = (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, data); return f; };
  const ok = (name, data, wantNorm) => {
    const r = T.readExportFile(put(name, data));
    check(`aceita: ${name}`, !r.error && r.env.accounts.length === 1 && r.normalized === wantNorm && JSON.parse(r.text).version === 1, r.error || "");
  };
  const bad = (name, data, re, fname) => {
    const r = T.readExportFile(put(fname || name, data));
    check(`recusa com motivo: ${name}`, !!r.error && re.test(r.error), r.error || "aceitou");
    return r;
  };
  ok("UTF-8 normal", json, false);
  ok("UTF-8 com BOM (Bloco de Notas)", "\uFEFF" + json, true);
  ok("quebras de linha do Windows (CRLF)", json.replace(/\n/g, "\r\n"), false);
  ok("espaços e linha em branco no fim", json + "\n\n  ", false);
  ok("UTF-16 LE com BOM", Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(json, "utf16le")]), true);
  ok("UTF-16 LE sem BOM", Buffer.from(json, "utf16le"), true);
  const be = Buffer.from(json, "utf16le"); be.swap16();
  ok("UTF-16 BE com BOM", Buffer.concat([Buffer.from([0xfe, 0xff]), be]), true);
  bad("arquivo “._” do Mac no pen drive", Buffer.concat([Buffer.from([0x00, 0x05, 0x16, 0x07, 0x00, 0x02, 0x00, 0x00]), Buffer.from("Mac OS X        ")]), /arquivo auxiliar.*“swap-plus-other\.cswap”/, "._swap-plus-other.cswap");
  bad("vazio (nuvem não baixada)", "", /vazio/);
  bad("zip", Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]), /\.zip/);
  bad("texto colado com aspas curvas", json.replace(/"/g, "”"), /aspas curvas/);
  const r = bad("outro tipo de arquivo", "olá, isto não é json", /não é um export/);
  check("mensagem não mostra o arquivo inteiro", r.error.length < 400);
  bad("JSON sem contas (ex.: swap-plus list)", JSON.stringify({ schemaVersion: 1, activeAccountNumber: 1 }), /lista de contas/);
  bad("export criptografado", JSON.stringify({ version: 1, encrypted: true, accounts: [] }), /criptografado/);
  bad("formato desconhecido", JSON.stringify({ version: 9, accounts: [{}] }), /versão 9/);
  bad("export sem nenhuma conta", JSON.stringify({ version: 1, accounts: [] }), /nenhuma conta/);

  // Pasta de rede bloqueada pelo VS Code no Windows (simulada).
  const netFile = put("na-rede.cswap", json);
  const origRead = fs.readFileSync;
  fs.readFileSync = function (f, ...rest) {
    if (f === netFile) { const e = new Error("UNC host not allowed"); e.code = "ERR_UNC_HOST_NOT_ALLOWED"; throw e; }
    return origRead.call(this, f, ...rest);
  };
  try {
    const rn = T.readExportFile(netFile);
    check("pasta de rede: avisa e explica o que fazer", rn.code === "ERR_UNC_HOST_NOT_ALLOWED" && /pasta de rede/.test(rn.error), rn.error || "");
  } finally {
    fs.readFileSync = origRead;
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte L: erro de limite nas transcrições
async function partL() {
  console.log("\n# L. Erro de limite nas transcrições (arquivos temporários)");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-tr-"));
  fs.mkdirSync(path.join(root, "proj", "sess", "subagents"), { recursive: true });
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const apiErr = (ms, text) => JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: iso(ms), message: { model: "<synthetic>", content: [{ type: "text", text }] } });
  const chat = (ms, text) => JSON.stringify({ type: "assistant", timestamp: iso(ms), message: { model: "claude-fable-5-2", content: [{ type: "text", text }] } });
  const f = path.join(root, "proj", "conversa.jsonl");
  fs.writeFileSync(f, [chat(now - 5000, "o print mostra You've hit your 5-hour limit · resets 10:20pm"), JSON.stringify({ type: "user", isApiErrorMessage: true, error: "rate_limit", timestamp: iso(now - 4000) }).replace('"isApiErrorMessage":true,', '')].join("\n") + "\n");
  let hit = await T.scanLimitErrors(now - 60000, root);
  check("texto de conversa citando o erro não conta", hit === null, hit ? hit.text : "");
  fs.appendFileSync(f, apiErr(now - 120000 * 10, "You've hit your 5-hour limit · resets 8:00pm") + "\n");
  hit = await T.scanLimitErrors(now - 60000, root);
  check("erro antigo (antes do período) não conta", hit === null);
  fs.appendFileSync(f, apiErr(now - 2000, "You've hit your 5-hour limit · resets 10:20pm (America/Sao_Paulo)") + "\n");
  hit = await T.scanLimitErrors(now - 60000, root);
  check("erro de limite do Claude Code é detectado", !!hit && /5-hour/.test(hit.text) && T.limitLabel(hit.text) === "limite da sessão de 5h");
  const sub = path.join(root, "proj", "sess", "subagents", "agente.jsonl");
  fs.writeFileSync(sub, apiErr(now - 1000, "You've hit your weekly limit") + "\n");
  hit = await T.scanLimitErrors(now - 60000, root);
  check("erro num subagente também é detectado", !!hit && hit.file === sub && T.limitLabel(hit.text) === "limite semanal");
  fs.rmSync(root, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte C: preparar o Claude Code
function partC() {
  console.log("\n# C. Preparar o Claude Code para quando o Fable acabar (arquivos temporários)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-cc-"));
  const f = (n) => path.join(dir, n, "settings.json");
  // 1) sem arquivo
  let r = T.prepareClaudeCode(f("a"));
  let d = JSON.parse(fs.readFileSync(f("a"), "utf8"));
  check("sem arquivo: cria com Opus de padrão e esforço do Opus", r.ok && d.model === "opus" && d.modelSettings["claude-opus-5-5"].effortLevel === "xhigh");
  // 2) padrão no Fable, outras chaves que não podem sumir
  fs.mkdirSync(path.join(dir, "b"));
  fs.writeFileSync(f("b"), JSON.stringify({ model: "claude-fable-5-2", effortLevel: "high", permissions: { allow: ["Bash(ls)"] }, modelSettings: { "claude-fable-5-2": { effortLevel: "high" }, "claude-opus-5-5": { autoCompactWindow: 200000 } } }));
  check("antes: não está pronto", T.claudeCodeStatus(f("b")).ready === false);
  r = T.prepareClaudeCode(f("b"));
  d = JSON.parse(fs.readFileSync(f("b"), "utf8"));
  check("Fable de padrão → Opus de padrão, Opus no mesmo esforço do Fable", r.ok && d.model === "opus" && d.modelSettings["claude-opus-5-5"].effortLevel === "high", r.changes.join("; "));
  check("mantém o resto do arquivo", d.permissions.allow[0] === "Bash(ls)" && d.modelSettings["claude-opus-5-5"].autoCompactWindow === 200000 && d.effortLevel === "high");
  check("depois: pronto", T.claudeCodeStatus(f("b")).ready === true);
  // 3) já pronto: não mexe
  const before = fs.readFileSync(f("b"), "utf8");
  r = T.prepareClaudeCode(f("b"));
  check("já pronto: não muda nada", r.ok && r.changes.length === 0 && fs.readFileSync(f("b"), "utf8") === before);
  // 4) arquivo corrompido: não grava
  fs.mkdirSync(path.join(dir, "c"));
  fs.writeFileSync(f("c"), "{ isto não é json");
  r = T.prepareClaudeCode(f("c"));
  check("arquivo corrompido: não grava e explica", !r.ok && fs.readFileSync(f("c"), "utf8") === "{ isto não é json", r.error || "");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte F: gravar e copiar arquivos
async function partF() {
  console.log("\n# F. Gravar e copiar arquivos" + (process.platform === "win32" ? " (Windows: com PowerShell e pasta de rede de verdade)" : ""));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-files-"));
  const content = '{"version":1,"accounts":[{}]}\n';
  const out = path.join(dir, "saida.cswap");
  check("grava o export", (await T.writeFileAny(out, content)) && fs.readFileSync(out, "utf8") === content);
  if (process.platform !== "win32") check("export só legível pelo seu usuário (600)", (fs.statSync(out).mode & 0o777) === 0o600);
  const cp = path.join(dir, "copia.cswap");
  check("copia arquivo local", (await T.copyFileAny(out, cp)) && fs.readFileSync(cp, "utf8") === content);
  if (process.platform === "win32") {
    // Força o caminho do PowerShell, que é o usado quando o VS Code bloqueia a pasta de rede.
    const origCopy = fs.copyFileSync;
    const origWrite = fs.writeFileSync;
    fs.copyFileSync = () => { const e = new Error("UNC host not allowed"); e.code = "ERR_UNC_HOST_NOT_ALLOWED"; throw e; };
    try {
      const viaShell = path.join(dir, "via-powershell.cswap");
      check("Windows: PowerShell copia quando o VS Code bloqueia", (await T.copyFileAny(out, viaShell)) && fs.readFileSync(viaShell, "utf8") === content);
      const m = dir.match(/^([A-Za-z]):\\(.*)$/);
      const unc = m ? `\\\\localhost\\${m[1]}$\\${m[2]}\\saida.cswap` : null;
      if (unc && fs.existsSync(unc)) {
        const fromNet = path.join(dir, "da-rede.cswap");
        check(`Windows: copia de uma pasta de rede de verdade (${unc.slice(0, 22)}…)`, (await T.copyFileAny(unc, fromNet)) && fs.readFileSync(fromNet, "utf8") === content);
        const r = T.readExportFile(fromNet);
        check("Windows: o arquivo copiado da rede é aceito", !r.error);
      } else {
        console.log("     (pasta de rede \\\\localhost\\C$ indisponível nesta máquina; teste de rede pulado)");
      }
      fs.writeFileSync = function (f, ...rest) {
        if (f === path.join(dir, "rede-destino.cswap")) { const e = new Error("UNC host not allowed"); e.code = "ERR_UNC_HOST_NOT_ALLOWED"; throw e; }
        return origWrite.call(this, f, ...rest);
      };
      check("Windows: grava export em pasta bloqueada via PowerShell", (await T.writeFileAny(path.join(dir, "rede-destino.cswap"), content)) && fs.readFileSync(path.join(dir, "rede-destino.cswap"), "utf8") === content);
    } finally {
      fs.copyFileSync = origCopy;
      fs.writeFileSync = origWrite;
    }
    const del = path.join(dir, "apagar.cswap");
    fs.writeFileSync(del, "x");
    const origUnlink = fs.unlinkSync;
    fs.unlinkSync = () => { const e = new Error("UNC host not allowed"); e.code = "ERR_UNC_HOST_NOT_ALLOWED"; throw e; };
    try {
      check("Windows: apaga via PowerShell quando o VS Code bloqueia", (await T.removeFileAny(del)) && !fs.existsSync(del));
    } finally {
      fs.unlinkSync = origUnlink;
    }
  }
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte U: atualizador
function partU() {
  console.log("\n# U. Atualizador (dados simulados)");
  const U = require(path.join(root, "updater.js"));
  check("1.10.0 é mais nova que 1.9.3", U.cmpVersion("1.10.0", "1.9.3") > 0);
  check("“swap-plus 1.1.0” = 1.1.0", U.cmpVersion("swap-plus 1.1.0", "1.1.0") === 0);
  const rels = [
    { tag_name: "plus-v1.2.0", prerelease: true, assets: [] },
    { tag_name: "plus-v1.1.0", assets: [{ name: "x.whl", browser_download_url: "u" }], html_url: "h" },
    { tag_name: "v9.9.9", assets: [] },
    { tag_name: "plus-v1.0.0", assets: [] },
  ];
  const r = U.pickPlusRelease(rels);
  check("release: a plus-v mais nova, sem pré-release nem tags do original", !!r && r.version === "1.1.0" && r.assets[0].url === "u");
  check("sem releases → nada", U.pickPlusRelease([]) === null);
  check("original: só versões estáveis", U.pickStableTag([{ name: "v1.2.0b1" }, { name: "v1.1.0" }, { name: "v1.0.9" }, { name: "nightly" }]) === "1.1.0");
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
  for (let i = 0; i < 80 && !(items[0] && items[0].shown && /Sessão/.test(items[0].text)); i++) await sleep(250);
  const raw = JSON.parse(cswap("list", "--json"));
  const active = raw.accounts.find((a) => a.number === raw.activeAccountNumber);
  const main = items.find((it) => it.id === "swapPlus.main");
  const shown = items.filter((it) => it.shown);
  console.log("     barra:", JSON.stringify(main.text));
  check("um único item na barra", shown.length === 1 && shown[0] === main, `${shown.length} item(ns)`);
  check("moldura nas pontas e ícone de e-mail", /^│ {2}\$\(mail\) {2}/.test(main.text) && / {2}│$/.test(main.text));
  check("nenhum e-mail no texto da barra", !/@/.test(main.text));
  check("formato “Sessão (5h): X% usado — renova …”", /Sessão \(5h\): \d+% usado( — renova \S+ \S+)?/.test(main.text));
  check("semanal e Fable no mesmo formato", /Semanal: \d+% usado — renova /.test(main.text) && /Fable: \d+% usado — renova /.test(main.text));
  const u = active.usage || {};
  const pcts = [[u.fiveHour ? u.fiveHour.pct : 0, 90], [u.sevenDay.pct, 80], ...(u.scoped || []).map((x) => [x.pct, 95])];
  const want = pcts.some(([p, l]) => p >= l) ? "charts.red" : pcts.some(([p]) => p >= 70) ? "charts.yellow" : undefined;
  check("cor do item = limite mais perto do fim", (main.color && main.color.id) === want, want || "normal");
  check("clique abre a lista", main.command === "swapPlus.switchAccount");
  check("hover mostra o e-mail em negrito, sem emojis", String(main.tooltip.value).includes(`**${active.email}**`) && !EMOJI.test(main.tooltip.value));
  console.log("     hover:\n" + redact(main.tooltip.value).split("\n").map((l) => "       | " + l).join("\n"));

  console.log("\n# B2. Clique na barra: lista de contas");
  await commands["swapPlus.switchAccount"]();
  const menu = vscodeMock.lastPick || [];
  check("“Configurações” é a primeira opção", /Configurações/.test(menu[0].label));
  check("sem a opção de troca automática na lista", !menu.some((m) => /Troca automática/.test(m.label || "")));
  const accRows = menu.filter((m) => m.accountNum > 0);
  check("lista todas as contas", accRows.length === raw.accounts.length, `${accRows.length} contas`);
  check("só a conta em uso tem o check", accRows.filter((m) => m.label.startsWith("$(check)")).length === 1 && accRows.find((m) => m.label.startsWith("$(check)")).accountNum === raw.activeAccountNumber);
  check("linha de cima: conta e e-mail", accRows.every((m) => /Conta \d+.* — .+@/.test(m.label)));
  check("sessão ao lado do nome, no formato pedido", accRows.every((m) => /^Sessão \(5h\): \d+% usado/.test(m.description)));
  check("linha de baixo: semanal e Fable, com renovação", accRows.every((m) => /^Semanal: \d+% usado — renova /.test(m.detail) && /Fable: \d+% usado — renova /.test(m.detail)));
  check("lista sem emojis", !menu.some((m) => EMOJI.test(`${m.label} ${m.description || ""} ${m.detail || ""}`)));
  accRows.slice(0, 3).forEach((m) => console.log("       › " + redact(m.label) + "   " + m.description + "\n         " + m.detail));

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
  check("padrão: quando o Fable acaba, segue na mesma conta", st.rules.onModelLimit === "sameAccount");
  check("padrão: estratégia “aproveitar ao máximo”", st.rules.strategy === "max");
  check("Claude Code deste Mac já está pronto (Opus 5.5 no mesmo esforço do Fable)", !!st.claudeCode && st.claudeCode.ready === true, JSON.stringify(st.claudeCode));

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
  const nWarnBefore = notifications.filter((n) => n[0] === "warn").length; // avisos reais (uso alto) não contam
  await sendAndWait({ type: "saveRules", rules: st.rules, alerts: { ...st.alerts, fiveHourPct: 1, weeklyPct: 1, modelPct: 1 } }, 200);
  await commands["swapPlus.refreshStatus"]();
  for (let i = 0; i < 40 && notifications.filter((n) => n[0] === "warn").length === nWarnBefore; i++) await sleep(250);
  await sleep(1000); // os avisos chegam um depois do outro
  const warns = notifications.filter((n) => n[0] === "warn").slice(nWarnBefore).map((n) => n[1]);
  if (process.env.SWAP_PLUS_DEBUG) warns.forEach((w) => console.log("     [aviso] " + redact(w)));
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

  if (!READONLY) {
    console.log("\n# B8b. Reordenar contas (ida e volta; a conta em uso não entra)");
    const listNow = () => JSON.parse(cswap("list", "--json")).accounts;
    const seqRec = () => JSON.parse(fs.readFileSync(path.join(home, ".claude-swap-backup", "sequence.json"), "utf8")).accounts || {};
    const nums = listNow().map((a) => a.number).sort((a, b) => a - b);
    const activeNum = JSON.parse(cswap("list", "--json")).activeAccountNumber;
    let pairIdx = nums.findIndex((n, i) => i < nums.length - 1 && n !== activeNum && nums[i + 1] !== activeNum);
    const [x, y] = [nums[pairIdx], nums[pairIdx + 1]];
    const before = listNow();
    const emailAt = (list, n) => (list.find((a) => a.number === n) || {}).email;
    const prefsOf = (rec) => JSON.stringify({ d: !!rec.disabled, t: rec.threshold ?? null, p: rec.priority || 0, a: rec.alias || null });
    const recBefore = seqRec();
    const prefsByEmail = {};
    for (const a of before) prefsByEmail[a.email] = prefsOf(recBefore[String(a.number)] || {});
    try {
      await sendAndWait({ type: "move", number: x, dir: "down" }, 600);
      const after = listNow();
      check(`conta ${x} desceu: trocou de posição com a ${y}`, emailAt(after, y) === emailAt(before, x) && emailAt(after, x) === emailAt(before, y));
      const recAfter = seqRec();
      check("ajustes de cada conta foram junto", after.every((a) => prefsByEmail[a.email] === prefsOf(recAfter[String(a.number)] || {})));
      check("conta em uso continua a mesma", JSON.parse(cswap("list", "--json")).activeAccountNumber === activeNum);
      const sp = lastState();
      check("tela já mostra a ordem nova", (sp.accounts.find((a) => a.number === y) || {}).email === emailAt(before, x));
    } finally {
      await sendAndWait({ type: "move", number: y, dir: "up" }, 600);
    }
    const back = listNow();
    check("ordem original restaurada", nums.every((n) => emailAt(back, n) === emailAt(before, n)));
    const nFirst = lastState().accounts.length;
    await sendAndWait({ type: "move", number: nums[0], dir: "up" }, 300);
    check("a primeira conta não sobe (nada muda)", emailAt(listNow(), nums[0]) === emailAt(before, nums[0]) && lastState().accounts.length === nFirst);
  }

  console.log("\n# B9. Modo privado");
  await sendAndWait({ type: "ui", key: "privacy.hideEmails", value: true }, 300);
  await commands["swapPlus.refreshStatus"]();
  const sp = lastState();
  check("tela não recebe e-mails nem organização", sp.privacy === true && sp.accounts.every((a) => a.email === null && a.org === "" && a.alias === null));
  check("hover da barra sem e-mail", !/@/.test(main.tooltip.value) && /\*\*Conta \d+\*\*/.test(main.tooltip.value));
  await commands["swapPlus.switchAccount"]();
  const privRows = (vscodeMock.lastPick || []).filter((m) => m.accountNum > 0);
  check("lista mostra só “Conta N”", privRows.length === raw.accounts.length && privRows.every((m) => /^(\$\(check\) )?Conta \d+$/.test(m.label)), privRows.slice(0, 3).map((m) => m.label).join(", "));
  check("nenhum e-mail em lugar nenhum da lista", !(vscodeMock.lastPick || []).some((m) => /@/.test(`${m.label} ${m.description || ""} ${m.detail || ""}`)));

  console.log("\n# B10. Export Other / Export Me (arquivo temporário, apagado em seguida)");
  const fileOther = path.join(SCRATCH, "other.cswap");
  const fileMe = path.join(SCRATCH, "me.cswap");
  try {
    vscodeMock.nextSave = fileMe;
    const nBefore = notifications.length;
    await sendAndWait({ type: "export", mode: "me" }, 300);
    check("em modo privado, Export Me fica bloqueado", !fs.existsSync(fileMe) && notifications.slice(nBefore).some((n) => /só o Export Other/.test(n[1])));
    vscodeMock.nextSave = fileOther;
    await sendAndWait({ type: "export", mode: "other" }, 300);
    const envO = JSON.parse(fs.readFileSync(fileOther, "utf8"));
    check("Export Other gera o arquivo com todas as contas", Array.isArray(envO.accounts) && envO.accounts.length === raw.accounts.length, `${envO.accounts.length} contas`);
    check("arquivo marcado para modo privado", envO.swapPlus && envO.swapPlus.hideEmails === true);
    const rd = T.readExportFile(fileOther);
    check("o export real deste Mac é aceito na importação, sem conversão", !rd.error && rd.normalized === false, rd.error || "");
    const es = envO.swapPlus.settings || {};
    check("leva regras de troca, avisos, exibição e troca automática", es["swapPlus.rules.weeklySwitchPct"] === 80 && es["swapPlus.rules.modelSwitchPct"] === 95 && "swapPlus.alerts.weeklyPct" in es && "swapPlus.statusBar.showModelWeekly" in es && "swapPlus.autoSwitch.enabled" in es, `${Object.keys(es).length} configurações`);
    check("não leva caminho do executável nem modo privado", !("swapPlus.executablePath" in es) && !("swapPlus.privacy.hideEmails" in es));
    const ea = envO.swapPlus.accounts || [];
    check("leva os ajustes de cada conta", ea.length === raw.accounts.length && ea.every((a) => "disabled" in a && "threshold" in a && "priority" in a));
    check("arquivo só legível pelo seu usuário (600)", (fs.statSync(fileOther).mode & 0o777) === 0o600);
    check("aviso do export sem e-mail", !notifications.slice(-2).some((n) => /@/.test(n[1])));
    await sendAndWait({ type: "ui", key: "privacy.hideEmails", value: false }, 300);
    vscodeMock.nextSave = fileMe;
    await sendAndWait({ type: "export", mode: "me" }, 300);
    const envM = JSON.parse(fs.readFileSync(fileMe, "utf8"));
    check("Export Me sem a marca de modo privado", envM.swapPlus && envM.swapPlus.hideEmails === false && envM.accounts.length === raw.accounts.length);
  } finally {
    for (const f of [fileOther, fileMe]) try { fs.unlinkSync(f); } catch {}
    vscodeMock.nextSave = null;
  }
  check("arquivos de teste apagados", !fs.existsSync(fileOther) && !fs.existsSync(fileMe));

  console.log("\n# B11. Importar (com um swap-plus de mentira: nada é gravado de verdade)");
  const fakeLog = path.join(SCRATCH, "fake.log");
  const fake = path.join(SCRATCH, "fake-swap-plus");
  // list/--version vão para o swap-plus de verdade (só leitura); o resto só é anotado.
  fs.writeFileSync(fake, `#!/bin/bash\ncase "$1" in list|--version) exec "${cswapBin}" "$@";; esac\necho "$@" >> "${fakeLog}"\nexit 0\n`, { mode: 0o755 });
  const fakeFile = path.join(SCRATCH, "vindo-do-outro.cswap");
  const other = raw.accounts.find((a) => a.number !== raw.activeAccountNumber);
  const seqNow = JSON.parse(fs.readFileSync(path.join(home, ".claude-swap-backup", "sequence.json"), "utf8"));
  const otherRec = (seqNow.accounts || {})[String(other.number)] || {};
  fs.writeFileSync(
    fakeFile,
    JSON.stringify({
      version: 1,
      accounts: [{}, {}],
      swapPlus: {
        hideEmails: true,
        settings: { "swapPlus.rules.weeklySwitchPct": 77, "swapPlus.alerts.modelPct": 88, "swapPlus.executablePath": "/nao/deve/aplicar" },
        // o oposto do estado atual da conta, para todo ajuste exigir um comando
        accounts: [{ email: other.email, organizationUuid: other.organizationUuid || "", disabled: !otherRec.disabled, threshold: otherRec.threshold === 75 ? 76 : 75, priority: (Number(otherRec.priority) || 0) === 4 ? 5 : 4 }],
      },
    }),
    { mode: 0o600 }
  );
  try {
    await vscodeMock.workspace.getConfiguration("swapPlus").update("executablePath", fake);
    await sleep(300);
    vscodeMock.nextOpen = fakeFile;
    await sendAndWait({ type: "import" }, 600);
    const logged = fs.existsSync(fakeLog) ? fs.readFileSync(fakeLog, "utf8").trim() : "";
    const lines = logged.split("\n");
    check("rodou “swap-plus import <arquivo>”", lines[0] === `import ${fakeFile}`, redact(lines[0] || ""));
    check("arquivo de Export Other liga o modo privado", lastState().privacy === true);
    check("aplica as regras e avisos do arquivo", lastState().rules.weeklyPct === 77 && lastState().alerts.modelPct === 88, `semanal ${lastState().rules.weeklyPct}, aviso Fable ${lastState().alerts.modelPct}, store ${JSON.stringify(store["swapPlus.rules.weeklySwitchPct"])}`);
    check("não aplica o caminho do executável de outra máquina", vscodeMock.workspace.getConfiguration("swapPlus").get("executablePath") === fake);
    const want = [
      `${otherRec.disabled ? "enable" : "disable"} ${other.number}`,
      `threshold ${other.number} ${otherRec.threshold === 75 ? 76 : 75}`,
      `priority ${other.number} ${(Number(otherRec.priority) || 0) === 4 ? 5 : 4}`,
    ];
    check("aplica os ajustes da conta, achando-a pelo e-mail", want.every((w) => lines.includes(w)), lines.slice(1).join(" | "));

    // Arquivo que chegou com BOM do Windows: o motor recebe uma cópia limpa, apagada no fim.
    const bomFile = path.join(SCRATCH, "com-bom.cswap");
    fs.writeFileSync(bomFile, "\uFEFF" + fs.readFileSync(fakeFile, "utf8"), { mode: 0o600 });
    fs.writeFileSync(fakeLog, "");
    vscodeMock.nextOpen = bomFile;
    await sendAndWait({ type: "import" }, 600);
    const first = (fs.readFileSync(fakeLog, "utf8").trim().split("\n")[0] || "").replace(/^import /, "");
    check("arquivo com BOM: o motor recebe uma cópia limpa", !!first && first !== bomFile && first.endsWith(".cswap"), path.basename(first));
    check("a cópia limpa é apagada depois", !!first && !fs.existsSync(first));
    check("o arquivo original continua lá (até a pessoa mandar apagar)", fs.existsSync(bomFile));
  } finally {
    vscodeMock.nextOpen = null;
    await vscodeMock.workspace.getConfiguration("swapPlus").update("executablePath", "");
    await vscodeMock.workspace.getConfiguration("swapPlus").update("privacy.hideEmails", false);
    await vscodeMock.workspace.getConfiguration("swapPlus").update("rules.weeklySwitchPct", 80);
    await vscodeMock.workspace.getConfiguration("swapPlus").update("alerts.modelPct", 85);
    await sleep(300);
  }
  check("configurações de teste desfeitas", lastState().privacy === false);

  console.log("\n# B13. Limite estourado → troca na hora (motor de mentira: nada é trocado de verdade)");
  {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-hit-"));
    fs.mkdirSync(path.join(root, "proj"));
    const log13 = path.join(SCRATCH, "fake13.log");
    const fake13 = path.join(SCRATCH, "fake13");
    fs.writeFileSync(fake13, `#!/bin/bash\ncase "$1" in list|--version|config) exec "${cswapBin}" "$@";; esac\necho "$@" >> "${log13}"\nexit 0\n`, { mode: 0o755 });
    const cfg13 = vscodeMock.workspace.getConfiguration("swapPlus");
    const nNotes = notifications.length;
    try {
      await cfg13.update("executablePath", fake13);
      await cfg13.update("autoSwitch.enabled", true);
      await sleep(300);
      globalState.set("swapPlus.lastLimitHit", 0);
      globalState.set("swapPlus.lastAutoSwitch", 0);
      try { fs.unlinkSync(path.join(os.tmpdir(), "swap-plus-limit.lock")); } catch {}
      T.setLimitRoot(root);
      fs.writeFileSync(path.join(root, "proj", "c.jsonl"), JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: new Date().toISOString(), message: { content: [{ type: "text", text: "You've hit your 5-hour limit · resets 10:20pm" }] } }) + "\n");
      const r13 = await T.checkLimitErrors();
      const logged = fs.existsSync(log13) ? fs.readFileSync(log13, "utf8").trim() : "";
      check("detecta o erro e manda trocar de conta na hora", /^switch \d+$/m.test(logged), logged || (r13 && r13.text) || "");
      check("explica o motivo no histórico", !!r13 && /bateu o limite da sessão de 5h/.test(r13.text), r13 && r13.text);
      const r13b = await T.checkLimitErrors();
      check("o mesmo erro não dispara duas vezes", r13b === null);
    } finally {
      T.setLimitRoot(path.join(home, ".claude", "projects"));
      await cfg13.update("autoSwitch.enabled", false);
      await cfg13.update("executablePath", "");
      await sleep(300);
      fs.rmSync(root, { recursive: true, force: true });
    }
    check("conta em uso não mudou (motor de mentira)", JSON.parse(cswap("list", "--json")).activeAccountNumber === before);
  }

  if (NO_GITHUB) {
    console.log("\n# B12. Atualizações puladas (--no-github)");
  } else {
    await partUpdates(context);
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
  fs.rmSync(SCRATCH, { recursive: true, force: true });
}

async function partUpdates(context) {
  console.log("\n# B12. Atualizações (GitHub de verdade; nada é instalado de fato)");
  const U = require(path.join(root, "updater.js"));
  const remaining = async () => {
    try {
      const r = await U.request("https://api.github.com/rate_limit", { timeout: 8000 });
      return r.resources.core.remaining;
    } catch { return null; }
  };
  const https = require("https");
  let apiCalls = 0;
  const count = (orig) => function (url, ...rest) {
    const host = typeof url === "string" ? new URL(url).host : (url && (url.host || url.hostname)) || "";
    if (/^api\.github\.com/.test(host)) apiCalls++;
    return orig.call(this, url, ...rest);
  };
  const origGet = https.get, origReq = https.request;
  https.get = count(origGet);
  https.request = count(origReq);
  const before = await remaining();
  apiCalls = 0; // a própria consulta do limite não conta
  if (before === 0) {
    const r0 = await T.getUpdater().check({ reason: "manual" });
    check("limite do GitHub estourado: mensagem clara, sem “403”", r0.error === U.RATE_LIMIT_MSG, r0.error || "");
    console.log("     (limite de consultas do GitHub esgotado nesta rede; o resto do B12 fica para depois)");
    return;
  }
  const res = await T.getUpdater().check({ reason: "manual" });
  const res2 = await T.getUpdater().check({ reason: "manual" });
  const callsByChecks = apiCalls;
  https.get = origGet;
  https.request = origReq;
  const mid = before;
  const after = await remaining();
  console.log(`     motor:    aqui ${res.cli.installed} · fork ${res.cli.latest} · original ${res.cli.upstream}`);
  console.log(`     extensão: aqui ${res.ext.installed} · fork ${res.ext.latest} · original ${res.ext.upstream} (base ${res.ext.base})`);
  console.log(`     consultas à API feitas pelas 2 verificações: ${callsByChecks} (limite da rede: ${before} → ${after}, inclui outros computadores)`);
  check("consulta o GitHub sem erro", !res.error && !res2.error, res.error || res2.error || "");
  check("verificações não usam a API do GitHub (não gastam o limite)", callsByChecks === 0, `${callsByChecks} consulta(s)`);
  check("acha as versões do original também", !!res.cli.upstream && !!res.ext.upstream, `${res.cli.upstream} / ${res.ext.upstream}`);
  check("2ª verificação dá o mesmo resultado", res2.cli.latest === res.cli.latest && res2.ext.latest === res.ext.latest && res2.cli.upstream === res.cli.upstream);
  check("motor desta máquina = última release do fork", !!res.cli.latest && U.cmpVersion(res.cli.latest, res.cli.installed) === 0);
  check("fork do motor em dia com o original", !!res.cli.upstream && U.cmpVersion(res.cli.upstream, res.cli.latest) === 0);
  check("release da extensão existe no fork", !!res.ext.latest);

  const calls = [];
  const origExec = vscodeMock.commands.executeCommand;
  vscodeMock.commands.executeCommand = (id, arg) => { calls.push([id, arg]); return Promise.resolve(); };
  try {
    if (res.ext.release) {
      await T.getUpdater().applyExt(res.ext.release);
      const c = calls.find((x) => x[0] === "workbench.extensions.installExtension");
      const ok = !!c && fs.readFileSync(c[1].fsPath).subarray(0, 2).toString("latin1") === "PK";
      check("baixa o .vsix da release e pede ao VS Code para instalar", ok);
      if (c) try { fs.unlinkSync(c[1].fsPath); } catch {}
    }
  } finally {
    vscodeMock.commands.executeCommand = origExec;
  }

  const fakeUv = path.join(SCRATCH, "fake-uv"), uvLog = path.join(SCRATCH, "uv.log");
  const fakeCode = path.join(SCRATCH, "fake-code"), codeLog = path.join(SCRATCH, "code.log");
  fs.writeFileSync(fakeUv, `#!/bin/bash\necho "$@" >> "${uvLog}"\n`, { mode: 0o755 });
  fs.writeFileSync(fakeCode, `#!/bin/bash\necho "$@" >> "${codeLog}"\n`, { mode: 0o755 });
  const base = vscodeMock.workspace.getConfiguration("swapPlus");
  const cfgOn = () => ({ get: (k) => (k === "updates.enabled" ? true : base.get(k)), update: base.update });
  const deps = (over) => ({ cfg: cfgOn, onCliUpdated: async () => {}, pushHistory: async () => {}, postState: () => {}, ...over });
  if (res.cli.release) {
    const u2 = U.createUpdater(deps({ context, cliVersion: async () => res.cli.latest, overrides: { uv: fakeUv } }));
    await u2.applyCli(res.cli.release);
    const l = fs.existsSync(uvLog) ? fs.readFileSync(uvLog, "utf8").trim() : "";
    check("motor: instala pelo wheel da release", /^tool install --force --reinstall https:\/\/github\.com\/bragarpaulo\/swap-plus\/releases\/download\/plus-v[\d.]+\/\S+\.whl$/.test(l), l);
  }

  // Ao fechar, com versões antigas simuladas: só verifica e anota; nada roda fora do VS Code.
  fs.writeFileSync(uvLog, "");
  try { fs.unlinkSync(path.join(os.tmpdir(), "swap-plus-close.lock")); } catch {}
  const oldCtx = { ...context, extension: { packageJSON: { version: "1.0.0", swapPlus: { upstreamExtension: "0.2.2" } } } };
  const u3 = U.createUpdater(deps({ context: oldCtx, cliVersion: async () => "1.0.0", overrides: { uv: fakeUv, code: fakeCode, autoUpdate: true } }));
  const t0 = Date.now();
  const rc = await u3.onClose();
  const took = Date.now() - t0;
  await sleep(2000);
  check("ao fechar: verifica em até 3 s", !!rc && took <= 3500, `${took} ms`);
  check("ao fechar: anota que há versão nova para a próxima abertura", u3.summary().pendingOnOpen === true);
  check("ao fechar: nada é instalado nem fica rodando", fs.readFileSync(uvLog, "utf8").trim() === "" && !fs.existsSync(codeLog));
  await globalState.set("swapPlus.updates", { ...(globalState.get("swapPlus.updates") || {}), pendingOnOpen: false });
}

(async () => {
  partA();
  partI();
  await partL();
  partC();
  await partF();
  partU();
  if (UNIT) {
    console.log(failed ? `\n${failed} verificação(ões) falharam.` : "\nTudo certo.");
    process.exit(failed ? 1 : 0);
  }
  await partB();
  console.log(failed ? `\n${failed} verificação(ões) falharam.` : "\nTudo certo.");
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
