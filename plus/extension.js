"use strict";
// Swap Plus — fork pessoal de smith89k/claude-swap-status (MIT).
//
// - Barra de status: um único item, com ícone de e-mail (endereço no hover),
//   sessão de 5h, semanal e limites semanais por modelo (ex.: Fable).
// - Clique na barra: lista de contas, com "Configurações" em primeiro.
// - Modo privado: mostra só "Conta N", sem e-mail (Export Other liga sozinho).
// - Regras de aviso e de troca automática, com linhas separadas para sessão,
//   semanal e por modelo. A decisão é tomada aqui, olhando o modelo que está em
//   uso no Claude Code; a troca em si é feita pelo CLI `swap-plus`
//   (fork do claude-swap; o `cswap` original também serve).
// - Modo servidor (2.0, `swapPlus.mode = "server"`): um servidor guarda os
//   logins, renova e decide as trocas; este computador recebe só o acesso da
//   conta escolhida para ele. Ver a seção "modo servidor" abaixo.

const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { createUpdater, cmpVersion } = require("./updater");
const {
  STRATEGY_LABELS,
  loginDead,
  fmtPct,
  roundedDate,
  dayPrefix,
  fmtWhen,
  windows,
  recordOf,
  linesFor,
  scopedNames,
  modelLabel,
  watchedModels,
  decide,
  RULE_DEFAULTS,
} = require("./rules");

const NS = "swapPlus";
const HISTORY_KEY = "swapPlus.autoHistory";
const LAST_TICK_KEY = "swapPlus.lastTick";
const LAST_SWITCH_KEY = "swapPlus.lastAutoSwitch";
const ALERTED_KEY = "swapPlus.alerted";
const AUTO_LOCK = path.join(os.tmpdir(), "swap-plus-auto.lock");
const HISTORY_MAX = 40;
const MODEL_WINDOW_MS = 30 * 60 * 1000; // modelo "em uso" = usado nos últimos 30 min
const YELLOW_AT = 70;


const STATUS_LABELS = {
  ok: "ok",
  token_expired: "token expirado",
  relogin_required: "precisa logar de novo",
  no_credentials: "sem credenciais",
  api_key: "API key (sem cota)",
  keychain_unavailable: "Keychain indisponível",
  foreign_credential: "credencial de outra conta",
  unavailable: "indisponível",
  unknown: "sem leitura ainda", // modo servidor: conta que o servidor ainda não consultou
};

let extContext;
let mainItem;
let panel;
let pollTimer;
let autoTimer;
let autoGen = 0;
let refreshing = null;
let lastBlockedWarnAt = 0;
let updater = null;
let state = { list: null, records: {}, models: [], error: null, fetchedAt: 0, unmanaged: null };

// Modo servidor: conexão e último estado recebido (detalhes na seção "modo servidor").
const srv = {
  token: undefined, // token deste computador no servidor; undefined = ainda não lido do cofre do VS Code
  client: null,
  clientKey: "",
  state: null, // última resposta de estado do servidor
  status: null, // null | "online" | "offline" | "revoked"
  lastOkAt: 0,
  lastError: null,
  hold: false, // conexão, envio de logins, desligar ou voltar ao modo local em andamento: o ciclo espera
  rejected: null, // { key, at, reason }: login atual recusado pelo servidor (não é apagado)
  loginRetry: null, // { key, at }: o servidor não conseguiu conferir o login agora (refresh_failed...): tenta de novo em ~1 min
  applyFail: null, // { key, at }: falha ao gravar a credencial (espera 1 min)
  discard: null, // login recusado que a pessoa decidiu trocar pela conta do servidor
  expectNumber: null, // troca pedida daqui: não avisar como "troca do servidor"
  originMismatch: false, // o token não vale no endereço atual (createServerClient recusou): nada é enviado
  owner: null, // esta janela é a "dona" (faz o batimento e grava)? null = ainda não sabe
  storeWarnings: [], // avisos do claudeAuth sobre onde o Claude Code lê o login (ex.: Gerenciador de Credenciais do Windows)
  accountWarned: null, // erro ao gravar o oauthAccount no ~/.claude.json já avisado (código)
  revokedWarned: false,
  disconnectedWarned: false,
};

// ---------------------------------------------------------------- utilitários

function cfg() {
  return vscode.workspace.getConfiguration(NS);
}

function numSetting(key, def, lo, hi) {
  const v = cfg().get(key);
  const n = Number(v);
  if (v === null || v === undefined || v === "" || !isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, n));
}

function rules() {
  // Modo servidor: as regras são as do servidor (valem para todos os computadores).
  if (serverMode() && srv.state && srv.state.rules) {
    const r = { ...RULE_DEFAULTS, ...srv.state.rules };
    if (!STRATEGY_LABELS[r.strategy]) r.strategy = "max";
    return r;
  }
  return localRules();
}

/** Regras das configurações deste VS Code (as do modo local). */
function localRules() {
  const st = cfg().get("rules.strategy");
  const pref = cfg().get("rules.preferModel");
  return {
    sessionPct: numSetting("rules.sessionSwitchPct", 90, 50, 100),
    weeklyPct: numSetting("rules.weeklySwitchPct", 80, 50, 100),
    modelPct: numSetting("rules.modelSwitchPct", 95, 50, 100),
    preferModel: typeof pref === "string" ? pref.trim() : "Fable",
    strategy: STRATEGY_LABELS[st] ? st : "max", // padrão: aproveitar ao máximo (fila por renovação)
    expiringHours: numSetting("rules.expiringHours", 24, 1, 168),
    cooldownMin: numSetting("rules.cooldownMinutes", 5, 0, 240),
    marginPct: numSetting("rules.marginPct", 5, 0, 30),
    intervalSec: numSetting("rules.intervalSeconds", 60, 15, 3600),
    // O que fazer quando o limite de um modelo (ex.: Fable) acaba na conta em uso.
    onModelLimit: cfg().get("rules.onModelLimit") === "switchAccount" ? "switchAccount" : "sameAccount",
  };
}

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

function privateMode() {
  return !!cfg().get("privacy.hideEmails");
}

/** Em modo privado, nenhum e-mail sai em mensagens, histórico ou tela. */
function safe(text) {
  return privateMode() ? String(text).replace(EMAIL_RE, "(e-mail oculto)") : String(text);
}

/** "Conta 3" (modo privado) ou "Conta 3 “apelido” — email". */
function displayName(acc) {
  if (privateMode()) return `Conta ${acc.number}`;
  const alias = accountAlias(acc);
  return `Conta ${acc.number}${alias ? ` “${alias}”` : ""} — ${acc.email}`;
}

function cswapPath() {
  const configured = (cfg().get("executablePath") || "").trim();
  if (configured) return configured;
  // swap-plus é o comando do fork; cswap (o original) fica como reserva.
  // No Windows o uv instala os comandos como .exe na mesma pasta.
  const ext = process.platform === "win32" ? ".exe" : "";
  for (const name of ["swap-plus", "cswap"]) {
    const local = path.join(os.homedir(), ".local", "bin", name + ext);
    if (fs.existsSync(local)) return local;
  }
  return "swap-plus" + ext;
}

// No modo servidor o motor local não é usado: só a migração (export/list) e a consulta de versão passam.
// A conferência é feita na hora de rodar, então nada que começou no modo local chega ao motor depois da troca.
const SERVER_MODE_ENGINE_ALLOWED = new Set(["export", "list", "--version"]);

function runCswap(args, timeout = 90000) {
  if (serverMode() && !SERVER_MODE_ENGINE_ALLOWED.has(String(args[0]))) {
    return Promise.resolve({ code: -1, stdout: "", stderr: "modo servidor: o motor local não é usado", spawnError: "modo servidor" });
  }
  return new Promise((resolve) => {
    execFile(
      cswapPath(),
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, NO_COLOR: "1" } },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
        resolve({ code, stdout: stdout || "", stderr: stderr || "", spawnError: code === -1 ? String(err.message || err) : null });
      }
    );
  });
}

// Comandos que gravam no motor (add, alias, linha, prioridade, rotação, troca,
// reordenar) rodam um de cada vez: o motor regrava a lista de contas inteira e
// dois ao mesmo tempo podem perder a mudança de um deles.
let writeChain = Promise.resolve();
function runCswapWrite(args, timeout) {
  const p = writeChain.then(() => runCswap(args, timeout));
  writeChain = p.catch(() => {});
  return p;
}

function parseJson(s) {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function lastLine(s) {
  const lines = String(s || "").trim().split("\n").filter(Boolean);
  return safe(lines.length ? lines[lines.length - 1] : "");
}

function statusLabel(s) {
  return (s && STATUS_LABELS[s]) || s || "desconhecido";
}

function needsAttention(s) {
  return !!s && s !== "ok" && s !== "token_expired" && s !== "unknown";
}


/** Interruptor geral. Desligado: não consulta as contas, não troca e não mexe no login. */
function swapOn() {
  return cfg().get("enabled") !== false;
}


function progressBar(pct) {
  const total = 5;
  const filled = Math.max(0, Math.min(total, Math.round((pct / 100) * total)));
  return "█".repeat(filled) + "░".repeat(total - filled);
}

function resetIn(iso) {
  if (!iso) return null;
  const ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return null;
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return `${d}d${h > 0 ? `${h}h` : ""}`;
  if (h > 0) return `${h}h${m > 0 ? `${m}m` : ""}`;
  return `${m}m`;
}




/** Versão curta para a lista de contas: "hoje 18h", "sex 20/11 12h30" */
function shortWhen(iso) {
  const d = roundedDate(iso);
  if (!d) return null;
  const hm = d.getMinutes() === 0 ? `${d.getHours()}h` : `${d.getHours()}h${String(d.getMinutes()).padStart(2, "0")}`;
  return `${dayPrefix(d)} ${hm}`;
}

function level(pct, line) {
  if (pct === null || pct === undefined || isNaN(pct)) return "none";
  if (pct >= line) return "bad";
  if (pct >= Math.min(YELLOW_AT, line)) return "warn";
  return "ok";
}

/** "Semanal: 30% usado — renova hoje 18h" */
function seg(label, win) {
  let s = `${label}: ${fmtPct(win.pct)} usado`;
  if (win.resetsAt) s += ` — renova ${shortWhen(win.resetsAt)}`;
  return s;
}

function worstLevel(levels) {
  if (levels.includes("bad")) return "bad";
  if (levels.includes("warn")) return "warn";
  return "ok";
}

function levelColor(lv) {
  if (lv === "bad") return new vscode.ThemeColor("charts.red");
  if (lv === "warn") return new vscode.ThemeColor("charts.yellow");
  return undefined;
}

// ---------------------------------------------------------------- uso e linhas




function accountRecord(num) {
  return recordOf(state.records, num);
}

function accountAlias(acc) {
  return acc.alias || accountRecord(acc.number).alias || null;
}



// ---------------------------------------------------------------- modelo em uso



async function readTail(p, bytes) {
  const fh = await fs.promises.open(p, "r");
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/**
 * Modelos usados pelo Claude Code nos últimos 30 minutos, do mais recente para
 * o mais antigo. Lê só o fim das transcrições locais (~/.claude/projects).
 */
async function detectModels(now = Date.now()) {
  const root = path.join(os.homedir(), ".claude", "projects");
  const seen = new Map();
  let dirs = [];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let files = [];
    try {
      files = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith(".jsonl")) continue;
      const p = path.join(dir, f);
      let st;
      try {
        st = await fs.promises.stat(p);
      } catch {
        continue;
      }
      if (now - st.mtimeMs > MODEL_WINDOW_MS) continue;
      let tail = "";
      try {
        tail = await readTail(p, 256 * 1024);
      } catch {
        continue;
      }
      const re = /"model":"(claude-[^"]+)"/g;
      let m;
      let last = null;
      while ((m = re.exec(tail))) last = m[1];
      if (last && (!seen.has(last) || seen.get(last) < st.mtimeMs)) seen.set(last, st.mtimeMs);
    }
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id, ts]) => ({ id, label: modelLabel(id), ts }));
}

// ---------------------------------------------------------------- decisão de troca


// ---------------------------------------------------------------- dados

