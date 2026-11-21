"use strict";
// Swap Plus Servidor — API HTTP(S) para os serviços, pareamento e admin local.
// Ponto de entrada: node server/src/server.js (na imagem: /app/server/src/server.js).
//
// - API (PORT): HTTPS com certificado próprio (TLS_MODE=self, o cliente fixa a
//   impressão digital) ou HTTP puro atrás de um proxy que faz o TLS (TLS_MODE=off).
//   Cada serviço se autentica com o token de dispositivo recebido no pareamento;
//   o servidor guarda só o sha256 dele.
// - Admin local (127.0.0.1:ADMIN_PORT, sem senha): só alcançável de dentro do
//   container. Gera o código de pareamento, mostra o estado, revoga dispositivos.
//   É o que o cli.js usa e o que o HEALTHCHECK do Docker consulta.
// - O refresh token nunca sai daqui: nem em resposta, nem em log. Access tokens
//   só saem em GET /v1/credential (é para isso que ele existe) e nunca vão para log.
// - Login com Google (opcional, além do código de pareamento): o dono libera quais
//   contas Google podem conectar serviços (cli.js allow <email>). Fluxo de
//   "login de dispositivo" em /v1/login/* e /auth/google/* (detalhes em google.js).
//   code, tokens, id_token e client_secret nunca vão para log.
// - Painel web (mesma porta e origem, WEB-SPEC.md): GET / (página), /static/*, /web/login
//   (login com Google do tipo "web", aqui) e /web/logout + /web/api/* (sessão por cookie e CSRF,
//   em web.js). Só o ADMINISTRADOR entra no painel: ADMIN_EMAILS (variável de ambiente, lida na
//   subida, sem jeito de mudar pelo painel nem pela API). Sem ADMIN_EMAILS o painel fica desligado.
//   As contas Google liberadas (allow) só conectam serviços; o administrador também conecta,
//   sem precisar estar na lista. E-mails são comparados por emailKey() (google.js): minúsculas e,
//   no Gmail, sem pontos e sem "+algo".
// - Só os serviços do ADMINISTRADOR enviam logins (POST /v1/logins; canUploadLogins): conectados com Google
//   com e-mail de ADMIN_EMAILS, ou pareados por código (o código só sai da linha de comando/painel do administrador).
//   Os outros recebem 403 not_admin (sem chegar ao motor nem à Anthropic) e usam as contas do servidor.
// - Avisos por e-mail ao dono (notify.js): o main() monta o createNotifier(DATA_DIR) e passa ao motor, que grava os
//   avisos em DATA_DIR/avisos/ (login vencendo, conta morta, cofre sem gravar). NOTICES_ENABLED=0 desliga.

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { RULE_DEFAULTS } = require("../../plus/rules");
const {
  PAGE_HEADERS,
  emailKey,
  sameEmail,
  loadGoogleConfig,
  LoginSessions,
  authRedirectUrl,
  exchangeCode,
  readIdToken,
  renderPage,
} = require("./google");
const { createWeb, webReplacer, uaSummary } = require("./web");
const access = require("./access");

const VERSION = "2.5.3";
const MAX_BODY = 256 * 1024; // corpo máximo aceito
const HARD_BODY = MAX_BODY * 4; // acima disso nem lê o resto: responde 413 e fecha
const PAIR_TTL_MS = 10 * 60 * 1000;
const PAIR_MAX_ERRORS = 5;
const PAIR_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const PAIR_LEN = 10;
const CONNECT_PREFIX = "swapplus1:";
const FAIL_WINDOW_MS = 10 * 60 * 1000; // janela das tentativas sem autorização
const FAIL_LIMIT = 20; // respostas 401 por IP na janela
const WEB_FAIL_LIMIT = 60; // respostas 401 do painel web por IP na janela (contador à parte)
const BLOCK_MS = 10 * 60 * 1000; // bloqueio depois do limite
// Limite de pedidos por IP nas rotas do login com Google (sem autenticação), por janela de 10 min.
const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_LIMITS = {
  loginStart: 10, // POST /v1/login/start
  loginPoll: 600, // POST /v1/login/poll (o VS Code pergunta a cada ~2 s)
  googleStart: 30, // GET /auth/google/start (navegador)
  googleCallback: 30, // GET /auth/google/callback (navegador)
  webLogin: 20, // GET /web/login (painel web)
};
const LOGIN_SWEEP_MS = 60 * 1000; // limpeza das sessões de login vencidas
const PANEL_SECTIONS = new Set(["geral", "computadores", "regras", "acesso", "historico"]); // ?next= do /web/login
const DEFAULT_RESTIC_PASS_FILE = "/run/secrets/restic_swap_plus_pass"; // senha do backup (kit de recuperação; opcional)
// Encerramento (SIGTERM): espera o motor terminar o que está fazendo, grava o cofre (tentando de novo se falhar) e sai.
const STOP_ENGINE_WAIT_MS = 52 * 1000; // cobre uma renovação lenta (até 45 s) que já estava em voo
const STOP_SAVE_RETRY_MS = 5 * 1000;
const STOP_HARD_MS = 62 * 1000; // saída forçada (o compose dá 75 s: stop_grace_period)
const NOT_ADMIN_TEXT = "Só os serviços do administrador enviam logins ao servidor. Este serviço usa as contas do servidor.";

const DEFAULT_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const DEFAULT_API_BASE = "https://api.anthropic.com";

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

class HttpError extends Error {
  constructor(status, error, message, headers) {
    super(message);
    this.status = status;
    this.error = error;
    this.headers = headers || undefined;
  }
}

/**
 * Erro das rotas do navegador (/auth/...): vira uma página HTML.
 * lines: parágrafos (texto ou lista de pedaços com { b: "negrito" }), ver renderPage().
 */
function pageError(status, error, heading, lines, tone = "erro", headers) {
  const plain = lines.map((l) => (Array.isArray(l) ? l.map((x) => (isObj(x) ? x.b : x)).join("") : l)).join(" ");
  const e = new HttpError(status, error, plain, headers);
  e.page = { tone, title: heading, heading, lines };
  return e;
}

/** Resposta que não é JSON (página HTML ou redirecionamento), devolvida pelas rotas do navegador. */
class RawReply {
  constructor(status, headers, body) {
    this.status = status;
    this.headers = headers || {};
    this.body = body || "";
  }
}

/** Resposta JSON com status/cabeçalhos próprios (ex.: Set-Cookie do painel). */
class JsonReply {
  constructor(status, body, headers) {
    this.status = status;
    this.body = body;
    this.headers = headers || undefined;
  }
}

/** Página HTML com os cabeçalhos de segurança (CSP, sem iframe, sem Referer, sem cache). */
const pageReply = (status, page, headers) => new RawReply(status, headers, renderPage(page));

const bad = (message) => new HttpError(400, "bad_request", message);
const hasOwn = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const sha256hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

/** Compara dois sha256 em hex sem vazar tempo. */
function sameHash(aHex, bHex) {
  if (typeof aHex !== "string" || typeof bHex !== "string" || aHex.length !== 64 || bHex.length !== 64) return false;
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === 32 && b.length === 32 && crypto.timingSafeEqual(a, b);
}

/** Tira tokens da Anthropic de qualquer texto (defesa extra para logs e mensagens). */
function redact(s) {
  return String(s == null ? "" : s).replace(/sk-ant-[A-Za-z0-9_-]{6,}/g, "sk-ant-[oculto]");
}

// Chaves que nunca saem em resposta, mesmo que o engine as devolva por engano.
const NEVER_SEND = new Set(["refreshToken", "refresh_token", "tokenHash"]);
const responseReplacer = (k, v) => (NEVER_SEND.has(k) ? undefined : v);
// Em log, nenhum campo com "token" no nome.
const logReplacer = (k, v) => (/token/i.test(k) ? undefined : v);

/** Texto livre vindo do cliente: sem caracteres de controle, aparado e curto. */
function cleanText(v, max) {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001f\u007f‪-‮⁦-⁩]/g, "")
    .trim()
    .slice(0, max);
}

