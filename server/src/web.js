"use strict";
// Painel web do Swap Plus Servidor (server/WEB-SPEC.md): sessão por cookie, CSRF, /web/api/* e os
// arquivos da página (server/web/index.html, app.js, app.css).
//
// - Mesma origem da API (PUBLIC_URL). Os arquivos saem de uma lista fixa (nada do caminho pedido vira
//   caminho no disco → sem path traversal), com CSP só 'self'.
// - Só o ADMINISTRADOR entra: os e-mails de ADMIN_EMAILS (variável de ambiente, lida na subida; nada
//   aqui muda essa lista). As contas da lista de liberadas (allowedEmails) só conectam computadores.
//   Sem ADMIN_EMAILS o painel fica desligado: "/" mostra uma página explicando e /web/api/* → 503.
// - O login com Google do painel (GET /web/login e o retorno /auth/google/callback) fica em server.js,
//   junto do login dos computadores; quando o Google confirma o administrador, ele chama
//   createSession() daqui e devolve o cookie.
// - Sessão: token de 32 bytes (base64url) no cookie sp_sess (HttpOnly; Secure; SameSite=Lax; 30 dias).
//   No cofre fica só o sha256 (state.webSessions). lastSeen sobe no máximo 1x/min e só na memória:
//   vai para o disco com a próxima gravação do cofre (o motor grava em todo ciclo em que algo mudou).
//   A cada pedido o e-mail da sessão precisa continuar administrador (comparado pela emailKey do
//   google.js): se ADMIN_EMAILS mudar, as sessões de quem saiu param de valer.
// - CSRF: todo método que muda algo exige Origin = origem de PUBLIC_URL e X-CSRF-Token = csrf da sessão.
// - Nunca devolve token, refresh token, access token, hash de token nem segredo: as respostas são
//   montadas campo a campo e ainda passam pelo webReplacer. Cookies e tokens nunca vão para log.
// - "Adicionar conta pela assinatura" (POST /web/api/claude-login/start e /finish): o login OAuth do
//   Claude Code com código colado (claudelogin.js); a conta é guardada pelo engine.storeFreshLogin (sem
//   renovar na hora: o login acabou de ser emitido) e renovada depois pelo ciclo do motor.
// - Computadores permitidos por conta (WEB-SPEC 2.3, access.js): PUT /web/api/accounts/:n/devices →
//   engine.setAccountDevices; o PanelState mostra `devices` em cada conta e `allowedAccounts` em cada computador.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { RULE_DEFAULTS } = require("../../plus/rules");
const { emailKey } = require("./google");
const { createClaudeLogin } = require("./claudelogin");
const access = require("./access");

