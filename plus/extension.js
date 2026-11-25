"use strict";
// Swap Plus — fork pessoal de smith89k/claude-swap-status (MIT).
//
// - Barra de status: um único item, com ícone de e-mail (endereço no hover),
//   sessão de 5h, semanal e limites semanais por modelo (ex.: Fable).
// - Clique na barra: lista de contas, com "Configurações" em primeiro.
// - Modo privado: mostra só "Conta N", sem e-mail.
// - 3.0 (só servidor): um servidor Swap Plus guarda os logins, renova e decide as
//   trocas (com as regras do rules.js) para todos os computadores; este computador
//   recebe só o acesso da conta escolhida para ele. Ver a seção "servidor" abaixo.
//   Sem conexão, a barra e a tela mostram "não conectado" com "Entrar com Google".
// - O motor antigo (CLI swap-plus/cswap, do antigo modo local) não é mais usado:
//   na primeira abertura da 3.0 ele é desinstalado (seção "motor antigo").

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
  RULE_DEFAULTS,
} = require("./rules");
const modelSwitch = require("./modelSwitch");
const resume = require("./resume");
const travas = require("./travas");
const { createInventory } = require("./transcricoes");

const NS = "swapPlus";
const HISTORY_KEY = "swapPlus.autoHistory";
const LAST_SWITCH_KEY = "swapPlus.lastAutoSwitch";
const ALERTED_KEY = "swapPlus.alerted";
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
  unknown: "sem leitura ainda", // conta que o servidor ainda não consultou
};

let extContext;
let mainItem;
let panel;
let pollTimer;
let refreshing = null;
let updater = null;
let state = { list: null, records: {}, models: [], error: null, fetchedAt: 0 };

// Servidor: conexão e último estado recebido (detalhes na seção "servidor").
const srv = {
  token: undefined, // token deste computador no servidor; undefined = ainda não lido do cofre do VS Code
  client: null,
  clientKey: "",
  state: null, // última resposta de estado do servidor
  status: null, // null | "online" | "offline" | "revoked"
  lastOkAt: 0,
  lastError: null,
  hold: false, // conexão, desligar ou desconectar em andamento: o ciclo espera
  rejected: null, // { key, at, reason }: login atual recusado pelo servidor (não é apagado)
  loginRetry: null, // { key, at }: o servidor não conseguiu conferir o login agora (refresh_failed...): tenta de novo em ~1 min
  applyFail: null, // { key, at }: falha ao gravar a credencial (espera 1 min)
  discard: null, // login recusado que a pessoa decidiu trocar pela conta do servidor
  uploadDenied: false, // o servidor recusou um envio de login (403 not_admin): este computador não envia logins até conectar de novo
  deniedKey: null, // login (hash) não enviado porque este computador não envia logins: a conta do servidor pode ir por cima
  deniedWarned: null, // login (hash) cujo aviso "não foi enviado" já apareceu
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

// Regra do servidor: computadores em contas separadas (padrão) ou todos juntos na mesma conta.
const DEVICE_PLACEMENTS = ["separate", "together"];

/** Regras de troca: as do servidor (valem para todos os computadores). Sem resposta do servidor ainda: as padrão. */
function rules() {
  const r = { ...RULE_DEFAULTS, ...((srv.state && srv.state.rules) || {}) };
  if (!STRATEGY_LABELS[r.strategy]) r.strategy = "max";
  if (!DEVICE_PLACEMENTS.includes(r.devicePlacement)) r.devicePlacement = "separate";
  return r;
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

// Inventário das transcrições (transcricoes.js): um só para a procura do limite e para o modelo em uso.
const transcripts = createInventory();

/** <pasta de config do Claude Code>/projects, calculado na hora (respeita CLAUDE_CONFIG_DIR). Teste: setLimitRoot. */
let projectsRootOverride = null;
function projectsRoot() {
  return projectsRootOverride || path.join(claudeConfigDir(), "projects");
}

/**
 * Modelos usados pelo Claude Code nos últimos 30 minutos, do mais recente para
 * o mais antigo. Lê só o fim das transcrições locais (<config>/projects; as de subagente não contam).
 */
async function detectModels(now = Date.now(), root = projectsRoot()) {
  const seen = new Map();
  const files = (await transcripts.list(root)).filter((f) => !f.sub && now - f.mtimeMs <= MODEL_WINDOW_MS);
  for (const f of files) {
    let tail = "";
    try {
      tail = await readTail(f.file, 256 * 1024);
    } catch {
      continue;
    }
    const re = /"model":"(claude-[^"]+)"/g;
    let m;
    let last = null;
    while ((m = re.exec(tail))) last = m[1];
    if (last && (!seen.has(last) || seen.get(last) < f.mtimeMs)) seen.set(last, f.mtimeMs);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).map(([id, ts]) => ({ id, label: modelLabel(id), ts }));
}

/**
 * Modelos em uso para o ciclo: a janela dona varre e deixa o resultado num arquivo do temporário; as outras janelas
 * leem esse arquivo (sem varrer de novo) enquanto ele estiver em dia. Sem dona viva ou arquivo velho: varre aqui.
 */
async function modelsForCycle() {
  const f = modelsShareFile();
  if (!isOwnerNow()) {
    const shared = readJsonFile(f);
    if (shared && Array.isArray(shared.models) && Date.now() - Number(shared.at || 0) < 2 * HEARTBEAT_MS) {
      return shared.models.filter((m) => m && typeof m.id === "string").map((m) => ({ id: m.id, label: modelLabel(m.id), ts: Number(m.ts) || 0 }));
    }
  }
  const models = await detectModels();
  try {
    writeJsonAtomic(f, { at: Date.now(), models: models.map((m) => ({ id: m.id, ts: m.ts })) });
  } catch {}
  return models;
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

/** Pasta de configuração do Claude Code (respeita CLAUDE_CONFIG_DIR). */
function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/** Depois de gravar: espera a atualização em andamento (que pode ter lido antes da gravação) e lê de novo. */
function refreshFresh() {
  const prev = refreshing;
  return prev ? prev.catch(() => {}).then(() => refresh()) : refresh();
}

function refresh() {
  if (refreshing) return refreshing;
  checkNewerInstalled(); // mesmo desligado ou sem servidor: avisa quando há versão nova instalada para recarregar
  if (!swapOn()) {
    // Desligado: nenhum contato com o servidor (e nada gravado no login).
    state = { ...state, error: null };
    render();
    postState();
    return Promise.resolve();
  }
  // Um ciclo = batimento no servidor (+ gravar a conta escolhida para este computador).
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
  t.appendMarkdown("\n\n");
  const last = srv.lastOkAt ? fmtWhen(srv.lastOkAt) : null;
  t.appendText(`Servidor ${serverHost()}${last ? ` · último contato ${last}` : ""}. Quem escolhe a conta e troca é o servidor.`);
  for (const wtext of srv.storeWarnings || []) {
    t.appendMarkdown("\n\n**Atenção:** ");
    t.appendText(safe(wtext));
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

  if (renderServerProblem()) return;

  if (!list) {
    // Conectado, mas ainda sem a lista de contas do servidor.
    mainItem.text = frame("$(mail) $(cloud)  Swap Plus: esperando o servidor");
    mainItem.tooltip = `${state.error || "Ainda sem a lista de contas do servidor."}\n\nO Swap Plus fala com o servidor a cada 30 s.`;
    mainItem.show();
    return;
  }

  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc) {
    mainItem.text = frame(
      list.accounts.length ? "$(mail) $(cloud)  sem conta atribuída — clique para escolher" : "$(mail) $(cloud)  nenhuma conta no servidor ainda"
    );
    mainItem.tooltip = list.accounts.length
      ? "O servidor ainda não escolheu uma conta para este computador. Clique para escolher uma."
      : loginUploadAllowed() === false
        ? "O servidor ainda não tem nenhuma conta. Quem adiciona as contas é o administrador (pelo painel do servidor ou por um computador dele)."
        : "O servidor ainda não tem nenhuma conta. Entre com uma conta no Claude Code: o Swap Plus envia o login ao servidor sozinho.";
    mainItem.show();
    return;
  }

  const r = rules();
  const l = linesFor(acc, r, state.records);
  const w = windows(acc);
  // Aviso sobre onde o Claude Code lê o login (ex.: variável de ambiente que passa na frente).
  const storeWarn = (srv.storeWarnings || []).length > 0;
  const icon = (cfg().get("statusBar.showAccountNumber") ? `$(mail) ${acc.number}` : "$(mail)") + " $(cloud)" + (storeWarn ? " $(warning)" : "");
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
  // Batimento no servidor a cada 30 s.
  refresh();
  pollTimer = setInterval(() => refresh(), HEARTBEAT_MS);
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
  if (!isOwnerNow()) return; // só a janela dona avisa (as outras veem o histórico e a barra)
  const list = state.list;
  if (!list) return;
  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc) return;
  const w = windows(acc);
  if (!w || w.stale) return;
  const a = alertSettings();
  const l = linesFor(acc, rules(), state.records);
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
    // Uma vez por computador: outra janela (que foi dona antes) pode já ter avisado e o globalState daqui não viu.
    if (!travas.claimOnce(alertsClaimDir(), key)) continue;
    const r = resetIn(ch.w.resetsAt);
    const text = `Conta ${acc.number} chegou a ${fmtPct(ch.w.pct)} ${ch.label}${r ? ` (renova em ${r})` : ""}`;
    await pushHistory([{ ts: new Date().toISOString(), kind: "alert", text }]);
    postState();
    const isModel = ch.id.startsWith("m:");
    const tail =
      isModel && rules().onModelLimit === "sameAccount"
        ? modelAlertTail(ch.id.slice(2), l.model)
        : autoEnabled()
          ? " A troca automática assume quando passar da linha de troca."
          : "";
    vscode.window.showWarningMessage(`Swap Plus: ${text}.${tail}`, "Trocar para a melhor conta", "Configurações").then((choice) => {
      if (choice === "Trocar para a melhor conta") switchBest();
      else if (choice === "Configurações") openSettings();
    });
  }
}

// ---------------------------------------------------------------- Claude Code: modelo padrão (preferido → secundário e volta)
//
// As regras e os limites do que dá para fazer estão em modelSwitch.js. Em resumo: o Claude Code
// não deixa outra extensão trocar o modelo de uma conversa aberta, então o Swap Plus troca o
// modelo PADRÃO deste computador (o que toda conversa nova usa) e orienta a conversa que parou.
// Quais são os dois modelos e o esforço de cada um: as regras do servidor (painel → Regras de troca:
// "Modelo preferido" e "Modelo secundário"). Servidor antigo, sem essas regras: Fable → Opus 5.5, como sempre.

/** O par de modelos das regras COMO O SERVIDOR MANDOU (sem os padrões por cima: ver modelSwitch.pairOf). */
function modelPair() {
  return modelSwitch.pairOf((srv.state && srv.state.rules) || null);
}

/**
 * O par visto deste computador (3.4.1, ver modelSwitch.orient): os dois modelos do painel são a alternativa um do
 * outro. Com o padrão do Claude Code daqui no SECUNDÁRIO do painel (ex.: painel Opus 5.5 → Fable 5.2, padrão daqui
 * no Fable), o par vale ao contrário: quando o Fable falta na conta em uso, o padrão vai para o Opus 5.5, e volta.
 */
function localPair() {
  const r = modelSwitch.readSettings(claudeSettingsPath());
  return modelSwitch.orient(modelPair(), r.error ? undefined : r.data.model, modelSwitch.readMarker(modelMarkerFile()));
}

/** O servidor procura este modelo nas contas? (o nome do limite que ele olha: a regra preferModel, que segue o modelo preferido do painel) */
function serverLooksFor(name) {
  return String(rules().preferModel || "") === name;
}

/**
 * O servidor escolhe a conta pelo modelo que este computador USA (servidor 2.7.0+, "model_missing")? Então é ele que
 * resolve conta sem o modelo ("requires usage credits") e modelo esgotado: leva este computador para uma conta que
 * tem o modelo, e só se não houver nenhuma o Swap Plus pergunta se quer mudar de modelo (askModelChange).
 */