async function readRecords() {
  const root = path.join(os.homedir(), ".claude-swap-backup");
  try {
    const seq = JSON.parse(await fs.promises.readFile(path.join(root, "sequence.json"), "utf8"));
    const out = {};
    for (const [num, rec] of Object.entries(seq.accounts || {})) {
      // Só as preferências da conta; nada de credenciais.
      out[num] = { alias: rec.alias || null, disabled: !!rec.disabled, threshold: rec.threshold ?? null, priority: rec.priority ?? 0 };
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Versão mais nova do Swap Plus já instalada nesta máquina (pelo instalador, pelo
 * terminal ou por outra janela) do que a que está rodando nesta janela. O VS Code
 * só passa a usar a versão nova depois de recarregar a janela.
 */
function newerInstalledVersion(extDir, own) {
  let obsolete = {};
  try {
    obsolete = JSON.parse(fs.readFileSync(path.join(extDir, ".obsolete"), "utf8")) || {};
  } catch {}
  let best = null;
  let names = [];
  try {
    names = fs.readdirSync(extDir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = name.match(/^paulo-local\.swap-plus-(\d+\.\d+\.\d+)$/);
    if (!m || obsolete[name]) continue;
    if (cmpVersion(m[1], own) > 0 && (!best || cmpVersion(m[1], best) > 0)) best = m[1];
  }
  return best;
}

let reloadPrompted = null;
function checkNewerInstalled() {
  if (!extContext || !extContext.extensionPath) return;
  const own = (extContext.extension && extContext.extension.packageJSON.version) || require("./package.json").version;
  const v = newerInstalledVersion(path.dirname(extContext.extensionPath), own);
  if (!v || reloadPrompted === v) return;
  reloadPrompted = v;
  vscode.window
    .showInformationMessage(`Swap Plus ${v} já está instalado, mas esta janela ainda usa a ${own}. Recarregue para usar a versão nova.`, "Recarregar agora")
    .then((c) => c && vscode.commands.executeCommand("workbench.action.reloadWindow"));
}

// ---------------------------------------------------------------- salvar o login na hora
//
// O refresh token de cada conta é de uso único: quando o Claude Code renova o
// token (ou você entra de novo), o anterior deixa de valer. Se a cópia guardada
// no Swap Plus ficar com o token velho, a conta "morre" para o Swap Plus. Por
// isso, sempre que o login do Claude Code muda numa conta cadastrada, ele é
// salvo na hora (`swap-plus add` regrava a cópia da conta logada).

const SAVED_LOGIN_KEY = "swapPlus.savedLogin";
const SAVE_RETRY_MS = 10 * 60 * 1000;
let saveTriedAt = {};

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Só a validade do login atual do Claude Code (nunca guarda nem mostra o token). */
function liveLoginExpiresAt() {
  const pick = (text) => {
    const j = parseJson(text);
    const o = j && j.claudeAiOauth;
    // Login sem refresh token (entregue por um servidor Swap Plus): não há o que guardar,
    // e gravar por cima estragaria a cópia do motor.
    if (o && !o.refreshToken) return null;
    return o && typeof o.expiresAt === "number" ? o.expiresAt : null;
  };
  return new Promise((resolve) => {
    if (process.platform === "darwin") {
      execFile("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { timeout: 10000 }, (err, stdout) => {
        if (!err && stdout) return resolve(pick(stdout.trim()));
        fs.readFile(path.join(claudeConfigDir(), ".credentials.json"), "utf8", (e2, t) => resolve(e2 ? null : pick(t)));
      });
    } else {
      fs.readFile(path.join(claudeConfigDir(), ".credentials.json"), "utf8", (e, t) => resolve(e ? null : pick(t)));
    }
  });
}

/** Conta logada agora no Claude Code (e-mail + organização), lida do ~/.claude.json. */
function liveIdentity() {
  const files = [path.join(os.homedir(), ".claude.json"), path.join(claudeConfigDir(), ".claude.json")];
  for (const f of files) {
    try {
      const o = JSON.parse(fs.readFileSync(f, "utf8")).oauthAccount;
      if (o && o.emailAddress) return { email: String(o.emailAddress).toLowerCase(), org: o.organizationUuid || null };
    } catch {}
  }
  return null;
}

/**
 * Salva o login atual na conta cadastrada quando ele é novo (token renovado ou
 * login refeito). Devolve true quando salvou. Não cadastra conta nova: isso
 * continua sendo perguntado (offerRegister).
 */
async function saveLiveLogin(list) {
  const who = liveIdentity();
  if (!who) return false;
  const acc = list.accounts.find(
    (a) => String(a.email || "").toLowerCase() === who.email && (!who.org || !a.organizationUuid || a.organizationUuid === who.org)
  );
  if (!acc) return false;
  const exp = await liveLoginExpiresAt();
  // Login vencido ou ilegível: não há nada novo para guardar (e não estraga a cópia).
  if (!exp || exp <= Date.now() + 60 * 1000) return false;
  const id = `${acc.email}|${acc.organizationUuid || ""}`;
  const saved = extContext.globalState.get(SAVED_LOGIN_KEY) || {};
  if (saved[id] === exp && !loginDead(acc)) return false;
  // Mesma versão do login: tenta de novo no máximo a cada 10 min (evita repetir a cada ciclo).
  if (saveTriedAt[id + exp] && Date.now() - saveTriedAt[id + exp] < SAVE_RETRY_MS) return false;
  saveTriedAt[id + exp] = Date.now();
  const r = await runCswapWrite(["add"], 60000);
  if (r.code !== 0) {
    console.error("[swap-plus] salvar login", lastLine(r.stderr) || lastLine(r.stdout));
    return false;
  }
  delete saveTriedAt[id + exp];
  await extContext.globalState.update(SAVED_LOGIN_KEY, { ...saved, [id]: exp });
  if (loginDead(acc)) {
    const text = `Login da conta ${acc.number} salvo de novo no Swap Plus (estava “${statusLabel(acc.usageStatus)}”)`;
    await pushHistory([{ ts: new Date().toISOString(), kind: "info", text }]);
    vscode.window.showInformationMessage(`Swap Plus: ${text}.`);
  }
  return true;
}

/** Depois de gravar: espera a atualização em andamento (que pode ter lido antes da gravação) e lê de novo. */
function refreshFresh() {
  const prev = refreshing;
  return prev ? prev.catch(() => {}).then(() => refresh()) : refresh();
}

function refresh() {
  if (refreshing) return refreshing;
  if (!swapOn()) {
    // Desligado: nenhuma chamada ao swap-plus (não renova token de nenhuma conta).
    state = { ...state, error: null, unmanaged: null };
    render();
    postState();
    return Promise.resolve();
  }
  if (serverMode()) {
    // Modo servidor: um ciclo = batimento no servidor (+ aplicar a conta escolhida). Nada do motor local.
    // Na fila única: nunca ao mesmo tempo que uma troca manual, um limite ou "usar a conta do servidor".
    refreshing = srvQueue(() => serverSync())
      .catch((e) => {
        // Erro daqui (ex.: arquivo da extensão faltando), não do servidor: mostra e não mexe no login.
        console.error("[swap-plus] servidor", safeErr(e));
        srv.status = "offline";
        srv.lastError = `erro na extensão: ${safeErr(e)}`;
        state = { ...state, error: cap(serverErrorLine()), fetchedAt: Date.now() };
        finishSync();
      })
      .finally(() => {
        refreshing = null;
      });
    return refreshing;
  }
  refreshing = (async () => {
    const [l0, models, records] = await Promise.all([runCswap(["list", "--json"]), detectModels(), readRecords()]);
    let l = l0;
    let list = parseJson(l.stdout);
    if (list && Array.isArray(list.accounts)) {
      let saved = false;
      try {
        saved = await saveLiveLogin(list);
      } catch (e) {
        console.error("[swap-plus] salvar login", e);
      }
      if (saved) {
        l = await runCswap(["list", "--json"]);
        list = parseJson(l.stdout);
      }
    }
    const ok = list && Array.isArray(list.accounts);
    // Sem conta em uso entre as cadastradas: o Claude Code pode estar logado numa conta nova.
    let unmanaged = null;
    if (ok && !list.accounts.some((a) => a.number === list.activeAccountNumber)) {
      const st = parseJson((await runCswap(["status", "--json"], 30000)).stdout);
      const a = st && st.active;
      if (a && a.managed === false && a.email) unmanaged = { email: a.email, org: a.organizationName || "" };
    }
    state = {
      list: ok ? list : null,
      records,
      models,
      unmanaged,
      error: ok ? null : l.spawnError || lastLine(l.stderr) || "não foi possível ler 'swap-plus list --json'",
      fetchedAt: Date.now(),
    };
    render();
    postState();
    if (unmanaged) offerRegister(unmanaged);
    checkAlerts().catch((e) => console.error("[swap-plus] alerts", e));
    checkNewerInstalled();
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

// ---------------------------------------------------------------- barra de status

function usageTooltip(acc, w, l) {
  const t = new vscode.MarkdownString(undefined, true);
  const priv = privateMode();
  t.appendMarkdown(`**Conta ${acc.number}**`);
  if (!priv) {
    const alias = accountAlias(acc);
    if (alias) t.appendText(` (${alias})`);
    t.appendMarkdown(" — **");
    t.appendText(acc.email || "");
    t.appendMarkdown("**");
  }
  t.appendMarkdown("  \n");
  const meta = [];
  if (acc.plan && acc.plan.label) meta.push(`plano ${acc.plan.label}`);
  if (!priv && acc.organizationName) meta.push(acc.organizationName);
  if (meta.length) t.appendText(meta.join(" · "));
  t.appendMarkdown("\n\n");

  if (!w) {
    t.appendText(`Uso indisponível (${statusLabel(acc.usageStatus)})`);
  } else {
    if (w.stale) {
      t.appendText(`Dados de ${Math.round((w.ageSeconds || 0) / 60)} min atrás (${statusLabel(acc.usageStatus)}).`);
      t.appendMarkdown("\n\n");
    }
    const line = (label, win, withLeft) => {
      t.appendMarkdown(`**${label}:** `);
      let s = `${fmtPct(win.pct)} usado`;
      if (withLeft) s += ` (sobra ${fmtPct(100 - win.pct)})`;
      if (win.resetsAt) s += ` — renova ${fmtWhen(win.resetsAt)}, em ${resetIn(win.resetsAt)}`;
      else if (win.idle) s += " — sem uso nas últimas 5h";
      t.appendText(s);
      t.appendMarkdown("  \n");
    };
    line("Sessão (5h)", w.session, true);
    if (w.weekly) line("Semanal", w.weekly, true);
    for (const m of w.models) line(m.name, m, true);
    if (w.weekly && w.weekly.willLast === false && w.weekly.exhaustAt) {
      t.appendText(`No ritmo atual, o semanal acaba ${fmtWhen(w.weekly.exhaustAt)}`);
      t.appendMarkdown("  \n");
    }
  }
  if (state.models.length) {
    t.appendMarkdown("\n");
    t.appendText(`Modelo em uso: ${state.models[0].label}`);
  }
  if (serverMode()) {
    t.appendMarkdown("\n\n");
    const last = srv.lastOkAt ? fmtWhen(srv.lastOkAt) : null;
    t.appendText(`Modo servidor: ${serverHost()}${last ? ` · último contato ${last}` : ""}. Quem escolhe a conta e troca é o servidor.`);
    for (const wtext of srv.storeWarnings || []) {
      t.appendMarkdown("\n\n**Atenção:** ");
      t.appendText(safe(wtext));
    }
  }
  t.appendMarkdown("\n\n_Clique para trocar de conta ou abrir as configurações_");
  return t;
}

/** Moldura do item: o VS Code não desenha borda em item da barra; as barras finas fazem esse papel. */
const frame = (s) => `│  ${s}  │`;

function render() {
  if (!mainItem) return;
  mainItem.color = undefined;
  mainItem.backgroundColor = undefined;
  const list = state.list;

  if (!swapOn()) {
    mainItem.text = frame("$(mail)  Swap Plus desligado");
    mainItem.tooltip =
      "O Swap Plus está desligado: não consulta as contas, não troca de conta e não mexe no login. O Claude Code funciona normalmente com a conta em que você entrar.\n\nClique para ligar de novo.";
    mainItem.show();
    return;
  }

  if (serverMode() && renderServerProblem()) return;

  if (!list) {
    mainItem.text = frame("$(mail)  $(warning) Swap Plus: erro");
    mainItem.tooltip = `Falha ao executar o swap-plus.\n${state.error || ""}\n\nVerifique se 'swap-plus list --json' funciona no terminal.`;
    mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    mainItem.show();
    return;
  }

  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc && serverMode()) {
    mainItem.text = frame(
      list.accounts.length ? "$(mail) $(cloud)  sem conta atribuída — clique para escolher" : "$(mail) $(cloud)  nenhuma conta no servidor ainda"
    );
    mainItem.tooltip = list.accounts.length
      ? "O servidor ainda não escolheu uma conta para este computador. Clique para escolher uma."
      : "O servidor ainda não tem nenhuma conta. Entre com uma conta no Claude Code: o Swap Plus envia o login ao servidor sozinho. Ou, em Configurações → Servidor, use “Enviar os logins deste computador”.";
    mainItem.show();
    return;
  }
  if (!acc) {
    if (state.unmanaged) {
      mainItem.text = frame("$(mail)  conta logada não cadastrada — clique para cadastrar");
      mainItem.tooltip = `O Claude Code está logado em ${privateMode() ? "uma conta" : state.unmanaged.email} que ainda não está no Swap Plus. Enquanto ela não for cadastrada, o Swap Plus não acompanha o uso nem troca de conta. Clique para cadastrar.`;
      mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    } else {
      mainItem.text = frame("$(mail)  sem conta ativa");
      mainItem.tooltip = "Nenhuma conta logada no Claude Code. Clique para escolher uma conta ou abrir as configurações.";
    }
    mainItem.show();
    return;
  }

  const r = rules();
  const l = linesFor(acc, r, state.records);
  const w = windows(acc);
  // Modo servidor: aviso sobre onde o Claude Code lê o login (ex.: variável de ambiente que passa na frente).
  const storeWarn = serverMode() && (srv.storeWarnings || []).length > 0;
  const icon = (cfg().get("statusBar.showAccountNumber") ? `$(mail) ${acc.number}` : "$(mail)") + (serverMode() ? " $(cloud)" : "") + (storeWarn ? " $(warning)" : "");
  mainItem.tooltip = usageTooltip(acc, w, l);

  if (!w) {
    mainItem.text = frame(`${icon}  Uso: ${statusLabel(acc.usageStatus)}`);
    if (needsAttention(acc.usageStatus) || storeWarn) mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
    mainItem.show();
    return;
  }

  const showModels = !!cfg().get("statusBar.showModelWeekly");
  const segs = [seg("Sessão (5h)", w.session)];
  const levels = [level(w.session.pct, l.session)];
  if (w.weekly) {
    segs.push(seg("Semanal", w.weekly));
    levels.push(level(w.weekly.pct, l.weekly));
  }
  if (showModels) {
    for (const m of w.models) {
      segs.push(seg(m.name, m));
      levels.push(level(m.pct, l.model));
    }
  }
  // Um item só tem uma cor: vale a do limite mais perto do fim.
  mainItem.text = frame(`${icon}  ${segs.join("  ·  ")}${w.stale ? "  $(history)" : ""}`);
  mainItem.color = levelColor(worstLevel(levels));
  if (needsAttention(acc.usageStatus) || storeWarn) mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  mainItem.show();
}

// ---------------------------------------------------------------- polling

function setupPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = undefined;
  if (!swapOn()) return refresh(); // só desenha o estado "desligado"
  if (serverMode()) {
    // Batimento no servidor a cada 30 s (o intervalo de atualização do modo local não vale aqui).
    refresh();
    pollTimer = setInterval(() => refresh(), HEARTBEAT_MS);
    return;
  }
  const minutes = Math.max(0.5, Number(cfg().get("pollIntervalMinutes")) || 1);
  refresh();
  pollTimer = setInterval(() => refresh(), minutes * 60 * 1000);
}

// ---------------------------------------------------------------- alertas

function alertSettings() {
  const c = cfg();
  const pct = (k, d) => Math.max(1, Math.min(100, Number(c.get(k)) || d));
  return {
    fiveHourEnabled: !!c.get("alerts.fiveHourEnabled"),
    fiveHourPct: pct("alerts.fiveHourPct", 80),
    weeklyEnabled: !!c.get("alerts.weeklyEnabled"),
    weeklyPct: pct("alerts.weeklyPct", 70),
    modelEnabled: !!c.get("alerts.modelEnabled"),
    modelPct: pct("alerts.modelPct", 85),
  };
}

/** "Chegou a X% → avisar": uma notificação por conta, janela e ciclo de renovação. */
async function checkAlerts() {
  const list = state.list;
  if (!list) return;
  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc) return;
  const w = windows(acc);
  if (!w || w.stale) return;
  const a = alertSettings();
  const checks = [];
  if (a.fiveHourEnabled && !w.session.idle) checks.push({ id: "5h", label: "na sessão de 5h", w: w.session, line: a.fiveHourPct });
  if (a.weeklyEnabled && w.weekly) checks.push({ id: "7d", label: "no limite semanal", w: w.weekly, line: a.weeklyPct });
  if (a.modelEnabled) for (const m of w.models) checks.push({ id: `m:${m.name}`, label: `no semanal do ${m.name}`, w: m, line: a.modelPct });

  for (const ch of checks) {
    if (!(ch.w.pct >= ch.line)) continue;
    const key = `${acc.number}|${ch.id}|${ch.line}|${String(ch.w.resetsAt || "").slice(0, 13)}`;
    const alerted = extContext.globalState.get(ALERTED_KEY) || [];
    if (alerted.includes(key)) continue;
    await extContext.globalState.update(ALERTED_KEY, [key, ...alerted].slice(0, 200));
    const r = resetIn(ch.w.resetsAt);
    const text = `Conta ${acc.number} chegou a ${fmtPct(ch.w.pct)} ${ch.label}${r ? ` (renova em ${r})` : ""}`;
    await pushHistory([{ ts: new Date().toISOString(), kind: "alert", text }]);
    postState();
    const isModel = ch.id.startsWith("m:");
    const tail =
      isModel && rules().onModelLimit === "sameAccount"
        ? ` Quando ele acabar, o Claude Code pergunta “Switch models?”: escolha “Switch to ${claudeCodeSwitchTarget()}” para seguir na mesma conta e na mesma sessão.`
        : autoEnabled()
          ? " A troca automática assume quando passar da linha de troca."
          : "";
    vscode.window.showWarningMessage(`Swap Plus: ${text}.${tail}`, "Trocar para a melhor conta", "Configurações").then((choice) => {
      if (choice === "Trocar para a melhor conta") switchBest();
      else if (choice === "Configurações") openSettings();
    });
  }
}

// ---------------------------------------------------------------- Claude Code: modelo da troca

const OPUS_ID = "claude-opus-5-5";
const FABLE_ID = "claude-fable-5-2";

function claudeSettingsPath() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

/** Lê o settings.json do Claude Code. { data, error } — data = {} se o arquivo não existe. */
function readClaudeSettings(file = claudeSettingsPath()) {
  try {
    const text = fs.readFileSync(file, "utf8");
    const data = text.trim() ? JSON.parse(text) : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "o arquivo não tem o formato esperado" };
    return { data };
  } catch (e) {
    if (e.code === "ENOENT") return { data: {} };
    return { error: e.message };
  }
}

const isOpus = (m) => typeof m === "string" && /^(opus|claude-opus)/i.test(m.trim());

/**
 * Como o Claude Code está preparado para quando o Fable acabar. Ele oferece trocar
 * para o modelo padrão (`model`); com o padrão em Opus, a troca vai para o Opus 5.5,
 * no esforço definido em modelSettings.
 */
function claudeCodeStatus(file) {
  const r = readClaudeSettings(file);
  if (r.error) return { error: r.error };
  const d = r.data;
  const ms = d.modelSettings || {};
  const fableEffort = (ms[FABLE_ID] && ms[FABLE_ID].effortLevel) || d.effortLevel || null;
  const opusEffort = (ms[OPUS_ID] && ms[OPUS_ID].effortLevel) || d.effortLevel || null;
  const opusDefault = isOpus(d.model);
  return { model: d.model || null, opusDefault, fableEffort, opusEffort, ready: opusDefault && (!fableEffort || opusEffort === fableEffort) };
}

function claudeCodeSwitchTarget() {
  const st = claudeCodeStatus();
  return st && st.opusDefault ? "Opus 5.5" : "outro modelo";
}

/**
 * Deixa o Claude Code pronto: modelo padrão Opus (o que ele oferece quando o Fable
 * acaba) e o Opus 5.5 no mesmo esforço do Fable. Mexe só nessas chaves e mantém o
 * resto do arquivo. Vale para as próximas sessões (o Claude Code lê isso ao começar).
 */
function prepareClaudeCode(file = claudeSettingsPath()) {
  const r = readClaudeSettings(file);
  if (r.error) return { ok: false, error: `não consegui ler ${file}: ${r.error}` };
  const d = r.data;
  const changes = [];
  if (!isOpus(d.model)) {
    changes.push(`modelo padrão: ${d.model || "(nenhum)"} → opus`);
    d.model = "opus";
  }
  const ms = (d.modelSettings = d.modelSettings && typeof d.modelSettings === "object" ? d.modelSettings : {});
  const fableEffort = (ms[FABLE_ID] && ms[FABLE_ID].effortLevel) || d.effortLevel || "xhigh";
  const cur = ms[OPUS_ID] && ms[OPUS_ID].effortLevel;
  if (cur !== fableEffort) {
    ms[OPUS_ID] = { ...(ms[OPUS_ID] || {}), effortLevel: fableEffort };
    changes.push(`esforço do Opus 5.5: ${cur || "(padrão)"} → ${fableEffort}`);
  }
  if (!changes.length) return { ok: true, changes };
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.swap-plus-${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(d, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true, changes };
}

// ---------------------------------------------------------------- troca automática

function autoEnabled() {
  if (!swapOn()) return false;
  // Modo servidor: a troca automática liga/desliga no servidor (vale para todos os computadores).
  if (serverMode()) return !!(srv.state && srv.state.autoSwitch);
  return !!cfg().get("autoSwitch.enabled");
}

function claimSlot(ms) {
  // Evita que várias janelas do VS Code decidam ao mesmo tempo.
  try {
    const now = Date.now();
    let last = 0;
    try {
      last = Number(fs.readFileSync(AUTO_LOCK, "utf8")) || 0;
    } catch {}
    if (now - last < ms * 0.8) return false;
    fs.writeFileSync(AUTO_LOCK, String(now));
    return true;
  } catch {
    return true;
  }
}

function setupAuto() {
  const gen = ++autoGen;
  if (autoTimer) clearTimeout(autoTimer);
  autoTimer = undefined;
  if (serverMode() || !autoEnabled()) return; // modo servidor: quem decide é o servidor
  const loop = async () => {
    if (gen !== autoGen) return;
    try {
      await autoTick({ manual: false });
    } catch (e) {
      console.error("[swap-plus] auto tick", e);
    }
    if (gen === autoGen && autoEnabled() && !serverMode()) autoTimer = setTimeout(loop, effectiveIntervalSec() * 1000);
  };
  autoTimer = setTimeout(loop, 5000);
}

const NEAR_LINE_PCT = 15; // mesma faixa em que o motor passa a atualizar o uso a cada minuto
const NEAR_LINE_INTERVAL_S = 30;

/** Conta em uso perto de alguma linha de troca: verifica a cada 30 s (o dado vem do cache do motor, sem gastar cota). */
function nearLine() {
  const list = state.list;
  const acc = list && list.accounts.find((a) => a.number === list.activeAccountNumber);
  const w = acc && windows(acc);
  if (!w) return false;
  const r = rules();
  const l = linesFor(acc, r, state.records);
  const rows = [[w.session.pct, l.session]];
  if (w.weekly) rows.push([w.weekly.pct, l.weekly]);
  if (r.onModelLimit === "switchAccount") {
    const watch = watchedModels(state.models.map((m) => m.id), scopedNames(list));
    for (const m of w.models) if (watch.includes(m.name)) rows.push([m.pct, l.model]);
  }
  return rows.some(([pct, line]) => pct >= line - NEAR_LINE_PCT);
}

function effectiveIntervalSec() {
  const base = rules().intervalSec;
  return nearLine() ? Math.min(base, NEAR_LINE_INTERVAL_S) : base;
}

async function pushHistory(entries) {
  if (!entries.length) return;
  const hist = extContext.globalState.get(HISTORY_KEY) || [];
  const fresh = entries.filter((e) => !(hist[0] && hist[0].kind === e.kind && hist[0].text === e.text));
  if (!fresh.length) return;
  await extContext.globalState.update(HISTORY_KEY, [...fresh.reverse(), ...hist].slice(0, HISTORY_MAX));
}

async function execSwitch(d) {
  const res = await runCswapWrite(["switch", String(d.to)], 120000);
  await refreshFresh();
  const now = state.list ? state.list.activeAccountNumber : null;
  if (res.code === 0 && now === d.to) return { ok: true };
  return { ok: false, error: lastLine(res.stderr) || res.spawnError || `a conta ativa continua ${now}` };
}

async function autoTick({ manual = false, dryRun = false } = {}) {
  if (serverMode()) return null; // a decisão local não roda no modo servidor
  const r = rules();
  if (!manual && !claimSlot(effectiveIntervalSec() * 1000)) return null;
  await refresh();
  const ts = new Date().toISOString();
  let main;
  if (!state.list) {
    main = { ts, kind: "error", text: `Erro ao ler as contas: ${state.error}` };
  } else {
    const d = decide({
      list: state.list,
      records: state.records,
      r,
      modelIds: state.models.map((m) => m.id),
      now: Date.now(),
      lastSwitchAt: extContext.globalState.get(LAST_SWITCH_KEY) || 0,
    });
    if (d.action === "switch" && dryRun) {
      main = { ts, kind: "sim", text: `Trocaria ${d.text}` };
    } else if (d.action === "switch") {
      const res = await execSwitch(d);
      if (res.ok) {
        await extContext.globalState.update(LAST_SWITCH_KEY, Date.now());
        main = { ts, kind: "switch", text: `Trocou ${d.text}`, atLimit: !!d.atLimit };
      } else {
        main = { ts, kind: "error", text: `Falha ao trocar para a conta ${d.to}: ${res.error}` };
      }
    } else {
      main = { ts, kind: d.kind, text: d.kind === "idle" ? `Sem troca: ${d.text}` : d.text.charAt(0).toUpperCase() + d.text.slice(1) };
    }
  }

  if (!dryRun) {
    await extContext.globalState.update(LAST_TICK_KEY, main);
    if (main.kind !== "idle") await pushHistory([main]);
  }
  if (main.kind === "switch") {
    const model = state.models[0];
    vscode.window.showInformationMessage(`Swap Plus: ${main.text}.${model ? ` O Claude Code continua no ${model.label}.` : ""}${main.atLimit ? RESUME_TIP : ""}`);
  } else if (main.kind === "blocked" && !manual && !dryRun && Date.now() - lastBlockedWarnAt > 60 * 60 * 1000) {
    lastBlockedWarnAt = Date.now();
    vscode.window.showWarningMessage(`Swap Plus: ${main.text}.`);
  } else if (main.kind === "error" && !manual) {
    vscode.window.showErrorMessage(`Swap Plus: ${main.text}`);
  }
  render();
  postState();
  return main;
}

// ---------------------------------------------------------------- limite estourado: reação imediata

const RESUME_TIP = " Se o Claude Code parou com “You've hit your limit”, mande uma mensagem (por exemplo, “continue”) para ele seguir na conta nova.";
const LIMIT_KEY = "swapPlus.lastLimitHit";
const LIMIT_LOCK = path.join(os.tmpdir(), "swap-plus-limit.lock");
const LIMIT_SCAN_S = 15;
let limitTimer = null;
let limitRoot = path.join(os.homedir(), ".claude", "projects");

function limitLabel(text) {
  const t = String(text || "");
  if (/5-hour|five.?hour|session/i.test(t)) return "limite da sessão de 5h";
  if (/weekly|week|seven.?day/i.test(t)) return /fable|opus|sonnet/i.test(t) ? null : "limite semanal";
  if (/fable|opus|sonnet/i.test(t)) return null; // limite de um modelo: quem resolve é a pergunta do Claude Code
  return "limite de uso";
}

/**
 * Procura, no fim das transcrições alteradas desde `sinceMs`, o erro que o Claude
 * Code grava quando a conta bate o limite: mensagem marcada isApiErrorMessage com
 * error "rate_limit". Texto de conversa comum que cite o erro não conta.
 */
async function scanLimitErrors(sinceMs, root = limitRoot) {
  let latest = null;
  const files = [];
  let dirs = [];
  try {
    dirs = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const dir = path.join(root, d.name);
    let entries = [];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.isFile() && e.name.endsWith(".jsonl")) files.push(path.join(dir, e.name));
      else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, "subagents");
        try {
          for (const f of await fs.promises.readdir(sub)) if (f.endsWith(".jsonl")) files.push(path.join(sub, f));
        } catch {}
      }
    }
  }
  for (const f of files) {
    let st;
    try {
      st = await fs.promises.stat(f);
    } catch {
      continue;
    }
    if (st.mtimeMs <= sinceMs) continue;
    let tail;
    try {
      tail = await readTail(f, 128 * 1024);
    } catch {
      continue;
    }
    for (const line of tail.split("\n")) {
      if (!line.includes('"isApiErrorMessage":true') || !line.includes('"rate_limit"')) continue;
      let d;
      try {
        d = JSON.parse(line);
      } catch {
        continue;
      }
      if (d.isApiErrorMessage !== true || d.error !== "rate_limit") continue;
      const ts = Date.parse(d.timestamp) || st.mtimeMs;
      if (ts <= sinceMs) continue;
      const c = d.message && d.message.content;
      const text = Array.isArray(c) ? c.map((x) => (x && x.text) || "").join(" ") : String(c || "");
      if (!latest || ts > latest.ts) latest = { ts, text, file: f };
    }
  }
  return latest;
}

/** Trava entre janelas: só uma reage a cada erro. */
function claimLimit(ts) {
  try {
    let last = 0;
    try {
      last = Number(fs.readFileSync(LIMIT_LOCK, "utf8")) || 0;
    } catch {}
    if (last >= ts) return false;
    fs.writeFileSync(LIMIT_LOCK, String(ts));
    return true;
  } catch {
    return true;
  }
}

async function checkLimitErrors() {
  if (!swapOn()) return null;
  const now = Date.now();
  const since = Math.max(extContext.globalState.get(LIMIT_KEY) || 0, extContext.globalState.get(LAST_SWITCH_KEY) || 0, now - 10 * 60 * 1000);
  const hit = await scanLimitErrors(since);
  if (!hit) return null;
  await extContext.globalState.update(LIMIT_KEY, hit.ts);
  const label = limitLabel(hit.text);
  if (!label || !claimLimit(hit.ts)) return null;
  return handleLimitHit(label);
}

async function handleLimitHit(label) {
  if (serverMode()) return serverLimitHit(label);
  await refresh();
  const list = state.list;
  if (!list) return null;
  const from = list.activeAccountNumber;
  const ts = new Date().toISOString();
  if (!autoEnabled()) {
    const text = `A conta ${from} bateu o ${label}.`;
    await pushHistory([{ ts, kind: "alert", text }]);
    vscode.window.showWarningMessage(`Swap Plus: ${text} A troca automática está desligada.`, "Trocar para a melhor conta").then((c) => c && switchBest());
    postState();
    return { kind: "alert" };
  }
  const d = decide({ list, records: state.records, r: rules(), modelIds: state.models.map((m) => m.id), now: Date.now(), limitHit: label });
  let main;
  if (d.action === "switch") {
    const res = await execSwitch(d);
    if (res.ok) {
      await extContext.globalState.update(LAST_SWITCH_KEY, Date.now());
      main = { ts, kind: "switch", text: `Trocou na hora ${d.text}`, atLimit: true };
      vscode.window.showInformationMessage(`Swap Plus: ${main.text}.${RESUME_TIP}`);
    } else {
      main = { ts, kind: "error", text: `A conta ${from} bateu o ${label}, mas a troca falhou: ${res.error}` };
      vscode.window.showErrorMessage(`Swap Plus: ${main.text}`);
    }
  } else {
    main = { ts, kind: "blocked", text: d.text.charAt(0).toUpperCase() + d.text.slice(1) };
    vscode.window.showWarningMessage(`Swap Plus: ${main.text}.`);
  }
  await extContext.globalState.update(LAST_TICK_KEY, main);
  await pushHistory([main]);
  render();
  postState();
  return main;
}

/**
 * Atualiza a barra e a tela no instante em que a conta em uso muda — por esta
 * janela, por outra janela do VS Code ou pelo terminal — sem esperar o próximo ciclo.
 */
function watchAccounts() {
  const dir = path.join(os.homedir(), ".claude-swap-backup");
  let t = null;
  try {
    const w = fs.watch(dir, (_ev, name) => {
      if (serverMode()) return; // modo servidor: as contas do motor local não importam
      if (name && !String(name).startsWith("sequence.json")) return;
      clearTimeout(t);
      t = setTimeout(() => refresh().catch(() => {}), 700);
    });
    extContext.subscriptions.push({ dispose: () => w.close() });
  } catch {}
}

function setupLimitWatch() {
  if (limitTimer) clearInterval(limitTimer);
  limitTimer = setInterval(() => checkLimitErrors().catch((e) => console.error("[swap-plus] limit watch", e)), LIMIT_SCAN_S * 1000);
}

// ---------------------------------------------------------------- linhas do motor (ritmo de atualização do uso)

/**
 * O motor atualiza o uso mais rápido (a cada minuto) quando a conta em uso chega a
 * 15 pontos da linha de troca, mas usa as linhas das configurações DELE. Aqui elas
 * são alinhadas às regras do Swap Plus.
 */
// Uma sincronização por vez; quem troca de modo pode esperar a que estiver em andamento (waitMotorSync).
let motorSyncP = null;
function syncMotorLines() {
  if (!motorSyncP) motorSyncP = syncMotorLinesNow().finally(() => { motorSyncP = null; });
  return motorSyncP;
}
function waitMotorSync() {
  return motorSyncP ? motorSyncP.catch(() => {}) : Promise.resolve();
}

async function syncMotorLinesNow() {
  if (!swapOn() || serverMode()) return false;
  const r = rules();
  const want = {
    "autoswitch.threshold": Math.min(99.9, r.sessionPct),
    "autoswitch.weeklyThreshold": Math.min(99.9, r.weeklyPct),
    "autoswitch.model": r.onModelLimit === "switchAccount" && r.preferModel ? r.preferModel : null,
  };
  const c = parseJson((await runCswap(["config", "--json"])).stdout);
  if (!c || !Array.isArray(c.settings)) return false;
  const cur = Object.fromEntries(c.settings.map((x) => [x.key, x]));
  for (const [k, v] of Object.entries(want)) {
    // O modo pode ter virado "servidor" (ou o Swap Plus desligado) no meio: nenhuma chamada ao motor depois disso.
    if (!swapOn() || serverMode()) return false;
    const now = cur[k] ? cur[k].value : undefined;
    if (v === null) {
      if (cur[k] && cur[k].isSet) await runCswap(["config", "unset", k]);
    } else if (Number(now) !== Number(v) && String(now) !== String(v)) {
      await runCswap(["config", "set", k, String(v)]);
    }
  }
  return true;
}

