"use strict";
// Regras de troca do Swap Plus — sem dependência do VS Code.
// Usado pela extensão (modo local) e pelo servidor (modo servidor), para as
// duas decidirem exatamente do mesmo jeito.

const STALE_USAGE_SEC = 20 * 60; // conta em uso: dados mais velhos que isso não decidem troca

const CAND_STALE_SEC = 60 * 60; // contas de destino: o semanal delas muda devagar, vale até 1 h

const STRATEGY_LABELS = {
  headroom: "Mais folga",
  max: "Aproveitar ao máximo",
  priority: "Por prioridade",
};

// Login guardado que não serve mais: trocar para essa conta derruba o Claude Code
// na tela de login (o refresh token dela foi usado em outro lugar ou revogado).
const DEAD_LOGIN = new Set(["relogin_required", "no_credentials", "foreign_credential"]);

function loginDead(acc) {
  return !!acc && DEAD_LOGIN.has(acc.usageStatus);
}

const fmtPct = (v) => `${Math.round(Number(v) || 0)}%`;

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

/** Linha própria gravada na conta (número) ou null = vale a regra geral. */
function ownLine(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

/**
 * Linhas de troca de uma conta: sessão, semanal e por modelo. Cada uma pode ter valor próprio na conta
 * (records[n].threshold / weeklyThreshold / modelThreshold); null = a regra geral.
 */
function linesFor(acc, r, records) {
  const rec = recordOf(records, acc.number);
  const session = ownLine(rec.threshold);
  const weekly = ownLine(rec.weeklyThreshold);
  const model = ownLine(rec.modelThreshold);
  return {
    session: session !== null ? session : r.sessionPct,
    weekly: weekly !== null ? weekly : r.weeklyPct,
    model: model !== null ? model : r.modelPct,
  };
}

function scopedNames(list) {
  const names = new Set();
  for (const a of (list && list.accounts) || []) {
    const w = windows(a);
    if (w) w.models.forEach((m) => names.add(m.name));
  }
  return [...names];
}

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

/**
 * Decide se troca de conta e para qual. Função pura (testável).
 *   - Gatilho: a conta ativa chegou na linha da sessão, do semanal ou, na regra
 *     "trocar de conta para continuar no modelo", do limite do modelo (vale mesmo
 *     com a conversa em outro modelo: a ideia é voltar para ele).
 *   - Destino: conta na rotação, com dados de uso recentes e abaixo de todas
 *     as linhas que importam (com a folga mínima). Contas com o modelo
 *     preferido (Fable) disponível vêm primeiro; depois vale a estratégia.
 *   - "Aproveitar ao máximo" também troca antes da linha, para uma conta cuja
 *     cota semanal zera logo e ainda está sobrando.
 *   - Modelo preferido (Fable): troca voluntária (antecipar, "melhor conta") nunca
 *     sai de uma conta que ainda tem o modelo para uma que não tem. Só a troca
 *     obrigatória (conta na linha ou limite estourado) pode, se não houver outra.
 */
function decide({ list, records, r, modelIds, now, lastSwitchAt, force = false, limitHit = null }) {
  const active = list.accounts.find((a) => a.number === list.activeAccountNumber);
  if (!active) return { action: "none", kind: "idle", text: "nenhuma conta ativa" };
  const names = scopedNames(list);
  // "Mesma conta": o limite do modelo não troca de conta (a extensão passa o modelo para o Opus 5.5).
  // "Trocar de conta": os limites por modelo (Fable) contam sempre, mesmo com a conversa já no Opus.
  const watch = r.onModelLimit === "switchAccount" ? names : [];
  const isModelRow = (x) => watch.some((n) => String(x.label).includes(n));
  const pref = r.preferModel && names.includes(r.preferModel) ? r.preferModel : null;

  const aw = windows(active);
  // limitHit: o Claude Code acabou de registrar "You've hit your limit" — vale mais que o dado de uso.
  if (!limitHit && (!aw || aw.stale)) return { action: "none", kind: "idle", text: "uso da conta ativa desatualizado; sem decisão por enquanto" };

  const rowsOf = (w, l) => {
    const rows = [{ label: "sessão", pct: w.session.pct, line: l.session }];
    if (w.weekly) rows.push({ label: "semanal", pct: w.weekly.pct, line: l.weekly });
    for (const name of watch) {
      const s = w.models.find((m) => m.name === name);
      if (s) rows.push({ label: name, pct: s.pct, line: l.model });
    }
    return rows;
  };

  const activeLines = aw ? linesFor(active, r, records) : null;
  const activeRows = aw ? rowsOf(aw, activeLines) : [];
  // O modelo preferido ainda tem folga na conta em uso? Então troca voluntária só para conta que também tem.
  const activePref = pref && aw ? aw.models.find((m) => m.name === pref) : null;
  const activePrefOk = !!activePref && activePref.pct < activeLines.model;
  const over = limitHit ? [{ label: limitHit, pct: 100, line: 100, hit: true }] : activeRows.filter((x) => x.pct >= x.line);
  const activeReset = aw && aw.weekly && aw.weekly.resetsAt ? Date.parse(aw.weekly.resetsAt) : Infinity;
  const activeHeadroom = activeRows.length ? Math.min(...activeRows.map((x) => x.line - x.pct)) : -Infinity;

  const cands = [];
  for (const acc of list.accounts) {
    if (acc.number === active.number) continue;
    if (recordOf(records, acc.number).disabled) continue;
    // Nunca trocar para conta com login morto: o Claude Code cairia na tela de login.
    if (loginDead(acc)) continue;
    const w = windows(acc);
    const tooOld = !w || !(typeof w.ageSeconds === "number") || w.ageSeconds > CAND_STALE_SEC;
    if (!w || (tooOld && !limitHit)) continue;
    const l = linesFor(acc, r, records);
    const rows = rowsOf(w, l);
    const base = rows.filter((x) => !isModelRow(x)); // só sessão e semanal
    let prefOk = true;
    if (pref) {
      const s = w.models.find((m) => m.name === pref);
      prefOk = !!s && s.pct <= l.model - r.marginPct;
    }
    cands.push({
      acc,
      strictOk: rows.every((x) => x.pct <= x.line - r.marginPct),
      looseOk: rows.every((x) => x.pct < x.line),
      strictBase: base.every((x) => x.pct <= x.line - r.marginPct),
      looseBase: base.every((x) => x.pct < x.line),
      headroom: Math.min(...rows.map((x) => x.line - x.pct)),
      prefOk,
      resetTs: w.weekly && w.weekly.resetsAt ? Date.parse(w.weekly.resetsAt) : Infinity,
      unused: w.weekly ? 100 - w.weekly.pct : 100,
      priority: Number(recordOf(records, acc.number).priority) || 0,
      stale: tooOld,
    });
  }

  const byStrategy = {
    headroom: (x, y) => y.headroom - x.headroom,
    max: (x, y) => x.resetTs - y.resetTs || y.headroom - x.headroom,
    priority: (x, y) => y.priority - x.priority || x.resetTs - y.resetTs || y.headroom - x.headroom,
  };
  const rank = (arr) =>
    [...arr].sort((x, y) => Number(y.prefOk) - Number(x.prefOk) || byStrategy[r.strategy](x, y) || x.acc.number - y.acc.number);
  // baseOnly: ignora os limites por modelo (só sessão e semanal) — para a troca obrigatória quando
  // nenhuma conta tem o modelo: sair da sessão/semanal estourada vem antes de continuar no modelo.
  const pick = (baseOnly = false) => {
    const strictKey = baseOnly ? "strictBase" : "strictOk";
    const looseKey = baseOnly ? "looseBase" : "looseOk";
    // Dados recentes primeiro; com o limite estourado, vale também conta com dado antigo.
    for (const pool of [cands.filter((c) => !c.stale), cands.filter((c) => c.stale)]) {
      const strict = rank(pool.filter((c) => c[strictKey]));
      if (strict.length) return strict[0];
      const loose = rank(pool.filter((c) => c[looseKey]))[0];
      if (loose) return loose;
    }
    return undefined;
  };
  const go = (t, reason) => ({ action: "switch", kind: "switch", from: active.number, to: t.acc.number, reason, text: `da conta ${active.number} para a conta ${t.acc.number}: ${reason}` });

  if (over.length) {
    const reason = limitHit ? `a conta ${active.number} bateu o ${limitHit}` : over.map((o) => `${o.label} em ${fmtPct(o.pct)} (linha ${fmtPct(o.line)})`).join(", ");
    let t = pick();
    // Sessão ou semanal estourados e nenhuma conta com o modelo: troca mesmo assim (sem o modelo).
    if (!t && over.some((o) => !isModelRow(o))) t = pick(true);
    if (!t) return { action: "none", kind: "blocked", text: limitHit ? `${reason}, mas nenhuma outra conta tem folga` : `conta ${active.number} com ${reason}, mas nenhuma outra conta tem folga` };
    return { ...go(t, reason), atLimit: !!limitHit || over.some((o) => o.pct >= 100) };
  }

  if (force) {
    const t = pick();
    if (t && activePrefOk && !t.prefOk) return { action: "none", kind: "idle", text: `a conta atual é a melhor: ainda tem ${pref} (as outras com folga não têm)` };
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
          c.unused >= 20 &&
          (!activePrefOk || c.prefOk) // não troca uma conta com o modelo preferido por uma sem ele
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

const RULE_DEFAULTS = {
  sessionPct: 90,
  weeklyPct: 80,
  modelPct: 95,
  preferModel: "Fable",
  strategy: "max",
  expiringHours: 24,
  cooldownMin: 5,
  marginPct: 5,
  intervalSec: 60,
  onModelLimit: "sameAccount",
  // Só no modo servidor (engine.js): "separate" = cada computador numa conta; "together" = todos na mesma conta
  // e trocam juntos. decide() não usa.
  devicePlacement: "separate",
};

module.exports = {
  STALE_USAGE_SEC,
  CAND_STALE_SEC,
  STRATEGY_LABELS,
  DEAD_LOGIN,
  RULE_DEFAULTS,
  loginDead,
  fmtPct,
  roundedDate,
  dayPrefix,
  fmtWhen,
  getUsage,
  windows,
  recordOf,
  linesFor,
  scopedNames,
  modelLabel,
  watchedModels,
  decide,
};
