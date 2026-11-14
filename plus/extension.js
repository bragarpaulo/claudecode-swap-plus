"use strict";
// Swap Plus — fork pessoal de smith89k/claude-swap-status (MIT).
// Barra de status compacta (ícone de e-mail com o endereço no hover) e uma
// tela de configuração das trocas automáticas, tudo em cima do CLI `swap-plus`
// (fork do claude-swap; o `cswap` original também serve).

const vscode = require("vscode");
const { execFile } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const NS = "swapPlus";
const HISTORY_KEY = "swapPlus.autoHistory";
const LAST_TICK_KEY = "swapPlus.lastTick";
const ALERTED_KEY = "swapPlus.alerted";
const AUTO_LOCK = path.join(os.tmpdir(), "swap-plus-auto.lock");
const HISTORY_MAX = 40;

const RULE_KEYS = [
  "autoswitch.threshold",
  "autoswitch.weeklyThreshold",
  "autoswitch.strategy",
  "autoswitch.model",
  "autoswitch.intervalSeconds",
  "autoswitch.cooldownSeconds",
  "autoswitch.hysteresisPct",
];

const STRATEGY_LABELS = {
  best: "Mais folga",
  "weekly-first": "Semanal primeiro",
  "consume-first": "Esgotar quem renova antes",
  "priority-consume-first": "Por prioridade",
};

const TRIGGER_LABELS = {
  proactive: "chegou no limite configurado",
  "at-limit": "conta bateu o limite",
  failover: "conta com problema",
  "consume-first": "outra conta renova antes",
  priority: "conta de prioridade maior disponível",
};

