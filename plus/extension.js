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

const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { createUpdater } = require("./updater");

const NS = "swapPlus";
const HISTORY_KEY = "swapPlus.autoHistory";
const LAST_TICK_KEY = "swapPlus.lastTick";
const LAST_SWITCH_KEY = "swapPlus.lastAutoSwitch";
const ALERTED_KEY = "swapPlus.alerted";
const AUTO_LOCK = path.join(os.tmpdir(), "swap-plus-auto.lock");
const HISTORY_MAX = 40;
const MODEL_WINDOW_MS = 30 * 60 * 1000; // modelo "em uso" = usado nos últimos 30 min
const STALE_USAGE_SEC = 20 * 60; // dados de uso mais velhos que isso não decidem troca
const YELLOW_AT = 70;

const STRATEGY_LABELS = {
  headroom: "Mais folga",
  max: "Aproveitar ao máximo",
  priority: "Por prioridade",
};

const STATUS_LABELS = {
  ok: "ok",
  token_expired: "token expirado",
  relogin_required: "precisa logar de novo",
  no_credentials: "sem credenciais",
  api_key: "API key (sem cota)",
  keychain_unavailable: "Keychain indisponível",
  foreign_credential: "credencial de outra conta",
  unavailable: "indisponível",
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
let state = { list: null, records: {}, models: [], error: null, fetchedAt: 0 };

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
  const st = cfg().get("rules.strategy");
  const pref = cfg().get("rules.preferModel");
  return {
    sessionPct: numSetting("rules.sessionSwitchPct", 90, 50, 100),
    weeklyPct: numSetting("rules.weeklySwitchPct", 80, 50, 100),
    modelPct: numSetting("rules.modelSwitchPct", 95, 50, 100),
    preferModel: typeof pref === "string" ? pref.trim() : "Fable",
    strategy: STRATEGY_LABELS[st] ? st : "headroom",
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

function runCswap(args, timeout = 90000) {
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
  return !!s && s !== "ok" && s !== "token_expired";
}

const fmtPct = (v) => `${Math.round(Number(v) || 0)}%`;

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

function roundedDate(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Date(Math.round(d.getTime() / 60000) * 60000); // 17:59:59 → 18:00
}

function dayPrefix(d) {
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return "hoje";
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return "amanhã";
  const wd = d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
  const dm = `${String(d.getDate()).padStart(2, "0")}/${String(d.getMonth() + 1).padStart(2, "0")}`;
  return `${wd} ${dm}`;
}

/** "hoje 18:00", "amanhã 09:30", "sex 20/11 12:00" */
function fmtWhen(iso) {
  const d = roundedDate(iso);
  if (!d) return null;
  return `${dayPrefix(d)} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
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

function getUsage(acc) {
  if (acc.usageStatus === "ok" && acc.usage) return { usage: acc.usage, stale: false, ageSeconds: acc.usageAgeSeconds };
  if (acc.lastGoodUsage) return { usage: acc.lastGoodUsage, stale: true, ageSeconds: acc.lastGoodAgeSeconds };
  return null;
}

/** Janelas de uso de uma conta, já no formato que o resto do código usa. */
function windows(acc) {
  const f = getUsage(acc);
  if (!f) return null;
  const u = f.usage;
  return {
    stale: f.stale || (typeof f.ageSeconds === "number" && f.ageSeconds > STALE_USAGE_SEC),
    ageSeconds: f.ageSeconds,
    // Sem janela de 5h aberta = sessão sem uso recente, 100% livre.
    session: u.fiveHour ? { pct: u.fiveHour.pct, resetsAt: u.fiveHour.resetsAt || null } : { pct: 0, resetsAt: null, idle: true },
    weekly: u.sevenDay
      ? {
          pct: u.sevenDay.pct,
          resetsAt: u.sevenDay.resetsAt || null,
          willLast: u.sevenDay.willLastToReset,
          exhaustAt: u.sevenDay.projectedExhaustionAt || null,
        }
      : null,
    models: (u.scoped || []).map((s) => ({ name: s.name, pct: s.pct, resetsAt: s.resetsAt || null })),
  };
}

function recordOf(records, num) {
  return (records && records[String(num)]) || {};
}

function accountRecord(num) {
  return recordOf(state.records, num);
}

function accountAlias(acc) {
  return acc.alias || accountRecord(acc.number).alias || null;
}

/** Linhas de troca de uma conta: sessão (pode ter limite próprio), semanal, por modelo. */
function linesFor(acc, r, records) {
  const rec = recordOf(records, acc.number);
  const own = rec.threshold !== null && rec.threshold !== undefined && isFinite(Number(rec.threshold));
  return { session: own ? Number(rec.threshold) : r.sessionPct, weekly: r.weeklyPct, model: r.modelPct };
}

function scopedNames(list) {
  const names = new Set();
  for (const a of (list && list.accounts) || []) {
    const w = windows(a);
    if (w) w.models.forEach((m) => names.add(m.name));
  }
  return [...names];
}

// ---------------------------------------------------------------- modelo em uso

function modelLabel(id) {
  const parts = String(id).replace(/^claude-/, "").replace(/-\d{8}$/, "").split("-");
  if (!parts[0] || /^\d/.test(parts[0])) return id;
  const name = parts[0].charAt(0).toUpperCase() + parts[0].slice(1);
  const ver = parts.slice(1).filter((x) => /^\d+$/.test(x)).join(".");
  return ver ? `${name} ${ver}` : name;
}

/** Limites por modelo (ex.: "Fable") que correspondem a um modelo em uso. */
function watchedModels(modelIds, names) {
  return names.filter((n) => modelIds.some((id) => String(id).toLowerCase().includes(n.toLowerCase())));
}

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

/**
 * Decide se troca de conta e para qual. Função pura (testável).
 *   - Gatilho: a conta ativa chegou na linha da sessão, do semanal, ou do
 *     limite de um modelo que está em uso agora.
 *   - Destino: conta na rotação, com dados de uso recentes e abaixo de todas
 *     as linhas que importam (com a folga mínima). Contas com o modelo
 *     preferido (Fable) disponível vêm primeiro; depois vale a estratégia.
 *   - "Aproveitar ao máximo" também troca antes da linha, para uma conta cuja
 *     cota semanal zera logo e ainda está sobrando.
 */
function decide({ list, records, r, modelIds, now, lastSwitchAt, force = false }) {
  const active = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!active) return { action: "none", kind: "idle", text: "nenhuma conta ativa" };
  const names = scopedNames(list);
  // "Mesma conta": o limite do modelo não troca de conta; o Claude Code pergunta e troca o modelo.
  const watch = r.onModelLimit === "switchAccount" ? watchedModels(modelIds, names) : [];
  const pref = r.preferModel && names.includes(r.preferModel) ? r.preferModel : null;

  const aw = windows(active);
  if (!aw || aw.stale) return { action: "none", kind: "idle", text: "uso da conta ativa desatualizado; sem decisão por enquanto" };

  const rowsOf = (w, l) => {
    const rows = [{ label: "sessão", pct: w.session.pct, line: l.session }];
    if (w.weekly) rows.push({ label: "semanal", pct: w.weekly.pct, line: l.weekly });
    for (const name of watch) {
      const s = w.models.find((m) => m.name === name);
      if (s) rows.push({ label: name, pct: s.pct, line: l.model });
    }
    return rows;
  };

  const activeRows = rowsOf(aw, linesFor(active, r, records));
  const over = activeRows.filter((x) => x.pct >= x.line);
  const activeReset = aw.weekly && aw.weekly.resetsAt ? Date.parse(aw.weekly.resetsAt) : Infinity;
  const activeHeadroom = Math.min(...activeRows.map((x) => x.line - x.pct));

  const cands = [];
  for (const acc of list.accounts) {
    if (acc.number === active.number) continue;
    if (recordOf(records, acc.number).disabled) continue;
    const w = windows(acc);
    if (!w || w.stale) continue;
    const l = linesFor(acc, r, records);
    const rows = rowsOf(w, l);
    let prefOk = true;
    if (pref) {
      const s = w.models.find((m) => m.name === pref);
      prefOk = !!s && s.pct <= l.model - r.marginPct;
    }
    cands.push({
      acc,
      strictOk: rows.every((x) => x.pct <= x.line - r.marginPct),
      looseOk: rows.every((x) => x.pct < x.line),
      headroom: Math.min(...rows.map((x) => x.line - x.pct)),
      prefOk,
      resetTs: w.weekly && w.weekly.resetsAt ? Date.parse(w.weekly.resetsAt) : Infinity,
      unused: w.weekly ? 100 - w.weekly.pct : 100,
      priority: Number(recordOf(records, acc.number).priority) || 0,
    });
  }

  const byStrategy = {
    headroom: (x, y) => y.headroom - x.headroom,
    max: (x, y) => x.resetTs - y.resetTs || y.headroom - x.headroom,
    priority: (x, y) => y.priority - x.priority || x.resetTs - y.resetTs || y.headroom - x.headroom,
  };
  const rank = (arr) =>
    [...arr].sort((x, y) => Number(y.prefOk) - Number(x.prefOk) || byStrategy[r.strategy](x, y) || x.acc.number - y.acc.number);
  const pick = () => {
    const strict = rank(cands.filter((c) => c.strictOk));
    return strict.length ? strict[0] : rank(cands.filter((c) => c.looseOk))[0];
  };
  const go = (t, reason) => ({ action: "switch", kind: "switch", from: active.number, to: t.acc.number, reason, text: `da conta ${active.number} para a conta ${t.acc.number}: ${reason}` });

  if (over.length) {
    const reason = over.map((o) => `${o.label} em ${fmtPct(o.pct)} (linha ${fmtPct(o.line)})`).join(", ");
    const t = pick();
    if (!t) return { action: "none", kind: "blocked", text: `conta ${active.number} com ${reason}, mas nenhuma outra conta tem folga` };
    return go(t, reason);
  }

  if (force) {
    const t = pick();
    if (!t || t.headroom <= activeHeadroom) return { action: "none", kind: "idle", text: "a conta atual já é a que tem mais folga" };
    return go(t, "troca pedida pela melhor conta");
  }

  if (r.strategy === "max") {
    const soon = rank(
      cands.filter(
        (c) =>
          c.strictOk &&
          c.resetTs > now &&
          c.resetTs - now <= r.expiringHours * 3600000 &&
          c.resetTs < activeReset - 3600000 &&
          c.unused >= 20
      )
    );
    if (soon.length) {
      if (lastSwitchAt && now - lastSwitchAt < r.cooldownMin * 60000) {
        return { action: "none", kind: "idle", text: "esperando o intervalo mínimo entre trocas" };
      }
      const t = soon[0];
      return go(t, `a cota semanal dela zera ${fmtWhen(new Date(t.resetTs).toISOString())} com ${fmtPct(t.unused)} sobrando`);
    }
  }

  const closest = [...activeRows].sort((a, b) => b.pct / b.line - a.pct / a.line)[0];
  return {
    action: "none",
    kind: "idle",
    text: `abaixo das linhas (mais perto: ${closest.label} ${fmtPct(closest.pct)} de ${fmtPct(closest.line)})`,
  };
}

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

function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const [l, models, records] = await Promise.all([runCswap(["list", "--json"]), detectModels(), readRecords()]);
    const list = parseJson(l.stdout);
    const ok = list && Array.isArray(list.accounts);
    state = {
      list: ok ? list : null,
      records,
      models,
      error: ok ? null : l.spawnError || lastLine(l.stderr) || "não foi possível ler 'swap-plus list --json'",
      fetchedAt: Date.now(),
    };
    render();
    postState();
    checkAlerts().catch((e) => console.error("[swap-plus] alerts", e));
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

  if (!list) {
    mainItem.text = frame("$(mail)  $(warning) Swap Plus: erro");
    mainItem.tooltip = `Falha ao executar o swap-plus.\n${state.error || ""}\n\nVerifique se 'swap-plus list --json' funciona no terminal.`;
    mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    mainItem.show();
    return;
  }

  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc) {
    mainItem.text = frame("$(mail)  sem conta ativa");
    mainItem.tooltip = "Clique para escolher uma conta ou abrir as configurações.";
    mainItem.show();
    return;
  }

  const r = rules();
  const l = linesFor(acc, r, state.records);
  const w = windows(acc);
  const icon = cfg().get("statusBar.showAccountNumber") ? `$(mail) ${acc.number}` : "$(mail)";
  mainItem.tooltip = usageTooltip(acc, w, l);

  if (!w) {
    mainItem.text = frame(`${icon}  Uso: ${statusLabel(acc.usageStatus)}`);
    if (needsAttention(acc.usageStatus)) mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
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
  if (needsAttention(acc.usageStatus)) mainItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");
  mainItem.show();
}

// ---------------------------------------------------------------- polling

function setupPolling() {
  if (pollTimer) clearInterval(pollTimer);
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
  if (!autoEnabled()) return;
  const loop = async () => {
    if (gen !== autoGen) return;
    try {
      await autoTick({ manual: false });
    } catch (e) {
      console.error("[swap-plus] auto tick", e);
    }
    if (gen === autoGen && autoEnabled()) autoTimer = setTimeout(loop, rules().intervalSec * 1000);
  };
  autoTimer = setTimeout(loop, 5000);
}

async function pushHistory(entries) {
  if (!entries.length) return;
  const hist = extContext.globalState.get(HISTORY_KEY) || [];
  const fresh = entries.filter((e) => !(hist[0] && hist[0].kind === e.kind && hist[0].text === e.text));
  if (!fresh.length) return;
  await extContext.globalState.update(HISTORY_KEY, [...fresh.reverse(), ...hist].slice(0, HISTORY_MAX));
}

async function execSwitch(d) {
  const res = await runCswap(["switch", String(d.to)], 120000);
  await refresh();
  const now = state.list ? state.list.activeAccountNumber : null;
  if (res.code === 0 && now === d.to) return { ok: true };
  return { ok: false, error: lastLine(res.stderr) || res.spawnError || `a conta ativa continua ${now}` };
}

async function autoTick({ manual = false, dryRun = false } = {}) {
  const r = rules();
  if (!manual && !claimSlot(r.intervalSec * 1000)) return null;
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
        main = { ts, kind: "switch", text: `Trocou ${d.text}` };
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
    vscode.window.showInformationMessage(`Swap Plus: ${main.text}.${model ? ` O Claude Code continua no ${model.label}.` : ""}`);
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

async function switchBest() {
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
  await refresh();
  const list = state.list;
  if (!list || !list.accounts.length) {
    const choice = await vscode.window.showErrorMessage(
      list ? "Nenhuma conta Claude cadastrada ainda." : `Swap Plus: ${state.error}`,
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
    { label: "$(gear) Configurações...", description: "regras de aviso e de troca automática", accountNum: -2 },
    { label: "Contas", kind: vscode.QuickPickItemKind.Separator },
    ...items,
    { label: "", kind: vscode.QuickPickItemKind.Separator },
    { label: "$(add) Adicionar conta...", description: "logar uma nova conta Claude Code", accountNum: -1 },
  ];

  const picked = await vscode.window.showQuickPick(menu, { placeHolder: "Escolha a conta Claude ou abra as configurações" });
  if (!picked) return;
  if (picked.accountNum === -1) return addAccount();
  if (picked.accountNum === -2) return openSettings();
  if (picked.accountNum !== list.activeAccountNumber) await doSwitch(picked.accountNum);
}

async function doSwitch(num) {
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Trocando para a conta ${num}...`, cancellable: false },
    () => runCswap(["switch", String(num)], 120000)
  );
  if (r.code === 0) {
    vscode.window.showInformationMessage(`Swap Plus: agora na conta ${num}.`);
    await pushHistory([{ ts: new Date().toISOString(), kind: "manual", text: `Troca manual para a conta ${num}` }]);
  } else {
    vscode.window.showErrorMessage(`Falha ao trocar de conta: ${lastLine(r.stderr) || r.spawnError || "erro desconhecido"}`);
  }
  await refresh();
}