const SESSION_COOKIE = "sp_sess";
const LOGIN_COOKIE = "sp_login"; // prende o login com Google ao navegador que começou (10 min)
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 dias
const SESSION_MAX_AGE_S = SESSION_TTL_MS / 1000; // 2592000
const LOGIN_COOKIE_PATH = "/auth/google/";
const LOGIN_COOKIE_MAX_AGE_S = 10 * 60;
const TOUCH_EVERY_MS = 60 * 1000; // lastSeen no máximo 1x/min
const MAX_SESSIONS = 100; // sessões do painel guardadas (acima disso sai a mais parada)
const LOGIN_WARN_MS = 3 * 24 * 60 * 60 * 1000; // aviso quando o login vence em menos de 3 dias
const HISTORY_IN_PANEL = 100;
const DEFAULT_WEB_DIR = path.join(__dirname, "..", "web"); // repo: server/web · imagem: /app/server/web
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/; // 32 bytes em base64url
const DEVICE_NAME_MAX = 40; // nome do computador (renomear pelo painel): 1 a 40 caracteres
// Caracteres de controle, separadores de linha e os de direção do texto (que enganam a leitura do nome).
const DEVICE_NAME_BAD = /[\p{Cc}\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;
const RECENT_LOGIN_MS = 15 * 60 * 1000; // kit de recuperação: só com login no Google feito há menos disso
const SECRET_MAX_BYTES = 4096;
const RECOVERY_ADVICE =
  "Guarde estas duas chaves FORA deste servidor (gerenciador de senhas ou um arquivo no seu computador). Se o servidor for perdido, só com elas o backup abre.";

const PANEL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

// Cabeçalhos de segurança da página e dos arquivos do painel.
const PANEL_HEADERS = Object.freeze({
  "Content-Security-Policy": PANEL_CSP,
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

// Os únicos arquivos servidos (nome → Content-Type).
const STATIC_FILES = Object.freeze({
  "index.html": "text/html; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "app.css": "text/css; charset=utf-8",
});

// Chaves que nunca saem numa resposta do painel (rede de segurança: as respostas já são montadas campo a campo).
const NEVER_SEND_WEB = new Set([
  "refreshToken",
  "refresh_token",
  "accessToken",
  "access_token",
  "tokenHash",
  "token",
  "idToken",
  "id_token",
  "verifier",
  "code_verifier",
  "pollHash",
  "bindHash",
  "codeHash",
  "clientSecret",
  "client_secret",
  "cred",
  "spentRefresh",
]);
const webReplacer = (k, v) => (NEVER_SEND_WEB.has(k) ? undefined : v);

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const lower = (s) => String(s || "").trim().toLowerCase();

/** Número positivo em ms (aceita segundos por engano), ou null. */
function posMs(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

/** "Chrome no macOS", "Safari no iOS"... (só um resumo: o User-Agent inteiro não é guardado). */
function uaSummary(ua) {
  const s = typeof ua === "string" ? ua.slice(0, 512) : "";
  if (!s) return null;
  let browser = "Navegador";
  if (/Edg(e|A|iOS)?\//.test(s)) browser = "Edge";
  else if (/OPR\/|Opera/.test(s)) browser = "Opera";
  else if (/Firefox\/|FxiOS\//.test(s)) browser = "Firefox";
  else if (/Chrome\/|CriOS\//.test(s)) browser = "Chrome";
  else if (/Safari\//.test(s)) browser = "Safari";
  else if (/curl\//i.test(s)) browser = "curl";
  let os = null;
  if (/iPhone|iPad|iPod/.test(s)) os = "iOS";
  else if (/Android/.test(s)) os = "Android";
  else if (/CrOS/.test(s)) os = "ChromeOS";
  else if (/Mac OS X|Macintosh/.test(s)) os = "macOS";
  else if (/Windows/.test(s)) os = "Windows";
  else if (/Linux/.test(s)) os = "Linux";
  return os ? `${browser} no ${os}` : browser;
}

/** Valores do cookie `name` no pedido (pode haver mais de um, com caminhos diferentes). */
function readCookies(req, name) {
  const raw = req && req.headers ? req.headers.cookie : null;
  if (typeof raw !== "string" || !raw) return [];
  const out = [];
  for (const part of raw.slice(0, 8192).split(";")) {
    const i = part.indexOf("=");
    if (i < 0 || part.slice(0, i).trim() !== name) continue;
    let v = part.slice(i + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (v) out.push(v);
    if (out.length >= 5) break;
  }
  return out;
}

/** Cookie sempre HttpOnly + Secure + SameSite=Lax (o painel só é acessado por https, via Cloudflare/Caddy). */
function cookie(name, value, cookiePath, maxAgeSec) {
  return `${name}=${value}; Path=${cookiePath}; Max-Age=${maxAgeSec}; HttpOnly; Secure; SameSite=Lax`;
}

const pad = (n) => String(n).padStart(2, "0");

/** "16/11 às 18:00" (fuso do servidor, TZ). */
function fmtWhen(t) {
  const d = new Date(t);
  if (Number.isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} às ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Segredo de um arquivo (kit de recuperação) → { ok: true, value } | { ok: false, why }. Nunca vai para log.
 * trimAll: tira espaços dos dois lados (chave mestra); senão só as quebras de linha do fim (senha do backup).
 */
function readSecret(file, trimAll) {
  if (typeof file !== "string" || !file) return { ok: false, why: "arquivo não configurado" };
  try {
    const st = fs.statSync(file);
    if (!st.isFile()) return { ok: false, why: "não é um arquivo" };
    if (st.size > SECRET_MAX_BYTES) return { ok: false, why: "arquivo grande demais" };
    const raw = fs.readFileSync(file, "utf8");
    const value = trimAll ? raw.trim() : raw.replace(/[\r\n]+$/, "");
    return value ? { ok: true, value } : { ok: false, why: "arquivo vazio" };
  } catch (e) {
    return { ok: false, why: e && e.code === "ENOENT" ? "arquivo não existe" : "não deu para ler o arquivo" };
  }
}

/** "40 min", "5 h", "2 dias". */
function fmtLeft(ms) {
  const min = Math.max(1, Math.round(ms / 60000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.floor(h / 24);
  return d === 1 ? "1 dia" : `${d} dias`;
}

/**
 * createWeb(deps) → { routes, ownsPath, createSession, findSession, dropSession, dropSessionsOf,
 *   sweepSessions, sessionCookie, clearSessionCookie, clearLoginCookie, newLoginBinding,
 *   loginBindingOk, panelState, webDir }
 *
 * deps vêm do server.js (createApp), para reaproveitar a mesma lógica do admin e da API:
 *   store, engine, config (webDir, publicUrl, masterKeyFile, resticPassFile), now, log, version,
 *   HttpError, RawReply, JsonReply, pageError, bad, limiter (401 do painel), sha256hex, sameHash,
 *   isAdmin, adminEmails (de ADMIN_EMAILS, fixos desde a subida), allowEmail, denyEmail, newPairCode,
 *   revokeDevice, googleInfo, applyRules, cleanAccountPatch, parseSwitchNumber, accountExists, pushHistory,
 *   claudeLogin (opcional: o "Adicionar conta pela assinatura" de claudelogin.js; sem ele, cria um com
 *   config.tokenUrl/config.apiBase, os mesmos ANTHROPIC_TOKEN_URL/ANTHROPIC_API_BASE do motor)
 */
function createWeb(deps) {
  const {
    store,
    engine,
    config = {},
    now = Date.now,
    log,
    version,
    HttpError,
    RawReply,
    JsonReply,
    pageError,
    bad,
    limiter,
    sha256hex,
    sameHash,
    isAdmin,
    adminEmails = [],
    allowEmail,
    denyEmail,
    newPairCode,
    revokeDevice,
    googleInfo,
    applyRules,
    cleanAccountPatch,
    parseSwitchNumber,
    accountExists,
    pushHistory,
  } = deps;

  // "Adicionar conta pela assinatura" (login OAuth do Claude Code com código colado; sessões só na memória).
  let claudeLogin = deps.claudeLogin || null;
  if (!claudeLogin) {
    try {
      claudeLogin = createClaudeLogin({ anthropicTokenUrl: config.tokenUrl, anthropicApiBase: config.apiBase, now, log });
    } catch (e) {
      log.warn(`[painel] "Adicionar conta pela assinatura" desligado: ${e && e.message}`);
    }
  }

  const webDir = config.webDir || DEFAULT_WEB_DIR;
  const admins = Object.freeze([...(Array.isArray(adminEmails) ? adminEmails : [])]);
  const panelOn = admins.length > 0; // sem administrador (ADMIN_EMAILS) o painel fica desligado

  /** Página "painel desligado" (sem ADMIN_EMAILS): GET /, /web/login e o retorno do Google. */
  function panelOffError() {
    const e = pageError(503, "panel_off", "Painel desligado", [
      "O painel web deste servidor está desligado: não há administrador definido.",
      ["O dono do servidor precisa pôr o próprio e-mail Google em ", { b: "ADMIN_EMAILS" }, " (no compose) e reiniciar o servidor."],
      "Os computadores conectados continuam funcionando normalmente.",
    ]);
    e.page.links = [];
    return e;
  }
  const panelOffJson = () =>
    new HttpError(503, "panel_off", "o painel web está desligado: o servidor não tem administrador (defina ADMIN_EMAILS no compose e reinicie)");
  const publicOrigin = (() => {
    try {
      return config.publicUrl ? new URL(config.publicUrl).origin : null;
    } catch {
      return null;
    }
  })();

  const sessions = () => {
    const st = store.state;
    if (!isObj(st.webSessions)) st.webSessions = {};
    return st.webSessions;
  };

  /** Grava o cofre sem derrubar o pedido (o que importa já foi gravado por quem fez a mudança). */
  const saveQuiet = (why) =>
    store.save().catch((e) => log.warn(`[painel] não consegui gravar o cofre (${why}): ${e && e.message}`));

  /** Histórico + gravação (ações do painel). */
  async function note(text, deviceId = null) {
    pushHistory("info", text, deviceId);
    await saveQuiet("histórico");
  }

  // ----- sessões -----

  const sessionCookie = (token) => cookie(SESSION_COOKIE, token, "/", SESSION_MAX_AGE_S);
  const clearSessionCookie = () => cookie(SESSION_COOKIE, "", "/", 0);
  const clearLoginCookie = () => cookie(LOGIN_COOKIE, "", LOGIN_COOKIE_PATH, 0);

  /** Tira as sessões vencidas e as de quem não é mais administrador → quantas saíram (sem gravar). */
  function sweep() {
    const t = now();
    const list = sessions();
    let n = 0;
    for (const [id, s] of Object.entries(list)) {
      if (!isObj(s) || !(Number(s.expiresAt) > t) || !isAdmin(s.email)) {
        delete list[id];
        n++;
      }
    }
    return n;
  }

  /** Limpeza periódica (server.js chama junto com a das sessões de login). Grava se tirou alguma. */
  async function sweepSessions() {
    const n = sweep();
    if (n) await saveQuiet("limpeza das sessões do painel");
    return n;
  }

  /**
   * Sessão nova do painel → { id, token }. O token em claro só sai aqui (vai para o cookie);
   * no cofre fica o sha256. Quem chama grava o cofre.
   */
  function createSession({ email, ip, ua }) {
    sweep();
    const list = sessions();
    const ids = Object.keys(list);
    if (ids.length >= MAX_SESSIONS) {
      ids.sort((a, b) => (Number(list[a].lastSeen) || 0) - (Number(list[b].lastSeen) || 0));
      for (const id of ids.slice(0, ids.length - MAX_SESSIONS + 1)) delete list[id];
    }
    const t = now();
    let id;
    do id = crypto.randomBytes(9).toString("base64url");
    while (hasOwn(list, id));
    const token = crypto.randomBytes(32).toString("base64url");
    list[id] = {
      tokenHash: sha256hex(token),
      email: lower(email),
      createdAt: t,
      lastSeen: t,
      expiresAt: t + SESSION_TTL_MS,
      ua: uaSummary(ua),
      ip: ip || null,
      csrf: crypto.randomBytes(32).toString("base64url"),
    };
    return { id, token };
  }

  /** Sessão do cookie sp_sess → { id, s } ou null. Vencida ou de quem não é mais administrador: apaga. */
  function findSession(req) {
    const list = sessions();
    const t = now();
    for (const tok of readCookies(req, SESSION_COOKIE)) {
      if (!TOKEN_RE.test(tok)) continue;
      const hash = sha256hex(tok);
      let id = null;
      for (const [k, s] of Object.entries(list)) {
        if (isObj(s) && sameHash(hash, s.tokenHash)) id = k;
      }
      if (!id) continue;
      const s = list[id];
      if (!(Number(s.expiresAt) > t) || !isAdmin(s.email)) {
        delete list[id];
        saveQuiet("sessão do painel vencida ou de quem não é mais administrador");
        continue;
      }
      return { id, s };
    }
    return null;
  }

  const dropSession = (id) => {
    const list = sessions();
    if (!hasOwn(list, id)) return false;
    delete list[id];
    return true;
  };

  /** Derruba todas as sessões do painel de um e-mail (pela emailKey) → quantas (sem gravar: quem chama grava). */
  function dropSessionsOf(email) {
    const k = emailKey(email);
    const list = sessions();
    let n = 0;
    for (const [id, s] of Object.entries(list)) {
      if (!isObj(s) || (!!k && emailKey(s.email) === k)) {
        delete list[id];
        n++;
      }
    }
    return n;
  }

  /** lastSeen/ip no máximo 1x/min, só na memória (sem gravar o cofre a cada pedido). */
  function touch(found, ip) {
    const t = now();
    if (t - (Number(found.s.lastSeen) || 0) < TOUCH_EVERY_MS) return;
    found.s.lastSeen = t;
    if (ip) found.s.ip = ip;
  }

  function unauthorized() {
    const e = new HttpError(401, "unauthorized", "entre com o Google para usar o painel");
    e.extra = { login: "/web/login", googleEnabled: !!googleInfo().enabled };
    return e;
  }

  function requireSession(req, ip) {
    const wait = limiter.blockedFor(ip);
    if (wait > 0) {
      throw new HttpError(429, "too_many_attempts", "pedidos sem sessão demais deste endereço; espere alguns minutos", {
        "Retry-After": String(Math.ceil(wait / 1000)),
      });
    }
    const found = findSession(req);
    if (!found) throw unauthorized();
    touch(found, ip);
    return found;
  }

  function checkOrigin(req) {
    const o = req.headers.origin;
    if (!publicOrigin || typeof o !== "string" || o !== publicOrigin) {
      throw new HttpError(403, "bad_origin", "pedido recusado: ele não veio do próprio painel");
    }
  }

  function checkCsrf(req, found) {
    const h = req.headers["x-csrf-token"];
    const want = found && found.s && found.s.csrf;
    if (typeof h !== "string" || typeof want !== "string" || !want || !sameHash(sha256hex(h.slice(0, 200)), sha256hex(want))) {
      throw new HttpError(403, "csrf", "pedido sem a proteção do painel; recarregue a página e tente de novo");
    }
  }

  /**
   * Rota do painel: painel ligado e sessão do administrador; se muda algo, também Origin e X-CSRF-Token.
   * csrf: exige o X-CSRF-Token mesmo sendo leitura (o kit de recuperação).
   */
  const panel =
    (fn, { change = false, csrf = false } = {}) =>
    async (args) => {
      if (!panelOn) throw panelOffJson();
      if (change) checkOrigin(args.req);
      const sess = requireSession(args.req, args.ip);
      if (change || csrf) checkCsrf(args.req, sess);
      args.ctx.name = `painel ${sess.s.email}`;
      return fn({ ...args, sess, me: sess.s.email });
    };

  // ----- login com Google: cookie que prende o login ao navegador -----

  function newLoginBinding() {
    const value = crypto.randomBytes(32).toString("base64url");
    return { hash: sha256hex(value), cookie: cookie(LOGIN_COOKIE, value, LOGIN_COOKIE_PATH, LOGIN_COOKIE_MAX_AGE_S) };
  }

  function loginBindingOk(req, hash) {
    if (typeof hash !== "string" || !hash) return false;
    return readCookies(req, LOGIN_COOKIE).some((v) => TOKEN_RE.test(v) && sameHash(sha256hex(v), hash));
  }

  // ----- PanelState -----

  function devicesNow() {
    const st = store.state;
    const list = typeof engine.devicesList === "function" ? engine.devicesList(null) : [];
    return (Array.isArray(list) ? list : []).filter(isObj).map((d) => ({
      id: d.id,
      name: d.name ?? null,
      platform: d.platform ?? null,
      googleEmail: d.googleEmail ?? null,
      createdAt: d.createdAt ?? null,
      lastSeen: d.lastSeen ?? null,
      active: !!d.active,
      assigned: d.assigned ?? null,
      // Contas que este computador pode usar (Contas → Computadores permitidos), em ordem; [] = nenhuma.
      allowedAccounts: access.allowedAccountsList(st, { id: d.id }),
    }));
  }

  function warningsFor(accounts, devices, g, t) {
    const out = [];
    for (const a of accounts) {
      const who = `conta ${a.number}${a.email ? ` (${a.email})` : ""}`;
      if (a.dead) {
        out.push({
          kind: "account_dead",
          account: a.number,
          text: `O login da ${who} morreu: entre de novo com esta conta no Claude Code de qualquer computador conectado.`,
        });
        continue;
      }
      if (a.loginExpiresAt !== null && a.loginExpiresAt - t < LOGIN_WARN_MS) {
        const left = a.loginExpiresAt - t;
        out.push({
          kind: "login_expiring",
          account: a.number,
          text:
            left > 0
              ? `O login da ${who} vence em ${fmtLeft(left)} (${fmtWhen(a.loginExpiresAt)}): entre de novo com esta conta no Claude Code de um computador conectado.`
              : `O login da ${who} venceu em ${fmtWhen(a.loginExpiresAt)}: entre de novo com esta conta no Claude Code de um computador conectado.`,
        });
      }
    }
    if (!g.enabled) {
      out.push({
        kind: "google_off",
        text: "O login com Google está desligado neste servidor: computadores novos só conectam com código de conexão e ninguém entra de novo no painel até ele voltar.",
      });
    }
    if (!devices.length) {
      out.push({
        kind: "no_devices",
        text: "Nenhum computador conectado: conecte um pelo VS Code (Swap Plus: Conectar ao servidor → Entrar com Google) ou gere um código de conexão.",
      });
    }
    if (!accounts.length) {
      out.push({ kind: "no_accounts", text: "Nenhuma conta Claude no servidor ainda: conecte um computador e envie os logins dele." });
    }
    try {
      const es = typeof engine.status === "function" ? engine.status() : null;
      const until = es ? Number(es.usagePausedUntil) : 0;
      if (until > t) {
        out.push({ kind: "usage_paused", text: `A Anthropic pediu uma pausa nas leituras de uso: elas voltam ${fmtWhen(until)}.` });
      }
    } catch {}
    return out;
  }

  /** Tudo o que a página mostra (formato em WEB-SPEC.md, "PanelState"). */
  function panelState(sess) {
    const st = store.state;
    const t = now();
    const list = engine.publicList(null) || {};
    const records = engine.records() || {};
    const devices = devicesNow();
    const rawAccounts = isObj(st.accounts) ? st.accounts : {};
    const accounts = (Array.isArray(list.accounts) ? list.accounts : []).filter(isObj).map((a) => {
      const key = String(a.number);
      const raw = isObj(rawAccounts[key]) ? rawAccounts[key] : {};
      const cred = isObj(raw.cred) ? raw.cred : {};
      const rec = isObj(records[key]) ? records[key] : {};
      return {
        // PublicAccount (lista fechada de campos)
        number: a.number,
        email: a.email ?? null,
        organizationName: a.organizationName ?? "",
        organizationUuid: a.organizationUuid ?? "",
        plan: isObj(a.plan) && a.plan.label ? { label: a.plan.label } : null,
        usageStatus: a.usageStatus ?? "unknown",
        usage: a.usage ?? null,
        usageAgeSeconds: a.usageAgeSeconds ?? null,
        lastGoodUsage: a.lastGoodUsage ?? null,
        lastGoodAgeSeconds: a.lastGoodAgeSeconds ?? null,
        dead: !!a.dead,
        // + painel (do cofre, nunca tokens)
        loginExpiresAt: posMs(cred.refreshTokenExpiresAt),
        accessExpiresAt: posMs(cred.expiresAt),
        lastRefreshAt: posMs(raw.lastRefreshAt),
        gen: raw.gen === null || raw.gen === undefined || !Number.isFinite(Number(raw.gen)) ? null : Number(raw.gen),
        disabled: !!(hasOwn(rec, "disabled") ? rec.disabled : raw.disabled),
        threshold: rec.threshold ?? raw.threshold ?? null,
        priority: Number(hasOwn(rec, "priority") ? rec.priority : raw.priority) || 0,
        alias: (hasOwn(rec, "alias") ? rec.alias : raw.alias) || null,
        assignedDevices: devices
          .filter((d) => d.assigned !== null && Number(d.assigned) === Number(a.number))
          .map((d) => ({ id: d.id, name: d.name })),
        // Computadores permitidos: null = todos (inclusive os que conectarem depois); [id...] = só esses.
        devices: access.accountDevicesFor(st, a.number),
      };
    });
    const names = new Map(devices.map((d) => [d.id, d.name]));
    const history = (Array.isArray(st.history) ? st.history : [])
      .slice(0, HISTORY_IN_PANEL)
      .filter(isObj)
      .map((h) => ({
        ts: h.ts ?? null,
        kind: h.kind ?? "info",
        text: String(h.text ?? ""),
        device: h.device ?? null,
        deviceName: h.deviceName ?? (h.device ? names.get(h.device) : null) ?? null,
      }));
    const g = googleInfo();
    return {
      version,
      serverTime: t,
      me: { email: sess.s.email, admin: isAdmin(sess.s.email) },
      adminEmails: [...admins],
      accounts,
      rules: engine.rulesEffective(),
      ruleDefaults: { ...RULE_DEFAULTS },
      autoSwitch: st.autoSwitch !== false,
      devices,
      allowedEmails: Array.isArray(st.allowedEmails) ? [...st.allowedEmails] : [],
      history,
      warnings: warningsFor(accounts, devices, g, t),
      diag: isObj(st.diag) ? { ...st.diag } : {},
      google: { enabled: !!g.enabled, callbackUrl: g.callbackUrl || null },
    };
  }

  /** Resposta das ações: { ok: true, ...detalhes, state: PanelState }. */
  const done = (sess, extra) => ({ ok: true, ...(extra || {}), state: panelState(sess) });

  // ----- arquivos da página -----

  async function staticFile(name) {
    const type = STATIC_FILES[name];
    if (!type) throw new HttpError(404, "not_found", "arquivo não encontrado");
    if (name === "index.html" && !panelOn) throw panelOffError();
    let body;
    try {
      body = await fs.promises.readFile(path.join(webDir, name));
    } catch {
      if (name === "index.html") {
        throw pageError(503, "no_panel", "Painel não instalado", [
          "Os arquivos do painel não estão neste servidor.",
          "Atualize a imagem do Swap Plus Servidor.",
        ]);
      }
      throw new HttpError(404, "not_found", "arquivo não encontrado");
    }
    return new RawReply(200, { ...PANEL_HEADERS, "Content-Type": type, "Cache-Control": "no-cache" }, body);
  }

  // ----- rotas -----

  function sessionsPublic(currentId) {
    const t = now();
    return Object.entries(sessions())
      .filter(([, s]) => isObj(s) && Number(s.expiresAt) > t)
      .map(([id, s]) => ({
        id,
        email: s.email ?? null,
        createdAt: s.createdAt ?? null,
        lastSeen: s.lastSeen ?? null,
        expiresAt: s.expiresAt ?? null,
        ua: s.ua ?? null,
        ip: s.ip ?? null,
        current: id === currentId,
      }))
      .sort((a, b) => (Number(b.lastSeen) || 0) - (Number(a.lastSeen) || 0));
  }

  async function logout({ req }) {
    checkOrigin(req);
    const found = findSession(req);
    if (found) {
      checkCsrf(req, found);
      dropSession(found.id);
      await saveQuiet("saída do painel");
      log.info(`[painel] ${found.s.email} saiu do painel`);
    }
    return new JsonReply(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
  }

  const rulesSnapshot = () => JSON.stringify([engine.rulesEffective(), store.state.autoSwitch !== false]);

  async function putRules({ body, sess, me }) {
    const before = rulesSnapshot();
    await applyRules(body);
    if (rulesSnapshot() !== before) await note(`Regras alteradas pelo painel (${me})`);
    return done(sess);
  }

  function describePatch(p) {
    const parts = [];
    if (hasOwn(p, "disabled")) parts.push(p.disabled ? "fora da rotação" : "de volta à rotação");
    if (hasOwn(p, "alias")) parts.push(p.alias ? `apelido "${p.alias}"` : "sem apelido");
    if (hasOwn(p, "threshold")) parts.push(p.threshold === null ? "linha da sessão padrão" : `linha da sessão ${p.threshold}%`);
    if (hasOwn(p, "priority")) parts.push(`prioridade ${p.priority}`);
    return parts.join(", ");
  }

  const needAccount = (n) => {
    if (!accountExists(n)) throw new HttpError(404, "not_found", `a conta ${n} não existe`);
  };

  async function patchAccount({ params, body, sess, me }) {
    const n = Number(params[0]);
    needAccount(n);
    const patch = cleanAccountPatch(body);
    await engine.updateAccount(n, patch);
    await note(`Conta ${n} ajustada pelo painel (${me}): ${describePatch(patch)}`);
    return done(sess);
  }

  async function deleteAccount({ params, sess, me }) {
    const n = Number(params[0]);
    needAccount(n);
    await engine.removeAccount(n);
    log.info(`[contas] conta ${n} removida pelo painel (${me})`);
    await note(`Conta ${n} removida pelo painel (${me})`);
    return done(sess, { number: n });
  }

  /**
   * PUT /web/api/accounts/:n/devices { devices: null | [deviceId, ...] } → engine.setAccountDevices.
   * null (escrito) = todos os computadores; [] = nenhum. Corpo sem `devices` → 400. Quem perdeu a permissão
   * sai da conta na hora (o motor troca). → { ok, number, devices, state }
   */
  async function putAccountDevices({ params, body, sess, me }) {
    const n = Number(params[0]);
    needAccount(n);
    if (!hasOwn(body, "devices")) {
      throw bad('envie { "devices": null } (todos os computadores) ou { "devices": ["id-do-computador", ...] } ([] = nenhum)');
    }
    let r;
    try {
      r = await engine.setAccountDevices(n, body.devices);
    } catch (e) {
      // Lista inválida (não é lista nem null, id inválido, computador que não existe, repetido): a mensagem do motor.
      if (e && e.code === "invalid") throw new HttpError(400, "invalid", String(e.message || "lista de computadores inválida").slice(0, 300));
      throw e; // not_found → 404 (a conta sumiu no meio)
    }
    const devices = r && hasOwn(r, "devices") ? r.devices : null;
    await note(`Computadores da conta ${n} ajustados pelo painel (${me}): ${access.devicesLabel(store.state, devices)}`);
    return done(sess, { number: n, devices });
  }

  function deviceById(id) {
    const devs = isObj(store.state.devices) ? store.state.devices : {};
    return hasOwn(devs, id) && isObj(devs[id]) ? devs[id] : null;
  }

  /** PATCH /web/api/devices/:id { name } → renomeia o computador (1 a 40 caracteres, sem caracteres de controle). */
  async function patchDevice({ params, body, sess, me }) {
    const id = params[0];
    const dev = deviceById(id);
    if (!dev) throw new HttpError(404, "not_found", "computador não encontrado");
    if (!hasOwn(body, "name")) throw bad('envie { "name": "novo nome" }');
    if (typeof body.name !== "string") throw bad("name precisa ser texto");
    const name = body.name.trim();
    const len = [...name].length;
    if (len < 1 || len > DEVICE_NAME_MAX) throw bad(`o nome do computador precisa ter de 1 a ${DEVICE_NAME_MAX} caracteres`);
    if (DEVICE_NAME_BAD.test(name)) throw bad("o nome do computador não pode ter quebra de linha, tabulação nem caracteres de controle");
    const old = dev.name;
    if (old !== name) {
      dev.name = name;
      await note(`Computador "${old}" renomeado para "${name}" pelo painel (${me})`, id);
      log.info(`[painel] computador ${id} renomeado pelo painel (${me})`);
    }
    return done(sess, { id, name });
  }

  async function switchDevice({ params, body, sess, me }) {
    const id = params[0];
    const dev = deviceById(id);
    if (!dev) throw new HttpError(404, "not_found", "computador não encontrado");
    const n = parseSwitchNumber(body.number);
    const r = (await engine.switchDevice(id, n, "painel")) || {};
    if (r.switched) {
      const to = r.to ?? n;
      await note(
        to !== null && to !== undefined
          ? `Computador "${dev.name}" passou para a conta ${to} pelo painel (${me})`
          : `Computador "${dev.name}" trocou de conta pelo painel (${me})`,
        id
      );
    }
    return done(sess, { switched: !!r.switched, text: typeof r.text === "string" ? r.text : "" });
  }

  async function deleteDevice({ params, sess, me }) {
    await revokeDevice(params[0], `revogado pelo painel por ${me}`);
    return done(sess, { id: params[0] });
  }

  async function allow({ body, sess, me }) {
    const r = await allowEmail(body.email, `pelo painel (${me})`);
    return done(sess, { email: r.email, added: r.added, admin: !!r.admin });
  }

  async function deny({ params, sess, me }) {
    let email;
    try {
      email = decodeURIComponent(params[0]);
    } catch {
      throw bad("e-mail inválido no endereço");
    }
    // O administrador (inclusive o próprio) não sai por aqui: denyEmail responde 409 "admin".
    const r = await denyEmail(lower(email), `pelo painel (${me})`);
    return done(sess, { email: r.email, removed: r.removed, devices: r.devices, panelSessions: r.panelSessions || 0 });
  }

  async function pairCode({ me }) {
    const r = await newPairCode();
    await note(`Código de conexão gerado pelo painel (${me})`);
    return { code: r.code, connect: r.connect, expiresAt: r.expiresAt };
  }

  async function deleteSession({ params, sess, me }) {
    const id = params[0];
    const list = sessions();
    if (!hasOwn(list, id) || !isObj(list[id])) throw new HttpError(404, "not_found", "sessão não encontrada");
    const s = list[id];
    dropSession(id);
    const mine = id === sess.id;
    if (mine) {
      await saveQuiet("saída do painel");
      log.info(`[painel] ${me} encerrou a própria sessão`);
      return new JsonReply(200, { ok: true, loggedOut: true, sessions: [] }, { "Set-Cookie": clearSessionCookie() });
    }
    log.info(`[painel] sessão do painel de ${s.email} encerrada por ${me}`);
    await note(`Sessão do painel de ${s.email}${s.ua ? ` (${s.ua})` : ""} encerrada pelo painel (${me})`);
    return { ok: true, loggedOut: false, sessions: sessionsPublic(sess.id) };
  }

  /**
   * GET /web/api/recovery-kit: chave mestra do cofre e senha do backup, para guardar fora do servidor.
   * Só com login no Google feito há menos de 15 min (senão 403 "reauth"). Os valores nunca vão para log.
   */
  async function recoveryKit({ sess, me }) {
    const t = now();
    const loginAt = Number(sess.s.createdAt) || 0;
    if (!(t - loginAt < RECENT_LOGIN_MS)) {
      const e = new HttpError(
        403,
        "reauth",
        `para ver o kit de recuperação, entre de novo com o Google: ele só aparece até ${RECENT_LOGIN_MS / 60000} minutos depois de entrar`
      );
      e.extra = { login: "/web/login?next=acesso" };
      throw e;
    }
    const item = (file, trimAll) => {
      const r = readSecret(file, trimAll);
      return r.ok ? { available: true, value: r.value, file } : { available: false, value: null, file: file || null, why: r.why };
    };
    const kit = {
      masterKey: item(config.masterKeyFile, true),
      backupPassword: item(config.resticPassFile, false),
      advice: RECOVERY_ADVICE,
      loginAt,
      availableUntil: loginAt + RECENT_LOGIN_MS,
    };
    pushHistory("info", `Kit de recuperação visto pelo painel (${me})`, null);
    await saveQuiet("histórico");
    log.info(`[painel] kit de recuperação visto por ${me}`); // só o fato: os valores nunca vão para log
    return new JsonReply(200, kit, { "Cache-Control": "no-store, max-age=0", Pragma: "no-cache" });
  }

  // ----- Adicionar conta pela assinatura (claudelogin.js + engine.storeFreshLogin) -----
  // O código colado, o state, o verifier e os tokens nunca saem daqui: nem em resposta, nem em log.
  // Erros: { error, message, restart } — restart: true = o login acabou, a tela começa outro (start).
  // storeFreshLogin guarda o login recém-emitido SEM renovar na hora (o motor renova depois, no ciclo).

  const ADD_AGAIN = 'clique em "Adicionar conta" de novo';
  const IDENTITY_TEXT = `a conta desse login não confere com a identidade que a Anthropic mostrou; ${ADD_AGAIN}`;
  // Erros do engine.storeFreshLogin → [status, texto do painel] (o código do erro do motor continua em `error`).
  const ADD_LOGIN_ERRORS = {
    dead_login: [422, `a Anthropic recusou renovar essa conta (o login dela não vale mais); ${ADD_AGAIN}`],
    stale_login: [422, `esse login já tinha sido usado pelo servidor; ${ADD_AGAIN}`],
    refresh_failed: [
      503,
      `o servidor não conseguiu guardar a conta agora (o servidor está reiniciando ou o cofre não está gravando); ${ADD_AGAIN} daqui a pouco`,
    ],
    identity_mismatch: [422, IDENTITY_TEXT],
    identity_mismatch_spent: [422, IDENTITY_TEXT],
    profile_unavailable: [502, `não deu para conferir de qual conta é esse login (perfil da Anthropic indisponível); ${ADD_AGAIN} daqui a pouco`],
    invalid_login: [502, `o login voltou incompleto da Anthropic (sem refresh token ou sem e-mail); ${ADD_AGAIN}`],
  };
  const hideTokens = (s) => String(s == null ? "" : s).replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-[oculto]");

  function loginHttpError(status, code, message, restart) {
    const e = new HttpError(status, code, message);
    e.extra = { restart: !!restart };
    return e;
  }

  function needClaudeLogin() {
    if (!claudeLogin) {
      throw loginHttpError(503, "claude_login_off", "adicionar conta pela assinatura está desligado neste servidor (veja o log da subida)", false);
    }
  }

  async function claudeLoginStart({ sess, me }) {
    needClaudeLogin();
    const r = claudeLogin.start({ owner: sess.id });
    log.info(`[painel] ${me} começou a adicionar uma conta pela assinatura`);
    return { loginId: r.loginId, authUrl: r.authUrl, expiresAt: r.expiresAt };
  }

  async function claudeLoginFinish({ body, sess, me }) {
    needClaudeLogin();
    const loginId = typeof body.loginId === "string" ? body.loginId.trim() : "";
    if (!loginId || loginId.length > 64) {
      throw loginHttpError(400, "bad_request", `falta o loginId deste login; ${ADD_AGAIN}`, true);
    }
    if (typeof body.code !== "string" || !body.code.trim()) {
      throw loginHttpError(400, "bad_code", "cole o código que a página da Anthropic mostrou depois de entrar na conta", false);
    }
    if (typeof engine.storeFreshLogin !== "function") throw new HttpError(501, "not_implemented", "este servidor ainda não sabe guardar contas");

    let login;
    try {
      login = await claudeLogin.finish(loginId, body.code, { owner: sess.id });
    } catch (e) {
      if (e && typeof e.code === "string" && Number.isInteger(e.status)) {
        throw loginHttpError(e.status, e.code, hideTokens(e.message).slice(0, 400), e.restart);
      }
      throw e;
    }
    const email = login.email;
    let r;
    try {
      r = await engine.storeFreshLogin({ claudeAiOauth: login.claudeAiOauth, oauthAccount: login.oauthAccount, plan: login.plan || undefined });
    } catch (e) {
      const code = e && typeof e.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(e.code) ? e.code : null;
      if (!code) throw e; // erro inesperado → 500 genérico (server.js), sem detalhes
      const known = ADD_LOGIN_ERRORS[code];
      const detail = hideTokens(typeof e.message === "string" ? e.message : "").slice(0, 300);
      log.warn(`[painel] conta da assinatura (${email}) recusada pelo motor: ${code}`);
      const message = known ? (code.startsWith("identity_mismatch") && detail ? `${known[1]} (${detail})` : known[1]) : detail || "o servidor recusou a conta";
      throw loginHttpError(known ? known[0] : 422, code, message, true);
    } finally {
      login = null; // os tokens não ficam presos aqui
    }
    const number = r && r.number;
    const created = !!(r && r.created);
    pushHistory(
      "info",
      created ? `Conta ${number} adicionada pelo painel (login da assinatura)` : `Conta ${number} atualizada pelo painel (login da assinatura)`,
      null
    );
    await saveQuiet("histórico");
    log.info(`[painel] ${me} adicionou pela assinatura a conta ${number} (${created ? "nova" : "já existia: login atualizado"})`);
    const message = created
      ? `Conta ${number} adicionada (${email}). O servidor guarda e renova o login dela.`
      : `A conta ${number} (${email}) já estava no servidor: o login dela foi atualizado com este.`;
    return done(sess, { number, created, email, message });
  }

  const change = { change: true };
  const routes = [
    { m: "GET", p: /^\/$/, fn: () => staticFile("index.html") },
    { m: "GET", p: /^\/static\/(app\.js|app\.css)$/, fn: ({ params }) => staticFile(params[0]) },
    { m: "POST", p: /^\/web\/logout$/, body: true, fn: logout },
    {
      m: "GET",
      p: /^\/web\/api\/me$/,
      fn: panel(({ sess }) => ({ email: sess.s.email, admin: isAdmin(sess.s.email), csrf: sess.s.csrf, expiresAt: sess.s.expiresAt })),
    },
    { m: "GET", p: /^\/web\/api\/state$/, fn: panel(({ sess }) => panelState(sess)) },
    { m: "PUT", p: /^\/web\/api\/rules$/, body: true, fn: panel(putRules, change) },
    { m: "PATCH", p: /^\/web\/api\/accounts\/(\d{1,6})$/, body: true, fn: panel(patchAccount, change) },
    { m: "DELETE", p: /^\/web\/api\/accounts\/(\d{1,6})$/, fn: panel(deleteAccount, change) },
    { m: "PUT", p: /^\/web\/api\/accounts\/(\d{1,6})\/devices$/, body: true, fn: panel(putAccountDevices, change) },
    { m: "POST", p: /^\/web\/api\/devices\/([A-Za-z0-9_-]{1,64})\/switch$/, body: true, fn: panel(switchDevice, change) },
    { m: "PATCH", p: /^\/web\/api\/devices\/([A-Za-z0-9_-]{1,64})$/, body: true, fn: panel(patchDevice, change) },
    { m: "DELETE", p: /^\/web\/api\/devices\/([A-Za-z0-9_-]{1,64})$/, fn: panel(deleteDevice, change) },
    { m: "POST", p: /^\/web\/api\/allowed$/, body: true, fn: panel(allow, change) },
    { m: "DELETE", p: /^\/web\/api\/allowed\/([^/]{1,400})$/, fn: panel(deny, change) },
    { m: "POST", p: /^\/web\/api\/pair-code$/, body: true, fn: panel(pairCode, change) },
    { m: "GET", p: /^\/web\/api\/sessions$/, fn: panel(({ sess }) => sessionsPublic(sess.id)) },
    { m: "DELETE", p: /^\/web\/api\/sessions\/([A-Za-z0-9_-]{1,40})$/, fn: panel(deleteSession, change) },
    { m: "GET", p: /^\/web\/api\/recovery-kit$/, fn: panel(recoveryKit, { csrf: true }) },
    { m: "POST", p: /^\/web\/api\/claude-login\/start$/, body: true, fn: panel(claudeLoginStart, change) },
    { m: "POST", p: /^\/web\/api\/claude-login\/finish$/, body: true, fn: panel(claudeLoginFinish, change) },
  ];

  /** Caminhos do painel (respostas com o webReplacer; 401 contam no limite do painel, não no dos computadores). */
  const ownsPath = (p) => p === "/" || p.startsWith("/static/") || p.startsWith("/web/");

  return {
    routes,
    ownsPath,
    webDir,
    panelOn,
    panelOffError,
    createSession,
    findSession,
    dropSession,
    dropSessionsOf,
    sweepSessions,
    sessionCookie,
    clearSessionCookie,
    clearLoginCookie,
    newLoginBinding,
    loginBindingOk,
    panelState,
  };
}

module.exports = {
  createWeb,
  webReplacer,
  uaSummary,
  readCookies,
  PANEL_CSP,
  PANEL_HEADERS,
  STATIC_FILES,
  SESSION_COOKIE,
  LOGIN_COOKIE,
  SESSION_TTL_MS,
  DEFAULT_WEB_DIR,
};