/** "AAAA-MM-DD" no fuso do servidor. */
function localDay(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** E-mail (conta Google) em minúsculas, ou null se não parecer um e-mail. */
function cleanEmail(v) {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && /^[^\s@<>"'(),;:\\]+@[^\s@<>"'(),;:\\]+\.[^\s@<>"'(),;:\\]+$/.test(e) ? e : null;
}

function createLogger(out = process.stdout, err = process.stderr) {
  const pad = (n) => String(n).padStart(2, "0");
  const ts = () => {
    const d = new Date();
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };
  const fmt = (a) => {
    if (a instanceof Error) return a.message;
    if (typeof a === "string") return a;
    try {
      return JSON.stringify(a, logReplacer);
    } catch {
      return String(a);
    }
  };
  const line = (stream) => (...args) => stream.write(`${ts()} ${redact(args.map(fmt).join(" "))}\n`);
  return { log: line(out), info: line(out), debug: line(out), warn: line(err), error: line(err) };
}

// ---------------------------------------------------------------------------
// Configuração (variáveis de ambiente)
// ---------------------------------------------------------------------------

function intEnv(v, def, name) {
  if (v === undefined || v === null || String(v).trim() === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${name} inválido: "${v}"`);
  return n;
}

function ipv4ToInt(s) {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s || "").trim());
  if (!m) return null;
  let n = 0;
  for (let i = 1; i <= 4; i++) {
    const p = Number(m[i]);
    if (p > 255) return null;
    n = n * 256 + p;
  }
  return n; // 0 .. 2^32-1 (sem operações de bit, para não virar negativo)
}

/** "203.0.113.7, 10.0.0.0/8" → [{ text, start, size }]. Lança erro em entrada inválida. */
function parseAllowIps(raw) {
  const out = [];
  for (const item of String(raw || "").split(/[\s,;]+/)) {
    if (!item) continue;
    const parts = item.split("/");
    const base = ipv4ToInt(parts[0]);
    const bitsOk = parts.length === 1 || (parts.length === 2 && /^\d{1,2}$/.test(parts[1]) && Number(parts[1]) <= 32);
    if (base === null || !bitsOk) {
      throw new Error(`ALLOW_IPS: entrada inválida "${item}" (use IPv4, ex. 203.0.113.7, ou CIDR, ex. 10.0.0.0/8)`);
    }
    const bits = parts.length === 2 ? Number(parts[1]) : 32;
    const size = 2 ** (32 - bits);
    out.push({ text: item, start: Math.floor(base / size) * size, size });
  }
  return out;
}

/**
 * ADMIN_EMAILS: "a@gmail.com, b@empresa.com" (vírgula; espaço e ponto e vírgula também servem) ou lista.
 * → { list: [e-mails aparados, em minúsculas, sem repetidos pela emailKey], invalid: [entradas que não são e-mail] }.
 * Não lança: uma entrada errada não pode derrubar o servidor (ele renova os logins); quem chama avisa no log.
 */
function parseAdminEmails(raw) {
  const items = Array.isArray(raw) ? raw.map((x) => (typeof x === "string" ? x : "")) : String(raw || "").split(/[\s,;]+/);
  const list = [];
  const invalid = [];
  const seen = new Set();
  for (const item of items) {
    const txt = String(item || "").trim();
    if (!txt) continue;
    const e = cleanEmail(txt);
    if (!e) {
      invalid.push(txt.slice(0, 80));
      continue;
    }
    const k = emailKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    list.push(e);
  }
  return { list, invalid };
}

function ipAllowed(ip, list) {
  if (!list || list.length === 0) return true;
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  return list.some((r) => n >= r.start && n < r.start + r.size);
}

function normalizeIp(ip) {
  let s = String(ip || "").trim();
  if (/^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(s)) s = s.slice(7);
  else if (/^\d+\.\d+\.\d+\.\d+:\d+$/.test(s)) s = s.replace(/:\d+$/, ""); // "1.2.3.4:5678" em X-Forwarded-For
  if (s === "::1") s = "127.0.0.1";
  return s;
}

function clientIp(req, trustProxy) {
  if (trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = typeof xff === "string" ? xff.split(",")[0].trim() : "";
    if (first) return normalizeIp(first);
  }
  return normalizeIp(req.socket && req.socket.remoteAddress);
}

function loadConfig(env = process.env) {
  const tlsMode = String(env.TLS_MODE || "self").trim().toLowerCase();
  if (tlsMode !== "self" && tlsMode !== "off") throw new Error(`TLS_MODE inválido: "${env.TLS_MODE}" (use self ou off)`);
  const port = intEnv(env.PORT, 8443, "PORT");
  const publicHost = String(env.PUBLIC_HOST || "").trim();
  let publicUrl = String(env.PUBLIC_URL || "").trim().replace(/\/+$/, "");
  if (!publicUrl && tlsMode === "self" && publicHost) {
    publicUrl = `https://${publicHost.includes(":") ? `[${publicHost}]` : publicHost}:${port}`;
  }
  if (publicUrl) {
    let u;
    try {
      u = new URL(publicUrl);
    } catch {
      throw new Error(`PUBLIC_URL inválida: "${publicUrl}"`);
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`PUBLIC_URL precisa começar com https:// ou http:// ("${publicUrl}")`);
  }
  const admins = parseAdminEmails(env.ADMIN_EMAILS);
  return {
    dataDir: env.DATA_DIR || "/data",
    masterKeyFile: env.MASTER_KEY_FILE || "/run/secrets/swap_plus_master_key",
    // Senha do backup (restic), só para o kit de recuperação do painel. Opcional: sem o arquivo, "não disponível".
    resticPassFile: String(env.RESTIC_PASS_FILE || "").trim() || DEFAULT_RESTIC_PASS_FILE,
    // Administrador(es) do painel: lido só aqui, na subida (o painel e a API não mudam). Vazio = painel desligado.
    adminEmails: admins.list,
    adminEmailsInvalid: admins.invalid,
    port,
    adminPort: intEnv(env.ADMIN_PORT, 8444, "ADMIN_PORT"),
    tlsMode,
    publicUrl,
    publicHost,
    trustProxy: /^(1|true|sim|yes)$/i.test(String(env.TRUST_PROXY || "0").trim()),
    allowIps: parseAllowIps(env.ALLOW_IPS),
    tokenUrl: env.ANTHROPIC_TOKEN_URL || DEFAULT_TOKEN_URL,
    apiBase: env.ANTHROPIC_API_BASE || DEFAULT_API_BASE,
    fingerprint: null, // preenchido pelo main() a partir do certificado (TLS_MODE=self)
    // Login com Google: GOOGLE_CLIENT_ID_FILE / GOOGLE_CLIENT_SECRET_FILE (lidos agora, na subida),
    // GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL. Faltando algo, fica desligado (google.enabled = false).
    google: loadGoogleConfig(env, publicUrl),
  };
}

// ---------------------------------------------------------------------------
// HTTP: corpo, respostas, erros, rotas
// ---------------------------------------------------------------------------

/** Página HTML, arquivo do painel ou redirecionamento (RawReply), sempre com os cabeçalhos de segurança. */
function sendRaw(res, r) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(String(r.body || ""), "utf8");
  res.writeHead(r.status, { ...PAGE_HEADERS, "Content-Length": body.length, ...(r.headers || {}) });
  res.end(body);
}

/** Query string da URL pedida (sem o fragmento). */
function parseQuery(url) {
  const s = String(url || "");
  const i = s.indexOf("?");
  if (i < 0) return new URLSearchParams();
  return new URLSearchParams(s.slice(i + 1).split("#")[0].slice(0, 8192));
}

/** Página para um erro qualquer (rotas do navegador). */
function pageOf(he) {
  if (he.page) return he.page;
  const heading =
    he.status === 429
      ? "Tentativas demais"
      : he.status === 403
        ? "Acesso negado"
        : he.status === 404 || he.status === 405
          ? "Página não encontrada"
          : he.status >= 500
            ? "Erro no servidor"
            : "Não deu certo";
  const msg = String(he.message || "");
  return { tone: "erro", title: heading, heading, lines: [msg ? msg.charAt(0).toUpperCase() + msg.slice(1) + "." : ""] };
}

function sendJson(res, status, obj, headers, replacer = responseReplacer) {
  if (res.headersSent || res.destroyed || res.writableEnded) return;
  const body = JSON.stringify(obj === undefined ? null : obj, replacer);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...(headers || {}),
  });
  res.end(body);
}

const tooLarge = (close) =>
  new HttpError(413, "too_large", `corpo grande demais (máximo ${MAX_BODY / 1024} KB)`, close ? { Connection: "close" } : undefined);

/** Lê o corpo inteiro (até MAX_BODY). Acima disso descarta e responde 413. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"]);
    if (Number.isFinite(declared) && declared > HARD_BODY) {
      reject(tooLarge(true));
      return;
    }
    const chunks = [];
    let size = 0;
    let over = false;
    let done = false;
    const finish = (err, val) => {
      if (done) return;
      done = true;
      if (err) reject(err);
      else resolve(val);
    };
    req.on("data", (c) => {
      if (done) return;
      size += c.length;
      if (size > HARD_BODY) {
        req.pause();
        finish(tooLarge(true));
        return;
      }
      if (size > MAX_BODY) {
        over = true; // continua lendo (e jogando fora) para conseguir responder 413 limpo
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => finish(over ? tooLarge(false) : null, over ? undefined : Buffer.concat(chunks)));
    req.on("error", () => finish(new HttpError(400, "bad_request", "falha ao ler o corpo da requisição")));
    req.on("close", () => finish(new HttpError(400, "aborted", "a conexão fechou antes do fim do corpo")));
  });
}

function parseJson(buf) {
  if (!buf || buf.length === 0) return {};
  let v;
  try {
    v = JSON.parse(buf.toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json", "o corpo não é um JSON válido");
  }
  if (!isObj(v)) throw new HttpError(400, "bad_request", "o corpo precisa ser um objeto JSON");
  return v;
}

/** Erro qualquer → HttpError. Erros com .code (do engine) viram 4xx com a mensagem; o resto, 500 genérico. */
function toHttpError(e) {
  if (e instanceof HttpError) return e;
  const code = e && typeof e.code === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(e.code) ? e.code : null;
  if (code) {
    // not_allowed: a conta não está liberada para este serviço (engine.switchDevice) → 409, como no ERROR_STATUS do motor.
    // not_admin: login de um serviço que não é do administrador (engine.addLogin) → 403.
    const status =
      code === "not_found" ? 404 : code === "not_admin" ? 403 : code === "no_account" || code === "conflict" || code === "not_allowed" ? 409 : 422;
    const message = redact(typeof e.message === "string" ? e.message : "").slice(0, 300) || "operação recusada";
    return new HttpError(status, code, message);
  }
  const he = new HttpError(500, "internal", "erro interno no servidor");
  he.internal = true;
  return he;
}

function cleanPath(url) {
  let p = String(url || "/").split("?")[0].split("#")[0];
  if (p.length > 1) p = p.replace(/\/+$/, "");
  return p || "/";
}

function matchRoute(routes, method, pathname) {
  const allow = [];
  for (const r of routes) {
    const m = r.p.exec(pathname);
    if (!m) continue;
    if (r.m === method) return { route: r, params: m.slice(1) };
    allow.push(r.m);
  }
  if (allow.length) throw new HttpError(405, "method_not_allowed", "método não aceito nesta rota", { Allow: allow.join(", ") });
  throw new HttpError(404, "not_found", "rota não encontrada");
}

// ---------------------------------------------------------------------------
// Limite de tentativas sem autorização (por IP)
// ---------------------------------------------------------------------------

function createLimiter(now, limit = FAIL_LIMIT) {
  const map = new Map(); // ip → { fails: [ms], blockedUntil }
  const sweep = (t) => {
    for (const [ip, e] of map) {
      if (e.blockedUntil <= t && !e.fails.some((x) => t - x < FAIL_WINDOW_MS)) map.delete(ip);
    }
  };
  return {
    /** ms restantes de bloqueio (0 = livre). */
    blockedFor(ip) {
      const e = map.get(ip);
      if (!e) return 0;
      const left = e.blockedUntil - now();
      return left > 0 ? left : 0;
    },
    /** Registra um 401. Devolve true quando este 401 acabou de bloquear o IP. */
    fail(ip) {
      const t = now();
      let e = map.get(ip);
      if (!e) {
        if (map.size >= 10000) sweep(t);
        e = { fails: [], blockedUntil: 0 };
        map.set(ip, e);
      }
      e.fails = e.fails.filter((x) => t - x < FAIL_WINDOW_MS);
      e.fails.push(t);
      if (e.fails.length >= limit) {
        e.fails = [];
        e.blockedUntil = t + BLOCK_MS;
        return true;
      }
      return false;
    },
  };
}

/**
 * Contador de pedidos por chave (ex.: "loginStart:203.0.113.7") numa janela deslizante.
 * hit(key, limite) → 0 se pode, ou ms até liberar (o pedido recusado não conta).
 */