async function switchBest() {
  if (serverMode()) return serverSwitch(null); // o servidor escolhe a melhor conta
  await refresh();
  if (!state.list) return vscode.window.showErrorMessage(`Swap Plus: ${state.error}`);
  const d = decide({ list: state.list, records: state.records, r: rules(), modelIds: state.models.map((m) => m.id), now: Date.now(), force: true });
  if (d.action !== "switch") return vscode.window.showInformationMessage(`Swap Plus: ${d.text}.`);
  const res = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Trocando para a conta ${d.to}...`, cancellable: false },
    () => execSwitch(d)
  );
  if (res.ok) {
    await pushHistory([{ ts: new Date().toISOString(), kind: "manual", text: `Troca manual ${d.text}` }]);
    vscode.window.showInformationMessage(`Swap Plus: agora na conta ${d.to}.`);
  } else {
    vscode.window.showErrorMessage(`Falha ao trocar de conta: ${res.error}`);
  }
  postState();
}

// ---------------------------------------------------------------- lista de contas

/**
 * Textos de cada conta na lista: a sessão vai ao lado do nome (texto mais
 * claro) e semanal + modelos na linha de baixo. As três partes juntas não
 * cabem numa linha só da lista do VS Code (~570 px).
 */
function pickerTexts(acc, w, disabled) {
  if (!w) return { description: "", detail: `Uso indisponível (${statusLabel(acc.usageStatus)})` };
  const parts = [];
  if (loginDead(acc)) parts.push(`$(warning) login morto — ${statusLabel(acc.usageStatus)}`);
  if (w.weekly) parts.push(seg("Semanal", w.weekly));
  for (const m of w.models) parts.push(seg(m.name, m));
  if (disabled) parts.push("fora da troca automática");
  if (w.stale) parts.push("dados antigos");
  return { description: seg("Sessão (5h)", w.session), detail: parts.join("  ·  ") };
}

/**
 * Ordem de exibição: primeiro as contas que participam da troca automática, de
 * quem renova o semanal antes para quem renova depois; no fim, as que não
 * participam, na mesma ordem. Empate: menos uso semanal, depois o número.
 */
function orderForDisplay(accounts, records) {
  const key = (acc) => {
    const w = windows(acc);
    const t = w && w.weekly && w.weekly.resetsAt ? Date.parse(w.weekly.resetsAt) : NaN;
    return { off: recordOf(records, acc.number).disabled ? 1 : 0, reset: isNaN(t) ? Infinity : t, pct: w && w.weekly ? w.weekly.pct : 100 };
  };
  return [...accounts]
    .map((acc) => ({ acc, k: key(acc) }))
    .sort((a, b) => a.k.off - b.k.off || a.k.reset - b.k.reset || a.k.pct - b.k.pct || a.acc.number - b.acc.number)
    .map((x) => x.acc);
}

async function switchAccount() {
  if (!swapOn()) {
    const c = await vscode.window.showInformationMessage(
      "Swap Plus está desligado: o Claude Code está funcionando normalmente, sem troca de conta.",
      "Ligar Swap Plus",
      "Configurações"
    );
    if (c === "Ligar Swap Plus") return setEnabled(true);
    if (c === "Configurações") return openSettings();
    return;
  }
  await refresh();
  if (serverMode()) {
    const st = serverStatus();
    if (st === "disconnected" || st === "revoked") {
      const c = await vscode.window.showWarningMessage(`Swap Plus: ${serverErrorLine()}`, "Conectar ao servidor", "Usar o modo local", "Configurações");
      if (c === "Conectar ao servidor") return connectServer();
      if (c === "Usar o modo local") return setMode("local");
      if (c === "Configurações") return openSettings();
      return;
    }
    if (st !== "online") {
      const c = await vscode.window.showWarningMessage(`Swap Plus: ${serverErrorLine()} Enquanto isso não dá para trocar de conta.`, "Tentar de novo", "Configurações");
      if (c === "Tentar de novo") return refreshFresh();
      if (c === "Configurações") return openSettings();
      return;
    }
    if (srv.rejected) {
      const c = await vscode.window.showWarningMessage(
        `Swap Plus: o servidor recusou o login atual do Claude Code: ${srv.rejected.reason}.`,
        "Usar a conta do servidor",
        "Escolher conta",
        "Configurações"
      );
      if (c === "Usar a conta do servidor") return useServerAccount();
      if (c === "Configurações") return openSettings();
      if (c !== "Escolher conta") return;
    }
  }
  const list = state.list;
  if (!list || !list.accounts.length) {
    const choice = await vscode.window.showErrorMessage(
      list ? (serverMode() ? "Nenhuma conta no servidor ainda." : "Nenhuma conta Claude cadastrada ainda.") : `Swap Plus: ${state.error}`,
      "Configurações",
      "Adicionar conta"
    );
    if (choice === "Configurações") openSettings();
    else if (choice === "Adicionar conta") addAccount();
    return;
  }
  const items = orderForDisplay(list.accounts, state.records).map((acc) => {
    const active = acc.number === list.activeAccountNumber;
    return {
      label: `${active ? "$(check) " : ""}${displayName(acc)}`,
      ...pickerTexts(acc, windows(acc), accountRecord(acc.number).disabled),
      accountNum: acc.number,
    };
  });
  const menu = [
    ...(state.unmanaged
      ? [{ label: "$(add) Cadastrar a conta logada no Claude Code", description: privateMode() ? "conta nova" : state.unmanaged.email, accountNum: -3 }]
      : []),
    { label: "$(gear) Configurações...", description: "regras de aviso e de troca automática", accountNum: -2 },
    { label: "Contas", kind: vscode.QuickPickItemKind.Separator },
    ...items,
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    {
      label: "$(add) Adicionar conta...",
      description: serverMode() ? "entre com a conta no Claude Code; o login vai para o servidor" : "cadastra a conta logada agora no Claude Code",
      accountNum: -1,
    },
    { label: "$(debug-disconnect) Desligar o Swap Plus", description: "para de consultar e trocar contas; o Claude Code fica normal", accountNum: -4 },
  ];

  const picked = await vscode.window.showQuickPick(menu, { placeHolder: "Escolha a conta Claude ou abra as configurações" });
  if (!picked) return;
  if (picked.accountNum === -1 || picked.accountNum === -3) return addAccount();
  if (picked.accountNum === -2) return openSettings();
  if (picked.accountNum === -4) return setEnabled(false);
  if (picked.accountNum !== list.activeAccountNumber) await doSwitch(picked.accountNum);
}

async function doSwitch(num) {
  const target = state.list && state.list.accounts.find((a) => a.number === Number(num));
  if (loginDead(target)) {
    const c = await vscode.window.showWarningMessage(
      serverMode()
        ? `O login da conta ${num} não vale mais no servidor (${statusLabel(target.usageStatus)}). Se trocar, o Claude Code vai pedir login. Depois de entrar com ela no Claude Code, o Swap Plus envia o login novo ao servidor sozinho.`
        : `O login guardado da conta ${num} não vale mais (${statusLabel(target.usageStatus)}). Se trocar, o Claude Code vai pedir login. Depois de entrar com ela no Claude Code, o Swap Plus salva o login novo sozinho.`,
      { modal: true },
      "Trocar mesmo assim"
    );
    if (c !== "Trocar mesmo assim") return;
  }
  if (serverMode()) return serverSwitch(Number(num));
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Trocando para a conta ${num}...`, cancellable: false },
    () => runCswapWrite(["switch", String(num)], 120000)
  );
  if (r.code === 0) {
    vscode.window.showInformationMessage(`Swap Plus: agora na conta ${num}.`);
    await pushHistory([{ ts: new Date().toISOString(), kind: "manual", text: `Troca manual para a conta ${num}` }]);
  } else {
    vscode.window.showErrorMessage(`Falha ao trocar de conta: ${lastLine(r.stderr) || r.spawnError || "erro desconhecido"}`);
  }
  await refreshFresh();
}

// ---------------------------------------------------------------- exportar / importar

/**
 * Export Other: todas as contas, e o outro computador entra em modo privado ao
 * importar (mostra só "Conta N"). Export Me: igual, mas sem ligar o modo privado.
 * O arquivo leva as credenciais em texto puro; o outro lado importa com o
 * botão "Importar contas" (ou `swap-plus import`, que ignora a marca).
 */
const SERVER_NO_XPORT =
  "Swap Plus: no modo servidor as contas ficam no servidor. Para usá-las em outro computador, conecte esse computador ao mesmo servidor (Swap Plus: Conectar ao servidor).";

async function exportAccounts(mode) {
  if (serverMode()) {
    vscode.window.showInformationMessage(SERVER_NO_XPORT);
    return null;
  }
  const other = mode === "other";
  const name = other ? "Export Other" : "Export Me";
  if (!other && privateMode()) {
    vscode.window.showInformationMessage("Swap Plus: em modo privado só o Export Other fica disponível.");
    return null;
  }
  const def = path.join(os.homedir(), "Desktop", other ? "swap-plus-other.cswap" : "swap-plus-me.cswap");
  const uri = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(def),
    filters: { "Swap Plus": ["cswap"] },
    saveLabel: name,
    title: `${name}: onde salvar o arquivo com as contas`,
  });
  if (!uri) return null;
  const file = uri.fsPath;
  await refresh(); // ajustes por conta atualizados
  // Gera numa pasta temporária local e só no fim grava no destino: assim funciona
  // também quando o destino é uma pasta de rede (que o VS Code bloqueia no Windows).
  const tmpOut = path.join(os.tmpdir(), `swap-plus-export-${process.pid}-${Date.now()}.cswap`);
  let env = null;
  try {
    const r = await runCswap(["export", tmpOut], 120000);
    try {
      env = JSON.parse(fs.readFileSync(tmpOut, "utf8"));
    } catch {}
    if (r.code !== 0 || !env || !Array.isArray(env.accounts)) {
      vscode.window.showErrorMessage(`Swap Plus: falha no ${name}: ${lastLine(r.stderr) || r.spawnError || "arquivo não foi gerado"}`);
      return null;
    }
  } finally {
    try {
      fs.unlinkSync(tmpOut);
    } catch {}
  }
  env.swapPlus = {
    hideEmails: other,
    exportedAt: new Date().toISOString(),
    settings: collectSettings(),
    accounts: env.accounts.map((a) => {
      const rec = recordOf(state.records, a.number);
      return { email: a.email, organizationUuid: a.organizationUuid || "", disabled: !!rec.disabled, threshold: rec.threshold ?? null, priority: Number(rec.priority) || 0 };
    }),
  };
  if (!(await writeFileAny(file, JSON.stringify(env, null, 2) + "\n"))) {
    vscode.window.showErrorMessage(`Swap Plus: não consegui salvar o arquivo em “${file}”. Escolha uma pasta deste computador (por exemplo, a Área de Trabalho).`);
    return null;
  }
  const n = env.accounts.length;
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `${name}: ${n} contas exportadas` }]);
  postState();
  vscode.window
    .showInformationMessage(
      `Swap Plus: ${n} contas exportadas (${name}), com as regras de troca, os avisos e os ajustes de cada conta${other ? ". No outro computador vai aparecer só “Conta 1”, “Conta 2”…" : ""}. O arquivo tem as credenciais das contas: leve para o outro computador, importe e apague.`,
      "Mostrar a pasta"
    )
    .then((c) => c && vscode.commands.executeCommand("revealFileInOS", uri));
  return { file, n };
}

/** Configurações do Swap Plus que viajam no export (não vão: caminho do executável, modo privado e o servidor, que são de cada máquina). */
const NOT_EXPORTED = new Set(["swapPlus.executablePath", "swapPlus.privacy.hideEmails", "swapPlus.mode", "swapPlus.server.url"]);

function settingKeys() {
  const pkg = (extContext.extension && extContext.extension.packageJSON) || require("./package.json");
  const props = (pkg.contributes && pkg.contributes.configuration && pkg.contributes.configuration.properties) || {};
  return Object.keys(props).filter((k) => k.startsWith(`${NS}.`) && !NOT_EXPORTED.has(k));
}

function collectSettings() {
  const out = {};
  for (const k of settingKeys()) out[k] = cfg().get(k.slice(NS.length + 1));
  return out;
}

async function applySettings(settings) {
  if (!settings || typeof settings !== "object") return 0;
  const known = new Set(settingKeys());
  let n = 0;
  for (const [k, v] of Object.entries(settings)) {
    if (!known.has(k) || v === undefined) continue;
    const key = k.slice(NS.length + 1);
    if (JSON.stringify(cfg().get(key)) === JSON.stringify(v)) continue;
    await cfg().update(key, v, vscode.ConfigurationTarget.Global);
    n++;
  }
  return n;
}

/** Fora da rotação, linha própria e prioridade de cada conta, achando a conta pelo e-mail + organização. */
async function applyAccountPrefs(prefs) {
  if (!Array.isArray(prefs) || !prefs.length) return 0;
  const l = await runCswap(["list", "--json"]);
  const list = parseJson(l.stdout);
  if (!list || !Array.isArray(list.accounts)) return 0;
  const records = await readRecords();
  let n = 0;
  for (const p of prefs) {
    const acc = list.accounts.find((a) => a.email === p.email && (a.organizationUuid || "") === (p.organizationUuid || ""));
    if (!acc) continue;
    const num = String(acc.number);
    const rec = recordOf(records, acc.number);
    const cmds = [];
    if (!!p.disabled !== !!rec.disabled) cmds.push([p.disabled ? "disable" : "enable", num]);
    const th = p.threshold === null || p.threshold === undefined ? null : Number(p.threshold);
    const cur = rec.threshold === null || rec.threshold === undefined ? null : Number(rec.threshold);
    if (th !== cur) cmds.push(th === null ? ["threshold", num, "--unset"] : ["threshold", num, String(th)]);
    if ((Number(p.priority) || 0) !== (Number(rec.priority) || 0)) cmds.push(["priority", num, String(Number(p.priority) || 0)]);
    for (const c of cmds) await runCswapWrite(c);
    if (cmds.length) n++;
  }
  return n;
}

async function importAccounts() {
  if (serverMode()) {
    vscode.window.showInformationMessage(SERVER_NO_XPORT);
    return null;
  }
  const uris = await vscode.window.showOpenDialog({
    canSelectMany: false,
    canSelectFolders: false,
    filters: { "Swap Plus": ["cswap", "json"] },
    openLabel: "Importar",
    title: "Importar contas do Swap Plus",
  });
  if (!uris || !uris.length) return null;
  const picked = uris[0].fsPath;
  const temps = [];
  const tmpName = (tag) => path.join(os.tmpdir(), `swap-plus-import-${tag}-${process.pid}-${Date.now()}.cswap`);
  try {
    let source = picked;
    let read = readExportFile(picked);
    if (read.code === UNC_ERR) {
      // Pasta de rede: o VS Code não deixa a extensão ler, mas o Windows copia normalmente.
      const local = tmpName("rede");
      temps.push(local);
      if (await copyFileAny(picked, local)) {
        read = readExportFile(local);
        source = local;
      }
    }
    if (read.error) {
      vscode.window.showErrorMessage(`Swap Plus: não deu para importar “${path.basename(picked)}”: ${read.error}`);
      return null;
    }
    // Se o arquivo chegou com outra codificação, o motor recebe uma cópia limpa (UTF-8).
    let file = source;
    if (read.normalized) {
      file = tmpName("limpo");
      temps.push(file);
      fs.writeFileSync(file, read.text, { mode: 0o600 });
    }
    return await importEnvelope(read.env, file, picked);
  } finally {
    for (const t of temps) {
      try {
        fs.unlinkSync(t);
      } catch {}
    }
  }
}

// ---------------------------------------------------------------- arquivos (inclusive pasta de rede no Windows)

const UNC_ERR = "ERR_UNC_HOST_NOT_ALLOWED";
const IS_WIN = process.platform === "win32";

/** Roda um comando de arquivo no PowerShell, com os caminhos em variáveis de ambiente (sem problema de aspas). */
function shellFile(command, src, dst) {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      { env: { ...process.env, SWAP_PLUS_SRC: src || "", SWAP_PLUS_DST: dst || "" }, timeout: 60000, windowsHide: true },
      (err) => resolve(!err)
    );
  });
}

/** Copia um arquivo. No Windows, se o VS Code bloquear (pasta de rede), o próprio Windows copia. */
async function copyFileAny(src, dst) {
  try {
    fs.copyFileSync(src, dst);
    return true;
  } catch {
    if (!IS_WIN) return false;
    const ok = await shellFile("Copy-Item -LiteralPath $env:SWAP_PLUS_SRC -Destination $env:SWAP_PLUS_DST -Force", src, dst);
    return ok && fs.existsSync(dst);
  }
}

/** Grava o arquivo só com permissão para o seu usuário; pasta de rede no Windows via cópia local. */
async function writeFileAny(dst, content) {
  try {
    fs.writeFileSync(dst, content, { mode: 0o600 });
    try {
      fs.chmodSync(dst, 0o600);
    } catch {}
    return true;
  } catch {
    if (!IS_WIN) return false;
    const tmp = path.join(os.tmpdir(), `swap-plus-out-${process.pid}-${Date.now()}.cswap`);
    try {
      fs.writeFileSync(tmp, content, { mode: 0o600 });
      return await shellFile("Copy-Item -LiteralPath $env:SWAP_PLUS_SRC -Destination $env:SWAP_PLUS_DST -Force", tmp, dst);
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }
}

async function removeFileAny(p) {
  try {
    fs.unlinkSync(p);
    return true;
  } catch {
    if (!IS_WIN) return false;
    return shellFile("Remove-Item -LiteralPath $env:SWAP_PLUS_SRC -Force", p, "");
  }
}

/**
 * Lê um arquivo de export tolerando o que costuma acontecer na transferência
 * entre computadores: marca BOM do Windows, UTF-16, espaços nas pontas. Quando
 * não dá, diz exatamente o motivo (sem mostrar credenciais).
 */
function readExportFile(file) {
  let buf;
  try {
    buf = fs.readFileSync(file);
  } catch (e) {
    if (e.code === UNC_ERR) {
      return {
        code: UNC_ERR,
        error: "o arquivo está numa pasta de rede, que o VS Code não deixa extensões lerem. Copie o arquivo para uma pasta deste computador (por exemplo, a Área de Trabalho) e importe de lá.",
      };
    }
    return { code: e.code, error: `não consegui ler o arquivo (${e.code || e.message}).` };
  }
  if (!buf.length) {
    return { error: "o arquivo está vazio (0 bytes). Se ele está numa pasta do OneDrive, iCloud ou Google Drive, baixe-o para o computador ou copie para outra pasta e tente de novo." };
  }
  // Arquivo auxiliar que o macOS cria ao copiar para pen drive ou disco de Windows:
  // "._nome.cswap", com a mesma extensão do verdadeiro.
  if (path.basename(file).startsWith("._") || (buf.length >= 4 && buf.readUInt32BE(0) === 0x00051607)) {
    const real = path.basename(file).replace(/^\._/, "");
    return { error: `esse é um arquivo auxiliar que o Mac cria ao copiar para pen drive (começa com “._”). Escolha o arquivo “${real}”, sem o “._” no começo.` };
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    return { error: "o arquivo é um .zip. Descompacte e escolha o arquivo .cswap que está dentro." };
  }
  let text;
  let normalized = false;
  if (buf[0] === 0xff && buf[1] === 0xfe) {
    text = buf.subarray(2).toString("utf16le");
    normalized = true;
  } else if (buf[0] === 0xfe && buf[1] === 0xff) {
    const le = Buffer.from(buf.subarray(2));
    le.swap16();
    text = le.toString("utf16le");
    normalized = true;
  } else if (buf.length > 3 && buf[1] === 0 && buf[3] === 0) {
    text = buf.toString("utf16le");
    normalized = true;
  } else {
    text = buf.toString("utf8");
  }
  if (text.charCodeAt(0) === 0xfeff) {
    text = text.slice(1);
    normalized = true;
  }
  // Espaços e quebras de linha nas pontas não atrapalham (nem aqui nem no motor).
  let env;
  try {
    env = JSON.parse(text);
  } catch (e) {
    if (/[“”]/.test(text.slice(0, 400))) {
      return { error: "o conteúdo foi alterado no caminho (as aspas viraram aspas curvas). Transfira o próprio arquivo, sem copiar e colar o texto." };
    }
    const start = text.slice(0, 24).replace(/\s+/g, " ");
    return { error: `o conteúdo não é um export do Swap Plus (${buf.length} bytes, começa com “${start}”). Gere o arquivo de novo no computador principal (Configurações → Export Other ou Export Me).` };
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) return { error: "o conteúdo não é um export do Swap Plus." };
  if (env.encrypted === true) return { error: "o arquivo está criptografado; o Swap Plus importa só exports sem criptografia." };
  if (!Array.isArray(env.accounts)) {
    return { error: "o arquivo não tem a lista de contas. Ele parece ser outro tipo de arquivo; gere o export de novo no computador principal." };
  }
  if (!env.accounts.length) return { error: "o arquivo não tem nenhuma conta." };
  if (env.version !== 1) return { error: `o arquivo é de um formato que esta versão não conhece (versão ${env.version}).` };
  return { env, text, normalized };
}

async function importEnvelope(env, file, picked) {
  const hide = !!(env.swapPlus && env.swapPlus.hideEmails);
  // Liga o modo privado antes, para nenhuma mensagem do import mostrar e-mail.
  if (hide) await cfg().update("privacy.hideEmails", true, vscode.ConfigurationTarget.Global);
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Importando contas...", cancellable: false },
    () => runCswapWrite(["import", file], 180000)
  );
  await refresh();
  if (r.code !== 0) {
    vscode.window.showErrorMessage(`Swap Plus: falha ao importar: ${lastLine(r.stderr) || r.spawnError || "erro desconhecido"}`);
    return { ok: false, hide };
  }
  const n = env.accounts.length;
  const sp = env.swapPlus || {};
  if (sp.hideEmails === false) await cfg().update("privacy.hideEmails", false, vscode.ConfigurationTarget.Global);
  const nSettings = await applySettings(sp.settings);
  const nAccounts = await applyAccountPrefs(sp.accounts);
  await refresh();
  const carried = nSettings || nAccounts ? ", com as regras de troca, os avisos e os ajustes de cada conta" : "";
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Importadas ${n} contas${carried ? " e configurações" : ""}${hide ? " (modo privado)" : ""}` }]);
  postState();
  vscode.window
    .showInformationMessage(
      `Swap Plus: ${n} contas importadas${carried}${hide ? ". Modo privado ligado: aqui aparece só “Conta N”." : "."} Apague o arquivo agora que ele não é mais necessário.`,
      "Apagar o arquivo"
    )
    .then((c) => {
      if (c) {
        removeFileAny(picked).then((ok) => {
          if (!ok) vscode.window.showWarningMessage(`Swap Plus: não consegui apagar “${picked}”. Apague à mão.`);
        });
      }
    });
  return { ok: true, hide, n };
}

async function cliVersion() {
  if (serverMode()) return null; // modo servidor: o motor não é usado, nem consultado pelo atualizador
  const r = await runCswap(["--version"], 20000);
  const m = `${r.stdout} ${r.stderr}`.match(/(\d+\.\d+\.\d+\S*)/);
  return r.code === 0 && m ? m[1] : null;
}

/**
 * Cadastra no Swap Plus a conta que está logada agora no Claude Code (é o que o
 * `swap-plus add` faz; sem número de posição ele não faz perguntas).
 */
async function addAccount() {
  if (serverMode()) {
    // Não há "cadastrar" no modo servidor: o login novo do Claude Code vai para o servidor sozinho.
    vscode.window.showInformationMessage(
      "Swap Plus (modo servidor): para adicionar uma conta, entre com ela no Claude Code (comando /login), sem sair da anterior. Em até 30 s o Swap Plus envia o login ao servidor, que passa a cuidar dela. Para levar todas as contas guardadas neste computador de uma vez: Configurações → Servidor → Enviar os logins deste computador."
    );
    return { ok: false, server: true };
  }
  const before = state.list ? state.list.accounts.map((a) => a.number) : [];
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Swap Plus: cadastrando a conta logada no Claude Code...", cancellable: false },
    () => runCswapWrite(["add"], 120000)
  );
  await refreshFresh();
  if (r.code !== 0) {
    const err = lastLine(r.stderr) || lastLine(r.stdout) || r.spawnError || "erro desconhecido";
    const noLogin = /log in first|No active Claude account|No credentials/i.test(`${r.stderr} ${r.stdout}`);
    vscode.window.showErrorMessage(
      noLogin
        ? "Swap Plus: não há conta logada no Claude Code. Entre com a conta nova no Claude Code (sem fazer logout da anterior) e clique em Adicionar conta de novo."
        : `Swap Plus: não consegui cadastrar a conta: ${err}`
    );
    return { ok: false };
  }
  const list = state.list;
  const acc = list && list.accounts.find((a) => a.number === list.activeAccountNumber);
  const isNew = acc && !before.includes(acc.number);
  const text = acc ? `${isNew ? "Conta nova cadastrada" : "Conta atualizada"}: ${displayName(acc)}, em uso agora` : "Conta cadastrada";
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: safe(text) }]);
  postState();
  vscode.window.showInformationMessage(`Swap Plus: ${safe(text)}.${autoEnabled() ? " Ela já participa da troca automática." : ""}`);
  return { ok: true, number: acc ? acc.number : null };
}

let registerOffered = null;
/** Pergunta uma vez por conta se é para cadastrar a conta logada que o Swap Plus não conhece. */
function offerRegister(u) {
  if (registerOffered === u.email) return;
  registerOffered = u.email;
  vscode.window
    .showWarningMessage(
      `Swap Plus: o Claude Code está logado em ${privateMode() ? "uma conta" : u.email} que ainda não está cadastrada. Sem isso, o Swap Plus não acompanha o uso nem troca de conta.`,
      "Cadastrar agora"
    )
    .then((c) => c && addAccount());
}

async function setEnabled(on) {
  const write = () => cfg().update("enabled", !!on, vscode.ConfigurationTarget.Global);
  // Modo servidor: desligar espera o ciclo em andamento (batimento, troca, gravação) terminar.
  if (!on && serverMode()) await holdServer(write);
  else await write();
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: on ? "Swap Plus ligado" : "Swap Plus desligado" }]);
  vscode.window.showInformationMessage(
    on
      ? serverMode()
        ? "Swap Plus ligado. Ele volta a falar com o servidor e a receber a conta escolhida para este computador."
        : "Swap Plus ligado. Ele volta a acompanhar as contas e salva o login atual do Claude Code."
      : serverMode()
        ? "Swap Plus desligado. Sem contato com o servidor e sem mexer no login: o Claude Code fica com o acesso que tem agora."
        : "Swap Plus desligado. O Claude Code fica normal: sem consultas, sem troca de conta, sem mexer no login."
  );
}

async function toggleEnabled() {
  return setEnabled(!swapOn());
}

async function toggleAuto() {
  if (serverMode()) {
    // A chave que vale é a do servidor (autoEnabled() diz false com o Swap Plus desligado).
    if (!swapOn()) {
      vscode.window.showInformationMessage("Swap Plus está desligado: ligue-o para mudar a troca automática do servidor.");
      return;
    }
    if (!srv.state) {
      vscode.window.showWarningMessage(`Swap Plus: ainda sem resposta do servidor; tente de novo em instantes.${serverErrorLine() ? ` (${serverErrorLine()})` : ""}`);
      return;
    }
    return setServerAuto(!srv.state.autoSwitch);
  }
  const next = !autoEnabled();
  await cfg().update("autoSwitch.enabled", next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Swap Plus: troca automática ${next ? "ligada" : "desligada"}.`);
}

