"use strict";
// Modelo padrão do Claude Code quando o modelo preferido acaba — sem dependência do VS Code.
//
// O que dá para fazer de fora do Claude Code (conferido no 2.1.325 e de novo no 2.1.330, no código e com testes):
//   - conversa NOVA: lê o modelo padrão (`model` do settings.json) quando começa;
//   - conversa ABERTA: só muda de modelo por dentro dela (seletor de modelo ou /model). Mudar o
//     settings.json não muda a conversa aberta, e o "modelo reserva" (fallbackModel) não vale para
//     limite de uso (erro 429): ela para com "You've hit your Fable limit … Switch to another model".
//
// Por isso o Swap Plus cuida do modelo PADRÃO deste computador:
//   - o modelo preferido acabou na conta em uso (erro visto na conversa) ou chegou na linha → padrão = o secundário;
//   - o preferido voltou (renovou, ou o computador foi para uma conta que tem) → padrão = o de antes.
// Só mexe quando o padrão é o preferido (ou o do plano) e só desfaz o que ele mesmo fez: um marcador
// guarda o valor de antes. Padrão escolhido à mão depois da troca fica como a pessoa deixou.
//
// Quais são os dois modelos (3.4.0): vêm das regras do servidor (painel → Regras de troca): `primaryModel` e
// `secondaryModel` (IDs da Anthropic), com o esforço de cada um (`primaryEffort`, `secondaryEffort`; "" = não mexe).
// O par é montado por pairOf(), a partir das regras COMO O SERVIDOR MANDOU. Servidor antigo (sem essas chaves) =
// o par de sempre: Fable → Opus 5.5 (o apelido "opus"), e nenhum esforço imposto.

const fs = require("fs");
const path = require("path");
const { windows, linesFor, modelLabel, modelLine, limitNameOf, MODEL_EFFORTS, MODEL_ID_RE } = require("./rules");

const OPUS_ID = "claude-opus-5-5";
const FABLE_ID = "claude-fable-5-2";
const FALLBACK_MODEL = "opus"; // apelido do Claude Code para o Opus mais novo (hoje o 5.5)
const FALLBACK_LABEL = "Opus 5.5";
const FABLE_RE = /fable/i;
const HOLD_MS = 30 * 60 * 1000; // limite visto na conversa, sem hora de renovação: não volta ao preferido antes disso
const CYCLE_MS = 7 * 24 * 3600 * 1000; // sem hora de renovação: o marcador vale por uma semana

const isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);

// ---------------------------------------------------------------- o par de modelos (preferido e secundário)

/** O par de sempre, para servidor que não manda os modelos: Fable → "opus" (o Opus mais novo), sem esforço imposto. */
const DEFAULT_PAIR = Object.freeze({
  explicit: false, // true = veio do servidor (regras primaryModel/secondaryModel)
  primaryId: FABLE_ID,
  primaryLine: "fable", // a família: é por ela que se acha o limite do modelo no uso da conta e o modelo em uso
  primaryName: "Fable", // como os avisos chamam o modelo (e como o limite dele aparece no uso das contas)
  primaryEffort: "",
  secondaryId: OPUS_ID,
  secondaryLine: "opus",
  secondaryValue: FALLBACK_MODEL, // o que vai para `model` no settings.json
  secondaryLabel: FALLBACK_LABEL,
  secondaryEffort: "",
});

/**
 * O par de modelos a partir das regras que o servidor mandou (sem os padrões de RULE_DEFAULTS por cima: é a presença
 * das chaves que diz que o servidor é novo). ID inválido ou secundário igual ao preferido = fica o de sempre.
 */
function pairOf(rules) {
  const o = isObj(rules) ? rules : {};
  const idOf = (v) => {
    const t = typeof v === "string" ? v.trim().toLowerCase() : "";
    return MODEL_ID_RE.test(t) ? t : null;
  };
  const effortOf = (v) => (typeof v === "string" && MODEL_EFFORTS.includes(v) ? v : "");
  const pair = { ...DEFAULT_PAIR, primaryEffort: effortOf(o.primaryEffort), secondaryEffort: effortOf(o.secondaryEffort) };
  const p = idOf(o.primaryModel);
  if (p && modelLine(p)) {
    pair.primaryId = p;
    pair.primaryLine = modelLine(p);
    pair.primaryName = limitNameOf(p);
    pair.explicit = true;
  }
  const s = idOf(o.secondaryModel);
  if (s && modelLine(s) && s !== pair.primaryId) {
    pair.secondaryId = s;
    pair.secondaryLine = modelLine(s);
    pair.secondaryValue = s; // o ID escolhido no painel (não o apelido, que anda sozinho para a versão mais nova)
    pair.secondaryLabel = modelLabel(s);
    pair.explicit = true;
  }
  return pair;
}

