"use strict";
// Teste rápido da extensão Swap Plus (3.0, só servidor). Nada aqui ativa a
// extensão nem fala com o servidor: são as partes que dá para testar sozinhas,
// com dados simulados e arquivos temporários. O modo servidor inteiro (com um
// servidor falso) está em servermode.test.js.
//
//   A. regra de troca do rules.js (a mesma que o servidor usa) e textos da lista
//   V. versão mais nova já instalada (pede para recarregar)
//   L. erro de limite nas transcrições do Claude Code
//   C. modelo padrão do Claude Code: passa para o Opus 5.5 quando o Fable acaba e volta sozinho
//   E. motor antigo: leitura do `uv tool list` (qual pacote desinstalar)
//   U. atualizador (dados simulados)
//   G. atualizador contra o GitHub de verdade (nada é instalado de fato)
//
//   node test/smoke.js             # tudo
//   node test/smoke.js --unit      # sem a parte G (usado no GitHub Actions)
//   node test/smoke.js --no-github # o mesmo que --unit

const Module = require("module");
const path = require("path");
const fs = require("fs");
const os = require("os");

const UNIT = process.argv.includes("--unit") || process.argv.includes("--no-github");
const root = path.join(__dirname, "..");
const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

// ------------------------------------------------------------ vscode falso (o mínimo para carregar os módulos)
const notifications = [];
const vscodeMock = {
  MarkdownString: class {
    constructor() {
      this.value = "";
    }
    appendMarkdown(s) {
      this.value += s;
      return this;
    }
    appendText(s) {
      this.value += s;
      return this;
    }
  },
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  env: { appRoot: "/nao-existe" },
  Uri: { file: (p) => ({ fsPath: p, toString() { return p; } }) },
  window: {
    showInformationMessage: (m) => { notifications.push(["info", m]); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { notifications.push(["warn", m]); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { notifications.push(["error", m]); return Promise.resolve(undefined); },
    withProgress: (_o, fn) => fn({ report() {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  },
  workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
  commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => Promise.resolve() },
};
const origLoad = Module._load;
Module._load = function (request) {
  if (request === "vscode") return vscodeMock;
  return origLoad.apply(this, arguments);
};

// ------------------------------------------------------------ utilitários
const ext = require(path.join(root, manifest.main));
const T = ext._test;
const R = require(path.join(root, "rules.js"));
const M = require(path.join(root, "modelSwitch.js"));
let failed = 0;
function check(name, cond, extra) {
  if (!cond) failed++;
  console.log(`${cond ? "  ok  " : " FALHA"}  ${name}${extra ? `  — ${extra}` : ""}`);
}
const EMOJI = /\p{Extended_Pictographic}/u;

// ------------------------------------------------------------ parte A: decisão (rules.js)
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
const RULES = { sessionPct: 90, weeklyPct: 80, modelPct: 95, preferModel: "Fable", strategy: "headroom", expiringHours: 24, cooldownMin: 5, marginPct: 5, intervalSec: 60, onModelLimit: "switchAccount" };
const OPUS = ["claude-opus-5-5"];
const FABLE = ["claude-fable-5-2"];
const run = (accounts, active, opts = {}) =>
  R.decide({ list: { activeAccountNumber: active, accounts }, records: opts.records || {}, r: { ...RULES, ...(opts.r || {}) }, modelIds: opts.models || OPUS, now: Date.now(), lastSwitchAt: opts.lastSwitchAt || 0, force: opts.force, limitHit: opts.limitHit || null });

function partA() {
  console.log("\n# A. Regra de decisão do rules.js (contas simuladas)");
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
  // O caso do Mac (14/11 19:59): a conta 8 tinha login morto, mas uso de 15 min atrás e semanal renovando antes.
  const dead = (n, o) => {
    const a = acct(n, o);
    return { ...a, usageStatus: "relogin_required", usage: null, lastGoodUsage: a.usage, lastGoodAgeSeconds: 900 };
  };
  d = run([acct(4, { w: 32, wReset: 65 }), dead(8, { w: 30, wReset: 3 })], 4, { r: { strategy: "max" } });
  check("login morto: “aproveitar ao máximo” não vai para ela", d.action === "none", d.text);
  d = run([acct(4, { w: 85 }), dead(8, { w: 5 }), acct(7, { w: 40 })], 4);
  check("login morto: na linha, pula a conta morta", d.action === "switch" && d.to === 7, d.text);
  d = run([acct(4, { w: 50 }), dead(8, { w: 5 }), acct(7, { w: 40 })], 4, { limitHit: "limite de 5 horas" });
  check("login morto: limite estourado também não vai para ela", d.action === "switch" && d.to === 7, d.text);
  d = run([acct(4, { w: 85 }), dead(8, { w: 5 })], 4);
  check("login morto: se só sobra ela, fica bloqueado (não derruba o Claude Code)", d.action === "none" && d.kind === "blocked", d.text);
  check("loginDead reconhece os estados", R.loginDead({ usageStatus: "relogin_required" }) && !R.loginDead({ usageStatus: "token_expired" }) && !R.loginDead({ usageStatus: "ok" }));
  // O print do Windows (14/11 18:19): conta 7 em uso; a 8 renova o semanal em 2h41 com 70% sobrando.
  const print = [acct(7, { s: 13, w: 10, f: 4, wReset: 89 }), acct(8, { s: 0, w: 30, f: 4, wReset: 2.7 }), acct(5, { s: 0, w: 31, f: 15, wReset: 67 }), acct(6, { s: 100, w: 40, f: 30, wReset: 50 })];
  d = run(print, 7, { r: { strategy: "max", onModelLimit: "sameAccount" }, models: FABLE, lastSwitchAt: Date.now() - 15 * 60e3 });
  check("print do Windows, “aproveitar ao máximo”: vai para a conta 8", d.action === "switch" && d.to === 8, d.text);
  d = run(print, 7, { r: { strategy: "headroom", onModelLimit: "sameAccount" }, models: FABLE });
  check("print do Windows, “mais folga”: fica (só troca na linha)", d.action === "none", d.text);
  d = run([acct(1, { s: 70, w: 20, age: 3600 }), acct(2, { w: 10, age: 3600 }), acct(3, { w: 40, age: 3600 })], 1, { r: { onModelLimit: "sameAccount" }, limitHit: "limite da sessão de 5h" });
  check("limite estourado agora: troca mesmo com dados antigos", d.action === "switch" && d.to === 2 && d.atLimit === true, d.text);
  d = run([acct(1, { s: 70, w: 20 }), acct(2, { w: 95 })], 1, { limitHit: "limite da sessão de 5h" });
  check("limite estourado e nenhuma conta com folga → avisa, não troca", d.action === "none" && d.kind === "blocked", d.text);
  check("nome do modelo: claude-fable-5-2 → Fable 5.2", R.modelLabel("claude-fable-5-2") === "Fable 5.2");
  check("limite do Fable reconhecido pelo id do modelo", R.watchedModels(["claude-fable-5-2"], ["Fable"]).join() === "Fable");
  check("Opus não liga o limite do Fable", R.watchedModels(["claude-opus-5-5"], ["Fable"]).length === 0);

  // Caso de 18/11: na conta 9 (Fable 15%, semanal zera em 4 dias), a conta 7 (Fable 100%, semanal 77%, zera em 11 h).
  const caso = [acct(9, { s: 0, w: 16, f: 15, wReset: 96 }), acct(7, { s: 7, w: 77, f: 100, wReset: 11 })];
  const MAXR = { strategy: "max", expiringHours: 168, onModelLimit: "sameAccount", weeklyPct: 96 }; // as regras dele
  d = run(caso, 9, { r: MAXR, models: OPUS });
  check("preferir Fable: “aproveitar ao máximo” não sai da conta com Fable para uma sem", d.action === "none", d.text);
  d = run(caso, 9, { r: { ...MAXR, preferModel: "" }, models: OPUS });
  check("sem preferir Fable: antecipa para a que zera antes (como antes)", d.action === "switch" && d.to === 7, d.text);
  d = run([acct(9, { s: 0, w: 16, f: 100, wReset: 96 }), acct(7, { s: 7, w: 77, f: 100, wReset: 11 })], 9, { r: MAXR, models: OPUS });
  check("conta em uso também sem Fable: antecipa normalmente", d.action === "switch" && d.to === 7, d.text);
  d = run([acct(9, { s: 0, w: 16, f: 15, wReset: 96 }), acct(7, { s: 7, w: 77, f: 10, wReset: 11 })], 9, { r: MAXR, models: OPUS });
  check("as duas com Fable: antecipa normalmente", d.action === "switch" && d.to === 7, d.text);
  d = run([acct(9, { s: 0, w: 16, f: 15, wReset: 96 }), acct(7, { s: 0, w: 10, f: 100, wReset: 96 })], 9, { r: { ...RULES, onModelLimit: "sameAccount" }, models: OPUS, force: true });
  check("“melhor conta” não troca a conta com Fable por uma sem (mesmo com mais folga)", d.action === "none" && /ainda tem Fable/.test(d.text), d.text);
  d = run([acct(9, { s: 95, w: 16, f: 15, wReset: 96 }), acct(7, { s: 7, w: 77, f: 100, wReset: 11 })], 9, { r: MAXR, models: OPUS });
  check("na linha da sessão troca mesmo assim (só sobrou conta sem Fable)", d.action === "switch" && d.to === 7, d.text);

  console.log("\n# A2. Lista de contas da barra (extensão)");
  // Ordem: quem participa primeiro, por renovação do semanal; quem não participa no fim, também por renovação.
  const ord = T.orderForDisplay(
    [acct(1, { w: 30, wReset: 50 }), acct(2, { w: 10, wReset: 5 }), acct(3, { w: 5, wReset: 1 }), acct(4, { w: 0, wReset: 20 }), acct(5, { w: 40, wReset: 20 }), acct(6, { w: 1, wReset: 3 })],
    { 3: { disabled: true }, 6: { disabled: true } }
  ).map((a) => a.number);
  check("ordem: participantes por renovação, depois os de fora", ord.join(",") === "2,4,5,1,3,6", ord.join(","));
  check("rótulos do erro de limite", T.limitLabel("You've hit your 5-hour limit · resets 10:20pm") === "limite da sessão de 5h" && T.limitLabel("You've hit your weekly limit") === "limite semanal" && T.limitLabel("You've reached your Fable limit for this week") === null);
  check("rótulo: “session limit” (texto atual do Claude Code)", T.limitLabel("You've hit your session limit · resets 1am (America/Sao_Paulo)") === "limite da sessão de 5h");
  check("erro passageiro do servidor não é limite da conta", T.limitLabel("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited") === null);
  const a = acct(9, { s: 20, w: 71, f: 57, wReset: 6 });
  const pt = T.pickerTexts(a, R.windows(a), false);
  console.log("     ao lado do nome: " + pt.description);
  console.log("     linha de baixo : " + pt.detail);
  check("lista: sessão no formato “X% usado — renova …”", /^Sessão \(5h\): 20% usado — renova (hoje|amanhã) \d+h/.test(pt.description));
  check("lista: semanal e Fable no mesmo formato", /^Semanal: 71% usado — renova .+ {2}· {2}Fable: 57% usado — renova /.test(pt.detail));
  check("lista: sem emojis", !EMOJI.test(pt.description + pt.detail));
  const idle = acct(9, { s: null, w: 3 });
  check("lista: sessão sem uso não mostra renovação", T.pickerTexts(idle, R.windows(idle), false).description === "Sessão (5h): 0% usado");
  const morta = { ...acct(10, { w: 10 }), usageStatus: "relogin_required" };
  check("lista: conta com login morto aparece marcada", /login morto|Uso indisponível/.test(T.pickerTexts(morta, R.windows(morta), false).detail));
}

// ------------------------------------------------------------ parte L: erro de limite nas transcrições
async function partL() {
  console.log("\n# L. Erro de limite nas transcrições (arquivos temporários)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-tr-"));
  fs.mkdirSync(path.join(dir, "proj", "sess", "subagents"), { recursive: true });
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const apiErr = (ms, text) => JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: iso(ms), message: { model: "<synthetic>", content: [{ type: "text", text }] } });
  const chat = (ms, text) => JSON.stringify({ type: "assistant", timestamp: iso(ms), message: { model: "claude-fable-5-2", content: [{ type: "text", text }] } });
  const f = path.join(dir, "proj", "conversa.jsonl");
  fs.writeFileSync(f, [chat(now - 5000, "o print mostra You've hit your 5-hour limit · resets 10:20pm"), JSON.stringify({ type: "user", isApiErrorMessage: true, error: "rate_limit", timestamp: iso(now - 4000) }).replace('"isApiErrorMessage":true,', "")].join("\n") + "\n");
  let hit = await T.scanLimitErrors(now - 60000, dir);
  check("texto de conversa citando o erro não conta", hit === null, hit ? hit.text : "");
  fs.appendFileSync(f, apiErr(now - 120000 * 10, "You've hit your 5-hour limit · resets 8:00pm") + "\n");
  hit = await T.scanLimitErrors(now - 60000, dir);
  check("erro antigo (antes do período) não conta", hit === null);
  fs.appendFileSync(f, apiErr(now - 2000, "You've hit your 5-hour limit · resets 10:20pm (America/Sao_Paulo)") + "\n");
  hit = await T.scanLimitErrors(now - 60000, dir);
  check("erro de limite do Claude Code é detectado", !!hit && /5-hour/.test(hit.text) && T.limitLabel(hit.text) === "limite da sessão de 5h");
  const sub = path.join(dir, "proj", "sess", "subagents", "agente.jsonl");
  fs.writeFileSync(sub, apiErr(now - 1000, "You've hit your weekly limit") + "\n");
  hit = await T.scanLimitErrors(now - 60000, dir);
  check("erro num subagente também é detectado", !!hit && hit.file === sub && T.limitLabel(hit.text) === "limite semanal");
  const reset = Math.floor((now + 2 * 24 * 3600e3) / 1000);
  const fableErr = JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", apiErrorStatus: 429, timestamp: iso(now - 500), quotaLimits: { status: "rejected", resetsAt: reset, rateLimitType: "seven_day_overage_included" }, message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your Fable limit · resets Nov 18, 12pm (America/Sao_Paulo). Switch to another model to continue." }] } });
  fs.appendFileSync(f, fableErr + "\n");
  hit = await T.scanLimitErrors(now - 60000, dir);
  check("limite do Fable: lê o tipo e a renovação gravados pelo Claude Code", !!hit && hit.rateLimitType === "seven_day_overage_included" && hit.resetsAt === reset * 1000 && T.limitLabel(hit.text) === null && M.limitModel(hit.text, hit.rateLimitType) === "Fable");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte V: versão nova instalada por fora