function createRateCounter(now, windowMs = RATE_WINDOW_MS) {
  const map = new Map(); // chave → [ms dos pedidos aceitos na janela]
  const sweep = (t) => {
    for (const [k, arr] of map) if (!arr.length || t - arr[arr.length - 1] >= windowMs) map.delete(k);
  };
  return {
    hit(key, limit) {
      const t = now();
      let arr = map.get(key);
      if (!arr) {
        if (map.size >= 20000) sweep(t);
        arr = [];
        map.set(key, arr);
      }
      while (arr.length && t - arr[0] >= windowMs) arr.shift();
      if (arr.length >= limit) return Math.max(1, arr[0] + windowMs - t);
      arr.push(t);
      return 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Validação dos corpos
// ---------------------------------------------------------------------------

function cleanRules(rules) {
  if (rules === null) return null; // null = voltar ao padrão
  if (!isObj(rules)) throw bad("rules precisa ser um objeto");
  const out = {};
  for (const [k, v] of Object.entries(rules)) {
    if (!hasOwn(RULE_DEFAULTS, k)) continue; // chave desconhecida: ignora
    const def = RULE_DEFAULTS[k];
    if (typeof def === "number") {
      if (typeof v !== "number" || !Number.isFinite(v)) throw bad(`regra ${k}: precisa ser um número`);
      out[k] = v;
    } else if (typeof def === "boolean") {
      if (typeof v !== "boolean") throw bad(`regra ${k}: precisa ser true ou false`);
      out[k] = v;
    } else {
      if (v !== null && (typeof v !== "string" || v.length > 60)) throw bad(`regra ${k}: precisa ser um texto curto`);
      out[k] = v;
    }
  }
  return out;
}

function numOrNull(v, name, min, max) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? Number(v.trim()) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) throw bad(`${name} precisa ser um número entre ${min} e ${max}`);
  return n;
}

function cleanAccountPatch(body) {
  const patch = {};
  if (hasOwn(body, "disabled")) {
    if (typeof body.disabled !== "boolean") throw bad("disabled precisa ser true ou false");
    patch.disabled = body.disabled;
  }
  // Linhas próprias da conta (sessão 5h, semanal, modelo): 50–100, ou null/"" = a regra geral.
  for (const k of ["threshold", "weeklyThreshold", "modelThreshold"]) {
    if (hasOwn(body, k)) patch[k] = numOrNull(body[k], k, 50, 100);
  }
  if (hasOwn(body, "priority")) patch.priority = numOrNull(body.priority, "priority", -1000, 1000) ?? 0;
  if (hasOwn(body, "alias")) {
    if (body.alias !== null && typeof body.alias !== "string") throw bad("alias precisa ser um texto ou null");
    patch.alias = cleanText(body.alias, 40) || null;
  }
  if (Object.keys(patch).length === 0) throw bad("nada para mudar (use disabled, threshold, weeklyThreshold, modelThreshold, priority ou alias)");
  return patch;
}

// ---------------------------------------------------------------------------
// Aplicação (handlers sem portas — usada pelo main() e pelos testes)
// ---------------------------------------------------------------------------

/**
 * createApp({ store, engine, config, now?, log?, fetchImpl? })
 *   → { api, admin, newPairCode, revokeDevice, status, limiter, webLimiter, sweepLogins, sweepWebSessions,
 *       allowEmail, denyEmail, googleInfo, web }
 *   api / admin: handlers (req, res) para http(s).createServer.
 *   fetchImpl: usado só na troca do code com o Google.
 *   config.webDir: pasta dos arquivos do painel (padrão server/web, ao lado de src/).
 *   config.adminEmails: administrador(es) do painel (de ADMIN_EMAILS; lido uma vez, aqui). Vazio = painel desligado.
 *     Também decide quem envia logins (canUploadLogins) e é passado ao motor (engine.setAdminCheck).
 *   config.masterKeyFile / config.resticPassFile: lidos só no kit de recuperação do painel.
 */
function createApp({ store, engine, config, now = Date.now, log = createLogger(), fetchImpl = fetch }) {
  if (!store || !store.state) throw new Error("createApp: o cofre precisa estar carregado (store.load())");
  if (!engine) throw new Error("createApp: falta o engine");
  config = config || {};
  const allowIps = Array.isArray(config.allowIps) ? config.allowIps : parseAllowIps(config.allowIps);
  const trustProxy = !!config.trustProxy;
  const startedAt = now();
  const limiter = createLimiter(now);
  const webLimiter = createLimiter(now, WEB_FAIL_LIMIT); // 401 do painel: contador à parte (não bloqueia os serviços)
  const google = isObj(config.google) ? config.google : { enabled: false, offReason: "login com Google não configurado" };
  const logins = new LoginSessions({ now });
  const rates = createRateCounter(now);
  // Administrador(es) do painel: lidos uma vez, aqui (config da subida). Nada no painel nem na API muda esta lista.
  const adminParsed = parseAdminEmails(config.adminEmails);
  const adminEmails = Object.freeze([...adminParsed.list]);
  const adminKeys = new Set(adminEmails.map(emailKey));
  const badAdmins = [...new Set([...(Array.isArray(config.adminEmailsInvalid) ? config.adminEmailsInvalid : []), ...adminParsed.invalid])];
  if (badAdmins.length) log.warn(`[painel] ADMIN_EMAILS: entrada(s) que não são e-mail, ignorada(s): ${badAdmins.join(", ")}`);
  if (!adminEmails.length) {
    log.warn("[painel] ADMIN_EMAILS não definido: o painel web fica DESLIGADO (os serviços seguem funcionando). Defina ADMIN_EMAILS=seu-email@gmail.com no compose e reinicie.");
  }
  const isAdmin = (email) => {
    const k = emailKey(email);
    return !!k && adminKeys.has(k);
  };
  /**
   * O serviço pode enviar logins (POST /v1/logins)? Só os do administrador: conectado com Google com e-mail de
   * ADMIN_EMAILS (desta subida: quem sai da lista deixa de poder depois do reinício) ou pareado por código
   * (googleEmail nulo: o código só sai da linha de comando/painel do administrador). Mesma regra do engine.canUploadLogins.
   */
  const canUploadLogins = (d) => isObj(d) && (!d.googleEmail || isAdmin(d.googleEmail));
  // O motor usa a mesma lista (stateFor → device.canUploadLogins e a segunda trava do addLogin).
  if (typeof engine.setAdminCheck === "function") engine.setAdminCheck(isAdmin);

  const state = () => {
    const st = store.state;
    if (!isObj(st.devices)) st.devices = {};
    if (!isObj(st.accounts)) st.accounts = {};
    if (!Array.isArray(st.allowedEmails)) st.allowedEmails = [];
    if (!isObj(st.webSessions)) st.webSessions = {};
    return st;
  };
  const saveQuiet = (why) => store.save().catch((e) => log.warn(`[cofre] não consegui gravar (${why}): ${redact(e && e.message)}`));

  const pushHistory = (kind, text, deviceId) => {
    try {
      if (typeof engine.pushHistory === "function") engine.pushHistory(kind, text, deviceId);
    } catch (e) {
      log.warn(`[histórico] não consegui registrar: ${e.message}`);
    }
  };

  const fingerprint = () => (config.tlsMode === "self" ? config.fingerprint || null : null);

  const devicePublic = (d, meId) => ({
    id: d.id,
    name: d.name,
    platform: d.platform || null,
    googleEmail: d.googleEmail || null, // conta Google com que conectou (null = código de pareamento)
    createdAt: d.createdAt ?? null,
    lastSeen: d.lastSeen ?? null,
    assigned: d.assigned ?? null,
    current: !!meId && d.id === meId,
  });

  const devicesList = (meId) =>
    Object.values(state().devices)
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
      .map((d) => devicePublic(d, meId));

  const accountExists = (n) => hasOwn(state().accounts, String(n));

  /** Token Bearer → dispositivo (ou null). Compara com todos, em tempo constante por item. */
  function authenticate(req) {
    const h = req.headers.authorization;
    if (typeof h !== "string") return null;
    const m = /^Bearer[ ]+([A-Za-z0-9_-]{20,200})[ ]*$/.exec(h);
    if (!m) return null;
    const hash = sha256hex(m[1]);
    let found = null;
    for (const d of Object.values(state().devices)) {
      if (sameHash(hash, d && d.tokenHash)) found = d;
    }
    return found;
  }

  const stateOf = async (device) => {
    const s = await engine.stateFor(device.id);
    // Quem decide é o servidor (ADMIN_EMAILS desta subida); o motor recebe a mesma lista, aqui só garante o campo.
    if (isObj(s) && isObj(s.device)) s.device.canUploadLogins = canUploadLogins(device);
    return s;
  };

  // ----- pareamento -----

  function normalizeCode(v) {
    return typeof v === "string" ? v.toUpperCase().replace(/[\s-]/g, "").slice(0, 40) : "";
  }

  function newDeviceId() {
    for (;;) {
      const id = crypto.randomBytes(6).toString("hex");
      if (!hasOwn(state().devices, id)) return id;
    }
  }

  /**
   * Cria o dispositivo (pareamento por código ou login com Google) → { id, token }.
   * Só o sha256 do token fica no cofre; quem chama grava o cofre.
   */
  function createDevice({ name, platform, googleEmail = null }) {
    const t = now();
    const id = newDeviceId();
    const token = crypto.randomBytes(32).toString("base64url");
    state().devices[id] = {
      id,
      name,
      platform,
      googleEmail: googleEmail || null,
      tokenHash: sha256hex(token),
      createdAt: t,
      lastSeen: t,
      assigned: null,
      lastSwitchAt: 0,
      models: [],
    };
    return { id, token };
  }

  async function newPairCode() {
    if (!config.publicUrl) {
      throw new HttpError(
        400,
        "no_public_url",
        "defina PUBLIC_URL (ou PUBLIC_HOST com TLS_MODE=self) para gerar o código de conexão"
      );
    }
    let code = "";
    for (let i = 0; i < PAIR_LEN; i++) code += PAIR_ALPHABET[crypto.randomInt(PAIR_ALPHABET.length)];
    const expiresAt = now() + PAIR_TTL_MS;
    state().pairing = { codeHash: sha256hex(code), expiresAt, attempts: 0 };
    await store.save();
    const fp = fingerprint();
    const connect = CONNECT_PREFIX + Buffer.from(JSON.stringify({ url: config.publicUrl, code, fp }), "utf8").toString("base64url");
    log.info(`[pareamento] código novo gerado (vale 10 min, uso único)`);
    return { code, expiresAt, connect, url: config.publicUrl, fp };
  }

  async function pair({ body, ip, ctx }) {
    const st = state();
    const p = st.pairing;
    if (!p || !p.codeHash) {
      throw new HttpError(401, "invalid_code", "não há código de pareamento ativo; gere um novo no servidor (cli.js pair)");
    }
    if (!(now() <= p.expiresAt)) {
      st.pairing = null;
      await store.save();
      throw new HttpError(401, "code_expired", "o código de pareamento venceu; gere um novo no servidor (cli.js pair)");
    }
    const code = normalizeCode(body.code);
    if (!code || !sameHash(sha256hex(code), p.codeHash)) {
      p.attempts = (Number(p.attempts) || 0) + 1;
      const discarded = p.attempts >= PAIR_MAX_ERRORS;
      if (discarded) {
        st.pairing = null;
        log.warn(`[pareamento] ${PAIR_MAX_ERRORS} códigos errados: código descartado (último de ${ip})`);
      }
      await store.save();
      throw new HttpError(
        401,
        "invalid_code",
        discarded ? "código errado vezes demais; ele foi descartado — gere um novo no servidor" : "código de pareamento errado"
      );
    }
    // Uso único: some antes de qualquer await.
    st.pairing = null;
    const name = cleanText(body.name, 60) || "serviço";
    const platform = cleanText(body.platform, 20) || "desconhecido";
    const { id, token } = createDevice({ name, platform, googleEmail: null });
    ctx.name = name;
    pushHistory("device", `Serviço "${name}" conectado`, id);
    await store.save();
    log.info(`[pareamento] serviço "${name}" (${platform}) conectado, id ${id}, de ${ip}`);
    return { deviceId: id, token };
  }

  /**
   * Depois de `delete st.devices[id]` (e antes de gravar): tira o serviço das listas "Serviços permitidos"
   * das contas (access.js). Lista que fica vazia continua vazia (nenhum serviço — nunca vira "todos"); se isso
   * acontecer, avisa no histórico (quiet: sem aviso, para desfazer o que nunca chegou a valer). → contas que mudaram
   */
  function forgetDevice(st, id, name, { quiet = false } = {}) {
    if (typeof engine.forgetContact === "function") engine.forgetContact(id); // o contato dele (presença) sai da memória do motor
    const changed = access.onDeviceRemoved(st, id);
    if (!quiet) {
      for (const n of changed) {
        const left = access.accountDevicesFor(st, n);
        if (Array.isArray(left) && left.length === 0) {
          pushHistory(
            "alert",
            `A conta ${n} não está liberada para nenhum serviço agora ("${name || id}" era o único); libere outro no painel (Contas → Serviços permitidos)`,
            null
          );
        }
      }
    }
    return changed;
  }

  async function revokeDevice(id, motivo) {
    const st = state();
    if (!hasOwn(st.devices, id)) throw new HttpError(404, "not_found", "serviço não encontrado");
    const d = st.devices[id];
    delete st.devices[id];
    pushHistory("device", `Serviço "${d.name}" desconectado (${motivo})`, id);
    forgetDevice(st, id, d && d.name);
    await store.save();
    log.info(`[dispositivos] "${d.name}" (${id}) ${motivo}`);
    return { ok: true };
  }

  // ----- contas Google liberadas -----

  // ----- contas Google: administrador (ADMIN_EMAILS) e liberadas (lista allowedEmails, só serviços) -----

  const allowedList = () => state().allowedEmails;
  /** Está na lista de contas liberadas (comparação pela emailKey: minúsculas e, no Gmail, sem pontos e sem "+algo")? */
  const isAllowed = (email) => {
    const k = emailKey(email);
    return !!k && allowedList().some((e) => emailKey(e) === k);
  };
  /** Pode conectar serviços com o Google: o administrador ou uma conta liberada. */
  const canConnect = (email) => isAdmin(email) || isAllowed(email);

  function googleInfo() {
    return {
      enabled: !!google.enabled,
      offReason: google.enabled ? null : google.offReason || "login com Google não configurado",
      callbackUrl: google.redirectUri || null,
      adminEmails: [...adminEmails],
      allowedEmails: [...allowedList()],
      pendingLogins: logins.size,
    };
  }

  /**
   * Libera a conta Google a conectar serviços (o painel continua só do administrador). by: quem fez, para o
   * histórico (ex.: "pelo painel (x@y)"). Guarda o e-mail como veio (aparado, minúsculas); repetido pela emailKey
   * não entra de novo. O administrador não precisa (nem entra) na lista: { added: false, admin: true }.
   */
  async function allowEmail(raw, by = null) {
    const email = cleanEmail(raw);
    if (!email) throw bad("e-mail inválido (ex.: pessoa@empresa.com)");
    if (isAdmin(email)) return { ok: true, email, added: false, admin: true, google: googleInfo() };
    const list = allowedList();
    const added = !isAllowed(email);
    if (added) {
      list.push(email);
      list.sort();
      pushHistory("info", `Conta Google ${email} liberada (conectar serviços pelo VS Code)${by ? ` ${by}` : ""}`, null);
      await store.save();
      log.info(`[google] conta Google ${email} liberada para conectar serviços${by ? ` ${by}` : ""}`);
    }
    return { ok: true, email, added, admin: false, google: googleInfo() };
  }

  /**
   * Tira a conta Google da lista (todas as formas dela, pela emailKey): não conecta serviços novos; os já
   * conectados continuam. O administrador não sai por aqui (ele não depende da lista): 409 "admin".
   */
  async function denyEmail(raw, by = null) {
    const email = typeof raw === "string" ? raw.trim().toLowerCase().slice(0, 320) : "";
    if (!email) throw bad("diga qual e-mail (ex.: deny pessoa@empresa.com)");
    if (isAdmin(email)) {
      throw new HttpError(
        409,
        "admin",
        `${email} é o administrador (ADMIN_EMAILS, definido no servidor): ele não depende da lista de contas liberadas e não pode ser tirado por aqui. Para mudar o administrador, edite ADMIN_EMAILS no compose e reinicie o servidor.`
      );
    }
    const k = emailKey(email);
    const list = allowedList();
    const gone = list.filter((e) => emailKey(e) === k);
    const removed = gone.length > 0;
    for (let i = list.length - 1; i >= 0; i--) if (emailKey(list[i]) === k) list.splice(i, 1);
    // Quem não é administrador não tem sessão no painel; se sobrou alguma (de antes), cai junto.
    const panelSessions = web.dropSessionsOf(email);
    if (removed || panelSessions) {
      const shown = removed ? gone.join(", ") : email;
      if (removed) pushHistory("info", `Conta Google ${shown} tirada da lista (não conecta serviços novos)${by ? ` ${by}` : ""}`, null);
      await store.save();
      if (removed) log.info(`[google] conta Google ${shown} retirada da lista${by ? ` ${by}` : ""}`);
      if (panelSessions) log.info(`[painel] ${panelSessions} sessão(ões) do painel de ${email} encerrada(s)`);
    }
    // Os serviços já conectados com ela continuam (cada um se desconecta à parte: revoke <id>).
    const devices = Object.values(state().devices)
      .filter((d) => isObj(d) && sameEmail(d.googleEmail, email))
      .map((d) => ({ id: d.id, name: d.name }));
    return { ok: true, email, removed, devices, panelSessions, google: googleInfo() };
  }

  // ----- login com Google (padrão "login de dispositivo") -----

  const googleOffJson = () =>
    new HttpError(503, "google_off", "o login com Google não está ligado neste servidor; peça ao dono um código de conexão (cli.js pair)");
  const googleOffPage = () =>
    pageError(503, "google_off", "Login com Google desligado", [
      "O login com Google não está ligado neste servidor.",
      "Peça ao dono do servidor um código de conexão.",
    ]);

  function rateLimit(bucket, ip, html) {
    const wait = rates.hit(`${bucket}:${ip}`, RATE_LIMITS[bucket]);
    if (!wait) return;
    const headers = { "Retry-After": String(Math.ceil(wait / 1000)) };
    if (html) {
      throw pageError(429, "too_many_requests", "Tentativas demais", ["Muitos pedidos deste endereço.", "Espere alguns minutos e tente de novo."], "aviso", headers);
    }
    throw new HttpError(429, "too_many_requests", "pedidos demais deste endereço; espere alguns minutos e tente de novo", headers);
  }

  /**
   * Tira as sessões vencidas. Se uma venceu com o serviço já criado e o VS Code não buscou
   * o acesso (ninguém tem o token), o dispositivo órfão é desfeito.
   */
  async function sweepLogins() {
    let changed = false;
    for (const s of logins.sweep()) {
      const r = s.result;
      if (!r || !r.deviceId) continue;
      const st = state();
      const d = hasOwn(st.devices, r.deviceId) ? st.devices[r.deviceId] : null;
      if (!d || !sameHash(sha256hex(r.token), d.tokenHash)) continue;
      delete st.devices[r.deviceId];
      changed = true;
      pushHistory("device", `Serviço "${d.name}" desconectado (o VS Code não buscou o acesso a tempo depois do login com Google)`, r.deviceId);
      forgetDevice(st, r.deviceId, d.name);
      log.warn(`[google] "${d.name}" (${r.deviceId}) desfeito: o VS Code não buscou o acesso a tempo`);
    }
    if (changed) await store.save();
  }

  const expiredLogin = () => new HttpError(404, "expired", "esse login venceu ou não existe; comece de novo pelo VS Code");

  /** POST /v1/login/start { name, platform } → { sessionId, pollToken, authUrl, expiresAt } */
  async function loginStart({ body, ip, ctx }) {
    if (!google.enabled) throw googleOffJson();
    rateLimit("loginStart", ip, false);
    await sweepLogins();
    const name = cleanText(body.name, 60) || "serviço";
    const platform = cleanText(body.platform, 20) || "desconhecido";
    const made = logins.create({ name, platform, ip });
    if (!made) {
      const wait = Math.max(1000, logins.nextExpiry("device") - now());
      throw new HttpError(429, "too_many_logins", "logins com Google em andamento demais neste servidor; tente de novo em alguns minutos", {
        "Retry-After": String(Math.ceil(wait / 1000)),
      });
    }
    const { session, pollToken } = made;
    ctx.name = name;
    log.info(`[google] login iniciado para "${name}" (${platform}) de ${ip}`);
    return {
      sessionId: session.id,
      pollToken,
      authUrl: `${google.startUrl}?s=${session.id}`,
      expiresAt: session.expiresAt,
    };
  }

  /** POST /v1/login/poll { sessionId, pollToken } → pending | ok (uma vez) | denied | 404 expired */
  async function loginPoll({ body, ip }) {
    if (!google.enabled) throw googleOffJson();
    rateLimit("loginPoll", ip, false);
    await sweepLogins();
    const { sessionId, pollToken } = body;
    if (typeof sessionId !== "string" || typeof pollToken !== "string") throw bad("envie sessionId e pollToken");
    const s = logins.get(sessionId);
    // pollToken errado responde igual a sessão inexistente (não revela que ela existe). Login do painel não tem poll.
    if (!s || s.kind !== "device" || !sameHash(sha256hex(pollToken.slice(0, 200)), s.pollHash)) throw expiredLogin();
    const r = s.result;
    if (!r) return { status: "pending" };
    if (r.denied) return { status: "denied", email: r.denied };
    // Entrega UMA vez e apaga a sessão.
    logins.remove(s);
    if (!hasOwn(state().devices, r.deviceId)) throw expiredLogin(); // revogado antes de buscar
    log.info(`[google] acesso entregue ao VS Code de "${s.name}" (${r.deviceId})`);
    return { status: "ok", deviceId: r.deviceId, token: r.token };
  }

  /** GET /auth/google/start?s=<id> → 302 para o Google (navegador). */
  async function googleStart({ query, ip, ctx }) {
    if (!google.enabled) throw googleOffPage();
    rateLimit("googleStart", ip, true);
    await sweepLogins();
    const s = logins.get(query.get("s") || "");
    // Login do painel vai direto do /web/login para o Google: este link é só dos serviços.
    if (!s || s.kind !== "device") {
      throw pageError(404, "expired", "Link vencido", ["Este link de login venceu ou não existe.", "Volte ao VS Code e comece de novo."], "aviso");
    }
    ctx.name = s.name;
    if (s.result) return finalPage(s);
    return new RawReply(302, { Location: authRedirectUrl(google, s) }, "");
  }

  function successPage(name, email) {
    return pageReply(200, {
      tone: "ok",
      title: "Pronto",
      // Quem conecta nem sempre é o VS Code (o cliente do Hermes também entra por aqui): o texto não cita programa.
      heading: "Pronto! Conectado.",
      lines: [[{ b: name }, " foi conectado ao Swap Plus com a conta Google ", { b: email }, "."], "Pode fechar esta aba e voltar ao que estava fazendo."],
    });
  }

  function deniedPage(email) {
    return pageReply(403, {
      tone: "erro",
      title: "Conta não liberada",
      heading: "Conta não liberada",
      lines: [["A conta Google ", { b: email }, " não está liberada neste servidor."], "Peça ao dono para liberar."],
    });
  }

  /** Recusa do login do painel (e apaga o cookie do login). */
  function panelDeniedPage(email) {
    return pageReply(
      403,
      {
        tone: "erro",
        title: "Conta não liberada",
        heading: "Conta não liberada",
        lines: [
          ["A conta Google ", { b: email }, " não está liberada para usar o painel deste servidor."],
          "O painel é só do administrador do servidor: entre com a conta dele.",
        ],
        links: [{ href: "/web/login", text: "Entrar com outra conta" }],
      },
      { "Set-Cookie": web.clearLoginCookie() }
    );
  }

  /** Conta liberada (conecta serviços) que não é administrador: o painel não abre para ela. */
  function panelNotAdminPage(email) {
    return pageReply(
      403,
      {
        tone: "aviso",
        title: "Painel só do administrador",
        heading: "Painel só do administrador",
        lines: [
          ["Você entrou com a conta Google ", { b: email }, "."],
          "Esta conta pode conectar serviços, mas o painel é só do administrador.",
          "Para conectar um serviço: no VS Code, abra o Swap Plus e clique em Entrar com Google no cartão “Conexão”.",
        ],
        links: [{ href: "/web/login", text: "Entrar com outra conta" }],
      },
      { "Set-Cookie": web.clearLoginCookie() }
    );
  }

  /** Para onde o navegador volta depois de entrar no painel ("/" ou "/#aba", se o login pediu ?next=aba). */
  const panelHome = (s) => (s.next && PANEL_SECTIONS.has(s.next) ? `/#${s.next}` : "/");

  /** Página do resultado já decidido (recarregar a aba, ou abrir o link de novo, não refaz nada). */
  function finalPage(s) {
    if (s.kind === "web") {
      const r = s.result;
      if (!r.denied) return new RawReply(302, { Location: panelHome(s) }, "");
      return r.notAdmin ? panelNotAdminPage(r.denied) : panelDeniedPage(r.denied);
    }
    return s.result.denied ? deniedPage(s.result.denied) : successPage(s.name, s.result.email);
  }

  const loginVencido = () =>
    pageError(400, "expired", "Link vencido", [
      "Este login venceu ou já foi usado.",
      "Se o VS Code já conectou, está tudo certo. Senão, comece de novo pelo VS Code (ou, no painel, clique em Entrar com Google).",
    ], "aviso");

  /**
   * Parte comum do retorno (serviço e painel): erro vindo do Google, troca do code e conferência
   * do id_token. → e-mail confirmado, ou lança a página de erro (a sessão continua esperando: dá para
   * tentar de novo).
   */
  async function confirmWithGoogle(s, query) {
    const isWeb = s.kind === "web";
    const deNovo = isWeb
      ? "Volte ao painel e clique em Entrar com Google de novo."
      : "Para tentar de novo, abra outra vez o link do VS Code (ou comece de novo por lá).";
    const recomece = isWeb ? "Volte ao painel e clique em Entrar com Google de novo." : "Comece de novo pelo VS Code.";
    const gErr = query.get("error");
    if (gErr) {
      const motivo = /^[a-z_]{1,40}$/.test(gErr) ? gErr : "erro";
      log.warn(`[google] o Google não concluiu o login de "${s.name}" (${motivo})`);
      throw pageError(400, "google_error", "Login não concluído", [
        motivo === "access_denied" ? "O login no Google foi cancelado." : `O Google não concluiu o login (${motivo}).`,
        deNovo,
      ]);
    }
    const code = query.get("code") || "";
    if (!code || code.length > 2048) {
      throw pageError(400, "bad_request", "Login não concluído", ["O Google não mandou o código de confirmação.", recomece]);
    }
    if (s.busy) {
      throw pageError(409, "busy", "Login em andamento", [
        "Este login já está sendo confirmado em outra aba.",
        isWeb ? "Espere um pouco e abra o painel de novo." : "Volte ao VS Code.",
      ], "aviso");
    }

    s.busy = true;
    let ex;
    try {
      ex = await exchangeCode(google, code, s.verifier, fetchImpl);
    } finally {
      s.busy = false;
    }
    if (!ex.ok) {
      log.warn(`[google] o Google recusou a confirmação do login de "${s.name}" (${ex.error})`);
      throw pageError(502, "google_exchange", "Não deu para confirmar com o Google", [
        "O Google não confirmou este login agora.",
        isWeb ? "Tente de novo pelo painel (Entrar com Google)." : "Tente de novo pelo link do VS Code (ou comece de novo por lá).",
      ]);
    }
    const id = readIdToken(ex.idToken, google, now());
    if (!id.ok) {
      log.warn(`[google] resposta do Google recusada para "${s.name}" (${id.reason})`);
      if (id.reason === "email_verified") {
        throw pageError(403, "email_not_verified", "E-mail não confirmado", [
          ["O e-mail da conta Google ", { b: id.email }, " não está confirmado."],
          "Confirme o e-mail no Google ou entre com outra conta.",
        ]);
      }
      throw pageError(403, "invalid_id_token", "Login recusado", ["A resposta do Google não confere com este servidor.", recomece]);
    }
    return id.email;
  }

  /** GET /auth/google/callback?code&state (navegador, vindo do Google). O tipo da sessão do `state` decide o fluxo. */
  async function googleCallback({ req, query, ip, ctx }) {
    if (!google.enabled) throw googleOffPage();
    rateLimit("googleCallback", ip, true);
    await sweepLogins();
    const s = logins.getByState(query.get("state") || "");
    if (!s) throw loginVencido();
    ctx.name = s.name;
    if (s.kind !== "web") return deviceCallback(s, { query, ip });
    try {
      return await webCallback(s, { req, query, ip });
    } catch (e) {
      if (e && e.page && !e.page.links) e.page.links = [{ href: "/", text: "Voltar ao painel" }];
      throw e;
    }
  }

  /** Retorno do login de um serviço (VS Code): cria o dispositivo; o VS Code busca o token pelo poll. */
  async function deviceCallback(s, { query, ip }) {
    if (s.result) return finalPage(s);
    const email = await confirmWithGoogle(s, query);
    // Venceu (ou outra aba concluiu) enquanto falava com o Google.
    if (logins.get(s.id) !== s) throw loginVencido();
    if (s.result) return finalPage(s);

    // Serviços: o administrador (ADMIN_EMAILS) ou uma conta da lista de liberadas.
    if (!canConnect(email)) {
      logins.settle(s, { denied: email });
      log.warn(`[google] a conta Google ${email} não está liberada (serviço "${s.name}", de ${ip})`);
      return deniedPage(email);
    }
    const { id: deviceId, token } = createDevice({ name: s.name, platform: s.platform, googleEmail: email });
    pushHistory("device", `Serviço "${s.name}" conectado com a conta Google ${email}`, deviceId);
    try {
      await store.save();
    } catch (e) {
      delete state().devices[deviceId];
      forgetDevice(state(), deviceId, s.name, { quiet: true }); // nunca chegou a valer: sem aviso no histórico
      throw e;
    }
    logins.settle(s, { deviceId, token, email });
    log.info(`[google] serviço "${s.name}" (${s.platform}) conectado com a conta Google ${email}, id ${deviceId}, de ${ip}`);
    return successPage(s.name, email);
  }

  /**
   * Retorno do login do painel: confere que é o mesmo navegador que começou (cookie sp_login) e que a
   * conta é do ADMINISTRADOR (ADMIN_EMAILS; a lista de liberadas não abre o painel), cria a sessão do
   * painel e volta para "/" com o cookie sp_sess. Recarregar depois só volta para "/".
   */
  async function webCallback(s, { req, query, ip }) {
    if (s.result) return finalPage(s);
    if (!web.loginBindingOk(req, s.bindHash)) {
      log.warn(`[painel] retorno do Google sem o cookie do login (outro navegador ou cookie vencido), de ${ip}`);
      throw pageError(400, "wrong_browser", "Login não concluído", [
        "Este login começou em outro navegador (ou demorou demais).",
        "Abra o painel neste navegador e clique em Entrar com Google.",
      ], "aviso");
    }
    const email = await confirmWithGoogle(s, query);
    if (logins.get(s.id) !== s) throw loginVencido();
    if (s.result) return finalPage(s);

    if (!web.panelOn) throw web.panelOffError();
    if (!isAdmin(email)) {
      const notAdmin = isAllowed(email); // liberada: conecta serviços, mas o painel é só do administrador
      logins.settle(s, { denied: email, notAdmin });
      log.warn(
        notAdmin
          ? `[painel] ${email} pode conectar serviços, mas não é administrador: painel recusado (de ${ip})`
          : `[painel] a conta Google ${email} não está liberada para o painel (de ${ip})`
      );
      return notAdmin ? panelNotAdminPage(email) : panelDeniedPage(email);
    }
    const ua = uaSummary(req.headers["user-agent"]);
    const old = web.findSession(req); // sessão anterior deste navegador (será trocada pela nova)
    const { id: sid, token } = web.createSession({ email, ip, ua: req.headers["user-agent"] });
    try {
      await store.save();
    } catch (e) {
      web.dropSession(sid);
      throw e;
    }
    if (old && old.id !== sid) web.dropSession(old.id);
    pushHistory("info", `Entrada no painel: ${email}${ua ? ` (${ua})` : ""}`, null);
    await saveQuiet("histórico do painel");
    logins.settle(s, { web: true, email });
    log.info(`[painel] ${email} entrou no painel${ua ? ` (${ua})` : ""}, de ${ip}`);
    return new RawReply(302, { Location: panelHome(s), "Set-Cookie": [web.sessionCookie(token), web.clearLoginCookie()] }, "");
  }

  /**
   * GET /web/login[?next=aba] → 302 para o Google (login do painel web, sessão de login do tipo "web").
   * next (opcional, só nomes de aba): para onde voltar depois de entrar (ex.: o kit de recuperação pede ?next=acesso).
   */
  async function webLogin({ req, query, ip, ctx }) {
    ctx.name = "painel";
    if (!web.panelOn) throw web.panelOffError();
    if (!google.enabled) {
      throw pageError(503, "google_off", "Login com Google desligado", [
        "O painel só abre com o login com Google, e ele não está ligado neste servidor.",
        "Monte o client id e o client secret do Google e reinicie o servidor.",
      ]);
    }
    rateLimit("webLogin", ip, true);
    await sweepLogins();
    const bind = web.newLoginBinding();
    const made = logins.create({
      kind: "web",
      name: "painel",
      platform: "web",
      ip,
      ua: uaSummary(req.headers["user-agent"]),
      bindHash: bind.hash,
      next: PANEL_SECTIONS.has(query.get("next")) ? query.get("next") : null,
    });
    if (!made) {
      const wait = Math.max(1000, logins.nextExpiry("web") - now());
      throw pageError(429, "too_many_logins", "Tentativas demais", ["Há logins do painel demais em andamento.", "Espere alguns minutos e tente de novo."], "aviso", {
        "Retry-After": String(Math.ceil(wait / 1000)),
      });
    }
    log.info(`[painel] login com Google iniciado, de ${ip}`);
    return new RawReply(302, { Location: authRedirectUrl(google, made.session), "Set-Cookie": bind.cookie }, "");
  }

  // ----- rotas da API -----

  async function heartbeat({ device, body }) {
    let models = [];
    if (body.models !== undefined && body.models !== null) {
      if (!Array.isArray(body.models)) throw bad("models precisa ser uma lista");
      models = body.models.filter((s) => typeof s === "string" && s.length > 0 && s.length <= 100).slice(0, 20);
    }
    let live = null;
    if (body.live !== undefined && body.live !== null) {
      if (!isObj(body.live)) throw bad("live precisa ser um objeto ou null");
      const l = body.live;
      live = {
        email: typeof l.email === "string" ? l.email.slice(0, 200) : null,
        orgUuid: typeof l.orgUuid === "string" ? l.orgUuid.slice(0, 100) : null,
        expiresAt: typeof l.expiresAt === "number" && Number.isFinite(l.expiresAt) ? l.expiresAt : null,
      };
    }
    await engine.heartbeat(device.id, { models, live });
    return stateOf(device);
  }

  async function credential({ device }) {
    const c = await engine.credentialFor(device.id);
    if (!c) throw new HttpError(409, "no_account", "nenhuma conta atribuída a este serviço ainda");
    const o = isObj(c.claudeAiOauth) ? c.claudeAiOauth : {};
    // Lista fechada de campos: o que não estiver aqui não sai (refreshToken nunca).
    return {
      number: c.number,
      gen: c.gen,
      claudeAiOauth: {
        accessToken: o.accessToken,
        expiresAt: o.expiresAt,
        scopes: o.scopes,
        subscriptionType: o.subscriptionType,
        rateLimitTier: o.rateLimitTier,
        // Até quando vale o login (ms), quando o motor sabe. O refreshToken nunca sai.
        ...(o.refreshTokenExpiresAt !== undefined && o.refreshTokenExpiresAt !== null ? { refreshTokenExpiresAt: o.refreshTokenExpiresAt } : {}),
      },
      oauthAccount: c.oauthAccount ?? null,
    };
  }

  // "Login recusado" no histórico: no máximo uma vez por serviço por dia (fuso do servidor). Só na memória.
  const loginRefusedOn = new Map(); // deviceId → "AAAA-MM-DD"

  /** POST /v1/logins de um serviço que não é do administrador: log (sem token), histórico 1x/dia e o 403. */
  function refuseLogin(device) {
    const conta = device.googleEmail ? ` (conta Google ${cleanText(String(device.googleEmail), 254)})` : "";
    log.warn(`[logins] login recusado de "${device.name}"${conta}: só os serviços do administrador (ADMIN_EMAILS) enviam logins`);
    const day = localDay(now());
    if (loginRefusedOn.get(device.id) !== day) {
      for (const [id, d] of loginRefusedOn) if (d !== day) loginRefusedOn.delete(id);
      loginRefusedOn.set(device.id, day);
      pushHistory("alert", `Login recusado de "${device.name}": só o administrador envia logins`, device.id);
    }
    return new HttpError(403, "not_admin", NOT_ADMIN_TEXT);
  }

  async function addLogin({ device, body }) {
    // Antes de tudo: quem não é do administrador nem chega ao motor (nada vai para a Anthropic).
    if (!canUploadLogins(device)) throw refuseLogin(device);
    const { claudeAiOauth, oauthAccount, plan } = body;
    const number = body.number === undefined || body.number === null ? null : Number(body.number);
    if (number !== null && !(Number.isInteger(number) && number > 0 && number <= 999)) throw bad("number precisa ser um inteiro entre 1 e 999");
    if (!isObj(claudeAiOauth) || !isObj(oauthAccount)) throw bad("envie claudeAiOauth e oauthAccount");
    if (plan !== undefined && plan !== null && !isObj(plan)) throw bad("plan precisa ser um objeto { label }");
    let r;
    try {
      r = await engine.addLogin({ claudeAiOauth, oauthAccount, plan: plan ?? undefined, deviceId: device.id, number });
    } catch (e) {
      const he = toHttpError(e);
      if (he.internal) throw e;
      log.warn(`[logins] login recusado de "${device.name}": ${he.error}`);
      throw new HttpError(he.error === "not_admin" ? 403 : 422, he.error, he.message);
    }
    log.info(`[logins] "${device.name}" enviou login: conta ${r && r.number} (${r && r.created ? "nova" : "atualizada"})`);
    return { number: r && r.number, created: !!(r && r.created) };
  }

  /** `number` do corpo de uma troca → número de uma conta existente, ou null (= melhor conta). */
  function parseSwitchNumber(raw) {
    if (raw === undefined || raw === null || raw === "") return null;
    const n = typeof raw === "string" ? Number(raw.trim()) : raw;
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) throw bad("number precisa ser o número de uma conta ou null");
    if (!accountExists(n)) throw new HttpError(404, "not_found", `a conta ${n} não existe`);
    return n;
  }

  async function switchAccount({ device, body }) {
    await engine.switchDevice(device.id, parseSwitchNumber(body.number), "manual");
    return stateOf(device);
  }

  async function events({ device, body }) {
    if (body.kind !== "limit_hit") throw bad('kind precisa ser "limit_hit"');
    const label = body.label === undefined || body.label === null ? null : cleanText(String(body.label), 80) || null;
    const r = (await engine.limitHit(device.id, label)) || {};
    return { switched: !!r.switched, text: typeof r.text === "string" ? r.text : "", state: await stateOf(device) };
  }

  async function patchAccount({ device, params, body }) {
    const n = Number(params[0]);
    if (!accountExists(n)) throw new HttpError(404, "not_found", `a conta ${n} não existe`);
    await engine.updateAccount(n, cleanAccountPatch(body));
    return stateOf(device);
  }

  async function deleteAccount({ device, params }) {
    const n = Number(params[0]);
    if (!accountExists(n)) throw new HttpError(404, "not_found", `a conta ${n} não existe`);
    await engine.removeAccount(n);
    log.info(`[contas] conta ${n} removida por "${device.name}"`);
    return stateOf(device);
  }

  /** Corpo { rules?, autoSwitch? } → engine.setRules (mesma regra para a API dos serviços e o painel). */
  async function applyRules(body) {
    const hasRules = hasOwn(body, "rules");
    const hasAuto = hasOwn(body, "autoSwitch");
    if (!hasRules && !hasAuto) throw bad("envie rules e/ou autoSwitch");
    if (hasAuto && typeof body.autoSwitch !== "boolean") throw bad("autoSwitch precisa ser true ou false");
    const st = state();
    // Sempre manda os dois: o que não veio segue como está.
    await engine.setRules({
      rules: hasRules ? cleanRules(body.rules) : st.rules ?? null,
      autoSwitch: hasAuto ? body.autoSwitch : st.autoSwitch !== false,
    });
  }

  async function putRules({ device, body }) {
    await applyRules(body);
    return stateOf(device);
  }

  // ----- painel web (web.js; só o administrador entra) -----

  const web = createWeb({
    store,
    engine,
    config,
    now,
    log,
    version: VERSION,
    HttpError,
    RawReply,
    JsonReply,
    pageError,
    bad,
    limiter: webLimiter,
    sha256hex,
    sameHash,
    isAdmin,
    adminEmails,
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
  });

  const apiRoutes = [
    { m: "GET", p: /^\/v1\/health$/, fn: () => ({ ok: true, version: VERSION }) },
    { m: "POST", p: /^\/v1\/pair$/, body: true, fn: pair },
    { m: "POST", p: /^\/v1\/login\/start$/, body: true, fn: loginStart },
    { m: "POST", p: /^\/v1\/login\/poll$/, body: true, fn: loginPoll },
    { m: "GET", p: /^\/auth\/google\/start$/, fn: googleStart },
    { m: "GET", p: /^\/auth\/google\/callback$/, fn: googleCallback },
    { m: "POST", p: /^\/v1\/heartbeat$/, auth: true, body: true, fn: heartbeat },
    { m: "GET", p: /^\/v1\/state$/, auth: true, fn: ({ device }) => stateOf(device) },
    { m: "GET", p: /^\/v1\/credential$/, auth: true, fn: credential },
    { m: "POST", p: /^\/v1\/logins$/, auth: true, body: true, fn: addLogin },
    { m: "POST", p: /^\/v1\/switch$/, auth: true, body: true, fn: switchAccount },
    { m: "POST", p: /^\/v1\/events$/, auth: true, body: true, fn: events },
    { m: "PATCH", p: /^\/v1\/accounts\/(\d{1,6})$/, auth: true, body: true, fn: patchAccount },
    { m: "DELETE", p: /^\/v1\/accounts\/(\d{1,6})$/, auth: true, fn: deleteAccount },
    { m: "PUT", p: /^\/v1\/rules$/, auth: true, body: true, fn: putRules },
    { m: "GET", p: /^\/v1\/devices$/, auth: true, fn: ({ device }) => devicesList(device.id) },
    {
      m: "DELETE",
      p: /^\/v1\/devices\/([A-Za-z0-9_-]{1,64})$/,
      auth: true,
      fn: ({ device, params }) => revokeDevice(params[0], `revogado por "${device.name}"`),
    },
    // Painel web: login (aqui, junto do Google) e o resto em web.js (página, arquivos, /web/logout, /web/api/*).
    { m: "GET", p: /^\/web\/login$/, fn: webLogin },
    ...web.routes,
  ];

  // ----- rotas do admin local -----

  function status() {
    const st = state();
    const t = now();
    const devices = Object.values(st.devices);
    const accounts = Object.values(st.accounts)
      .filter(isObj)
      .sort((a, b) => (a.number || 0) - (b.number || 0))
      .map((a) => ({
        number: a.number,
        email: a.email ?? null,
        orgName: a.orgName ?? null,
        plan: (a.plan && a.plan.label) || null,
        alias: a.alias ?? null,
        dead: a.dead ? a.dead.reason || "dead" : null,
        disabled: !!a.disabled,
        accessExpiresAt: (a.cred && a.cred.expiresAt) ?? null,
        loginExpiresAt: (a.cred && a.cred.refreshTokenExpiresAt) ?? null,
        lastRefreshAt: a.lastRefreshAt ?? null,
        refreshFailures: a.refreshFailures || 0,
        gen: a.gen ?? null,
        usage: a.usage ?? null,
        usageFetchedAt: a.usageFetchedAt ?? null,
        usageError: a.usageError ?? null,
        lastGoodUsage: a.lastGoodUsage ?? null,
        lastGoodAt: a.lastGoodAt ?? null,
        devices: devices.filter((d) => d.assigned != null && String(d.assigned) === String(a.number)).map((d) => d.name),
      }));
    let rules = null;
    try {
      rules = typeof engine.rulesEffective === "function" ? engine.rulesEffective() : null;
    } catch {}
    const p = st.pairing;
    // Avisos por e-mail ao dono (notify.js): ligados? e a pasta que o host lê. null = motor sem essa informação.
    let notices = null;
    try {
      const es = typeof engine.status === "function" ? engine.status() : null;
      notices = es && es.notices ? es.notices : null;
    } catch {}
    return {
      ok: true,
      version: VERSION,
      serverTime: t,
      uptimeSec: Math.round((t - startedAt) / 1000),
      notices,
      tlsMode: config.tlsMode || null,
      publicUrl: config.publicUrl || null,
      fingerprint: fingerprint(),
      allowIps: allowIps.map((r) => r.text),
      trustProxy,
      autoSwitch: st.autoSwitch !== false,
      rules,
      pairing: p && p.expiresAt > t ? { expiresAt: p.expiresAt, attempts: p.attempts || 0 } : null,
      google: googleInfo(),
      accounts,
      devices: devicesList(null),
      diag: st.diag || {},
      history: Array.isArray(st.history) ? st.history.slice(0, 15) : [],
    };
  }

  /** POST /admin/accounts/:n/login-expires { at: ISO } → engine.setLoginExpiresAt(n, ms). */
  async function setLoginExpires({ params, body }) {
    const n = Number(params[0]);
    const raw = typeof body.at === "string" ? body.at.trim() : "";
    if (!raw || raw.length > 64) throw bad('envie { "at": "2026-12-01T18:00:00-03:00" } (data e hora em ISO)');
    const ms = Date.parse(raw);
    if (!Number.isFinite(ms)) throw bad(`data inválida "${cleanText(raw, 64)}" (use ISO, ex.: 2026-12-01T18:00:00-03:00)`);
    if (!accountExists(n)) throw new HttpError(404, "not_found", `a conta ${n} não existe`);
    if (typeof engine.setLoginExpiresAt !== "function") {
      throw new HttpError(501, "not_implemented", "este servidor ainda não sabe guardar a validade do login");
    }
    try {
      await engine.setLoginExpiresAt(n, ms);
    } catch (e) {
      if (e && e.code === "invalid") {
        throw new HttpError(400, "invalid", redact(typeof e.message === "string" ? e.message : "").slice(0, 300) || "valor inválido");
      }
      throw e; // not_found → 404 (toHttpError)
    }
    const a = state().accounts[String(n)];
    const saved = a && isObj(a.cred) ? Number(a.cred.refreshTokenExpiresAt) : NaN;
    const loginExpiresAt = Number.isFinite(saved) && saved > 0 ? saved : ms;
    log.info(`[contas] validade do login da conta ${n} ajustada pelo admin: ${new Date(loginExpiresAt).toISOString()}`);
    return { ok: true, number: n, loginExpiresAt };
  }

  /**
   * POST /admin/weekly-notice → manda agora o resumo semanal ao dono (o mesmo que sai sozinho toda semana), sem
   * mexer na marca do resumo automático. Serve para conferir que o e-mail chega. Com `{ preview: true }` só devolve
   * o texto, sem mandar.
   */
  function weeklyNotice({ body }) {
    if (typeof engine.weeklySummary !== "function") throw new HttpError(501, "not_implemented", "este servidor ainda não tem o resumo semanal");
    if (body && body.preview === true) {
      const s = engine.weeklySummary();
      return { ok: true, sent: false, subject: s.subject, text: s.text, expiring: s.expiring, dead: s.dead, unknown: s.unknown };
    }
    const { result, summary } = engine.noticeWeekly();
    const sent = !!(result && result.ok === true);
    const why = sent ? null : !result ? "off" : result.skipped ? "disabled" : "failed";
    log.info(`[avisos] resumo semanal pedido pelo admin: ${sent ? "enviado" : `não enviado (${why})`}`);
    return { ok: true, sent, why, subject: summary.subject, text: summary.text, expiring: summary.expiring, dead: summary.dead, unknown: summary.unknown };
  }

  const adminRoutes = [
    { m: "GET", p: /^\/v1\/health$/, quiet: true, fn: () => ({ ok: true, version: VERSION }) },
    { m: "POST", p: /^\/admin\/weekly-notice$/, body: true, fn: weeklyNotice },
    { m: "POST", p: /^\/admin\/pair-code$/, fn: () => newPairCode() },
    { m: "GET", p: /^\/admin\/status$/, fn: () => status() },
    { m: "GET", p: /^\/admin\/devices$/, fn: () => devicesList(null) },
    {
      m: "DELETE",
      p: /^\/admin\/devices\/([A-Za-z0-9_-]{1,64})$/,
      fn: ({ params }) => revokeDevice(params[0], "revogado pelo admin"),
    },
    { m: "GET", p: /^\/admin\/allowed$/, fn: () => googleInfo() },
    { m: "POST", p: /^\/admin\/allow$/, body: true, fn: ({ body }) => allowEmail(body.email) },
    { m: "POST", p: /^\/admin\/deny$/, body: true, fn: ({ body }) => denyEmail(body.email) },
    { m: "POST", p: /^\/admin\/accounts\/(\d{1,6})\/login-expires$/, body: true, fn: setLoginExpires },
    // Regras pela linha de comando do servidor (ex.: serviços juntos, troca automática).
    {
      m: "PUT",
      p: /^\/admin\/rules$/,
      body: true,
      fn: async ({ body }) => {
        const patch = {};
        if (body.rules !== undefined) {
          if (body.rules !== null && !isObj(body.rules)) throw bad("rules precisa ser um objeto (ou null para voltar ao padrão)");
          patch.rules = body.rules === null ? null : { ...(state().rules || {}), ...body.rules };
        }
        if (body.autoSwitch !== undefined) patch.autoSwitch = !!body.autoSwitch;
        if (!("rules" in patch) && !("autoSwitch" in patch)) throw bad("envie { rules } e/ou { autoSwitch }");
        try {
          await engine.setRules(patch);
        } catch (e) {
          if (e && (e.code === "invalid_rules" || e.code === "invalid")) throw new HttpError(400, e.code, String(e.message || "regra inválida").slice(0, 300));
          throw e;
        }
        log.info("[regras] alteradas pelo admin (linha de comando)");
        return { ok: true, rules: engine.rulesEffective(), autoSwitch: state().autoSwitch !== false };
      },
    },
  ];

  // ----- montagem -----

  function makeHandler(kind, routes, guard) {
    return async (req, res) => {
      const t0 = performance.now();
      const method = req.method;
      const pathname = cleanPath(req.url);
      const ip = kind === "api" ? clientIp(req, trustProxy) : normalizeIp(req.socket && req.socket.remoteAddress);
      // Rotas do navegador (login com Google, página do painel, /web/login): respostas e erros em HTML.
      const html = kind === "api" && (pathname.startsWith("/auth/") || pathname === "/" || pathname === "/web/login");
      // Painel web: respostas filtradas pelo webReplacer e 401 no limite próprio (não bloqueia os serviços).
      const webPath = kind === "api" && web.ownsPath(pathname);
      const replacer = webPath ? webReplacer : responseReplacer;
      const ctx = { name: null, quiet: false };
      res.on("finish", () => {
        if (ctx.quiet && res.statusCode < 400) return;
        const ms = Math.round(performance.now() - t0);
        const who = ctx.name ? `"${ctx.name}"` : "-";
        // Só o caminho: a query (code, state) nunca vai para o log.
        log.info(`[${kind}] ${method} ${pathname.slice(0, 120)} ${res.statusCode} ${ms}ms ${who} ${ip}`);
      });
      try {
        guard(req, ip);
        const { route, params } = matchRoute(routes, method, pathname);
        ctx.quiet = !!route.quiet;
        let device = null;
        if (route.auth) {
          device = authenticate(req);
          if (!device) {
            throw new HttpError(401, "unauthorized", "token ausente ou inválido (conecte este serviço de novo)", {
              "WWW-Authenticate": "Bearer",
            });
          }
          ctx.name = device.name;
          // Presença: token aceito = contato do serviço, seja qual for a rota (só na memória do motor; o que acontecer
          // depois — 400, 409... — não desfaz). Pedidos sem token válido, de IP bloqueado ou fora de ALLOW_IPS não chegam aqui.
          if (typeof engine.touch === "function") engine.touch(device.id);
        }
        const body = route.body ? parseJson(await readBody(req)) : null;
        const query = parseQuery(req.url);
        const out = await route.fn({ req, ip, device, params, body, query, ctx });
        if (out instanceof RawReply) sendRaw(res, out);
        else if (out instanceof JsonReply) sendJson(res, out.status, out.body, out.headers, replacer);
        else sendJson(res, 200, out, undefined, replacer);
      } catch (e) {
        const he = toHttpError(e);
        if (kind === "api" && he.status === 401) {
          if (webPath) {
            if (webLimiter.fail(ip)) log.warn(`[painel] ${ip} bloqueado por 10 min no painel: ${WEB_FAIL_LIMIT} pedidos sem sessão`);
          } else if (limiter.fail(ip)) {
            log.warn(`[api] ${ip} bloqueado por 10 min: ${FAIL_LIMIT} tentativas sem autorização`);
          }
        }
        if (he.internal) log.error(`[${kind}] erro em ${method} ${pathname}: ${redact(e && e.message)}`);
        if (html) sendRaw(res, pageReply(he.status, pageOf(he), he.headers));
        else sendJson(res, he.status, { error: he.error, message: he.message, ...(isObj(he.extra) ? he.extra : {}) }, he.headers, replacer);
      }
    };
  }

  const apiGuard = (req, ip) => {
    if (!ipAllowed(ip, allowIps)) throw new HttpError(403, "forbidden", "este endereço não tem acesso a este servidor");
    const wait = limiter.blockedFor(ip);
    if (wait > 0) {
      throw new HttpError(429, "too_many_attempts", "tentativas sem autorização demais; espere alguns minutos", {
        "Retry-After": String(Math.ceil(wait / 1000)),
      });
    }
  };

  const adminGuard = (req, ip) => {
    // Só da própria máquina, e nunca de um navegador (página web não fala com o admin).
    if (!/^127\./.test(ip)) throw new HttpError(403, "forbidden", "o admin só aceita conexões locais");
    if (req.headers.origin) throw new HttpError(403, "forbidden", "o admin não aceita requisições de navegador");
  };

  return {
    api: makeHandler("api", apiRoutes, apiGuard),
    admin: makeHandler("admin", adminRoutes, adminGuard),
    newPairCode,
    revokeDevice,
    status,
    limiter,
    webLimiter,
    sweepLogins,
    sweepWebSessions: () => web.sweepSessions(),
    allowEmail,
    denyEmail,
    googleInfo,
    web,
  };
}