// ---------------------------------------------------------------- modo servidor
//
// O refresh token de cada conta é de uso único: quem renova primeiro invalida a
// cópia dos outros. No modo servidor só o servidor guarda o refresh token e
// renova; ele também decide as trocas (mesma regra do rules.js) para todos os
// computadores. Este computador:
//   - a cada 30 s manda um batimento (modelos em uso + conta e validade do login
//     atual) e recebe o estado (contas, uso, regras, histórico, dispositivos).
//     Com várias janelas do VS Code abertas, só uma (a "dona", por trava em
//     arquivo) faz o batimento, envia login novo e grava; as outras só leem o
//     estado (GET /v1/state);
//   - quando a conta escolhida para ele muda, ou o acesso dela é renovado, grava
//     no Claude Code só o acesso (access token) — nunca o refresh token — e nunca
//     por cima de um login novo que ainda não foi para o servidor (o writeLive
//     confere sob a trava do Claude Code: compare-and-swap);
//   - quando o Claude Code ganha um login novo (entrar pelo navegador traz um
//     refresh token), envia esse login ao servidor e grava por cima o acesso que
//     o servidor devolve. Se não der para gravar, tira só o refresh token do
//     login enviado (o Claude Code não o renova e não mata a cópia do servidor);
//   - o token deste computador só vai para o endereço em que foi emitido (o
//     guardado na conexão). Endereço novo nas configurações = conectar de novo;
//   - enquanto o modo servidor está ligado, a tela de login do Claude Code fica
//     desligada (claudeCode.disableLoginPrompt): quem faz o login é o Swap Plus.
//     Ao sair do modo servidor (ou desconectar) a configuração volta como estava.
// Aqui o motor local (swap-plus) não é chamado — só no envio dos logins deste
// computador (list + export) — e a decisão local (decide) não roda.
// Tokens nunca vão para log nem para mensagens.

const SERVER_TOKEN_KEY = "swapPlus.server.token"; // em context.secrets
const SERVER_META_KEY = "swapPlus.server"; // globalState: { url, fp, deviceId, name, via, connectedAt, revokedAt } — url = onde o token foi emitido
const SERVER_APPLIED_KEY = "swapPlus.server.applied"; // globalState: { number, gen, expiresAt, at, noIdentity } — última credencial gravada
const SERVER_MIGRATED_KEY = "swapPlus.server.migrated"; // globalState: { "<url>": ms } — logins deste computador já enviados
const SERVER_SENT_KEY = "swapPlus.server.sentLogin"; // globalState: [hash] — logins com refresh token já resolvidos (enviados, mortos ou gastos); nunca o token
const SERVER_RULES_OFFERED_KEY = "swapPlus.server.rulesOffered"; // globalState: { "<origem>": ms } — oferta de levar as regras daqui já feita
const LOGIN_PROMPT_KEY = "swapPlus.server.loginPrompt"; // globalState: { applied, had, value, noticed } — claudeCode.disableLoginPrompt de antes do modo servidor
const HEARTBEAT_MS = 30 * 1000;
const DEVICE_ACTIVE_MS = 5 * 60 * 1000;
const LOGIN_POST_TIMEOUT_MS = 90 * 1000; // POST /v1/logins: o servidor renova o login na hora (fala com a Anthropic)
const LOGIN_RETRY_MS = 60 * 1000; // refresh_failed / profile_unavailable: tenta de novo em ~1 min, sem aviso
const APPLY_RETRY_MS = 60 * 1000; // gravação que falhou: tenta de novo em 1 min
const OWNER_STALE_MS = 25 * 1000; // dona que não renova a trava por mais que isso: outra janela assume
const OWNER_TOUCH_MS = 10 * 1000; // a dona renova a trava a cada 10 s (e a cada ciclo)
const UPLOAD_LOCK_STALE_MS = 2 * LOGIN_POST_TIMEOUT_MS; // trava de envio esquecida (janela fechada no meio)
const SPENT_MAX = 50;
const WINDOW_ID = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
// Aviso do claudeAuth.credentialStoreWarnings() quando o Claude Code (Windows) lê o login do Gerenciador de
// Credenciais: o que o Swap Plus grava no .credentials.json seria ignorado. Nesse caso não grava.
const CREDMAN_RE = /Gerenciador de Credenciais do Windows/;
const NO_ACCOUNT_TEXT = "o servidor ainda não tem conta para este computador";
const LOGIN_PROMPT_NOTE = "Enquanto estiver no modo servidor, o login do Claude Code é feito pelo Swap Plus";

function serverMode() {
  return cfg().get("mode") === "server";
}

function serverMeta() {
  return (extContext && extContext.globalState.get(SERVER_META_KEY)) || {};
}

async function setServerMeta(patch) {
  await extContext.globalState.update(SERVER_META_KEY, { ...serverMeta(), ...patch });
}

const DEFAULT_SERVER_URL = "https://swap.assistentes.si"; // mesmo padrão de swapPlus.server.url no package.json

/**
 * Endereço posto nas configurações DO USUÁRIO, ou "". Não conta o padrão do
 * package.json nem o de um projeto aberto (swapPlus.server.url é "machine": um
 * settings.json de projeto não escolhe para onde vai o token deste computador).
 */
function configuredServerUrl() {
  let i = null;
  try {
    i = cfg().inspect("server.url");
  } catch {}
  return i && typeof i.globalValue === "string" ? i.globalValue.trim() : "";
}

function defaultServerUrl() {
  let d = null;
  try {
    d = cfg().inspect("server.url").defaultValue;
  } catch {}
  return String(d || DEFAULT_SERVER_URL).trim();
}

/** Origem ("https://host[:porta]") de um endereço, ou "". (Sem carregar o serverClient: vale também no modo local.) */
function urlOrigin(u) {
  try {
    const x = new URL(String(u || "").trim());
    return x.protocol === "https:" || x.protocol === "http:" ? x.origin : "";
  } catch {
    return "";
  }
}

/**
 * Endereço do servidor. Conectado: SEMPRE o da conexão (é o servidor que emitiu
 * o token deste computador). Sem conexão: o das configurações do usuário, senão o
 * padrão (usado por “Entrar com Google”).
 */
function serverUrl() {
  const u = serverMeta().url || configuredServerUrl() || defaultServerUrl();
  return String(u).replace(/\/+$/, "");
}

/** Endereço para conectar (“Entrar com Google”): o das configurações do usuário; senão o da conexão; senão o padrão. */
function connectUrl() {
  return String(configuredServerUrl() || serverMeta().url || defaultServerUrl()).replace(/\/+$/, "");
}

/** Conectado, mas o endereço das configurações do usuário aponta para outro servidor: o token não vai para lá. */
function serverAddressMoved() {
  const meta = serverMeta();
  if (!srv.token || !meta.url) return false;
  const conf = configuredServerUrl();
  return !!conf && urlOrigin(conf) !== urlOrigin(meta.url);
}

/** Tem token, mas não dá para usá-lo: o endereço mudou (ou não se sabe onde ele foi emitido). */
function serverAddressChanged() {
  return !!srv.token && (!serverMeta().url || serverAddressMoved() || srv.originMismatch);
}

function serverHost(url = serverUrl()) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

// Carregados só quando o modo servidor é usado: o modo local não depende deles.
function claudeAuth() {
  return require("./claudeAuth");
}
function serverLib() {
  return require("./serverClient");
}

const cap = (s) => {
  const t = String(s || "");
  return t.charAt(0).toUpperCase() + t.slice(1);
};

/** Horário do servidor (ms ou texto ISO) em ms. */
const tsMs = (v) => (typeof v === "number" ? v : Date.parse(v));

/** Texto de erro sem nada que pareça token (sequências longas viram “…”) e sem e-mail no modo privado. */
function safeErr(e) {
  const raw = e && e.message ? e.message : String(e || "erro desconhecido");
  return safe(raw.replace(/[A-Za-z0-9_\-.+/=]{32,}/g, "…").slice(0, 240));
}

const hashKey = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

let localTagMemo = null;
/** Marca das travas entre janelas: mesmo usuário e mesma pasta do Claude Code (janelas que mexem no mesmo login). */
function localTag() {
  if (localTagMemo) return localTagMemo;
  let uid = "";
  try {
    uid = String(os.userInfo().uid);
  } catch {}
  localTagMemo = hashKey(`${uid}|${path.resolve(claudeConfigDir())}`).slice(0, 12);
  return localTagMemo;
}
const ownerFile = () => path.join(os.tmpdir(), `swap-plus-owner-${localTag()}.json`);
const ownerLockDir = () => path.join(os.tmpdir(), `swap-plus-owner-${localTag()}.lock`);
const spentFile = () => path.join(os.tmpdir(), `swap-plus-spent-${localTag()}.json`);
const uploadLockDir = (key) => path.join(os.tmpdir(), `swap-plus-upload-${hashKey(`lock|${localTag()}|${key}`).slice(0, 24)}.lock`);

/** Grava JSON atômico (temporário ao lado + rename), só para o seu usuário. false se não deu. */
function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    return false;
  }
}

function readJsonFile(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8"));
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
}

function defaultDeviceName() {
  const h = String(os.hostname() || "").replace(/\.local$/i, "").trim();
  return h || (process.platform === "darwin" ? "Mac" : process.platform === "win32" ? "Windows" : "Linux");
}

/** O motor local tem contas guardadas? (só lê o sequence.json; não chama o motor) */
function localEngineHasAccounts() {
  try {
    const seq = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".claude-swap-backup", "sequence.json"), "utf8"));
    return Object.keys(seq.accounts || {}).length > 0;
  } catch {
    return false;
  }
}

async function serverToken() {
  if (srv.token !== undefined) return srv.token;
  let t = null;
  try {
    if (extContext && extContext.secrets) t = (await extContext.secrets.get(SERVER_TOKEN_KEY)) || null;
  } catch {
    t = null;
  }
  srv.token = t;
  return t;
}

function resetServerConnection() {
  srv.token = undefined;
  srv.client = null;
  srv.clientKey = "";
  srv.status = null;
  srv.originMismatch = false;
  srv.revokedWarned = false;
}

/** createServerClient com o token; origin_mismatch (o token não vale neste endereço) → null, sem nenhum envio. */
function makeServerClient(opts) {
  try {
    const c = serverLib().createServerClient(opts);
    srv.originMismatch = false;
    return c;
  } catch (e) {
    if (e && e.code === "origin_mismatch") {
      srv.originMismatch = true;
      return null;
    }
    throw e;
  }
}

/**
 * Cliente do servidor, ou null se este computador não está conectado — ou se o
 * endereço mudou (o token só vai para o servidor que o emitiu: tokenOrigin).
 * timeoutMs: cliente à parte (sem cache) para pedidos longos (POST /v1/logins).
 */
async function serverClient({ timeoutMs } = {}) {
  const token = await serverToken();
  const meta = serverMeta();
  if (!token || !meta.url) return null; // sem o endereço em que o token foi emitido: desconectado
  if (serverAddressMoved()) return null;
  const url = serverUrl();
  const fp = meta.fp || null;
  const opts = { url, token, fp, tokenOrigin: meta.url };
  if (timeoutMs) return makeServerClient({ ...opts, timeoutMs });
  const key = `${url}|${fp || ""}|${urlOrigin(meta.url)}`;
  if (!srv.client || srv.clientKey !== key) {
    srv.client = null;
    srv.clientKey = "";
    const c = makeServerClient(opts);
    if (!c) return null;
    srv.client = c;
    srv.clientKey = key;
  }
  return srv.client;
}

/**
 * Cliente para o servidor que EMITIU o token (o endereço da conexão), mesmo que o
 * das configurações tenha mudado. Só para revogar este computador lá.
 */
async function issuerClient() {
  const token = await serverToken();
  const meta = serverMeta();
  if (!token || !meta.url) return null;
  try {
    return serverLib().createServerClient({ url: meta.url, token, fp: meta.fp || null, tokenOrigin: meta.url });
  } catch {
    return null;
  }
}

/** "revoked" (401) | "forbidden" (403) | "throttled" (429) | "rejected" (outro 4xx: o pedido foi recusado) | "offline" (rede, tempo, 5xx) */
function srvErrKind(e) {
  const st = Number(e && e.status);
  if (st === 401) return "revoked";
  if (st === 403) return "forbidden";
  if (st === 429) return "throttled";
  if (st >= 400 && st < 500) return "rejected";
  return "offline";
}

function srvErrText(e) {
  switch (srvErrKind(e)) {
    case "revoked":
      return "o servidor recusou o acesso deste computador (revogado ou desconectado)";
    case "forbidden":
      return "o servidor não aceita conexões deste endereço de internet";
    case "throttled":
      return "muitas tentativas seguidas; o servidor pediu para esperar alguns minutos";
    case "rejected":
      return safeErr(e);
    default:
      if (e && e.code === "fingerprint_mismatch") {
        return "o certificado do servidor não é o esperado (a impressão digital mudou). Se o servidor foi reinstalado, conecte de novo com um código novo";
      }
      // Erros de rede/tempo/TLS já vêm com a mensagem em português do serverClient.
      return safeErr(e).replace(/\.+$/, "");
  }
}

/** "local" | "off" | "disconnected" | "revoked" | "connecting" | "online" | "offline" */
function serverStatus() {
  if (!serverMode()) return "local";
  if (!swapOn()) return "off";
  if (srv.token === undefined) return "connecting";
  if (!srv.token || serverAddressChanged()) return "disconnected";
  if (serverMeta().revokedAt) return "revoked";
  return srv.status || "connecting";
}

function lastContactText() {
  return srv.lastOkAt ? fmtWhen(srv.lastOkAt) : null;
}

/** "desconectado: o endereço mudou…" (frase sem maiúscula no começo). */
function addressChangedText() {
  const meta = serverMeta();
  if (!meta.url) return "desconectado: não sei em que servidor este computador foi conectado (o endereço mudou ou se perdeu). Conecte de novo.";
  const conf = configuredServerUrl();
  const detail = conf && urlOrigin(conf) !== urlOrigin(meta.url) ? ` (nas configurações: ${serverHost(conf)}; este computador foi conectado a ${serverHost(meta.url)})` : "";
  return `desconectado: o endereço do servidor mudou${detail}. Conecte de novo; o acesso deste computador não é enviado a outro endereço.`;
}

/** Problema de conexão em uma frase (sem maiúscula no começo), ou null se está tudo certo. */
function serverErrorLine() {
  const st = serverStatus();
  const last = lastContactText();
  if (st === "disconnected") {
    if (serverAddressChanged()) return addressChangedText();
    return "este computador ainda não está conectado ao servidor. Use “Conectar ao servidor” (paleta de comandos ou Configurações → Servidor).";
  }
  if (st === "revoked") return "o servidor recusou o acesso deste computador (foi revogado ou desconectado). Conecte de novo: entre com Google ou cole um código novo.";
  if (st === "offline") return `servidor fora do ar${last ? ` (último contato: ${last})` : ""} — ${srv.lastError || "sem resposta"}. O login do Claude Code não é mexido enquanto isso.`;
  if (st === "connecting") return "conectando ao servidor…";
  return null;
}

function serverStatusText(st) {
  const host = serverHost();
  switch (st) {
    case "local":
      return srv.token ? `os logins ficam neste computador (motor swap-plus). Continua conectado a ${host}: dá para voltar ao modo servidor quando quiser.` : "os logins ficam neste computador (motor swap-plus).";
    case "off":
      return "Swap Plus desligado: sem contato com o servidor e sem mexer no login.";
    case "disconnected":
      return serverAddressChanged() ? addressChangedText() : "modo servidor ligado, mas este computador ainda não foi conectado.";
    case "connecting":
      return `falando com ${host}…`;
    case "online":
      return `conectado a ${host}. O servidor guarda os logins, renova e escolhe a conta deste computador.`;
    case "offline":
      return `${srv.lastError || "sem resposta"}. Enquanto isso o login do Claude Code não é mexido.`;
    case "revoked":
      return "o servidor recusou este computador (acesso revogado). Conecte de novo: entre com Google ou cole um código novo.";
    default:
      return "";
  }
}

/** Avisos do claudeAuth sobre onde o Claude Code lê o login (relidos a cada ciclo; nunca lança). */
function refreshStoreWarnings() {
  try {
    const w = claudeAuth().credentialStoreWarnings();
    srv.storeWarnings = Array.isArray(w) ? w.map(String) : [];
  } catch {
    srv.storeWarnings = [];
  }
  return srv.storeWarnings;
}

/** Motivo para NÃO gravar o login (Windows lendo do Gerenciador de Credenciais), ou null. */
function storeBlockReason(list = srv.storeWarnings) {
  return (list || []).some((x) => CREDMAN_RE.test(String(x)))
    ? "o Claude Code está lendo o login do Gerenciador de Credenciais do Windows e o Swap Plus grava no arquivo .credentials.json: a troca não teria efeito, então nada é gravado"
    : null;
}

/** Barra de status no modo servidor quando não dá para mostrar o uso (sem conexão, fora do ar…). true = já desenhou. */
function renderServerProblem() {
  const st = serverStatus();
  const last = lastContactText();
  let text = null;
  let tip = null;
  let bg = null;
  if (st === "disconnected" && serverAddressChanged()) {
    text = "$(mail) $(warning)  servidor: o endereço mudou — clique para conectar de novo";
    tip = `${cap(addressChangedText())}\n\nO login do Claude Code não foi mexido.`;
    bg = "statusBarItem.warningBackground";
  } else if (st === "disconnected") {
    text = "$(mail) $(cloud)  servidor não conectado — clique para conectar";
    tip = "O Swap Plus está no modo servidor, mas este computador ainda não foi conectado. Clique e escolha “Conectar ao servidor”: entre com a sua conta Google (liberada pelo dono do servidor) ou cole o código de conexão gerado no servidor.";
    bg = "statusBarItem.warningBackground";
  } else if (st === "revoked") {
    text = "$(mail) $(warning)  servidor recusou este computador — clique para conectar";
    tip = "O acesso deste computador ao servidor foi revogado (ou ele foi desconectado). O login do Claude Code não foi mexido. Conecte de novo: entre com Google ou cole um código novo.";
    bg = "statusBarItem.errorBackground";
  } else if (st === "offline") {
    text = `$(mail) $(warning)  servidor fora do ar${last ? ` · último contato ${last}` : ""}`;
    tip = `Não consegui falar com o servidor (${serverHost()}): ${srv.lastError || "sem resposta"}.\n\nEnquanto isso o Swap Plus não mexe no login: o Claude Code continua com o acesso que tem. Tento de novo a cada 30 s.`;
    bg = "statusBarItem.warningBackground";
  } else if (st === "connecting" && !srv.state) {
    text = "$(mail) $(sync~spin)  conectando ao servidor…";
    tip = `Falando com o servidor ${serverHost()}…`;
  } else if (st === "online" && storeBlockReason()) {
    text = "$(mail) $(warning)  o Swap Plus não consegue trocar o login aqui — clique";
    tip = `${srv.storeWarnings.map(safe).join("\n\n")}\n\nEnquanto isso o Swap Plus não grava nada no login do Claude Code.`;
    bg = "statusBarItem.warningBackground";
  } else if (st === "online" && srv.rejected) {
    text = "$(mail) $(warning)  login do Claude Code recusado pelo servidor — clique";
    tip = `O servidor recusou o login atual do Claude Code: ${srv.rejected.reason}.\n\nEsse login fica como está (o Swap Plus não grava nada por cima). Clique para usar a conta escolhida pelo servidor.`;
    bg = "statusBarItem.warningBackground";
  }
  if (!text) return false;
  mainItem.text = frame(text);
  mainItem.tooltip = tip;
  if (bg) mainItem.backgroundColor = new vscode.ThemeColor(bg);
  mainItem.show();
  return true;
}

function finishSync() {
  render();
  postState();
}

/**
 * Guarda o estado recebido do servidor; barra, lista e tela passam a usar
 * list/records/rules/history dele. Só no modo servidor: no modo local a lista
 * da tela é sempre a do motor deste computador.
 */
function applyStateResponse(resp) {
  if (!serverMode()) return false;
  if (!resp || !resp.list || !Array.isArray(resp.list.accounts)) return false;
  srv.state = resp;
  srv.status = "online";
  srv.lastOkAt = Date.now();
  srv.lastError = null;
  state = { ...state, list: resp.list, records: resp.records || {}, error: null, fetchedAt: Date.now(), unmanaged: null };
  return true;
}

async function serverFailed(e, where) {
  const kind = srvErrKind(e);
  srv.lastError = srvErrText(e);
  console.error(`[swap-plus] servidor (${where})`, srv.lastError);
  if (kind === "revoked") {
    // Para de chamar o servidor com este token: cada recusa conta no limite de tentativas do endereço.
    srv.status = "revoked";
    await setServerMeta({ revokedAt: Date.now() });
    if (!srv.revokedWarned) {
      srv.revokedWarned = true;
      vscode.window
        .showWarningMessage("Swap Plus: o servidor recusou o acesso deste computador (revogado ou desconectado). O login do Claude Code não foi mexido.", "Conectar ao servidor")
        .then((c) => c && connectServer());
    }
  } else {
    srv.status = "offline";
  }
  state = { ...state, error: cap(serverErrorLine()), fetchedAt: Date.now() };
  finishSync();
}

function warnDisconnectedOnce() {
  if (srv.disconnectedWarned || srv.hold || connecting) return;
  srv.disconnectedWarned = true;
  const text = serverAddressChanged()
    ? `Swap Plus: ${addressChangedText()}`
    : "Swap Plus: o modo servidor está ligado, mas este computador ainda não foi conectado ao servidor.";
  vscode.window.showWarningMessage(text, "Conectar ao servidor", "Usar o modo local").then((c) => {
    if (c === "Conectar ao servidor") connectServer();
    else if (c === "Usar o modo local") setMode("local");
  });
}

function onServerModeChanged() {
  srv.state = null;
  srv.status = null;
  srv.rejected = null;
  srv.client = null;
  srv.clientKey = "";
  srv.originMismatch = false;
  srv.owner = null;
  srv.disconnectedWarned = false;
  state = { ...state, list: null, records: {}, error: null, unmanaged: null };
  if (!serverMode() || !swapOn()) releaseOwner();
  if (serverMode()) {
    serverToken()
      .then((t) => {
        if ((!t || serverAddressChanged()) && serverMode()) warnDisconnectedOnce();
      })
      .catch(() => {});
  }
}

// ---- fila única do modo servidor
//
// Ciclo (batimento + gravação), troca manual, limite batido e "usar a conta do
// servidor" rodam um de cada vez: dois gravando ao mesmo tempo poderiam deixar no
// Claude Code o acesso mais velho, ou gravar por cima de um login que o outro
// acabou de enviar.
let srvChain = Promise.resolve();
function srvQueue(fn) {
  const p = srvChain.then(fn, fn);
  srvChain = p.catch(() => {});
  return p;
}

/** Segura o ciclo do modo servidor e espera o que estiver em andamento (ciclo, troca, gravação) antes de fn. */
async function holdServer(fn) {
  const prev = srv.hold;
  srv.hold = true;
  try {
    if (refreshing) await refreshing.catch(() => {});
    await srvChain;
    return await fn();
  } finally {
    srv.hold = prev;
  }
}

