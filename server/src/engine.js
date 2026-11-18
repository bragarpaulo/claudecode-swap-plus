"use strict";
// Motor do servidor: renova os logins, lê o uso dentro do orçamento e decide a
// conta de cada dispositivo com as mesmas regras da extensão (plus/rules.js).
//
// Regras de ouro:
// - O refresh token é de uso único. Quem renova grava o cofre (await store.save())
//   ANTES de usar o token novo. Se o cofre não grava, não renova mais nada.
// - O refresh token nunca sai daqui (nem para o cliente, nem para o log).
//   Access tokens também nunca vão para o log.
// - Uma renovação por conta de cada vez (trava por conta) e um envio por login (trava por login).
// - Encerrando (stop()), nada começa a gastar refresh token; stop() espera o que já começou.
// - Renovação sem resposta (ambígua) pode ter gastado o refresh token: tenta de novo logo e
//   confirma um invalid_grant que venha em seguida antes de dar a conta como morta.
// - Computadores permitidos por conta (access.js, WEB-SPEC 2.3): um computador só recebe, troca para
//   ou ganha o acesso de uma conta liberada para ele. É permissão, não preferência: vale com a troca
//   automática ligada ou desligada. records() continua global (extensão e painel); as escolhas usam
//   recordsFor(dev).
// - Regra "Computadores" (rules.devicePlacement): "separate" (padrão) = cada computador ativo numa conta (as dos
//   outros ficam ocupadas, para não dividirem a sessão de 5 h; spreadOut separa); "together" = todos os ativos na
//   MESMA conta (a do grupo) e trocam juntos (togetherStep). Quem não pode usar a conta do grupo fica com a melhor
//   conta liberada para ele — a permissão sempre vale mais que o "juntos".
// - Só os computadores do ADMINISTRADOR enviam logins (canUploadLogins): conectados com Google com e-mail de
//   ADMIN_EMAILS (o servidor passa quem é administrador em setAdminCheck) ou pareados por código (googleEmail nulo:
//   o código só sai da linha de comando/painel do administrador). Os outros usam as contas do servidor.
// - Avisos por e-mail ao dono (notify.js, opção `notify` do construtor): login que vence em menos de 3 dias (junto
//   com o alerta diário do histórico: 1 por conta por dia), conta que morre (1 na hora) e cofre que para de gravar
//   (1 por incidente). O motor só chama notify({ subject, text }); sem `notify`, nada é avisado. Nunca derruba nada.

const crypto = require("crypto");
const { RULE_DEFAULTS, STRATEGY_LABELS, decide, windows, linesFor } = require("../../plus/rules");
const access = require("./access");

const VERSION = "2.4.2";
const TICK_MS = 15 * 1000;
const ACTIVE_MS = 5 * 60 * 1000; // dispositivo visto nos últimos 5 min = ativo
const POLL_ACTIVE_MS = 3 * 60 * 1000; // conta de dispositivo ativo: uso a cada 3 min
const POLL_IDLE_MS = 20 * 60 * 1000; // as outras: a cada 20 min
const POLL_BACKOFF_MIN = [2, 5, 10];
const REFRESH_BACKOFF_MIN = [1, 2, 5, 10];
const INVALID_CLIENT_BACKOFF_MS = 10 * 60 * 1000;
const PAUSE_429_MIN_MS = 10 * 60 * 1000;
const CRED_MIN_VALID_MS = 30 * 60 * 1000; // credencial entregue vale pelo menos 30 min (ou metade da vida do token)
const UNAUTHORIZED_MIN_AGE_MS = 15 * 60 * 1000; // 401 na leitura de uso só renova token com mais de 15 min
const AMBIGUOUS_RETRY_MS = 15 * 1000; // renovação sem resposta: tenta de novo em ~15 s
const AMBIGUOUS_WINDOW_MS = 10 * 60 * 1000; // invalid_grant até 10 min depois de uma sem resposta: confirma antes
const CONFIRM_INVALID_GRANT_MS = 2 * 60 * 1000; // ...confirma 2 min depois
const MAX_ACCESS_LIFE_MS = 24 * 60 * 60 * 1000; // acesso renovado vale no máximo 24 h (data absurda não vale)
const FALLBACK_ACCESS_MS = 60 * 60 * 1000; // acesso renovado com data inválida: 1 h
const EXPIRED_SLACK_MS = 60 * 1000;
const HISTORY_MAX = 100;
const HISTORY_IN_STATE = 40;
const NOTE_REPEAT_MS = 60 * 60 * 1000; // "sem folga" no histórico no máximo 1x/h por dispositivo
const SPENT_KEEP = 500; // refresh tokens gastos lembrados (por conta e na lista geral)
const DIAG_MAX_ATTEMPTS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOGIN_WARN_MS = 3 * DAY_MS; // avisa quando faltam menos de 3 dias para o login vencer de vez
const LOGIN_FILL_MAX_AHEAD_MS = 5 * 365 * DAY_MS; // setLoginExpiresAt: mais longe que isso é engano de digitação
const MAX_DATE_MS = 8.64e15; // maior data que o Date aceita (além disso toISOString lança)

const PLAN_LABELS = { team: "Team", max: "Max", pro: "Pro", enterprise: "Enterprise" };
const STOPPING_TEXT = "o servidor está reiniciando; tente de novo daqui a pouco";
const NOT_ADMIN_TEXT = "Só os computadores do administrador enviam logins ao servidor. Este computador usa as contas do servidor.";
const NO_ADMIN = () => false; // sem setAdminCheck: ninguém com Google é administrador
const SAVE_FAILED_TEXT = "O cofre não está gravando (disco cheio?). NÃO reinicie o servidor: há login renovado só na memória.";
const NO_RESPONSE_TEXT = "a renovação anterior ficou sem resposta e o login foi gasto";
const SAVE_NOTICE_RETRY_MS = 60 * 1000; // aviso de cofre sem gravar que não foi gravado (disco cheio): tenta de novo depois disso
const SAVE_NOTICE_GAP_MS = 60 * 60 * 1000; // cofre que vai e volta: no máximo 1 aviso de "cofre sem gravar" por hora

// Faixas iguais às das configurações da extensão (plus/package.json). Números fora da faixa são ajustados.
const RULE_LIMITS = {
  sessionPct: [50, 100],
  weeklyPct: [50, 100],
  modelPct: [50, 100],
  expiringHours: [1, 168],
  cooldownMin: [0, 240],
  marginPct: [0, 30],
  intervalSec: [15, 3600],
};
// Linhas próprias por conta (updateAccount / records): sessão 5h, semanal, modelo. null = a regra geral.
const OWN_LINE_KEYS = ["threshold", "weeklyThreshold", "modelThreshold"];
const MODEL_LIMIT_MODES = ["sameAccount", "switchAccount"];
const DEVICE_PLACEMENTS = ["separate", "together"]; // rules.devicePlacement
// Modo "together": trocas que definem a conta do grupo (a atribuição "assign" não define: no modo "separate" ela
// escolhe uma conta livre, não a do topo da fila).
const GROUP_LEADER_BY = new Set(["auto", "limit", "manual", "painel", "group"]);

