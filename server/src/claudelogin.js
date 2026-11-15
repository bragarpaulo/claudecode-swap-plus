"use strict";
// "Adicionar conta pela assinatura" (WEB-SPEC.md 2.3): o administrador entra numa conta Claude DELE pelo
// painel, do mesmo jeito que o /login do Claude Code quando a pessoa cola o código (OAuth com PKCE e
// "código colado"). Este módulo só faz o login: guarda o PKCE e o state em memória, troca o código por
// tokens e monta o claudeAiOauth + oauthAccount. Quem guarda a conta é o engine (storeFreshLogin: guarda o login novo como veio, sem renovar na hora; daí em diante o engine renova sozinho).
//
// Parâmetros copiados do Claude Code 2.1.325 (bundle extraído; trechos curtos como evidência):
//
// - Endereços (config "prod"):
//     CLAUDE_AI_AUTHORIZE_URL:"https://claude.com/cai/oauth/authorize"
//     TOKEN_URL:"https://platform.claude.com/v1/oauth/token"
//     MANUAL_REDIRECT_URL:"https://platform.claude.com/oauth/code/callback"
//     CLIENT_ID:"9d1c250a-e61b-44d9-88ed-5944d1962f5e"
//   (login com a assinatura = loginWithClaudeAi → CLAUDE_AI_AUTHORIZE_URL; o do Console é
//   platform.claude.com/oauth/authorize, que NÃO usamos.)
//
// - URL de autorização (função d2o), nesta ordem:
//     U.searchParams.append("code","true"),U.searchParams.append("client_id",...CLIENT_ID),
//     U.searchParams.append("response_type","code"),
//     U.searchParams.append("redirect_uri",s?dn().MANUAL_REDIRECT_URL:`http://localhost:${r}/callback`)
//     ...U.searchParams.append("scope",j.join(" ")),U.searchParams.append("code_challenge",e),
//     U.searchParams.append("code_challenge_method","S256"),U.searchParams.append("state",n)
//   (orgUUID, login_hint e login_method só vão quando pedidos; o /login normal não manda.)
//   Modo "colar o código" = isManual → redirect_uri = MANUAL_REDIRECT_URL.
//
// - Escopos do /login (Pqo()): L([...S,...Q5t()]) + fYr, com
//     S=[c,n8] = ["org:create_api_key","user:profile"]
//     n=[n8,gC,snr,"user:mcp_servers","user:file_upload"] (+ J5t="user:plugins": PLUGINS_SCOPE_REGISTERED:!0)
//     gC="user:inference", snr="user:sessions:claude_code", fYr="user:privacy_consents:write"
//     (PRIVACY_CONSENTS_SCOPE_REGISTERED:!0), L(e) = [...new Set(e)]
//   → "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers
//      user:file_upload user:plugins user:privacy_consents:write"
//
// - PKCE e state: function I(){return A(L(32))} (verifier = 32 bytes aleatórios em base64url),
//     function O(e){let r=x("sha256");return r.update(e),A(r.digest())} (challenge = sha256 do verifier,
//     base64url), function y(){return A(L(32))} (state = 32 bytes aleatórios em base64url).
//
// - Código colado: a página mostra "código#state"; o Claude Code faz
//     let[h,k]=p.split("#");if(!h||!k){..."Invalid code. Please make sure the full code was copied."
//     if(n!==void 0&&k!==n){..."That code is not from this sign-in."
//
// - Troca do código (função oYs): POST TOKEN_URL, JSON (Content-Type: application/json), sem redirecionamento
//   (axios maxRedirects:0), tempo máximo 30 s (aqui 45 s, como a renovação do anthropic.js):
//     {grant_type:"authorization_code",code:e,redirect_uri:h?dn().MANUAL_REDIRECT_URL:...,
//      client_id:E??dn().CLIENT_ID,code_verifier:r,state:n}   (expires_in só no setup-token)
//   Status != 200 → erro; 400/401 com error "invalid_grant" = "That code wasn't accepted. It may be
//   incomplete, expired, already used, or from an earlier sign-in attempt."
//
// - Resposta usada (formatTokens): accessToken:e.access_token, refreshToken:e.refresh_token,
//     expiresAt:Date.now()+e.expires_in*1000, refreshTokenExpiresAt:l2o(e.refresh_token_expires_in,!0),
//     scopes:HVr(e.scope) (texto separado por espaço), tokenAccount:{uuid:e.account.uuid,
//     emailAddress:e.account.email_address, organizationUuid:e.organization?.uuid,
//     organizationName:e.organization?.name, ...}
//   (o Claude Code chuta 30 dias quando falta refresh_token_expires_in; aqui fica "desconhecido", como
//   manda o SPEC.md.)
//
// - Perfil depois do login (k_n/ok): GET {BASE_API_URL}/api/oauth/profile com Authorization: Bearer;
//     subscriptionType:FVr(r?.organization?.organization_type) com
//     NVr=new Map([["claude_max","max"],["claude_pro","pro"],["claude_enterprise","enterprise"],["claude_team","team"]]),
//     rateLimitTier:r?.organization?.rate_limit_tier; oauthAccount: accountUuid:_.account.uuid,
//     emailAddress:_.account.email, organizationUuid:_.organization.uuid (sem perfil: o tokenAccount).
//
// Regras daqui:
// - Sessões só na memória (reiniciar o servidor desfaz logins em andamento): máx. 10, 10 min cada,
//   id aleatório; presa à sessão do painel que começou (owner). Passando de 10, sai a mais antiga.
// - O código é de uso único: a sessão sai da memória ANTES de ir à Anthropic (dois cliques não trocam
//   duas vezes). Código mal colado ou state de outro login não gastam a sessão (5 erros de state: sai).
// - Nunca vai para log nem para mensagem de erro: código, state, verifier, access token, refresh token.
// - Tudo com tempo máximo e redirect: "error" (os segredos só vão para o endereço configurado).