function serverPicksByModel() {
  const f = srv.state && Array.isArray(srv.state.features) ? srv.state.features : [];
  return f.includes("model_missing") && !!srv.token && !serverMeta().revokedAt;
}

/** O modelo padrão do Claude Code deste computador (o `model` do settings.json), para o servidor saber; null = o do plano. */
function claudeDefaultModel() {
  const r = modelSwitch.readSettings(claudeSettingsPath());
  return !r.error && typeof r.data.model === "string" && r.data.model ? r.data.model.slice(0, 100) : null;
}

/**
 * O par em que `name` ("Fable") é o modelo que falta: o deste computador; senão o do painel (virado, se `name` é o
 * secundário dele — ex.: painel Opus 5.5 → Fable 5.2 e falta o Fable: Fable → Opus 5.5); senão o de sempre.
 */
function pairMissing(name) {
  const local = localPair();
  if (local.primaryName === name) return local;
  const panel = modelSwitch.orient(modelPair(), name.toLowerCase(), null);
  if (panel.primaryName === name) return panel;
  return modelSwitch.pairOf(null);
}

const MODEL_ASK_KEY = "swapPlus.modelAskShown";
const MISSING_GAP_MS = 60 * 1000; // várias conversas (e subagentes) com o mesmo erro: um pedido ao servidor
let missingAskedAt = 0;
let modelAsking = false;

/**
 * "Não há mais nenhuma conta com Fable disponível. Você quer mudar?" — só quando o servidor diz que nenhuma conta tem
 * o modelo que este computador usa (device.modelBlock). Uma vez por episódio (o `since` do servidor), em uma janela.
 * Mudar = o modelo padrão do Claude Code passa para o outro modelo do par (as conversas novas abrem nele), e a conversa
 * aberta precisa do seletor de modelo (o Claude Code não deixa outra extensão mudar o modelo dela).
 */
async function askModelChange(block) {
  if (!block || !block.model || modelAsking) return null;
  const key = `${block.model}:${block.since || ""}`;
  if (extContext.globalState.get(MODEL_ASK_KEY) === key) return null;
  modelAsking = true;
  try {
    await extContext.globalState.update(MODEL_ASK_KEY, key);
    const name = block.model;
    const pair = pairMissing(name);
    const S = pair.secondaryLabel;
    const change = `Mudar para o ${S}`;
    const keep = `Continuar esperando o ${name}`;
    await pushHistory([{ ts: new Date().toISOString(), kind: "alert", text: `Nenhuma conta com ${name} disponível` }]);
    postState();
    const c = await vscode.window.showWarningMessage(
      `Não há mais nenhuma conta com ${name} disponível. Você quer mudar para o ${S}?`,
      { modal: true, detail: `${safe(block.text || "")}\n\nSe mudar: o modelo padrão do Claude Code passa para o ${S} (as conversas novas abrem nele). Na conversa que parou, escolha ${S} no seletor de modelo e mande “continue”.\nSe esperar: assim que uma conta com ${name} ficar disponível, o Swap Plus troca sozinho.` },
      change,
      keep
    );
    if (c === change) {
      const acc = block.account === null || block.account === undefined ? null : Number(block.account);
      const res = await fallbackToOpus({ pair, reason: "limit", seen: true, account: acc, holdUntil: Date.now() + modelSwitch.HOLD_MS });
      if (!res) vscode.window.showInformationMessage(`Swap Plus: ${continueTip(pair)}`);
      return res;
    }
    if (c === keep) vscode.window.showInformationMessage(`Swap Plus: fico de olho. Quando uma conta com ${name} ficar disponível, troco sozinho.`);
    return null;
  } finally {
    modelAsking = false;
  }
}

/** Depois de cada batimento, na janela dona: o servidor disse que nenhuma conta tem o modelo deste computador? */
async function checkModelBlock() {
  if (!extContext || !swapOn() || !isOwnerNow() || !serverPicksByModel()) return null;
  const block = srv.state && srv.state.device ? srv.state.device.modelBlock : null;
  if (!block) return null;
  return askModelChange(block);
}

/**
 * Servidor 2.7.0+: conta sem o modelo ("requires usage credits") ou modelo esgotado na regra "trocar de conta".
 * O servidor leva este computador (e, no modo "juntos", o grupo) para uma conta que tem o modelo; a conversa que
 * parou retoma sozinha lá (gancho de retomada). Sem nenhuma conta com o modelo: pergunta (askModelChange).
 */
async function modelHitViaServer(name, absent) {
  const now = Date.now();
  if (absent && now - missingAskedAt < MISSING_GAP_MS) return null;
  if (absent) missingAskedAt = now;
  const pair = pairMissing(name);
  const label = absent ? `limite do ${name} (a conta não tem esse modelo)` : `limite do ${name}`;
  const body = absent ? { kind: "model_missing", model: pair.primaryId } : { kind: "limit_hit", label };
  const res = await serverLimitHit(label, { quiet: true, body });
  if (res && res.kind === "switch") return res;
  const block = srv.state && srv.state.device ? srv.state.device.modelBlock : null;
  if (block) return askModelChange(block);
  if (res && res.text) vscode.window.showWarningMessage(`Swap Plus: ${res.text}.`);
  return res;
}

const continueTip = (pair) => `Na conversa que parou, escolha ${pair.secondaryLabel} no seletor de modelo (embaixo da caixa de mensagem) e mande “continue”.`;
const openTip = (pair) => `As conversas abertas seguem no modelo delas; para passar uma agora, escolha ${pair.secondaryLabel} no seletor de modelo.`;
const EFFORT_WORDS = { low: "baixo", medium: "médio", high: "alto", xhigh: "muito alto" };
const MODEL_NOTE_GAP_MS = 2 * 60 * 1000; // erros de limite em sequência (subagentes, várias conversas): um aviso só
// Conta sem o modelo preferido, na regra "trocar de conta": um pedido de troca ao servidor a cada tanto. Se a conta
// nova também não tiver o modelo, a conversa retomada para de novo — sem esta espera, o computador ficaria pulando.
const ABSENT_ASK_GAP_MS = 10 * 60 * 1000;
let modelErrShown = null;
let modelLimitNotedAt = 0;
let absentAskedAt = 0;

function claudeSettingsPath() {
  return path.join(claudeConfigDir(), "settings.json");
}

/** Marcador da troca de modelo: na pasta de dados da extensão (dura entre reinícios e vale para todas as janelas). */
function modelMarkerFile() {
  const dir = extContext && extContext.globalStorageUri && extContext.globalStorageUri.fsPath;
  return dir ? path.join(dir, "modelo-padrao.json") : path.join(os.tmpdir(), `swap-plus-modelo-${localTag()}.json`);
}

/** Troca automática do modelo padrão ligada neste computador? */
function autoModelOn() {
  return swapOn() && cfg().get("autoModel.enabled") !== false;
}

/** Para a tela: como está o modelo padrão do Claude Code neste computador. */
function modelStatus() {
  const pair = localPair();
  const base = { enabled: autoModelOn(), fallbackLabel: pair.secondaryLabel };
  const r = modelSwitch.readSettings(claudeSettingsPath());
  if (r.error) return { ...base, error: safe(r.error) };
  const marker = modelSwitch.readMarker(modelMarkerFile());
  const model = r.data.model;
  const switched = !!marker && marker.state === "fallback" && modelSwitch.isSecondary(model, pair);
  return {
    ...base,
    label: modelSwitch.defaultLabel(model),
    isFable: modelSwitch.isPrimaryDefault(model, pair), // (nomes de antes da 3.4.0: "é o modelo preferido" e "é o secundário")
    isOpus: modelSwitch.isSecondary(model, pair),
    switched, // o secundário de agora foi posto pelo Swap Plus: volta sozinho quando o preferido voltar
    since: switched && marker.at ? fmtWhen(new Date(marker.at).toISOString()) : null,
    account: switched && marker.account !== null && marker.account !== undefined ? marker.account : null,
    backLabel: switched ? modelSwitch.defaultLabel(marker.from) : null,
    byHand: !!marker && marker.state === "user",
  };
}

/** Fim do aviso "o Fable chegou a X%" na regra "mesma conta". */
function modelAlertTail(name, line) {
  const pair = localPair();
  if (!modelSwitch.isPrimaryName(name, pair)) return "";
  return autoModelOn()
    ? ` Em ${fmtPct(line)} o Swap Plus passa o modelo padrão do Claude Code para o ${pair.secondaryLabel} (vale para as conversas novas); a conta não muda.`
    : ` Quando ele acabar, o Claude Code para a conversa: escolha outro modelo no seletor para seguir na mesma conta.`;
}

function reportModelError(text) {
  console.error("[swap-plus] modelo padrão", text);
  if (modelErrShown === text) return;
  modelErrShown = text;
  vscode.window.showWarningMessage(`Swap Plus: não consegui trocar o modelo padrão do Claude Code: ${text}`);
}

const defaultModelText = (m) => (m === null || m === undefined ? "o modelo do plano" : `o ${modelSwitch.defaultLabel(m)}`);

/**
 * Passa o modelo padrão do Claude Code para o secundário (se hoje é o preferido) e avisa.
 * meta: { reason: "limit" | "line" | "absent", seen, account, pct, line, resetsAt (ISO), holdUntil (ms), cycleEnd (ms) }
 *   reason "absent": a conta em uso não tem o modelo preferido (pelo uso das contas, ou pelo erro "requires usage credits").
 *   seen: o motivo foi visto numa conversa, que parou (o "limit" é sempre assim).
 *   pair: o par em que o modelo que falta é o "preferido" (sem ele, o par visto deste computador: localPair).
 */
async function fallbackToOpus(meta) {
  if (!autoModelOn()) return null;
  const pair = meta.pair || localPair();
  const P = pair.primaryName;
  const S = pair.secondaryLabel;
  const limit = meta.reason === "limit" || !!meta.seen; // uma conversa parou com o erro: o preferido estava em uso
  const res = modelSwitch.toFallback(claudeSettingsPath(), modelMarkerFile(), {
    account: meta.account === undefined ? null : meta.account,
    reason: meta.reason,
    now: Date.now(),
    holdUntil: meta.holdUntil || null,
    cycleEnd: meta.cycleEnd || null,
    // Erro visto na conversa: o preferido estava em uso. Pelo uso das contas: só se foi usado neste computador há pouco.
    fableInUse: limit || state.models.some((m) => modelSwitch.isPrimaryName(m.id, pair)),
    pair,
  });
  if (!res.ok) {
    reportModelError(safe(res.error));
    return res;
  }
  modelErrShown = null;
  const known = !(meta.account === null || meta.account === undefined);
  const acc = known ? ` na conta ${meta.account}` : "";
  const when = meta.resetsAt && fmtWhen(meta.resetsAt) ? ` (renova ${fmtWhen(meta.resetsAt)})` : "";
  const what =
    meta.reason === "absent"
      ? `${known ? `a conta ${meta.account}` : "a conta em uso"} não tem o ${P}`
      : limit
        ? `o ${P} acabou${acc}${when}`
        : `o ${P}${acc.replace(" na ", " da ")} chegou a ${fmtPct(meta.pct)} (linha ${fmtPct(meta.line)})`;
  const settings = (c) => c && openSettings();
  const noted = limit && Date.now() - modelLimitNotedAt < MODEL_NOTE_GAP_MS;
  if (limit) modelLimitNotedAt = Date.now();
  if (res.changed) {
    await pushHistory([{ ts: new Date().toISOString(), kind: "model", text: `${cap(what)}: o modelo padrão do Claude Code passou de ${defaultModelText(res.from).replace(/^o /, "")} para ${S}` }]);
    postState();
    vscode.window
      .showWarningMessage(
        `Swap Plus: ${what}. O modelo padrão do Claude Code passou para o ${S}: toda conversa nova já abre nele, na mesma conta. ${limit ? continueTip(pair) : openTip(pair)}`,
        "Configurações"
      )
      .then(settings);
  } else if (limit && !noted) {
    // O padrão já não era o preferido (ou a troca já tinha sido feita): só orienta a conversa que parou.
    const cur = res.state === "already" ? `O modelo padrão do Claude Code já é o ${S}.` : `O modelo padrão do Claude Code (${modelSwitch.defaultLabel(res.model)}) não é o ${P} e não foi mexido.`;
    await pushHistory([{ ts: new Date().toISOString(), kind: "alert", text: cap(what) }]);
    postState();
    vscode.window.showWarningMessage(`Swap Plus: ${what}. ${cur} ${continueTip(pair)}`, "Configurações").then(settings);
  }
  return res;
}