function partV() {
  console.log("\n# V. Versão mais nova já instalada (pede para recarregar)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-ext-"));
  for (const v of ["1.6.0", "1.7.0", "1.7.1", "1.10.0"]) fs.mkdirSync(path.join(dir, `paulo-local.swap-plus-${v}`));
  fs.mkdirSync(path.join(dir, "outra.extensao-9.9.9"));
  check("acha a mais nova que a que está rodando", T.newerInstalledVersion(dir, "1.7.0") === "1.10.0");
  fs.writeFileSync(path.join(dir, ".obsolete"), JSON.stringify({ "paulo-local.swap-plus-1.10.0": true }));
  check("ignora versão marcada como obsoleta pelo VS Code", T.newerInstalledVersion(dir, "1.7.0") === "1.7.1");
  check("rodando a mais nova: não pede nada", T.newerInstalledVersion(dir, "1.7.1") === null);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte C: modelo padrão do Claude Code (modelSwitch.js)
function partC() {
  console.log("\n# C. Modelo padrão do Claude Code: Fable → Opus 5.5 e volta (arquivos temporários)");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-cc-"));
  const f = (n) => path.join(dir, n, "settings.json");
  const mk = (n) => path.join(dir, n, "dados", "modelo-padrao.json");
  const ler = (n) => JSON.parse(fs.readFileSync(f(n), "utf8"));
  const gravar = (n, obj) => {
    fs.mkdirSync(path.join(dir, n), { recursive: true });
    fs.writeFileSync(f(n), typeof obj === "string" ? obj : JSON.stringify(obj));
  };
  const now = Date.now();

  // --- de qual limite é o erro
  const FABLE_MSG = "You've hit your Fable limit · resets Nov 18, 12pm (America/Sao_Paulo). Switch to another model to continue.";
  check("erro do print: é o limite do Fable", M.limitModel(FABLE_MSG) === "Fable");
  check("tipo gravado pelo Claude Code vale mais que o texto", M.limitModel("You've hit your limit", "seven_day_overage_included") === "Fable" && M.limitModel(FABLE_MSG, "five_hour") === null);
  check("limite da sessão e semanal não são de modelo", M.limitModel("You've hit your session limit · resets 1am") === null && M.limitModel("You've hit your weekly limit") === null);
  check("erro passageiro do servidor não é limite", M.limitModel("API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited") === null);
  check("padrão é o Fable: fable, id completo, sem chave, default", M.isFableDefault("fable") && M.isFableDefault("claude-fable-5-2") && M.isFableDefault(undefined) && M.isFableDefault("default") && !M.isFableDefault("opus") && !M.isFableDefault("sonnet"));
  check("padrão do plano: sem chave ou default; fable escolhido não é “do plano”", M.isPlanDefault(undefined) && M.isPlanDefault("default") && !M.isPlanDefault("fable"));

  // --- decisão pelo uso (função pura)
  const R1 = { ...RULES, onModelLimit: "sameAccount" };
  const plano = (accounts, o = {}) => M.plan({ list: { activeAccountNumber: o.active || 1, accounts }, records: o.records || {}, r: { ...R1, ...(o.r || {}) }, marker: o.marker || null, now });
  let p = plano([acct(1, { f: 94 })]);
  check("“mesma conta”: Fable em 94% (linha 95%) → nada", p.want === null, p.why);
  p = plano([acct(1, { f: 95 })]);
  check("“mesma conta”: Fable na linha → Opus 5.5", p.want === "fallback" && p.account === 1 && p.line === 95);
  p = plano([acct(1, { f: 97 })], { r: { onModelLimit: "switchAccount" } });
  check("“trocar de conta”: na linha quem age é o servidor (97% → nada)", p.want === null, p.why);
  p = plano([acct(1, { f: 100 })], { r: { onModelLimit: "switchAccount" } });
  check("“trocar de conta”: Fable em 100% e continua na conta → Opus 5.5", p.want === "fallback" && p.line === 100);
  p = plano([acct(1, { f: 80 })], { records: { 1: { modelThreshold: 75 } } });
  check("linha própria da conta vale", p.want === "fallback" && p.line === 75);
  p = plano([acct(1, { f: 99, age: 3600 })]);
  check("uso desatualizado: não decide", p.want === null, p.why);
  p = plano([{ ...acct(1), usage: { sevenDay: { pct: 10, resetsAt: new Date(now + HOUR).toISOString() } } }]);
  check("conta sem o limite do Fable informado: não decide", p.want === null, p.why);
  const feito = { v: 1, state: "fallback", from: "fable", to: "opus", account: 1, at: now - HOUR, holdUntil: null, cycleEnd: now + 48 * HOUR };
  p = plano([acct(1, { f: 92 })], { marker: feito });
  check("depois da troca, perto da linha (92%): espera a folga", p.want === null, p.why);
  p = plano([acct(1, { f: 90 })], { marker: feito });
  check("Fable com folga (90%): volta ao Fable", p.want === "preferred");
  p = plano([acct(1, { f: 40 })], { marker: { ...feito, holdUntil: now + HOUR } });
  check("limite visto na conversa: não volta só pelo dado de uso (pode estar atrasado)", p.want === null, p.why);
  p = plano([acct(1, { f: 100 }), acct(2, { f: 10 })], { active: 2, marker: { ...feito, holdUntil: now + HOUR } });
  check("foi para outra conta com Fable: volta ao Fable (a trava era da conta 1)", p.want === "preferred" && p.account === 2);
  p = plano([acct(1, { f: 99 })], { marker: { v: 1, state: "user", account: 1, at: now - HOUR, cycleEnd: now + 48 * HOUR } });
  check("padrão escolhido à mão depois da troca: não troca de novo pelo uso", p.want === null && !p.forget, p.why);
  p = plano([acct(1, { f: 99 }), acct(2, { f: 99 })], { active: 2, marker: { v: 1, state: "user", account: 1, at: now - HOUR, cycleEnd: now + 48 * HOUR } });
  check("…mas em outra conta a regra volta a valer", p.want === "fallback" && p.forget === true);

  // --- trocar: padrão no Fable, com outras chaves que não podem sumir
  gravar("a", { model: "fable", effortLevel: "high", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [] }, modelSettings: { "claude-fable-5-2": { effortLevel: "xhigh" }, "claude-opus-5-5": { autoCompactWindow: 200000 } } });
  let r = M.toFallback(f("a"), mk("a"), { account: 7, reason: "limit", now, holdUntil: now + HOUR, cycleEnd: now + 48 * HOUR });
  let d = ler("a");
  check("Fable acabou: o padrão passa para o Opus", r.ok && r.changed && r.state === "switched" && r.from === "fable" && d.model === "opus");
  check("Opus sem esforço próprio recebe o do Fable", d.modelSettings["claude-opus-5-5"].effortLevel === "xhigh" && r.effort === "xhigh");
  check("mantém o resto do arquivo", d.permissions.allow[0] === "Bash(ls)" && d.modelSettings["claude-opus-5-5"].autoCompactWindow === 200000 && d.effortLevel === "high" && Array.isArray(d.hooks.Stop));
  let m = M.readMarker(mk("a"));
  check("marcador guarda o valor de antes, a conta e a trava", !!m && m.state === "fallback" && m.from === "fable" && m.account === 7 && m.holdUntil === now + HOUR);
  const antes = fs.readFileSync(f("a"), "utf8");
  r = M.toFallback(f("a"), mk("a"), { account: 7, reason: "line", now });
  check("de novo: já está no Opus, não mexe", r.ok && !r.changed && r.state === "already" && fs.readFileSync(f("a"), "utf8") === antes);
  // a pessoa escolhe "Opus 5.5" no seletor (o Claude Code grava o padrão): continua sendo a troca do Swap Plus
  m = M.noteUserChoice(f("a"), mk("a"), now);
  check("escolher o Opus no seletor não desfaz o marcador", m.state === "fallback");
  r = M.toPreferred(f("a"), mk("a"));
  d = ler("a");
  check("Fable voltou: o padrão volta a ser o de antes e o marcador some", r.ok && r.changed && r.state === "restored" && d.model === "fable" && M.readMarker(mk("a")) === null);
  check("…e o resto do arquivo continua lá", d.permissions.allow[0] === "Bash(ls)" && d.modelSettings["claude-opus-5-5"].effortLevel === "xhigh");
  r = M.toPreferred(f("a"), mk("a"));
  check("sem marcador: não desfaz nada", r.ok && !r.changed && r.state === "none" && ler("a").model === "fable");

  // --- sem a chave `model` (vale o modelo do plano): troca e, ao voltar, tira a chave
  gravar("b", { effortLevel: "xhigh" });
  r = M.toFallback(f("b"), mk("b"), { account: 3, reason: "line", now });
  check("sem modelo escolhido e sem sinal de Fable em uso: não mexe (o padrão do plano pode ser outro)", r.ok && !r.changed && r.state === "plan" && !("model" in ler("b")) && M.readMarker(mk("b")) === null);
  r = M.toFallback(f("b"), mk("b"), { account: 3, reason: "line", now, fableInUse: true });
  check("sem modelo escolhido, Fable em uso: passa para o Opus", r.changed && r.from === null && ler("b").model === "opus");
  r = M.toPreferred(f("b"), mk("b"));
  check("ao voltar: a chave some de novo", r.changed && !("model" in ler("b")) && ler("b").effortLevel === "xhigh");

  // --- sem arquivo nenhum
  r = M.toFallback(f("c"), mk("c"), { account: 1, reason: "limit", now, fableInUse: true });
  check("sem settings.json: cria só com o modelo", r.changed && JSON.stringify(ler("c")) === JSON.stringify({ model: "opus" }));

  // --- o padrão não é o Fable: não mexe
  gravar("e", { model: "sonnet" });
  r = M.toFallback(f("e"), mk("e"), { account: 1, reason: "limit", now });
  check("padrão em outro modelo (Sonnet): não mexe nem anota", r.ok && !r.changed && r.state === "other" && ler("e").model === "sonnet" && M.readMarker(mk("e")) === null);
  gravar("g", { model: "opus" });
  r = M.toFallback(f("g"), mk("g"), { account: 1, reason: "limit", now });
  check("padrão já no Opus (escolha da pessoa): não anota", !r.changed && r.state === "already" && M.readMarker(mk("g")) === null);
  r = M.toPreferred(f("g"), mk("g"));
  check("…e depois não é “devolvido” ao Fable", !r.changed && ler("g").model === "opus");

  // --- a pessoa volta o padrão à mão depois da troca
  gravar("h", { model: "claude-fable-5-2" });
  M.toFallback(f("h"), mk("h"), { account: 2, reason: "line", now, cycleEnd: now + 48 * HOUR });
  gravar("h", { model: "claude-fable-5-2" }); // escolheu o Fable de novo no seletor
  m = M.noteUserChoice(f("h"), mk("h"), now);
  check("voltou o padrão à mão: vale a escolha dela", m.state === "user" && m.account === 2 && m.from === "claude-fable-5-2");
  r = M.toPreferred(f("h"), mk("h"));
  check("…e não há nada para desfazer", !r.changed && ler("h").model === "claude-fable-5-2" && M.readMarker(mk("h")) === null);
  M.toFallback(f("h"), mk("h"), { account: 2, reason: "line", now });
  gravar("h", { model: "claude-fable-5-2" });
  M.noteUserChoice(f("h"), mk("h"), now);
  r = M.toFallback(f("h"), mk("h"), { account: 2, reason: "limit", now, holdUntil: now + HOUR });
  check("erro de limite na conversa troca mesmo depois da escolha à mão", r.changed && ler("h").model === "opus" && M.readMarker(mk("h")).state === "fallback");
  gravar("h", { model: "sonnet" });
  r = M.toPreferred(f("h"), mk("h"));
  check("padrão mudado para outro modelo: fica como a pessoa deixou", !r.changed && r.state === "user" && ler("h").model === "sonnet" && M.readMarker(mk("h")) === null);

  // --- arquivo corrompido: não grava
  gravar("x", "{ isto não é json");
  r = M.toFallback(f("x"), mk("x"), { account: 1, reason: "limit", now });
  check("arquivo corrompido: não grava, não anota e explica", !r.ok && fs.readFileSync(f("x"), "utf8") === "{ isto não é json" && M.readMarker(mk("x")) === null, r.error || "");
  gravar("y", "﻿" + JSON.stringify({ model: "fable" }));
  r = M.toFallback(f("y"), mk("y"), { account: 1, reason: "limit", now });
  check("arquivo com BOM (Windows): lê e troca", r.ok && r.changed && ler("y").model === "opus");
  fs.rmSync(dir, { recursive: true, force: true });
}

