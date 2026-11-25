"use strict";
// Login dos serviços com Google (OAuth 2.0 + OpenID Connect), no padrão "login de dispositivo":
// o VS Code não recebe o retorno do navegador, então abre a página de login no navegador e fica
// perguntando ao servidor (poll) até o login terminar.
//
//   1. POST /v1/login/start        → sessão EM MEMÓRIA (id, pollToken, state, PKCE) e o link do navegador
//   2. GET  /auth/google/start     → 302 para o Google (state + PKCE S256)
//   3. GET  /auth/google/callback  → troca o code no Google, lê o id_token e, se a conta puder conectar
//                                    serviços (administrador ou lista de liberadas), cria o dispositivo
//   4. POST /v1/login/poll         → pending | ok (entrega o token UMA vez) | denied | 404 expired
//
// Aqui ficam as partes sem rotas (configuração, sessões, troca do code, leitura do id_token e as
// páginas HTML); as rotas estão em server.js. Este módulo não grava nada em log: code, tokens,
// id_token e client_secret nunca saem daqui a não ser na troca com o próprio Google.
//
// Dois tipos de sessão de login (campo `kind`), com o mesmo cliente OAuth e o mesmo retorno:
//   "device" — o fluxo acima (VS Code: start → navegador → poll);
//   "web"    — entrar no painel web (GET /web/login → Google → retorno cria a sessão do painel,
//              ver web.js). Só o administrador (ADMIN_EMAILS) entra. Não tem poll: o próprio
//              navegador recebe o cookie no retorno.
// Cada tipo tem o seu limite de sessões vivas (logins do painel não ocupam a vez dos serviços).

const crypto = require("crypto");
const fs = require("fs");

const DEFAULT_GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const DEFAULT_GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const DEFAULT_CLIENT_ID_FILE = "/run/secrets/google_client_id";
const DEFAULT_CLIENT_SECRET_FILE = "/run/secrets/google_client_secret";
const GOOGLE_ISSUERS = new Set(["accounts.google.com", "https://accounts.google.com"]);
const START_PATH = "/auth/google/start";
const CALLBACK_PATH = "/auth/google/callback";
const LOGIN_TTL_MS = 10 * 60 * 1000; // a sessão de login vale 10 min
const RESULT_GRACE_MS = 5 * 60 * 1000; // depois do retorno do Google, o VS Code tem pelo menos 5 min para buscar
const MAX_SESSIONS = 50; // sessões vivas ao mesmo tempo (por tipo)
const LOGIN_KINDS = new Set(["device", "web"]);
const TIMEOUT_MS = 15 * 1000;
const USER_AGENT = "swap-plus-server/2.0";

// Cabeçalhos de toda página HTML (e do redirecionamento para o Google).
const PAGE_HEADERS = Object.freeze({
  "Content-Type": "text/html; charset=utf-8",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
});

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const rand = (bytes) => crypto.randomBytes(bytes).toString("base64url");
const sha256hex = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
const GMAIL_DOMAINS = new Set(["gmail.com", "googlemail.com"]);

/**
 * Chave para COMPARAR contas Google (o e-mail é guardado e mostrado como veio, só aparado e em minúsculas):
 * minúsculas; em gmail.com / googlemail.com, a parte local perde os pontos e o "+algo" (o Gmail ignora os dois)
 * e o domínio vira gmail.com. "Dono.Exemplo+x@googlemail.com" e "donoexemplo@gmail.com" → "donoexemplo@gmail.com".
 * Outros domínios: só minúsculas (pontos e "+" podem ser contas diferentes). "" se não parecer e-mail.
 */
function emailKey(v) {
  if (typeof v !== "string") return "";
  const e = v.trim().toLowerCase();
  const at = e.lastIndexOf("@");
  if (at <= 0 || at === e.length - 1 || e.length > 320) return "";
  let local = e.slice(0, at);
  let domain = e.slice(at + 1);
  if (GMAIL_DOMAINS.has(domain)) {
    const plus = local.indexOf("+");
    if (plus >= 0) local = local.slice(0, plus);
    local = local.replace(/\./g, "");
    domain = "gmail.com";
    if (!local) return "";
  }
  return `${local}@${domain}`;
}

/** Os dois e-mails são da mesma conta Google (pela chave de emailKey)? */
function sameEmail(a, b) {
  const ka = emailKey(a);
  return !!ka && ka === emailKey(b);
}

// ---------------------------------------------------------------------------
// Configuração
// ---------------------------------------------------------------------------

/** Primeira linha do arquivo, aparada; null se não existir, não abrir ou estiver vazio. */
function readSecretFile(file) {
  try {
    const v = fs.readFileSync(file, "utf8").split(/\r?\n/)[0].trim();
    return v || null;
  } catch {
    return null;
  }
}