/** Valor de `model` (apelido ou ID) da família `line`? ("opus", "opus[1m]", "claude-opus-5-5"…) */
function inLine(m, line) {
  if (typeof m !== "string" || !line) return false;
  const t = m.trim().toLowerCase();
  return t.startsWith(line) || t.startsWith(`claude-${line}`);
}

/** O nome (do limite no uso, do modelo em uso) é do modelo preferido? */
function isPrimaryName(name, pair = DEFAULT_PAIR) {
  return typeof name === "string" && name.toLowerCase().includes(pair.primaryLine);
}

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

/** O padrão é o modelo secundário do par (qualquer versão da família dele)? */
function isSecondary(m, pair = DEFAULT_PAIR) {
  return inLine(m, pair.secondaryLine);
}

/** Sem `model` escolhido (ou "default"/"best"): vale o modelo do plano, que pode ser o preferido ou não. */
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

/** O padrão é o modelo preferido do par (escolhido) ou o do plano (que pode ser ele)? */
function isPrimaryDefault(m, pair = DEFAULT_PAIR) {
  return isPlanDefault(m) || inLine(m, pair.primaryLine);
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
//     to: o que o Swap Plus pôs em `model` (o secundário daquela hora)
//     holdUntil: limite visto na conversa — não volta ao preferido antes disso, nesta conta
//     cycleEnd: quando o preferido dessa conta renova (ms), se o servidor informou
// { v, state: "user", from, account, at, cycleEnd }
//     a pessoa tirou o padrão do secundário à mão depois da troca: não troca de novo pelo uso até o preferido
//     renovar ou a conta mudar (um erro de limite na conversa ainda troca). `from` fica guardado: se
//     ela voltar ao secundário, o marcador volta a ser "fallback" e o Swap Plus desfaz quando o preferido voltar.

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

/** O marcador ainda fala desta conta e deste ciclo do modelo preferido? */
function markerCurrent(marker, account, now) {
  if (!marker || marker.account !== account) return false;
  return marker.cycleEnd ? now < marker.cycleEnd : now - (Number(marker.at) || 0) < CYCLE_MS;
}

/**
 * O padrão de agora ainda é o que o Swap Plus pôs? É o secundário do par — ou da família do que o marcador diz que
 * foi posto (o secundário pode ter sido trocado no painel depois da troca: o que está lá continua sendo "nosso").
 */
function stillOurs(model, marker, pair) {
  if (isSecondary(model, pair)) return true;
  const to = marker && typeof marker.to === "string" ? modelLine(marker.to) : null;
  return !!to && inLine(model, to);
}

// ---------------------------------------------------------------- erro de limite: é de um modelo?

/** "Server is temporarily limiting requests (not your usage limit)": passageiro, não é limite da conta. */
const TRANSIENT_LIMIT_RE = /not your usage limit|temporarily limiting requests/i;

const TYPE_MODEL = { seven_day_overage_included: "Fable", seven_day_opus: "Opus", seven_day_sonnet: "Sonnet" };
const TYPE_ACCOUNT = new Set(["five_hour", "seven_day", "overage"]);

/**
 * Modelo cujo limite acabou, num erro de limite do Claude Code ("You've hit your Fable limit · resets …").
 * rateLimitType: campo que o Claude Code grava junto do erro (quando grava). → "Fable" | "Opus" | "Sonnet" | "Haiku" | null
 */
function limitModel(text, rateLimitType) {
  const t = String(text || "");
  if (TRANSIENT_LIMIT_RE.test(t)) return null;
  if (TYPE_MODEL[rateLimitType]) return TYPE_MODEL[rateLimitType];
  if (TYPE_ACCOUNT.has(rateLimitType)) return null;
  if (/5-hour|five.?hour|session/i.test(t)) return null;
  const m = /\b(fable|opus|sonnet|haiku)\b/i.exec(t);
  return m ? m[1][0].toUpperCase() + m[1].slice(1).toLowerCase() : null;
}

// ---------------------------------------------------------------- decisão (função pura)

/** Linha do modelo preferido para esta troca: a "linha do modelo" na regra "mesma conta"; 100% se a regra é trocar de conta. */
function fallbackLine(acc, r, records) {
  return r.onModelLimit === "switchAccount" ? 100 : linesFor(acc, r, records).model;
}

/**
 * O que fazer com o modelo padrão, pelo uso da conta em uso.
 *   want: "fallback" (passar para o secundário) | "preferred" (voltar ao de antes) | null (nada)
 *   forget: o marcador "escolhido à mão" não vale mais (conta ou ciclo mudou): apagar
 *   pair: o par de modelos (pairOf); sem ele, o de sempre (Fable → Opus 5.5)
 */
function plan({ list, records, r, marker, now, pair = DEFAULT_PAIR }) {
  const none = (why, extra) => ({ want: null, why, ...extra });
  const P = pair.primaryName;
  const accounts = list && Array.isArray(list.accounts) ? list.accounts : [];
  const active = accounts.find((a) => a.number === list.activeAccountNumber);
  if (!active) return none("nenhuma conta em uso");
  const w = windows(active);
  if (!w || w.stale) return none("uso da conta em uso desatualizado");
  const fable = w.models.find((m) => isPrimaryName(m.name, pair));
  if (!fable) return none(`a conta em uso não informa o limite do ${P}`);
  const line = fallbackLine(active, r, records);
  const cycleEnd = Date.parse(fable.resetsAt || "") || null;
  const base = { account: active.number, name: fable.name, pct: fable.pct, line, resetsAt: fable.resetsAt || null, cycleEnd };
  const current = markerCurrent(marker, active.number, now);
  let forget = false;
  if (marker && marker.state === "user") {
    if (current) return none(`modelo padrão escolhido à mão depois da troca: fica assim até o ${P} renovar`, base);
    forget = true;
    marker = null;
  }
  if (fable.pct >= line) return { want: "fallback", reason: "line", forget, ...base };
  if (!marker) return none(`${P} abaixo da linha`, { forget, ...base });
  // Voltar ao preferido: com folga (a mesma margem das trocas de conta) e nunca enquanto vale um limite
  // visto na conversa para esta mesma conta (o dado de uso pode estar atrasado).
  if (current && marker.holdUntil && now < marker.holdUntil) return none(`limite do ${P} visto na conversa: espera a renovação`, base);
  const margin = Math.max(0, Number(r.marginPct) || 0);
  if (fable.pct <= line - margin) return { want: "preferred", ...base };
  return none(`${P} perto da linha: espera a folga`, base);
}

// ---------------------------------------------------------------- trocar e desfazer

/**
 * Passa o modelo padrão para o secundário, se hoje o padrão é o preferido.
 * meta: { account, reason: "limit" | "line", now, holdUntil, cycleEnd, fableInUse, pair }
 *   fableInUse: o preferido é o modelo em uso neste computador (erro de limite dele, ou usado há pouco).
 *     Sem `model` escolhido vale o modelo do plano, que só é tratado como o preferido com essa confirmação.
 *   pair: o par de modelos (pairOf); sem ele, o de sempre (Fable → Opus 5.5).
 * → { ok, changed, state: "switched" | "already" | "other" | "plan", from, model, effort, error }
 *   already = o padrão já é o secundário; other = a pessoa usa outro modelo de padrão (não mexe);
 *   plan = padrão do plano e nada indica que seja o preferido (não mexe).
 */
function toFallback(file, markerFile, meta = {}) {
  const pair = meta.pair || DEFAULT_PAIR;
  const r = readSettings(file);
  if (r.error) return { ok: false, error: `não consegui ler ${file}: ${r.error}` };
  const d = r.data;
  const cur = d.model;
  const now = meta.now || Date.now();
  const marker = readMarker(markerFile);
  const account = meta.account === undefined ? null : meta.account;
  const hold = Number(meta.holdUntil) || 0;
  if (isSecondary(cur, pair)) {
    // Já no secundário. Se foi o Swap Plus que pôs, guarda o limite visto agora (segura a volta ao preferido).
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
  if (!isPrimaryDefault(cur, pair)) return { ok: true, changed: false, state: "other", model: cur };
  if (isPlanDefault(cur) && !meta.fableInUse) return { ok: true, changed: false, state: "plan", model: cur };

  d.model = pair.secondaryValue;
  let ms = isObj(d.modelSettings) ? d.modelSettings : null;
  let effort = null;
  if (pair.secondaryEffort) {
    // O painel escolheu o esforço do secundário: é esse.
    if (!(ms && isObj(ms[pair.secondaryId]) && ms[pair.secondaryId].effortLevel === pair.secondaryEffort) && (ms || d.modelSettings === undefined)) {
      if (!ms) ms = d.modelSettings = {};
      ms[pair.secondaryId] = { ...(isObj(ms[pair.secondaryId]) ? ms[pair.secondaryId] : {}), effortLevel: pair.secondaryEffort };
      effort = pair.secondaryEffort;
    }
  } else {
    // Sem esforço escolhido: o secundário no mesmo esforço do preferido, só se ele ainda não tem um esforço próprio.
    const primaryEffort = (ms && ms[pair.primaryId] && ms[pair.primaryId].effortLevel) || null;
    if (primaryEffort && !(ms[pair.secondaryId] && ms[pair.secondaryId].effortLevel) && primaryEffort !== d.effortLevel) {
      ms[pair.secondaryId] = { ...(ms[pair.secondaryId] || {}), effortLevel: primaryEffort };
      effort = primaryEffort;
    }
  }
  // Marcador antes do arquivo: se parar no meio, o pior caso é não trocar (nunca ficar no secundário sem saber desfazer).
  try {
    writeMarker(markerFile, {
      v: 1,
      state: "fallback",
      from: cur === undefined ? null : cur,
      to: pair.secondaryValue,
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
  return { ok: true, changed: true, state: "switched", from: cur === undefined ? null : cur, model: pair.secondaryValue, effort };
}

/**
 * Desfaz a troca do Swap Plus: o modelo padrão volta ao valor de antes.
 * → { ok, changed, state: "restored" | "none" | "user", model, error }
 *   user = a pessoa mudou o padrão depois (não é mais o secundário): fica como ela deixou.
 */
function toPreferred(file, markerFile, pair = DEFAULT_PAIR) {
  const marker = readMarker(markerFile);
  if (!marker || marker.state !== "fallback") {
    if (marker) clearMarker(markerFile);
    return { ok: true, changed: false, state: "none" };
  }
  const r = readSettings(file);
  if (r.error) return { ok: false, error: `não consegui ler ${file}: ${r.error}` };
  const d = r.data;
  if (!stillOurs(d.model, marker, pair)) {
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
 * A pessoa tirou o padrão do secundário depois da troca do Swap Plus? Então vale a escolha dela:
 * o marcador vira "user" (não troca de novo pelo uso até o preferido renovar ou a conta mudar).
 * Se ela voltar ao secundário, o marcador volta a ser "fallback" (o Swap Plus desfaz quando o preferido voltar).
 * → o marcador que vale agora (ou null)
 */
function noteUserChoice(file, markerFile, now = Date.now(), pair = DEFAULT_PAIR) {
  const marker = readMarker(markerFile);
  if (!marker) return null;
  const r = readSettings(file);
  if (r.error) return marker;
  const ours = stillOurs(r.data.model, marker, pair);
  const account = marker.account === undefined ? null : marker.account;
  const from = marker.from === undefined ? null : marker.from;
  let m;
  if (marker.state === "fallback" && !ours) m = { v: 1, state: "user", from, account, at: now, cycleEnd: marker.cycleEnd || null };
  else if (marker.state === "user" && isSecondary(r.data.model, pair)) m = { v: 1, state: "fallback", from, to: pair.secondaryValue, account, reason: "line", at: now, holdUntil: null, cycleEnd: marker.cycleEnd || null };
  else return marker;
  try {
    writeMarker(markerFile, m);
  } catch {
    return marker;
  }
  return m;
}

// ---------------------------------------------------------------- esforço dos modelos (regras do painel)

/**
 * Deixa o esforço dos dois modelos do par como o painel pede: `modelSettings["<id>"].effortLevel` no settings.json
 * do Claude Code. Esforço "" na regra = não mexe naquele modelo. Só grava se algo mudou; o resto do arquivo
 * (inclusive os ganchos) fica como está. `modelSettings` num formato que não é o esperado: não mexe.
 * → { ok, changed: [{ id, effort }], error }
 */
function syncEfforts(file, pair = DEFAULT_PAIR) {
  const want = [
    [pair.primaryId, pair.primaryEffort],
    [pair.secondaryId, pair.secondaryEffort],
  ].filter(([id, e]) => id && MODEL_EFFORTS.includes(e));
  if (!want.length) return { ok: true, changed: [] };
  const r = readSettings(file);
  if (r.error) return { ok: false, changed: [], error: `não consegui ler ${file}: ${r.error}` };
  const d = r.data;
  if (d.modelSettings !== undefined && !isObj(d.modelSettings)) return { ok: true, changed: [] };
  const changed = [];
  for (const [id, effort] of want) {
    const cur = d.modelSettings && isObj(d.modelSettings[id]) ? d.modelSettings[id] : null;
    if (cur && cur.effortLevel === effort) continue;
    if (!d.modelSettings) d.modelSettings = {};
    d.modelSettings[id] = { ...(cur || {}), effortLevel: effort };
    changed.push({ id, effort });
  }
  if (!changed.length) return { ok: true, changed };
  try {
    writeSettings(file, d);
  } catch (e) {
    return { ok: false, changed: [], error: `não consegui gravar ${file}: ${e.message}` };
  }
  return { ok: true, changed };
}

module.exports = {
  OPUS_ID,
  FABLE_ID,
  FALLBACK_MODEL,
  FALLBACK_LABEL,
  FABLE_RE,
  HOLD_MS,
  TRANSIENT_LIMIT_RE,
  DEFAULT_PAIR,
  pairOf,
  isPrimaryName,
  readSettings,
  writeSettings,
  isOpus,
  isSecondary,
  isPlanDefault,
  isFableDefault,
  isPrimaryDefault,
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
  syncEfforts,
};