// ---- janela "dona" (várias janelas do VS Code no mesmo computador)
//
// Só a dona faz o batimento, envia login novo e grava o login do Claude Code; as
// outras só leem o estado. A trava é um arquivo { id, at } no temporário, mexido
// sob um diretório-trava (mkdir é atômico); a dona renova a cada 10 s e a cada
// ciclo. Sem renovação por 25 s, outra janela assume no próximo ciclo. Uma ação
// da pessoa (troca, limite, usar a conta do servidor) faz a janela dela assumir.
let ownerTimer = null;

function readOwner() {
  return readJsonFile(ownerFile());
}

/** Roda fn sob a trava da dona. null = trava ocupada agora. */
function withOwnerLock(fn) {
  const lock = ownerLockDir();
  let made = false;
  try {
    fs.mkdirSync(lock, { mode: 0o700 });
    made = true;
  } catch (e) {
    if (e.code !== "EEXIST") return fn(); // sem como travar (ex.: sem permissão no temporário): segue sem a trava
    try {
      // Trava esquecida (janela fechada no meio): toma.
      if (Date.now() - fs.statSync(lock).mtimeMs > 5000) {
        fs.rmdirSync(lock);
        fs.mkdirSync(lock, { mode: 0o700 });
        made = true;
      }
    } catch {}
    if (!made) return null;
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(lock);
    } catch {}
  }
}

/** Esta janela é (ou passa a ser) a dona? take = assumir mesmo com outra dona viva (a pessoa agiu nesta janela). */
function claimOwner(take = false) {
  const r = withOwnerLock(() => {
    const now = Date.now();
    const cur = readOwner();
    const mine = !!cur && cur.id === WINDOW_ID;
    const alive = !!cur && now - Number(cur.at || 0) < OWNER_STALE_MS;
    if (!mine && alive && !take) return false;
    writeJsonAtomic(ownerFile(), { id: WINDOW_ID, at: now });
    return true;
  });
  if (r === null) {
    const cur = readOwner();
    return !!cur && cur.id === WINDOW_ID;
  }
  srv.owner = r;
  return r;
}

function isOwnerNow() {
  const cur = readOwner();
  return !!cur && cur.id === WINDOW_ID;
}

/** Larga a posição de dona (saiu do modo servidor, desligou ou a janela fechou): outra janela assume logo. */
function releaseOwner() {
  try {
    withOwnerLock(() => {
      if (isOwnerNow()) fs.unlinkSync(ownerFile());
      return true;
    });
  } catch {}
  srv.owner = null;
}

function setupOwnerTimer() {
  if (ownerTimer) clearInterval(ownerTimer);
  ownerTimer = setInterval(() => {
    try {
      if (serverMode() && swapOn() && srv.token && isOwnerNow()) claimOwner(false);
    } catch {}
  }, OWNER_TOUCH_MS);
  if (ownerTimer.unref) ownerTimer.unref();
}

// ---- login atual do Claude Code

/**
 * Login atual do Claude Code: { oauth, who, unreadable }.
 * oauth = claudeAiOauth | null (null = NÃO HÁ login); unreadable = motivo quando NÃO
 * deu para ler (Keychain trancado, JSON quebrado...). Nesse caso nada é enviado nem
 * gravado neste ciclo, e o estado de "recusado" fica como estava.
 */
async function readLiveSafe(auth) {
  let oauth = null;
  let unreadable = null;
  let who = null;
  try {
    const r = await auth.readLive();
    oauth = (r && r.claudeAiOauth) || null;
  } catch (e) {
    unreadable = String((e && (e.reason || e.code)) || "erro");
    console.error("[swap-plus] ler o login do Claude Code", safeErr(e));
  }
  try {
    const w = await auth.liveIdentity();
    if (w && w.email) who = { email: String(w.email).toLowerCase(), orgUuid: w.orgUuid || null };
  } catch {}
  return { oauth, who, unreadable };
}

/** O que vai no batimento sobre o login atual (sem token). */
function liveSummary(live) {
  if (!live.who) return null;
  return { email: live.who.email, orgUuid: live.who.orgUuid || null, expiresAt: live.oauth && typeof live.oauth.expiresAt === "number" ? live.oauth.expiresAt : null };
}

/** Identifica um login sem guardar token: hash do refresh token (ou, sem ele, da conta + validade). */
function loginKey(live) {
  const o = (live && live.oauth) || {};
  if (typeof o.refreshToken === "string" && o.refreshToken) return hashKey(`rt|${o.refreshToken}`);
  const w = (live && live.who) || {};
  return hashKey(`${w.email || "?"}|${w.orgUuid || ""}|${o.expiresAt || ""}`);
}

const listOf = (v) => (Array.isArray(v) ? v : typeof v === "string" && v ? [v] : []).filter((k) => typeof k === "string" && k);

/** Logins (com refresh token) já resolvidos: enviados ao servidor, recusados como mortos/gastos. Só hashes. */
function spentKeys() {
  const out = new Set(listOf(extContext.globalState.get(SERVER_SENT_KEY)));
  const f = readJsonFile(spentFile()); // outras janelas
  for (const x of (f && Array.isArray(f.keys) ? f.keys : [])) if (x && typeof x.k === "string") out.add(x.k);
  return out;
}

/** Este login pode ser substituído pelo acesso do servidor? (resolvido ou descartado pela pessoa) */
function isSpent(key) {
  return !!key && (srv.discard === key || spentKeys().has(key));
}

/** Anota que este login não deve mais ser enviado (e pode ser gravado por cima). state: "sent" | "dead". */
async function markLoginSent(key, st = "sent") {
  if (!key) return;
  const f = readJsonFile(spentFile());
  const keys = (f && Array.isArray(f.keys) ? f.keys : []).filter((x) => x && x.k !== key);
  writeJsonAtomic(spentFile(), { keys: [{ k: key, state: st, at: Date.now() }, ...keys].slice(0, SPENT_MAX) });
  const list = listOf(extContext.globalState.get(SERVER_SENT_KEY)).filter((k) => k !== key);
  try {
    await extContext.globalState.update(SERVER_SENT_KEY, [key, ...list].slice(0, SPENT_MAX));
  } catch {}
}

/**
 * Compare-and-swap do writeLive: grava por cima de um login com refresh token só se
 * ele já foi resolvido (enviado ao servidor, recusado como morto/gasto ou
 * descartado pela pessoa). Um login novo que apareceu no meio do caminho fica.
 */
function canReplaceLive(cur) {
  const o = cur && cur.claudeAiOauth;
  if (!o || !o.refreshToken) return true;
  return isSpent(loginKey({ oauth: o }));
}

/** Trava entre janelas para enviar UM login (mkdir é atômico). → função que libera | null (outra janela está enviando). */
function takeUploadLock(key) {
  const dir = uploadLockDir(key);
  for (let i = 0; i < 2; i++) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
      return () => {
        try {
          fs.rmdirSync(dir);
        } catch {}
      };
    } catch (e) {
      // Sem como travar aqui (ex.: sem permissão): segue. Enviar o mesmo login duas vezes não estraga
      // nada: o servidor responde stale_login (já renovou) ou "nada a fazer".
      if (e.code !== "EEXIST") return () => {};
      let st = null;
      try {
        st = fs.statSync(dir);
      } catch {
        continue; // sumiu agora: tenta de novo
      }
      if (Date.now() - st.mtimeMs <= UPLOAD_LOCK_STALE_MS) return null;
      try {
        fs.rmdirSync(dir); // trava esquecida (janela fechada no meio do envio)
      } catch {}
    }
  }
  return null;
}

/** oauthAccount do ~/.claude.json (dados da conta logada; sem segredo). */
async function liveOauthAccount(auth) {
  try {
    const p = await auth.globalConfigPath();
    const o = JSON.parse(await fs.promises.readFile(p, "utf8")).oauthAccount;
    return o && o.emailAddress ? o : null;
  } catch {
    return null;
  }
}

const LOGIN_REJECT_REASONS = {
  dead_login: "o login não vale mais (é preciso entrar de novo com a conta no Claude Code)",
  stale_login: "esse login já tinha sido renovado pelo servidor (o servidor tem um mais novo)",
  identity_mismatch: "o login não bate com a conta informada (e-mail ou organização diferentes)",
};

function loginRejectReason(e) {
  return LOGIN_REJECT_REASONS[e && e.code] || safeErr(e);
}

/**
 * Envia ao servidor o login novo do Claude Code (o que tem refresh token).
 * kind: "sent" | "dup" (já resolvido: enviado aqui ou por outra janela)
 *     | "dead" (morto/gasto no servidor, ou descartado pela pessoa — discarded: pode gravar por cima)
 *     | "rejected" (recusado: não grava por cima) | "wait" (ainda não dá: não grava por cima) | "offline"
 */
async function uploadLiveLogin(auth, live) {
  const key = loginKey(live);
  const now = Date.now();
  if (srv.discard && srv.discard === key) return { kind: "dead", key, discarded: true }; // a pessoa escolheu usar a conta do servidor
  // Já resolvido: nunca reenviar o mesmo login (o servidor já o renovou; o daqui está gasto).
  if (isSpent(key)) return { kind: "dup", key };
  if (srv.rejected && srv.rejected.key === key && now - srv.rejected.at < SAVE_RETRY_MS) return { kind: "rejected", key };
  if (srv.loginRetry && srv.loginRetry.key === key && now - srv.loginRetry.at < LOGIN_RETRY_MS) return { kind: "wait", key };
  const oauthAccount = await liveOauthAccount(auth);
  if (!oauthAccount) return { kind: "wait", key }; // o Claude Code ainda não gravou os dados da conta
  const release = takeUploadLock(key);
  if (!release) return { kind: "wait", key }; // outra janela está enviando este login agora
  try {
    if (isSpent(key)) return { kind: "dup", key }; // outra janela terminou o envio enquanto isso
    let client;
    try {
      client = await serverClient({ timeoutMs: LOGIN_POST_TIMEOUT_MS });
    } catch (e) {
      return { kind: "offline", error: e, key };
    }
    if (!client) return { kind: "wait", key };
    const ts = new Date().toISOString();
    try {
      const res = await client.request("POST", "/v1/logins", { claudeAiOauth: live.oauth, oauthAccount });
      await markLoginSent(key, "sent");
      srv.rejected = null;
      srv.loginRetry = null;
      await pushHistory([{ ts, kind: "info", text: `Login da conta ${res.number} enviado ao servidor${res.created ? " (conta nova)" : ""}` }]);
      return { kind: "sent", number: res.number, created: !!res.created, key };
    } catch (e) {
      if (srvErrKind(e) !== "rejected") return { kind: "offline", error: e, key };
      const code = e && e.code;
      if (code === "refresh_failed" || code === "profile_unavailable") {
        // O servidor não conseguiu conferir o login agora (falha temporária): tenta de novo em ~1 min, sem aviso.
        srv.loginRetry = { key, at: Date.now() };
        console.warn(`[swap-plus] o servidor não conseguiu conferir o login agora (${code}); tento de novo em 1 min`);
        return { kind: "wait", key };
      }
      const reason = loginRejectReason(e);
      const whose = live.who && !privateMode() ? ` de ${live.who.email}` : "";
      if (code === "dead_login" || code === "stale_login" || code === "identity_mismatch_spent") {
        // Login morto ou já gasto pelo servidor: não há o que guardar; a conta escolhida pelo servidor pode ir por cima.
        await markLoginSent(key, "dead");
        srv.rejected = null;
        srv.loginRetry = null;
        await pushHistory([{ ts, kind: code === "dead_login" ? "warn" : "info", text: `Login${whose} recusado pelo servidor: ${reason}` }]);
        return { kind: "dead", key };
      }
      const first = !srv.rejected || srv.rejected.key !== key;
      srv.rejected = { key, at: Date.now(), reason };
      if (first) {
        await pushHistory([{ ts, kind: "warn", text: `Login${whose} recusado pelo servidor: ${reason}` }]);
        vscode.window
          .showWarningMessage(
            `Swap Plus: o servidor recusou o login${whose} do Claude Code: ${reason}. Esse login fica como está (o Swap Plus não grava nada por cima); o envio é tentado de novo em 10 min.`,
            "Usar a conta do servidor"
          )
          .then((c) => c && useServerAccount());
      }
      return { kind: "rejected", key };
    }
  } finally {
    release();
  }
}

function notifyLoginSent(up, res) {
  const base = `Swap Plus: login da conta ${up.number} enviado ao servidor${up.created ? " (conta nova)" : ""}; agora quem renova é o servidor.`;
  // Pulou em silêncio (ex.: login novo apareceu agora): fica para o próximo ciclo, sem aviso de falha.
  if (res && ((res.status === "blocked" && !res.quiet) || res.status === "fail")) {
    const tail = res.stripped ? " Para não estragar a cópia do servidor, tirei daqui o refresh token desse login (o Claude Code segue com o acesso atual)." : "";
    vscode.window.showWarningMessage(safe(`${base} Ainda não gravei aqui a conta escolhida pelo servidor: ${res.reason || "falhou"}.${tail}`));
    return;
  }
  const cur = srv.state && srv.state.credential ? srv.state.credential.number : null;
  if (cur === null || cur === up.number) {
    vscode.window.showInformationMessage(`${base}${cur === up.number ? " Este computador segue nela." : ""}`);
    return;
  }
  vscode.window
    .showInformationMessage(`${base} Este computador está na conta ${cur}, escolhida pelo servidor.`, `Usar a conta ${up.number}`)
    .then((c) => c && serverSwitch(up.number));
}

function notifyServerSwitch(number, resp) {
  const me = serverMeta();
  const h = ((resp && resp.history) || []).find(
    (x) => x.kind === "switch" && (!x.device || x.device === me.deviceId || x.device === me.name) && Date.now() - tsMs(x.ts) < 5 * 60 * 1000
  );
  const model = state.models[0];
  vscode.window.showInformationMessage(
    safe(`Swap Plus: o servidor trocou este computador para a conta ${number}${h ? ` (${String(h.text).replace(/\.+$/, "")})` : ""}.${model ? ` O Claude Code continua no ${model.label}.` : ""}`)
  );
}

/** Mesma conta? who = { email (minúsculo), orgUuid }; target = { email, orgUuid }. */
function sameIdentity(who, target) {
  if (!who || !target || !target.email) return false;
  return who.email === String(target.email).toLowerCase() && (!who.orgUuid || !target.orgUuid || who.orgUuid === target.orgUuid);
}

/**
 * Tira só o refreshToken do login atual (que já foi para o servidor e não pôde ser
 * substituído pelo acesso do servidor): assim o Claude Code não o renova — o que
 * mataria a cópia do servidor. Sob a trava do Claude Code, e só se o login atual
 * ainda for o mesmo. true = tirou.
 */
async function stripLiveRefresh(auth, live) {
  const o = live && live.oauth;
  if (!o || !o.refreshToken || !swapOn() || !serverMode()) return false;
  const key = loginKey(live);
  const same = (c) => !!(c && c.claudeAiOauth && c.claudeAiOauth.refreshToken) && loginKey({ oauth: c.claudeAiOauth }) === key;
  try {
    await auth.withClaudeCredentialLocks(async () => {
      const cur = await auth.readLive();
      if (!same(cur)) throw Object.assign(new Error("o login do Claude Code mudou"), { code: "live_changed" });
      await auth.writeLive(cur.claudeAiOauth, { canReplace: same }); // o writeLive nunca grava o refreshToken
    });
  } catch (e) {
    if (!(e && e.code === "live_changed")) console.error("[swap-plus] tirar o refresh token do login enviado", safeErr(e));
    return false;
  }
  console.warn("[swap-plus] login enviado ao servidor sem a conta do servidor gravada: tirei o refresh token dele daqui");
  await pushHistory([
    { ts: new Date().toISOString(), kind: "info", text: "O login novo do Claude Code foi para o servidor; o refresh token dele foi tirado deste computador (quem renova é o servidor)" },
  ]);
  return true;
}

/**
 * Grava no Claude Code o acesso da conta que o servidor escolheu para este computador, quando:
 * a versão (gen) ou a conta mudou, a conta logada não é a atribuída, ou a validade do login
 * atual difere da do servidor. Só o acesso: o refresh token nunca é gravado no modo servidor.
 * opts: live (login atual já lido), up (resultado do envio do login atual, se já feito),
 *   force (buscar e gravar mesmo sem mudança), retryNow (não esperar 1 min depois de uma falha).
 * → null (nada a fazer) | { number, prev, wrote: true } | { blocked: código, reason, quiet, stripped }
 */
async function syncCredential(client, resp, { live = null, up = null, force = false, retryNow = false } = {}) {
  if (!swapOn() || !serverMode()) return null; // desligado ou modo local: nunca grava
  const auth = claudeAuth();
  const storeBlock = storeBlockReason(refreshStoreWarnings());
  if (storeBlock) return { blocked: "store", reason: storeBlock };
  if (!live) live = await readLiveSafe(auth);
  if (live.unreadable) return { blocked: "unreadable", reason: "não consegui ler o login atual do Claude Code", quiet: true };
  // Nunca grava por cima de um login novo que ainda não foi para o servidor (troca manual ou
  // limite logo depois de entrar com uma conta, antes do próximo ciclo).
  if (!up && live.oauth && live.oauth.refreshToken) {
    up = await uploadLiveLogin(auth, live);
    if (up.kind === "offline") {
      up.error.fromServer = true;
      throw up.error;
    }
  }
  if (up && up.kind === "rejected") {
    return { blocked: "rejected", reason: `o servidor recusou o login atual do Claude Code${srv.rejected ? ` (${srv.rejected.reason})` : ""}, que fica como está` };
  }
  if (up && up.kind === "wait") return { blocked: "wait", reason: "o login novo do Claude Code ainda está indo para o servidor", quiet: true };
  if (up) force = true;
  // Login já entregue ao servidor (ou gasto lá): se não der para pôr o acesso do servidor por cima, tira o refresh token dele.
  const spentUp = !!up && (up.kind === "sent" || up.kind === "dup" || (up.kind === "dead" && !up.discarded));
  try {
    return await applyServerCredential(client, resp, auth, live, { force, retryNow, spentUp });
  } catch (e) {
    if (spentUp && e && typeof e === "object" && (await stripLiveRefresh(auth, live))) e.stripped = true;
    throw e;
  }
}

async function applyServerCredential(client, resp, auth, live, { force, retryNow, spentUp }) {
  const cred = resp && resp.credential;
  const blocked = async (code, reason, quiet) => ({ blocked: code, reason, quiet: !!quiet, stripped: spentUp ? await stripLiveRefresh(auth, live) : false });
  if (!cred) return spentUp ? blocked("no_account", NO_ACCOUNT_TEXT) : null;
  const applied = extContext.globalState.get(SERVER_APPLIED_KEY) || null;
  const accounts = resp.list && Array.isArray(resp.list.accounts) ? resp.list.accounts : [];
  const acc = accounts.find((a) => a.number === cred.number);
  const who = live.who;
  const sameAccount = sameIdentity(who, acc && { email: acc.email, orgUuid: acc.organizationUuid });
  const liveExp = live.oauth ? live.oauth.expiresAt : null;
  const changed = !applied || applied.number !== cred.number || applied.gen !== cred.gen;
  // Servidor sem os dados da conta (ou ~/.claude.json que não deu para gravar): não dá para conferir a identidade; não regrava a cada ciclo por isso.
  const identityOk = sameAccount || (!changed && applied && applied.noIdentity);
  if (!force && !changed && identityOk && liveExp === cred.expiresAt) return null;
  const failKey = `${cred.number}|${cred.gen}`;
  if (!retryNow && srv.applyFail && srv.applyFail.key === failKey && Date.now() - srv.applyFail.at < APPLY_RETRY_MS) {
    return spentUp ? blocked("retry", "a última gravação falhou; tento de novo em 1 min", true) : null;
  }
  let r;
  try {
    r = await client.request("GET", "/v1/credential");
  } catch (e) {
    if (Number(e && e.status) === 409) return blocked("no_account", NO_ACCOUNT_TEXT); // sem conta para este computador
    e.fromServer = true;
    throw e;
  }
  const o = (r && r.claudeAiOauth) || {};
  if (!o.accessToken || typeof o.expiresAt !== "number") throw new Error("o servidor não mandou o acesso da conta");
  const clean = { accessToken: o.accessToken, expiresAt: o.expiresAt };
  for (const k of ["scopes", "subscriptionType", "rateLimitTier"]) if (o[k] !== undefined) clean[k] = o[k];
  // (sem refreshToken, de propósito; o writeLive também tira)
  const oa = r.oauthAccount && r.oauthAccount.emailAddress ? r.oauthAccount : null;
  const target = oa ? { email: oa.emailAddress, orgUuid: oa.organizationUuid || null } : acc ? { email: acc.email, orgUuid: acc.organizationUuid } : null;
  // Trocando de conta: o "dispositivo confiável" é da conta anterior (o próprio Claude Code apaga no /login).
  const switching = !sameIdentity(who, target);
  if (!swapOn() || !serverMode()) return null; // desligado (ou modo local) no meio do caminho: não grava
  try {
    await auth.writeLive(clean, { canReplace: canReplaceLive, dropTrustedDevice: switching });
  } catch (e) {
    // Login novo apareceu agora (ou não deu para reler sob a trava): fica para o próximo ciclo, sem aviso.
    if (e && e.code === "live_changed") return { blocked: "live_changed", reason: "o login do Claude Code acabou de mudar (login novo); fica para o próximo ciclo", quiet: true };
    if (e && e.code === "live_unreadable") return { blocked: "live_unreadable", reason: "não consegui ler o login atual do Claude Code", quiet: true };
    throw e;
  }
  // Gravou: anota já (um erro daqui em diante não faz regravar a cada ciclo).
  srv.applyFail = null;
  srv.discard = null;
  const appliedNow = { number: r.number, gen: r.gen, expiresAt: o.expiresAt, at: Date.now(), noIdentity: !oa };
  await extContext.globalState.update(SERVER_APPLIED_KEY, appliedNow);
  if (oa) {
    try {
      await auth.writeOauthAccount(r.oauthAccount);
      srv.accountWarned = null;
    } catch (e) {
      await extContext.globalState.update(SERVER_APPLIED_KEY, { ...appliedNow, noIdentity: true });
      const code = (e && e.code) || "erro";
      console.error("[swap-plus] dados da conta no ~/.claude.json", safeErr(e));
      if (srv.accountWarned !== code) {
        srv.accountWarned = code;
        vscode.window.showWarningMessage(
          `Swap Plus: gravei o acesso da conta ${r.number} no Claude Code, mas não consegui atualizar os dados da conta (e-mail/organização) no ${path.basename(String(auth.globalConfigPath()))}: ${safeErr(e)} O Claude Code pode mostrar a conta anterior até isso ser resolvido.`
        );
      }
    }
  }
  const prev = applied ? applied.number : null;
  const expected = srv.expectNumber;
  srv.expectNumber = null;
  if (prev !== null && prev !== r.number && expected !== r.number) notifyServerSwitch(r.number, resp);
  return { number: r.number, prev, wrote: true };
}

/**
 * syncCredential sem lançar erro.
 * → { status: "ok" (gravou) | "skip" (nada a fazer) | "blocked" (não gravou, com motivo) | "fail", reason?, shown?, stripped? }
 */
async function syncCredentialSafe(client, resp, opts) {
  try {
    const r = await syncCredential(client, resp, opts);
    if (!r) return { status: "skip" };
    if (r.blocked) {
      if (!r.quiet) console.warn("[swap-plus] credencial não gravada:", r.reason);
      return { status: "blocked", code: r.blocked, reason: r.reason, quiet: !!r.quiet, stripped: !!r.stripped };
    }
    return { status: "ok", number: r.number };
  } catch (e) {
    if (e && e.fromServer && srvErrKind(e) !== "rejected") {
      await serverFailed(e, "credencial");
      return { status: "fail", reason: srvErrText(e), shown: false, stripped: !!e.stripped };
    }
    const cred = resp && resp.credential;
    const key = cred ? `${cred.number}|${cred.gen}` : "";
    const first = !srv.applyFail || srv.applyFail.key !== key;
    srv.applyFail = { key, at: Date.now() };
    const reason = `não consegui gravar o login da conta ${cred ? cred.number : "?"} no Claude Code: ${(e && e.fromServer ? srvErrText(e) : safeErr(e)).replace(/\.+$/, "")}`;
    console.error("[swap-plus] credencial", reason);
    if (first) vscode.window.showErrorMessage(`Swap Plus: ${reason}. Tento de novo em 1 min.`);
    return { status: "fail", reason, shown: first, stripped: !!(e && e.stripped) };
  }
}

