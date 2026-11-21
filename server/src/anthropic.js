"use strict";
// Chamadas à Anthropic: renovar o login (OAuth), ler o uso, ler o perfil e ler o catálogo de modelos.
//
// - Este módulo não grava nada em log. Tokens só saem daqui dentro do
//   resultado de refresh() (para o motor guardar no cofre).
// - Toda chamada tem tempo máximo (AbortSignal.timeout): 45 s na renovação (uma renovação
//   cortada no meio pode ter gastado o refresh token sem devolver o novo), 15 s no uso e no perfil.
//   E recusa redirecionamento (redirect: "error"): o refresh token e o access token
//   só vão para o endereço configurado.
// - tokenUrl/apiBase precisam ser https (http só em 127.0.0.1/localhost, para
//   os testes com servidor local); senão createAnthropic lança.
// - As chamadas não lançam exceção para fora: erro de rede, tempo esgotado, redirecionamento e resposta
//   estranha viram resultado com `ok: false` (ou `null` no perfil).
// - Renovação que falhou sem resposta (tempo esgotado, conexão caída, 5xx, corpo quebrado) volta com
//   `ambiguous: true`: a Anthropic pode ter gastado o refresh token. Só o pedido que comprovadamente
//   nunca saiu daqui (DNS, conexão recusada) não é ambíguo.
// - Mesmo comportamento do motor Python (swap-plus/src/claude_swap/oauth.py):
//   try_refresh_oauth_credentials, request_usage_data, build_usage_result,
//   fetch_oauth_profile.

const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
const USER_AGENT = "swap-plus-server/2.0";
const OAUTH_BETA = "oauth-2025-04-20";
const API_VERSION = "2023-06-01"; // cabeçalho anthropic-version do catálogo de modelos (/v1/models)
const MODELS_LIMIT = 100; // modelos por página (hoje vêm 15)
const EFFORT_ORDER = ["low", "medium", "high", "xhigh", "max"];
const MODEL_ID_RE = /^claude-[a-z0-9][a-z0-9.-]{0,79}$/;
const TIMEOUT_MS = 15000; // uso e perfil
const REFRESH_TIMEOUT_MS = 45000; // renovação: cortar cedo demais pode perder o refresh token novo
const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_API_BASE = "https://api.anthropic.com";
const MAX_RETRY_AFTER_SEC = 6 * 3600; // teto do Retry-After: um valor absurdo não para as leituras por dias
const FALLBACK_EXPIRES_IN_SEC = 3600; // 200 com access_token mas sem expires_in válido: assume 1 h (renova cedo)
const MAX_EXPIRES_IN_SEC = 24 * 3600; // teto do expires_in: um valor absurdo não deixa o acesso "valendo" por anos
// Erros em que o pedido comprovadamente não saiu daqui (o refresh token não chegou à Anthropic).
const NOT_SENT_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"]);
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const MAX_DATE_MS = 8.64e15; // maior data que o Date aceita

/** Segundos vindos da resposta (número, ou número em texto) > 0; senão null. */
function seconds(raw) {
  const n = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Códigos de erro de rede de uma exceção do fetch (o undici põe o motivo em `cause`, às vezes num AggregateError). */
function errorCodes(e, out = [], depth = 0) {
  if (!e || typeof e !== "object" || depth > 5) return out;
  if (typeof e.code === "string" && e.code) out.push(e.code);
  else if (e.name === "TimeoutError" || e.name === "AbortError") out.push(e.name);
  if (e.cause) errorCodes(e.cause, out, depth + 1);
  if (Array.isArray(e.errors)) for (const x of e.errors) errorCodes(x, out, depth + 1);
  return out;
}

/** true só quando o pedido comprovadamente nunca saiu (DNS, conexão recusada). Na dúvida: false (ambíguo). */
function neverSent(e) {
  const codes = errorCodes(e);
  return codes.length > 0 && codes.every((c) => NOT_SENT_CODES.has(c));
}

/** Falha temporária da renovação; `ambiguous` = a Anthropic pode ter gastado o refresh token sem a resposta chegar. */
function transient(status, ambiguous) {
  return ambiguous ? { ok: false, error: "transient", status, ambiguous: true } : { ok: false, error: "transient", status };
}

/** Resposta de uso que não dá para ler como medição (vira `bad_response`). */
class BadResponse extends Error {}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** Lê o corpo como JSON; `undefined` se não for JSON. Erro de rede no corpo propaga. */
async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Descarta o corpo (libera a conexão) sem nunca lançar. */
async function discard(res) {
  try {
    await res.text();
  } catch {}
}

/** Retry-After em segundos (aceita número ou data HTTP), com teto de 6 h; null se não veio. */
function retryAfterOf(res, nowMs) {
  const raw = res && res.headers && typeof res.headers.get === "function" ? res.headers.get("retry-after") : null;
  if (!raw) return null;
  const n = Number(String(raw).trim());
  if (Number.isFinite(n) && n >= 0) return Math.min(n, MAX_RETRY_AFTER_SEC);
  const t = Date.parse(raw);
  if (!isNaN(t)) return Math.min(MAX_RETRY_AFTER_SEC, Math.max(0, Math.round((t - nowMs) / 1000)));
  return null;
}

/** Só https; http só para 127.0.0.1/localhost (testes com servidor local). Lança se não servir. */
function checkUrl(name, value) {
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`${name} inválido: não é um endereço`);
  }
  if (u.protocol === "https:") return;
  if (u.protocol === "http:" && LOCAL_HOSTS.includes(u.hostname)) return;
  throw new Error(`${name} precisa ser https (http só em 127.0.0.1/localhost); veio ${u.protocol}//${u.host}`);
}