/** Desfaz a troca do Swap Plus: o modelo padrão volta ao de antes. `what` = o motivo, para o aviso. */
async function backToPreferred(what) {
  const res = modelSwitch.toPreferred(claudeSettingsPath(), modelMarkerFile(), localPair());
  if (!res.ok) {
    reportModelError(safe(res.error));
    return res;
  }
  modelErrShown = null;
  if (res.changed) {
    const to = defaultModelText(res.model);
    await pushHistory([{ ts: new Date().toISOString(), kind: "model", text: `${cap(what)}: o modelo padrão do Claude Code voltou para ${to.replace(/^o /, "")}` }]);
    postState();
    vscode.window.showInformationMessage(`Swap Plus: ${what}. O modelo padrão do Claude Code voltou para ${to}: as conversas novas abrem nele.`);
  }
  return res;
}

/** Recurso desligado (ou Swap Plus desligado, ou computador desconectado): não deixa o padrão trocado para trás. */
async function undoModelSwitch(what) {
  const marker = modelSwitch.readMarker(modelMarkerFile());
  if (!marker) return null;
  if (marker.state !== "fallback") {
    modelSwitch.clearMarker(modelMarkerFile());
    return null;
  }
  return backToPreferred(what);
}

/**
 * Esforço dos dois modelos escolhido no painel (regras primaryEffort/secondaryEffort): garante o mesmo no
 * settings.json do Claude Code (modelSettings["<id>"].effortLevel). Regra vazia = não mexe. Só conectado ao
 * servidor; só grava quando está diferente; o resto do arquivo fica como está.
 */
async function syncModelEfforts(pair) {
  if (!pair.primaryEffort && !pair.secondaryEffort) return null;
  if (!srv.token || serverMeta().revokedAt) return null;
  const res = modelSwitch.syncEfforts(claudeSettingsPath(), pair);
  if (!res.ok) {
    reportModelError(safe(res.error));
    return res;
  }
  if (res.changed.length) {
    const parts = res.changed.map((c) => `${modelSwitch.defaultLabel(c.id)} em ${EFFORT_WORDS[c.effort] || c.effort}`);
    await pushHistory([{ ts: new Date().toISOString(), kind: "model", text: `Esforço no Claude Code acertado pelas regras do painel: ${parts.join(" e ")}` }]);
    postState();
  }
  return res;
}

/** A cada ciclo, na janela dona: o uso do modelo preferido na conta em uso decide o modelo padrão (e o esforço segue o painel). */
async function checkModelSwitch() {
  if (!extContext || !swapOn() || !isOwnerNow()) return null;
  // Desligada com o VS Code fechado (ou em outra janela): não deixa o padrão trocado para trás.
  if (!autoModelOn()) return undoModelSwitch("a troca automática do modelo padrão está desligada");
  const list = state.list;
  if (!list) return null;
  await syncModelEfforts(modelPair());
  const pair = localPair(); // quem usa o secundário do painel como padrão cai no preferido do painel (e volta)
  const file = claudeSettingsPath();
  const mk = modelMarkerFile();
  const now = Date.now();
  const marker = modelSwitch.noteUserChoice(file, mk, now, pair);
  const p = modelSwitch.plan({ list, records: state.records, r: rules(), marker, now, pair });
  if (p.forget) modelSwitch.clearMarker(mk);
  // Servidor 2.7.0+: conta sem o modelo é com ele (troca de conta); na regra "trocar de conta", o modelo esgotado
  // também. O modelo padrão só muda se a pessoa disser que quer (askModelChange, quando nenhuma conta tem o modelo).
  if (p.want === "fallback" && serverPicksByModel() && (p.reason === "absent" || rules().onModelLimit === "switchAccount")) return null;
  if (p.want === "fallback") return fallbackToOpus({ ...p, pair });
  if (p.want === "preferred") {
    // Saiu de uma conta que não tem o modelo: ele não "voltou", é a conta nova que tem.
    const absent = !!marker && marker.reason === "absent" && marker.account !== p.account;
    return backToPreferred(absent ? `a conta ${p.account} tem o ${pair.primaryName} (${fmtPct(p.pct)} usado)` : `o ${pair.primaryName} voltou na conta ${p.account} (${fmtPct(p.pct)} usado)`);
  }
  return null;
}

/**
 * Há outra conta, na troca automática e com o login vivo, em que o modelo preferido ainda está abaixo da linha?
 * (Com os dados que este computador tem; quem escolhe a conta é o servidor.)
 */
function otherAccountHasPrimary(list, active, pair) {
  const r = rules();
  for (const a of (list && list.accounts) || []) {
    if (active && a.number === active.number) continue;
    if (recordOf(state.records, a.number).disabled || loginDead(a)) continue;
    const w = windows(a);
    const m = w ? w.models.find((x) => modelSwitch.isPrimaryName(x.name, pair)) : null;
    if (m && m.pct < linesFor(a, r, state.records).model) return true;
  }
  return false;
}

/**
 * O limite de um modelo acabou na conta em uso, ou a conta não tem o modelo (erro visto na conversa). Vale para o
 * modelo que este computador usa como padrão (localPair: pode ser o secundário do painel) e, como sempre, para o
 * preferido do painel. Erro de outro modelo: nada.
 */
async function modelLimitHit(model, hit) {
  // Servidor 2.7.0+: ele escolhe a conta pelo modelo que este computador usa (vale para qualquer modelo do painel).
  if (serverPicksByModel()) {
    const absent = !!hit && modelSwitch.needsCredits(hit.text, hit.code);
    if (absent || rules().onModelLimit === "switchAccount") return modelHitViaServer(model, absent);
  }
  const pair = [localPair(), modelPair()].find((p) => p.primaryName === model);
  if (!pair) return null;
  // Sem conexão com o servidor o Swap Plus não mexe em nada (nem saberia quando o preferido volta).
  if (!srv.token || serverMeta().revokedAt) return null;
  const now = Date.now();
  const list = state.list;
  const active = list ? list.accounts.find((a) => a.number === list.activeAccountNumber) : null;
  const w = active ? windows(active) : null;
  const fable = w ? w.models.find((m) => modelSwitch.isPrimaryName(m.name, pair)) : null;
  // "Fable 5.2 requires usage credits": a conta em uso não tem o modelo. Não é limite que renova.
  const absent = !!hit && modelSwitch.needsCredits(hit.text, hit.code);
  // Quando o Fable renova: o que o Claude Code gravou junto do erro; senão o que o servidor informa.
  const fromUsage = fable ? Date.parse(fable.resetsAt || "") : NaN;
  const resetMs = absent ? null : hit && hit.resetsAt > now ? hit.resetsAt : fromUsage > now ? fromUsage : null;
  if (rules().onModelLimit === "switchAccount") {
    // Regra "trocar de conta": primeiro o servidor procura uma conta que ainda tem o modelo preferido.
    // Modelo que o servidor não procura nas contas (o secundário do painel): ele poderia mandar o computador para
    // outra conta sem o modelo, então não pede — vale o outro modelo do par, na mesma conta.
    // Conta sem o modelo: só pede se alguma outra tem, e um pedido a cada tanto (ver ABSENT_ASK_GAP_MS).
    const looksFor = serverLooksFor(pair.primaryName);
    const ask = absent ? looksFor && now - absentAskedAt >= ABSENT_ASK_GAP_MS && otherAccountHasPrimary(list, active, pair) : looksFor || !pair.reversedFrom;
    if (ask) {
      if (absent) absentAskedAt = now;
      const label = absent ? `limite do ${pair.primaryName} (a conta não tem esse modelo)` : `limite do ${pair.primaryName}`;
      const res = await serverLimitHit(label, { quiet: autoModelOn() });
      if (res && res.kind === "switch") return res;
    }
  }
  return fallbackToOpus({
    pair,
    reason: absent ? "absent" : "limit",
    seen: true,
    account: active ? active.number : null,
    resetsAt: resetMs ? new Date(resetMs).toISOString() : null,
    holdUntil: resetMs || now + modelSwitch.HOLD_MS,
    cycleEnd: resetMs,
  });
}

// ---------------------------------------------------------------- troca automática (decidida pelo servidor)

/** A troca automática liga/desliga no servidor (vale para todos os computadores). Swap Plus desligado: false. */
function autoEnabled() {
  return swapOn() && !!(srv.state && srv.state.autoSwitch);
}

async function pushHistory(entries) {
  if (!entries.length) return;
  const hist = extContext.globalState.get(HISTORY_KEY) || [];
  const fresh = entries.filter((e) => !(hist[0] && hist[0].kind === e.kind && hist[0].text === e.text));
  if (!fresh.length) return;
  await extContext.globalState.update(HISTORY_KEY, [...fresh.reverse(), ...hist].slice(0, HISTORY_MAX));
}

// ---------------------------------------------------------------- limite estourado: reação imediata

const RESUME_TIP = " Se o Claude Code parou com “You've hit your limit”, mande uma mensagem (por exemplo, “continue”) para ele seguir na conta nova.";
const RESUME_AUTO_TIP = " A conversa do Claude Code que parou nesse limite retoma sozinha em alguns segundos.";

// ---------------------------------------------------------------- retomar a conversa depois da troca

const RESUME_CHECK_MS = 10 * 60 * 1000;
let resumeTimer = null;
let resumeState = { enabled: false, installed: false, changed: false, error: null };

/** A conversa que parou por limite retoma sozinha depois da troca? Opção deste VS Code; com o Swap Plus desligado, não. */
function resumeOn() {
  return swapOn() && cfg().get("resume.enabled") !== false;
}

/**
 * Deixa o gancho do Claude Code como a opção pede (resume.js): ligado, o script hooks/retomar.js é copiado para
 * ~/.swap-plus e entra no hooks.StopFailure do settings.json do Claude Code; desligado, sai. Vale para todas as
 * janelas deste sistema (o settings.json é um só); cada janela chama isto e o resultado é o mesmo. Nunca lança.
 */
function syncResume() {
  let r;
  try {
    r = resume.sync({ enabled: resumeOn(), text: String(cfg().get("resume.text") || ""), scriptSource: path.join(__dirname, "hooks", "retomar.js") });
  } catch (e) {
    r = { enabled: resumeOn(), installed: false, changed: false, error: { code: "error", message: String((e && e.message) || e) } };
  }
  if (r.error && (!resumeState.error || resumeState.error.message !== r.error.message)) console.error("[swap-plus] retomar", r.error.message);
  resumeState = r;
  return r;
}

/** A dica do aviso de troca por limite: com a retomada ligada e instalada, a conversa segue sozinha. */
function resumeTip() {
  return resumeOn() && resumeState.installed ? RESUME_AUTO_TIP : RESUME_TIP;
}
const LIMIT_KEY = "swapPlus.lastLimitHit";
const LIMIT_LOCK = path.join(os.tmpdir(), "swap-plus-limit.lock");
const LIMIT_SCAN_S = 15;
let limitTimer = null;

function limitLabel(text) {
  const t = String(text || "");
  // "Server is temporarily limiting requests (not your usage limit)": passageiro, a conta não bateu limite nenhum.
  if (modelSwitch.TRANSIENT_LIMIT_RE.test(t)) return null;
  if (/5-hour|five.?hour|session/i.test(t)) return "limite da sessão de 5h";
  if (/weekly|week|seven.?day/i.test(t)) return /fable|opus|sonnet/i.test(t) ? null : "limite semanal";
  if (/fable|opus|sonnet/i.test(t)) return null; // limite de um modelo: ver modelLimitHit
  return "limite de uso";
}