// ---------------------------------------------------------------------------
// Ponto de entrada
// ---------------------------------------------------------------------------

function tuneServer(server) {
  server.headersTimeout = 20 * 1000;
  server.requestTimeout = 30 * 1000;
  server.keepAliveTimeout = 10 * 1000;
  return server;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function main() {
  const log = createLogger();
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    log.error(`[config] ${e.message}`);
    process.exit(1);
  }
  log.info(`[início] Swap Plus Servidor ${VERSION} (Node ${process.version}, TZ ${process.env.TZ || "padrão do sistema"})`);

  // Cofre
  const { Store } = require("./store");
  let store;
  try {
    store = new Store({ dir: config.dataDir, keyFile: config.masterKeyFile });
  } catch (e) {
    log.error(`[cofre] não consegui ler a chave mestra (${config.masterKeyFile}): ${e.message}`);
    log.error("[cofre] crie uma com: (umask 077; openssl rand -hex 32 > swap_plus_master_key)   e monte em MASTER_KEY_FILE");
    process.exit(1);
  }
  try {
    store.load();
  } catch (e) {
    log.error(`[cofre] ${e.message}`);
    process.exit(1);
  }
  const st = store.state;
  log.info(`[cofre] ${Object.keys(st.accounts || {}).length} conta(s), ${Object.keys(st.devices || {}).length} serviço(s)`);

  // TLS
  let tls = null;
  if (config.tlsMode === "self") {
    const certFile = path.join(config.dataDir, "tls", "cert.pem");
    const keyFile = path.join(config.dataDir, "tls", "key.pem");
    if (!fs.existsSync(certFile) || !fs.existsSync(keyFile)) {
      log.error(`[tls] TLS_MODE=self, mas não achei ${certFile} e ${keyFile}. No Docker o entrypoint.sh gera; fora dele gere com openssl ou use TLS_MODE=off atrás de um proxy.`);
      process.exit(1);
    }
    tls = { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) };
    try {
      const x = new crypto.X509Certificate(tls.cert);
      config.fingerprint = x.fingerprint256;
      const validTo = new Date(x.validTo).getTime();
      if (validTo - Date.now() < 30 * 24 * 3600 * 1000) {
        log.warn(`[tls] o certificado vence em ${x.validTo}; apague ${path.dirname(certFile)} e reinicie para gerar outro (os serviços precisarão de um código de conexão novo)`);
      }
    } catch (e) {
      log.error(`[tls] certificado inválido em ${certFile}: ${e.message}`);
      process.exit(1);
    }
  }
  if (!config.publicUrl) log.warn("[config] PUBLIC_URL não definido: o código de conexão não vai funcionar até definir");

  // Anthropic + motor (carregados só aqui, para os testes da API não dependerem deles)
  const anthropicMod = require("./anthropic");
  const createAnthropic = anthropicMod.createAnthropic || anthropicMod;
  const engineMod = require("./engine");
  const Engine = engineMod.Engine || engineMod;
  const anthropic = createAnthropic({ tokenUrl: config.tokenUrl, apiBase: config.apiBase });
  // Avisos por e-mail ao dono: o motor grava em DATA_DIR/avisos/ e um processo do host entrega ao Painel do Servidor.
  const { createNotifier } = require("./notify");
  const notify = createNotifier({ dir: config.dataDir, env: process.env, log });
  if (notify.enabled) log.info(`[avisos] avisos por e-mail ao dono ligados: caixa de saída em ${notify.dir} (o host entrega ao Painel do Servidor)`);
  else log.info("[avisos] avisos por e-mail ao dono desligados (NOTICES_ENABLED=0)");
  const engine = new Engine({ store, anthropic, log, env: process.env, notify });

  const app = createApp({ store, engine, config, log });

  const apiServer = tuneServer(
    tls ? https.createServer({ cert: tls.cert, key: tls.key, minVersion: "TLSv1.2" }, app.api) : http.createServer(app.api)
  );
  const adminServer = tuneServer(http.createServer(app.admin));
  try {
    await listen(apiServer, config.port);
    await listen(adminServer, config.adminPort, "127.0.0.1");
  } catch (e) {
    log.error(`[início] não consegui abrir a porta: ${e.message}`);
    process.exit(1);
  }
  log.info(
    `[api] ouvindo em ${tls ? "https" : "http"}://0.0.0.0:${config.port}` +
      (tls ? ` (certificado próprio, impressão digital ${config.fingerprint})` : " (sem TLS: o proxy faz o TLS)")
  );
  log.info(`[api] endereço público: ${config.publicUrl || "(não definido)"}; IPs aceitos: ${config.allowIps.length ? config.allowIps.map((r) => r.text).join(", ") : "todos"}${config.trustProxy ? "; usando X-Forwarded-For" : ""}`);
  log.info(`[admin] ouvindo em http://127.0.0.1:${config.adminPort}`);
  const g = app.googleInfo();
  if (g.enabled) {
    log.info(`[google] login com Google ligado (retorno: ${g.callbackUrl}; ${g.allowedEmails.length} conta(s) liberada(s))`);
  } else {
    log.info(`[google] login com Google desligado: ${g.offReason} — o código de pareamento continua valendo`);
  }
  if (!app.web.panelOn) {
    // o aviso de ADMIN_EMAILS faltando já saiu no createApp
  } else if (fs.existsSync(path.join(app.web.webDir, "index.html"))) {
    log.info(`[painel] painel web em ${config.publicUrl ? `${config.publicUrl}/` : "(defina PUBLIC_URL)"}${g.enabled ? "" : " — sem o login com Google ele não abre"}`);
    log.info(`[painel] administrador${g.adminEmails.length > 1 ? "es" : ""} (ADMIN_EMAILS): ${g.adminEmails.join(", ")} — só ${g.adminEmails.length > 1 ? "eles entram" : "ele entra"} no painel`);
  } else {
    log.warn(`[painel] arquivos do painel não encontrados em ${app.web.webDir}: a página / responde 503`);
  }
  // Sessões de login vencidas (e serviços criados cujo acesso o VS Code não buscou) e sessões do painel vencidas.
  setInterval(() => {
    app.sweepLogins().catch((e) => log.warn(`[google] limpeza das sessões de login falhou: ${redact(e && e.message)}`));
    app.sweepWebSessions().catch((e) => log.warn(`[painel] limpeza das sessões do painel falhou: ${redact(e && e.message)}`));
  }, LOGIN_SWEEP_MS).unref();

  engine.start();

  // Encerramento limpo
  let closing = false;
  const shutdown = async (sig) => {
    if (closing) return;
    closing = true;
    log.info(`[fim] ${sig} recebido; encerrando`);
    const hard = setTimeout(() => {
      log.error(`[fim] demorou demais para encerrar (${STOP_HARD_MS / 1000} s); saindo à força`);
      process.exit(1);
    }, STOP_HARD_MS);
    hard.unref();
    apiServer.close();
    adminServer.close();
    if (typeof apiServer.closeIdleConnections === "function") apiServer.closeIdleConnections();
    if (typeof adminServer.closeIdleConnections === "function") adminServer.closeIdleConnections();
    try {
      // Espera o motor terminar o que está fazendo (ex.: uma renovação em andamento) — no máximo 40 s.
      // Timer "ref": segura o processo vivo enquanto espera (o de saída forçada é unref).
      let waitTimer = null;
      const stopped = await Promise.race([
        Promise.resolve(engine.stop()).then(() => true),
        new Promise((r) => {
          waitTimer = setTimeout(() => r(false), STOP_ENGINE_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(waitTimer));
      if (!stopped) log.warn(`[fim] o motor não terminou em ${STOP_ENGINE_WAIT_MS / 1000} s; gravando o cofre assim mesmo`);
    } catch (e) {
      log.error(`[fim] erro ao parar o motor: ${redact(e && e.message)}`);
    }
    // Grava o cofre; se falhar, tenta de novo por até 5 s (um token renovado que não chega ao disco é um login perdido).
    const saveUntil = Date.now() + STOP_SAVE_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        await store.save();
        log.info(`[fim] cofre gravado${attempt > 1 ? ` (na tentativa ${attempt})` : ""}; até mais`);
        break;
      } catch (e) {
        const left = saveUntil - Date.now();
        if (left <= 0 || (e && e.code === "BUSY")) {
          log.error(`[fim] não consegui gravar o cofre (${attempt} tentativa(s)): ${redact(e && e.message)}`);
          store.close(); // solta a trava da pasta de dados (store.lock)
          process.exit(1);
        }
        log.warn(`[fim] não consegui gravar o cofre (tentativa ${attempt}): ${redact(e && e.message)}; tentando de novo`);
        await new Promise((r) => setTimeout(r, Math.min(500 * attempt, left))); // "ref": o processo espera a nova tentativa
      }
    }
    store.close(); // solta a trava da pasta de dados (store.lock)
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (e) => log.error(`[erro] promessa rejeitada sem tratamento: ${redact(e && e.message ? e.message : e)}`));
  process.on("uncaughtException", (e) => {
    log.error(`[erro] exceção não tratada: ${redact(e && e.message)}`);
    process.exit(1);
  });
}

module.exports = {
  VERSION,
  MAX_BODY,
  createApp,
  createLogger,
  loadConfig,
  parseAllowIps,
  parseAdminEmails,
  ipAllowed,
  clientIp,
  main,
};

if (require.main === module) {
  main().catch((e) => {
    process.stderr.write(`[início] falhou: ${redact(e && e.message)}\n`);
    process.exit(1);
  });
}
