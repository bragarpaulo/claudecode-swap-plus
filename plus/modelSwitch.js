"use strict";
// Modelo padrão do Claude Code quando o Fable acaba — sem dependência do VS Code.
//
// O que dá para fazer de fora do Claude Code (conferido no 2.1.325, no código e com um teste real):
//   - conversa NOVA: lê o modelo padrão (`model` do settings.json) quando começa;
//   - conversa ABERTA: só muda de modelo por dentro dela (seletor de modelo ou /model). Mudar o
//     settings.json não muda a conversa aberta, e o "modelo reserva" (fallbackModel) não vale para
//     limite de uso (erro 429): ela para com "You've hit your Fable limit … Switch to another model".
//
// Por isso o Swap Plus cuida do modelo PADRÃO deste computador:
//   - o Fable da conta em uso acabou (erro visto na conversa) ou chegou na linha → padrão = Opus 5.5;
//   - o Fable voltou (renovou, ou o computador foi para uma conta com Fable) → padrão = o de antes.
// Só mexe quando o padrão é o Fable (ou o do plano) e só desfaz o que ele mesmo fez: um marcador
// guarda o valor de antes. Padrão escolhido à mão depois da troca fica como a pessoa deixou.

const fs = require("fs");
const path = require("path");
const { windows, linesFor, modelLabel } = require("./rules");

const OPUS_ID = "claude-opus-5-5";
const FABLE_ID = "claude-fable-5-2";
const FALLBACK_MODEL = "opus"; // apelido do Claude Code para o Opus mais novo (hoje o 5.5)
const FALLBACK_LABEL = "Opus 5.5";
const FABLE_RE = /fable/i;
const HOLD_MS = 30 * 60 * 1000; // limite visto na conversa, sem hora de renovação: não volta ao Fable antes disso
const CYCLE_MS = 7 * 24 * 3600 * 1000; // sem hora de renovação: o marcador vale por uma semana

// ---------------------------------------------------------------- settings.json do Claude Code

/** Lê o settings.json do Claude Code. { data, error } — data = {} se o arquivo não existe. */
function readSettings(file) {
  try {
    const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
    const data = text.trim() ? JSON.parse(text) : {};
    if (!data || typeof data !== "object" || Array.isArray(data)) return { error: "o arquivo não tem o formato esperado" };
    return { data };
  } catch (e) {
    if (e.code === "ENOENT") return { data: {} };
    return { error: e.message };
  }
}