/**
 * Procura, no fim das transcrições alteradas desde `sinceMs`, o erro que o Claude
 * Code grava quando a conta bate o limite: mensagem marcada isApiErrorMessage com
 * error "rate_limit". Texto de conversa comum que cite o erro não conta.
 */
async function scanLimitErrors(sinceMs, root = projectsRoot()) {
  let latest = null;
  const files = (await transcripts.list(root)).filter((x) => x.mtimeMs > sinceMs);
  for (const { file: f, mtimeMs } of files) {
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
      const ts = Date.parse(d.timestamp) || mtimeMs;
      if (ts <= sinceMs) continue;
      const c = d.message && d.message.content;
      const text = Array.isArray(c) ? c.map((x) => (x && x.text) || "").join(" ") : String(c || "");
      // Quando o Claude Code grava: qual limite foi (five_hour, seven_day, seven_day_overage_included = Fable…) e quando renova.
      const q = d.quotaLimits || (d.apiErrorParams && d.apiErrorParams.rate_limit_info) || null;
      const rateLimitType = q && typeof q.rateLimitType === "string" ? q.rateLimitType : null;
      const resetsAt = q && Number(q.resetsAt) > 0 ? Number(q.resetsAt) * 1000 : null;
      // "credits_required" = a conta não tem o modelo ("Fable 5.2 requires usage credits"): ver modelSwitch.needsCredits.
      const code = typeof d.apiErrorCode === "string" ? d.apiErrorCode : q && typeof q.errorCode === "string" ? q.errorCode : null;
      if (!latest || ts > latest.ts) latest = { ts, text, file: f, rateLimitType, resetsAt, code };
    }
  }
  return latest;
}

/**
 * Trava entre janelas: só uma reage a cada erro. Ler → comparar → gravar dentro da trava de pasta (mkdir atômico):
 * duas janelas que veem o mesmo erro no mesmo instante não passam as duas. Trava ocupada = outra janela está
 * reivindicando agora: esta não reivindica.
 */
function claimLimit(ts) {
  const r = travas.withDirLock(`${LIMIT_LOCK}.d`, () => {
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
  });
  return r === true;
}

let limitScanning = false;

/** Procura o limite batido. Só a janela dona varre (as outras não); varredura em andamento: este tique é pulado. */
async function checkLimitErrors() {
  if (!swapOn() || !isOwnerNow() || limitScanning) return null;
  limitScanning = true;
  try {
    return await checkLimitErrorsNow();
  } finally {
    limitScanning = false;
  }
}

async function checkLimitErrorsNow() {
  const now = Date.now();
  const since = Math.max(extContext.globalState.get(LIMIT_KEY) || 0, extContext.globalState.get(LAST_SWITCH_KEY) || 0, now - 10 * 60 * 1000);
  const hit = await scanLimitErrors(since);
  if (!hit) return null;
  await extContext.globalState.update(LIMIT_KEY, hit.ts);
  const model = modelSwitch.limitModel(hit.text, hit.rateLimitType);
  const label = model ? null : limitLabel(hit.text);
  if ((!model && !label) || !claimLimit(hit.ts)) return null;
  if (model) return modelLimitHit(model, hit); // limite de um modelo: o modelo padrão passa para o Opus 5.5
  return serverLimitHit(label); // limite da conta: quem decide a troca é o servidor
}

function setupLimitWatch() {
  if (limitTimer) clearInterval(limitTimer);
  limitTimer = setInterval(() => checkLimitErrors().catch((e) => console.error("[swap-plus] limit watch", e)), LIMIT_SCAN_S * 1000);
}

/** Trocar para a melhor conta: quem escolhe é o servidor. */
async function switchBest() {
  return serverSwitch(null);
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
  const st = serverStatus();
  if (st === "disconnected" || st === "revoked") {
    // Sem conexão: o caminho é entrar (com Google ou com o código de conexão).
    const c = await vscode.window.showWarningMessage(`Swap Plus: ${serverErrorLine()}`, "Entrar com Google", "Colar código", "Configurações");
    if (c === "Entrar com Google") return connectServer("google");
    if (c === "Colar código") return connectServer("code");
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
  const list = state.list;
  if (!list || !list.accounts.length) {
    const choice = await vscode.window.showErrorMessage(
      list ? "Nenhuma conta no servidor ainda." : `Swap Plus: ${state.error || "ainda sem a lista de contas do servidor."}`,
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
    { label: "$(gear) Configurações...", description: "deste VS Code: conexão, conta em uso e avisos", accountNum: -2 },
    { label: "Contas", kind: vscode.QuickPickItemKind.Separator },
    ...items,
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(add) Adicionar conta...", description: "entre com a conta no Claude Code; o login vai para o servidor", accountNum: -1 },
    { label: "$(debug-disconnect) Desligar o Swap Plus", description: "para de falar com o servidor e de trocar contas; o Claude Code fica normal", accountNum: -4 },
  ];

  const picked = await vscode.window.showQuickPick(menu, { placeHolder: "Escolha a conta Claude ou abra as configurações" });
  if (!picked) return;
  if (picked.accountNum === -1) return addAccount();
  if (picked.accountNum === -2) return openSettings();
  if (picked.accountNum === -4) return setEnabled(false);
  if (picked.accountNum !== list.activeAccountNumber) await doSwitch(picked.accountNum);
}

async function doSwitch(num) {
  const target = state.list && state.list.accounts.find((a) => a.number === Number(num));
  if (loginDead(target)) {
    const c = await vscode.window.showWarningMessage(
      `O login da conta ${num} não vale mais no servidor (${statusLabel(target.usageStatus)}). Se trocar, o Claude Code vai pedir login. ${
        loginUploadAllowed() === false
          ? "Para usar esta conta de novo, o administrador precisa entrar outra vez com ela."
          : "Depois de entrar com ela no Claude Code, o Swap Plus envia o login novo ao servidor sozinho."
      }`,
      { modal: true },
      "Trocar mesmo assim"
    );
    if (c !== "Trocar mesmo assim") return;
  }
  return serverSwitch(Number(num));
}

// ---------------------------------------------------------------- adicionar conta

/**
 * Como adicionar uma conta: não há "cadastrar" aqui. O login novo do Claude Code vai
 * sozinho para o servidor — só nos computadores do administrador.
 */
function addAccount() {
  const st = serverStatus();
  if (st === "disconnected" || st === "revoked") {
    vscode.window
      .showInformationMessage("Swap Plus: as contas ficam no servidor. Conecte este computador primeiro (Entrar com Google).", "Entrar com Google")
      .then((c) => c && connectServer("google"));
    return { ok: false };
  }
  if (loginUploadAllowed() === false) {
    vscode.window.showInformationMessage(
      "Swap Plus: só os computadores do administrador enviam logins ao servidor. Para adicionar uma conta, use o painel do servidor (Contas → + Adicionar conta) ou entre com ela no Claude Code de um computador do administrador."
    );
    return { ok: false };
  }
  vscode.window.showInformationMessage(
    "Swap Plus: para adicionar uma conta, entre com ela no Claude Code (comando /login), sem sair da anterior. Em até 30 s o Swap Plus envia o login ao servidor, que passa a cuidar dela."
  );
  return { ok: false };
}

async function setEnabled(on) {
  const write = () => cfg().update("enabled", !!on, vscode.ConfigurationTarget.Global);
  // Desligar espera o ciclo em andamento (batimento, troca, gravação) terminar.
  if (!on) await holdServer(write);
  else await write();
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: on ? "Swap Plus ligado" : "Swap Plus desligado" }]);
  vscode.window.showInformationMessage(
    on
      ? "Swap Plus ligado. Ele volta a falar com o servidor e a receber a conta escolhida para este computador."
      : "Swap Plus desligado. Sem contato com o servidor e sem mexer no login: o Claude Code fica com o acesso que tem agora."
  );
}

async function toggleEnabled() {
  return setEnabled(!swapOn());
}

async function toggleAuto() {
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

// ---------------------------------------------------------------- servidor
//
// O refresh token de cada conta é de uso único: quem renova primeiro invalida a
// cópia dos outros. Por isso só o servidor guarda o refresh token e renova; ele
// também decide as trocas (mesma regra do rules.js) para todos os computadores.
// Este computador:
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
//   - só os computadores do administrador enviam logins: o servidor diz no
//     estado (device.canUploadLogins) e recusa o POST /v1/logins dos outros
//     (403 not_admin). Nos outros, nenhum login vai ao servidor; um login novo do
//     Claude Code é substituído pela conta do servidor, com um aviso. Sem o campo
//     (servidor antigo), envia como antes;
//   - o token deste computador só vai para o endereço em que foi emitido (o
//     guardado na conexão). Endereço novo nas configurações = conectar de novo;
//   - enquanto está conectado (e o Swap Plus ligado), a tela de login do Claude
//     Code fica desligada (claudeCode.disableLoginPrompt): quem faz o login é o
//     Swap Plus. Ao desconectar (ou desligar) a configuração volta como estava.
// Sem conexão, nada vai ao servidor e nada é gravado no login: a barra e a tela
// mostram "não conectado" com "Entrar com Google". O motor antigo (swap-plus) não
// é chamado. Tokens nunca vão para log nem para mensagens.

const SERVER_TOKEN_KEY = "swapPlus.server.token"; // em context.secrets
const SERVER_META_KEY = "swapPlus.server"; // globalState: { url, fp, deviceId, name, via, connectedAt, revokedAt } — url = onde o token foi emitido
const SERVER_APPLIED_KEY = "swapPlus.server.applied"; // globalState: { number, gen, expiresAt, at, noIdentity } — última credencial gravada
const SERVER_SENT_KEY = "swapPlus.server.sentLogin"; // globalState: [hash] — logins com refresh token já resolvidos (enviados, mortos ou gastos); nunca o token
const LOGIN_PROMPT_KEY = "swapPlus.server.loginPrompt"; // globalState: { applied, had, value, noticed } — claudeCode.disableLoginPrompt de antes da conexão
const HEARTBEAT_MS = 30 * 1000;
const DEVICE_ACTIVE_MS = 5 * 60 * 1000;
const LOGIN_POST_TIMEOUT_MS = 90 * 1000; // POST /v1/logins: o servidor renova o login na hora (fala com a Anthropic)
const LOGIN_RETRY_MS = 60 * 1000; // refresh_failed / profile_unavailable: tenta de novo em ~1 min, sem aviso
const REJECT_RETRY_MS = 10 * 60 * 1000; // login recusado pelo servidor: o envio é tentado de novo depois de 10 min
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
const UPLOAD_DENIED_TEXT = "Este computador usa as contas do servidor. O login local não foi enviado: só os computadores do administrador enviam logins.";
const LOGIN_PROMPT_NOTE = "Enquanto este computador estiver conectado ao servidor, o login do Claude Code é feito pelo Swap Plus";

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

/** Origem ("https://host[:porta]") de um endereço, ou "" (sem carregar o serverClient). */
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

// Carregados na primeira vez em que são usados.
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
const modelsShareFile = () => path.join(os.tmpdir(), `swap-plus-modelos-${localTag()}.json`);
// "Chegou a X%": cada aviso é reivindicado por um arquivo aqui (uma notificação por computador, não por janela).
const alertsClaimDir = () => path.join(os.tmpdir(), `swap-plus-avisos-${localTag()}`);
const ALERT_CLAIM_MAX_AGE_MS = 8 * 24 * 60 * 60 * 1000;
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
  srv.uploadDenied = false;
  srv.deniedKey = null;
  srv.deniedWarned = null;
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

/** "off" | "disconnected" | "revoked" | "connecting" | "online" | "offline" */
function serverStatus() {
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
    return "este computador ainda não está conectado ao servidor. Entre com Google (ou cole o código de conexão) para usar as contas do servidor.";
  }
  if (st === "revoked") return "o servidor recusou o acesso deste computador (foi revogado ou desconectado). Conecte de novo: entre com Google ou cole um código novo.";
  if (st === "offline") return `servidor fora do ar${last ? ` (último contato: ${last})` : ""} — ${srv.lastError || "sem resposta"}. O login do Claude Code não é mexido enquanto isso.`;
  if (st === "connecting") return "conectando ao servidor…";
  return null;
}