/** Status HTTP sugerido para cada `.code` de erro lançado pelo motor. */
const ERROR_STATUS = {
  invalid: 400,
  invalid_rules: 400,
  unknown_device: 404,
  not_found: 404,
  dead_account: 409,
  not_allowed: 409, // a conta não está liberada para este computador (Contas → Computadores permitidos)
  not_admin: 403, // addLogin de um computador que não é do administrador (canUploadLogins)
  invalid_login: 422,
  dead_login: 422,
  stale_login: 422,
  identity_mismatch: 422,
  identity_mismatch_spent: 422, // identidade errada descoberta DEPOIS de renovar: o login enviado foi gasto
  profile_unavailable: 422,
  refresh_failed: 422,
};

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function isObj(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function str(v) {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

const notAllowedText = (n) => `a conta ${n} não está liberada para este computador`;
const TOGETHER_TEXT = "computadores juntos na mesma conta";
/** "A", "A e B", "A, B e C" */
const joinNames = (names) => (names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} e ${names[names.length - 1]}`);
const devName = (d) => d.name || d.id;
const lower = (s) => String(s || "").trim().toLowerCase();
const cap = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const pad2 = (n) => String(n).padStart(2, "0");

/** Data (epoch ms) válida: número finito > 0 que o Date aceita; em segundos vira ms. Senão null. */
function epochMs(v) {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return null;
  const ms = Math.round(v < 1e11 ? v * 1000 : v);
  return ms <= MAX_DATE_MS ? ms : null;
}

/** ISO da data (ms), ou null se não for uma data válida > 0. */
function isoOrNull(v) {
  const ms = Number(v);
  return Number.isFinite(ms) && ms > 0 && ms <= MAX_DATE_MS ? new Date(ms).toISOString() : null;
}

/** "DD/MM HH:MM" no fuso do servidor (TZ), como os textos do rules.js. */
function fmtDayTime(ms) {
  const d = new Date(ms);
  return `${pad2(d.getDate())}/${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** "AAAA-MM-DD" no fuso do servidor: o dia do último aviso de login vencendo. */
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** Quanto falta, em português simples, para os avisos por e-mail ("cerca de 2 dias", "cerca de 5 horas"). */
function leftText(ms) {
  if (!(ms > 0)) return "já passou";
  const h = ms / 3600000;
  if (h < 1) return "menos de 1 hora";
  if (h < 36) {
    const n = Math.round(h);
    return n === 1 ? "cerca de 1 hora" : `cerca de ${n} horas`;
  }
  const d = Math.round(h / 24);
  return d === 1 ? "cerca de 1 dia" : `cerca de ${d} dias`;
}

/** Endereço do painel (PUBLIC_URL) sem a barra do fim, ou null se não for um endereço http(s). */
function panelUrlOf(v) {
  const s = typeof v === "string" ? v.trim().replace(/\/+$/, "") : "";
  if (!s) return null;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? s : null;
  } catch {
    return null;
  }
}

function makeLog(log) {
  const pick = (k) => {
    if (log && typeof log[k] === "function") return log[k].bind(log);
    if (log && typeof log.log === "function") return log.log.bind(log);
    return () => {};
  };
  return { info: pick("info"), warn: pick("warn"), error: pick("error") };
}

/** Só os campos conhecidos da credencial (nada de campos extras vindos do cliente). */
function cleanCred(c) {
  let exp = Number(c.expiresAt);
  if (!Number.isFinite(exp)) exp = 0;
  if (exp > 0 && exp < 1e11) exp *= 1000; // veio em segundos
  const out = {
    accessToken: typeof c.accessToken === "string" ? c.accessToken : "",
    refreshToken: typeof c.refreshToken === "string" ? c.refreshToken : "",
    expiresAt: exp,
    scopes: Array.isArray(c.scopes)
      ? c.scopes.filter((s) => typeof s === "string")
      : typeof c.scopes === "string"
        ? c.scopes.split(/\s+/).filter(Boolean)
        : [],
    subscriptionType: typeof c.subscriptionType === "string" ? c.subscriptionType : null,
    rateLimitTier: typeof c.rateLimitTier === "string" ? c.rateLimitTier : null,
  };
  // Quando o login acaba de vez (só um /login novo resolve). Sem o campo = desconhecido (nunca "agora").
  const loginExp = epochMs(c.refreshTokenExpiresAt);
  if (loginExp) out.refreshTokenExpiresAt = loginExp;
  return out;
}

/** Renovar o acesso não muda o fim do login: se a resposta não trouxe data nova, fica a de antes. */
function keepLoginExpiry(next, prev) {
  if (!next.refreshTokenExpiresAt && isObj(prev)) {
    const v = epochMs(prev.refreshTokenExpiresAt);
    if (v) next.refreshTokenExpiresAt = v;
  }
  return next;
}

/** Validade do acesso recém-renovado sempre uma data que serve: inválida → 1 h; mais de 24 h à frente → 24 h. */
function sanitizeAccess(cred, t) {
  const exp = Number(cred.expiresAt);
  if (!Number.isFinite(exp) || exp <= 0 || exp > MAX_DATE_MS) cred.expiresAt = t + FALLBACK_ACCESS_MS;
  else if (exp > t + MAX_ACCESS_LIFE_MS) cred.expiresAt = t + MAX_ACCESS_LIFE_MS;
  return cred;
}

function planOf(plan, subscriptionType) {
  if (isObj(plan) && str(plan.label)) return { label: str(plan.label).slice(0, 40) };
  const label = PLAN_LABELS[lower(subscriptionType)];
  return label ? { label } : null;
}

function cleanModels(models) {
  if (!Array.isArray(models)) return [];
  const out = [];
  for (const m of models) {
    const id = typeof m === "string" ? m : isObj(m) && typeof m.id === "string" ? m.id : null;
    if (id && id.trim() && !out.includes(id.trim().slice(0, 100))) out.push(id.trim().slice(0, 100));
    if (out.length >= 20) break;
  }
  return out;
}

function cleanLive(live, t) {
  if (!isObj(live)) return null;
  const exp = Number(live.expiresAt);
  return {
    email: str(live.email) ? str(live.email).slice(0, 200) : null,
    orgUuid: str(live.orgUuid) ? str(live.orgUuid).slice(0, 100) : null,
    expiresAt: Number.isFinite(exp) ? exp : null,
    at: t,
  };
}

function checkRule(key, value) {
  if (RULE_LIMITS[key]) {
    const [min, max] = RULE_LIMITS[key];
    const n = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : NaN;
    if (!Number.isFinite(n)) throw fail("invalid_rules", `${key} precisa ser um número de ${min} a ${max}`);
    return Math.min(max, Math.max(min, n));
  }
  if (key === "strategy") {
    if (!STRATEGY_LABELS[value]) throw fail("invalid_rules", `strategy precisa ser ${Object.keys(STRATEGY_LABELS).join(", ")}`);
    return value;
  }
  if (key === "onModelLimit") {
    if (!MODEL_LIMIT_MODES.includes(value)) throw fail("invalid_rules", `onModelLimit precisa ser ${MODEL_LIMIT_MODES.join(" ou ")}`);
    return value;
  }
  if (key === "devicePlacement") {
    if (!DEVICE_PLACEMENTS.includes(value)) throw fail("invalid_rules", `devicePlacement precisa ser ${DEVICE_PLACEMENTS.join(" ou ")}`);
    return value;
  }
  if (key === "preferModel") {
    if (typeof value !== "string") throw fail("invalid_rules", "preferModel precisa ser texto");
    return value.trim().slice(0, 40);
  }
  throw fail("invalid_rules", `regra desconhecida: ${key}`);
}

class Engine {
  /**
   * notify (opcional): fn({ subject, text }) → { ok, ... } — avisos por e-mail ao dono (notify.js: createNotifier,
   * que grava em DATA_DIR/avisos/). Sem ele, nenhum aviso. O endereço do painel nos avisos vem de env.PUBLIC_URL.
   */
  constructor({ store, anthropic, now = Date.now, log = console, env = process.env, version = VERSION, isAdminEmail = null, notify = null } = {}) {
    if (!store) throw new Error("o motor precisa do cofre (store)");
    if (!anthropic) throw new Error("o motor precisa do cliente da Anthropic");
    const e = env || {};
    this.store = store;
    this.anthropic = anthropic;
    this.now = now;
    this.log = makeLog(log);
    this.version = version;
    this.setAdminCheck(isAdminEmail);
    this.notifyFn = typeof notify === "function" ? notify : null;
    this.panelUrl = panelUrlOf(e.PUBLIC_URL);
    this.saveIncident = null; // cofre sem gravar: { since, error, notified, lastTry } (só na memória)
    this.saveNoticeAt = 0; // quando saiu o último aviso de "cofre sem gravar" (anti vai-e-volta)
    const perHour = Number(e.USAGE_MAX_PER_HOUR);
    this.usageMaxPerHour = Number.isFinite(perHour) && perHour >= 1 ? perHour : 24;
    const ahead = Number(e.REFRESH_AHEAD_MIN);
    this.refreshAheadMs = (Number.isFinite(ahead) && ahead >= 0 && String(e.REFRESH_AHEAD_MIN).trim() !== "" ? ahead : 120) * 60000;
    // Estado só da memória (não vai para o cofre).
    this.bucket = { tokens: this.usageMaxPerHour, at: now() };
    this.pausedUntil = 0; // pausa global do uso depois de um 429
    this.locks = new Map();
    this.pollSoon = new Set(); // contas para ler o uso logo (limite batido, login novo)
    this.diagPending = null; // { number, accessToken, expiresAt, attempts } — token ANTIGO, nunca logar
    this.notes = new Map(); // deviceId → { key, at } (avisos repetidos no histórico)
    this.dirty = false;
    this.saveFailed = false;
    this.timer = null;
    this.ticking = null;
    this.stopping = false; // stop() chamado: nada novo gasta refresh token
    this.inflight = new Set(); // envios de login em andamento (stop() espera)
    this._normalized = null;
  }

  // ------------------------------------------------------------------ estado

  get st() {
    const s = this.store.state;
    if (!s) throw new Error("cofre não carregado (chame store.load() antes)");
    if (this._normalized !== s) {
      if (!isObj(s.accounts)) s.accounts = {};
      if (!isObj(s.devices)) s.devices = {};
      if (!Array.isArray(s.history)) s.history = [];
      if (!isObj(s.diag)) s.diag = {};
      const maxN = Object.values(s.accounts).reduce((m, a) => Math.max(m, Number(a && a.number) || 0), 0);
      if (!Number.isInteger(s.nextNumber) || s.nextNumber <= maxN) s.nextNumber = maxN + 1;
      this._normalized = s;
    }
    return s;
  }

  /** ISO da data; nunca lança (data inválida vira texto, para não derrubar uma renovação no meio). */
  iso(t = this.now()) {
    const ms = Number(t);
    return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? new Date(ms).toISOString() : "data inválida";
  }

  acc(n) {
    if (n === null || n === undefined || n === "") return null;
    const a = this.st.accounts[String(n)];
    return isObj(a) ? a : null;
  }

  device(id) {
    if (typeof id !== "string" || !id) return null;
    const devs = this.st.devices;
    return Object.prototype.hasOwnProperty.call(devs, id) && isObj(devs[id]) ? devs[id] : null;
  }

  needDevice(id) {
    const d = this.device(id);
    if (!d) throw fail("unknown_device", "dispositivo desconhecido");
    return d;
  }

  /**
   * Quem é administrador: fn(email) → true/false (o servidor passa o isAdmin de ADMIN_EMAILS, lido na subida).
   * Sem fn: ninguém com Google é administrador (só os computadores pareados por código enviam logins).
   */
  setAdminCheck(fn) {
    this.isAdminEmail = typeof fn === "function" ? fn : NO_ADMIN;
  }

  /**
   * O computador pode enviar logins ao servidor (POST /v1/logins)? Só os do administrador: conectado com Google com
   * e-mail de administrador, ou pareado por código (googleEmail nulo). Mesma regra do canUploadLogins do server.js.
   */
  canUploadLogins(dev) {
    if (!isObj(dev)) return false;
    if (!dev.googleEmail) return true;
    try {
      return this.isAdminEmail(dev.googleEmail) === true;
    } catch {
      return false;
    }
  }

  accountList() {
    return Object.values(this.st.accounts)
      .filter(isObj)
      .sort((a, b) => a.number - b.number);
  }

  deviceList() {
    return Object.values(this.st.devices)
      .filter(isObj)
      .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0) || String(a.id).localeCompare(String(b.id)));
  }

  isActive(dev, t = this.now()) {
    return !!dev && Number(dev.lastSeen) > 0 && t - Number(dev.lastSeen) <= ACTIVE_MS;
  }

  /** Contas em uso por OUTROS dispositivos ativos. */
  othersAccounts(deviceId, t = this.now()) {
    const s = new Set();
    for (const d of this.deviceList()) {
      if (d.id !== deviceId && d.assigned !== null && d.assigned !== undefined && this.isActive(d, t)) s.add(Number(d.assigned));
    }
    return s;
  }

  findAccount(email, orgUuid) {
    const e = lower(email);
    const o = orgUuid || "";
    const same = this.accountList().filter((a) => lower(a.email) === e);
    return same.find((a) => (a.orgUuid || "") === o) || same.find((a) => !a.orgUuid || !o) || null;
  }

  isSpent(refreshToken) {
    const h = sha256(refreshToken);
    const global = this.st.spentLogins;
    if (Array.isArray(global) && global.includes(h)) return true;
    return this.accountList().some((a) => Array.isArray(a.spentRefresh) && a.spentRefresh.includes(h));
  }

  addSpent(acc, refreshToken) {
    acc.spentRefresh = [sha256(refreshToken), ...(Array.isArray(acc.spentRefresh) ? acc.spentRefresh : [])].slice(0, SPENT_KEEP);
  }

  /** Gasto que não ficou em conta nenhuma (ex.: identidade errada depois de renovar): nunca mais vai para a Anthropic. */
  addSpentGlobal(refreshToken) {
    const st = this.st;
    st.spentLogins = [sha256(refreshToken), ...(Array.isArray(st.spentLogins) ? st.spentLogins : [])].slice(0, SPENT_KEEP);
    this.dirty = true;
  }

  /** Registra uma tarefa que stop() precisa esperar (ex.: envio de login). */
  track(p) {
    this.inflight.add(p);
    const done = () => this.inflight.delete(p);
    p.then(done, done);
    return p;
  }

  /**
   * Antes de gastar um refresh token: o cofre precisa estar gravando (senão o refresh token novo
   * ficaria só na memória). → null (pode) | "stopping" | "save_failed"
   */
  async spendBlocker() {
    if (this.stopping) return "stopping";
    if (this.store.lockLost || this.store.closed) return "save_failed";
    if (this.saveFailed) {
      try {
        await this.save();
      } catch {
        return "save_failed";
      }
    }
    return this.stopping ? "stopping" : null;
  }

  async withLock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let release;
    const mine = new Promise((r) => (release = r));
    const tail = prev.then(() => mine);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  async save() {
    try {
      await this.store.save();
      this.dirty = false;
      if (this.saveFailed) this.log.info("[motor] o cofre voltou a gravar");
      this.saveFailed = false;
      this.saveIncident = null; // fim do incidente: um próximo avisa de novo
    } catch (e) {
      this.dirty = true;
      this.saveFailed = true;
      // O cofre encadeia as gravações com .then(): depois de uma falha a corrente ficaria
      // rejeitada para sempre e nenhuma gravação seguinte aconteceria. Destrava aqui.
      if (this.store.writing && typeof this.store.writing.catch === "function") this.store.writing = this.store.writing.catch(() => {});
      this.log.error(`[motor] não consegui gravar o cofre: ${e && e.message}`);
      if (!this.saveIncident) this.saveIncident = { since: this.now(), error: String((e && e.message) || e || "erro").slice(0, 200), notified: false, lastTry: 0 };
      this.noticeSaveFailed();
      throw e;
    }
  }

  // ------------------------------------------------------------------ avisos por e-mail ao dono (notify.js)

  /** Manda um aviso ao dono (grava na caixa de saída). Sem `notify` → null. Nunca lança. */
  notice(subject, text) {
    if (!this.notifyFn) return null;
    try {
      const r = this.notifyFn({ subject, text });
      return isObj(r) ? r : { ok: true };
    } catch (e) {
      this.log.error(`[avisos] o aviso ao dono falhou: ${e && e.message}`);
      return { ok: false, error: "exception" };
    }
  }

  /** "conta 3 (apelido “Trabalho”, e-mail ana@x.com)" — número, apelido e e-mail, para os avisos por e-mail. */
  accountWho(a) {
    const parts = [];
    if (str(a.alias)) parts.push(`apelido “${str(a.alias)}”`);
    if (str(a.email)) parts.push(`e-mail ${str(a.email)}`);
    return `conta ${a.number}${parts.length ? ` (${parts.join(", ")})` : ""}`;
  }

  /** Como renovar o login de uma conta (pelo painel, "Entrar de novo", ou pelo /login do Claude Code). */
  renewText(a) {
    const email = str(a.email) || "o e-mail desta conta";
    const where = this.panelUrl ? `abra ${this.panelUrl}` : "abra o painel do Swap Plus";
    return (
      `Para renovar: ${where} → Contas → conta ${a.number} → Entrar de novo, e entre com ${email} na página da Claude; ` +
      "copie o código e cole no painel. (Ou faça /login no Claude Code de um computador do administrador.)"
    );
  }

  /** Aviso "o login vence" (junto com o alerta diário do histórico). */
  noticeLoginExpiring(a, exp, t = this.now()) {
    const verb = exp > t ? "vence" : "venceu";
    const head =
      exp > t
        ? `O login da ${this.accountWho(a)} no Swap Plus vence em ${fmtDayTime(exp)} (faltam ${leftText(exp - t)}). ` +
          "Depois disso o servidor não consegue mais renovar o acesso dela, e os computadores deixam de usá-la."
        : `O login da ${this.accountWho(a)} no Swap Plus venceu em ${fmtDayTime(exp)}. ` +
          "O servidor pode não conseguir mais renovar o acesso dela, e os computadores deixam de usá-la quando isso acontecer.";
    return this.notice(`Swap Plus: login da conta ${a.number} ${verb} ${fmtDayTime(exp)}`, `${head}\n\n${this.renewText(a)}`);
  }

  /** Aviso "o login parou de valer" (conta que acabou de morrer). */
  noticeDead(a, t = this.now()) {
    const cause = a.dead && a.dead.cause === "no_response";
    const reason = cause
      ? "a renovação anterior ficou sem resposta (a Anthropic gastou o login, mas a resposta não chegou ao servidor) e a seguinte foi recusada"
      : "a Anthropic recusou a renovação (o login foi encerrado, venceu ou foi usado em outro lugar)";
    const text =
      `O login da ${this.accountWho(a)} parou de valer em ${fmtDayTime(t)}.\n` +
      `Motivo: ${reason}.\n` +
      "O servidor não renova mais esta conta, e os computadores que estavam nela passam para outra.\n\n" +
      this.renewText(a);
    return this.notice(`Swap Plus: o login da conta ${a.number} parou de valer`, text);
  }

  /**
   * Aviso "cofre sem gravar": 1 por incidente (o incidente acaba quando o cofre volta a gravar), no máximo 1 por hora
   * se o cofre ficar indo e voltando. Aviso que não deu para gravar (o disco cheio também pega a caixa de saída) é
   * tentado de novo a cada minuto enquanto o incidente durar.
   */
  noticeSaveFailed() {
    const inc = this.saveIncident;
    if (!inc || inc.notified || !this.notifyFn) return;
    const t = this.now();
    if (inc.lastTry && t - inc.lastTry < SAVE_NOTICE_RETRY_MS) return;
    inc.lastTry = t;
    if (this.saveNoticeAt && t - this.saveNoticeAt < SAVE_NOTICE_GAP_MS) {
      inc.notified = true; // avisado há menos de 1 h (cofre indo e voltando): não repete
      return;
    }
    const text =
      `O servidor do Swap Plus não está conseguindo gravar o cofre (o arquivo com os logins das contas) desde ${fmtDayTime(inc.since)}. ` +
      `Erro: ${inc.error}.\n\n` +
      "NÃO reinicie o servidor: há login renovado só na memória. Se o processo parar antes de gravar, esse login se perde e a conta " +
      "precisa entrar de novo.\n\n" +
      "Veja o disco do servidor (espaço livre: df -h; e a pasta de dados do Swap Plus). Enquanto o cofre não grava, o servidor não " +
      "renova nenhuma conta; assim que ele voltar a gravar, o servidor grava sozinho e segue normal. Este aviso não se repete " +
      "enquanto durar este problema.";
    const r = this.notice("Swap Plus: o cofre não está gravando — NÃO reinicie o servidor", text);
    if (!r || r.ok || r.skipped) {
      inc.notified = true;
      if (r && r.ok) this.saveNoticeAt = t;
    }
  }

  async saveQuiet() {
    try {
      await this.save();
    } catch {}
  }

  pushHistory(kind, text, deviceId = null) {
    const st = this.st;
    const dev = deviceId ? this.device(deviceId) : null;
    const entry = { ts: this.iso(), kind: String(kind), text: String(text), device: deviceId || null };
    if (dev) entry.deviceName = dev.name || null;
    st.history.unshift(entry);
    if (st.history.length > HISTORY_MAX) st.history.length = HISTORY_MAX;
    this.dirty = true;
    this.log.info(`[histórico] ${entry.kind}${dev ? ` (${dev.name})` : ""}: ${entry.text}`);
    return entry;
  }

  /** Aviso repetitivo (ex.: "sem folga"): no máximo 1x/h por dispositivo, ou quando muda. */
  noteOnce(dev, key, kind, text) {
    const t = this.now();
    const prev = this.notes.get(dev.id);
    if (prev && prev.key === key && t - prev.at < NOTE_REPEAT_MS) return false;
    this.notes.set(dev.id, { key, at: t });
    this.pushHistory(kind, text, dev.id);
    return true;
  }

  // ------------------------------------------------------------------ visões

  rulesEffective() {
    const own = isObj(this.st.rules) ? this.st.rules : {};
    const r = { ...RULE_DEFAULTS, ...own };
    if (!STRATEGY_LABELS[r.strategy]) r.strategy = RULE_DEFAULTS.strategy;
    if (!DEVICE_PLACEMENTS.includes(r.devicePlacement)) r.devicePlacement = RULE_DEFAULTS.devicePlacement;
    return r;
  }

  /** Regra "Computadores: Juntos" ligada (todos os ativos na mesma conta, trocando juntos)? */
  together() {
    return this.rulesEffective().devicePlacement === "together";
  }

  records() {
    const out = {};
    for (const a of this.accountList()) {
      out[String(a.number)] = {
        disabled: !!a.disabled,
        threshold: a.threshold === undefined ? null : a.threshold,
        weeklyThreshold: a.weeklyThreshold === undefined ? null : a.weeklyThreshold,
        modelThreshold: a.modelThreshold === undefined ? null : a.modelThreshold,
        priority: Number(a.priority) || 0,
        alias: a.alias || null,
      };
    }
    return out;
  }

  /**
   * records() visto por um computador: as contas que ele não pode usar entram como `disabled` (só para as escolhas
   * do motor — decide() e bestAccountFor). Nunca mandar para a extensão nem gravar: a tela mostraria "fora da
   * rotação". dev null → sem restrição.
   */
  recordsFor(dev) {
    return access.filterRecordsForDevice(this.records(), this.st, dev);
  }

  withDisabled(records, numbers) {
    const out = { ...records };
    for (const n of numbers) out[String(n)] = { ...(out[String(n)] || {}), disabled: true };
    return out;
  }

  usageStatusOf(a) {
    if (a.dead) return "relogin_required";
    if (a.usageError) return "unavailable";
    if (a.usage) return "ok";
    return "unknown";
  }

  toPublic(a, t, names, active) {
    const status = this.usageStatusOf(a);
    const age = (x) => (Number(x) > 0 ? Math.max(0, Math.round((t - Number(x)) / 100) / 10) : null);
    return {
      number: a.number,
      email: a.email,
      organizationName: a.orgName || "",
      organizationUuid: a.orgUuid || "",
      plan: a.plan && a.plan.label ? { label: a.plan.label } : null,
      alias: a.alias || null,
      active: a.number === active,
      disabled: !!a.disabled,
      usageStatus: status,
      usage: status === "ok" ? a.usage : null,
      usageAgeSeconds: status === "ok" ? age(a.usageFetchedAt) : null,
      lastGoodUsage: a.lastGoodUsage || null,
      lastGoodAgeSeconds: a.lastGoodUsage ? age(a.lastGoodAt) : null,
      dead: !!a.dead,
      loginExpiresAt: isoOrNull(this.loginExpiry(a)), // fim do login (só /login novo resolve); null = desconhecido
      accessExpiresAt: isoOrNull(a.cred && a.cred.expiresAt), // vencimento do access token atual (o servidor renova)
      assignedDevices: names.get(a.number) || [],
    };
  }

  /** Quando o login da conta acaba de vez (epoch ms), ou null se não se sabe. */
  loginExpiry(a) {
    return a && isObj(a.cred) ? epochMs(a.cred.refreshTokenExpiresAt) : null;
  }

  /** "apelido" ou o começo do e-mail (antes do @), para os avisos. */
  accountLabel(a) {
    if (str(a.alias)) return str(a.alias);
    const e = str(a.email) || "";
    return e.split("@")[0] || e || "sem e-mail";
  }

  loginExpiringText(a, exp, t = this.now()) {
    return `O login da conta ${a.number} (${this.accountLabel(a)}) ${exp > t ? "vence" : "venceu"} ${fmtDayTime(exp)} — entre de novo com ela no Claude Code de qualquer computador conectado.`;
  }

  deadText(a) {
    const why = a.dead && a.dead.cause === "no_response" ? ` (${NO_RESPONSE_TEXT})` : "";
    return `O login da conta ${a.number} (${this.accountLabel(a)}) não vale mais${why} — entre de novo com ela no Claude Code de qualquer computador conectado.`;
  }

  /** Avisos de agora (calculados na hora): cofre sem gravar, contas mortas e logins que vencem em menos de 3 dias. */
  warnings(t = this.now()) {
    const out = [];
    if (this.saveFailed) out.push({ kind: "save_failed", text: SAVE_FAILED_TEXT });
    for (const a of this.accountList()) {
      if (a.dead) {
        out.push({ kind: "dead", account: a.number, text: this.deadText(a) });
        continue;
      }
      const exp = this.loginExpiry(a);
      if (exp && exp - t < LOGIN_WARN_MS) out.push({ kind: "login_expiring", account: a.number, text: this.loginExpiringText(a, exp, t) });
    }
    return out;
  }

  /** Lista no formato do `swap-plus list --json` (a extensão já lê esse formato). */
  publicList(deviceId) {
    const t = this.now();
    const dev = this.device(deviceId);
    const active = dev && dev.assigned !== null && dev.assigned !== undefined ? Number(dev.assigned) : null;
    const names = new Map();
    for (const d of this.deviceList()) {
      if (d.assigned === null || d.assigned === undefined) continue;
      const n = Number(d.assigned);
      if (!names.has(n)) names.set(n, []);
      names.get(n).push(d.name || d.id);
    }
    return { schemaVersion: 1, activeAccountNumber: active, accounts: this.accountList().map((a) => this.toPublic(a, t, names, active)) };
  }

  devicesList(currentId = null) {
    const t = this.now();
    return this.deviceList().map((d) => ({
      id: d.id,
      name: d.name || null,
      platform: d.platform || null,
      googleEmail: d.googleEmail || null, // conta Google com que conectou (null = código de pareamento)
      createdAt: d.createdAt || null,
      lastSeen: d.lastSeen || null,
      assigned: d.assigned === undefined ? null : d.assigned,
      current: d.id === currentId,
      active: this.isActive(d, t),
    }));
  }

  stateFor(deviceId) {
    const st = this.st;
    const dev = this.device(deviceId);
    const acc = dev ? this.acc(dev.assigned) : null;
    return {
      serverTime: this.now(),
      version: this.version,
      device: dev
        ? {
            id: dev.id,
            name: dev.name || null,
            assigned: dev.assigned === undefined ? null : dev.assigned,
            lastSwitchAt: Number(dev.lastSwitchAt) || 0,
            canUploadLogins: this.canUploadLogins(dev), // false = este computador usa as contas do servidor, não envia logins
          }
        : null,
      list: this.publicList(deviceId),
      records: this.records(), // global (sem o filtro por computador)
      rules: this.rulesEffective(),
      autoSwitch: st.autoSwitch !== false,
      credential:
        acc && !acc.dead && acc.cred && access.canUse(st, dev, acc.number) ? { number: acc.number, gen: acc.gen, expiresAt: acc.cred.expiresAt } : null,
      history: st.history.slice(0, HISTORY_IN_STATE),
      devices: this.devicesList(deviceId),
      diag: { ...st.diag },
      warnings: this.warnings(),
    };
  }

  /** Resumo para o admin local. */
  status() {
    const t = this.now();
    this.refill(t);
    const accs = this.accountList();
    const devs = this.deviceList();
    return {
      version: this.version,
      serverTime: t,
      accounts: accs.length,
      deadAccounts: accs.filter((a) => a.dead).map((a) => a.number),
      devices: devs.length,
      activeDevices: devs.filter((d) => this.isActive(d, t)).length,
      autoSwitch: this.st.autoSwitch !== false,
      usagePausedUntil: this.pausedUntil > t ? this.pausedUntil : null,
      usageBudget: { perHour: this.usageMaxPerHour, available: Math.max(0, Math.floor(this.bucket.tokens)) },
      diag: { ...this.st.diag },
      saveFailed: !!this.saveFailed, // true = há mudança (talvez login renovado) só na memória: não reiniciar
      // Avisos por e-mail ao dono (notify.js): ligados? e a pasta (DATA_DIR/avisos) que o host lê.
      notices: { enabled: !!this.notifyFn && this.notifyFn.enabled !== false, dir: (this.notifyFn && this.notifyFn.dir) || null },
      stopping: !!this.stopping,
      warnings: this.warnings(t),
    };
  }

  // ------------------------------------------------------------------ ciclo

  start() {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => {
      this.tick().catch(() => {});
    }, TICK_MS);
    if (typeof this.timer.unref === "function") this.timer.unref();
    this.tick().catch(() => {});
  }

  /**
   * Para o ciclo e espera o que está em andamento: o ciclo atual, toda renovação/ação sob trava
   * (de conta ou de login) e os envios de login. Daqui em diante nada começa a gastar refresh token
   * (refreshAccount → "stopping", addLogin → refresh_failed, credentialFor entrega o que tem).
   */
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const waits = [this.ticking, ...this.locks.values(), ...this.inflight].filter(Boolean);
    return Promise.allSettled(waits).then(() => undefined);
  }

  async tick() {
    if (this.stopping) return;
    if (this.ticking) return this.ticking;
    const run = this.runTick();
    this.ticking = run;
    try {
      return await run;
    } finally {
      if (this.ticking === run) this.ticking = null;
    }
  }

  async runTick() {
    try {
      if (this.dirty) {
        try {
          await this.save();
        } catch {
          return; // cofre não grava: não renova nada (perderia o login)
        }
      }
      await this.refreshStep();
      this.loginExpiryStep();
      if (!this.stopping) {
        await this.usageStep();
        await this.decisionStep();
      }
      if (this.dirty) await this.saveQuiet();
    } catch (e) {
      this.log.error(`[motor] erro no ciclo: ${e && e.message}`);
    }
  }

  // ------------------------------------------------------------------ 1) renovações

  async refreshStep() {
    for (const acc of this.accountList()) {
      if (this.stopping) break; // encerrando: não começa outra renovação
      if (acc.dead || !acc.cred || !acc.cred.refreshToken) continue;
      const t = this.now();
      if (t < (Number(acc.refreshBackoffUntil) || 0)) continue;
      // refreshRetry: a última ficou sem resposta (ou um invalid_grant espera confirmação): tenta de novo mesmo com o acesso valendo.
      const ahead = this.aheadMs(acc);
      if (!acc.refreshRetry && (Number(acc.cred.expiresAt) || 0) - t >= ahead) continue;
      await this.refreshAccount(acc.number, { minValidMs: acc.refreshRetry ? Infinity : ahead });
    }
  }

  /** Metade da vida real do access token atual (expiresAt - lastRefreshAt), ou Infinity se não dá para saber. */
  halfLife(acc) {
    const exp = Number(acc && acc.cred && acc.cred.expiresAt);
    const last = Number(acc && acc.lastRefreshAt);
    if (!Number.isFinite(exp) || !Number.isFinite(last) || last <= 0 || exp <= last) return Infinity;
    return (exp - last) / 2;
  }

  /** Antecedência da renovação: REFRESH_AHEAD_MIN, ou metade da vida do token se ela for menor (token curto não renova a cada ciclo). */
  aheadMs(acc) {
    return Math.min(this.refreshAheadMs, this.halfLife(acc));
  }

  /** Validade mínima da credencial entregue: 30 min, ou metade da vida do token se ela for menor. */
  credMinMs(acc) {
    return Math.min(CRED_MIN_VALID_MS, this.halfLife(acc));
  }

  /** Teve renovação sem resposta nos últimos 10 min? */
  recentAmbiguous(acc, t) {
    const at = Number(acc.lastAmbiguousAt) || 0;
    return at > 0 && t - at <= AMBIGUOUS_WINDOW_MS;
  }

  /**
   * Renova o login de uma conta, sob a trava dela. Grava o cofre antes de devolver ok.
   *   minValidMs     não renova se o token ainda vale isso (outro pode ter renovado enquanto esperava a trava);
   *                  padrão: a antecedência da conta (aheadMs)
   *   ifAccessToken  renovação por 401: só renova se o access token ainda for este
   *   ignoreBackoff  ignora a espera depois de falha temporária
   * Não começa (nada gasto) se o motor está parando ("stopping") ou se o cofre não grava ("save_failed").
   * → { ok: true, refreshed } | { ok: false, error }
   */
  async refreshAccount(number, { minValidMs = null, ifAccessToken = null, ignoreBackoff = false } = {}) {
    if (this.stopping) return { ok: false, error: "stopping" };
    return this.withLock(`acc:${number}`, async () => {
      if (this.stopping) return { ok: false, error: "stopping" };
      const acc = this.acc(number);
      if (!acc) return { ok: false, error: "not_found" };
      if (acc.dead) return { ok: false, error: "dead" };
      if (!acc.cred || !acc.cred.refreshToken) return { ok: false, error: "no_refresh_token" };
      const t = this.now();
      const minMs = minValidMs === null || minValidMs === undefined ? this.aheadMs(acc) : minValidMs;
      if (ifAccessToken) {
        if (acc.cred.accessToken !== ifAccessToken) return { ok: true, refreshed: false };
      } else if ((Number(acc.cred.expiresAt) || 0) - t >= minMs) {
        return { ok: true, refreshed: false };
      }
      if (!ignoreBackoff && t < (Number(acc.refreshBackoffUntil) || 0)) return { ok: false, error: "backoff" };
      // Cofre que não grava (ou trava perdida/fechado) ou motor parando: não gasta o refresh token.
      const blocked = await this.spendBlocker();
      if (blocked) return { ok: false, error: blocked };
      const oldCred = acc.cred;
      const res = await this.anthropic.refresh(oldCred);
      if (this.acc(number) !== acc || acc.cred !== oldCred) {
        // Removida (ou trocada) enquanto esperava a resposta: nada a gravar.
        this.log.warn(`[renovação] conta ${number} mudou durante a renovação; resultado descartado`);
        return { ok: false, error: "changed" };
      }
      const t2 = this.now();
      if (res.ok) {
        const cred = sanitizeAccess(keepLoginExpiry(cleanCred(res.cred), oldCred), t2);
        if (cred.refreshToken !== oldCred.refreshToken) this.addSpent(acc, oldCred.refreshToken);
        acc.cred = cred;
        acc.gen = (Number(acc.gen) || 0) + 1;
        acc.lastRefreshAt = t2;
        acc.refreshFailures = 0;
        acc.refreshBackoffUntil = 0;
        acc.lastAmbiguousAt = null;
        acc.invalidGrantAt = null;
        acc.refreshRetry = false;
        try {
          await this.save(); // ANTES de qualquer uso do token novo
        } catch {
          this.log.error(`[renovação] conta ${number} renovada mas o cofre não gravou; tento gravar de novo no próximo ciclo`);
          return { ok: false, error: "save_failed" };
        }
        this.log.info(`[renovação] conta ${number} renovada (gen ${acc.gen}, vale até ${this.iso(cred.expiresAt)})`);
        this.scheduleDiag(number, oldCred, t2);
        return { ok: true, refreshed: true };
      }
      if (isObj(res.cred) && str(res.cred.refreshToken) && res.cred.refreshToken !== oldCred.refreshToken) {
        // Falha que já trouxe um refresh token novo (ex.: 200 sem access token): o antigo foi gasto,
        // o novo é o único que vale. Grava ANTES de tudo; o acesso fica vencido (expiresAt 0) e renova de novo.
        this.addSpent(acc, oldCred.refreshToken);
        acc.cred = keepLoginExpiry(cleanCred(res.cred), oldCred);
        try {
          await this.save();
        } catch {
          this.log.error(`[renovação] conta ${number}: veio um refresh token novo sem acesso e o cofre não gravou; tento gravar de novo no próximo ciclo`);
          return { ok: false, error: "save_failed" };
        }
        this.log.warn(`[renovação] conta ${number}: resposta incompleta (refresh token novo sem acesso); guardei o refresh token novo e renovo de novo em seguida`);
      }
      if (res.error === "invalid_grant" || res.error === "no_refresh_token") {
        if (res.error === "invalid_grant" && !acc.invalidGrantAt && this.recentAmbiguous(acc, t2)) {
          // Logo depois de uma renovação sem resposta: confirma uma vez, 2 min depois, antes de dar a conta como morta.
          acc.invalidGrantAt = t2;
          acc.refreshRetry = true;
          acc.refreshBackoffUntil = t2 + CONFIRM_INVALID_GRANT_MS;
          this.dirty = true;
          this.log.warn(
            `[renovação] conta ${number}: a Anthropic recusou a renovação (invalid_grant) logo depois de uma renovação que ficou sem resposta; confirmo em ${CONFIRM_INVALID_GRANT_MS / 60000} min antes de dar o login como perdido`
          );
          await this.saveQuiet();
          return { ok: false, error: "invalid_grant_unconfirmed" };
        }
        this.markDead(acc, t2, acc.invalidGrantAt ? "no_response" : null);
        await this.saveQuiet();
        return { ok: false, error: res.error };
      }
      if (res.error === "invalid_client") {
        // Problema do client_id (sistêmico), não da conta: não marca como morta.
        acc.refreshBackoffUntil = t2 + INVALID_CLIENT_BACKOFF_MS;
        this.dirty = true;
        this.log.error(`[renovação] a Anthropic recusou o client_id ao renovar a conta ${number} (invalid_client); tento de novo em 10 min`);
        return { ok: false, error: res.error };
      }
      acc.refreshFailures = (Number(acc.refreshFailures) || 0) + 1;
      const step = REFRESH_BACKOFF_MIN[Math.min(acc.refreshFailures - 1, REFRESH_BACKOFF_MIN.length - 1)];
      let waitMs = step * 60000;
      if (res.ambiguous) {
        // Sem resposta: a Anthropic pode ter gastado o refresh token. Tenta de novo logo (mesmo com o acesso
        // valendo) para saber; um invalid_grant nos próximos 10 min é confirmado antes de matar a conta.
        acc.lastAmbiguousAt = t2;
        acc.refreshRetry = true;
        if (acc.refreshFailures === 1) waitMs = AMBIGUOUS_RETRY_MS;
      }
      acc.refreshBackoffUntil = t2 + waitMs;
      this.dirty = true;
      const why = `${res.status ? `status ${res.status}` : "rede"}${res.ambiguous ? ", sem resposta: pode ter sido gasta" : ""}`;
      const wait = waitMs < 60000 ? `${Math.round(waitMs / 1000)} s` : `${Math.round(waitMs / 60000)} min`;
      this.log.warn(`[renovação] falha temporária ao renovar a conta ${number} (${why}); tento de novo em ${wait}`);
      return { ok: false, error: "transient" };
    });
  }

  /** cause "no_response": o invalid_grant veio depois de uma renovação sem resposta (o login foi gasto lá). */
  markDead(acc, t = this.now(), cause = null) {
    if (acc.dead) return;
    acc.dead = cause ? { reason: "relogin_required", at: t, cause } : { reason: "relogin_required", at: t };
    acc.refreshRetry = false;
    acc.invalidGrantAt = null;
    this.dirty = true;
    const why = cause === "no_response" ? NO_RESPONSE_TEXT : "a Anthropic recusou a renovação";
    this.log.warn(`[renovação] conta ${acc.number}: a Anthropic recusou a renovação (invalid_grant)${cause === "no_response" ? " depois de uma renovação sem resposta" : ""}; precisa de login novo`);
    this.pushHistory("alert", `O login da conta ${acc.number} não vale mais (${why}). Entre de novo com ela no Claude Code para o servidor receber um login novo.`, null);
    this.noticeDead(acc, t); // e-mail ao dono: 1 por morte (markDead não repete numa conta já morta)
  }

  /**
   * Aviso no histórico quando faltam menos de 3 dias para o login de uma conta viva vencer de vez:
   * no máximo 1x por dia (do fuso do servidor) por conta; o dia avisado fica em `acc.loginWarnedOn`.
   * No MESMO momento vai o aviso por e-mail ao dono (notify): também 1 por conta por dia.
   * Conta sem `refreshTokenExpiresAt` (login antigo) não avisa.
   */
  loginExpiryStep(t = this.now()) {
    const today = localDay(t);
    for (const acc of this.accountList()) {
      if (acc.dead || acc.loginWarnedOn === today) continue;
      const exp = this.loginExpiry(acc);
      if (!exp || exp - t >= LOGIN_WARN_MS) continue;
      acc.loginWarnedOn = today;
      this.pushHistory("alert", this.loginExpiringText(acc, exp, t), null); // marca dirty: grava no fim do ciclo
      this.noticeLoginExpiring(acc, exp, t);
    }
  }

  /** Diagnóstico único: o access token ANTIGO continua valendo depois de renovar? */
  scheduleDiag(number, oldCred, t) {
    if (typeof this.st.diag.oldTokenValidAfterRefresh === "boolean" || this.diagPending) return;
    // Token antigo já vencido (servidor parado): o teste não diria nada.
    if (!oldCred.accessToken || (Number(oldCred.expiresAt) || 0) - t < EXPIRED_SLACK_MS) return;
    this.diagPending = { number, accessToken: oldCred.accessToken, expiresAt: Number(oldCred.expiresAt), attempts: 0 };
  }

  // ------------------------------------------------------------------ 2) uso

  refill(t = this.now()) {
    const capN = this.usageMaxPerHour;
    const el = Math.max(0, t - this.bucket.at);
    this.bucket.tokens = Math.min(capN, this.bucket.tokens + (el * capN) / 3600000);
    this.bucket.at = Math.max(this.bucket.at, t);
  }

  canSpend(t = this.now()) {
    this.refill(t);
    return this.bucket.tokens >= 1;
  }

  spend(t = this.now()) {
    this.refill(t);
    this.bucket.tokens -= 1;
  }

  pollable(acc, t) {
    if (acc.dead || !acc.cred || !acc.cred.accessToken) return false;
    if ((Number(acc.cred.expiresAt) || 0) > t + EXPIRED_SLACK_MS) return true;
    // Token vencido: só se der para renovar antes.
    return !!acc.cred.refreshToken && t >= (Number(acc.refreshBackoffUntil) || 0);
  }

  dueAt(acc, active) {
    const backoff = Number(acc.pollBackoffUntil) || 0;
    if (this.pollSoon.has(acc.number)) return backoff;
    const last = Number(acc.usageFetchedAt) || 0;
    return Math.max(backoff, last ? last + (active ? POLL_ACTIVE_MS : POLL_IDLE_MS) : 0);
  }

  activeAccountNumbers(t = this.now()) {
    const s = new Set();
    for (const d of this.deviceList()) if (d.assigned !== null && d.assigned !== undefined && this.isActive(d, t)) s.add(Number(d.assigned));
    return s;
  }

  async usageStep() {
    const t = this.now();
    if (t < this.pausedUntil) return;
    if (this.diagPending && (await this.runDiag())) return;
    const active = this.activeAccountNumbers(t);
    const due = [];
    for (const acc of this.accountList()) {
      if (!this.pollable(acc, t)) continue;
      const at = this.dueAt(acc, active.has(acc.number));
      if (at <= t) due.push({ acc, at });
    }
    if (!due.length || !this.canSpend(t)) return;
    due.sort((x, y) => x.at - y.at || x.acc.number - y.acc.number); // a mais atrasada primeiro
    await this.pollAccount(due[0].acc.number);
  }

  applyUsage(acc, usage, t) {
    acc.usage = usage;
    acc.usageFetchedAt = t;
    acc.usageError = null;
    acc.lastGoodUsage = usage;
    acc.lastGoodAt = t;
    acc.pollFailures = 0;
    acc.pollBackoffUntil = 0;
    acc.nextPollAt = this.dueAt(acc, this.activeAccountNumbers(t).has(acc.number));
    this.dirty = true;
  }

  pauseUsage(retryAfterSec, t = this.now()) {
    const ms = Math.max(PAUSE_429_MIN_MS, (Number(retryAfterSec) || 0) * 1000);
    this.pausedUntil = t + ms;
    this.log.warn(`[uso] a Anthropic pediu para esperar (429); consultas de uso pausadas por ${Math.round(ms / 60000)} min`);
  }

  /** Lê o uso de uma conta (gasta 1 do orçamento; 2 se precisar renovar depois de 401). */
  async pollAccount(number) {
    let acc = this.acc(number);
    if (!acc || acc.dead) return;
    this.pollSoon.delete(acc.number);
    // Token vencido mesmo assim (servidor parado): renova antes de usar.
    if ((Number(acc.cred.expiresAt) || 0) <= this.now() + EXPIRED_SLACK_MS) {
      const rr = await this.refreshAccount(number, { minValidMs: EXPIRED_SLACK_MS });
      acc = this.acc(number);
      if (!rr.ok || !acc || acc.dead) return;
    }
    this.spend();
    let token = acc.cred.accessToken;
    let res = await this.anthropic.usage(token);
    if (!res.ok && res.error === "unauthorized") {
      // 401: renova e tenta de novo uma vez — só se o token já tem mais de 15 min (um 401 com token
      // recém-renovado não se resolve renovando de novo, e cada renovação gasta um refresh token) e
      // respeitando a espera de renovação.
      const age = this.now() - (Number(acc.lastRefreshAt) || 0);
      if (age > UNAUTHORIZED_MIN_AGE_MS) {
        const rr = await this.refreshAccount(number, { ifAccessToken: token });
        acc = this.acc(number);
        if (!acc || acc.dead) return;
        if (rr.ok && acc.cred.accessToken !== token) {
          this.spend();
          token = acc.cred.accessToken;
          res = await this.anthropic.usage(token);
        }
      } else {
        this.log.warn(`[uso] a Anthropic recusou o acesso da conta ${number} (401) com um token renovado há ${Math.max(0, Math.round(age / 60000))} min; não renovo de novo por isso`);
      }
    }
    acc = this.acc(number);
    if (!acc || acc.dead) return;
    const t = this.now();
    if (res.ok) {
      this.applyUsage(acc, res.usage, t);
      return;
    }
    if (res.error === "rate_limited") {
      this.pauseUsage(res.retryAfterSec, t);
      return;
    }
    acc.pollFailures = (Number(acc.pollFailures) || 0) + 1;
    const step = POLL_BACKOFF_MIN[Math.min(acc.pollFailures - 1, POLL_BACKOFF_MIN.length - 1)];
    acc.pollBackoffUntil = t + step * 60000;
    acc.nextPollAt = acc.pollBackoffUntil;
    acc.usage = null;
    acc.usageError = res.error || "transient";
    this.dirty = true;
    this.log.warn(`[uso] falha ao ler o uso da conta ${number} (${acc.usageError}${res.status ? `, status ${res.status}` : ""}); tento de novo em ${step} min`);
  }

  /** Roda o diagnóstico pendente. true = usou (ou guardou) a vez da leitura deste ciclo. */
  async runDiag() {
    const p = this.diagPending;
    const t = this.now();
    if (!p || typeof this.st.diag.oldTokenValidAfterRefresh === "boolean" || p.expiresAt <= t + EXPIRED_SLACK_MS / 2) {
      this.diagPending = null;
      return false;
    }
    if (!this.canSpend(t)) return true;
    this.spend(t);
    p.attempts += 1;
    const res = await this.anthropic.usage(p.accessToken);
    const t2 = this.now();
    if (res.ok || res.error === "unauthorized") {
      const valid = !!res.ok;
      this.st.diag = { ...this.st.diag, oldTokenValidAfterRefresh: valid, checkedAt: t2 };
      this.diagPending = null;
      this.dirty = true;
      this.log.info(`[diagnóstico] acesso antigo continua valendo depois de renovar: ${valid ? "sim" : "não"}`);
      // A leitura é da mesma conta: aproveita como leitura de uso.
      const acc = this.acc(p.number);
      if (res.ok && acc && !acc.dead) this.applyUsage(acc, res.usage, t2);
      await this.saveQuiet();
    } else if (res.error === "rate_limited") {
      this.pauseUsage(res.retryAfterSec, t2);
    } else if (p.attempts >= DIAG_MAX_ATTEMPTS) {
      this.diagPending = null;
      this.log.warn("[diagnóstico] não deu para testar o acesso antigo; fica para a próxima renovação");
    }
    return true;
  }

  // ------------------------------------------------------------------ 3) decisões

  async decisionStep() {
    if (this.decideAll()) await this.saveQuiet();
  }

  /** Decide a conta de todos os dispositivos ativos (síncrono). true = mudou algo. */
  decideAll(t = this.now()) {
    // "Juntos": uma decisão para o grupo inteiro.
    if (this.together()) return this.togetherStep(t);
    let changed = false;
    for (const dev of this.deviceList()) {
      if (!this.isActive(dev, t)) continue;
      if (this.decideDevice(dev)) changed = true;
    }
    return changed;
  }

  /** Motivo para (re)atribuir a conta do dispositivo, ou null. */
  needsAssign(dev) {
    if (dev.assigned === null || dev.assigned === undefined) return "none";
    const cur = this.acc(dev.assigned);
    if (!cur) return "removed";
    if (cur.dead) return "dead";
    // Permissão (não preferência): vale com a troca automática ligada ou desligada.
    if (!access.canUse(this.st, dev, cur.number)) return "not_allowed";
    if (cur.disabled && this.st.autoSwitch !== false) return "disabled";
    return null;
  }

  /**
   * Decide a conta de um dispositivo (síncrono: lê e muda o estado sem esperar nada). true = mudou algo.
   * Modo "together": decide o grupo inteiro (togetherStep), não só este dispositivo.
   */
  decideDevice(dev) {
    if (this.together()) return this.togetherStep();
    const why = this.needsAssign(dev);
    if (why) return this.assignBest(dev, why);
    if (this.st.autoSwitch === false) return false;
    const t = this.now();
    const others = this.othersAccounts(dev.id, t);
    const base = this.recordsFor(dev); // contas não liberadas para este computador nunca são destino
    const args = { list: this.publicList(dev.id), r: this.rulesEffective(), modelIds: dev.models || [], now: t, lastSwitchAt: Number(dev.lastSwitchAt) || 0 };
    // Contas de outros dispositivos ativos ficam de fora (não dividir a sessão de 5h)...
    let d = decide({ ...args, records: this.withDisabled(base, others) });
    // ...a não ser que não haja outra saída: dividir é melhor que parar (ainda só entre as liberadas).
    if (d.kind === "blocked" && others.size) d = decide({ ...args, records: base });
    if (d.action === "switch") {
      this.applySwitch(dev, d.to, "auto", "switch", `Trocou ${d.text}`);
      return true;
    }
    if (d.kind === "blocked") return this.noteOnce(dev, `blocked:${dev.assigned}`, "blocked", cap(d.text));
    return this.spreadOut(dev, others, args.r, t);
  }

  /**
   * Dois dispositivos ativos na mesma conta e há outra livre (abaixo das linhas): quem
   * chegou por último por troca automática sai. Quem escolheu a conta à mão fica.
   */
  spreadOut(dev, others, r, t) {
    const from = Number(dev.assigned);
    if (!others.has(from) || dev.lastSwitchBy === "manual") return false;
    const mine = Number(dev.lastSwitchAt) || 0;
    if (mine && t - mine < r.cooldownMin * 60000) return false;
    const sharing = [];
    for (const o of this.deviceList()) {
      if (o.id === dev.id || Number(o.assigned) !== from || !this.isActive(o, t)) continue;
      sharing.push(o.name || o.id);
      if (o.lastSwitchBy === "manual") continue; // o outro escolheu à mão: eu saio
      const theirs = Number(o.lastSwitchAt) || 0;
      if (theirs > mine || (theirs === mine && String(o.id) > String(dev.id))) return false; // o outro chegou depois: ele sai
    }
    const to = this.bestAccountFor(dev, { freeOnly: true, requireOk: true });
    if (to === null || to === from) return false;
    this.applySwitch(dev, to, "auto", "switch", `Trocou da conta ${from} para a conta ${to}: a conta ${from} já está em uso em ${sharing.join(", ")}`);
    return true;
  }

  // ------------------------------------------------------------------ modo "together" (computadores juntos)

  /** records() com `disabled` nas contas que algum destes computadores não pode usar. */
  sharedRecords(devs) {
    return devs.reduce((recs, d) => access.filterRecordsForDevice(recs, this.st, d), this.records());
  }

  /** publicList com a conta `n` como a ativa (para o decide() do grupo). */
  listWithActive(n) {
    return { ...this.publicList(null), activeAccountNumber: n };
  }

  /**
   * Conta do grupo entre os dispositivos `active`: a do que trocou por último (troca automática, por limite, à mão
   * ou entrando no grupo — GROUP_LEADER_BY; a atribuição "assign" não conta), se ainda serve para ele (existe, viva,
   * liberada para ele e, com a troca automática ligada, na rotação); empate: a conta com mais ativos nela. Senão a
   * melhor conta (bestAccountFor, mesma estratégia), primeiro entre as que todos os ativos podem usar.
   * Se a conta passou de uma linha, quem decide é o groupDecide (troca o grupo inteiro de uma vez).
   * → { account, leader } | null (nenhuma conta para ninguém)
   */
  groupAccount(active, t = this.now()) {
    if (!active.length) return null;
    const onIt = new Map();
    for (const d of active) {
      if (d.assigned === null || d.assigned === undefined) continue;
      onIt.set(Number(d.assigned), (onIt.get(Number(d.assigned)) || 0) + 1);
    }
    const cands = active
      .map((d, i) => ({ d, i }))
      .filter(({ d }) => d.assigned !== null && d.assigned !== undefined && GROUP_LEADER_BY.has(d.lastSwitchBy))
      .sort(
        (x, y) =>
          (Number(y.d.lastSwitchAt) || 0) - (Number(x.d.lastSwitchAt) || 0) ||
          (onIt.get(Number(y.d.assigned)) || 0) - (onIt.get(Number(x.d.assigned)) || 0) ||
          x.i - y.i
      );
    for (const { d } of cands) if (!this.needsAssign(d)) return { account: Number(d.assigned), leader: d };
    let n = this.bestAccountFor(null, { records: this.sharedRecords(active) });
    if (n !== null) return { account: n, leader: active.find((d) => access.canUse(this.st, d, n)) || active[0] };
    for (const d of active) {
      n = this.bestAccountFor(d);
      if (n !== null) return { account: n, leader: d };
    }
    return null;
  }

  /**
   * decide() para a conta do grupo: modelos em uso de TODOS os computadores do grupo (união), intervalo mínimo
   * contado da última troca de qualquer um deles, destino entre as contas que todos eles podem usar. Sem destino
   * assim (blocked), tenta entre as liberadas para o `leader` (dividir o grupo é melhor que parar).
   */
  groupDecide(account, team, leader, t = this.now(), limitHit = null) {
    const devs = team.length ? team : [leader];
    const modelIds = [...new Set(devs.flatMap((d) => (Array.isArray(d.models) ? d.models : [])))];
    const lastSwitchAt = Math.max(0, ...devs.map((d) => Number(d.lastSwitchAt) || 0));
    const args = { list: this.listWithActive(account), r: this.rulesEffective(), modelIds, now: t, lastSwitchAt, limitHit };
    let d = decide({ ...args, records: this.sharedRecords(devs) });
    if (d.kind === "blocked" && devs.length > 1) d = decide({ ...args, records: this.recordsFor(leader) });
    return d;
  }

  /**
   * Leva os computadores `devs` para a conta `to` (quem já está nela fica). Um só trocando: o texto de sempre
   * ("Trocou [na hora] da conta X para a conta Y: motivo", no histórico dele); dois ou mais: um registro
   * "Computadores trocados juntos [na hora] para a conta Y: motivo — A e B". → o texto, ou null se ninguém trocou.
   */
  moveGroup(devs, to, by, reason, { now = false, deviceId = null } = {}) {
    const moving = devs.filter((d) => Number(d.assigned) !== to);
    if (!moving.length) return null;
    const hora = now ? " na hora" : "";
    if (moving.length === 1) {
      const d = moving[0];
      const from = d.assigned === null || d.assigned === undefined ? null : Number(d.assigned);
      const text = from === null ? `Conta ${to} atribuída a ${devName(d)}: ${reason}` : `Trocou${hora} da conta ${from} para a conta ${to}: ${reason}`;
      this.applySwitch(d, to, by, "switch", text);
      return text;
    }
    for (const d of moving) this.moveDevice(d, to, by);
    const text = `Computadores trocados juntos${hora} para a conta ${to}: ${reason} — ${joinNames(moving.map(devName))}`;
    this.pushHistory("switch", text, deviceId);
    return text;
  }

  /**
   * Modo "together" (síncrono; true = mudou algo). Entre os dispositivos ativos:
   *   1) conta do grupo = groupAccount;
   *   2) com a troca automática ligada, decide() para ela (groupDecide); se trocar, todos os que podem usar a conta
   *      nova vão juntos para ela;
   *   3) senão, quem pode usar a conta do grupo e está em outra entra nela (com a troca automática desligada, só
   *      quem precisa de conta: sem conta, conta morta/removida/não liberada);
   *   4) quem não pode usar a conta do grupo segue sozinho (decideSolo): a melhor conta liberada para ele.
   */
  togetherStep(t = this.now()) {
    const active = this.deviceList().filter((d) => this.isActive(d, t));
    if (!active.length) return false;
    const auto = this.st.autoSwitch !== false;
    const g = this.groupAccount(active, t);
    let changed = false;
    let target = g ? g.account : null;
    let reason = null;
    if (g && auto) {
      const team = active.filter((d) => access.canUse(this.st, d, g.account));
      const d = this.groupDecide(g.account, team, g.leader, t);
      if (d.action === "switch") {
        target = d.to;
        reason = d.reason;
      } else if (d.kind === "blocked" && this.noteOnce(g.leader, `blocked:${g.account}`, "blocked", cap(d.text))) {
        changed = true;
      }
    }
    if (target !== null) {
      const group = active.filter((d) => access.canUse(this.st, d, target));
      if (reason !== null) {
        if (this.moveGroup(group, target, "auto", reason)) changed = true;
      } else {
        for (const d of group) {
          const from = d.assigned === null || d.assigned === undefined ? null : Number(d.assigned);
          if (from === target) continue;
          const why = this.needsAssign(d);
          if (!why && !auto) continue; // troca automática desligada: só quem precisa de conta
          if (from === null) this.applySwitch(d, target, "group", "info", `Conta ${target} atribuída a ${devName(d)}`);
          else this.applySwitch(d, target, "group", "switch", `Trocou da conta ${from} para a conta ${target}: ${why ? this.assignReason(why, from) : TOGETHER_TEXT}`);
          changed = true;
        }
      }
    }
    for (const d of active) {
      if (target !== null && access.canUse(this.st, d, target)) continue;
      if (this.decideSolo(d)) changed = true;
    }
    return changed;
  }

  /**
   * Modo "together", computador que não pode usar a conta do grupo: segue sozinho, como no modo "separate" mas sem
   * contas ocupadas — a melhor conta liberada para ele, trocando quando ela chega numa linha.
   */
  decideSolo(dev) {
    const why = this.needsAssign(dev);
    if (why) return this.assignBest(dev, why);
    if (this.st.autoSwitch === false) return false;
    const t = this.now();
    const d = decide({
      list: this.publicList(dev.id),
      records: this.recordsFor(dev),
      r: this.rulesEffective(),
      modelIds: dev.models || [],
      now: t,
      lastSwitchAt: Number(dev.lastSwitchAt) || 0,
    });
    if (d.action === "switch") {
      this.applySwitch(dev, d.to, "auto", "switch", `Trocou ${d.text}`);
      return true;
    }
    if (d.kind === "blocked") return this.noteOnce(dev, `blocked:${dev.assigned}`, "blocked", cap(d.text));
    return false;
  }

  /**
   * Modo "together": para onde vai um computador que precisa de conta — a do grupo (dos outros ativos), se ele puder
   * usá-la; senão a melhor liberada para ele (sozinho, ele começa o grupo). → { to, group }
   */
  placeFor(dev, t = this.now()) {
    const others = this.deviceList().filter((d) => d.id !== dev.id && this.isActive(d, t));
    const g = others.length ? this.groupAccount(others, t) : null;
    if (g && access.canUse(this.st, dev, g.account)) return { to: g.account, group: true };
    return { to: this.bestAccountFor(dev), group: !others.length };
  }

  /** Muda a conta do dispositivo (sem histórico). */
  moveDevice(dev, to, by) {
    dev.assigned = Number(to);
    dev.lastSwitchAt = this.now();
    dev.lastSwitchBy = by;
    this.notes.delete(dev.id);
  }

  applySwitch(dev, to, by, kind, text) {
    this.moveDevice(dev, to, by);
    this.pushHistory(kind, text, dev.id);
  }

  /** Texto do motivo de needsAssign (para o histórico). */
  assignReason(why, from) {
    return {
      dead: `o login da conta ${from} não vale mais`,
      disabled: `a conta ${from} foi desativada`,
      removed: `a conta ${from} foi removida`,
      not_allowed: notAllowedText(from),
    }[why];
  }

  assignBest(dev, why) {
    const from = dev.assigned === null || dev.assigned === undefined ? null : Number(dev.assigned);
    // "Juntos": a conta do grupo, se este computador puder usá-la; senão a melhor liberada para ele.
    const place = this.together() ? this.placeFor(dev) : { to: this.bestAccountFor(dev), group: false };
    const to = place.to;
    const by = place.group ? "group" : "assign";
    const reason = this.assignReason(why, from);
    if (to === null) {
      // Sem outra conta: o computador sai da conta que não existe mais ou que não está liberada para ele
      // (nunca fica numa conta não permitida, nem morta e não permitida).
      if (why === "removed" || why === "not_allowed" || (from !== null && !access.canUse(this.st, dev, from))) {
        dev.assigned = null;
        this.notes.delete(dev.id);
        this.pushHistory("alert", `Nenhuma conta disponível para ${dev.name || dev.id} (${reason})`, dev.id);
        return true;
      }
      if (from === null) return false;
      return this.noteOnce(dev, `noaccount:${from}:${why}`, "alert", `Nenhuma outra conta disponível para ${dev.name || dev.id} (${reason})`);
    }
    if (to === from) return false;
    if (from === null) {
      this.applySwitch(dev, to, by, "info", `Conta ${to} atribuída a ${dev.name || dev.id}`);
      return true;
    }
    this.applySwitch(dev, to, by, "switch", `Trocou da conta ${from} para a conta ${to}: ${reason}`);
    return true;
  }

  /**
   * Melhor conta para o dispositivo: vivas, não desativadas, de preferência com uso conhecido
   * e livres (não usadas por outro dispositivo ativo).
   *   - max: a que zera o semanal primeiro, com ≥ 20% sobrando e abaixo das linhas (com margem)
   *   - senão a de mais folga (min(linha - pct) entre sessão e semanal); priority: prioridade antes
   *   - sem uso conhecido: a viva de menor número
   *   - ninguém livre: vale conta de outro dispositivo
   * freeOnly: só livres. requireOk: só abaixo das linhas (com margem) e com uso conhecido.
   * Só contas liberadas para o computador (recordsFor); dev null = sem restrição.
   * records: records já filtrados (ex.: só as contas que todos os computadores do grupo podem usar), no lugar de recordsFor(dev).
   * Modo "together": nenhuma conta está ocupada (os computadores dividem a conta de propósito).
   */
  bestAccountFor(dev, { freeOnly = false, requireOk = false, records = null } = {}) {
    const t = this.now();
    const r = this.rulesEffective();
    const pref = str(r.preferModel) || null; // modelo preferido (Fable): contas com ele vêm primeiro
    const recs = records || this.recordsFor(dev);
    const others = r.devicePlacement === "together" ? new Set() : this.othersAccounts(dev ? dev.id : null, t);
    const list = this.publicList(dev ? dev.id : null);
    const live = list.accounts.filter((p) => !p.dead && !(recs[String(p.number)] || {}).disabled);

    const score = (pool) => {
      const known = [];
      const unknown = [];
      for (const p of pool) {
        const w = windows(p);
        if (!w) {
          unknown.push(p.number);
          continue;
        }
        const l = linesFor(p, r, recs);
        const rows = [{ pct: Number(w.session.pct) || 0, line: l.session }];
        if (w.weekly) rows.push({ pct: Number(w.weekly.pct) || 0, line: l.weekly });
        const reset = w.weekly && w.weekly.resetsAt ? Date.parse(w.weekly.resetsAt) : NaN;
        const ps = pref ? w.models.find((m) => m.name === pref) : null;
        known.push({
          n: p.number,
          prefOk: !!ps && Number(ps.pct) <= l.model - r.marginPct,
          ok: rows.every((x) => x.pct <= x.line - r.marginPct),
          headroom: Math.min(...rows.map((x) => x.line - x.pct)),
          resetTs: Number.isFinite(reset) ? reset : Infinity,
          unused: w.weekly ? 100 - (Number(w.weekly.pct) || 0) : 100,
          priority: Number((recs[String(p.number)] || {}).priority) || 0,
        });
      }
      unknown.sort((a, b) => a - b);
      return { known, unknown };
    };
    const byStrategy =
      r.strategy === "priority"
        ? (a, b) => b.priority - a.priority || b.headroom - a.headroom || a.n - b.n
        : (a, b) => b.headroom - a.headroom || a.n - b.n;
    const order = (a, b) => Number(b.prefOk) - Number(a.prefOk) || byStrategy(a, b);
    const pickOk = (pool) => {
      const all = score(pool).known.filter((k) => k.ok);
      if (!all.length) return null;
      // Com o modelo preferido: só entre as que têm ele, se houver alguma (mesma ideia do decide()).
      const withPref = all.filter((k) => k.prefOk);
      const ok = withPref.length ? withPref : all;
      if (r.strategy === "max") {
        const soon = ok
          .filter((k) => k.unused >= 20 && k.resetTs !== Infinity && k.resetTs > t)
          .sort((a, b) => a.resetTs - b.resetTs || b.headroom - a.headroom || a.n - b.n);
        if (soon.length) return soon[0].n;
      }
      return ok.sort(order)[0].n;
    };
    const pickUnknown = (pool) => {
      const u = score(pool).unknown;
      return u.length ? u[0] : null;
    };
    const pickAny = (pool) => {
      const s = score(pool);
      if (s.known.length) return s.known.sort(order)[0].n;
      return s.unknown.length ? s.unknown[0] : null;
    };

    const free = live.filter((p) => !others.has(p.number));
    let pick = pickOk(free);
    if (pick !== null || requireOk) return pick;
    pick = pickUnknown(free);
    if (pick !== null) return pick;
    if (!freeOnly) {
      pick = pickOk(live); // dividir uma conta com folga é melhor que pegar uma estourada
      if (pick !== null) return pick;
    }
    pick = pickAny(free);
    if (pick !== null || freeOnly) return pick;
    return pickAny(live);
  }

  // ------------------------------------------------------------------ dispositivos

  async heartbeat(deviceId, { models, live } = {}) {
    const dev = this.needDevice(deviceId);
    const t = this.now();
    const returning = !this.isActive(dev, t);
    dev.lastSeen = t;
    dev.models = cleanModels(models);
    dev.live = cleanLive(live, t);
    this.dirty = true; // lastSeen/modelos vão para o cofre no próximo ciclo
    // "Juntos": quem conecta ou volta a ficar ativo entra na conta do grupo (a dos outros ativos), em vez de puxar o
    // grupo para a conta dele (uma troca antiga dele não define mais a conta do grupo).
    if (returning && this.together() && GROUP_LEADER_BY.has(dev.lastSwitchBy) && this.deviceList().some((d) => d.id !== dev.id && this.isActive(d, t))) {
      dev.lastSwitchBy = "follow";
    }
    if (this.decideDevice(dev)) await this.saveQuiet();
    return this.stateFor(deviceId);
  }

  credentialPayload(acc) {
    const c = acc.cred;
    // Montado campo a campo: o refreshToken nunca sai do servidor.
    const claudeAiOauth = {
      accessToken: c.accessToken,
      expiresAt: c.expiresAt,
      scopes: Array.isArray(c.scopes) ? [...c.scopes] : [],
      subscriptionType: c.subscriptionType === undefined ? null : c.subscriptionType,
      rateLimitTier: c.rateLimitTier === undefined ? null : c.rateLimitTier,
    };
    // Não é segredo: o Claude Code usa para avisar "sign-in ends". Desconhecido → fica de fora (nunca null/0).
    const loginExp = this.loginExpiry(acc);
    if (loginExp) claudeAiOauth.refreshTokenExpiresAt = loginExp;
    return {
      number: acc.number,
      gen: acc.gen,
      claudeAiOauth,
      oauthAccount: isObj(acc.oauthAccount) ? { ...acc.oauthAccount } : null,
    };
  }

  /**
   * Credencial da conta do dispositivo, valendo pelo menos 30 min (ou metade da vida do token, se for curto);
   * renova se preciso. Sem refreshToken. Parando (stop()): não renova; entrega a atual se ainda vale mais de 1 min.
   * Nunca entrega o acesso de uma conta não liberada para o computador (conferido de novo depois de cada espera:
   * a regra pode mudar no meio).
   */
  async credentialFor(deviceId) {
    this.needDevice(deviceId);
    for (let attempt = 0; attempt < 3; attempt++) {
      const dev = this.device(deviceId);
      if (!dev) return null; // revogado no meio
      const why = this.needsAssign(dev);
      if (why && this.assignBest(dev, why)) {
        await this.saveQuiet();
        if (this.device(deviceId) !== dev) continue; // revogado enquanto gravava: na volta devolve null
      }
      const acc = this.acc(dev.assigned);
      if (!acc || acc.dead || !acc.cred || !acc.cred.accessToken || !access.canUse(this.st, dev, acc.number)) return null;
      const minMs = this.credMinMs(acc);
      const left = (Number(acc.cred.expiresAt) || 0) - this.now();
      if (left >= minMs) return this.credentialPayload(acc);
      // Encerrando: não renova (o token novo poderia não chegar ao disco); entrega o atual se ainda vale.
      if (this.stopping) return left > EXPIRED_SLACK_MS ? this.credentialPayload(acc) : null;
      const rr = await this.refreshAccount(acc.number, { minValidMs: minMs });
      if (!rr.ok && rr.error === "save_failed") return null; // token novo ainda não está no cofre: não entrega
      const d2 = this.device(deviceId);
      const cur = d2 ? this.acc(d2.assigned) : null;
      // Morreu, foi removida, o dispositivo trocou ou a conta deixou de estar liberada para ele: de novo
      // (na volta o needsAssign → "not_allowed" troca a conta).
      if (!cur || cur.dead || cur !== acc || !access.canUse(this.st, d2, cur.number)) continue;
      if (rr.ok) return this.credentialPayload(cur);
      // Renovação falhou agora (temporário): entrega o que tem se ainda vale.
      if ((Number(cur.cred.expiresAt) || 0) > this.now() + EXPIRED_SLACK_MS) return this.credentialPayload(cur);
      return null;
    }
    return null;
  }

  /**
   * Troca a conta do dispositivo. number null = melhor conta (só entre as liberadas para ele).
   * Modo "together": troca o grupo inteiro (os ativos + este); quem não pode usar a conta fica onde está.
   * Erros (.code): not_found, dead_account, not_allowed (a conta não está liberada para este computador).
   * → { switched, from, to, text }
   */
  async switchDevice(deviceId, number, by = "manual") {
    const dev = this.needDevice(deviceId);
    const from = dev.assigned === null || dev.assigned === undefined ? null : Number(dev.assigned);
    let to;
    if (number === null || number === undefined) {
      to = this.bestAccountFor(dev);
      if (to === null) return { switched: false, from, to: null, text: "nenhuma conta disponível" };
    } else {
      const n = Number(number);
      const acc = Number.isInteger(n) ? this.acc(n) : null;
      if (!acc) throw fail("not_found", `a conta ${number} não existe`);
      if (acc.dead) throw fail("dead_account", `o login da conta ${n} não vale mais; entre de novo com ela no Claude Code para o servidor receber um login novo`);
      if (!access.canUse(this.st, dev, n)) {
        throw fail("not_allowed", `${notAllowedText(n)} ("${dev.name || dev.id}"); libere no painel em Contas → Computadores permitidos`);
      }
      to = n;
    }
    const best = number === null || number === undefined ? " (melhor conta)" : "";
    const kind = by === "manual" ? "manual" : "switch";
    if (this.together()) {
      const t = this.now();
      const moving = this.deviceList().filter(
        (d) => (d.id === dev.id || this.isActive(d, t)) && Number(d.assigned) !== to && access.canUse(this.st, d, to)
      );
      if (moving.length && !(moving.length === 1 && moving[0] === dev)) {
        const who = by === "painel" ? "pelo painel" : `pelo computador ${devName(dev)}`;
        const text = `Computadores trocados juntos para a conta ${to}: troca manual ${who}${best} — ${joinNames(moving.map(devName))}`;
        // Quem pediu fica como "manual"/"painel"; os outros foram junto ("group").
        for (const d of moving) this.moveDevice(d, to, d === dev ? by : "group");
        this.pushHistory(kind, text, dev.id);
        await this.saveQuiet();
        return { switched: true, from, to, text };
      }
      // Só este computador troca (os outros já estão na conta ou não podem usá-la): como no modo "separate".
    }
    if (to === from) return { switched: false, from, to, text: `já está na conta ${to}` };
    const text = from === null ? `Troca manual para a conta ${to}${best}` : `Troca manual da conta ${from} para a conta ${to}${best}`;
    this.applySwitch(dev, to, by, kind, text);
    await this.saveQuiet();
    return { switched: true, from, to, text };
  }

  /**
   * O Claude Code do dispositivo registrou "You've hit your limit". → { switched, text }
   * Modo "together": troca na hora todos os ativos que estão na mesma conta (o grupo).
   */
  async limitHit(deviceId, label) {
    const dev = this.needDevice(deviceId);
    const lbl = str(label) ? str(label).slice(0, 80) : "limite de uso";
    const t = this.now();
    dev.lastSeen = t;
    const acc = this.acc(dev.assigned);
    if (!acc) return { switched: false, text: "nenhuma conta atribuída a este dispositivo" };
    this.pollSoon.add(acc.number); // reler o uso dela logo, para não voltar para ela por dado velho
    if (!access.canUse(this.st, dev, acc.number)) {
      // A conta atual não está (mais) liberada para este computador: sai dela já, com a troca automática
      // ligada ou desligada (é permissão), e só para uma liberada (ou para nenhuma).
      const from = acc.number;
      this.assignBest(dev, "not_allowed");
      await this.saveQuiet();
      const to = dev.assigned === null || dev.assigned === undefined ? null : Number(dev.assigned);
      if (to === null || to === from) return { switched: false, text: `Nenhuma conta disponível para ${dev.name || dev.id} (${notAllowedText(from)})` };
      return { switched: true, text: `Trocou da conta ${from} para a conta ${to}: ${notAllowedText(from)}`, to };
    }
    if (this.st.autoSwitch === false) {
      const text = `A conta ${acc.number} bateu o ${lbl}.`;
      this.pushHistory("alert", text, dev.id);
      await this.saveQuiet();
      return { switched: false, text };
    }
    if (this.together()) {
      // "Juntos": decide pela conta que bateu o limite com os ativos nela (o grupo) e troca na hora todos os ativos
      // que podem usar a conta nova (o grupo inteiro vai junto).
      const live = this.deviceList().filter((d) => d.id === dev.id || this.isActive(d, t));
      const team = live.filter((d) => Number(d.assigned) === acc.number);
      const d = this.groupDecide(acc.number, team, dev, t, lbl);
      if (d.action === "switch") {
        const text = this.moveGroup(live.filter((x) => access.canUse(this.st, x, d.to)), d.to, "limit", d.reason, { now: true, deviceId: dev.id });
        await this.saveQuiet();
        return { switched: true, text, to: d.to };
      }
      const text = cap(d.text);
      this.pushHistory("blocked", text, dev.id);
      await this.saveQuiet();
      return { switched: false, text };
    }
    const others = this.othersAccounts(dev.id, t);
    const base = this.recordsFor(dev); // só contas liberadas para este computador (também na reserva abaixo)
    const args = { list: this.publicList(dev.id), r: this.rulesEffective(), modelIds: dev.models || [], now: t, lastSwitchAt: Number(dev.lastSwitchAt) || 0, limitHit: lbl };
    let d = decide({ ...args, records: this.withDisabled(base, others) });
    if (d.kind === "blocked" && others.size) d = decide({ ...args, records: base });
    if (d.action === "switch") {
      const text = `Trocou na hora ${d.text}`;
      this.applySwitch(dev, d.to, "limit", "switch", text);
      await this.saveQuiet();
      return { switched: true, text, to: d.to };
    }
    const text = cap(d.text);
    this.pushHistory("blocked", text, dev.id);
    await this.saveQuiet();
    return { switched: false, text };
  }

  // ------------------------------------------------------------------ contas

  /** Lança identity_mismatch se o dono do token (`who`) não é o e-mail/organização do oauthAccount enviado. */
  checkIdentity(who, email, sentOrg) {
    const orgDiffers = !!(who.orgUuid && sentOrg && who.orgUuid !== sentOrg);
    if (lower(who.email) !== lower(email) || orgDiffers) {
      throw fail("identity_mismatch", `esse login é de ${who.email}${orgDiffers ? " (organização diferente)" : ""}, não de ${email}`);
    }
  }

  /**
   * Recebe um login (com refreshToken) de um dispositivo. → { number, created }
   * Só aceita login comprovadamente vivo: o refresh token recebido é SEMPRE renovado na hora,
   * antes de qualquer mudança. Um refresh token já morto (renovado em outro lugar) com o access
   * token ainda valendo não substitui mais um login bom.
   * Erros (.code), sem mudar nada: not_admin (deviceId de um computador que não pode enviar logins — canUploadLogins;
   * nem fala com a Anthropic), invalid_login, stale_login, dead_login (a Anthropic recusou a renovação),
   * refresh_failed (falha temporária, cofre sem gravar ou servidor reiniciando — nada gasto),
   * identity_mismatch (identidade errada conferida ANTES de renovar — nada gasto).
   * identity_mismatch_spent: a identidade errada só apareceu DEPOIS de renovar — o login enviado foi gasto
   * (entra na lista dos gastos; o cliente trata como login gasto).
   * Sucesso: grava o cofre com o token RENOVADO (é ele que vale daqui em diante; o enviado deixou de valer).
   * Renovação que falhou mas já trouxe um refresh token novo: também grava (o enviado foi gasto), com o acesso vencido.
   * Um envio por login de cada vez (trava pelo hash do refresh token): dois envios do mesmo login ao mesmo
   * tempo renovam uma vez só; o outro recebe "nada a fazer" ou stale_login. stop() espera o envio em andamento.
   */
  async addLogin(args = {}) {
    // Segunda trava (o server.js já recusa antes): login de computador que não é do administrador não entra.
    const from = isObj(args) ? this.device(args.deviceId) : null;
    if (from && !this.canUploadLogins(from)) throw fail("not_admin", NOT_ADMIN_TEXT);
    if (this.stopping) throw fail("refresh_failed", STOPPING_TEXT);
    return this.track(this.receiveLogin(args));
  }

  async receiveLogin({ claudeAiOauth, oauthAccount, plan, deviceId = null, number: wantNumber = null } = {}) {
    if (!isObj(claudeAiOauth) || !str(claudeAiOauth.refreshToken)) {
      throw fail("invalid_login", "o login precisa ter refreshToken (entre de novo com a conta no Claude Code)");
    }
    if (!isObj(oauthAccount) || !str(oauthAccount.emailAddress)) {
      throw fail("invalid_login", "o login precisa do oauthAccount com emailAddress");
    }
    const sent = cleanCred(claudeAiOauth);
    sent.refreshToken = sent.refreshToken.trim();
    const job = { sent, oauthAccount, plan, deviceId, wantNumber, email: str(oauthAccount.emailAddress), sentOrg: str(oauthAccount.organizationUuid) };
    return this.withLock(`login:${sha256(sent.refreshToken)}`, () => this.receiveLoginLocked(job));
  }

  /** Antes de gastar o login enviado: servidor não está parando e o cofre grava. Senão refresh_failed (nada gasto). */
  async assertCanSpendLogin() {
    const blocked = await this.spendBlocker();
    if (!blocked) return;
    if (blocked === "stopping") throw fail("refresh_failed", STOPPING_TEXT);
    this.log.warn("[login] login recusado sem renovar: o cofre não está gravando (o login enviado não foi gasto)");
    throw fail("refresh_failed", "o cofre do servidor não está gravando agora; tente de novo daqui a pouco");
  }

  async receiveLoginLocked({ sent, oauthAccount, plan, deviceId, wantNumber, email, sentOrg }) {
    // Login que o próprio servidor já renovou (refresh token gasto): guardar mataria a conta.
    // (Conferido sob a trava do login: um envio igual que chegou junto já terminou.)
    if (this.isSpent(sent.refreshToken)) {
      throw fail("stale_login", "esse login já foi renovado pelo servidor e não vale mais; o servidor já tem um mais novo");
    }
    const known = this.findAccount(email, sentOrg);
    if (known && known.cred && known.cred.refreshToken === sent.refreshToken) {
      if (known.dead) throw fail("dead_login", "esse login não vale mais (a Anthropic recusou a renovação); entre de novo com a conta no Claude Code");
      return { number: known.number, created: false }; // o mesmo login que o servidor já guarda: nada a fazer
    }
    await this.assertCanSpendLogin();

    // 1) Antes de gastar o login enviado: se o acesso dele ainda vale, confere de quem é.
    //    Identidade errada → recusa sem gastar nada (o computador continua com o login dele).
    let before = null;
    if (sent.accessToken && sent.expiresAt - this.now() > EXPIRED_SLACK_MS) {
      before = await this.anthropic.profile(sent.accessToken);
      if (before && before.email) this.checkIdentity(before, email, sentOrg);
    }
    const verified = !!(before && before.email);
    // A conferência acima pode levar até 15 s: o servidor pode ter começado a parar ou o cofre parado de gravar.
    await this.assertCanSpendLogin();

    // 2) Renova SEMPRE, na hora: é a prova de que o refresh token está vivo.
    //    Até aqui nada mudou; qualquer falha devolve erro e o login antigo da conta (se houver) fica.
    const res = await this.anthropic.refresh(sent);
    // Falha que já trouxe um refresh token novo (200 sem access token): o enviado foi gasto e o novo
    // é o único que vale — recusar agora perderia a conta. Guarda com o acesso vencido (renova no próximo ciclo).
    const issued = !res.ok && isObj(res.cred) && str(res.cred.refreshToken) && res.cred.refreshToken !== sent.refreshToken ? res.cred : null;
    if (!res.ok && !issued) {
      if (res.error === "invalid_grant" || res.error === "no_refresh_token") {
        this.log.warn("[login] login recusado: a Anthropic recusou a renovação (refresh token morto)");
        throw fail("dead_login", "esse login não vale mais (a Anthropic recusou a renovação); entre de novo com a conta no Claude Code");
      }
      if (res.ambiguous) this.log.warn("[login] a renovação do login recebido ficou sem resposta (a Anthropic pode ter gastado o login); recusei com refresh_failed");
      throw fail("refresh_failed", "não consegui renovar esse login agora; tente de novo daqui a pouco");
    }
    // A data de fim do login vem do login enviado; a renovação só a troca se trouxer uma nova.
    const cred = keepLoginExpiry(cleanCred(issued || res.cred), sent);
    if (issued) {
      cred.expiresAt = 0;
      this.log.warn("[login] renovação incompleta (refresh token novo sem acesso); guardo o login novo e renovo de novo em seguida");
    } else {
      sanitizeAccess(cred, this.now());
    }
    const consumed = cred.refreshToken !== sent.refreshToken ? sent.refreshToken : null; // o enviado, gasto aqui

    // 3) Confere a identidade do token RENOVADO (é ele que fica guardado). Daqui até gravar o login enviado
    //    já foi gasto, então cada chamada a mais alonga a janela em que um problema perderia o token novo:
    //    a identidade que veio junto da renovação, se veio; senão a conferida antes de gastar (mesmo login);
    //    só sem nenhuma das duas (e sem estar parando) pergunta o perfil do token novo.
    let who = null;
    if (res.account && res.account.email) who = res.account;
    else if (verified) who = before;
    else if (!issued && !this.stopping) who = await this.anthropic.profile(cred.accessToken);
    if (!who || !who.email) {
      // Já renovado (o login enviado foi gasto): recusar agora perderia a conta.
      this.log.warn("[login] não deu para conferir a identidade depois de renovar; aceito pelo oauthAccount enviado");
    } else {
      try {
        this.checkIdentity(who, email, sentOrg);
      } catch (e) {
        if (!consumed) {
          // A renovação não trocou o refresh token: o enviado continua valendo no computador.
          this.log.warn("[login] login recusado depois de renovar: a identidade não bate (o refresh token enviado não mudou)");
          throw e;
        }
        // O enviado foi gasto aqui e o token novo não é desta conta: lembra o gasto (nunca mais vai para a
        // Anthropic) e avisa o cliente que o login dele não vale mais.
        this.addSpentGlobal(consumed);
        this.log.warn("[login] login recusado depois de renovar: a identidade não bate (o login enviado foi gasto; entrou na lista dos gastos)");
        await this.saveQuiet();
        throw fail("identity_mismatch_spent", `${e.message}; esse login já foi renovado aqui e não vale mais — entre de novo com a conta certa no Claude Code`);
      }
    }
    const orgUuid = sentOrg || (who && who.orgUuid) || (before && before.orgUuid) || null;
    const planObj = planOf(plan, cred.subscriptionType);

    const out = await this.storeLogin({ cred, oauthAccount, email, orgUuid, planObj, consumed, wantNumber });
    this.pushHistory("info", `Login da conta ${out.number} recebido`, deviceId);
    await this.save();
    return out;
  }

  /**
   * Guarda um login que ACABOU de ser emitido pela troca do código (painel, "Adicionar conta pela assinatura":
   * claudelogin.finish). Igual ao addLogin, MAS sem renovar na hora: o token é novinho e veio da própria
   * Anthropic para o servidor (renovar só gastaria o refresh token à toa e abriria a janela de perdê-lo).
   * - Servidor parando ou cofre sem gravar → refresh_failed (nada muda; o login não foi gasto).
   * - Confere a identidade com profile(accessToken): e-mail/organização diferentes → identity_mismatch (nada
   *   muda). Perfil indisponível → aceita pela identidade que veio da troca do código (aviso no log).
   * - Um envio por login (trava pelo hash do refresh token); refresh token já gasto pelo servidor → stale_login;
   *   o mesmo login que a conta já guarda → "nada a fazer".
   * - Cria ou atualiza a conta (e-mail + organização): gen++, dead = null, esperas zeradas, o fim do login
   *   (refreshTokenExpiresAt) é o que veio com este login. Grava o cofre ANTES de devolver; histórico.
   * Erros (.code): invalid_login, stale_login, dead_login, refresh_failed, identity_mismatch. → { number, created }
   */
  async storeFreshLogin(args = {}) {
    if (this.stopping) throw fail("refresh_failed", STOPPING_TEXT);
    return this.track(this.receiveFreshLogin(args));
  }

  async receiveFreshLogin({ claudeAiOauth, oauthAccount, plan } = {}) {
    if (!isObj(claudeAiOauth) || !str(claudeAiOauth.refreshToken) || !str(claudeAiOauth.accessToken)) {
      throw fail("invalid_login", "o login precisa ter accessToken e refreshToken");
    }
    if (!isObj(oauthAccount) || !str(oauthAccount.emailAddress)) {
      throw fail("invalid_login", "o login precisa do oauthAccount com emailAddress");
    }
    const sent = cleanCred(claudeAiOauth);
    sent.refreshToken = sent.refreshToken.trim();
    const job = { sent, oauthAccount, plan, email: str(oauthAccount.emailAddress), sentOrg: str(oauthAccount.organizationUuid) };
    return this.withLock(`login:${sha256(sent.refreshToken)}`, () => this.receiveFreshLoginLocked(job));
  }

  async receiveFreshLoginLocked({ sent, oauthAccount, plan, email, sentOrg }) {
    if (this.isSpent(sent.refreshToken)) {
      throw fail("stale_login", "esse login já foi renovado pelo servidor e não vale mais; o servidor já tem um mais novo");
    }
    const known = this.findAccount(email, sentOrg);
    if (known && known.cred && known.cred.refreshToken === sent.refreshToken) {
      if (known.dead) throw fail("dead_login", "esse login não vale mais (a Anthropic recusou a renovação); entre de novo com a conta");
      return { number: known.number, created: false }; // o mesmo login que o servidor já guarda: nada a fazer
    }
    // Nada é gasto aqui, mas o login só vale depois de ir para o disco: parando ou sem gravar, recusa.
    await this.assertCanSpendLogin();

    // Identidade: o dono do access token tem de ser o e-mail/organização do oauthAccount.
    let who = null;
    if (sent.expiresAt - this.now() > EXPIRED_SLACK_MS) who = await this.anthropic.profile(sent.accessToken);
    if (who && who.email) this.checkIdentity(who, email, sentOrg);
    else this.log.warn("[login] login novo da assinatura: perfil indisponível; aceito pela identidade da troca do código");
    // A conferência pode levar até 15 s: o servidor pode ter começado a parar ou o cofre parado de gravar.
    await this.assertCanSpendLogin();

    const cred = sanitizeAccess(sent, this.now()); // sem renovar: o acesso é o da troca do código (com limites sãos)
    const orgUuid = sentOrg || (who && who.orgUuid) || null;
    const planObj = planOf(plan, cred.subscriptionType);
    const out = await this.storeLogin({ cred, oauthAccount, email, orgUuid, planObj });
    this.pollSoon.add(out.number); // lê o uso da conta logo
    this.pushHistory("info", `Login da conta ${out.number} recebido (login novo da assinatura, pelo painel)`, null);
    await this.save(); // ANTES de devolver: o login novo só existe na memória até aqui
    return out;
  }

  /**
   * Grava o login na conta (cria ou atualiza pela identidade e-mail + organização) — a parte comum do addLogin e
   * do storeFreshLogin. Conta existente: espera a renovação em andamento dela (trava da conta) antes de trocar o
   * login. Não grava o cofre (quem chama grava antes de devolver). consumed = refresh token gasto aqui (ou null).
   * → { number, created }
   */
  async storeLogin({ cred, oauthAccount, email, orgUuid, planObj, consumed = null, wantNumber = null }) {
    const commit = () => {
      const t = this.now();
      const acc = this.findAccount(email, orgUuid);
      if (acc) {
        acc.cred = cred;
        acc.oauthAccount = { ...oauthAccount };
        acc.email = email;
        acc.orgUuid = orgUuid || acc.orgUuid || null;
        acc.orgName = str(oauthAccount.organizationName) || acc.orgName || null;
        if (planObj) acc.plan = planObj;
        acc.dead = null;
        acc.gen = (Number(acc.gen) || 0) + 1;
        acc.refreshFailures = 0;
        acc.refreshBackoffUntil = 0;
        acc.pollBackoffUntil = 0;
        acc.lastRefreshAt = t;
        acc.loginWarnedOn = null; // login novo: o aviso de "vence" recomeça
        acc.lastAmbiguousAt = null; // login novo: nada pendente da família de tokens antiga
        acc.invalidGrantAt = null;
        acc.refreshRetry = false;
        if (consumed) this.addSpent(acc, consumed);
        this.pollSoon.add(acc.number);
        return { number: acc.number, created: false };
      }
      const st = this.st;
      // Número preferido (ex.: o mesmo que a conta tinha no computador que mandou), se estiver livre.
      const want = Number(wantNumber);
      const number = Number.isInteger(want) && want > 0 && want <= 999 && !st.accounts[String(want)] ? want : st.nextNumber;
      st.nextNumber = Math.max(st.nextNumber, number + 1);
      // Conta nova começa liberada para todos os computadores: uma lista que tenha sobrado de uma conta antiga
      // com o mesmo número não vale para ela (removeAccount já limpa; isto cobre cofre mexido à mão).
      access.onAccountRemoved(st, number);
      st.accounts[String(number)] = {
        number,
        email,
        orgUuid,
        orgName: str(oauthAccount.organizationName),
        plan: planObj,
        alias: null,
        oauthAccount: { ...oauthAccount },
        cred,
        gen: 1,
        dead: null,
        disabled: false,
        threshold: null,
        priority: 0,
        usage: null,
        usageFetchedAt: null,
        usageError: null,
        lastGoodUsage: null,
        lastGoodAt: null,
        nextPollAt: 0,
        pollBackoffUntil: 0,
        pollFailures: 0,
        refreshBackoffUntil: 0,
        refreshFailures: 0,
        spentRefresh: consumed ? [sha256(consumed)] : [],
        addedAt: t,
        lastRefreshAt: t,
        loginWarnedOn: null,
      };
      return { number, created: true };
    };
    const existing = this.findAccount(email, orgUuid);
    return existing ? this.withLock(`acc:${existing.number}`, async () => commit()) : commit();
  }

  /**
   * Texto do histórico das linhas próprias da conta. own = [sessão, semanal, modelo] (null = regra geral).
   * "Regras próprias da conta 2: sessão 85% · semanal 80% (geral) · modelo 95% (geral)" ou
   * "Conta 2 voltou às regras gerais".
   */
  ownLinesText(n, own) {
    if (own.every((v) => v === null)) return `Conta ${n} voltou às regras gerais`;
    const r = this.rulesEffective();
    const parts = [
      ["sessão", own[0], r.sessionPct],
      ["semanal", own[1], r.weeklyPct],
      ["modelo", own[2], r.modelPct],
    ].map(([label, v, geral]) => (v === null ? `${label} ${geral}% (geral)` : `${label} ${v}%`));
    return `Regras próprias da conta ${n}: ${parts.join(" · ")}`;
  }

  /**
   * Ajustes por conta: disabled, threshold (sessão 5h), weeklyThreshold, modelThreshold (50–100 ou null = regra
   * geral), priority, alias. → o record novo
   */
  async updateAccount(number, patch) {
    const acc = this.acc(number);
    if (!acc) throw fail("not_found", `a conta ${number} não existe`);
    if (!isObj(patch)) throw fail("invalid", "corpo inválido");
    const next = {};
    if ("disabled" in patch) {
      if (typeof patch.disabled !== "boolean") throw fail("invalid", "disabled precisa ser true ou false");
      next.disabled = patch.disabled;
    }
    // Linhas próprias da conta (sessão 5h, semanal, modelo): 50–100, ou null = a regra geral.
    for (const k of OWN_LINE_KEYS) {
      if (!(k in patch)) continue;
      const v = patch[k];
      if (v === null) next[k] = null;
      else {
        const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
        if (!Number.isFinite(n) || n < 50 || n > 100) throw fail("invalid", `${k} precisa ser null ou um número de 50 a 100`);
        next[k] = n;
      }
    }
    if ("priority" in patch) {
      const v = patch.priority;
      const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
      if (!Number.isFinite(n) || Math.abs(n) > 1000) throw fail("invalid", "priority precisa ser um número");
      next.priority = Math.round(n);
    }
    if ("alias" in patch) {
      const v = patch.alias;
      if (v === null) next.alias = null;
      else if (typeof v === "string") next.alias = v.trim().slice(0, 40) || null;
      else throw fail("invalid", "alias precisa ser texto ou null");
    }
    const wasDisabled = !!acc.disabled;
    const ownOf = (a) => OWN_LINE_KEYS.map((k) => (a[k] === undefined || a[k] === null ? null : Number(a[k])));
    const ownBefore = ownOf(acc);
    Object.assign(acc, next);
    const ownAfter = ownOf(acc);
    if (ownAfter.some((v, i) => v !== ownBefore[i])) this.pushHistory("info", this.ownLinesText(acc.number, ownAfter), null);
    if ("disabled" in next && next.disabled !== wasDisabled) {
      this.pushHistory("info", `Conta ${acc.number} ${next.disabled ? "fora da rotação" : "de volta à rotação"}`, null);
      if (next.disabled) for (const d of this.deviceList()) if (Number(d.assigned) === acc.number && this.isActive(d)) this.decideDevice(d);
    }
    this.dirty = true;
    await this.save();
    return this.records()[String(acc.number)];
  }

  /**
   * Preenche à mão quando o login da conta vence de vez (contas enviadas antes de o servidor guardar
   * `refreshTokenExpiresAt`). ms = epoch em ms, depois de "agora - 1 dia" (e até 5 anos à frente).
   * Erros (.code): not_found, invalid. → { number, loginExpiresAt (ISO) }
   */
  async setLoginExpiresAt(number, ms) {
    const acc = this.acc(number);
    if (!acc) throw fail("not_found", `a conta ${number} não existe`);
    const v = typeof ms === "number" ? ms : typeof ms === "string" && ms.trim() !== "" ? Number(ms) : NaN;
    const t = this.now();
    if (!Number.isFinite(v) || v <= t - DAY_MS || v > t + LOGIN_FILL_MAX_AHEAD_MS) {
      throw fail("invalid", "a validade do login precisa ser uma data em milissegundos (epoch), de ontem em diante");
    }
    if (!isObj(acc.cred)) throw fail("invalid", `a conta ${acc.number} não tem login guardado`);
    const n = acc.number;
    const value = Math.round(v);
    // Sob a trava da conta e mudando o cred NO LUGAR: a renovação compara `acc.cred` com o que mandou
    // e descartaria um resultado (refresh token novo) se o objeto fosse trocado no meio.
    await this.withLock(`acc:${n}`, async () => {
      if (this.acc(n) !== acc || !isObj(acc.cred)) throw fail("not_found", `a conta ${n} não existe`);
      acc.cred.refreshTokenExpiresAt = value;
      acc.loginWarnedOn = null; // data nova: o aviso de "vence" recomeça
    });
    this.pushHistory("info", `Validade do login da conta ${n} preenchida`, null);
    await this.save();
    return { number: n, loginExpiresAt: this.iso(value) };
  }

  async removeAccount(number) {
    const acc = this.acc(number);
    if (!acc) throw fail("not_found", `a conta ${number} não existe`);
    const n = acc.number;
    // Espera a renovação em andamento dela (se houver) antes de apagar.
    await this.withLock(`acc:${n}`, async () => {
      if (this.acc(n) !== acc) return;
      delete this.st.accounts[String(n)];
      // A lista de computadores permitidos sai junto (um número reaproveitado depois começa com "todos").
      access.onAccountRemoved(this.st, n);
    });
    this.pollSoon.delete(n);
    if (this.diagPending && this.diagPending.number === n) this.diagPending = null;
    this.pushHistory("info", `Conta ${n} removida`, null);
    for (const d of this.deviceList()) {
      if (Number(d.assigned) !== n) continue;
      if (this.isActive(d)) this.decideDevice(d);
      else d.assigned = null;
    }
    await this.save();
    return { number: n };
  }

  /**
   * Quais computadores podem usar a conta (WEB-SPEC 2.3). O painel chama este (não o access.js direto).
   * devices: null = todos os computadores (inclusive os que conectarem depois); [id, ...] = só esses ([] = nenhum).
   * Quem estava na conta e perdeu a permissão sai dela já: ativo troca na hora (needsAssign → "not_allowed" →
   * assignBest: só para uma conta liberada; sem nenhuma, fica sem conta); parado fica sem conta e recebe uma
   * liberada na próxima conexão. Grava o cofre.
   * Erros (.code), sem mudar nada: not_found (a conta não existe), invalid (não é lista nem null, id inválido,
   * computador que não existe, repetido). → { number, devices: null | [id...] }
   */
  async setAccountDevices(number, devices) {
    const st = this.st;
    const before = JSON.stringify(access.accountDevicesFor(st, number));
    const value = access.setAccountDevices(st, number, devices); // lança .code "not_found" / "invalid" (nada muda)
    const n = Number(String(number).trim());
    if (JSON.stringify(value) !== before) {
      const text = Array.isArray(value) && value.length === 0
        ? `Conta ${n} não está liberada para nenhum computador`
        : `Conta ${n} liberada para ${access.devicesLabel(st, value)}`;
      this.pushHistory("info", text, null);
    }
    for (const d of this.deviceList()) {
      if (Number(d.assigned) !== n || access.canUse(st, d, n)) continue;
      if (this.isActive(d)) this.decideDevice(d); // troca já
      else d.assigned = null; // parado: recebe uma conta liberada na próxima conexão
    }
    this.dirty = true;
    await this.save();
    return { number: n, devices: value };
  }

  /**
   * rules: undefined = não mexe; null = tudo volta ao padrão; objeto = mescla com as atuais
   * (chave com null volta ao padrão; chave desconhecida é ignorada; número fora da faixa é ajustado).
   * autoSwitch: true/false. → { rules (efetivas), autoSwitch }
   * Mudou a regra "Computadores" (devicePlacement): vale já (decideAll), sem esperar o próximo ciclo.
   */
  async setRules({ rules, autoSwitch } = {}) {
    const st = this.st;
    if (autoSwitch !== undefined && typeof autoSwitch !== "boolean") throw fail("invalid_rules", "autoSwitch precisa ser true ou false");
    const placementBefore = this.rulesEffective().devicePlacement;
    let nextRules;
    if (rules === null) nextRules = {};
    else if (rules !== undefined) {
      if (!isObj(rules)) throw fail("invalid_rules", "rules precisa ser um objeto");
      nextRules = { ...(isObj(st.rules) ? st.rules : {}) };
      for (const [k, v] of Object.entries(rules)) {
        if (!Object.prototype.hasOwnProperty.call(RULE_DEFAULTS, k)) continue; // chave desconhecida: ignora
        if (v === null) delete nextRules[k];
        else nextRules[k] = checkRule(k, v);
      }
    }
    if (nextRules) {
      const value = Object.keys(nextRules).length ? nextRules : null;
      const before = isObj(st.rules) ? st.rules : {};
      const keys = new Set([...Object.keys(before), ...Object.keys(nextRules)]);
      if ([...keys].some((k) => before[k] !== nextRules[k])) {
        st.rules = value;
        this.pushHistory("info", value ? "Regras de troca atualizadas" : "Regras de troca de volta ao padrão", null);
      }
    }
    if (autoSwitch !== undefined && (st.autoSwitch !== false) !== autoSwitch) {
      st.autoSwitch = autoSwitch;
      this.pushHistory("info", autoSwitch ? "Troca automática ligada" : "Troca automática desligada", null);
    }
    const placement = this.rulesEffective().devicePlacement;
    if (placement !== placementBefore) {
      this.pushHistory(
        "info",
        placement === "together"
          ? "Computadores juntos: todos na mesma conta (a do topo da fila), trocando juntos"
          : "Computadores separados: cada um na sua conta",
        null
      );
      this.decideAll();
    }
    this.dirty = true;
    await this.save();
    return { rules: this.rulesEffective(), autoSwitch: st.autoSwitch !== false };
  }
}

module.exports = { Engine, VERSION, ERROR_STATUS, TICK_MS, ACTIVE_MS, POLL_ACTIVE_MS, POLL_IDLE_MS, CRED_MIN_VALID_MS };