const crypto = require("crypto");
const { CLIENT_ID, USER_AGENT, DEFAULT_TOKEN_URL, DEFAULT_API_BASE } = require("./anthropic");

const AUTHORIZE_URL = "https://claude.com/cai/oauth/authorize";
const MANUAL_REDIRECT_URL = "https://platform.claude.com/oauth/code/callback";
const SCOPES = Object.freeze([
  "org:create_api_key",
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
  "user:plugins",
  "user:privacy_consents:write",
]);
const LOGIN_TTL_MS = 10 * 60 * 1000;
const MAX_LOGINS = 10;
const MAX_STATE_ERRORS = 5;
const EXCHANGE_TIMEOUT_MS = 45 * 1000; // a troca pode ter gerado tokens: não cortar cedo
const PROFILE_TIMEOUT_MS = 15 * 1000;
const MAX_PASTE = 4096;
const MAX_TOKEN_LEN = 16 * 1024;
const FALLBACK_EXPIRES_IN_SEC = 3600; // sem expires_in válido: 1 h (o engine renova antes de vencer)
const MAX_EXPIRES_IN_SEC = 24 * 3600;
const MAX_DATE_MS = 8.64e15;
const LOCAL_HOSTS = ["127.0.0.1", "localhost", "[::1]"];
const PLAN_TYPES = new Map([
  ["claude_max", "max"],
  ["claude_pro", "pro"],
  ["claude_enterprise", "enterprise"],
  ["claude_team", "team"],
]);

// Mensagens (português) por código de erro. status = HTTP sugerido; restart = precisa começar de novo.
const ERRORS = {
  bad_code: {
    status: 400,
    restart: false,
    message: "código incompleto: copie o código inteiro que a página da Anthropic mostrou (tem um # no meio) e cole de novo",
  },
  wrong_state: {
    status: 400,
    restart: false,
    message: "esse código não é deste login: cole o código que apareceu depois de abrir o endereço DESTE login",
  },
  login_expired: {
    status: 410,
    restart: true,
    message: "este login venceu (vale 10 minutos), já foi usado ou não existe mais: clique em \"Adicionar conta\" de novo",
  },
  code_refused: {
    status: 422,
    restart: true,
    message:
      "a Anthropic não aceitou o código: ele pode estar incompleto, vencido, já usado ou ser de outra tentativa. Clique em \"Adicionar conta\" de novo",
  },
  no_refresh_token: {
    status: 502,
    restart: true,
    message: "a Anthropic não devolveu o refresh token deste login (sem ele o servidor não consegue renovar a conta): clique em \"Adicionar conta\" de novo",
  },
  no_identity: {
    status: 502,
    restart: true,
    message: "não deu para saber de qual conta é este login (a Anthropic não mandou o e-mail): clique em \"Adicionar conta\" de novo daqui a pouco",
  },
  anthropic_refused: {
    status: 502,
    restart: true,
    message: "a Anthropic recusou a troca do código",
  },
  anthropic_failed: {
    status: 502,
    restart: true,
    message: "a Anthropic não respondeu à troca do código (rede, tempo esgotado ou erro do lado dela): clique em \"Adicionar conta\" de novo",
  },
};