function serverStatusText(st) {
  const host = serverHost();
  switch (st) {
    case "off":
      return "Swap Plus desligado: sem contato com o servidor e sem mexer no login.";
    case "disconnected":
      return serverAddressChanged()
        ? addressChangedText()
        : `este computador ainda não está conectado${connectUrl() ? ` a ${serverHost(connectUrl())}` : ""}. Entre com Google para usar as contas do servidor.`;
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

/** Barra de status quando não dá para mostrar o uso (sem conexão, fora do ar…). true = já desenhou. */
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
    text = "$(mail) $(cloud)  não conectado — clique para entrar com Google";
    tip = `Este computador ainda não está conectado ao servidor Swap Plus (${serverHost(connectUrl())}). Clique e escolha “Entrar com Google” (a conta Google precisa estar liberada pelo dono do servidor) ou cole o código de conexão gerado no servidor.\n\nEnquanto isso o Swap Plus não mexe no login do Claude Code.`;
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

/** Guarda o estado recebido do servidor; barra, lista e tela passam a usar list/records/rules/history dele. */
function applyStateResponse(resp) {
  if (!resp || !resp.list || !Array.isArray(resp.list.accounts)) return false;
  // O servidor passou de "não pode" para "pode enviar logins" (ex.: voltou a ser computador do administrador
  // depois de um reinício do servidor): a recusa anterior (403 not_admin) deixa de valer.
  const canBefore = srv.state && srv.state.device ? srv.state.device.canUploadLogins : undefined;
  if (srv.uploadDenied && canBefore === false && resp.device && resp.device.canUploadLogins === true) srv.uploadDenied = false;
  srv.state = resp;
  srv.status = "online";
  srv.lastOkAt = Date.now();
  srv.lastError = null;
  state = { ...state, list: resp.list, records: resp.records || {}, error: null, fetchedAt: Date.now() };
  return true;
}

/**
 * Este computador pode enviar logins ao servidor? Só os do administrador podem.
 * false = não (o estado diz device.canUploadLogins false, ou o servidor já recusou
 * um envio com 403 not_admin); true = pode (o campo veio true, ou não veio: servidor
 * antigo, que aceita de todos); null = ainda sem o estado do servidor.
 */
function loginUploadAllowed() {
  if (srv.uploadDenied) return false;
  const st = srv.state;
  if (!st) return null;
  return !(st.device && st.device.canUploadLogins === false);
}

/** O servidor recusou o envio porque este computador não é do administrador? (403 { error: "not_admin" }) */
function isNotAdmin(e) {
  return Number(e && e.status) === 403 && !!e && e.code === "not_admin";
}

/** Avisa (uma vez por login) que o login local não foi enviado: este computador não envia logins. */
async function notifyUploadDenied(key) {
  if (srv.deniedWarned === key) return;
  srv.deniedWarned = key;
  console.warn("[swap-plus] login do Claude Code não enviado: só os computadores do administrador enviam logins");
  try {
    await pushHistory([
      { ts: new Date().toISOString(), kind: "info", text: "Login do Claude Code não enviado ao servidor: só os computadores do administrador enviam logins" },
    ]);
  } catch {}
  vscode.window.showWarningMessage(`Swap Plus: ${UPLOAD_DENIED_TEXT}`);
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
    : "Swap Plus: este computador ainda não está conectado ao servidor. Entre com Google para usar as contas do servidor.";
  vscode.window.showWarningMessage(text, "Entrar com Google", "Colar código").then((c) => {
    if (c === "Entrar com Google") connectServer("google");
    else if (c === "Colar código") connectServer("code");
  });
}

/** O endereço do servidor mudou nas configurações: esquece o estado e o cliente; avisa se o acesso deste computador não vale lá. */
function onServerUrlChanged() {
  srv.state = null;
  srv.status = null;
  srv.rejected = null;
  srv.client = null;
  srv.clientKey = "";
  srv.originMismatch = false;
  srv.owner = null;
  srv.disconnectedWarned = false;
  state = { ...state, list: null, records: {}, error: null };
  if (!swapOn()) releaseOwner();
  serverToken()
    .then((t) => {
      if (swapOn() && (!t || serverAddressChanged())) warnDisconnectedOnce();
    })
    .catch(() => {});
}

// ---- fila única
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

/** Segura o ciclo e espera o que estiver em andamento (ciclo, troca, gravação) antes de fn. */
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

/** Roda fn sob a trava da dona. null = trava ocupada agora. (Trava de pasta: travas.withDirLock.) */
function withOwnerLock(fn) {
  return travas.withDirLock(ownerLockDir(), fn);
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

/** Larga a posição de dona (desligou, desconectou ou a janela fechou): outra janela assume logo. */
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
      if (swapOn() && srv.token && isOwnerNow()) claimOwner(false);
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
 * ele já foi resolvido (enviado ao servidor, recusado como morto/gasto,
 * descartado pela pessoa, ou não enviado porque este computador não envia logins).
 * Um login novo que apareceu no meio do caminho fica.
 */
function canReplaceLive(cur) {
  const o = cur && cur.claudeAiOauth;
  if (!o || !o.refreshToken) return true;
  const key = loginKey({ oauth: o });
  return isSpent(key) || srv.deniedKey === key;
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

/** Login novo que não vai ao servidor (este computador não envia logins): a conta do servidor pode ir por cima; avisa uma vez. */
async function denyLiveLogin(key) {
  srv.deniedKey = key;
  if (srv.rejected && srv.rejected.key === key) srv.rejected = null;
  await notifyUploadDenied(key);
  return { kind: "denied", key };
}

/**
 * Envia ao servidor o login novo do Claude Code (o que tem refresh token).
 * kind: "sent" | "dup" (já resolvido: enviado aqui ou por outra janela)
 *     | "dead" (morto/gasto no servidor, ou descartado pela pessoa — discarded: pode gravar por cima)
 *     | "denied" (este computador não envia logins — só os do administrador: não foi enviado e a conta do servidor vai por cima)
 *     | "rejected" (recusado: não grava por cima) | "wait" (ainda não dá: não grava por cima) | "offline"
 */
async function uploadLiveLogin(auth, live) {
  const key = loginKey(live);
  const now = Date.now();
  if (srv.discard && srv.discard === key) return { kind: "dead", key, discarded: true }; // a pessoa escolheu usar a conta do servidor
  // Já resolvido: nunca reenviar o mesmo login (o servidor já o renovou; o daqui está gasto).
  if (isSpent(key)) return { kind: "dup", key };
  const allowed = loginUploadAllowed();
  if (allowed === false) return denyLiveLogin(key); // só os computadores do administrador enviam logins: nenhum POST
  if (allowed === null) return { kind: "wait", key }; // sem o estado do servidor ainda: não se sabe se este computador pode enviar
  if (srv.rejected && srv.rejected.key === key && now - srv.rejected.at < REJECT_RETRY_MS) return { kind: "rejected", key };
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
      if (isNotAdmin(e)) {
        // Este computador não é do administrador: para de tentar enviar (até conectar de novo).
        srv.uploadDenied = true;
        srv.rejected = null;
        srv.loginRetry = null;
        return await denyLiveLogin(key);
      }
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
  if (!o || !o.refreshToken || !swapOn()) return false;
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
 * atual difere da do servidor. Só o acesso: o refresh token nunca é gravado aqui.
 * opts: live (login atual já lido), up (resultado do envio do login atual, se já feito),
 *   force (buscar e gravar mesmo sem mudança), retryNow (não esperar 1 min depois de uma falha).
 * → null (nada a fazer) | { number, prev, wrote: true } | { blocked: código, reason, quiet, stripped }
 */
async function syncCredential(client, resp, { live = null, up = null, force = false, retryNow = false } = {}) {
  if (!swapOn()) return null; // desligado: nunca grava
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
  // Enviado, gasto ou não enviado ("denied": este computador não envia logins): a conta do servidor vai por cima.
  if (up) force = true;
  // Login já entregue ao servidor (ou gasto lá): se não der para pôr o acesso do servidor por cima, tira o refresh token dele.
  // ("denied" não: o servidor não tem esse login, então ele fica inteiro aqui.)
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
  if (!swapOn()) return null; // desligado no meio do caminho: não grava
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
  // É por este arquivo que o gancho de retomada (hooks/retomar.js) sabe que há login novo no Claude Code.
  resume.markApplied({ number: r.number, gen: r.gen });
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

const RETRY_NET_MS = 2000;
/**
 * Pedido que pode repetir sem efeito colateral (batimento, leitura do estado): uma falha de rede antes de
 * qualquer resposta (Wi-Fi que perdeu um pacote) tenta de novo uma vez, 2 s depois, antes de virar
 * "servidor fora do ar". Nunca usar para enviar login (o refresh token só vale uma vez).
 */
async function retryOnce(fn) {
  try {
    return await fn();
  } catch (e) {
    const k = e && e.code;
    if (k !== "network" && k !== "timeout") throw e;
    console.error("[swap-plus] servidor: falha de rede, tentando de novo em 2 s:", safeErr(e));
    await new Promise((r) => setTimeout(r, RETRY_NET_MS));
    if (!swapOn()) throw e;
    return fn();
  }
}

/**
 * Um ciclo. Janela dona: envia login novo (se houver), batimento,
 * grava a conta escolhida. Outras janelas: só leem o estado.
 */
async function serverSync() {
  const models = await modelsForCycle();
  state = { ...state, models };
  if (srv.hold || !swapOn()) return finishSync(); // conexão, desligar, desconectar... em andamento
  let client = null;
  try {
    client = await serverClient();
  } catch (e) {
    srv.lastError = safeErr(e);
  }
  const st = serverStatus();
  if (!client || st === "revoked") {
    if (!srv.token) {
      // Sem conexão (desconectado aqui ou em outra janela): nada do servidor fica na barra nem na tela.
      srv.state = null;
      state = { ...state, list: null, records: {} };
    }
    state = { ...state, error: cap(serverErrorLine() || srv.lastError || "sem conexão com o servidor"), fetchedAt: Date.now() };
    if (st === "disconnected") warnDisconnectedOnce();
    return finishSync();
  }
  refreshStoreWarnings();
  if (!claimOwner(false)) {
    // Outra janela do VS Code cuida do batimento e do login deste computador: esta só lê o estado.
    let resp;
    try {
      resp = await retryOnce(() => client.request("GET", "/v1/state"));
    } catch (e) {
      return serverFailed(e, "estado");
    }
    if (!swapOn()) return finishSync(); // desligou no meio
    if (!applyStateResponse(resp)) return serverFailed(new Error("a resposta do servidor veio sem a lista de contas"), "estado");
    finishSync();
    checkAlerts().catch((e) => console.error("[swap-plus] alerts", safeErr(e)));
    checkModelSwitch().catch((e) => console.error("[swap-plus] modelo padrão", safeErr(e)));
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
    // Sem o estado do servidor ainda (1º ciclo): busca antes, para saber se este computador pode enviar logins
    // (só os do administrador podem). Sem saber, nada é enviado.
    if (loginUploadAllowed() === null && !isSpent(loginKey(live))) {
      let st0;
      try {
        st0 = await client.request("GET", "/v1/state");
      } catch (e) {
        return serverFailed(e, "estado");
      }
      if (!swapOn()) return finishSync(); // desligou no meio
      applyStateResponse(st0);
    }
    up = await uploadLiveLogin(auth, live);
    if (up.kind === "offline") return serverFailed(up.error, "envio do login");
  } else if (!live.unreadable && !(live.oauth && live.oauth.refreshToken)) {
    srv.rejected = null;
  }
  // 2) batimento (pode repetir: só avisa que este computador está vivo)
  let resp;
  try {
    resp = await retryOnce(() => client.request("POST", "/v1/heartbeat", { models: models.map((m) => m.id), live: liveSummary(live), defaultModel: claudeDefaultModel() }));
  } catch (e) {
    return serverFailed(e, "batimento");
  }
  if (!swapOn()) return finishSync(); // desligou no meio: não grava nada
  if (!applyStateResponse(resp)) return serverFailed(new Error("a resposta do servidor veio sem a lista de contas"), "batimento");
  // 3) credencial. Login recusado (ou ainda sendo enviado por outra janela): nada por cima, para não perdê-lo.
  let res = null;
  if (!live.unreadable && !blocked) res = await syncCredentialSafe(client, resp, { live, up, force: !!up });
  if (up && up.kind === "sent") notifyLoginSent(up, res);
  finishSync();
  checkAlerts().catch((e) => console.error("[swap-plus] alerts", safeErr(e)));
  checkModelSwitch().catch((e) => console.error("[swap-plus] modelo padrão", safeErr(e)));
  checkModelBlock().catch((e) => console.error("[swap-plus] nenhuma conta com o modelo", safeErr(e)));
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

/** Troca manual (num = null: o servidor escolhe a melhor conta). */
async function serverSwitch(num) {
  if (!swapOn()) {
    vscode.window.showInformationMessage("Swap Plus está desligado: ligue-o para trocar de conta.");
    return null;
  }
  return srvQueue(() => serverSwitchNow(num));
}

async function serverSwitchNow(num) {
  if (!swapOn()) return null;
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
async function serverLimitHit(label, opts) {
  if (!swapOn()) return null;
  return srvQueue(() => serverLimitHitNow(label, opts));
}

/** quiet: sem o aviso de "não trocou" (quem chamou avisa do jeito dele). */
async function serverLimitHitNow(label, { quiet = false, body = null } = {}) {
  if (!swapOn()) return null;
  let client = null;
  try {
    client = await serverClient();
  } catch {}
  if (!client || serverStatus() === "revoked") return null;
  claimOwner(true); // esta janela viu o limite e vai gravar a conta nova
  let res;
  try {
    res = await client.request("POST", "/v1/events", body || { kind: "limit_hit", label });
  } catch (e) {
    await serverFailed(e, "limite");
    if (!quiet) vscode.window.showWarningMessage(`Swap Plus: a conta em uso bateu o ${label}, mas não consegui avisar o servidor: ${srvErrText(e)}.`);
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
    if (wrote) vscode.window.showInformationMessage(`Swap Plus: ${text}.${resumeTip()}`);
    else if (w.status === "fail" && w.shown) {
      // o erro de gravação já foi mostrado
    } else vscode.window.showWarningMessage(`Swap Plus: o servidor trocou a conta deste computador (${text.replace(/^./, (c) => c.toLowerCase())}), mas não gravei a conta nova aqui: ${w.reason || "falhou"}.`);
  } else if (!quiet) {
    vscode.window
      .showWarningMessage(`Swap Plus: ${text}.${autoEnabled() ? "" : " A troca automática está desligada no servidor."}`, "Trocar para a melhor conta")
      .then((c) => c && switchBest());
  }
  finishSync();
  return { kind: res && res.switched ? (wrote ? "switch" : "blocked") : "blocked", text, noModel: (res && res.noModel) || null };
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
  // devicePlacement vai junto mesmo que o rules.js ainda não a tenha em RULE_DEFAULTS (o servidor ignora chave que não conhece).
  for (const k of new Set([...Object.keys(RULE_DEFAULTS), "devicePlacement"])) if (m.rules && k in m.rules) body[k] = m.rules[k];
  if ("devicePlacement" in body && !DEVICE_PLACEMENTS.includes(body.devicePlacement)) delete body.devicePlacement;
  const resp = await serverCall("PUT", "/v1/rules", { rules: body }, "salvar as regras no servidor");
  if (resp) post({ type: "toast", kind: "info", text: "Regras salvas no servidor (valem para todos os computadores conectados)." });
  else postState();
}

// Regra própria de cada conta (null = segue a regra geral): sessão de 5h, semanal e limite do modelo.
const ACCOUNT_RULE_KEYS = ["threshold", "weeklyThreshold", "modelThreshold"];

/** Valor de linha própria vindo da tela: null (regra geral), número de 50 a 100, ou undefined se inválido. */
function accountRuleValue(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) && n >= 50 && n <= 100 ? n : undefined;
}

// As mudanças de uma conta vão ao servidor uma de cada vez, na ordem em que a pessoa fez
// (os sliders mandam a cada pausa; sem a fila, duas respostas poderiam chegar fora de ordem).
let accountOpChain = Promise.resolve();

function serverAccountOp(m) {
  const run = accountOpChain.then(() => serverAccountOpNow(m));
  accountOpChain = run.catch(() => {});
  return run;
}

async function serverAccountOpNow(m) {
  const n = Number(m.number);
  if (!Number.isInteger(n)) return;
  const ruleOp = ACCOUNT_RULE_KEYS.includes(m.op) || m.op === "useDefault";
  const done = (ok) => {
    if (ruleOp) post({ type: "acctSaved", number: n, op: m.op, seq: m.seq ?? null, ok: !!ok });
  };
  const patch = {};
  if (m.op === "disabled") patch.disabled = !!m.value;
  else if (ACCOUNT_RULE_KEYS.includes(m.op)) {
    const v = accountRuleValue(m.value);
    if (v === undefined) {
      post({ type: "toast", kind: "error", text: `Conta ${n}: a linha precisa ficar entre 50% e 100%.` });
      done(false);
      return postState();
    }
    patch[m.op] = v;
  } else if (m.op === "useDefault") for (const k of ACCOUNT_RULE_KEYS) patch[k] = null;
  else if (m.op === "priority") patch.priority = m.value === null || m.value === "" ? 0 : Number(m.value);
  else if (m.op === "alias") patch.alias = m.value ? String(m.value).slice(0, 24) : null;
  else return;
  const resp = await serverCall("PATCH", `/v1/accounts/${n}`, patch, `Conta ${n}`);
  if (!resp) {
    done(false);
    return postState();
  }
  if (!ruleOp) return;
  // Confere se o servidor guardou mesmo (um servidor antigo ignora weeklyThreshold/modelThreshold).
  let stored = true;
  if (resp.records && typeof resp.records === "object") {
    const rec = recordOf(resp.records, n);
    const same = (a, b) => (a === null || a === undefined ? b === null : b !== null && Math.abs(Number(a) - b) < 0.01);
    stored = Object.keys(patch).every((k) => same(rec[k], patch[k]));
  }
  if (stored) post({ type: "toast", kind: "info", text: m.op === "useDefault" ? `Conta ${n} voltou à regra padrão.` : `Regra da conta ${n} salva no servidor.` });
  else post({ type: "toast", kind: "error", text: `Conta ${n}: o servidor não guardou essa regra (ele pode estar numa versão que ainda não tem regra por conta).` });
  done(stored);
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

// ---- tela de login do Claude Code (claudeCode.disableLoginPrompt)
//
// O Claude Code recebe só o acesso (sem refresh token). Quando o acesso vence antes
// de o Swap Plus gravar o novo, o Claude Code (extensão do VS Code) abriria a tela de
// login. Enquanto este computador está conectado (e o Swap Plus ligado), a tela fica
// desligada; o valor anterior fica guardado e volta ao desconectar ou desligar.

function loginPromptWanted() {
  return swapOn() && !!srv.token && !!serverMeta().url;
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
        `Swap Plus: ${LOGIN_PROMPT_NOTE.charAt(0).toLowerCase()}${LOGIN_PROMPT_NOTE.slice(1)}: a tela de login do Claude Code fica desligada (claudeCode.disableLoginPrompt) e volta como estava ao desconectar ou desligar o Swap Plus.`
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
    vscode.window.showErrorMessage("Swap Plus: esta versão do VS Code não tem o cofre de segredos; atualize o VS Code para conectar ao servidor.");
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

/**
 * Nome deste computador na lista do servidor (sugestão: o nome da máquina). undefined = desistiu.
 * `taken`: o nome que o servidor recusou (já é de outro serviço): a caixa reabre com ele e com a mensagem.
 */
async function askDeviceName(taken) {
  const again = typeof taken === "string";
  const name = await vscode.window.showInputBox({
    title: "Swap Plus: nome deste computador",
    prompt: again
      ? `${serverLib().NAME_TAKEN_MSG || "Já existe um serviço com este nome."} Digite outro nome.`
      : "Como este computador aparece na lista de computadores do servidor.",
    value: again ? taken : defaultDeviceName(),
    ignoreFocusOut: true,
    validateInput: (v) => (String(v || "").trim().length > 60 ? "Use até 60 caracteres." : null),
  });
  if (name === undefined) return undefined;
  return name.trim() || defaultDeviceName();
}

/**
 * Acesso atual deste computador para mandar como `replaces` ao conectar de novo: só para a MESMA origem do servidor
 * em que o token foi emitido (outro servidor não conhece este token e nem deve recebê-lo). → { deviceId, token } | null
 */
async function replacesFor(lib, url) {
  const meta = serverMeta();
  const token = await serverToken();
  if (!token || !meta.deviceId || meta.revokedAt) return null;
  const a = lib.originOf(meta.url);
  return a && a === lib.originOf(url) ? { deviceId: meta.deviceId, token } : null;
}

/** O servidor recusou o nome (já é de outro serviço): avisa e pergunta outro. → nome novo | undefined (desistiu) */
async function askNameAgain(name, message) {
  vscode.window.showWarningMessage(`Swap Plus: ${message || serverLib().NAME_TAKEN_MSG}`);
  return askDeviceName(name);
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
  let name = deviceName || (await askDeviceName());
  if (name === undefined) return null;
  const url = String(parsed.url || "").replace(/\/+$/, "");
  const replaces = await replacesFor(lib, url);
  let res;
  for (;;) {
    try {
      res = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Swap Plus: conectando a ${serverHost(url)}...`, cancellable: false },
        () => lib.pair({ url, fp: parsed.fp || null, code: parsed.code, name, platform: process.platform, replaces })
      );
      break;
    } catch (e) {
      if (e && e.code === "name_taken") {
        // O código continua valendo: só o nome precisa mudar.
        name = await askNameAgain(name, e.message);
        if (name === undefined) return null;
        continue;
      }
      vscode.window.showErrorMessage(`Swap Plus: ${pairErrorText(e, url)}`);
      return null;
    }
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
    return v; // ok | denied | expired | name_taken
  }
}

/** Uma tentativa de entrar com Google: inicia no servidor, abre o navegador e espera o resultado. */
async function googleAttempt(lib, url, name, replaces = null) {
  let start;
  try {
    start = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Swap Plus: conectando a ${serverHost(url)}...`, cancellable: false },
      () => lib.loginStart({ url, fp: null, name, platform: process.platform, replaces })
    );
  } catch (e) {
    if (e && e.code === "name_taken") return { status: "name_taken", message: e.message };
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
  let name = await askDeviceName();
  if (name === undefined) return null;
  const replaces = await replacesFor(lib, url);
  for (;;) {
    const r = await googleAttempt(lib, url, name, replaces);
    if (r.status === "ok") return { url, fp: null, deviceId: r.deviceId, token: r.token, name, via: "google" };
    if (r.status === "name_taken") {
      name = await askNameAgain(name, r.message);
      if (name === undefined) return null;
      continue;
    }
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
 * globalState e atualiza. O login atual do Claude Code vai para o servidor no
 * ciclo seguinte (só nos computadores do administrador).
 */
async function finishConnect(got, had) {
  const { url, deviceId, token, name } = got;
  const fp = got.fp || null;
  const via = got.via === "google" ? "google" : "code";
  // Conexão anterior: o cliente é o do servidor que emitiu o token antigo (mesmo que o endereço tenha mudado).
  const old = had ? { meta: serverMeta(), client: await issuerClient() } : null;
  srv.hold = true; // o ciclo espera até o fim
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
    srv.disconnectedWarned = false;
    // url = onde o token foi emitido: é para lá (e só para lá) que ele vai daqui em diante.
    await extContext.globalState.update(SERVER_META_KEY, { url, fp, deviceId, name, via, connectedAt: Date.now() });
    await extContext.globalState.update(SERVER_APPLIED_KEY, undefined);
    if (String(cfg().get("server.url") || "").replace(/\/+$/, "") !== url) await cfg().update("server.url", url, vscode.ConfigurationTarget.Global);
    await syncLoginPrompt();
    await pushHistory([
      { ts: new Date().toISOString(), kind: "info", text: `Conectado ao servidor ${serverHost(url)} como “${name}”${via === "google" ? " (entrou com Google)" : ""}` },
    ]);
  } finally {
    srv.hold = false;
  }
  await refreshFresh();
  cleanupOldEngine().catch(() => {}); // 3.0: agora que está conectado, o motor antigo pode sair
  const n = state.list ? state.list.activeAccountNumber : null;
  const tail =
    serverStatus() !== "online"
      ? `Ainda sem resposta do servidor: ${srv.lastError || "tento de novo em 30 s"}.`
      : n
        ? `Este computador está na conta ${n}.`
        : loginUploadAllowed() === false
          ? "O servidor ainda não tem conta para este computador: quem adiciona as contas é o administrador."
          : "O servidor ainda não tem conta para este computador: entre com uma conta no Claude Code e o login vai para o servidor.";
  vscode.window.showInformationMessage(`Swap Plus: conectado ao servidor ${serverHost()}. ${tail}`);
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
  state = { ...state, list: null, records: {}, error: null };
  // Sem servidor não há mais como saber do Fable: o modelo padrão volta ao que era.
  await undoModelSwitch("este computador foi desconectado do servidor").catch((e) => console.error("[swap-plus] modelo padrão", safeErr(e)));
}

/** Comando "Desconectar do servidor": revoga este computador no servidor e apaga o acesso guardado. */
async function disconnectServer() {
  const token = await serverToken();
  if (!token) {
    vscode.window.showInformationMessage("Swap Plus: este computador não está conectado a nenhum servidor.");
    return;
  }
  const DISCONNECT = "Desconectar";
  const OFF = "Desconectar e desligar o Swap Plus";
  const c = await vscode.window.showWarningMessage(
    `Desconectar este computador do servidor ${serverHost()}?`,
    {
      modal: true,
      detail:
        "O servidor deixa de mandar o login para este computador e a tela de login do Claude Code volta como estava. O Claude Code fica com o acesso atual até ele vencer (algumas horas); depois disso, entre de novo com Google no Swap Plus.\n\n• Desconectar: o Swap Plus fica ligado, mostrando “não conectado”.\n• Desconectar e desligar: o Claude Code fica normal, sem o Swap Plus (entre com uma conta direto nele).",
    },
    DISCONNECT,
    OFF
  );
  if (c !== DISCONNECT && c !== OFF) return postState();
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
    srv.disconnectedWarned = true; // a pessoa acabou de desconectar: sem o aviso de "não conectado"
    if (c === OFF) await cfg().update("enabled", false, vscode.ConfigurationTarget.Global);
  });
  await syncLoginPrompt();
  await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: c === OFF ? "Desconectado do servidor; Swap Plus desligado" : "Desconectado do servidor" }]);
  finishSync();
  vscode.window.showInformationMessage(
    c === OFF
      ? "Swap Plus: desconectado do servidor e desligado. O Claude Code fica normal."
      : "Swap Plus: desconectado do servidor. Para voltar a usar as contas do servidor, entre com Google de novo (Configurações → Conexão)."
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

/** Histórico da tela: o do servidor + o deste computador desde a conexão (sem conexão: só o deste computador). */
function historyPayload() {
  const local = extContext.globalState.get(HISTORY_KEY) || [];
  const fmt = (h) => ({ ...h, text: safe(h.text), when: fmtWhen(h.ts) });
  if (!srv.state || !Array.isArray(srv.state.history)) return local.map(fmt);
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
  // "Sua conta" no cartão principal: com qual conta Google este computador entrou e qual conta Claude ele usa agora.
  const me = devices.find((d) => d.current) || null;
  const myAssigned = st && st.device ? st.device.assigned : null;
  return {
    status,
    statusText: serverStatusText(status),
    connected: !!srv.token,
    connecting,
    url: serverUrl() || null,
    host: serverHost() || null,
    via: srv.token ? meta.via || null : null,
    deviceName: meta.name || null,
    myGoogle: srv.token && meta.via === "google" ? (priv ? "(e-mail oculto)" : (me && me.googleEmail) || meta.googleEmail || null) : null,
    myAccount: srv.token && myAssigned !== null && myAssigned !== undefined ? accName(myAssigned) : null,
    lastOkWhen: lastContactText(),
    version: st && st.version ? String(st.version) : null,
    devices,
    diag: dg
      ? { value: typeof dg.oldTokenValidAfterRefresh === "boolean" ? dg.oldTokenValidAfterRefresh : null, when: dg.checkedAt ? fmtWhen(dg.checkedAt) : null }
      : null,
    rejected: srv.rejected ? { reason: srv.rejected.reason } : null,
    // Só os computadores do administrador enviam logins (a tela muda a dica da conta com login morto).
    canUploadLogins: loginUploadAllowed() !== false,
    addressChanged: serverAddressChanged(),
    configuredUrl: configuredServerUrl() || null,
    storeWarnings: (srv.storeWarnings || []).map(safe),
    storeBlocked: !!storeBlockReason(),
    loginPromptOff: !!(extContext.globalState.get(LOGIN_PROMPT_KEY) || {}).applied,
    loginPromptNote: LOGIN_PROMPT_NOTE,
    otherWindow: srv.owner === false && serverStatus() === "online",
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
          // Regra própria da conta (null = segue a regra geral): sessão de 5h, semanal e modelo.
          threshold: rec.threshold ?? null,
          weeklyThreshold: rec.weeklyThreshold ?? null,
          modelThreshold: rec.modelThreshold ?? null,
          priority: rec.priority || 0,
          // Computadores que estão usando esta conta agora.
          devices: Array.isArray(acc.assignedDevices) ? acc.assignedDevices.map(String) : [],
        };
      })
    : [];
  const names = scopedNames(list);
  const last = serverLastDecision();
  return {
    type: "state",
    error: state.error ? safe(state.error) : null,
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
      enabled: !!(srv.state && srv.state.autoSwitch),
      last,
      lastWhen: last && last.ts ? fmtWhen(last.ts) : null,
      history: historyPayload(),
    },
    privacy: priv,
    autoModel: modelStatus(),
    updates: updater ? (() => { const u = updater.summary(); if (u.last) u.last.when = fmtWhen(u.last.ts); return u; })() : null,
    ui: {
      showAccountNumber: !!cfg().get("statusBar.showAccountNumber"),
      showModelWeekly: !!cfg().get("statusBar.showModelWeekly"),
      autoResume: cfg().get("resume.enabled") !== false,
    },
    // Retomada automática: se o gancho está mesmo no settings.json do Claude Code, e o erro se não deu para pôr.
    resume: { on: resumeOn(), installed: !!resumeState.installed, error: resumeState.error ? safe(String(resumeState.error.message)) : null },
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
  panel = vscode.window.createWebviewPanel(`${NS}.settings`, "Swap Plus — Configurações", vscode.ViewColumn.One, {
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
      return setServerAuto(!!m.enabled);

    case "setEnabled":
      await setEnabled(!!m.enabled);
      return;

    case "checkNow":
      post({ type: "busy", on: true, text: "Consultando o servidor..." });
      await refreshFresh();
      post({ type: "busy", on: false });
      post({ type: "toast", kind: serverStatus() === "online" ? "info" : "error", text: serverCheckText() });
      return;

    case "saveRules":
      return saveServerRules(m);

    // Avisos ("avisar em X%") deste VS Code: só as configurações locais, nenhum pedido ao servidor.
    case "saveAlerts":
      if (!m.alerts || typeof m.alerts !== "object") return;
      await saveAlerts(m.alerts);
      post({ type: "toast", kind: "info", text: "Avisos salvos neste VS Code." });
      return;

    case "account":
      return serverAccountOp(m);

    case "switch":
      await doSwitch(m.number);
      return;

    case "add":
      addAccount();
      return;

    case "ui": {
      const allowed = ["statusBar.showAccountNumber", "statusBar.showModelWeekly", "privacy.hideEmails", "resume.enabled"];
      if (!allowed.includes(m.key)) return;
      await cfg().update(m.key, m.value, vscode.ConfigurationTarget.Global);
      return;
    }


    case "checkUpdates": {
      post({ type: "busy", on: true, text: "Verificando atualizações..." });
      const r = updater ? await updater.runCheck({ reason: "manual" }) : null;
      post({ type: "busy", on: false });
      postState();
      if (r && r.error) post({ type: "toast", kind: "error", text: `Não consegui falar com o GitHub: ${r.error}` });
      else if (r) post({ type: "toast", kind: "info", text: "Verificação concluída." });
      return;
    }

    case "connectServer":
      await connectServer(typeof m.method === "string" ? m.method : undefined);
      return;

    case "disconnectServer":
      await disconnectServer();
      return;

    case "revokeDevice":
      await revokeDevice(String(m.id || ""));
      return;

    case "useServerAccount":
      await useServerAccount();
      return;

    // Painel do Swap no navegador: sempre o endereço guardado na conexão deste VS Code, nunca um endereço vindo da tela.
    case "openPanel": {
      const link = (await serverToken()) && serverMeta().url ? serverUrl() : "";
      if (!urlOrigin(link)) {
        post({ type: "toast", kind: "error", text: "Este VS Code não está conectado ao servidor: entre primeiro (cartão “Conexão”) para abrir o painel." });
        return;
      }
      if (!(await openInBrowser(link))) post({ type: "toast", kind: "error", text: `Não consegui abrir o navegador. O painel fica em ${link}` });
      return;
    }
  }
}

// ---------------------------------------------------------------- motor antigo (limpeza da 3.0)
//
// Até a 2.x havia o modo local, que usava o motor swap-plus (CLI Python instalado
// pelo uv como o pacote claude-swap, com os comandos claude-swap, cswap e swap-plus).
// Na 3.0 só o servidor guarda os logins. Na primeira abertura, se o comando swap-plus
// ainda existir (~/.local/bin ou PATH), o pacote do uv que o traz (`uv tool list`) é
// desinstalado (`uv tool uninstall <pacote>`, sem sudo e sem pedir senha), com UMA
// notificação. Se nenhum pacote do uv trouxer o swap-plus, nada é mexido (um
// claude-swap instalado por outro motivo fica). Se falhar, só fica anotado no
// histórico, e a próxima tentativa é no mínimo 1 dia depois. A pasta
// ~/.claude-swap-backup (cópias antigas dos logins, que não servem mais) NÃO é
// apagada: a notificação diz que ela pode ser apagada.

const ENGINE_CLEANUP_KEY = "swapPlus.engineCleanup"; // globalState: { done, packages? } | { lastTry, error? }
const ENGINE_RETRY_MS = 24 * 3600e3; // falhou: no máximo uma tentativa por dia
const ENGINE_CLEANUP_DELAY_MS = 15 * 1000; // depois que a janela assenta
const ENGINE_EXE = "swap-plus"; // o comando que só o motor do Swap Plus traz
const IS_WIN = process.platform === "win32";
let engineCleanupTimer = null;
let engineCleanupP = null;

const engineLockFile = () => path.join(os.tmpdir(), `swap-plus-engine-cleanup-${localTag()}.lock`);

/** Arquivos com estes nomes nestas pastas (no Windows, também .exe), na ordem e sem repetir. Só confere se existem. */
function findFiles(names, dirs) {
  const exts = IS_WIN ? [".exe", ""] : [""];
  const seen = new Set();
  const out = [];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      for (const x of exts) {
        const p = path.join(d, n + x);
        const k = IS_WIN ? p.toLowerCase() : p;
        if (seen.has(k)) continue;
        seen.add(k);
        try {
          if (fs.statSync(p).isFile()) out.push(p);
        } catch {}
      }
    }
  }
  return out;
}

const pathDirs = () => String(process.env.PATH || "").split(path.delimiter).filter((d) => d && path.isAbsolute(d)); // nunca pasta relativa

/** Comando swap-plus do motor antigo em ~/.local/bin e no PATH (no Windows, swap-plus.exe). */
function findOldEngine() {
  return findFiles([ENGINE_EXE], [path.join(os.homedir(), ".local", "bin"), ...pathDirs()]);
}

/**
 * O uv (que instalou o motor): ~/.local/bin, ~/.cargo/bin e PATH (no Windows, uv.exe);
 * por último, as pastas do Homebrew (VS Code aberto pelo Dock pode vir com PATH curto). null = não tem.
 */
function findUv() {
  const home = os.homedir();
  const dirs = [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin"), ...pathDirs()];
  if (!IS_WIN) dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  return findFiles(["uv"], dirs)[0] || null;
}

/**
 * Pacotes do `uv tool list` cuja lista de executáveis inclui o swap-plus (no Windows,
 * swap-plus.exe). O motor do Swap Plus é o pacote claude-swap: linha "claude-swap v1.1.0"
 * seguida de "- claude-swap", "- cswap" e "- swap-plus". Um pacote sem o swap-plus não entra.
 */
function enginePackages(listText) {
  const out = [];
  let pkg = null;
  for (const raw of String(listText || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("- ")) {
      const exe = line.slice(2).trim().replace(/\.exe$/i, "").toLowerCase();
      if (pkg && exe === ENGINE_EXE && !out.includes(pkg)) out.push(pkg);
    } else {
      const name = line.split(/\s+/)[0];
      pkg = /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) ? name : null;
    }
  }
  return out;
}

function runUv(uv, args, timeout = 120000) {
  return new Promise((resolve) => {
    execFile(
      uv,
      args,
      { timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, env: { ...process.env, NO_COLOR: "1", UV_NO_PROGRESS: "1" } },
      (err, stdout, stderr) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : -1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
          error: err ? String(err.message || err) : null,
        });
      }
    );
  });
}

/** Trava entre janelas: no máximo uma tentativa por dia neste computador. */
function claimEngineCleanup(now) {
  const file = engineLockFile();
  try {
    let last = 0;
    try {
      last = Number(fs.readFileSync(file, "utf8")) || 0;
    } catch {}
    if (now >= last && now - last < ENGINE_RETRY_MS) return false;
    fs.writeFileSync(file, String(now));
    return true;
  } catch {
    return true;
  }
}

/** Limpeza da 3.0 (uma de cada vez nesta janela). → { status: "done" | "absent" | "wait" | "removed" | "fail" | "error", ... } */
function cleanupOldEngine(opts) {
  if (!engineCleanupP) {
    engineCleanupP = cleanupOldEngineNow(opts)
      .catch((e) => {
        console.error("[swap-plus] motor antigo", safeErr(e));
        return { status: "error" };
      })
      .finally(() => {
        engineCleanupP = null;
      });
  }
  return engineCleanupP;
}

async function cleanupOldEngineNow({ now = Date.now() } = {}) {
  const saved = extContext.globalState.get(ENGINE_CLEANUP_KEY) || {};
  if (saved.done) return { status: "done" };
  // Só depois de conectado ao servidor: num computador que nunca conectou, os logins do modo local
  // (2.x) só existem no motor — removê-lo antes deixaria a pessoa sem eles.
  if (!(await serverToken()) || !serverMeta().url) return { status: "wait", reason: "not_connected" };
  const found = findOldEngine();
  if (!found.length) {
    // Não está instalado (ou outra janela já removeu): nada a fazer, sem aviso.
    await extContext.globalState.update(ENGINE_CLEANUP_KEY, { done: now });
    return { status: "absent" };
  }
  if (saved.lastTry && now >= saved.lastTry && now - saved.lastTry < ENGINE_RETRY_MS) return { status: "wait" };
  if (!claimEngineCleanup(now)) return { status: "wait" }; // outra janela tentou há menos de 1 dia
  await extContext.globalState.update(ENGINE_CLEANUP_KEY, { lastTry: now });
  const ts = new Date().toISOString();
  const fail = async (reason) => {
    const text = `Não consegui remover o motor antigo (swap-plus): ${reason}. Tento de novo daqui a 1 dia`;
    console.warn(`[swap-plus] ${text}`);
    await extContext.globalState.update(ENGINE_CLEANUP_KEY, { lastTry: now, error: reason });
    await pushHistory([{ ts, kind: "warn", text }]);
    postState();
    return { status: "fail", reason };
  };
  // Casos que não mudam sozinhos (sem uv, ou motor instalado de outro jeito): registra uma vez e não tenta mais.
  const skip = async (reason) => {
    const text = `O motor antigo (swap-plus) continua neste computador: ${reason}. Ele não é mais usado; pode ser removido à mão`;
    console.warn(`[swap-plus] ${text}`);
    await extContext.globalState.update(ENGINE_CLEANUP_KEY, { done: now, skipped: reason });
    await pushHistory([{ ts, kind: "info", text }]);
    postState();
    return { status: "skipped", reason };
  };
  const uv = findUv();
  if (!uv) return skip(`o uv não foi encontrado (o motor está em ${found[0]})`);
  // O nome do pacote vem do `uv tool list` (o motor do Swap Plus é o pacote claude-swap: `uv tool uninstall swap-plus` não funciona).
  const listed = await runUv(uv, ["tool", "list"], 60000);
  if (listed.code !== 0) {
    return fail(`uv tool list falhou: ${lastLine(listed.stderr) || lastLine(listed.stdout) || (listed.error ? safeErr(listed.error) : "") || `código ${listed.code}`}`);
  }
  const packages = enginePackages(listed.stdout);
  // Nenhum pacote do uv traz o swap-plus (instalado de outro jeito): não mexe em nada.
  if (!packages.length) return skip(`nenhum pacote do uv traz o comando swap-plus (ele está em ${found[0]}); nada foi removido`);
  const cmd = `uv tool uninstall ${packages.join(" ")}`;
  const res = await runUv(uv, ["tool", "uninstall", ...packages]);
  if (res.code !== 0) {
    return fail(`${cmd} falhou: ${lastLine(res.stderr) || lastLine(res.stdout) || (res.error ? safeErr(res.error) : "") || `código ${res.code}`}`);
  }
  const left = findOldEngine();
  if (left.length) return fail(`depois de ${cmd}, o comando continua em ${left[0]}`);
  const backup = path.join(os.homedir(), ".claude-swap-backup");
  let hasBackup = false;
  try {
    hasBackup = fs.statSync(backup).isDirectory();
  } catch {}
  await extContext.globalState.update(ENGINE_CLEANUP_KEY, { done: Date.now(), packages });
  await pushHistory([{ ts, kind: "info", text: `Motor antigo (swap-plus) removido deste computador (${cmd}); as contas ficam no servidor` }]);
  postState();
  const where = IS_WIN ? backup : "~/.claude-swap-backup";
  vscode.window.showInformationMessage(
    `Swap Plus 3.0: o motor antigo (swap-plus) não é mais usado e foi removido deste computador. As contas ficam no servidor.${
      hasBackup ? ` A pasta ${where} guarda cópias antigas dos logins do modo local: confira no painel se todas as suas contas estão no servidor e, estando, pode apagá-la.` : ""
    }`
  );
  return { status: "removed", packages };
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
    vscode.commands.registerCommand(`${NS}.refreshStatus`, refresh),
    vscode.commands.registerCommand(`${NS}.switchBest`, switchBest),
    vscode.commands.registerCommand(`${NS}.checkUpdates`, () => updater && updater.runCheck({ reason: "manual" })),
    vscode.commands.registerCommand(`${NS}.connectServer`, connectServer),
    vscode.commands.registerCommand(`${NS}.disconnectServer`, disconnectServer)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(NS)) return;
      const onOff = e.affectsConfiguration(`${NS}.enabled`);
      const urlChange = e.affectsConfiguration(`${NS}.server.url`);
      if (urlChange) onServerUrlChanged();
      else if (onOff && !swapOn()) releaseOwner();
      if (onOff || urlChange) {
        // Tela de login do Claude Code: desligada só enquanto está conectado (e ligado).
        syncLoginPrompt();
        setupPolling();
      }
      // Retomada automática: o gancho do Claude Code entra ou sai junto com a opção (e com o Swap Plus inteiro).
      if (onOff || e.affectsConfiguration(`${NS}.resume`)) syncResume();
      // Troca do modelo padrão desligada (ou o Swap Plus inteiro): o padrão volta ao que era.
      if ((onOff || e.affectsConfiguration(`${NS}.autoModel.enabled`)) && !autoModelOn()) {
        undoModelSwitch(swapOn() ? "a troca automática do modelo padrão foi desligada" : "o Swap Plus foi desligado").catch((err) => console.error("[swap-plus] modelo padrão", safeErr(err)));
      }
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
        refreshFresh();
      })
    );
  }

  setupPolling();
  setupOwnerTimer();
  // Lê do cofre do VS Code se este computador está conectado a um servidor (para a tela e a barra).
  serverToken()
    .then(() => {
      syncLoginPrompt();
      finishSync();
    })
    .catch(() => {});

  updater = createUpdater({ context, cfg, pushHistory, postState });
  updater.start();

  setupLimitWatch();
  travas.sweepClaims(alertsClaimDir(), ALERT_CLAIM_MAX_AGE_MS); // avisos com mais de 8 dias
  syncResume();
  // De 10 em 10 min confere de novo: se outro programa regravou o settings.json sem o gancho, ele volta.
  resumeTimer = setInterval(syncResume, RESUME_CHECK_MS);
  if (resumeTimer.unref) resumeTimer.unref();

  // 3.0: remove o motor antigo (swap-plus), uma vez, depois que a janela assenta.
  engineCleanupTimer = setTimeout(() => {
    engineCleanupTimer = null;
    cleanupOldEngine().catch(() => {});
  }, ENGINE_CLEANUP_DELAY_MS);
  if (engineCleanupTimer.unref) engineCleanupTimer.unref();
}