const REASON_LABELS = {
  "below-threshold": "abaixo do limite",
  cooldown: "aguardando intervalo mínimo entre trocas",
  "no-candidates": "nenhuma outra conta disponível",
  "no-viable-target": "nenhuma conta com folga suficiente",
  "no-qualifying-candidate": "nenhuma conta atende às regras",
  "no-comparison": "sem dados para comparar",
  "already-active": "já está na melhor conta",
  "already-consuming-soonest": "já está na conta que renova antes",
  "already-consuming-priority": "já está na conta de maior prioridade",
  "active-idle": "conta ativa sem uso recente",
  "active-usage-unknown": "uso da conta ativa desconhecido",
  "active-api-key": "conta ativa é API key",
  "stale-usage": "dados de uso desatualizados",
  "reset-unknown": "horário de renovação desconhecido",
  "no-active-account": "nenhuma conta ativa",
  "unmanaged-active-account": "conta ativa não está cadastrada no swap-plus",
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
let mailItem;
let usageItem;
let panel;
let pollTimer;
let autoTimer;
let autoGen = 0;
let refreshing = null;
let lastBlockedWarnAt = 0;
let state = { list: null, config: {}, configPath: null, records: {}, error: null, fetchedAt: 0 };

// ---------------------------------------------------------------- helpers

function cfg() {
  return vscode.workspace.getConfiguration(NS);
}

function cswapPath() {
  const configured = (cfg().get("executablePath") || "").trim();
  if (configured) return configured;
  // swap-plus é o comando do fork; cswap (o original) fica como reserva.
  for (const name of ["swap-plus", "cswap"]) {
    const local = path.join(os.homedir(), ".local", "bin", name);
    if (fs.existsSync(local)) return local;
  }
  return "swap-plus";
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
  return lines.length ? lines[lines.length - 1] : "";
}

function getUsage(acc) {
  if (acc.usageStatus === "ok" && acc.usage) return { usage: acc.usage, stale: false, ageSeconds: acc.usageAgeSeconds };
  if (acc.lastGoodUsage) return { usage: acc.lastGoodUsage, stale: true, ageSeconds: acc.lastGoodAgeSeconds };
  return null;
}

function statusLabel(s) {
  return (s && STATUS_LABELS[s]) || s || "desconhecido";
}

function needsAttention(s) {
  return !!s && s !== "ok" && s !== "token_expired";
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

function fmtWhen(iso) {
  let d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  d = new Date(Math.round(d.getTime() / 60000) * 60000); // 17:59:59 → 18:00
  const now = new Date();
  const time = d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  if (d.toDateString() === now.toDateString()) return `hoje ${time}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `amanhã ${time}`;
  const wd = d.toLocaleDateString("pt-BR", { weekday: "short" }).replace(".", "");
  const dm = d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  return `${wd} ${dm} ${time}`;
}

function fmtWindow(w) {
  const r = resetIn(w.resetsAt);
  return `${progressBar(w.pct)} ${Math.round(w.pct)}%${r ? ` R:${r}` : ""}`;
}

function resetDetail(w) {
  if (!w || !w.resetsAt) return "sem renovação agendada";
  const when = fmtWhen(w.resetsAt);
  const r = resetIn(w.resetsAt);
  return `renova ${when || ""}${r ? ` (em ${r})` : ""}`.trim();
}

function confValue(key) {
  const c = state.config[key];
  return c ? c.value : undefined;
}

function autoEnabled() {
  return !!cfg().get("autoSwitch.enabled");
}

function autoIntervalMs() {
  const v = Number(confValue("autoswitch.intervalSeconds"));
  return Math.max(15, isFinite(v) && v > 0 ? v : 60) * 1000;
}

function rulesSummary() {
  const th = confValue("autoswitch.threshold");
  const wk = confValue("autoswitch.weeklyThreshold");
  const st = confValue("autoswitch.strategy") || "best";
  const model = confValue("autoswitch.model");
  const parts = [`5h ≥ ${th ?? 90}%`, `semanal ≥ ${wk ?? th ?? 90}%`];
  if (model) parts.push(`modelo: ${model}`);
  parts.push(STRATEGY_LABELS[st] || st);
  return parts.join(" · ");
}

function accountRecord(num) {
  return (state.records && state.records[String(num)]) || {};
}

function accountAlias(acc) {
  return acc.alias || accountRecord(acc.number).alias || null;
}

// ---------------------------------------------------------------- data

async function readRecords(configPath) {
  const root = configPath ? path.dirname(configPath) : path.join(os.homedir(), ".claude-swap-backup");
  try {
    const seq = JSON.parse(await fs.promises.readFile(path.join(root, "sequence.json"), "utf8"));
    const out = {};
    for (const [num, rec] of Object.entries(seq.accounts || {})) {
      // Só os campos de preferência; nada de credenciais.
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
    const [l, c] = await Promise.all([runCswap(["list", "--json"]), runCswap(["config", "--json"])]);
    const list = parseJson(l.stdout);
    const confRaw = parseJson(c.stdout);
    const config = {};
    if (confRaw && Array.isArray(confRaw.settings)) {
      for (const s of confRaw.settings) config[s.key] = { value: s.value, isSet: s.isSet };
    }
    const configPath = (confRaw && confRaw.path) || state.configPath;
    const records = await readRecords(configPath);
    const ok = list && Array.isArray(list.accounts);
    state = {
      list: ok ? list : null,
      config: Object.keys(config).length ? config : state.config,
      configPath,
      records,
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

// ---------------------------------------------------------------- status bar

function render() {
  if (!mailItem || !usageItem) return;
  usageItem.backgroundColor = undefined;
  const list = state.list;

  if (!list) {
    mailItem.text = "$(mail)";
    mailItem.tooltip = "Swap Plus: não consegui executar o swap-plus.";
    usageItem.text = "$(warning) Claude: erro no swap-plus";
    usageItem.tooltip = `Falha ao executar o swap-plus.\n${state.error || ""}\n\nVerifique se 'swap-plus list --json' funciona no terminal.`;
    usageItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
    mailItem.show();
    usageItem.show();
    return;
  }

  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc) {
    mailItem.text = "$(mail)";
    mailItem.tooltip = "Nenhuma conta ativa. Clique para escolher.";
    usageItem.text = "Claude: sem conta ativa";
    usageItem.tooltip = "Clique para escolher uma conta ou abrir as configurações.";
    mailItem.show();
    usageItem.show();
    return;
  }

  const alias = accountAlias(acc);
  const showNum = !!cfg().get("statusBar.showAccountNumber");
  const showModel = !!cfg().get("statusBar.showModelWeekly");
  const autoOn = autoEnabled();

  // ---- ícone de e-mail (hover mostra o endereço)
  mailItem.text = showNum ? `$(mail) ${acc.number}` : "$(mail)";
  const mt = new vscode.MarkdownString(undefined, true);
  mt.appendMarkdown("$(mail) ");
  mt.appendText(acc.email || "");
  mt.appendMarkdown("  \n");
  const meta = [`Conta ${acc.number}`];
  if (alias) meta.push(alias);
  if (acc.plan && acc.plan.label) meta.push(`plano ${acc.plan.label}`);
  if (acc.organizationName) meta.push(acc.organizationName);
  mt.appendText(meta.join(" · "));
  mt.appendMarkdown("\n\n_Clique para trocar de conta ou abrir as configurações_");
  mailItem.tooltip = mt;

  // ---- uso
  let five = "N/A";
  let seven = "N/A";
  let modelStr = "";
  let staleMark = "";
  let maxPct = 0;
  const found = getUsage(acc);
  const ut = new vscode.MarkdownString(undefined, true);
  ut.appendMarkdown(`**Uso — conta ${acc.number}**`);
  if (alias) ut.appendText(` (${alias})`);
  ut.appendMarkdown("\n\n");

  if (found) {
    const u = found.usage;
    if (found.stale) {
      staleMark = " $(history)";
      ut.appendText(`Mostrando o último uso conhecido, de ${Math.round((found.ageSeconds || 0) / 60)} min atrás (${statusLabel(acc.usageStatus)}).`);
      ut.appendMarkdown("\n\n");
    }
    if (u.fiveHour) {
      five = fmtWindow(u.fiveHour);
      maxPct = Math.max(maxPct, u.fiveHour.pct);
    }
    if (u.sevenDay) {
      seven = fmtWindow(u.sevenDay);
      maxPct = Math.max(maxPct, u.sevenDay.pct);
    }
    const lines = [];
    lines.push(`5h: ${u.fiveHour ? Math.round(u.fiveHour.pct) + "%" : "—"} — ${resetDetail(u.fiveHour)}`);
    lines.push(`Semanal: ${u.sevenDay ? Math.round(u.sevenDay.pct) + "%" : "—"} — ${resetDetail(u.sevenDay)}`);
    for (const s of u.scoped || []) {
      lines.push(`${s.name} (semanal): ${Math.round(s.pct)}% — ${resetDetail(s)}`);
      if (showModel) {
        modelStr += ` | ${s.name}: ${progressBar(s.pct)} ${Math.round(s.pct)}%`;
        maxPct = Math.max(maxPct, s.pct);
      }
    }
    if (u.sevenDay && u.sevenDay.willLastToReset === false && u.sevenDay.projectedExhaustionAt) {
      lines.push(`⚠ No ritmo atual, o semanal acaba ${fmtWhen(u.sevenDay.projectedExhaustionAt)}`);
    }
    for (const line of lines) {
      ut.appendText(line);
      ut.appendMarkdown("  \n");
    }
  } else if (acc.usageStatus) {
    five = seven = statusLabel(acc.usageStatus);
    ut.appendText(`Status: ${statusLabel(acc.usageStatus)}`);
    ut.appendMarkdown("  \n");
  }

  if (maxPct >= 85) usageItem.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  else if (maxPct >= 70 || needsAttention(acc.usageStatus)) usageItem.backgroundColor = new vscode.ThemeColor("statusBarItem.warningBackground");

  ut.appendMarkdown("\n---\n\n");
  if (autoOn) {
    ut.appendMarkdown("$(sync) Troca automática **ligada** — ");
    ut.appendText(rulesSummary());
  } else {
    ut.appendMarkdown("$(circle-slash) Troca automática **desligada**");
  }
  const last = extContext && extContext.globalState.get(LAST_TICK_KEY);
  if (autoOn && last && last.ts) {
    ut.appendMarkdown("  \n");
    ut.appendText(`Última verificação ${fmtWhen(last.ts) || ""}: ${last.text}`);
  }
  ut.appendMarkdown("\n\n_Clique para trocar de conta ou abrir as configurações_");

  usageItem.text = `5h: ${five} | 7d: ${seven}${modelStr}${staleMark}${autoOn ? " $(sync)" : ""}`;
  usageItem.tooltip = ut;
  mailItem.show();
  usageItem.show();
}

// ---------------------------------------------------------------- alertas

function alertSettings() {
  const c = cfg();
  const pct = (k, d) => Math.max(1, Math.min(100, Number(c.get(k)) || d));
  return {
    fiveHourEnabled: !!c.get("alerts.fiveHourEnabled"),
    fiveHourPct: pct("alerts.fiveHourPct", 80),
    weeklyEnabled: !!c.get("alerts.weeklyEnabled"),
    weeklyPct: pct("alerts.weeklyPct", 80),
    modelEnabled: !!c.get("alerts.modelEnabled"),
    modelPct: pct("alerts.modelPct", 80),
  };
}

/** "Chegou a X% → avisar": uma notificação por conta, janela e ciclo de renovação. */
async function checkAlerts() {
  const list = state.list;
  if (!list) return;
  const acc = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!acc) return;
  const found = getUsage(acc);
  if (!found || found.stale) return;
  const u = found.usage;
  const a = alertSettings();
  const checks = [];
  if (a.fiveHourEnabled && u.fiveHour) checks.push({ id: "5h", label: "na janela de 5h", w: u.fiveHour, line: a.fiveHourPct });
  if (a.weeklyEnabled && u.sevenDay) checks.push({ id: "7d", label: "no limite semanal", w: u.sevenDay, line: a.weeklyPct });
  if (a.modelEnabled) for (const s of u.scoped || []) checks.push({ id: `m:${s.name}`, label: `no semanal do ${s.name}`, w: s, line: a.modelPct });

  for (const ch of checks) {
    if (!(ch.w.pct >= ch.line)) continue;
    const key = `${acc.number}|${ch.id}|${ch.line}|${String(ch.w.resetsAt || "").slice(0, 13)}`;
    const alerted = extContext.globalState.get(ALERTED_KEY) || [];
    if (alerted.includes(key)) continue;
    await extContext.globalState.update(ALERTED_KEY, [key, ...alerted].slice(0, 200));
    const r = resetIn(ch.w.resetsAt);
    const text = `Conta ${acc.number} chegou a ${Math.round(ch.w.pct)}% ${ch.label}${r ? ` (renova em ${r})` : ""}`;
    await pushHistory([{ ts: new Date().toISOString(), kind: "alert", text }]);
    postState();
    const tail = autoEnabled() ? " A troca automática assume quando passar da linha de troca." : "";
    vscode.window.showWarningMessage(`Swap Plus: ${text}.${tail}`, "Trocar para a melhor conta", "Configurar").then((choice) => {
      if (choice === "Trocar para a melhor conta") switchBest();
      else if (choice === "Configurar") openSettings();
    });
  }
}

async function switchBest() {
  const model = confValue("autoswitch.model");
  const args = ["switch", "--strategy", "best", "--json"];
  if (model) args.push("--model", String(model));
  const before = state.list ? state.list.activeAccountNumber : null;
  const r = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: "Trocando para a conta com mais folga...", cancellable: false },
    () => runCswap(args, 120000)
  );
  await refresh();
  const after = state.list ? state.list.activeAccountNumber : null;
  if (r.code !== 0) {
    vscode.window.showErrorMessage(`Falha ao trocar de conta: ${lastLine(r.stderr) || r.spawnError || "erro desconhecido"}`);
  } else if (after !== before) {
    vscode.window.showInformationMessage(`Swap Plus: agora na conta ${after}.`);
    await pushHistory([{ ts: new Date().toISOString(), kind: "manual", text: `Troca manual para a conta ${after} (melhor conta)` }]);
    postState();
  } else {
    vscode.window.showInformationMessage("Swap Plus: a conta atual já é a melhor opção.");
  }
}

// ---------------------------------------------------------------- polling

function setupPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const minutes = Math.max(0.5, Number(cfg().get("pollIntervalMinutes")) || 1);
  refresh();
  pollTimer = setInterval(() => refresh(), minutes * 60 * 1000);
}

// ---------------------------------------------------------------- auto-switch

function claimSlot(ms) {
  // Evita que várias janelas do VS Code rodem a verificação ao mesmo tempo.
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
    if (gen === autoGen && autoEnabled()) autoTimer = setTimeout(loop, autoIntervalMs());
  };
  autoTimer = setTimeout(loop, 5000);
}

function accRef(ref) {
  if (!ref) return "(nenhuma)";
  return `conta ${ref.number}`;
}

function summarize(events, code, dryRun, stderr) {
  const ts = new Date().toISOString();
  const extra = [];
  for (const e of events) {
    if (e.event === "account-quarantined") extra.push({ ts, kind: "warn", text: `Conta ${e.number} saiu da rotação temporariamente (${e.reason})` });
    if (e.event === "account-unquarantined") extra.push({ ts, kind: "info", text: `Conta ${e.number} voltou para a rotação` });
  }
  const sw = events.find((e) => e.event === "switch");
  if (sw) {
    const verb = dryRun ? "Trocaria" : "Trocou";
    return {
      main: { ts, kind: dryRun ? "sim" : "switch", text: `${verb} da ${accRef(sw.from)} para a ${accRef(sw.to)} — ${TRIGGER_LABELS[sw.trigger] || sw.trigger}`, to: sw.to ? sw.to.number : null },
      extra,
    };
  }
  const ex = events.find((e) => e.event === "all-exhausted");
  if (ex) {
    const when = ex.earliestResetAt ? fmtWhen(ex.earliestResetAt) : null;
    return { main: { ts, kind: "blocked", text: `Todas as contas no limite${when ? ` — a primeira renova ${when}` : ""}` }, extra };
  }
  const err = events.find((e) => e.event === "error");
  if (err) return { main: { ts, kind: "error", text: `Erro: ${err.message}` }, extra };
  const ns = events.find((e) => e.event === "no-switch");
  if (ns) {
    const reason = REASON_LABELS[ns.reason] || ns.reason;
    return { main: { ts, kind: code === 3 ? "blocked" : "idle", text: `Sem troca: ${reason}${ns.detail ? ` (${ns.detail})` : ""}` }, extra };
  }
  if (code !== 0 && code !== 2) {
    return { main: { ts, kind: "error", text: `Erro ao rodar 'swap-plus auto'${stderr ? `: ${lastLine(stderr)}` : ""}` }, extra };
  }
  return { main: { ts, kind: "idle", text: "Sem troca" }, extra };
}

async function pushHistory(entries) {
  if (!entries.length) return;
  const hist = extContext.globalState.get(HISTORY_KEY) || [];
  const next = [...entries.reverse(), ...hist].slice(0, HISTORY_MAX);
  await extContext.globalState.update(HISTORY_KEY, next);
}

async function autoTick({ manual = false, dryRun = false } = {}) {
  if (!manual && !claimSlot(autoIntervalMs())) return null;
  const args = ["auto", "--once", "--json"];
  if (dryRun) args.push("--dry-run");
  const r = await runCswap(args, 180000);
  const events = r.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(parseJson)
    .filter(Boolean);
  const { main, extra } = summarize(events, r.code, dryRun, r.stderr || r.spawnError);

  if (!dryRun) {
    await extContext.globalState.update(LAST_TICK_KEY, main);
    const notable = main.kind === "idle" ? [] : [main];
    await pushHistory([...extra, ...notable]);
  }

  if (main.kind === "switch") {
    vscode.window.showInformationMessage(`Swap Plus: ${main.text}.`);
    await refresh();
  } else if (main.kind === "blocked" && !manual && !dryRun && Date.now() - lastBlockedWarnAt > 60 * 60 * 1000) {
    lastBlockedWarnAt = Date.now();
    vscode.window.showWarningMessage(`Swap Plus: ${main.text}.`);
  }
  render();
  postState();
  return main;
}

// ---------------------------------------------------------------- commands

async function switchAccount() {
  await refresh();
  const list = state.list;
  if (!list || !list.accounts.length) {
    vscode.window.showErrorMessage("Nenhuma conta Claude cadastrada. Adicione uma conta primeiro.");
    return;
  }
  const items = list.accounts.map((acc) => {
    const active = acc.number === list.activeAccountNumber;
    const alias = accountAlias(acc);
    const rec = accountRecord(acc.number);
    const found = getUsage(acc);
    let detail = "";
    if (found) {
      const f = found.usage.fiveHour ? `${Math.round(found.usage.fiveHour.pct)}%` : "—";
      const s = found.usage.sevenDay ? `${Math.round(found.usage.sevenDay.pct)}%` : "—";
      detail = `5h ${f} · semanal ${s}`;
      for (const sc of found.usage.scoped || []) detail += ` · ${sc.name} ${Math.round(sc.pct)}%`;
      if (found.usage.sevenDay && found.usage.sevenDay.resetsAt) detail += ` · semanal renova ${fmtWhen(found.usage.sevenDay.resetsAt)}`;
      if (found.stale) detail += ` · último conhecido`;
    } else {
      detail = statusLabel(acc.usageStatus);
    }
    if (rec.disabled) detail += " · fora da rotação automática";
    return {
      label: `${active ? "$(check) " : ""}Conta ${acc.number}${alias ? ` (${alias})` : ""}`,
      description: acc.email,
      detail,
      accountNum: acc.number,
    };
  });
  const sep = (label) => ({ label, kind: vscode.QuickPickItemKind.Separator });
  const autoOn = autoEnabled();
  const menu = [
    { label: "$(gear) Configurações...", description: "regras de aviso e de troca automática", accountNum: -2 },
    { label: `$(sync) Troca automática: ${autoOn ? "ligada" : "desligada"}`, description: autoOn ? "clique para desligar" : "clique para ligar", accountNum: -3 },
    sep("Contas"),
    ...items,
    sep(""),
    { label: "$(add) Adicionar conta...", description: "logar uma nova conta Claude Code", accountNum: -1 },
  ];

  const picked = await vscode.window.showQuickPick(menu, { placeHolder: "Escolha a conta Claude ou abra as configurações", matchOnDescription: true });
  if (!picked) return;
  if (picked.accountNum === -1) return addAccount();
  if (picked.accountNum === -2) return openSettings();
  if (picked.accountNum === -3) return toggleAuto();
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

function addAccount() {
  const term = vscode.window.createTerminal("Swap Plus");
  term.show();
  term.sendText(`"${cswapPath()}" add`);
}

async function toggleAuto() {
  const next = !autoEnabled();
  await cfg().update("autoSwitch.enabled", next, vscode.ConfigurationTarget.Global);
  vscode.window.showInformationMessage(`Swap Plus: troca automática ${next ? "ligada" : "desligada"}.`);
}

// ---------------------------------------------------------------- settings panel

function winPayload(w) {
  const ts = w.resetsAt ? new Date(w.resetsAt).getTime() : NaN;
  return { pct: w.pct, in: resetIn(w.resetsAt), when: w.resetsAt ? fmtWhen(w.resetsAt) : null, resetTs: isNaN(ts) ? null : ts };
}

function buildPayload() {
  const list = state.list;
  const accounts = list
    ? list.accounts.map((acc) => {
        const found = getUsage(acc);
        const rec = accountRecord(acc.number);
        return {
          number: acc.number,
          email: acc.email,
          alias: accountAlias(acc),
          org: acc.organizationName || "",
          plan: (acc.plan && acc.plan.label) || "",
          active: acc.number === list.activeAccountNumber,
          status: acc.usageStatus,
          statusLabel: statusLabel(acc.usageStatus),
          stale: found ? found.stale : false,
          fiveHour: found && found.usage.fiveHour ? winPayload(found.usage.fiveHour) : null,
          sevenDay: found && found.usage.sevenDay ? winPayload(found.usage.sevenDay) : null,
          scoped: found ? (found.usage.scoped || []).map((s) => ({ name: s.name, ...winPayload(s) })) : [],
          disabled: !!rec.disabled,
          threshold: rec.threshold,
          priority: rec.priority || 0,
        };
      })
    : [];
  const modelNames = [...new Set(accounts.flatMap((a) => a.scoped.map((s) => s.name)))];
  const rules = {};
  for (const k of RULE_KEYS) rules[k] = state.config[k] ? state.config[k].value : null;
  return {
    type: "state",
    error: state.error,
    fetchedAt: state.fetchedAt,
    accounts,
    modelNames,
    rules,
    alerts: alertSettings(),
    auto: {
      enabled: autoEnabled(),
      last: extContext.globalState.get(LAST_TICK_KEY) || null,
      lastWhen: (() => {
        const l = extContext.globalState.get(LAST_TICK_KEY);
        return l && l.ts ? fmtWhen(l.ts) : null;
      })(),
      history: (extContext.globalState.get(HISTORY_KEY) || []).map((h) => ({ ...h, when: fmtWhen(h.ts) })),
    },
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
  panel = vscode.window.createWebviewPanel("swapPlus.settings", "Swap Plus", vscode.ViewColumn.One, {
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

function sameValue(a, b) {
  if (a === null || a === undefined || a === "") return b === null || b === undefined || b === "";
  if (b === null || b === undefined || b === "") return false;
  if (typeof a === "number" || typeof b === "number") return Number(a) === Number(b);
  return String(a) === String(b);
}

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
      post({ type: "busy", on: true, text: "Salvando regras..." });
      const errors = [];
      for (const key of RULE_KEYS) {
        if (!(key in m.values)) continue;
        const next = m.values[key];
        const cur = state.config[key] ? state.config[key].value : null;
        if (sameValue(next, cur)) continue;
        const args = next === null || next === undefined || next === "" ? ["config", "unset", key] : ["config", "set", key, String(next)];
        const r = await runCswap(args);
        if (r.code !== 0) errors.push(`${key}: ${lastLine(r.stderr) || lastLine(r.stdout) || r.spawnError || "erro"}`);
      }
      if (m.alerts && typeof m.alerts === "object") {
        const cur = alertSettings();
        for (const k of Object.keys(cur)) {
          if (!(k in m.alerts) || m.alerts[k] === cur[k]) continue;
          const v = typeof cur[k] === "boolean" ? !!m.alerts[k] : Math.max(1, Math.min(100, Number(m.alerts[k]) || cur[k]));
          await cfg().update(`alerts.${k}`, v, vscode.ConfigurationTarget.Global);
        }
      }
      await refresh();
      setupAuto();
      post({ type: "busy", on: false });
      post(errors.length ? { type: "toast", kind: "error", text: errors.join(" | ") } : { type: "toast", kind: "info", text: "Regras salvas." });
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

    case "add":
      addAccount();
      return;

    case "ui": {
      const allowed = ["statusBar.showAccountNumber", "statusBar.showModelWeekly", "pollIntervalMinutes"];
      if (!allowed.includes(m.key)) return;
      await cfg().update(m.key, m.value, vscode.ConfigurationTarget.Global);
      return;
    }

    case "clearHistory":
      await extContext.globalState.update(HISTORY_KEY, []);
      postState();
      return;
  }
}

// ---------------------------------------------------------------- lifecycle

function activate(context) {
  extContext = context;

  mailItem = vscode.window.createStatusBarItem(`${NS}.mail`, vscode.StatusBarAlignment.Left, 101);
  mailItem.name = "Swap Plus — conta";
  mailItem.command = `${NS}.switchAccount`;
  usageItem = vscode.window.createStatusBarItem(`${NS}.usage`, vscode.StatusBarAlignment.Left, 100);
  usageItem.name = "Swap Plus — uso";
  usageItem.command = `${NS}.switchAccount`;
  context.subscriptions.push(mailItem, usageItem);

  context.subscriptions.push(
    vscode.commands.registerCommand(`${NS}.switchAccount`, switchAccount),
    vscode.commands.registerCommand(`${NS}.openSettings`, openSettings),
    vscode.commands.registerCommand(`${NS}.toggleAuto`, toggleAuto),
    vscode.commands.registerCommand(`${NS}.addAccount`, addAccount),
    vscode.commands.registerCommand(`${NS}.refreshStatus`, refresh),
    vscode.commands.registerCommand(`${NS}.switchBest`, switchBest)
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(NS)) return;
      if (e.affectsConfiguration(`${NS}.pollIntervalMinutes`) || e.affectsConfiguration(`${NS}.executablePath`)) setupPolling();
      if (e.affectsConfiguration(`${NS}.autoSwitch.enabled`)) setupAuto();
      render();
      postState();
    })
  );

  setupPolling();
  // Espera o primeiro refresh para saber o intervalo do cswap.
  refresh().then(() => setupAuto());
}

function deactivate() {
  autoGen++;
  if (pollTimer) clearInterval(pollTimer);
  if (autoTimer) clearTimeout(autoTimer);
}

module.exports = { activate, deactivate };