/**
 * Um ciclo do modo servidor. Janela dona: envia login novo (se houver), batimento,
 * grava a conta escolhida. Outras janelas: só leem o estado.
 */
async function serverSync() {
  const models = await detectModels();
  state = { ...state, models, unmanaged: null };
  if (srv.hold || !serverMode() || !swapOn()) return finishSync(); // conexão, envio de logins, desligar... em andamento
  let client = null;
  try {
    client = await serverClient();
  } catch (e) {
    srv.lastError = safeErr(e);
  }
  const st = serverStatus();
  if (!client || st === "revoked") {
    state = { ...state, error: cap(serverErrorLine() || srv.lastError || "sem conexão com o servidor"), fetchedAt: Date.now() };
    if (st === "disconnected") warnDisconnectedOnce();
    return finishSync();
  }
  refreshStoreWarnings();
  if (!claimOwner(false)) {
    // Outra janela do VS Code cuida do batimento e do login deste computador: esta só lê o estado.
    let resp;
    try {
      resp = await client.request("GET", "/v1/state");
    } catch (e) {
      return serverFailed(e, "estado");
    }
    if (!serverMode() || !swapOn()) return finishSync(); // mudou de modo (ou desligou) no meio
    if (!applyStateResponse(resp)) return serverFailed(new Error("a resposta do servidor veio sem a lista de contas"), "estado");
    finishSync();
    checkAlerts().catch((e) => console.error("[swap-plus] alerts", safeErr(e)));
    checkNewerInstalled();
    return;
  }
  const auth = claudeAuth();
  const live = await readLiveSafe(auth);
  const blocked = storeBlockReason();
  // 1) login novo no Claude Code (tem refresh token): vai para o servidor antes de qualquer gravação.
  //    Leitura que falhou: nada é enviado nem gravado, e o "recusado" fica como estava.
  let up = null;
  if (!live.unreadable && !blocked && live.oauth && live.oauth.refreshToken) {
    up = await uploadLiveLogin(auth, live);
    if (up.kind === "offline") return serverFailed(up.error, "envio do login");
  } else if (!live.unreadable && !(live.oauth && live.oauth.refreshToken)) {
    srv.rejected = null;
  }
  // 2) batimento
  let resp;
  try {
    resp = await client.request("POST", "/v1/heartbeat", { models: models.map((m) => m.id), live: liveSummary(live) });
  } catch (e) {
    return serverFailed(e, "batimento");
  }
  if (!serverMode() || !swapOn()) return finishSync(); // mudou de modo (ou desligou) no meio: não grava nada
  if (!applyStateResponse(resp)) return serverFailed(new Error("a resposta do servidor veio sem a lista de contas"), "batimento");
  // 3) credencial. Login recusado (ou ainda sendo enviado por outra janela): nada por cima, para não perdê-lo.
  let res = null;
  if (!live.unreadable && !blocked) res = await syncCredentialSafe(client, resp, { live, up, force: !!up });
  if (up && up.kind === "sent") notifyLoginSent(up, res);
  finishSync();
  checkAlerts().catch((e) => console.error("[swap-plus] alerts", safeErr(e)));
  checkNewerInstalled();
}

/** Chamada ao servidor que devolve o estado (ajustes, regras...). Mostra o erro e devolve null se falhar. */
async function serverCall(method, p, body, what) {
  const report = (text) => {
    if (panel) post({ type: "toast", kind: "error", text });
    else vscode.window.showErrorMessage(`Swap Plus: ${text}`);
  };
  if (!swapOn()) {
    report(`${what}: o Swap Plus está desligado (sem contato com o servidor). Ligue-o e tente de novo.`);
    return null;
  }
  let client = null;
  try {
    client = await serverClient();
  } catch (e) {
    report(`${what}: ${safeErr(e)}`);
    return null;
  }
  if (!client || serverStatus() === "revoked") {
    report(`${what}: ${serverErrorLine() || "sem conexão com o servidor"}`);
    return null;
  }
  try {
    const resp = await client.request(method, p, body);
    if (resp && resp.list) applyStateResponse(resp);
    finishSync();
    return resp || {};
  } catch (e) {
    const kind = srvErrKind(e);
    if (kind !== "rejected") await serverFailed(e, what);
    report(`${what}: ${srvErrText(e)}`);
    return null;
  }
}

/** Troca manual no modo servidor (num = null: o servidor escolhe a melhor conta). */
async function serverSwitch(num) {
  if (!swapOn()) {
    vscode.window.showInformationMessage("Swap Plus está desligado: ligue-o para trocar de conta.");
    return null;
  }
  if (!serverMode()) return null;
  return srvQueue(() => serverSwitchNow(num));
}

async function serverSwitchNow(num) {
  if (!swapOn() || !serverMode()) return null;
  let client = null;
  try {
    client = await serverClient();
  } catch (e) {
    vscode.window.showErrorMessage(`Swap Plus: ${safeErr(e)}`);
    return null;
  }
  if (!client || serverStatus() === "revoked") {
    vscode.window.showErrorMessage(`Swap Plus: ${serverErrorLine() || "sem conexão com o servidor."}`);
    return null;
  }
  claimOwner(true); // a pessoa agiu nesta janela: é ela que grava
  const before = state.list ? state.list.activeAccountNumber : null;
  const title = num === null ? "Pedindo ao servidor a melhor conta..." : `Trocando para a conta ${num}...`;
  let resp = null;
  let err = null;
  let res = { status: "skip" };
  await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: false }, async () => {
    try {
      resp = await client.request("POST", "/v1/switch", { number: num });
    } catch (e) {
      err = e;
      return;
    }
    applyStateResponse(resp);
    srv.expectNumber = resp && resp.credential ? resp.credential.number : null;
    res = await syncCredentialSafe(client, resp, { force: true, retryNow: true });
  });
  if (err) {
    if (srvErrKind(err) !== "rejected") await serverFailed(err, "troca");
    vscode.window.showErrorMessage(`Swap Plus: falha ao trocar de conta: ${srvErrText(err)}`);
    return null;
  }
  const now = resp && resp.credential ? resp.credential.number : null;
  // "agora na conta N" só quando o acesso dela foi gravado de fato.
  if (now === null) vscode.window.showWarningMessage("Swap Plus: o servidor não tem conta livre para este computador agora.");
  else if (res.status === "blocked") vscode.window.showWarningMessage(`Swap Plus: o servidor escolheu a conta ${now} para este computador, mas não gravei aqui: ${res.reason}.`);
  else if (res.status === "fail") {
    if (!res.shown) vscode.window.showErrorMessage(`Swap Plus: o servidor escolheu a conta ${now}, mas: ${res.reason}.`);
  } else if (num === null && now === before) vscode.window.showInformationMessage(`Swap Plus: a conta ${now} já é a melhor para este computador.`);
  else if (num !== null && now !== num) vscode.window.showWarningMessage(`Swap Plus: o servidor manteve este computador na conta ${now}.`);
  else vscode.window.showInformationMessage(`Swap Plus: agora na conta ${now}.`);
  finishSync();
  return resp;
}

/** Limite batido (visto na transcrição): avisa o servidor, que decide a troca. */
async function serverLimitHit(label) {
  if (!swapOn() || !serverMode()) return null;
  return srvQueue(() => serverLimitHitNow(label));
}

async function serverLimitHitNow(label) {
  if (!swapOn() || !serverMode()) return null;
  let client = null;
  try {
    client = await serverClient();
  } catch {}
  if (!client || serverStatus() === "revoked") return null;
  claimOwner(true); // esta janela viu o limite e vai gravar a conta nova
  let res;
  try {
    res = await client.request("POST", "/v1/events", { kind: "limit_hit", label });
  } catch (e) {
    await serverFailed(e, "limite");
    vscode.window.showWarningMessage(`Swap Plus: a conta em uso bateu o ${label}, mas não consegui avisar o servidor: ${srvErrText(e)}.`);
    return null;
  }
  const st = res && res.state;
  if (st) applyStateResponse(st);
  const text = cap(safe(String((res && res.text) || `a conta em uso bateu o ${label}`)).replace(/\.+$/, ""));
  let wrote = false;
  if (res && res.switched) {
    srv.expectNumber = st && st.credential ? st.credential.number : null;
    const w = st ? await syncCredentialSafe(client, st, { force: true, retryNow: true }) : { status: "blocked", reason: "o servidor não mandou o estado novo" };
    await extContext.globalState.update(LAST_SWITCH_KEY, Date.now());
    wrote = w.status === "ok";
    // "Trocou" só quando a conta nova foi gravada aqui de fato.
    if (wrote) vscode.window.showInformationMessage(`Swap Plus: ${text}.${RESUME_TIP}`);
    else if (w.status === "fail" && w.shown) {
      // o erro de gravação já foi mostrado
    } else vscode.window.showWarningMessage(`Swap Plus: o servidor trocou a conta deste computador (${text.replace(/^./, (c) => c.toLowerCase())}), mas não gravei a conta nova aqui: ${w.reason || "falhou"}.`);
  } else {
    vscode.window
      .showWarningMessage(`Swap Plus: ${text}.${autoEnabled() ? "" : " A troca automática está desligada no servidor."}`, "Trocar para a melhor conta")
      .then((c) => c && switchBest());
  }
  finishSync();
  return { kind: res && res.switched ? (wrote ? "switch" : "blocked") : "blocked", text };
}

async function setServerAuto(on) {
  const resp = await serverCall("PUT", "/v1/rules", { autoSwitch: !!on }, "troca automática");
  if (!resp) return postState();
  const text = `troca automática ${on ? "ligada" : "desligada"} no servidor (vale para todos os computadores conectados)`;
  if (panel) post({ type: "toast", kind: "info", text: cap(text) + "." });
  else vscode.window.showInformationMessage(`Swap Plus: ${text}.`);
}

async function saveServerRules(m) {
  // Os avisos ("avisar em X%") são deste computador: ficam nas configurações do VS Code.
  if (m.alerts && typeof m.alerts === "object") await saveAlerts(m.alerts);
  const body = {};
  for (const k of Object.keys(RULE_DEFAULTS)) if (m.rules && k in m.rules) body[k] = m.rules[k];
  const resp = await serverCall("PUT", "/v1/rules", { rules: body }, "salvar as regras no servidor");
  if (resp) post({ type: "toast", kind: "info", text: "Regras salvas no servidor (valem para todos os computadores conectados)." });
  else postState();
}

async function serverAccountOp(m) {
  const n = Number(m.number);
  if (!Number.isInteger(n)) return;
  const patch = {};
  if (m.op === "disabled") patch.disabled = !!m.value;
  else if (m.op === "threshold") patch.threshold = m.value === null || m.value === "" ? null : Number(m.value);
  else if (m.op === "priority") patch.priority = m.value === null || m.value === "" ? 0 : Number(m.value);
  else if (m.op === "alias") patch.alias = m.value ? String(m.value).slice(0, 24) : null;
  else return;
  const resp = await serverCall("PATCH", `/v1/accounts/${n}`, patch, `Conta ${n}`);
  if (!resp) postState();
}

/** Usar a conta escolhida pelo servidor, descartando o login atual (que o servidor recusou). */
async function useServerAccount() {
  const c = await vscode.window.showWarningMessage(
    "Usar a conta escolhida pelo servidor?",
    {
      modal: true,
      detail:
        "O login atual do Claude Code (que o servidor recusou) é substituído pelo acesso da conta que o servidor escolheu para este computador. Para usar aquele login de novo, entre outra vez com a conta no Claude Code.",
    },
    "Usar a conta do servidor"
  );
  if (c !== "Usar a conta do servidor") return;
  await srvQueue(async () => {
    const live = await readLiveSafe(claudeAuth());
    if (live.unreadable) {
      vscode.window.showErrorMessage("Swap Plus: não consegui ler o login atual do Claude Code; nada foi trocado. Tente de novo em instantes.");
      return;
    }
    claimOwner(true);
    srv.discard = live.oauth && live.oauth.refreshToken ? loginKey(live) : null;
    srv.rejected = null;
  });
  await refreshFresh(); // fora da fila: o ciclo entra nela
}

// ---- regras deste computador → servidor (primeira conexão)

const OFFER_RULE_KEYS = ["sessionPct", "weeklyPct", "modelPct", "preferModel", "strategy", "expiringHours", "cooldownMin", "marginPct", "onModelLimit"];
const OFFER_RULE_LABELS = {
  sessionPct: "Troca na sessão de 5h",
  weeklyPct: "Troca no semanal",
  modelPct: "Troca no semanal do modelo",
  preferModel: "Modelo preferido",
  strategy: "Estratégia",
  expiringHours: "Cota que zera em até (horas)",
  cooldownMin: "Intervalo mínimo entre trocas (min)",
  marginPct: "Margem abaixo da linha",
  onModelLimit: "Quando o limite do modelo acaba",
};

function ruleText(k, v) {
  if (k === "strategy") return STRATEGY_LABELS[v] || String(v);
  if (k === "onModelLimit") return v === "switchAccount" ? "trocar de conta" : "seguir na mesma conta";
  if (k === "preferModel") return v ? String(v) : "nenhum";
  if (/Pct$/.test(k)) return `${v}%`;
  return String(v);
}

function sameRule(a, b) {
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a == null ? "" : a).trim() === String(b == null ? "" : b).trim();
}

/**
 * Primeira conexão a um servidor: se as regras de troca deste computador (e a troca
 * automática) são diferentes das do servidor, oferece levá-las para lá (PUT /v1/rules;
 * valem para todos os computadores). Uma vez por servidor.
 */
async function offerLocalRules(url) {
  const origin = urlOrigin(url);
  if (!origin || !serverMode() || !swapOn()) return null;
  const offered = extContext.globalState.get(SERVER_RULES_OFFERED_KEY) || {};
  if (offered[origin]) return null;
  const st = srv.state;
  if (!st || serverStatus() !== "online") return null; // sem as regras do servidor ainda: fica para a próxima conexão
  await extContext.globalState.update(SERVER_RULES_OFFERED_KEY, { ...offered, [origin]: Date.now() });
  const mine = localRules();
  const theirs = { ...RULE_DEFAULTS, ...(st.rules || {}) };
  const diffs = OFFER_RULE_KEYS.filter((k) => !sameRule(mine[k], theirs[k]));
  const myAuto = !!cfg().get("autoSwitch.enabled");
  const autoDiff = myAuto !== !!st.autoSwitch;
  if (!diffs.length && !autoDiff) return null;
  const lines = diffs.map((k) => `• ${OFFER_RULE_LABELS[k]}: aqui ${ruleText(k, mine[k])} · no servidor ${ruleText(k, theirs[k])}`);
  if (autoDiff) lines.push(`• Troca automática: aqui ${myAuto ? "ligada" : "desligada"} · no servidor ${st.autoSwitch ? "ligada" : "desligada"}`);
  const BTN = "Usar as regras deste computador no servidor";
  const c = await vscode.window.showInformationMessage(
    "As regras de troca deste computador são diferentes das do servidor.",
    {
      modal: true,
      detail: `${lines.join("\n")}\n\nNo modo servidor valem as regras do servidor, para todos os computadores conectados a ele. Sem levar as daqui, este computador passa a seguir as do servidor (as daqui ficam guardadas para o modo local).`,
    },
    BTN
  );
  if (c !== BTN) return false;
  const rulesBody = Object.fromEntries(OFFER_RULE_KEYS.map((k) => [k, mine[k]]));
  const resp = await serverCall("PUT", "/v1/rules", { rules: rulesBody, autoSwitch: myAuto }, "levar as regras deste computador ao servidor");
  if (!resp) return false;
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Regras de troca deste computador levadas ao servidor ${serverHost(url)}` }]);
  postState();
  vscode.window.showInformationMessage("Swap Plus: regras deste computador salvas no servidor (valem para todos os computadores conectados).");
  return true;
}

// ---- tela de login do Claude Code (claudeCode.disableLoginPrompt)
//
// No modo servidor o Claude Code recebe só o acesso (sem refresh token). Quando o
// acesso vence antes de o Swap Plus gravar o novo, o Claude Code (extensão do VS
// Code) abriria a tela de login. Enquanto o modo servidor está ligado, a tela fica
// desligada; o valor anterior fica guardado e volta ao sair.

function loginPromptWanted() {
  return serverMode() && swapOn() && !!srv.token && !!serverMeta().url;
}

let loginPromptChain = Promise.resolve();
/** Aplica ou devolve claudeCode.disableLoginPrompt conforme o modo (em fila; nunca lança). */
function syncLoginPrompt() {
  const p = loginPromptChain.then(() => doSyncLoginPrompt()).catch((e) => console.error("[swap-plus] claudeCode.disableLoginPrompt", safeErr(e)));
  loginPromptChain = p;
  return p;
}

async function doSyncLoginPrompt() {
  if (!extContext) return;
  await serverToken();
  const want = loginPromptWanted();
  const saved = extContext.globalState.get(LOGIN_PROMPT_KEY) || {};
  const cc = vscode.workspace.getConfiguration("claudeCode");
  let g;
  try {
    const i = cc.inspect("disableLoginPrompt");
    g = i ? i.globalValue : undefined;
  } catch {
    g = undefined;
  }
  if (want) {
    if (saved.applied) return;
    await extContext.globalState.update(LOGIN_PROMPT_KEY, { applied: true, had: g !== undefined, value: g === undefined ? null : g, noticed: !!saved.noticed });
    try {
      if (g !== true) await cc.update("disableLoginPrompt", true, vscode.ConfigurationTarget.Global);
    } catch (e) {
      // Ex.: a extensão do Claude Code não está instalada (configuração desconhecida). Tenta de novo depois.
      await extContext.globalState.update(LOGIN_PROMPT_KEY, { applied: false, noticed: !!saved.noticed });
      console.warn("[swap-plus] não consegui desligar a tela de login do Claude Code:", safeErr(e));
      return;
    }
    if (!saved.noticed) {
      await extContext.globalState.update(LOGIN_PROMPT_KEY, { ...(extContext.globalState.get(LOGIN_PROMPT_KEY) || {}), noticed: true });
      vscode.window.showInformationMessage(
        `Swap Plus: ${LOGIN_PROMPT_NOTE.charAt(0).toLowerCase()}${LOGIN_PROMPT_NOTE.slice(1)}: a tela de login do Claude Code fica desligada (claudeCode.disableLoginPrompt) e volta como estava ao sair do modo servidor ou desconectar.`
      );
    }
    postState();
    return;
  }
  if (!saved.applied) return;
  // Só devolve se continua como deixamos (true); se a pessoa mudou à mão no meio, fica a escolha dela.
  if (g === true) await cc.update("disableLoginPrompt", saved.had ? saved.value : undefined, vscode.ConfigurationTarget.Global);
  await extContext.globalState.update(LOGIN_PROMPT_KEY, { applied: false, noticed: !!saved.noticed });
  postState();
}

async function setMode(mode) {
  const want = mode === "server" ? "server" : "local";
  const cur = serverMode() ? "server" : "local";
  const ts = new Date().toISOString();
  if (want === "server") {
    if (!(await serverToken())) return connectServer(); // conecta e liga o modo servidor no fim
    if (cur === "server") return;
    await cfg().update("mode", "server", vscode.ConfigurationTarget.Global);
    await pushHistory([{ ts, kind: "info", text: `Modo servidor ligado (${serverHost()})` }]);
    vscode.window.showInformationMessage(`Swap Plus: modo servidor (${serverHost()}). O servidor guarda os logins e escolhe a conta deste computador.`);
    return;
  }
  if (cur === "local") return;
  const c = await vscode.window.showWarningMessage(
    "Voltar para o modo local?",
    {
      modal: true,
      detail:
        "No modo local o motor swap-plus deste computador volta a cuidar (e a renovar) os logins que ele guarda. Um login que o servidor também tem morre lá quando é renovado aqui: o login só vale para quem renovou por último. Use o modo local só se não for mais usar o servidor com essas contas.\n\nEste computador continua conectado: dá para voltar ao modo servidor a qualquer momento. O Claude Code fica com o acesso atual até ele vencer; depois, entre de novo com uma conta.",
    },
    "Voltar ao modo local"
  );
  if (c !== "Voltar ao modo local") return postState();
  // Espera o ciclo em andamento (que pode estar gravando) antes de mudar de modo.
  await holdServer(async () => {
    await cfg().update("mode", "local", vscode.ConfigurationTarget.Global);
    await pushHistory([{ ts, kind: "info", text: "Modo local ligado" }]);
  });
  await syncLoginPrompt();
}

function pairErrorText(e, url) {
  const st = Number(e && e.status);
  if (st === 403) return `o servidor ${serverHost(url)} não aceita conexões deste endereço de internet (lista de endereços permitidos).`;
  if (st === 429) return "muitas tentativas seguidas; espere uns minutos e tente de novo.";
  if (st >= 400 && st < 500) return "o código não foi aceito. Ele vale 10 minutos e só uma vez: gere outro no servidor (comando pair) e cole de novo.";
  if (e && e.code === "fingerprint_mismatch") {
    return `o certificado do servidor ${serverHost(url)} não bate com o do código de conexão. Gere um código novo no servidor e tente de novo.`;
  }
  return `não consegui falar com o servidor em ${serverHost(url)}: ${safeErr(e).replace(/\.+$/, "")}. Confira se ele está no ar e se o endereço está certo.`;
}

/** Erro ao entrar com Google (início ou consulta), numa frase sem maiúscula no começo. */
function googleErrorText(e, url) {
  const st = Number(e && e.status);
  const host = serverHost(url);
  const msg = safeErr(e).replace(/\.+$/, "");
  if (e && e.code === "bad_response") return `resposta inesperada do servidor ${host}: ${msg}.`;
  if (st === 403) return `o servidor ${host} recusou o acesso a partir deste endereço de internet.`;
  if (st === 429) return "muitas tentativas seguidas; espere uns minutos e tente de novo.";
  if (st === 404) return `o servidor ${host} não tem o login com Google (versão antiga?). Conecte com o código de conexão.`;
  if (st >= 400 && st < 500) return `o servidor ${host} recusou o pedido: ${msg}.`;
  return `não consegui falar com o servidor em ${host}: ${msg}. Confira se ele está no ar e se o endereço está certo.`;
}

let connecting = false;

const CONNECT_METHODS = ["google", "googleOther", "code"];
const GOOGLE_POLL_MS = 2000; // consulta ao servidor enquanto a pessoa entra no navegador
const GOOGLE_MAX_MS = 10 * 60 * 1000; // nunca espera mais que isso, mesmo se o servidor der mais prazo
const GOOGLE_OFFLINE_MAX_MS = 60 * 1000; // sem resposta do servidor por mais que isso: desiste
const CANCELLED = Symbol("cancelado");

/**
 * Comando "Conectar ao servidor". `method`: "google" (entrar com a conta Google no
 * endereço de swapPlus.server.url), "googleOther" (idem, perguntando o endereço) ou
 * "code" (colar o código de conexão). Sem `method`, pergunta.
 */
async function connectServer(method) {
  if (connecting) {
    vscode.window.showInformationMessage("Swap Plus: já há uma conexão ao servidor em andamento (veja a notificação no canto da tela).");
    return;
  }
  connecting = true;
  postState();
  try {
    await connectServerFlow(CONNECT_METHODS.includes(method) ? method : undefined);
  } finally {
    connecting = false;
    postState();
  }
}

async function connectServerFlow(method) {
  if (!extContext.secrets) {
    vscode.window.showErrorMessage("Swap Plus: esta versão do VS Code não tem o cofre de segredos; atualize o VS Code para usar o modo servidor.");
    return;
  }
  if (!swapOn()) {
    const c = await vscode.window.showWarningMessage("O Swap Plus está desligado. Para conectar ao servidor, ligue-o.", "Ligar e conectar");
    if (c !== "Ligar e conectar") return;
    await setEnabled(true);
  }
  let lib;
  try {
    lib = serverLib();
  } catch (e) {
    vscode.window.showErrorMessage(`Swap Plus: não consegui carregar o cliente do servidor: ${safeErr(e)}`);
    return;
  }
  const had = await serverToken();
  if (had) {
    const c = await vscode.window.showWarningMessage(
      `Este computador já está conectado a ${serverHost()}. Conectar de novo?`,
      { modal: true, detail: "A conexão atual é substituída pela nova (o acesso antigo deste computador é revogado no servidor)." },
      "Conectar de novo"
    );
    if (c !== "Conectar de novo") return;
  }
  if (!method) method = await pickConnectMethod();
  if (!method) return;
  const got = method === "code" ? await connectByCode(lib) : await connectByGoogle(lib, { askUrl: method === "googleOther" });
  if (!got) return;
  await finishConnect(got, had);
}

/** Como conectar: "google" (padrão) | "code" | "googleOther" | undefined (desistiu). */
async function pickConnectMethod() {
  const host = serverHost(connectUrl());
  const c = await vscode.window.showQuickPick(
    [
      {
        label: "$(account) Entrar com Google",
        description: host,
        detail: "Abre o navegador para você entrar com a sua conta Google. O dono do servidor precisa ter liberado essa conta.",
        method: "google",
      },
      {
        label: "$(key) Colar código de conexão",
        detail: "O código que começa com swapplus1:, gerado no servidor (comando pair). Vale 10 minutos e uma vez só.",
        method: "code",
      },
      {
        label: "$(globe) Outro endereço…",
        detail: `Entrar com Google num servidor Swap Plus que não é ${host}.`,
        method: "googleOther",
      },
    ],
    { title: "Swap Plus: conectar ao servidor", placeHolder: "Como conectar este computador ao servidor?", ignoreFocusOut: true }
  );
  return c ? c.method : undefined;
}

/** Nome deste computador na lista do servidor (sugestão: o nome da máquina). undefined = desistiu. */
async function askDeviceName() {
  const name = await vscode.window.showInputBox({
    title: "Swap Plus: nome deste computador",
    prompt: "Como este computador aparece na lista de computadores do servidor.",
    value: defaultDeviceName(),
    ignoreFocusOut: true,
    validateInput: (v) => (String(v || "").trim().length > 60 ? "Use até 60 caracteres." : null),
  });
  if (name === undefined) return undefined;
  return name.trim() || defaultDeviceName();
}

/**
 * Colar o código de conexão → pareia (POST /v1/pair).
 * → { url, fp, deviceId, token, name, via: "code" } ou null (desistiu ou deu erro, já avisado).
 */
async function connectByCode(lib, deviceName) {
  const text = await vscode.window.showInputBox({
    title: "Swap Plus: conectar ao servidor",
    prompt: "Cole o código de conexão gerado no servidor (comando pair). Ele começa com swapplus1: e vale por 10 minutos.",
    placeHolder: "swapplus1:…",
    ignoreFocusOut: true,
    validateInput: (v) => {
      const s = String(v || "").trim();
      if (!s) return null;
      try {
        const c = lib.parseConnectCode(s);
        return c && c.url && c.code ? null : "Código inválido: falta o endereço ou o código do servidor.";
      } catch (e) {
        return safeErr(e); // a mensagem do serverClient já diz o que está errado
      }
    },
  });
  if (!text || !text.trim()) return null;
  let parsed;
  try {
    parsed = lib.parseConnectCode(text.trim());
    if (!parsed || !parsed.url || !parsed.code) throw new Error("falta o endereço ou o código do servidor");
  } catch (e) {
    vscode.window.showErrorMessage(`Swap Plus: código de conexão inválido: ${safeErr(e)}`);
    return null;
  }
  const name = deviceName || (await askDeviceName());
  if (name === undefined) return null;
  const url = String(parsed.url || "").replace(/\/+$/, "");
  let res;
  try {
    res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Swap Plus: conectando a ${serverHost(url)}...`, cancellable: false },
      () => lib.pair({ url, fp: parsed.fp || null, code: parsed.code, name, platform: process.platform })
    );
  } catch (e) {
    vscode.window.showErrorMessage(`Swap Plus: ${pairErrorText(e, url)}`);
    return null;
  }
  if (!res || !res.token || !res.deviceId) {
    vscode.window.showErrorMessage("Swap Plus: o servidor não devolveu o acesso deste computador.");
    return null;
  }
  return { url, fp: parsed.fp || null, deviceId: res.deviceId, token: res.token, name, via: "code" };
}