/** Grava o settings.json inteiro (temporário ao lado + rename). Lança se não der. */
function writeSettings(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.swap-plus-${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

const isOpus = (m) => typeof m === "string" && /^(opus|claude-opus)/i.test(m.trim());

/** Sem `model` escolhido (ou "default"/"best"): vale o modelo do plano, que pode ser o Fable ou não. */
function isPlanDefault(m) {
  if (m === undefined || m === null) return true;
  if (typeof m !== "string") return false;
  const t = m.trim().toLowerCase();
  return t === "" || t === "default" || t === "best";
}

/** O padrão é o Fable (escolhido) ou o do plano (que pode ser o Fable)? */
function isFableDefault(m) {
  return isPlanDefault(m) || (typeof m === "string" && /^(claude-)?fable/.test(m.trim().toLowerCase()));
}

/** Nome para mostrar do valor de `model`. */
function defaultLabel(m) {
  if (m === undefined || m === null || (typeof m === "string" && !m.trim())) return "o do plano";
  const t = String(m).trim();
  if (/^opus(\[|$)/i.test(t)) return FALLBACK_LABEL;
  return modelLabel(t);
}

// ---------------------------------------------------------------- marcador (o que o Swap Plus trocou)
//
// { v, state: "fallback", from, to, account, reason, at, holdUntil, cycleEnd }
//     from: valor de `model` antes da troca (null = a chave não existia)
//     holdUntil: limite visto na conversa — não volta ao Fable antes disso, nesta conta
//     cycleEnd: quando o Fable dessa conta renova (ms), se o servidor informou
// { v, state: "user", from, account, at, cycleEnd }
//     a pessoa tirou o padrão do Opus à mão depois da troca: não troca de novo pelo uso até o Fable
//     renovar ou a conta mudar (um erro de limite na conversa ainda troca). `from` fica guardado: se
//     ela voltar ao Opus, o marcador volta a ser "fallback" e o Swap Plus desfaz quando o Fable voltar.

function readMarker(file) {
  try {
    const m = JSON.parse(fs.readFileSync(file, "utf8"));
    return m && typeof m === "object" && (m.state === "fallback" || m.state === "user") ? m : null;
  } catch {
    return null;
  }
}

function writeMarker(file, m) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(m), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function clearMarker(file) {
  try {
    fs.unlinkSync(file);
  } catch {}
}

/** O marcador ainda fala desta conta e deste ciclo do Fable? */
function markerCurrent(marker, account, now) {
  if (!marker || marker.account !== account) return false;
  return marker.cycleEnd ? now < marker.cycleEnd : now - (Number(marker.at) || 0) < CYCLE_MS;
}

// ---------------------------------------------------------------- erro de limite: é de um modelo?

/** "Server is temporarily limiting requests (not your usage limit)": passageiro, não é limite da conta. */
const TRANSIENT_LIMIT_RE = /not your usage limit|temporarily limiting requests/i;

const TYPE_MODEL = { seven_day_overage_included: "Fable", seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };
const TYPE_ACCOUNT = new Set(["five_hour", "seven_day", "overage"]);

/**
 * Modelo cujo limite acabou, num erro de limite do Claude Code ("You've hit your Fable limit · resets …").
 * rateLimitType: campo que o Claude Code grava junto do erro (quando grava). → "Fable" | "Opus" | "Sonnet" | null
 */
function limitModel(text, rateLimitType) {
  const t = String(text || "");
  if (TRANSIENT_LIMIT_RE.test(t)) return null;
  if (TYPE_MODEL[rateLimitType]) return TYPE_MODEL[rateLimitType];
  if (TYPE_ACCOUNT.has(rateLimitType)) return null;
  if (/5-hour|five.?hour|session/i.test(t)) return null;
  const m = /\b(fable|opus|sonnet)\b/i.exec(t);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

// ---------------------------------------------------------------- decisão (função pura)

/** Linha do Fable para esta troca: a "linha do modelo" na regra "mesma conta"; 100% se a regra é trocar de conta. */
function fallbackLine(acc, r, records) {
  return r.onModelLimit === "switchAccount" ? 100 : linesFor(acc, r, records).model;
}

/**
 * O que fazer com o modelo padrão, pelo uso da conta em uso.
 *   want: "fallback" (passar para o Opus 5.5) | "preferred" (voltar ao de antes) | null (nada)
 *   forget: o marcador "escolhido à mão" não vale mais (conta ou ciclo mudou): apagar
 */
function plan({ list, records, r, marker, now }) {
  const none = (why, extra) => ({ want: null, why, ...extra });
  const accounts = list && Array.isArray(list.accounts) ? list.accounts : [];
  const active = accounts.find((a) => a.number === list.activeAccountNumber);
  if (!active) return none("nenhuma conta em uso");
  const w = windows(active);
  if (!w || w.stale) return none("uso da conta em uso desatualizado");
  const fable = w.models.find((m) => FABLE_RE.test(m.name));
  if (!fable) return none("a conta em uso não informa o limite do Fable");
  const line = fallbackLine(active, r, records);
  const cycleEnd = Date.parse(fable.resetsAt || "") || null;
  const base = { account: active.number, name: fable.name, pct: fable.pct, line, resetsAt: fable.resetsAt || null, cycleEnd };
  const current = markerCurrent(marker, active.number, now);
  let forget = false;
  if (marker && marker.state === "user") {
    if (current) return none("modelo padrão escolhido à mão depois da troca: fica assim até o Fable renovar", base);
    forget = true;
    marker = null;
  }
  if (fable.pct >= line) return { want: "fallback", reason: "line", forget, ...base };
  if (!marker) return none("Fable abaixo da linha", { forget, ...base });
  // Voltar ao Fable: com folga (a mesma margem das trocas de conta) e nunca enquanto vale um limite
  // visto na conversa para esta mesma conta (o dado de uso pode estar atrasado).
  if (current && marker.holdUntil && now < marker.holdUntil) return none("limite do Fable visto na conversa: espera a renovação", base);
  const margin = Math.max(0, Number(r.marginPct) || 0);
  if (fable.pct <= line - margin) return { want: "preferred", ...base };
  return none("Fable perto da linha: espera a folga", base);
}

// ---------------------------------------------------------------- trocar e desfazer

/**
 * Passa o modelo padrão para o Opus 5.5, se hoje o padrão é o Fable.
 * meta: { account, reason: "limit" | "line", now, holdUntil, cycleEnd, fableInUse }
 *   fableInUse: o Fable é o modelo em uso neste computador (erro de limite dele, ou usado há pouco).
 *     Sem `model` escolhido vale o modelo do plano, que só é tratado como Fable com essa confirmação.
 * → { ok, changed, state: "switched" | "already" | "other" | "plan", from, model, effort, error }
 *   already = o padrão já é o Opus; other = a pessoa usa outro modelo de padrão (não mexe);
 *   plan = padrão do plano e nada indica que seja o Fable (não mexe).
 */
function toFallback(file, markerFile, meta = {}) {
  const r = readSettings(file);
  if (r.error) return { ok: false, error: `não consegui ler ${file}: ${r.error}` };
  const d = r.data;
  const cur = d.model;
  const now = meta.now || Date.now();
  const marker = readMarker(markerFile);
  const account = meta.account === undefined ? null : meta.account;
  const hold = Number(meta.holdUntil) || 0;
  if (isOpus(cur)) {
    // Já no Opus. Se foi o Swap Plus que pôs, guarda o limite visto agora (segura a volta ao Fable).
    if (marker && marker.state === "fallback" && hold) {
      try {
        writeMarker(markerFile, {
          ...marker,
          account: account === null ? marker.account : account,
          holdUntil: Math.max(Number(marker.holdUntil) || 0, hold),
          cycleEnd: meta.cycleEnd || marker.cycleEnd || null,
        });
      } catch {}
    }
    return { ok: true, changed: false, state: "already", model: cur };
  }
  if (!isFableDefault(cur)) return { ok: true, changed: false, state: "other", model: cur };
  if (isPlanDefault(cur) && !meta.fableInUse) return { ok: true, changed: false, state: "plan", model: cur };

  d.model = FALLBACK_MODEL;
  // Opus no mesmo esforço do Fable, só se o Opus ainda não tem um esforço próprio.
  const ms = d.modelSettings && typeof d.modelSettings === "object" && !Array.isArray(d.modelSettings) ? d.modelSettings : null;
  const fableEffort = (ms && ms[FABLE_ID] && ms[FABLE_ID].effortLevel) || null;
  let effort = null;
  if (fableEffort && !(ms[OPUS_ID] && ms[OPUS_ID].effortLevel) && fableEffort !== d.effortLevel) {
    ms[OPUS_ID] = { ...(ms[OPUS_ID] || {}), effortLevel: fableEffort };
    effort = fableEffort;
  }
  // Marcador antes do arquivo: se parar no meio, o pior caso é não trocar (nunca ficar no Opus sem saber desfazer).
  try {
    writeMarker(markerFile, {
      v: 1,
      state: "fallback",
      from: cur === undefined ? null : cur,
      to: FALLBACK_MODEL,
      account,
      reason: meta.reason || "line",
      at: now,
      holdUntil: hold || null,
      cycleEnd: meta.cycleEnd || null,
    });
  } catch (e) {
    return { ok: false, error: `não consegui anotar a troca: ${e.message}` };
  }
  try {
    writeSettings(file, d);
  } catch (e) {
    if (marker) {
      try {
        writeMarker(markerFile, marker);
      } catch {}
    } else clearMarker(markerFile);
    return { ok: false, error: `não consegui gravar ${file}: ${e.message}` };
  }
  return { ok: true, changed: true, state: "switched", from: cur === undefined ? null : cur, model: FALLBACK_MODEL, effort };
}

/**
 * Desfaz a troca do Swap Plus: o modelo padrão volta ao valor de antes.
 * → { ok, changed, state: "restored" | "none" | "user", model, error }
 *   user = a pessoa mudou o padrão depois (não é mais um Opus): fica como ela deixou.
 */
function toPreferred(file, markerFile) {
  const marker = readMarker(markerFile);
  if (!marker || marker.state !== "fallback") {
    if (marker) clearMarker(markerFile);
    return { ok: true, changed: false, state: "none" };
  }
  const r = readSettings(file);
  if (r.error) return { ok: false, error: `não consegui ler ${file}: ${r.error}` };
  const d = r.data;
  if (!isOpus(d.model)) {
    clearMarker(markerFile);
    return { ok: true, changed: false, state: "user", model: d.model };
  }
  const from = marker.from === undefined ? null : marker.from;
  if (from === null) delete d.model;
  else d.model = from;
  try {
    writeSettings(file, d);
  } catch (e) {
    return { ok: false, error: `não consegui gravar ${file}: ${e.message}` };
  }
  clearMarker(markerFile);
  return { ok: true, changed: true, state: "restored", model: from };
}

/**
 * A pessoa tirou o padrão do Opus depois da troca do Swap Plus? Então vale a escolha dela:
 * o marcador vira "user" (não troca de novo pelo uso até o Fable renovar ou a conta mudar).
 * Se ela voltar ao Opus, o marcador volta a ser "fallback" (o Swap Plus desfaz quando o Fable voltar).
 * → o marcador que vale agora (ou null)
 */
function noteUserChoice(file, markerFile, now = Date.now()) {
  const marker = readMarker(markerFile);
  if (!marker) return null;
  const r = readSettings(file);
  if (r.error) return marker;
  const opus = isOpus(r.data.model);
  const account = marker.account === undefined ? null : marker.account;
  const from = marker.from === undefined ? null : marker.from;
  let m;
  if (marker.state === "fallback" && !opus) m = { v: 1, state: "user", from, account, at: now, cycleEnd: marker.cycleEnd || null };
  else if (marker.state === "user" && opus) m = { v: 1, state: "fallback", from, to: FALLBACK_MODEL, account, reason: "line", at: now, holdUntil: null, cycleEnd: marker.cycleEnd || null };
  else return marker;
  try {
    writeMarker(markerFile, m);
  } catch {
    return marker;
  }
  return m;
}

module.exports = {
  OPUS_ID,
  FABLE_ID,
  FALLBACK_MODEL,
  FALLBACK_LABEL,
  HOLD_MS,
  TRANSIENT_LIMIT_RE,
  readSettings,
  writeSettings,
  isOpus,
  isPlanDefault,
  isFableDefault,
  defaultLabel,
  readMarker,
  writeMarker,
  clearMarker,
  markerCurrent,
  limitModel,
  fallbackLine,
  plan,
  toFallback,
  toPreferred,
  noteUserChoice,
};