// ------------------------------------------------------------ parte E: motor antigo (leitura do `uv tool list`)
function partE() {
  console.log("\n# E. Motor antigo: qual pacote do uv desinstalar (só leitura de texto)");
  const lista = "claude-swap v1.1.0\n- claude-swap\n- cswap\n- swap-plus\nruff v0.6.9\n- ruff\n";
  check("o pacote que traz o swap-plus é o claude-swap", T.enginePackages(lista).join() === "claude-swap", T.enginePackages(lista).join());
  check("Windows (swap-plus.exe, CRLF)", T.enginePackages("claude-swap v1.1.0\r\n- claude-swap.exe\r\n- cswap.exe\r\n- swap-plus.exe\r\n").join() === "claude-swap");
  check("claude-swap original (sem o swap-plus) não entra", T.enginePackages("claude-swap v0.9.0\n- claude-swap\n- cswap\n").length === 0);
  check("outras ferramentas não entram", T.enginePackages("ruff v0.6.9\n- ruff\nblack v24.1.0\n- black\n").length === 0);
  check("lista vazia ou estranha: nada", T.enginePackages("").length === 0 && T.enginePackages("No tools installed\n").length === 0 && T.enginePackages("- swap-plus\n").length === 0);
}

// ------------------------------------------------------------ parte U: atualizador (dados simulados)
function partU() {
  console.log("\n# U. Atualizador (dados simulados)");
  const U = require(path.join(root, "updater.js"));
  check("1.10.0 é mais nova que 1.9.3", U.cmpVersion("1.10.0", "1.9.3") > 0);
  check("“swap-plus 1.1.0” = 1.1.0", U.cmpVersion("swap-plus 1.1.0", "1.1.0") === 0);
  const rels = [
    { tag_name: "plus-v1.2.0", prerelease: true, assets: [] },
    { tag_name: "plus-v1.1.0", assets: [{ name: "swap-plus.vsix", browser_download_url: "u" }], html_url: "h" },
    { tag_name: "v9.9.9", assets: [] },
    { tag_name: "plus-v1.0.0", assets: [] },
  ];
  const r = U.pickPlusRelease(rels);
  check("release: a plus-v mais nova, sem pré-release nem tags do original", !!r && r.version === "1.1.0" && r.assets[0].url === "u");
  check("sem releases → nada", U.pickPlusRelease([]) === null);
  check("original: só versões estáveis", U.pickStableTag([{ name: "v1.2.0b1" }, { name: "v1.1.0" }, { name: "v1.0.9" }, { name: "nightly" }]) === "1.1.0");
  check("o atualizador não tem mais nada do motor", !("cli" in U.REPOS) && !("upstreamCli" in U.REPOS) && !("findBin" in U));
}