function deactivate() {
  if (pollTimer) clearInterval(pollTimer);
  if (limitTimer) clearInterval(limitTimer);
  if (resumeTimer) clearInterval(resumeTimer);
  if (ownerTimer) clearInterval(ownerTimer);
  if (engineCleanupTimer) clearTimeout(engineCleanupTimer);
  engineCleanupTimer = null;
  releaseOwner(); // outra janela assume o batimento logo (a configuração de login do Claude Code fica: a conexão continua)
  if (updater) {
    updater.stop();
    return updater.onClose().catch(() => {}); // verificação ao fechar o VS Code
  }
}

module.exports = {
  activate,
  deactivate,
  _test: {
    resetServerConnection,
    serverStatus,
    refreshFresh,
    safeErr,
    loginKey,
    syncCredential,
    historyPayload,
    applyStateResponse,
    buildPayload,
    serverSwitch,
    syncLoginPrompt,
    ownerFile,
    uploadLockDir,
    srv,
    swapOn,
    newerInstalledVersion,
    scanLimitErrors,
    checkLimitErrors,
    syncResume,
    resumeOn,
    resumeTip,
    resumeState: () => resumeState,
    limitLabel,
    setLimitRoot: (r) => (projectsRootOverride = r),
    transcripts,
    claimLimit,
    alertsClaimDir,
    modelsShareFile,
    checkAlerts,
    modelStatus,
    checkModelSwitch,
    modelLimitHit,
    resetAbsentAsk: () => ((absentAskedAt = 0), (missingAskedAt = 0)),
    clearModelMarker: () => modelSwitch.clearMarker(modelMarkerFile()),
    modelMarkerFile,
    claudeSettingsPath,
    orderForDisplay,
    pickerTexts,
    detectModels,
    cleanupOldEngine,
    findOldEngine,
    findUv,
    enginePackages,
    engineLockFile,
    cancelEngineCleanup: () => {
      if (engineCleanupTimer) clearTimeout(engineCleanupTimer);
      engineCleanupTimer = null;
    },
    getUpdater: () => updater,
  },
};