/** Endereço digitado → "https://host[/caminho]" sem barra no fim ("" se vazio). */
function typedServerUrl(v) {
  let s = String(v || "").trim();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = `https://${s}`;
  return s.replace(/\/+$/, "");
}

/** "Outro endereço…": pergunta o endereço do servidor para entrar com Google. undefined = desistiu. */
async function askServerUrl(lib, current) {
  const v = await vscode.window.showInputBox({
    title: "Swap Plus: outro endereço",
    prompt: "Endereço do servidor Swap Plus em que você vai entrar com a sua conta Google.",
    value: current,
    placeHolder: "https://swap.exemplo.com",
    ignoreFocusOut: true,
    validateInput: (x) => {
      const u = typedServerUrl(x);
      if (!u) return null;
      if (!/^https:\/\//i.test(u)) return "Use um endereço https://.";
      try {
        lib.createServerClient({ url: u });
        return null;
      } catch (e) {
        return safeErr(e);
      }
    },
  });
  if (v === undefined) return undefined;
  return typedServerUrl(v) || undefined;
}

/** Abre o endereço no navegador. Como texto, o VS Code não mexe na codificação do endereço. */
async function openInBrowser(link) {
  try {
    return !!(await vscode.env.openExternal(link));
  } catch {
    try {
      return !!(await vscode.env.openExternal(vscode.Uri.parse(link, true)));
    } catch {
      return false;
    }
  }
}

function sleepOrCancel(ms, ct) {
  return new Promise((resolve) => {
    let timer = null;
    let sub = null;
    const done = () => {
      clearTimeout(timer);
      if (sub) sub.dispose();
      resolve();
    };
    timer = setTimeout(done, ms);
    sub = ct.onCancellationRequested(done);
  });
}

/** Resolve com { value } / { error } da promessa, ou com CANCELLED se a pessoa cancelar antes. */
function raceCancel(promise, ct) {
  let sub = null;
  const cancel = new Promise((resolve) => {
    sub = ct.onCancellationRequested(() => resolve(CANCELLED));
  });
  return Promise.race([promise.then((value) => ({ value }), (error) => ({ error })), cancel]).finally(() => {
    if (sub) sub.dispose();
  });
}

/** Acesso criado no servidor depois que a pessoa cancelou: revoga (melhor esforço) para não sobrar computador fantasma. */
function revokeOrphanDevice(url, got) {
  try {
    return serverLib()
      .createServerClient({ url, token: got.token, tokenOrigin: url }) // o token acabou de ser emitido por `url`
      .request("DELETE", `/v1/devices/${encodeURIComponent(got.deviceId)}`)
      .catch(() => {});
  } catch {
    return Promise.resolve();
  }
}

/**
 * Espera o resultado do login com Google: consulta POST /v1/login/poll a cada 2 s
 * até expiresAt (máx. 10 min). → { status: "ok", deviceId, token } | { status: "denied", email }
 * | { status: "expired" } | { status: "cancelled" } | { status: "google_off" } | { status: "error", error }
 */
async function waitGoogleLogin(lib, url, start, progress, ct) {
  const t0 = Date.now();
  const exp = Number(start.expiresAt);
  const deadline = Math.min(t0 + GOOGLE_MAX_MS, Number.isFinite(exp) && exp > t0 ? exp : Infinity);
  const body = { url, fp: null, sessionId: start.sessionId, pollToken: start.pollToken };
  let failingSince = 0;
  let note = "";
  let delay = GOOGLE_POLL_MS;
  const say = () => {
    const min = Math.max(1, Math.ceil((deadline - Date.now()) / 60000));
    progress.report({ message: `Entre com a sua conta Google no navegador… ${note || `(o link vale mais ${min} min)`}` });
  };
  say();
  for (;;) {
    if (ct.isCancellationRequested) return { status: "cancelled" };
    await sleepOrCancel(delay, ct);
    if (ct.isCancellationRequested) return { status: "cancelled" };
    if (Date.now() >= deadline) return { status: "expired" };
    delay = GOOGLE_POLL_MS;
    const pending = lib.loginPoll(body);
    const r = await raceCancel(pending, ct);
    if (r === CANCELLED) {
      pending.then((x) => x && x.status === "ok" && revokeOrphanDevice(url, x)).catch(() => {});
      return { status: "cancelled" };
    }
    if (r.error) {
      const e = r.error;
      if (e && e.code === "google_off") return { status: "google_off" };
      if (e && (e.code === "bad_response" || e.code === "tls" || e.code === "bad_url")) return { status: "error", error: e };
      const kind = srvErrKind(e);
      if (kind === "throttled") {
        delay = 15000;
        note = "(o servidor pediu para esperar um pouco)";
        say();
        continue;
      }
      if (kind !== "offline") return { status: "error", error: e };
      // Rede, tempo esgotado ou erro 5xx: tenta de novo por até 1 min seguido.
      if (!failingSince) failingSince = Date.now();
      if (Date.now() - failingSince > GOOGLE_OFFLINE_MAX_MS) return { status: "error", error: e };
      note = "(sem resposta do servidor; tentando de novo…)";
      say();
      continue;
    }
    failingSince = 0;
    note = "";
    const v = r.value || {};
    if (v.status === "pending") {
      say();
      continue;
    }
    return v; // ok | denied | expired
  }
}

/** Uma tentativa de entrar com Google: inicia no servidor, abre o navegador e espera o resultado. */
async function googleAttempt(lib, url, name) {
  let start;
  try {
    start = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Swap Plus: conectando a ${serverHost(url)}...`, cancellable: false },
      () => lib.loginStart({ url, fp: null, name, platform: process.platform })
    );
  } catch (e) {
    return e && e.code === "google_off" ? { status: "google_off" } : { status: "error", error: e };
  }
  if (!(await openInBrowser(start.authUrl))) {
    vscode.window
      .showWarningMessage("Swap Plus: não consegui abrir o navegador. Copie o link, abra no navegador e entre com a sua conta Google.", "Copiar link")
      .then((c) => c && vscode.env.clipboard.writeText(start.authUrl));
  }
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Swap Plus", cancellable: true },
    (progress, ct) => waitGoogleLogin(lib, url, start, progress, ct)
  );
}

/**
 * Entrar com Google → { url, fp: null, deviceId, token, name, via: "google" } ou null
 * (desistiu ou deu erro, já avisado). `askUrl`: pergunta o endereço ("Outro endereço…").
 */
async function connectByGoogle(lib, { askUrl = false } = {}) {
  let url = connectUrl(); // o das configurações do usuário (se mudou, é nele que a pessoa quer entrar)
  if (askUrl) {
    url = await askServerUrl(lib, url);
    if (!url) return null;
  }
  const name = await askDeviceName();
  if (name === undefined) return null;
  for (;;) {
    const r = await googleAttempt(lib, url, name);
    if (r.status === "ok") return { url, fp: null, deviceId: r.deviceId, token: r.token, name, via: "google" };
    if (r.status === "google_off") {
      const c = await vscode.window.showWarningMessage(
        `Swap Plus: o servidor ${serverHost(url)} não está com o login do Google ligado. Conecte com o código de conexão gerado no servidor (comando pair).`,
        "Colar código de conexão"
      );
      return c ? connectByCode(lib, name) : null;
    }
    if (r.status === "denied") {
      // Modo privado: nenhum e-mail na tela, nem o da conta Google negada.
      const who = r.email && !privateMode() ? `a conta Google ${String(r.email).slice(0, 120)}` : "a sua conta Google";
      const c = await vscode.window.showErrorMessage(
        `Swap Plus: ${who} não está liberada neste servidor. Peça ao dono do servidor para liberá-la, ou entre com outra conta.`,
        "Entrar com outra conta"
      );
      if (c === "Entrar com outra conta") continue;
      return null;
    }
    if (r.status === "expired") vscode.window.showWarningMessage("Swap Plus: o tempo para entrar com o Google acabou. Conecte de novo quando quiser.");
    else if (r.status === "cancelled") vscode.window.showInformationMessage("Swap Plus: conexão com o Google cancelada.");
    else vscode.window.showErrorMessage(`Swap Plus: ${googleErrorText(r.error, url)}`);
    return null;
  }
}

/**
 * Caminho de sucesso comum (código ou Google): revoga o acesso anterior deste
 * computador, guarda o token no cofre de segredos e endereço/deviceId/fp no
 * globalState, liga o modo servidor, oferece o envio dos logins e atualiza.
 */
async function finishConnect(got, had) {
  const { url, deviceId, token, name } = got;
  const fp = got.fp || null;
  const via = got.via === "google" ? "google" : "code";
  // Conexão anterior: o cliente é o do servidor que emitiu o token antigo (mesmo que o endereço tenha mudado).
  const old = had ? { meta: serverMeta(), client: await issuerClient() } : null;
  srv.hold = true; // o ciclo espera até o fim (inclusive o envio dos logins)
  try {
    if (refreshing) await refreshing.catch(() => {});
    await srvChain;
    // Conexão anterior: revoga no servidor (melhor esforço), para não sobrar um computador fantasma.
    if (old && old.client && old.meta.deviceId && old.meta.deviceId !== deviceId && !old.meta.revokedAt) {
      try {
        await old.client.request("DELETE", `/v1/devices/${encodeURIComponent(old.meta.deviceId)}`);
      } catch {}
    }
    await extContext.secrets.store(SERVER_TOKEN_KEY, token);
    resetServerConnection();
    srv.token = token;
    srv.state = null;
    srv.lastOkAt = 0;
    srv.lastError = null;
    srv.rejected = null;
    srv.loginRetry = null;
    srv.applyFail = null;
    // url = onde o token foi emitido: é para lá (e só para lá) que ele vai daqui em diante.
    await extContext.globalState.update(SERVER_META_KEY, { url, fp, deviceId, name, via, connectedAt: Date.now() });
    await extContext.globalState.update(SERVER_APPLIED_KEY, undefined);
    // Primeiro o modo (o ciclo está parado por srv.hold), depois o endereço.
    if (!serverMode()) await cfg().update("mode", "server", vscode.ConfigurationTarget.Global);
    if (String(cfg().get("server.url") || "").replace(/\/+$/, "") !== url) await cfg().update("server.url", url, vscode.ConfigurationTarget.Global);
    await syncLoginPrompt();
    await pushHistory([
      { ts: new Date().toISOString(), kind: "info", text: `Conectado ao servidor ${serverHost(url)} como “${name}”${via === "google" ? " (entrou com Google)" : ""}` },
    ]);
    // 1ª conexão a este servidor: oferecer o envio dos logins guardados neste computador.
    const migrated = extContext.globalState.get(SERVER_MIGRATED_KEY) || {};
    if (localEngineHasAccounts() && !migrated[url]) await offerMigration();
  } finally {
    srv.hold = false;
  }
  await refreshFresh();
  const n = state.list ? state.list.activeAccountNumber : null;
  const tail =
    serverStatus() !== "online"
      ? `Ainda sem resposta do servidor: ${srv.lastError || "tento de novo em 30 s"}.`
      : n
        ? `Este computador está na conta ${n}.`
        : "O servidor ainda não tem conta para este computador: entre com uma conta no Claude Code e o login vai para o servidor.";
  vscode.window.showInformationMessage(`Swap Plus: conectado ao servidor ${serverHost()}. ${tail}`);
  // 1ª conexão a este servidor: regras de troca daqui diferentes das de lá? Oferece levá-las.
  await offerLocalRules(url);
}

async function offerMigration() {
  const c = await vscode.window.showInformationMessage(
    "Enviar os logins deste computador para o servidor?",
    {
      modal: true,
      detail:
        "O Swap Plus lê as contas guardadas neste computador (motor swap-plus) e envia o login de cada uma ao servidor, que passa a ser o único a renovar. Contas que o servidor já tem funcionando ficam como estão. Nada é apagado deste computador.\n\nO login em uso agora no Claude Code vai para o servidor de qualquer jeito.",
    },
    "Enviar os logins"
  );
  if (c === "Enviar os logins") await migrateLocalLogins();
}

function removeDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

/**
 * "Enviar os logins deste computador": swap-plus list (planos) + export para um
 * arquivo temporário numa pasta só do seu usuário → cada conta com refresh token
 * vai para POST /v1/logins → o temporário é apagado na hora. Única vez em que o
 * modo servidor chama o motor local.
 */
async function migrateLocalLogins() {
  if (!swapOn()) {
    vscode.window.showInformationMessage("Swap Plus está desligado: ligue-o para enviar os logins.");
    return null;
  }
  if (!serverMode()) {
    // No modo local o motor daqui é quem renova: mandar os logins ao servidor faria os dois renovarem a mesma conta.
    vscode.window.showInformationMessage(
      "Swap Plus: “Enviar os logins deste computador” só funciona no modo servidor. Ligue o modo servidor (Configurações → Servidor) e tente de novo."
    );
    return null;
  }
  let client = null;
  try {
    client = await serverClient({ timeoutMs: LOGIN_POST_TIMEOUT_MS }); // o servidor renova cada login na hora
  } catch {}
  if (!client || serverStatus() === "revoked") {
    vscode.window.showErrorMessage(`Swap Plus: ${serverErrorLine() || "conecte este computador ao servidor antes."}`);
    return null;
  }
  const prevHold = srv.hold;
  srv.hold = true;
  let dir = null;
  let out = null;
  try {
    if (!prevHold) {
      if (refreshing) await refreshing.catch(() => {});
      await srvChain;
    }
    out = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "Swap Plus: enviando os logins deste computador ao servidor...", cancellable: false },
      async (progress) => {
        // 1) O que o servidor já tem: conta viva lá não recebe a cópia daqui (a de lá é a mais nova).
        let remote = [];
        try {
          const st = await client.request("GET", "/v1/state");
          if (applyStateResponse(st)) remote = st.list.accounts;
        } catch (e) {
          if (srvErrKind(e) !== "rejected") {
            await serverFailed(e, "envio dos logins");
            return { error: srvErrText(e) };
          }
        }
        // 2) Planos (list) e logins (export) do motor local.
        progress.report({ message: "lendo as contas deste computador" });
        const list = parseJson((await runCswap(["list", "--json"])).stdout);
        dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-envio-")); // pasta só do seu usuário
        const file = path.join(dir, "contas.cswap");
        const r = await runCswap(["export", file], 120000);
        let env = null;
        try {
          env = JSON.parse(fs.readFileSync(file, "utf8"));
        } catch {}
        removeDir(dir); // apaga o temporário assim que leu
        dir = null;
        if (r.code !== 0 || !env || !Array.isArray(env.accounts)) {
          return { error: `não consegui ler os logins guardados neste computador: ${lastLine(r.stderr) || r.spawnError || "o motor não gerou o arquivo"}` };
        }
        // 3) Login em uso no Claude Code: é o mais novo da conta dele.
        const live = await readLiveSafe(claudeAuth());
        const results = [];
        let abort = null;
        let i = 0;
        for (const a of env.accounts) {
          i++;
          progress.report({ message: `conta ${i} de ${env.accounts.length}` });
          const label = privateMode() ? `Conta ${a.number}` : `Conta ${a.number} (${a.email})`;
          if (abort) {
            results.push({ label, ok: false, reason: `não enviada: ${abort}` });
            continue;
          }
          const email = String(a.email || "").toLowerCase();
          const org = a.organizationUuid || "";
          if (a.kind === "api_key" || !a.credentials || typeof a.credentials !== "object") {
            results.push({ label, ok: false, reason: "é uma chave de API, não um login de conta" });
            continue;
          }
          const oauthAccount = a.config && a.config.oauthAccount;
          let oauth = a.credentials.claudeAiOauth;
          let isLive = false;
          if (live.oauth && live.oauth.refreshToken && live.who && live.who.email === email && (!live.who.orgUuid || !org || live.who.orgUuid === org)) {
            oauth = live.oauth;
            isLive = true;
          }
          if (!oauth || !oauth.refreshToken) {
            results.push({ label, ok: false, reason: "não tem login guardado completo (sem refresh token)" });
            continue;
          }
          if (!oauthAccount || !oauthAccount.emailAddress) {
            results.push({ label, ok: false, reason: "faltam os dados da conta (oauthAccount)" });
            continue;
          }
          const there = remote.find(
            (x) => String(x.email || "").toLowerCase() === email && (!org || !x.organizationUuid || x.organizationUuid === org)
          );
          if (there && !loginDead(there) && !isLive) {
            results.push({ label, ok: false, skip: true, reason: `o servidor já tem esta conta funcionando (conta ${there.number} lá); o login de lá foi mantido` });
            continue;
          }
          const la = list && Array.isArray(list.accounts) ? list.accounts.find((x) => x.number === a.number) : null;
          const body = { claudeAiOauth: oauth, oauthAccount };
          if (la && la.plan && la.plan.label) body.plan = { label: la.plan.label };
          try {
            const res = await client.request("POST", "/v1/logins", body);
            results.push({ label, ok: true, number: res.number, created: !!res.created });
            if (isLive) await markLoginSent(loginKey(live), "sent"); // o ciclo não reenvia (e pode gravar por cima)
          } catch (e) {
            if (srvErrKind(e) === "rejected") {
              if (isLive && (e.code === "dead_login" || e.code === "stale_login" || e.code === "identity_mismatch_spent")) await markLoginSent(loginKey(live), "dead");
              results.push({ label, ok: false, reason: loginRejectReason(e) });
            } else {
              abort = srvErrText(e);
              results.push({ label, ok: false, reason: `não enviada: ${abort}` });
            }
          }
        }
        return { results };
      }
    );
  } finally {
    if (dir) removeDir(dir);
    srv.hold = prevHold;
  }
  if (!out) return null;
  if (out.error) {
    vscode.window.showErrorMessage(`Swap Plus: ${out.error}`);
    return null;
  }
  const results = out.results;
  const ok = results.filter((x) => x.ok);
  const skipped = results.filter((x) => x.skip);
  const bad = results.filter((x) => !x.ok && !x.skip);
  const head =
    `${ok.length} ${ok.length === 1 ? "login aceito" : "logins aceitos"} pelo servidor` +
    (skipped.length ? `, ${skipped.length} já ${skipped.length === 1 ? "estava" : "estavam"} lá` : "") +
    (bad.length ? `, ${bad.length} ${bad.length === 1 ? "recusado" : "recusados"}` : "");
  const lines = [
    ...ok.map((x) => `✓ ${x.label} → conta ${x.number} no servidor${x.created ? " (nova)" : " (atualizada)"}`),
    ...skipped.map((x) => `• ${x.label}: ${x.reason}`),
    ...bad.map((x) => `✗ ${x.label}: ${x.reason}`),
  ];
  const migrated = extContext.globalState.get(SERVER_MIGRATED_KEY) || {};
  await extContext.globalState.update(SERVER_MIGRATED_KEY, { ...migrated, [serverUrl()]: Date.now() });
  await pushHistory([{ ts: new Date().toISOString(), kind: bad.length ? "warn" : "info", text: `Logins deste computador enviados ao servidor: ${head}` }]);
  if (!prevHold) await refreshFresh();
  post({ type: "toast", kind: bad.length ? "error" : "info", text: `${cap(head)}.` });
  vscode.window.showInformationMessage(safe(`Swap Plus: ${head}.`), {
    modal: true,
    detail: safe(
      `${lines.join("\n")}\n\nAs cópias guardadas pelo motor neste computador continuam aqui, mas agora quem renova esses logins é o servidor. Não use o modo local com essas contas (nem neste nem em outro computador): ao renovar aqui, elas morrem no servidor.`
    ),
  });
  return { ok: ok.length, skipped: skipped.length, bad: bad.length };
}

async function forgetServer() {
  try {
    if (extContext.secrets) await extContext.secrets.delete(SERVER_TOKEN_KEY);
  } catch {}
  await extContext.globalState.update(SERVER_META_KEY, undefined);
  await extContext.globalState.update(SERVER_APPLIED_KEY, undefined);
  resetServerConnection();
  releaseOwner();
  srv.token = null;
  srv.state = null;
  srv.lastOkAt = 0;
  srv.lastError = null;
  srv.rejected = null;
  srv.loginRetry = null;
  srv.applyFail = null;
  srv.discard = null;
  srv.storeWarnings = [];
}

/** Comando "Desconectar do servidor": revoga este computador no servidor e apaga o acesso guardado. */
async function disconnectServer() {
  const token = await serverToken();
  if (!token) {
    if (serverMode()) {
      await holdServer(() => cfg().update("mode", "local", vscode.ConfigurationTarget.Global));
      await syncLoginPrompt();
      vscode.window.showInformationMessage("Swap Plus: este computador não estava conectado a um servidor. Modo local ligado.");
    } else {
      vscode.window.showInformationMessage("Swap Plus: este computador não está conectado a nenhum servidor.");
    }
    return;
  }
  const OFF = "Desconectar e desligar o Swap Plus";
  const LOCAL = "Desconectar e usar o modo local";
  const c = await vscode.window.showWarningMessage(
    `Desconectar este computador do servidor ${serverHost()}?`,
    {
      modal: true,
      detail:
        "O servidor deixa de mandar o login para este computador. O Claude Code fica com o acesso atual até ele vencer (algumas horas); depois disso, entre de novo com uma conta.\n\n• Desligar o Swap Plus: o mais seguro se outros computadores continuam usando o servidor.\n• Modo local: o motor swap-plus deste computador volta a cuidar das contas guardadas aqui — mas, ao renovar uma conta que o servidor também tem, ela morre no servidor.",
    },
    OFF,
    LOCAL
  );
  if (c !== OFF && c !== LOCAL) return postState();
  await holdServer(async () => {
    const meta = serverMeta();
    // Revoga no servidor que emitiu o token (o endereço da conexão), mesmo que o das configurações tenha mudado.
    const client = await issuerClient();
    if (client && meta.deviceId && !meta.revokedAt) {
      try {
        await client.request("DELETE", `/v1/devices/${encodeURIComponent(meta.deviceId)}`);
      } catch {}
    }
    await forgetServer();
    if (c === OFF) await cfg().update("enabled", false, vscode.ConfigurationTarget.Global);
    if (serverMode()) await cfg().update("mode", "local", vscode.ConfigurationTarget.Global);
  });
  await syncLoginPrompt();
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: c === OFF ? "Desconectado do servidor; Swap Plus desligado" : "Desconectado do servidor; modo local ligado" }]);
  postState();
  vscode.window.showInformationMessage(
    c === OFF
      ? "Swap Plus: desconectado do servidor e desligado. O Claude Code fica normal."
      : "Swap Plus: desconectado do servidor. Modo local ligado. Se alguma conta aparecer como “Login morto”, entre de novo com ela no Claude Code."
  );
}

/** Revogar outro computador (a lista vem do servidor). */
async function revokeDevice(id) {
  if (!id) return;
  const me = serverMeta();
  if (id === me.deviceId) return disconnectServer();
  const d = srv.state && (srv.state.devices || []).find((x) => String(x.id) === id);
  const name = d ? d.name : "este computador";
  const c = await vscode.window.showWarningMessage(
    `Revogar o acesso de “${name}”?`,
    {
      modal: true,
      detail:
        "Ele para de receber o login das contas na hora. O Claude Code dele fica com o acesso atual até vencer (algumas horas). Para voltar, ele precisa conectar de novo (entrando com uma conta Google liberada no servidor ou com um código novo). Para impedir de vez, tire também a conta Google dele da lista de liberadas no servidor.",
    },
    "Revogar"
  );
  if (c !== "Revogar") return;
  const resp = await serverCall("DELETE", `/v1/devices/${encodeURIComponent(id)}`, undefined, `revogar “${name}”`);
  if (!resp) return;
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Acesso de “${name}” revogado no servidor` }]);
  await refreshFresh();
  post({ type: "toast", kind: "info", text: `Acesso de “${name}” revogado.` });
}