// ------------------------------------------------------------ parte G: atualizador contra o GitHub
async function partG() {
  console.log("\n# G. Atualizações da extensão (GitHub de verdade; nada é instalado de fato)");
  const U = require(path.join(root, "updater.js"));
  const gs = new Map();
  const context = { globalState: { get: (k) => gs.get(k), update: async (k, v) => { gs.set(k, v); } }, extension: { packageJSON: manifest } };
  const cfg = () => ({ get: (k) => (k === "updates.enabled" ? true : undefined) });
  const deps = (over) => ({ context, cfg, pushHistory: async () => {}, postState: () => {}, ...over });
  const remaining = async () => {
    try {
      const r = await U.request("https://api.github.com/rate_limit", { timeout: 8000 });
      return r.resources.core.remaining;
    } catch {
      return null;
    }
  };
  const https = require("https");
  let apiCalls = 0;
  const count = (orig) =>
    function (url, ...rest) {
      const host = typeof url === "string" ? new URL(url).host : (url && (url.host || url.hostname)) || "";
      if (/^api\.github\.com/.test(host)) apiCalls++;
      return orig.call(this, url, ...rest);
    };
  const before = await remaining();
  const u = U.createUpdater(deps());
  if (before === 0) {
    const r0 = await u.check({ reason: "manual" });
    check("limite do GitHub estourado: mensagem clara, sem “403”", r0.error === U.RATE_LIMIT_MSG, r0.error || "");
    console.log("     (limite de consultas do GitHub esgotado nesta rede; o resto da parte G fica para depois)");
    return;
  }
  const origGet = https.get;
  const origReq = https.request;
  https.get = count(origGet);
  https.request = count(origReq);
  let res;
  let res2;
  try {
    res = await u.check({ reason: "manual" });
    res2 = await u.check({ reason: "manual" });
  } finally {
    https.get = origGet;
    https.request = origReq;
  }
  console.log(`     extensão: aqui ${res.ext.installed} · fork ${res.ext.latest} · original ${res.ext.upstream} (base ${res.ext.base})`);
  check("consulta o GitHub sem erro", !res.error && !res2.error, res.error || res2.error || "");
  check("verificações não usam a API do GitHub (não gastam o limite)", apiCalls === 0, `${apiCalls} consulta(s)`);
  check("acha a versão do original também", !!res.ext.upstream, res.ext.upstream || "");
  check("2ª verificação dá o mesmo resultado", res2.ext.latest === res.ext.latest && res2.ext.upstream === res.ext.upstream);
  check("release da extensão existe no fork", !!res.ext.latest);
  check("o resultado não tem mais o motor", !("cli" in res));

  const calls = [];
  const origExec = vscodeMock.commands.executeCommand;
  vscodeMock.commands.executeCommand = (id, arg) => {
    calls.push([id, arg]);
    return Promise.resolve();
  };
  try {
    if (res.ext.release) {
      await u.applyExt(res.ext.release);
      const c = calls.find((x) => x[0] === "workbench.extensions.installExtension");
      const ok = !!c && fs.readFileSync(c[1].fsPath).subarray(0, 2).toString("latin1") === "PK";
      check("baixa o .vsix da release e pede ao VS Code para instalar", ok);
      if (c) try { fs.unlinkSync(c[1].fsPath); } catch {}
    }

    // Ao fechar, com versão antiga simulada: só verifica e anota; nada é instalado.
    calls.length = 0;
    try { fs.unlinkSync(path.join(os.tmpdir(), "swap-plus-close.lock")); } catch {}
    const oldCtx = { ...context, extension: { packageJSON: { version: "1.0.0", swapPlus: { upstreamExtension: "0.2.2" } } } };
    const u3 = U.createUpdater(deps({ context: oldCtx, overrides: { autoUpdate: true } }));
    const t0 = Date.now();
    const rc = await u3.onClose();
    const took = Date.now() - t0;
    check("ao fechar: verifica em até 3 s", !!rc && took <= 3500, `${took} ms`);
    check("ao fechar: anota que há versão nova para a próxima abertura", u3.summary().pendingOnOpen === true);
    check("ao fechar: nada é instalado", !calls.some((x) => x[0] === "workbench.extensions.installExtension"));
  } finally {
    vscodeMock.commands.executeCommand = origExec;
  }
}

(async () => {
  partA();
  partV();
  await partL();
  partC();
  partE();
  partU();
  if (!UNIT) await partG();
  console.log(failed ? `\n${failed} verificação(ões) falharam.` : "\nTudo certo.");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