/**
 * Uma janela five_hour/seven_day → { pct, resetsAt } ou undefined (ausente).
 * Ausente = faltando, null ou {}. `utilization: null` mantém a janela com pct null.
 * utilization faltando, negativa, não numérica → resposta inválida (como o motor Python:
 * descartar uma janela deixaria a outra passar por leitura completa).
 */
function normWindow(key, w) {
  if (w === undefined || w === null) return undefined;
  if (!isObj(w)) throw new BadResponse(`${key} precisa ser objeto ou null`);
  if (!Object.keys(w).length) return undefined;
  if (!("utilization" in w)) throw new BadResponse(`${key}.utilization ausente`);
  const pct = w.utilization;
  if (pct !== null && !(typeof pct === "number" && Number.isFinite(pct) && pct >= 0)) {
    throw new BadResponse(`${key}.utilization precisa ser null ou número >= 0`);
  }
  return { pct, resetsAt: str(w.resets_at) };
}

/** Resposta crua de /api/oauth/usage → Usage { fiveHour?, sevenDay?, scoped? }. */
function normalizeUsage(data) {
  if (!isObj(data)) throw new BadResponse("resposta de uso não é um objeto");
  const out = {};
  const five = normWindow("five_hour", data.five_hour);
  if (five) out.fiveHour = five;
  const seven = normWindow("seven_day", data.seven_day);
  if (seven) out.sevenDay = seven;
  // Limites por modelo (ex.: Fable) vêm só no array `limits`, com scope.model.display_name.
  if (Array.isArray(data.limits)) {
    const scoped = [];
    for (const lim of data.limits) {
      if (!isObj(lim)) continue;
      const model = isObj(lim.scope) && isObj(lim.scope.model) ? lim.scope.model : null;
      const name = model ? str(model.display_name) : null;
      const pct = lim.percent;
      if (!name || typeof pct !== "number" || !Number.isFinite(pct)) continue;
      scoped.push({ name, pct, resetsAt: str(lim.resets_at) });
    }
    if (scoped.length) out.scoped = scoped;
  }
  return out;
}

/**
 * Resposta crua de /v1/models (`data[]`) → [{ id, name, line, createdAt, efforts }], o mais novo primeiro.
 *   line: a família ("fable", "opus", "sonnet", "haiku"); efforts: os níveis de esforço que o modelo aceita, na
 *   ordem low, medium, high, xhigh, max ([] = o modelo não tem esforço). Item sem ID de modelo válido é ignorado.
 */