function serverCheckText() {
  if (serverStatus() !== "online") return cap(serverErrorLine() || "sem resposta do servidor");
  const n = state.list ? state.list.activeAccountNumber : null;
  return n ? `Servidor consultado: este computador está na conta ${n}.` : "Servidor consultado: ainda sem conta para este computador.";
}

/** Última decisão do servidor para este computador (troca, bloqueio...), para o cartão da troca automática. */
function serverLastDecision() {
  const st = srv.state;
  if (!st || !Array.isArray(st.history)) return null;
  const me = serverMeta();
  const h = st.history.find((x) => ["switch", "blocked", "manual", "error"].includes(x.kind) && (!x.device || x.device === me.deviceId || x.device === me.name));
  return h ? { ts: h.ts, kind: h.kind, text: safe(h.text) } : null;
}

/** Histórico da tela: no modo servidor, o do servidor + o deste computador desde a conexão. */
function historyPayload() {
  const local = extContext.globalState.get(HISTORY_KEY) || [];
  const fmt = (h) => ({ ...h, text: safe(h.text), when: fmtWhen(h.ts) });
  if (!serverMode() || !srv.state || !Array.isArray(srv.state.history)) return local.map(fmt);
  const names = {};
  for (const d of srv.state.devices || []) names[d.id] = d.name;
  const since = serverMeta().connectedAt || 0;
  // Computador que saiu da lista (revogado): vale o nome que veio no próprio histórico (deviceName).
  const devName = (h) => names[h.device] || (typeof h.deviceName === "string" && h.deviceName.trim() ? h.deviceName.trim().slice(0, 60) : null) || (String(h.device).length > 24 ? "outro computador" : String(h.device));
  const remote = srv.state.history.map((h) => ({ ts: h.ts, kind: h.kind, text: h.text, who: h.device ? devName(h) : "servidor" }));
  const mine = local.filter((h) => (tsMs(h.ts) || 0) >= since).map((h) => ({ ...h, who: "este computador" }));
  return [...remote, ...mine]
    .sort((a, b) => (tsMs(b.ts) || 0) - (tsMs(a.ts) || 0))
    .slice(0, 60)
    .map(fmt);
}

/** Cartão "Servidor" da tela. */
function serverPayload() {
  const meta = serverMeta();
  const st = srv.state;
  const priv = privateMode();
  const accName = (n) => {
    if (n === null || n === undefined) return "nenhuma conta";
    const a = st && st.list && st.list.accounts.find((x) => x.number === n);
    return priv || !a || !a.email ? `Conta ${n}` : `Conta ${n} — ${a.email}`;
  };
  const devices =
    st && Array.isArray(st.devices)
      ? st.devices.map((d) => {
          const seen = tsMs(d.lastSeen);
          const google = typeof d.googleEmail === "string" && d.googleEmail ? d.googleEmail : null;
          return {
            id: String(d.id),
            name: String(d.name || d.id),
            current: !!d.current || d.id === meta.deviceId,
            account: accName(d.assigned),
            // Conta Google com que o computador entrou (modo privado: só diz que foi com Google, sem o e-mail).
            google: !!google,
            googleEmail: priv ? null : google,
            active: typeof d.active === "boolean" ? d.active : !isNaN(seen) && Date.now() - seen < DEVICE_ACTIVE_MS,
            lastSeenWhen: isNaN(seen) ? null : fmtWhen(seen),
          };
        })
      : [];
  const dg = st && st.diag ? st.diag : null;
  const status = serverStatus();
  const migratedAt = (extContext.globalState.get(SERVER_MIGRATED_KEY) || {})[serverUrl()] || null;
  return {
    mode: serverMode() ? "server" : "local",
    status,
    statusText: serverStatusText(status),
    connected: !!srv.token,
    connecting,
    url: serverUrl() || null,
    host: serverHost() || null,
    via: srv.token ? meta.via || null : null,
    deviceName: meta.name || null,
    lastOkWhen: lastContactText(),
    version: st && st.version ? String(st.version) : null,
    devices,
    diag: dg
      ? { value: typeof dg.oldTokenValidAfterRefresh === "boolean" ? dg.oldTokenValidAfterRefresh : null, when: dg.checkedAt ? fmtWhen(dg.checkedAt) : null }
      : null,
    rejected: srv.rejected ? { reason: srv.rejected.reason } : null,
    // Só no modo servidor: no modo local o motor daqui é quem renova esses logins.
    canMigrate: serverMode() && !!srv.token && localEngineHasAccounts(),
    addressChanged: serverMode() && serverAddressChanged(),
    configuredUrl: configuredServerUrl() || null,
    storeWarnings: serverMode() ? (srv.storeWarnings || []).map(safe) : [],
    storeBlocked: serverMode() && !!storeBlockReason(),
    loginPromptOff: serverMode() && !!(extContext.globalState.get(LOGIN_PROMPT_KEY) || {}).applied,
    loginPromptNote: LOGIN_PROMPT_NOTE,
    otherWindow: serverMode() && srv.owner === false && serverStatus() === "online",
    migratedWhen: migratedAt ? fmtWhen(migratedAt) : null,
  };
}

// ---------------------------------------------------------------- tela de configurações

function winPayload(win, line) {
  const ts = win.resetsAt ? Date.parse(win.resetsAt) : NaN;
  return {
    pct: win.pct,
    in: resetIn(win.resetsAt),
    when: win.resetsAt ? fmtWhen(win.resetsAt) : null,
    resetTs: isNaN(ts) ? null : ts,
    level: level(win.pct, line),
    idle: !!win.idle,
  };
}

function buildPayload() {
  const list = state.list;
  const r = rules();
  const priv = privateMode();
  const accounts = list
    ? list.accounts.map((acc) => {
        const w = windows(acc);
        const l = linesFor(acc, r, state.records);
        const rec = accountRecord(acc.number);
        return {
          number: acc.number,
          email: priv ? null : acc.email,
          alias: priv ? null : accountAlias(acc),
          org: priv ? "" : acc.organizationName || "",
          plan: (acc.plan && acc.plan.label) || "",
          active: acc.number === list.activeAccountNumber,
          status: acc.usageStatus,
          statusLabel: statusLabel(acc.usageStatus),
          loginDead: loginDead(acc),
          stale: w ? w.stale : false,
          ageMin: w && typeof w.ageSeconds === "number" ? Math.round(w.ageSeconds / 60) : null,
          lines: l,
          session: w ? winPayload(w.session, l.session) : null,
          weekly: w && w.weekly ? winPayload(w.weekly, l.weekly) : null,
          models: w ? w.models.map((m) => ({ name: m.name, ...winPayload(m, l.model) })) : [],
          disabled: !!rec.disabled,
          threshold: rec.threshold,
          priority: rec.priority || 0,
          // Modo servidor: computadores que estão usando esta conta agora.
          devices: Array.isArray(acc.assignedDevices) ? acc.assignedDevices.map(String) : [],
        };
      })
    : [];
  const names = scopedNames(list);
  const isServer = serverMode();
  const last = isServer ? serverLastDecision() : extContext.globalState.get(LAST_TICK_KEY) || null;
  return {
    type: "state",
    error: state.error ? safe(state.error) : null,
    serverMode: isServer,
    server: serverPayload(),
    fetchedAt: state.fetchedAt,
    accounts,
    modelNames: names,
    modelsInUse: state.models.map((m) => ({ id: m.id, label: m.label, minutesAgo: Math.max(0, Math.round((Date.now() - m.ts) / 60000)) })),
    watch: watchedModels(state.models.map((m) => m.id), names),
    rules: r,
    alerts: alertSettings(),
    swapOn: swapOn(),
    auto: {
      enabled: isServer ? !!(srv.state && srv.state.autoSwitch) : !!cfg().get("autoSwitch.enabled"),
      last,
      lastWhen: last && last.ts ? fmtWhen(last.ts) : null,
      history: historyPayload(),
    },
    privacy: priv,
    unmanaged: state.unmanaged ? { email: priv ? null : state.unmanaged.email } : null,
    claudeCode: claudeCodeStatus(),
    updates: updater ? (() => { const u = updater.summary(); if (u.last) u.last.when = fmtWhen(u.last.ts); return u; })() : null,
    ui: {
      showAccountNumber: !!cfg().get("statusBar.showAccountNumber"),
      showModelWeekly: !!cfg().get("statusBar.showModelWeekly"),
      pollIntervalMinutes: Number(cfg().get("pollIntervalMinutes")) || 1,
    },
  };
}

function postState() {
  if (panel) panel.webview.postMessage(buildPayload());
}

function post(msg) {
  if (panel) panel.webview.postMessage(msg);
}

function openSettings() {
  if (panel) {
    panel.reveal(vscode.ViewColumn.One);
    refresh();
    return;
  }
  const media = vscode.Uri.joinPath(extContext.extensionUri, "media");
  panel = vscode.window.createWebviewPanel(`${NS}.settings`, "Swap Plus", vscode.ViewColumn.One, {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [media],
  });
  panel.iconPath = vscode.Uri.joinPath(extContext.extensionUri, "icon.png");
  const nonce = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.css"));
  const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(media, "panel.js"));
  const html = fs.readFileSync(path.join(extContext.extensionPath, "media", "panel.html"), "utf8");
  panel.webview.html = html
    .replace(/\{\{csp\}\}/g, panel.webview.cspSource)
    .replace(/\{\{nonce\}\}/g, nonce)
    .replace(/\{\{css\}\}/g, String(css))
    .replace(/\{\{js\}\}/g, String(js));
  panel.onDidDispose(() => {
    panel = undefined;
  });
  panel.webview.onDidReceiveMessage((m) => handleMessage(m).catch((e) => post({ type: "toast", kind: "error", text: String(e && e.message ? e.message : e) })));
}

const RULE_SETTINGS = {
  sessionPct: "rules.sessionSwitchPct",
  weeklyPct: "rules.weeklySwitchPct",
  modelPct: "rules.modelSwitchPct",
  preferModel: "rules.preferModel",
  strategy: "rules.strategy",
  expiringHours: "rules.expiringHours",
  cooldownMin: "rules.cooldownMinutes",
  marginPct: "rules.marginPct",
  intervalSec: "rules.intervalSeconds",
  onModelLimit: "rules.onModelLimit",
};

/** Avisos ("avisar em X%"): sempre deste computador, nas configurações do VS Code. */
async function saveAlerts(alerts) {
  const ca = alertSettings();
  for (const k of Object.keys(ca)) {
    if (!(k in alerts) || alerts[k] === ca[k]) continue;
    const v = typeof ca[k] === "boolean" ? !!alerts[k] : Math.max(1, Math.min(100, Number(alerts[k]) || ca[k]));
    await cfg().update(`alerts.${k}`, v, vscode.ConfigurationTarget.Global);
  }
}

async function handleMessage(m) {
  switch (m.type) {
    case "ready":
    case "refresh":
      postState();
      await refresh();
      return;

    case "setAuto":
      if (serverMode()) return setServerAuto(!!m.enabled);
      await cfg().update("autoSwitch.enabled", !!m.enabled, vscode.ConfigurationTarget.Global);
      return; // onDidChangeConfiguration cuida do resto

    case "setEnabled":
      await setEnabled(!!m.enabled);
      return;

    case "checkNow": {
      if (serverMode()) {
        if (m.dryRun) {
          post({ type: "toast", kind: "info", text: "No modo servidor quem decide é o servidor: a simulação não está disponível." });
          return;
        }
        post({ type: "busy", on: true, text: "Consultando o servidor..." });
        await refreshFresh();
        post({ type: "busy", on: false });
        post({ type: "toast", kind: serverStatus() === "online" ? "info" : "error", text: serverCheckText() });
        return;
      }
      post({ type: "busy", on: true, text: m.dryRun ? "Simulando..." : "Verificando..." });
      const res = await autoTick({ manual: true, dryRun: !!m.dryRun });
      post({ type: "busy", on: false });
      if (res) post({ type: "toast", kind: res.kind === "error" ? "error" : "info", text: (m.dryRun ? "Simulação: " : "") + res.text });
      return;
    }

    case "saveRules": {
      if (serverMode()) return saveServerRules(m);
      const cur = rules();
      for (const [k, key] of Object.entries(RULE_SETTINGS)) {
        if (!m.rules || !(k in m.rules) || m.rules[k] === cur[k]) continue;
        await cfg().update(key, m.rules[k], vscode.ConfigurationTarget.Global);
      }
      if (m.alerts && typeof m.alerts === "object") await saveAlerts(m.alerts);
      setupAuto();
      syncMotorLines().catch(() => {});
      render();
      postState();
      if (autoEnabled()) {
        // Aplica as regras novas na hora, em vez de esperar o próximo ciclo.
        const res = await autoTick({ manual: true });
        post({ type: "toast", kind: res && res.kind === "error" ? "error" : "info", text: `Regras salvas. ${res ? res.text : ""}`.trim() });
      } else {
        post({ type: "toast", kind: "info", text: "Regras salvas." });
      }
      return;
    }

    case "account": {
      if (serverMode()) return serverAccountOp(m);
      const n = String(m.number);
      let args;
      if (m.op === "disabled") args = [m.value ? "disable" : "enable", n];
      else if (m.op === "threshold") args = m.value === null || m.value === "" ? ["threshold", n, "--unset"] : ["threshold", n, String(m.value)];
      else if (m.op === "priority") args = ["priority", n, String(m.value === null || m.value === "" ? 0 : m.value)];
      else if (m.op === "alias") args = m.value ? ["alias", n, String(m.value)] : ["alias", n, "--unset"];
      else return;
      const r = await runCswapWrite(args);
      if (r.code !== 0) post({ type: "toast", kind: "error", text: `Conta ${n}: ${lastLine(r.stderr) || lastLine(r.stdout) || r.spawnError || "erro"}` });
      await refreshFresh();
      return;
    }

    case "switch":
      await doSwitch(m.number);
      return;

    case "move": {
      if (serverMode()) {
        post({ type: "toast", kind: "info", text: "No modo servidor o número de cada conta é dado pelo servidor e não muda daqui." });
        return;
      }
      // Reordenar: troca a posição (número) com a conta vizinha. O swap-plus leva
      // junto apelido, ajustes, cópias e histórico; a sessão aberta não é tocada.
      const nums = state.list ? state.list.accounts.map((a) => a.number).sort((a, b) => a - b) : [];
      const i = nums.indexOf(Number(m.number));
      const j = m.dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= nums.length) return;
      post({ type: "busy", on: true, text: "Reordenando..." });
      const r = await runCswapWrite(["swap", String(nums[i]), String(nums[j])], 60000);
      post({ type: "busy", on: false });
      if (r.code !== 0) post({ type: "toast", kind: "error", text: `Não consegui reordenar: ${lastLine(r.stderr) || lastLine(r.stdout) || r.spawnError || "erro"}` });
      else await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Contas ${nums[i]} e ${nums[j]} trocaram de posição` }]);
      await refreshFresh();
      return;
    }

    case "add":
      addAccount();
      return;

    case "ui": {
      const allowed = ["statusBar.showAccountNumber", "statusBar.showModelWeekly", "pollIntervalMinutes", "privacy.hideEmails"];
      if (!allowed.includes(m.key)) return;
      await cfg().update(m.key, m.value, vscode.ConfigurationTarget.Global);
      return;
    }

    case "prepareClaudeCode": {
      const res = prepareClaudeCode();
      postState();
      if (!res.ok) post({ type: "toast", kind: "error", text: `Claude Code: ${res.error}` });
      else post({ type: "toast", kind: "info", text: res.changes.length ? `Claude Code pronto: ${res.changes.join("; ")}. Vale para as próximas conversas.` : "O Claude Code já estava pronto." });
      return;
    }

    case "export":
      await exportAccounts(m.mode === "other" ? "other" : "me");
      return;

    case "import":
      await importAccounts();
      return;

    case "checkUpdates": {
      post({ type: "busy", on: true, text: "Verificando atualizações..." });
      const r = updater ? await updater.runCheck({ reason: "manual" }) : null;
      post({ type: "busy", on: false });
      postState();
      if (r && r.error) post({ type: "toast", kind: "error", text: `Não consegui falar com o GitHub: ${r.error}` });
      else if (r) post({ type: "toast", kind: "info", text: "Verificação concluída." });
      return;
    }

    case "clearHistory":
      await extContext.globalState.update(HISTORY_KEY, []);
      postState();
      return;

    // ---- modo servidor
    case "setMode":
      await setMode(m.mode === "server" ? "server" : "local");
      return;

    case "connectServer":
      await connectServer(typeof m.method === "string" ? m.method : undefined);
      return;

    case "disconnectServer":
      await disconnectServer();
      return;

    case "revokeDevice":
      await revokeDevice(String(m.id || ""));
      return;

    case "migrate":
      await migrateLocalLogins();
      return;

    case "useServerAccount":
      await useServerAccount();
      return;
  }
}

// ---------------------------------------------------------------- ciclo de vida

function activate(context) {
  extContext = context;

  mainItem = vscode.window.createStatusBarItem(`${NS}.main`, vscode.StatusBarAlignment.Left, 105);
  mainItem.name = "Swap Plus";
  mainItem.command = `${NS}.switchAccount`;
  context.subscriptions.push(mainItem);

  context.subscriptions.push(
    vscode.commands.registerCommand(`${NS}.switchAccount`, switchAccount),
    vscode.commands.registerCommand(`${NS}.openSettings`, openSettings),
    vscode.commands.registerCommand(`${NS}.toggleAuto`, toggleAuto),
    vscode.commands.registerCommand(`${NS}.toggleEnabled`, toggleEnabled),
    vscode.commands.registerCommand(`${NS}.addAccount`, addAccount),
    vscode.commands.registerCommand(`${NS}.refreshStatus`, refresh),
    vscode.commands.registerCommand(`${NS}.switchBest`, switchBest),
    vscode.commands.registerCommand(`${NS}.exportOther`, () => exportAccounts("other")),
    vscode.commands.registerCommand(`${NS}.exportMe`, () => exportAccounts("me")),
    vscode.commands.registerCommand(`${NS}.importAccounts`, importAccounts),
    vscode.commands.registerCommand(`${NS}.checkUpdates`, () => updater && updater.runCheck({ reason: "manual" })),
    vscode.commands.registerCommand(`${NS}.connectServer`, connectServer),
    vscode.commands.registerCommand(`${NS}.disconnectServer`, disconnectServer)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(NS)) return;
      const onOff = e.affectsConfiguration(`${NS}.enabled`);
      const modeChange = e.affectsConfiguration(`${NS}.mode`) || e.affectsConfiguration(`${NS}.server.url`);
      if (modeChange) onServerModeChanged();
      else if (onOff && !swapOn()) releaseOwner();
      // Tela de login do Claude Code: desligada só enquanto o modo servidor está ligado (e conectado).
      if (onOff || modeChange) syncLoginPrompt();
      if (onOff || modeChange || e.affectsConfiguration(`${NS}.pollIntervalMinutes`) || e.affectsConfiguration(`${NS}.executablePath`)) setupPolling();
      if (onOff || modeChange || e.affectsConfiguration(`${NS}.autoSwitch.enabled`) || e.affectsConfiguration(`${NS}.rules.intervalSeconds`)) setupAuto();
      if ((onOff || modeChange) && swapOn() && !serverMode()) syncMotorLines().catch(() => {});
      render();
      postState();
    })
  );

  // Token deste computador no servidor guardado/apagado por outra janela do VS Code.
  if (context.secrets && typeof context.secrets.onDidChange === "function") {
    context.subscriptions.push(
      context.secrets.onDidChange((e) => {
        if (e.key !== SERVER_TOKEN_KEY) return;
        resetServerConnection();
        syncLoginPrompt();
        if (serverMode()) refreshFresh();
      })
    );
  }

  setupPolling();
  setupAuto();
  setupOwnerTimer();
  // Lê do cofre do VS Code se este computador está conectado a um servidor (para a tela e a barra).
  serverToken()
    .then(() => {
      syncLoginPrompt();
      return serverMode() ? finishSync() : postState();
    })
    .catch(() => {});

  // Modo servidor: o atualizador não consulta nem oferece o motor (swap-plus), que não é usado.
  updater = createUpdater({ context, cfg, cliVersion, engineWanted: () => !serverMode(), onCliUpdated: refresh, pushHistory, postState });
  updater.start();

  setupLimitWatch();
  watchAccounts();
  setTimeout(() => syncMotorLines().catch(() => {}), 8000);
}

function deactivate() {
  autoGen++;
  if (pollTimer) clearInterval(pollTimer);
  if (autoTimer) clearTimeout(autoTimer);
  if (limitTimer) clearInterval(limitTimer);
  if (ownerTimer) clearInterval(ownerTimer);
  releaseOwner(); // outra janela assume o batimento logo (a configuração de login do Claude Code fica: o modo servidor continua)
  if (updater) {
    updater.stop();
    return updater.onClose().catch(() => {}); // verificação ao fechar o VS Code
  }
}

module.exports = { activate, deactivate, _test: { serverMode, serverStatus, refreshFresh, safeErr, loginKey, syncCredential, historyPayload, applyStateResponse, buildPayload, serverSwitch, syncLoginPrompt, ownerFile, uploadLockDir, srv, addAccount, saveLiveLogin, liveIdentity, loginDead, swapOn, newerInstalledVersion, scanLimitErrors, checkLimitErrors, limitLabel, syncMotorLines, waitMotorSync, nearLine, setLimitRoot: (r) => (limitRoot = r), claudeCodeStatus, prepareClaudeCode, orderForDisplay, readExportFile, copyFileAny, writeFileAny, removeFileAny, shellFile, decide, pickerTexts, windows, linesFor, level, watchedModels, modelLabel, detectModels, getUpdater: () => updater } };