// ---------------------------------------------------------------- exportar / importar

/**
 * Export Other: todas as contas, e o outro computador entra em modo privado ao
 * importar (mostra só "Conta N"). Export Me: igual, mas sem ligar o modo privado.
 * O arquivo leva as credenciais em texto puro; o outro lado importa com o
 * botão "Importar contas" (ou `swap-plus import`, que ignora a marca).
 */
async function exportAccounts(mode) {
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

/** Configurações do Swap Plus que viajam no export (não vão: caminho do executável e modo privado). */
const NOT_EXPORTED = new Set(["swapPlus.executablePath", "swapPlus.privacy.hideEmails"]);

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
    for (const c of cmds) await runCswap(c);
    if (cmds.length) n++;
  }
  return n;
}

async function importAccounts() {
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
    () => runCswap(["import", file], 180000)
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
  const r = await runCswap(["--version"], 20000);
  const m = `${r.stdout} ${r.stderr}`.match(/(\d+\.\d+\.\d+\S*)/);
  return r.code === 0 && m ? m[1] : null;
}

function addAccount() {
  const term = vscode.window.createTerminal("Swap Plus");
  term.show();
  // No PowerShell um caminho entre aspas precisa do & para ser executado.
  term.sendText(process.platform === "win32" ? `& "${cswapPath()}" add` : `"${cswapPath()}" add`);
}