function normalizeModels(data) {
  const out = [];
  const seen = new Set();
  for (const m of Array.isArray(data) ? data : []) {
    if (!isObj(m)) continue;
    const id = str(m.id);
    if (!id || !MODEL_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    const eff = isObj(m.capabilities) && isObj(m.capabilities.effort) ? m.capabilities.effort : null;
    const efforts = eff && eff.supported !== false ? EFFORT_ORDER.filter((k) => isObj(eff[k]) && eff[k].supported === true) : [];
    const fromId = /^claude-([a-z]+)/.exec(id);
    const line = (str(m.line) || (fromId ? fromId[1] : "")).toLowerCase().slice(0, 40) || null;
    out.push({ id, name: (str(m.display_name) || id).slice(0, 80), line, createdAt: str(m.created_at), efforts });
  }
  const ts = (m) => Date.parse(m.createdAt || "") || 0;
  return out.sort((a, b) => ts(b) - ts(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** Identidade opcional que o endpoint de token às vezes manda junto da renovação. */
function tokenAccount(body) {
  if (!isObj(body) || !isObj(body.account)) return null;
  const uuid = str(body.account.uuid);
  if (!uuid) return null;
  return {
    uuid,
    email: str(body.account.email_address) || str(body.account.email),
    orgUuid: isObj(body.organization) ? str(body.organization.uuid) : null,
  };
}

function createAnthropic({ tokenUrl = DEFAULT_TOKEN_URL, apiBase = DEFAULT_API_BASE, fetchImpl = fetch, now = Date.now } = {}) {
  const base = String(apiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const url = tokenUrl || DEFAULT_TOKEN_URL;
  checkUrl("ANTHROPIC_TOKEN_URL (tokenUrl)", url);
  checkUrl("ANTHROPIC_API_BASE (apiBase)", base);

  /**
   * Renova o login. O refresh token é de uso único: quem chama precisa gravar
   * o `cred` novo no cofre antes de qualquer outra coisa.
   * → { ok: true, cred, account? } | { ok: false, error: "invalid_grant"|"invalid_client"|"transient"|"no_refresh_token", status, cred?, ambiguous? }
   * `ambiguous: true` (só em transient): sem resposta (tempo esgotado, conexão caída, 5xx, corpo quebrado);
   * a Anthropic pode ter gastado o refresh token. DNS/conexão recusada e 4xx não são ambíguos.
   * Falha COM `cred`: a resposta trouxe um refresh token novo sem access token. O antigo já foi gasto,
   * então quem chama TEM de gravar esse `cred` (refresh token novo, expiresAt 0 = renovar de novo logo).
   * `refreshTokenExpiresAt` (quando o login acaba de vez; renovar não muda) vem do `cred` recebido e só é
   * recalculado se a resposta trouxer `refresh_token_expires_in` (s) válido. Nunca é apagado.
   */
  async function refresh(cred) {
    if (!isObj(cred) || !str(cred.refreshToken)) return { ok: false, error: "no_refresh_token", status: 0 };
    let res;
    try {
      res = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: cred.refreshToken, client_id: CLIENT_ID }),
        redirect: "error",
        signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS),
      });
    } catch (e) {
      return transient(0, !neverSent(e)); // tempo esgotado / conexão caída / redirecionamento: pode ter chegado lá
    }
    let body;
    try {
      body = await readJson(res);
    } catch {
      return transient(res.status || 0, true); // a resposta começou e caiu no meio
    }
    if (res.ok) {
      if (!isObj(body)) return transient(res.status, true); // 200 com corpo quebrado: a renovação pode ter acontecido
      const t = now();
      const newRefresh = str(body.refresh_token) ? body.refresh_token : null;
      // Fim do login: só muda se a resposta disser (senão fica o do `cred`, que vem no ...cred).
      const loginSec = seconds(body.refresh_token_expires_in);
      const loginExp = loginSec && t + loginSec * 1000 <= MAX_DATE_MS ? t + loginSec * 1000 : null;
      if (!str(body.access_token)) {
        // Sem access token. Se veio um refresh token novo, o antigo já foi gasto: devolve o novo
        // para ser gravado (perdê-lo mataria a conta), com o acesso vencido para renovar de novo.
        if (newRefresh && newRefresh !== cred.refreshToken) {
          const partial = { ...cred, refreshToken: newRefresh, expiresAt: 0 };
          if (loginExp) partial.refreshTokenExpiresAt = loginExp;
          return { ok: false, error: "transient", status: res.status, cred: partial };
        }
        return transient(res.status, true); // 200 sem nada que sirva: corpo quebrado
      }
      const next = {
        ...cred,
        accessToken: body.access_token,
        refreshToken: newRefresh || cred.refreshToken,
        expiresAt: t + Math.min(seconds(body.expires_in) || FALLBACK_EXPIRES_IN_SEC, MAX_EXPIRES_IN_SEC) * 1000,
      };
      if (loginExp) next.refreshTokenExpiresAt = loginExp;
      if (str(body.scope)) next.scopes = body.scope.trim().split(/\s+/);
      const account = tokenAccount(body);
      return account ? { ok: true, cred: next, account } : { ok: true, cred: next };
    }
    // Definitivo só quando o servidor recusou o pedido E disse por quê (campo `error` do JSON).
    if ([400, 401, 403].includes(res.status) && isObj(body) && (body.error === "invalid_grant" || body.error === "invalid_client")) {
      return { ok: false, error: body.error, status: res.status };
    }
    // 5xx: o servidor (ou o proxy dele) pode ter processado a renovação. 4xx: o pedido foi recusado.
    return transient(res.status, res.status >= 500);
  }

  /**
   * Lê o uso da conta dona do access token.
   * → { ok: true, usage } | { ok: false, error: "unauthorized"|"rate_limited"|"transient"|"bad_response", status, retryAfterSec }
   */
  async function usage(accessToken) {
    const fail = (error, status, retryAfterSec = null) => ({ ok: false, error, status, retryAfterSec });
    let res;
    try {
      res = await fetchImpl(`${base}/api/oauth/usage`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": OAUTH_BETA, "User-Agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return fail("transient", 0);
    }
    if (res.status === 401) {
      await discard(res);
      return fail("unauthorized", 401);
    }
    if (res.status === 429) {
      const ra = retryAfterOf(res, now());
      await discard(res);
      return fail("rate_limited", 429, ra);
    }
    if (!res.ok) {
      const ra = retryAfterOf(res, now());
      await discard(res);
      return fail("transient", res.status, ra);
    }
    let data;
    try {
      data = await readJson(res);
    } catch {
      return fail("transient", res.status);
    }
    if (data === undefined) return fail("bad_response", res.status);
    try {
      return { ok: true, usage: normalizeUsage(data) };
    } catch (e) {
      if (e instanceof BadResponse) return fail("bad_response", res.status);
      return fail("transient", res.status);
    }
  }

  /** Dono do access token: { uuid, email, orgUuid } ou null (qualquer falha). */
  async function profile(accessToken) {
    try {
      const res = await fetchImpl(`${base}/api/oauth/profile`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        await discard(res);
        return null;
      }
      const data = await readJson(res);
      if (!isObj(data) || !isObj(data.account)) return null;
      const uuid = str(data.account.uuid);
      if (!uuid) return null;
      return {
        uuid,
        // A API documentada usa email_address; o motor Python lê `email`. Aceita os dois.
        email: str(data.account.email_address) || str(data.account.email),
        orgUuid: isObj(data.organization) ? str(data.organization.uuid) : null,
      };
    } catch {
      return null;
    }
  }

  /**
   * Catálogo de modelos que a conta dona do access token enxerga (GET /v1/models). Não é inferência: não gasta uso.
   * → { ok: true, models: [{ id, name, line, createdAt, efforts }] } |
   *   { ok: false, error: "unauthorized"|"rate_limited"|"transient"|"bad_response", status, retryAfterSec }
   */
  async function models(accessToken) {
    const fail = (error, status, retryAfterSec = null) => ({ ok: false, error, status, retryAfterSec });
    let res;
    try {
      res = await fetchImpl(`${base}/v1/models?limit=${MODELS_LIMIT}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, "anthropic-beta": OAUTH_BETA, "anthropic-version": API_VERSION, "User-Agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      return fail("transient", 0);
    }
    if (res.status === 401) {
      await discard(res);
      return fail("unauthorized", 401);
    }
    if (res.status === 429) {
      const ra = retryAfterOf(res, now());
      await discard(res);
      return fail("rate_limited", 429, ra);
    }
    if (!res.ok) {
      await discard(res);
      return fail("transient", res.status);
    }
    let data;
    try {
      data = await readJson(res);
    } catch {
      return fail("transient", res.status);
    }
    if (!isObj(data) || !Array.isArray(data.data)) return fail("bad_response", res.status);
    const list = normalizeModels(data.data);
    return list.length ? { ok: true, models: list } : fail("bad_response", res.status);
  }

  return { refresh, usage, profile, models };
}

module.exports = {
  createAnthropic,
  normalizeUsage,
  normalizeModels,
  EFFORT_ORDER,
  API_VERSION,
  CLIENT_ID,
  USER_AGENT,
  OAUTH_BETA,
  TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
  DEFAULT_TOKEN_URL,
  DEFAULT_API_BASE,
  MAX_RETRY_AFTER_SEC,
  FALLBACK_EXPIRES_IN_SEC,
  MAX_EXPIRES_IN_SEC,
};