function httpUrlEnv(v, def, name) {
  const s = String(v || "").trim() || def;
  let u;
  try {
    u = new URL(s);
  } catch {
    throw new Error(`${name} inválida: "${s}"`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error(`${name} precisa começar com https:// ou http:// ("${s}")`);
  return s;
}

/**
 * Lê a configuração do login com Google (na subida). Sem client id, client secret ou PUBLIC_URL,
 * o login com Google fica desligado (`enabled: false`, motivo em `offReason`) e o resto funciona.
 * O client secret fica numa propriedade não enumerável (não aparece em JSON.stringify da config).
 */
function loadGoogleConfig(env = process.env, publicUrl = "") {
  const idFile = String(env.GOOGLE_CLIENT_ID_FILE || "").trim() || DEFAULT_CLIENT_ID_FILE;
  const secretFile = String(env.GOOGLE_CLIENT_SECRET_FILE || "").trim() || DEFAULT_CLIENT_SECRET_FILE;
  const authUrl = httpUrlEnv(env.GOOGLE_AUTH_URL, DEFAULT_GOOGLE_AUTH_URL, "GOOGLE_AUTH_URL");
  const tokenUrl = httpUrlEnv(env.GOOGLE_TOKEN_URL, DEFAULT_GOOGLE_TOKEN_URL, "GOOGLE_TOKEN_URL");
  const clientId = readSecretFile(idFile);
  const clientSecret = readSecretFile(secretFile);
  const base = String(publicUrl || "").trim().replace(/\/+$/, "");
  let offReason = null;
  if (!clientId) offReason = `falta o client id do Google (arquivo ${idFile})`;
  else if (!clientSecret) offReason = `falta o client secret do Google (arquivo ${secretFile})`;
  else if (!base) offReason = "falta PUBLIC_URL (o Google precisa do endereço de retorno)";
  const g = {
    enabled: !offReason,
    offReason,
    clientId: clientId || null,
    authUrl,
    tokenUrl,
    startUrl: base ? base + START_PATH : null,
    redirectUri: base ? base + CALLBACK_PATH : null,
  };
  Object.defineProperty(g, "clientSecret", { value: clientSecret || null, enumerable: false });
  return g;
}

// ---------------------------------------------------------------------------
// Sessões de login (só na memória: reiniciar o servidor desfaz os logins em andamento)
// ---------------------------------------------------------------------------

class LoginSessions {
  constructor({ now = Date.now, ttlMs = LOGIN_TTL_MS, max = MAX_SESSIONS } = {}) {
    this.now = now;
    this.ttlMs = ttlMs;
    this.max = max;
    this.byId = new Map();
    this.byState = new Map();
  }

  get size() {
    return this.byId.size;
  }

  /** Tira as sessões vencidas e devolve a lista delas (quem chama limpa o que sobrou de cada uma). */
  sweep() {
    const t = this.now();
    const gone = [];
    for (const s of this.byId.values()) {
      if (s.expiresAt <= t) {
        this.remove(s);
        gone.push(s);
      }
    }
    return gone;
  }

  /** Quantas sessões (ainda não varridas) existem de um tipo. */
  countOf(kind) {
    let n = 0;
    for (const s of this.byId.values()) if (s.kind === kind) n++;
    return n;
  }

  /**
   * Nova sessão → { session, pollToken } (o pollToken em claro só sai aqui), ou null se já há
   * sessões demais desse tipo.
   *   kind      "device" (VS Code, padrão) ou "web" (painel)
   *   ua        User-Agent do navegador (web)
   *   bindHash  sha256 do cookie que prende o login ao navegador que começou (web)
   *   next      aba do painel para onde voltar depois do login (web; quem chama já conferiu o valor)
   *   replacesId / replacesHash  serviço que esta conexão substitui (reconexão do mesmo serviço) e o sha256
   *             do token dele (só o hash; o token antigo nunca fica aqui) (device)
   *   nameTakenStatus  quem pediu entende o status "name_taken" no poll (device; extensão 3.6+, cliente 1.2+)
   */
  create({ kind = "device", name, platform, ip, ua = null, bindHash = null, next = null, replacesId = null, replacesHash = null, nameTakenStatus = false }) {
    if (!LOGIN_KINDS.has(kind)) throw new Error(`tipo de login desconhecido: ${kind}`);
    if (this.countOf(kind) >= this.max) return null;
    const t = this.now();
    let id = rand(16);
    while (this.byId.has(id)) id = rand(16);
    let state = rand(16);
    while (this.byState.has(state)) state = rand(16);
    const pollToken = rand(32);
    const session = {
      id,
      kind,
      pollHash: sha256hex(pollToken),
      state,
      verifier: rand(32), // PKCE code_verifier (43 caracteres)
      name,
      platform,
      ip,
      ua: ua || null,
      bindHash: bindHash || null,
      next: next || null,
      replacesId: replacesId || null,
      replacesHash: replacesHash || null,
      nameTakenStatus: !!nameTakenStatus,
      createdAt: t,
      expiresAt: t + this.ttlMs,
      result: null, // device: { deviceId, token, email } | { nameTaken: true } | web: { web: true, email } | { denied: email }
      busy: false,
    };
    this.byId.set(id, session);
    this.byState.set(state, id);
    return { session, pollToken };
  }

  /** Sessão viva pelo id (ou null). */
  get(id) {
    if (typeof id !== "string" || !id) return null;
    const s = this.byId.get(id);
    return s && s.expiresAt > this.now() ? s : null;
  }

  /** Sessão viva pelo `state` do OAuth (ou null). */
  getByState(state) {
    if (typeof state !== "string" || !state) return null;
    const id = this.byState.get(state);
    return id ? this.get(id) : null;
  }

  /** Depois do retorno do Google: o resultado fica disponível por pelo menos RESULT_GRACE_MS. */
  settle(s, result) {
    s.result = result;
    s.expiresAt = Math.max(s.expiresAt, this.now() + RESULT_GRACE_MS);
  }

  remove(s) {
    if (this.byId.get(s.id) === s) this.byId.delete(s.id);
    if (this.byState.get(s.state) === s.id) this.byState.delete(s.state);
  }

  /** Quando a sessão mais antiga (do tipo, se dado) vence (para o Retry-After quando estão todas ocupadas). */
  nextExpiry(kind) {
    let min = Infinity;
    for (const s of this.byId.values()) if (!kind || s.kind === kind) min = Math.min(min, s.expiresAt);
    return min;
  }
}

// ---------------------------------------------------------------------------
// OAuth: redirecionamento, troca do code, id_token
// ---------------------------------------------------------------------------

/** code_challenge do PKCE (S256). */
function pkceChallenge(verifier) {
  return crypto.createHash("sha256").update(verifier, "ascii").digest("base64url");
}

/** Endereço do Google para onde o navegador vai (302). */
function authRedirectUrl(g, s) {
  const u = new URL(g.authUrl);
  const params = {
    client_id: g.clientId,
    redirect_uri: g.redirectUri,
    response_type: "code",
    scope: "openid email",
    state: s.state,
    code_challenge: pkceChallenge(s.verifier),
    code_challenge_method: "S256",
    prompt: "select_account",
  };
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

/**
 * Troca o code pelo id_token no endpoint de token do Google (form-urlencoded).
 * → { ok: true, idToken } | { ok: false, error, status }. Nunca lança.
 * `error` é só um código curto (ex.: invalid_grant) — pode ir para o log.
 */
async function exchangeCode(g, code, verifier, fetchImpl = fetch) {
  const form = new URLSearchParams({
    code,
    client_id: g.clientId,
    client_secret: g.clientSecret,
    redirect_uri: g.redirectUri,
    grant_type: "authorization_code",
    code_verifier: verifier,
  });
  let res;
  try {
    res = await fetchImpl(g.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json", "User-Agent": USER_AGENT },
      body: form.toString(),
      redirect: "error",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    return { ok: false, error: "rede", status: 0 };
  }
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    data = undefined;
  }
  if (!res.ok) {
    const err = isObj(data) && typeof data.error === "string" && /^[A-Za-z0-9_.-]{1,60}$/.test(data.error) ? data.error : `http_${res.status}`;
    return { ok: false, error: err, status: res.status };
  }
  if (!isObj(data) || typeof data.id_token !== "string" || !data.id_token) return { ok: false, error: "sem_id_token", status: res.status };
  return { ok: true, idToken: data.id_token };
}

/**
 * Lê e confere o id_token. Ele veio direto do Google pelo canal da troca do code (TLS), então,
 * pela OIDC Core 3.1.3.7, dá para dispensar a assinatura; o resto é conferido aqui:
 * iss do Google, aud = nosso client id (azp também, se vier), exp no futuro, e-mail confirmado.
 * → { ok: true, email, sub } | { ok: false, reason, email? }
 */
function readIdToken(idToken, { clientId }, nowMs) {
  const parts = typeof idToken === "string" ? idToken.split(".") : [];
  if (parts.length !== 3 || !parts[1]) return { ok: false, reason: "formato" };
  let c;
  try {
    c = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    return { ok: false, reason: "formato" };
  }
  if (!isObj(c)) return { ok: false, reason: "formato" };
  if (!GOOGLE_ISSUERS.has(c.iss)) return { ok: false, reason: "iss" };
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!clientId || !aud.includes(clientId)) return { ok: false, reason: "aud" };
  if ((c.azp !== undefined || aud.length > 1) && c.azp !== clientId) return { ok: false, reason: "azp" };
  const exp = typeof c.exp === "number" ? c.exp : Number(c.exp);
  if (!Number.isFinite(exp) || exp * 1000 <= nowMs) return { ok: false, reason: "exp" };
  const email = typeof c.email === "string" ? c.email.trim().toLowerCase() : "";
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+$/.test(email)) return { ok: false, reason: "email" };
  if (c.email_verified !== true && c.email_verified !== "true") return { ok: false, reason: "email_verified", email };
  return { ok: true, email, sub: typeof c.sub === "string" ? c.sub : null };
}

// ---------------------------------------------------------------------------
// Páginas HTML (tema escuro, sem JS, tudo escapado)
// ---------------------------------------------------------------------------

function escapeHtml(s) {
  return String(s === null || s === undefined ? "" : s).replace(
    /[&<>"']/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]
  );
}

const ICONS = { ok: "&#10003;", erro: "&#10005;", aviso: "!" };

/**
 * page = { tone: "ok"|"erro"|"aviso", title, heading, lines, links? }
 * lines: cada item é um parágrafo — texto, ou lista de pedaços (texto ou { b: "negrito" }).
 * links: [{ href, text }] — botões; só endereços deste servidor ("/..."; o resto é ignorado).
 */
function renderPage({ tone = "erro", title, heading, lines = [], links = [] } = {}) {
  const t = ICONS[tone] ? tone : "erro";
  const seg = (x) => (isObj(x) ? `<strong>${escapeHtml(x.b)}</strong>` : escapeHtml(x));
  const paras = lines.map((l) => `    <p>${Array.isArray(l) ? l.map(seg).join("") : seg(l)}</p>`).join("\n");
  const botoes = (Array.isArray(links) ? links : [])
    .filter((l) => isObj(l) && typeof l.href === "string" && /^\/(?![/\\])/.test(l.href) && typeof l.text === "string")
    .map((l) => `<a class="botao" href="${escapeHtml(l.href)}">${escapeHtml(l.text)}</a>`);
  const acoes = botoes.length ? `\n    <p class="acoes">${botoes.join(" ")}</p>` : "";
  return `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtml(title || heading || "Swap Plus")} · Swap Plus</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; }
  body {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    padding: 24px 16px; background: #0d1117; color: #e6edf3;
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    width: 100%; max-width: 440px; padding: 32px 28px; text-align: center;
    background: #161b22; border: 1px solid #30363d; border-radius: 16px;
    box-shadow: 0 16px 48px rgba(0, 0, 0, .4);
  }
  .icone {
    width: 60px; height: 60px; margin: 0 auto 18px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 700;
  }
  .ok .icone { background: rgba(63, 185, 80, .14); color: #3fb950; }
  .erro .icone { background: rgba(248, 81, 73, .14); color: #f85149; }
  .aviso .icone { background: rgba(210, 153, 34, .14); color: #d29922; }
  h1 { margin: 0 0 12px; font-size: 21px; line-height: 1.3; }
  p { margin: 8px 0; color: #9da7b3; overflow-wrap: anywhere; }
  strong { color: #e6edf3; font-weight: 600; }
  .marca { margin-top: 26px; font-size: 13px; color: #6e7681; letter-spacing: .02em; }
  .acoes { margin-top: 20px; }
  .botao {
    display: inline-block; margin: 4px; padding: 9px 16px; border-radius: 8px;
    background: #238636; color: #fff; text-decoration: none; font-weight: 600;
  }
  .botao:focus-visible { outline: 2px solid #58a6ff; outline-offset: 2px; }
</style>
</head>
<body>
  <main class="card ${t}">
    <div class="icone" aria-hidden="true">${ICONS[t]}</div>
    <h1>${escapeHtml(heading || title || "")}</h1>
${paras}${acoes}
    <div class="marca">Swap Plus Servidor</div>
  </main>
</body>
</html>
`;
}

module.exports = {
  DEFAULT_GOOGLE_AUTH_URL,
  DEFAULT_GOOGLE_TOKEN_URL,
  START_PATH,
  CALLBACK_PATH,
  LOGIN_TTL_MS,
  RESULT_GRACE_MS,
  MAX_SESSIONS,
  PAGE_HEADERS,
  emailKey,
  sameEmail,
  loadGoogleConfig,
  LoginSessions,
  pkceChallenge,
  authRedirectUrl,
  exchangeCode,
  readIdToken,
  escapeHtml,
  renderPage,
};