function fail(code, detail) {
  const spec = ERRORS[code];
  const e = new Error(detail ? `${spec.message} (${detail})` : spec.message);
  e.code = code;
  e.status = spec.status;
  e.restart = spec.restart;
  return e;
}

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
const b64url = (buf) => Buffer.from(buf).toString("base64url");
const sha256b64url = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("base64url");

/** Segundos vindos da resposta (número, ou número em texto) > 0; senão null. */
function seconds(raw) {
  const n = typeof raw === "number" || (typeof raw === "string" && raw.trim()) ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Compara dois segredos curtos sem vazar tempo (pelo sha256, que tem o mesmo tamanho). */
function sameSecret(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = crypto.createHash("sha256").update(a).digest();
  const y = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(x, y) && a.length === b.length;
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

/** Código do erro OAuth do corpo (`error` em texto, ou `error.type`), só se tiver cara de código. */
function oauthError(body) {
  if (!isObj(body)) return null;
  const raw = typeof body.error === "string" ? body.error : isObj(body.error) ? body.error.type : null;
  return typeof raw === "string" && /^[a-z][a-z0-9_]{0,40}$/.test(raw) ? raw : null;
}

/**
 * Texto colado → { code, state }. Igual ao Claude Code: "código#state" (split("#"), as duas partes
 * precisam existir). Aqui também tira espaços/quebras de linha e aspas que vêm junto na cópia.
 */
function parsePasted(pasted) {
  if (typeof pasted !== "string") throw fail("bad_code");
  let s = pasted.slice(0, MAX_PASTE + 1);
  if (s.length > MAX_PASTE) throw fail("bad_code");
  s = s.replace(/\s+/g, "").replace(/^["'`]+|["'`]+$/g, "");
  const [code, state] = s.split("#");
  if (!code || !state) throw fail("bad_code");
  const printable = /^[\x21-\x7e]+$/;
  if (!printable.test(code) || !printable.test(state)) throw fail("bad_code");
  return { code, state };
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function discard(res) {
  try {
    await res.text();
  } catch {}
}

function makeLog(log) {
  const pick = (k) => {
    if (log && typeof log[k] === "function") return log[k].bind(log);
    if (log && typeof log.log === "function") return log.log.bind(log);
    return () => {};
  };
  return { info: pick("info"), warn: pick("warn") };
}

/**
 * createClaudeLogin({ anthropicTokenUrl, fetchImpl, now, anthropicApiBase?, authorizeUrl?, log? }) → {
 *   start({ owner }?)                  → { loginId, authUrl, expiresAt }
 *   finish(loginId, pastedCode, { owner }?) → { claudeAiOauth, oauthAccount, plan: null, email }
 *                                         ou lança Error com .code/.status/.restart (ERRORS acima)
 *   size()                             → logins em andamento (vivos)
 * }
 * owner (opcional): id da sessão do painel; o login só termina na mesma sessão que começou.
 */
function createClaudeLogin({
  anthropicTokenUrl = DEFAULT_TOKEN_URL,
  anthropicApiBase = DEFAULT_API_BASE,
  authorizeUrl = AUTHORIZE_URL,
  fetchImpl = fetch,
  now = Date.now,
  log,
} = {}) {
  const tokenUrl = anthropicTokenUrl || DEFAULT_TOKEN_URL;
  const apiBase = String(anthropicApiBase || DEFAULT_API_BASE).replace(/\/+$/, "");
  const authUrlBase = authorizeUrl || AUTHORIZE_URL;
  checkUrl("ANTHROPIC_TOKEN_URL (anthropicTokenUrl)", tokenUrl);
  checkUrl("ANTHROPIC_API_BASE (anthropicApiBase)", apiBase);
  checkUrl("authorizeUrl", authUrlBase);
  const L = makeLog(log);
  const logins = new Map(); // loginId → { state, verifier, owner, createdAt, expiresAt, stateErrors }

  function sweep() {
    const t = now();
    for (const [id, s] of logins) if (!(s.expiresAt > t)) logins.delete(id);
  }

  function start({ owner = null } = {}) {
    sweep();
    while (logins.size >= MAX_LOGINS) logins.delete(logins.keys().next().value); // sai o mais antigo
    let loginId;
    do loginId = b64url(crypto.randomBytes(16));
    while (logins.has(loginId));
    const verifier = b64url(crypto.randomBytes(32));
    const state = b64url(crypto.randomBytes(32));
    const t = now();
    const expiresAt = t + LOGIN_TTL_MS;
    logins.set(loginId, { state, verifier, owner: owner || null, createdAt: t, expiresAt, stateErrors: 0 });
    const u = new URL(authUrlBase);
    u.searchParams.append("code", "true");
    u.searchParams.append("client_id", CLIENT_ID);
    u.searchParams.append("response_type", "code");
    u.searchParams.append("redirect_uri", MANUAL_REDIRECT_URL);
    u.searchParams.append("scope", SCOPES.join(" "));
    u.searchParams.append("code_challenge", sha256b64url(verifier));
    u.searchParams.append("code_challenge_method", "S256");
    u.searchParams.append("state", state);
    L.info(`[conta claude] login pela assinatura começado (vale ${LOGIN_TTL_MS / 60000} min; ${logins.size} em andamento)`);
    return { loginId, authUrl: u.toString(), expiresAt };
  }

  /** POST no endpoint de token: código → resposta crua (objeto). Lança os erros de ERRORS. */
  async function exchange(code, s) {
    let res;
    try {
      res = await fetchImpl(tokenUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": USER_AGENT },
        body: JSON.stringify({
          grant_type: "authorization_code",
          code,
          redirect_uri: MANUAL_REDIRECT_URL,
          client_id: CLIENT_ID,
          code_verifier: s.verifier,
          state: s.state,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
      });
    } catch {
      L.warn("[conta claude] a troca do código ficou sem resposta (rede, tempo esgotado ou redirecionamento)");
      throw fail("anthropic_failed");
    }
    let body;
    try {
      body = await readJson(res);
    } catch {
      L.warn(`[conta claude] a resposta da troca do código caiu no meio (HTTP ${res.status})`);
      throw fail("anthropic_failed");
    }
    if (!res.ok) {
      const err = oauthError(body);
      L.warn(`[conta claude] a troca do código não deu certo: HTTP ${res.status}${err ? ` ${err}` : ""}`);
      if (res.status === 401 || (res.status === 400 && err === "invalid_grant")) throw fail("code_refused");
      if (res.status >= 500) throw fail("anthropic_failed");
      throw fail("anthropic_refused", `HTTP ${res.status}${err ? `, ${err}` : ""}`);
    }
    if (!isObj(body) || !str(body.access_token) || body.access_token.length > MAX_TOKEN_LEN) {
      L.warn(`[conta claude] a troca do código voltou sem access token (HTTP ${res.status})`);
      throw fail("anthropic_failed");
    }
    if (!str(body.refresh_token) || body.refresh_token.length > MAX_TOKEN_LEN) {
      L.warn("[conta claude] a troca do código voltou sem refresh token: login recusado (o servidor não teria como renovar)");
      throw fail("no_refresh_token");
    }
    return body;
  }

  /** Perfil do dono do access token (o que o Claude Code lê depois do login), ou null. */
  async function profile(accessToken) {
    try {
      const res = await fetchImpl(`${apiBase}/api/oauth/profile`, {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json", "User-Agent": USER_AGENT },
        redirect: "error",
        signal: AbortSignal.timeout(PROFILE_TIMEOUT_MS),
      });
      if (!res.ok) {
        await discard(res);
        L.warn(`[conta claude] perfil da conta indisponível (HTTP ${res.status}); sigo com a identidade da troca do código`);
        return null;
      }
      const data = await readJson(res);
      if (!isObj(data) || !isObj(data.account)) return null;
      const org = isObj(data.organization) ? data.organization : {};
      return {
        accountUuid: str(data.account.uuid),
        email: str(data.account.email) || str(data.account.email_address),
        orgUuid: str(org.uuid),
        orgName: str(org.name),
        organizationType: str(org.organization_type),
        rateLimitTier: str(org.rate_limit_tier),
      };
    } catch {
      L.warn("[conta claude] perfil da conta sem resposta; sigo com a identidade da troca do código");
      return null;
    }
  }

  async function finish(loginId, pastedCode, { owner = null } = {}) {
    sweep();
    const s = typeof loginId === "string" && loginId.length <= 64 ? logins.get(loginId) : undefined;
    if (!s || (s.owner && s.owner !== owner)) throw fail("login_expired");
    const { code, state } = parsePasted(pastedCode); // mal colado: a sessão continua (dá para colar de novo)
    if (!sameSecret(state, s.state)) {
      s.stateErrors += 1;
      if (s.stateErrors >= MAX_STATE_ERRORS) logins.delete(loginId);
      L.warn(`[conta claude] código colado de outro login (state não confere; ${s.stateErrors}/${MAX_STATE_ERRORS})`);
      throw fail("wrong_state");
    }
    // Uso único: daqui em diante o código vai para a Anthropic; dois envios iguais não trocam duas vezes.
    logins.delete(loginId);

    const body = await exchange(code, s);
    const t = now();
    const who = await profile(body.access_token);
    const acct = isObj(body.account) ? body.account : {};
    const org = isObj(body.organization) ? body.organization : {};
    const email = (who && who.email) || str(acct.email_address) || str(acct.email);
    if (!email) {
      L.warn("[conta claude] login recusado: nem a troca do código nem o perfil disseram o e-mail da conta");
      throw fail("no_identity");
    }

    const claudeAiOauth = {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: t + Math.min(seconds(body.expires_in) || FALLBACK_EXPIRES_IN_SEC, MAX_EXPIRES_IN_SEC) * 1000,
      // Sem `scope` na resposta: os escopos pedidos (os do /login), para o Claude Code reconhecer o login da assinatura.
      scopes: str(body.scope) ? body.scope.trim().split(/\s+/) : [...SCOPES],
    };
    const subscriptionType = who && who.organizationType ? PLAN_TYPES.get(who.organizationType) || null : null;
    if (subscriptionType) claudeAiOauth.subscriptionType = subscriptionType;
    if (who && who.rateLimitTier) claudeAiOauth.rateLimitTier = who.rateLimitTier;
    const loginSec = seconds(body.refresh_token_expires_in);
    if (loginSec && t + loginSec * 1000 <= MAX_DATE_MS) claudeAiOauth.refreshTokenExpiresAt = t + loginSec * 1000;

    // oauthAccount mínimo: o perfil manda; o que faltar vem da resposta da troca do código.
    const oauthAccount = { emailAddress: email };
    const accountUuid = (who && who.accountUuid) || str(acct.uuid);
    const organizationUuid = (who && who.orgUuid) || str(org.uuid);
    const organizationName = (who && who.orgName) || str(org.name);
    if (accountUuid) oauthAccount.accountUuid = accountUuid;
    if (organizationUuid) oauthAccount.organizationUuid = organizationUuid;
    if (organizationName) oauthAccount.organizationName = organizationName;

    L.info(`[conta claude] login pela assinatura concluído: ${email}${subscriptionType ? ` (${subscriptionType})` : ""}`);
    return { claudeAiOauth, oauthAccount, plan: null, email };
  }

  function size() {
    sweep();
    return logins.size;
  }

  return { start, finish, size };
}

module.exports = {
  createClaudeLogin,
  parsePasted,
  AUTHORIZE_URL,
  MANUAL_REDIRECT_URL,
  SCOPES,
  LOGIN_TTL_MS,
  MAX_LOGINS,
  MAX_STATE_ERRORS,
  EXCHANGE_TIMEOUT_MS,
  PROFILE_TIMEOUT_MS,
  ERRORS,
};