async function toggleAuto() {
  const next = !autoEnabled();
  await cfg().update("autoSwitch.enabled", next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Swap Plus: troca automática ${next ? "ligada" : "desligada"}.`);
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
          stale: w ? w.stale : false,
          lines: l,
          session: w ? winPayload(w.session, l.session) : null,
          weekly: w && w.weekly ? winPayload(w.weekly, l.weekly) : null,
          models: w ? w.models.map((m) => ({ name: m.name, ...winPayload(m, l.model) })) : [],
          disabled: !!rec.disabled,
          threshold: rec.threshold,
          priority: rec.priority || 0,
        };
      })
    : [];
  const names = scopedNames(list);
  const last = extContext.globalState.get(LAST_TICK_KEY) || null;
  return {
    type: "state",
    error: state.error ? safe(state.error) : null,
    fetchedAt: state.fetchedAt,
    accounts,
    modelNames: names,
    modelsInUse: state.models.map((m) => ({ id: m.id, label: m.label, minutesAgo: Math.max(0, Math.round((Date.now() - m.ts) / 60000)) })),
    watch: watchedModels(state.models.map((m) => m.id), names),
    rules: r,
    alerts: alertSettings(),
    auto: {
      enabled: autoEnabled(),
      last,
      lastWhen: last && last.ts ? fmtWhen(last.ts) : null,
      history: (extContext.globalState.get(HISTORY_KEY) || []).map((h) => ({ ...h, text: safe(h.text), when: fmtWhen(h.ts) })),
    },
    privacy: priv,
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

async function handleMessage(m) {
  switch (m.type) {
    case "ready":
    case "refresh":
      postState();
      await refresh();
      return;

    case "setAuto":
      await cfg().update("autoSwitch.enabled", !!m.enabled, vscode.ConfigurationTarget.Global);
      return; // onDidChangeConfiguration cuida do resto

    case "checkNow": {
      post({ type: "busy", on: true, text: m.dryRun ? "Simulando..." : "Verificando..." });
      const res = await autoTick({ manual: true, dryRun: !!m.dryRun });
      post({ type: "busy", on: false });
      if (res) post({ type: "toast", kind: res.kind === "error" ? "error" : "info", text: (m.dryRun ? "Simulação: " : "") + res.text });
      return;
    }

    case "saveRules": {
      const cur = rules();
      for (const [k, key] of Object.entries(RULE_SETTINGS)) {
        if (!m.rules || !(k in m.rules) || m.rules[k] === cur[k]) continue;
        await cfg().update(key, m.rules[k], vscode.ConfigurationTarget.Global);
      }
      if (m.alerts && typeof m.alerts === "object") {
        const ca = alertSettings();
        for (const k of Object.keys(ca)) {
          if (!(k in m.alerts) || m.alerts[k] === ca[k]) continue;
          const v = typeof ca[k] === "boolean" ? !!m.alerts[k] : Math.max(1, Math.min(100, Number(m.alerts[k]) || ca[k]));
          await cfg().update(`alerts.${k}`, v, vscode.ConfigurationTarget.Global);
        }
      }
      setupAuto();
      render();
      postState();
      post({ type: "toast", kind: "info", text: "Regras salvas." });
      return;
    }

    case "account": {
      const n = String(m.number);
      let args;
      if (m.op === "disabled") args = [m.value ? "disable" : "enable", n];
      else if (m.op === "threshold") args = m.value === null || m.value === "" ? ["threshold", n, "--unset"] : ["threshold", n, String(m.value)];
      else if (m.op === "priority") args = ["priority", n, String(m.value === null || m.value === "" ? 0 : m.value)];
      else if (m.op === "alias") args = m.value ? ["alias", n, String(m.value)] : ["alias", n, "--unset"];
      else return;
      const r = await runCswap(args);
      if (r.code !== 0) post({ type: "toast", kind: "error", text: `Conta ${n}: ${lastLine(r.stderr) || lastLine(r.stdout) || r.spawnError || "erro"}` });
      await refresh();
      return;
    }

    case "switch":
      await doSwitch(m.number);
      return;

    case "move": {
      // Reordenar: troca a posição (número) com a conta vizinha. O swap-plus leva
      // junto apelido, ajustes, cópias e histórico; a sessão aberta não é tocada.
      const nums = state.list ? state.list.accounts.map((a) => a.number).sort((a, b) => a - b) : [];
      const i = nums.indexOf(Number(m.number));
      const j = m.dir === "up" ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= nums.length) return;
      post({ type: "busy", on: true, text: "Reordenando..." });
      const r = await runCswap(["swap", String(nums[i]), String(nums[j])], 60000);
      post({ type: "busy", on: false });
      if (r.code !== 0) post({ type: "toast", kind: "error", text: `Não consegui reordenar: ${lastLine(r.stderr) || lastLine(r.stdout) || r.spawnError || "erro"}` });
      else await pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Contas ${nums[i]} e ${nums[j]} trocaram de posição` }]);
      await refresh();
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
    vscode.commands.registerCommand(`${NS}.addAccount`, addAccount),
    vscode.commands.registerCommand(`${NS}.refreshStatus`, refresh),
    vscode.commands.registerCommand(`${NS}.switchBest`, switchBest),
    vscode.commands.registerCommand(`${NS}.exportOther`, () => exportAccounts("other")),
    vscode.commands.registerCommand(`${NS}.exportMe`, () => exportAccounts("me")),
    vscode.commands.registerCommand(`${NS}.importAccounts`, importAccounts),
    vscode.commands.registerCommand(`${NS}.checkUpdates`, () => updater && updater.runCheck({ reason: "manual" }))
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(NS)) return;
      if (e.affectsConfiguration(`${NS}.pollIntervalMinutes`) || e.affectsConfiguration(`${NS}.executablePath`)) setupPolling();
      if (e.affectsConfiguration(`${NS}.autoSwitch.enabled`) || e.affectsConfiguration(`${NS}.rules.intervalSeconds`)) setupAuto();
      render();
      postState();
    })
  );

  setupPolling();
  setupAuto();

  updater = createUpdater({ context, cfg, cliVersion, onCliUpdated: refresh, pushHistory, postState });
  updater.start();
}

function deactivate() {
  autoGen++;
  if (pollTimer) clearInterval(pollTimer);
  if (autoTimer) clearTimeout(autoTimer);
  if (updater) {
    updater.stop();
    return updater.onClose().catch(() => {}); // verificação ao fechar o VS Code
  }
}

module.exports = { activate, deactivate, _test: { claudeCodeStatus, prepareClaudeCode, orderForDisplay, readExportFile, copyFileAny, writeFileAny, removeFileAny, shellFile, decide, pickerTexts, windows, linesFor, level, watchedModels, modelLabel, detectModels, getUpdater: () => updater } };
