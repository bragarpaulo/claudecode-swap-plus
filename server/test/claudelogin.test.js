"use strict";
// Testes do "Adicionar conta pela assinatura" (server/src/claudelogin.js e as rotas
// POST /web/api/claude-login/start e /finish de web.js).
// "Anthropic falsa": o mesmo objeto atende por fetch falso (testes do módulo, sem rede) e por um servidor
// HTTP local em 127.0.0.1 (testes das rotas: ANTHROPIC_TOKEN_URL / ANTHROPIC_API_BASE apontam para ele).
// O "navegador" é a função authorize(): lê o authUrl como a página de login leria, guarda o código
// preso ao code_challenge/state e devolve o texto que a página mostra ("código#state").
// O fim a fim usa o motor de verdade (engine.js + anthropic.js) contra a mesma Anthropic falsa.
// Rodar no servidor:  node --test server/test/claudelogin.test.js     (TEST_LOG=1 mostra os logs)

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const {
  createClaudeLogin,
  parsePasted,
  AUTHORIZE_URL,
  MANUAL_REDIRECT_URL,
  SCOPES,
  MAX_LOGINS,
  MAX_STATE_ERRORS,
} = require("../src/claudelogin");
const { CLIENT_ID, createAnthropic } = require("../src/anthropic");
const { Store, decrypt, loadKey } = require("../src/store");
const { createApp, loadConfig } = require("../src/server");
const { Engine } = require("../src/engine");
const { RULE_DEFAULTS } = require("../../plus/rules");

const TOKEN_URL = "https://anthropic.falsa/v1/oauth/token";
const API = "https://api.anthropic.falsa";
const PUBLIC_URL = "https://swap.exemplo.com";
const ADMIN = "ana@exemplo.com";
const SEC = 1000;
const MIN = 60 * SEC;
const DAY = 24 * 60 * MIN;
const START = Date.parse("2026-11-14T12:00:00Z");
const SCOPE_TEXT =
  "org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins user:privacy_consents:write";
const ACCESS_LIFE_S = 8 * 3600;
const LOGIN_LIFE_S = 30 * 24 * 3600;

const sha256hex = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const sha256b64url = (s) => crypto.createHash("sha256").update(String(s)).digest("base64url");
const hex = (n) => crypto.randomBytes(n).toString("hex");

// ---------------------------------------------------------------------------
// Anthropic falsa
// ---------------------------------------------------------------------------

class FakeAnthropic {
  constructor() {
    this.codes = new Map(); // código → { challenge, state, redirectUri, clientId, scope, used }
    this.access = new Map(); // access token → identidade
    this.refreshes = new Map(); // refresh token → { identity, used }
    this.issued = []; // { access, refresh, grant } na ordem em que saíram
    this.calls = []; // { kind: "authorization_code" | "refresh_token" | "profile" | ..., body? }
    this.requests = []; // pedidos crus que chegaram pelo fetch falso (url, method, headers, redirect, signal, body)
    this.secrets = []; // tudo o que nunca pode aparecer em resposta do painel nem em log
    this.mode = {}; // exchange: "no_refresh" | "500" | "403"; profile: "500"; account: false; loginExpiry: false
    this.netError = false;
    this.identity = {
      uuid: "acc-uuid-1",
      email: "dono@exemplo.com",
      orgUuid: "org-uuid-1",
      orgName: "Org do Dono",
      orgType: "claude_max",
      tier: "default_claude_max_20x",
    };
    this.fetch = async (url, init = {}) => {
      const u = new URL(String(url));
      const headers = {};
      for (const [k, v] of Object.entries(init.headers || {})) headers[k.toLowerCase()] = v;
      const method = init.method || "GET";
      this.requests.push({ url: String(url), method, headers, redirect: init.redirect, signal: init.signal, body: init.body });
      if (this.netError) {
        throw new TypeError("fetch failed", { cause: Object.assign(new Error("ECONNRESET anthropic.falsa"), { code: "ECONNRESET" }) });
      }
      const [status, body] = this.handle(method, u.pathname, headers, typeof init.body === "string" ? init.body : "");
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    };
  }

  /** O navegador: abre o authUrl, entra na conta e copia o que a página mostra ("código#state"). */
  authorize(authUrl) {
    const p = Object.fromEntries(new URL(authUrl).searchParams);
    const code = `codigo-${hex(12)}`;
    this.codes.set(code, {
      challenge: p.code_challenge,
      state: p.state,
      redirectUri: p.redirect_uri,
      clientId: p.client_id,
      scope: p.scope,
      used: false,
    });
    this.secrets.push(code, p.state);
    return `${code}#${p.state}`;
  }

  mint(identity, grant) {
    const access = `sk-ant-oat01-ACESSO-${hex(8)}`;
    const refresh = `sk-ant-ort01-REFRESH-${hex(8)}`;
    this.access.set(access, identity);
    this.refreshes.set(refresh, { identity, used: false });
    this.issued.push({ access, refresh, grant });
    this.secrets.push(access, refresh);
    return { access, refresh };
  }

  identityBlocks(id) {
    return { account: { uuid: id.uuid, email_address: id.email }, organization: { uuid: id.orgUuid, name: id.orgName } };
  }

  handle(method, pathname, headers, bodyText) {
    if (method === "POST" && pathname === "/v1/oauth/token") {
      let b;
      try {
        b = JSON.parse(bodyText);
      } catch {
        return [400, { error: "invalid_request" }];
      }
      this.calls.push({ kind: String(b.grant_type), body: b, contentType: headers["content-type"] });
      if (b.grant_type === "authorization_code") {
        if (this.mode.exchange === "500") return [500, { error: "server_error" }];
        if (this.mode.exchange === "403") return [403, { error: { type: "permission_error", message: "não pode" } }];
        const c = this.codes.get(b.code);
        const ok =
          !!c &&
          !c.used &&
          b.client_id === CLIENT_ID &&
          c.clientId === CLIENT_ID &&
          b.redirect_uri === c.redirectUri &&
          b.state === c.state &&
          sha256b64url(b.code_verifier) === c.challenge;
        if (!ok) return [400, { error: "invalid_grant", error_description: "Invalid authorization code" }];
        c.used = true;
        const { access, refresh } = this.mint(this.identity, "authorization_code");
        const out = { token_type: "Bearer", access_token: access, expires_in: ACCESS_LIFE_S, scope: c.scope };
        if (this.mode.exchange !== "no_refresh") out.refresh_token = refresh;
        if (this.mode.loginExpiry !== false) out.refresh_token_expires_in = LOGIN_LIFE_S;
        if (this.mode.account !== false) Object.assign(out, this.identityBlocks(this.identity));
        return [200, out];
      }
      if (b.grant_type === "refresh_token") {
        const r = this.refreshes.get(b.refresh_token);
        if (!r || r.used || b.client_id !== CLIENT_ID) return [400, { error: "invalid_grant" }];
        r.used = true;
        const { access, refresh } = this.mint(r.identity, "refresh_token");
        // Sem refresh_token_expires_in: o fim do login continua o da troca do código.
        return [200, { token_type: "Bearer", access_token: access, refresh_token: refresh, expires_in: ACCESS_LIFE_S, scope: SCOPE_TEXT, ...this.identityBlocks(r.identity) }];
      }
      return [400, { error: "unsupported_grant_type" }];
    }
    if (method === "GET" && pathname === "/api/oauth/profile") {
      this.calls.push({ kind: "profile" });
      if (this.mode.profile === "500") return [500, { error: { type: "api_error" } }];
      const tok = String(headers.authorization || "").replace(/^Bearer /, "");
      const id = this.access.get(tok);
      if (!id) return [401, { error: { type: "authentication_error" } }];
      return [
        200,
        {
          account: { uuid: id.uuid, email: id.email, display_name: "Dono" },
          organization: { uuid: id.orgUuid, name: id.orgName, organization_type: id.orgType, rate_limit_tier: id.tier },
        },
      ];
    }
    if (method === "GET" && pathname === "/api/oauth/usage") {
      this.calls.push({ kind: "usage" });
      return [200, { five_hour: { utilization: 10, resets_at: null }, seven_day: { utilization: 20, resets_at: null } }];
    }
    return [404, { error: "not_found" }];
  }

  count(kind) {
    return this.calls.filter((c) => c.kind === kind).length;
  }
}

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function listen(handler) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  });
}

/** A Anthropic falsa num servidor HTTP local (para as rotas do painel, que usam o fetch de verdade). */
async function startFakeServer(fake) {
  const { server, port } = await listen(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      const [status, body] = fake.handle(req.method, u.pathname, req.headers, await readAll(req));
      const text = JSON.stringify(body);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
      res.end(text);
    } catch (e) {
      res.writeHead(500);
      res.end(String(e && e.message));
    }
  });
  return { server, base: `http://127.0.0.1:${port}` };
}

function makeLogs() {
  const logs = [];
  const put = (...a) => {
    const line = a.map(String).join(" ");
    logs.push(line);
    if (process.env.TEST_LOG) console.log(line);
  };
  return { logs, log: { log: put, info: put, debug: put, warn: put, error: put } };
}

function assertNoSecrets(texts, secrets, where) {
  for (const text of texts) {
    for (const s of secrets) {
      if (s) assert.ok(!String(text).includes(s), `${where} contém um segredo (${String(s).slice(0, 14)}…): ${String(text).slice(0, 200)}`);
    }
  }
}

async function rejectsCode(promise, code) {
  let err = null;
  try {
    await promise;
  } catch (e) {
    err = e;
  }
  assert.ok(err, `esperava o erro ${code}, mas deu certo`);
  assert.equal(err.code, code, `esperava ${code}, veio ${err.code}: ${err.message}`);
  assert.equal(typeof err.message, "string");
  assert.ok(err.message.length > 10);
  return err;
}

// ---------------------------------------------------------------------------
// Módulo (fetch falso)
// ---------------------------------------------------------------------------

function unit() {
  const clock = { t: START };
  const now = () => clock.t;
  const fake = new FakeAnthropic();
  const { logs, log } = makeLogs();
  const cl = createClaudeLogin({ anthropicTokenUrl: TOKEN_URL, anthropicApiBase: API, fetchImpl: fake.fetch, now, log });
  return { clock, now, fake, logs, cl };
}

test("start: URL de autorização igual à do /login do Claude Code com código colado (PKCE S256 + state)", () => {
  const { cl, clock } = unit();
  const r = cl.start();
  assert.deepEqual(Object.keys(r).sort(), ["authUrl", "expiresAt", "loginId"]);
  assert.match(r.loginId, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(r.expiresAt, clock.t + 10 * MIN);

  const u = new URL(r.authUrl);
  assert.equal(AUTHORIZE_URL, "https://claude.com/cai/oauth/authorize");
  assert.equal(u.origin + u.pathname, AUTHORIZE_URL);
  // mesma ordem de parâmetros do Claude Code (d2o)
  assert.deepEqual([...u.searchParams.keys()], ["code", "client_id", "response_type", "redirect_uri", "scope", "code_challenge", "code_challenge_method", "state"]);
  const p = Object.fromEntries(u.searchParams);
  assert.equal(p.code, "true");
  assert.equal(p.client_id, "9d1c250a-e61b-44d9-88ed-5944d1962f5e");
  assert.equal(p.response_type, "code");
  assert.equal(p.redirect_uri, "https://platform.claude.com/oauth/code/callback");
  assert.equal(MANUAL_REDIRECT_URL, p.redirect_uri);
  assert.equal(p.scope, SCOPE_TEXT);
  assert.equal(SCOPES.join(" "), SCOPE_TEXT);
  assert.equal(p.code_challenge_method, "S256");
  assert.match(p.code_challenge, /^[A-Za-z0-9_-]{43}$/); // sha256 em base64url
  assert.match(p.state, /^[A-Za-z0-9_-]{43}$/); // 32 bytes em base64url

  const r2 = cl.start();
  const p2 = Object.fromEntries(new URL(r2.authUrl).searchParams);
  assert.notEqual(r2.loginId, r.loginId);
  assert.notEqual(p2.state, p.state);
  assert.notEqual(p2.code_challenge, p.code_challenge);
  assert.equal(cl.size(), 2);
});

test("finish com 'código#state' certo: troca o código (JSON, PKCE, state, redirect_uri), lê o perfil e monta o login", async () => {
  const { cl, fake, clock, logs } = unit();
  const { loginId, authUrl } = cl.start({ owner: "sessao-1" });
  const pasted = fake.authorize(authUrl);
  const [code, state] = pasted.split("#");

  const out = await cl.finish(loginId, `  ${pasted}\n`, { owner: "sessao-1" });

  // troca do código
  const tok = fake.requests.find((r) => r.url === TOKEN_URL);
  assert.ok(tok, "pedido ao endpoint de token");
  assert.equal(tok.method, "POST");
  assert.equal(tok.headers["content-type"], "application/json");
  assert.equal(tok.redirect, "error");
  assert.ok(tok.signal, "com tempo máximo");
  const body = JSON.parse(tok.body);
  assert.deepEqual(Object.keys(body), ["grant_type", "code", "redirect_uri", "client_id", "code_verifier", "state"]);
  assert.equal(body.grant_type, "authorization_code");
  assert.equal(body.code, code);
  assert.equal(body.state, state);
  assert.equal(body.redirect_uri, MANUAL_REDIRECT_URL);
  assert.equal(body.client_id, CLIENT_ID);
  assert.match(body.code_verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(sha256b64url(body.code_verifier), new URL(authUrl).searchParams.get("code_challenge"), "PKCE S256");

  // perfil com o access token novo
  const issued = fake.issued[0];
  const prof = fake.requests.find((r) => r.url === `${API}/api/oauth/profile`);
  assert.ok(prof, "leu o perfil");
  assert.equal(prof.headers.authorization, `Bearer ${issued.access}`);
  assert.equal(prof.redirect, "error");
  assert.ok(prof.signal);

  assert.deepEqual(out.claudeAiOauth, {
    accessToken: issued.access,
    refreshToken: issued.refresh,
    expiresAt: clock.t + ACCESS_LIFE_S * SEC,
    scopes: SCOPE_TEXT.split(" "),
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
    refreshTokenExpiresAt: clock.t + LOGIN_LIFE_S * SEC,
  });
  assert.deepEqual(out.oauthAccount, {
    emailAddress: "dono@exemplo.com",
    accountUuid: "acc-uuid-1",
    organizationUuid: "org-uuid-1",
    organizationName: "Org do Dono",
  });
  assert.equal(out.email, "dono@exemplo.com");
  assert.equal(out.plan, null);

  // uso único: o mesmo login não troca de novo
  await rejectsCode(cl.finish(loginId, pasted, { owner: "sessao-1" }), "login_expired");
  assert.equal(fake.count("authorization_code"), 1);
  assert.equal(cl.size(), 0);

  // nada de código, state, verifier nem token no log
  assertNoSecrets(logs, [...fake.secrets, body.code_verifier], "log");
  assert.ok(logs.some((l) => l.includes("dono@exemplo.com")), "o log diz qual conta entrou");
});

test("código mal colado (sem #, vazio, não texto) recusa sem gastar o login; depois o certo funciona", async () => {
  const { cl, fake } = unit();
  const { loginId, authUrl } = cl.start();
  const pasted = fake.authorize(authUrl);
  const [code, state] = pasted.split("#");
  for (const bad of ["", "   ", code, `#${state}`, `${code}#`, "#", 12345, null, undefined, "x".repeat(5000)]) {
    const e = await rejectsCode(cl.finish(loginId, bad), "bad_code");
    assert.equal(e.status, 400);
    assert.equal(e.restart, false);
    assert.ok(!e.message.includes(code));
  }
  assert.equal(fake.requests.length, 0, "nada foi à Anthropic");
  const out = await cl.finish(loginId, `"${code}#\n${state}"`); // aspas e quebra de linha da cópia
  assert.equal(out.claudeAiOauth.refreshToken, fake.issued[0].refresh);
});

test("parsePasted: igual ao Claude Code (split('#')), sem espaços nem aspas da cópia", () => {
  assert.deepEqual(parsePasted("abc#def"), { code: "abc", state: "def" });
  assert.deepEqual(parsePasted("  abc#def \r\n"), { code: "abc", state: "def" });
  assert.deepEqual(parsePasted("'abc#de f'"), { code: "abc", state: "def" });
  assert.deepEqual(parsePasted("abc#def#ghi"), { code: "abc", state: "def" }); // como o Claude Code: só as duas primeiras partes
  for (const bad of ["abc", "#def", "abc#", "", "ab\u0000c#def"]) assert.throws(() => parsePasted(bad), (e) => e.code === "bad_code");
});

test("state errado recusa sem ir à Anthropic; o login continua; 5 erros descartam o login", async () => {
  const { cl, fake, logs } = unit();
  const a = cl.start();
  const pasted = fake.authorize(a.authUrl);
  const [code] = pasted.split("#");

  const e = await rejectsCode(cl.finish(a.loginId, `${code}#state-de-outro-login`), "wrong_state");
  assert.equal(e.status, 400);
  assert.equal(e.restart, false);
  // state de outro login começado aqui também não serve
  const b = cl.start();
  const stateB = new URL(b.authUrl).searchParams.get("state");
  await rejectsCode(cl.finish(a.loginId, `${code}#${stateB}`), "wrong_state");
  assert.equal(fake.requests.length, 0, "nada foi à Anthropic");
  // o login A continua valendo
  const out = await cl.finish(a.loginId, pasted);
  assert.equal(out.email, "dono@exemplo.com");

  // 5 erros seguidos: o login sai da memória
  const c = cl.start();
  const pastedC = fake.authorize(c.authUrl);
  const [codeC] = pastedC.split("#");
  for (let i = 0; i < MAX_STATE_ERRORS; i++) await rejectsCode(cl.finish(c.loginId, `${codeC}#errado-${i}`), "wrong_state");
  await rejectsCode(cl.finish(c.loginId, pastedC), "login_expired");
  assert.equal(fake.count("authorization_code"), 1);
  assertNoSecrets(logs, fake.secrets, "log");
});

test("login vencido (10 min) ou desconhecido recusa sem ir à Anthropic", async () => {
  const { cl, fake, clock } = unit();
  const a = cl.start();
  const pasted = fake.authorize(a.authUrl);
  clock.t += 10 * MIN;
  const e = await rejectsCode(cl.finish(a.loginId, pasted), "login_expired");
  assert.equal(e.status, 410);
  assert.equal(e.restart, true);
  await rejectsCode(cl.finish("nao-existe", pasted), "login_expired");
  await rejectsCode(cl.finish(undefined, pasted), "login_expired");
  await rejectsCode(cl.finish({ id: a.loginId }, pasted), "login_expired");
  assert.equal(fake.requests.length, 0);

  // 1 ms antes de vencer ainda vale
  const b = cl.start();
  const pb = fake.authorize(b.authUrl);
  clock.t += 10 * MIN - 1;
  const out = await cl.finish(b.loginId, pb);
  assert.equal(out.email, "dono@exemplo.com");
});

test("login preso à sessão do painel que começou", async () => {
  const { cl, fake } = unit();
  const a = cl.start({ owner: "sessao-A" });
  const pasted = fake.authorize(a.authUrl);
  await rejectsCode(cl.finish(a.loginId, pasted, { owner: "sessao-B" }), "login_expired");
  await rejectsCode(cl.finish(a.loginId, pasted), "login_expired");
  assert.equal(fake.requests.length, 0);
  const out = await cl.finish(a.loginId, pasted, { owner: "sessao-A" });
  assert.equal(out.claudeAiOauth.refreshToken, fake.issued[0].refresh);
});

test("troca sem refresh_token recusa (no_refresh_token) e não guarda nada", async () => {
  const { cl, fake, logs } = unit();
  fake.mode.exchange = "no_refresh";
  const a = cl.start();
  const e = await rejectsCode(cl.finish(a.loginId, fake.authorize(a.authUrl)), "no_refresh_token");
  assert.equal(e.status, 502);
  assert.equal(e.restart, true);
  assert.equal(fake.count("profile"), 0, "nem leu o perfil");
  assertNoSecrets([e.message, ...logs], fake.secrets, "erro/log");
  assert.equal(cl.size(), 0, "o login foi gasto (o código é de uso único)");
});

test("Anthropic recusou ou falhou: code_refused, anthropic_refused, anthropic_failed (sem segredo na mensagem)", async () => {
  const { cl, fake, logs } = unit();
  const msgs = [];

  // código que a Anthropic não conhece (vencido, já usado, de outra tentativa) → invalid_grant
  const a = cl.start();
  const stateA = new URL(a.authUrl).searchParams.get("state");
  const e1 = await rejectsCode(cl.finish(a.loginId, `codigo-inventado#${stateA}`), "code_refused");
  assert.equal(e1.status, 422);
  assert.equal(e1.restart, true);
  msgs.push(e1.message);

  // o mesmo código duas vezes (outro login com o código já usado)
  const b = cl.start();
  const pb = fake.authorize(b.authUrl);
  await cl.finish(b.loginId, pb);
  const c = cl.start();
  const stateC = new URL(c.authUrl).searchParams.get("state");
  msgs.push((await rejectsCode(cl.finish(c.loginId, `${pb.split("#")[0]}#${stateC}`), "code_refused")).message);

  fake.mode.exchange = "403";
  const d = cl.start();
  const e3 = await rejectsCode(cl.finish(d.loginId, fake.authorize(d.authUrl)), "anthropic_refused");
  assert.match(e3.message, /HTTP 403/);
  assert.match(e3.message, /permission_error/);
  msgs.push(e3.message);

  fake.mode.exchange = "500";
  const f = cl.start();
  msgs.push((await rejectsCode(cl.finish(f.loginId, fake.authorize(f.authUrl)), "anthropic_failed")).message);

  fake.mode.exchange = undefined;
  fake.netError = true;
  const g = cl.start();
  msgs.push((await rejectsCode(cl.finish(g.loginId, fake.authorize(g.authUrl)), "anthropic_failed")).message);

  assertNoSecrets([...msgs, ...logs], fake.secrets, "erro/log");
});

test("sem perfil: identidade da troca do código; sem e-mail em lugar nenhum: no_identity; sem refresh_token_expires_in: data desconhecida", async () => {
  const { cl, fake, clock } = unit();
  fake.mode.profile = "500";
  fake.mode.loginExpiry = false;
  const a = cl.start();
  const out = await cl.finish(a.loginId, fake.authorize(a.authUrl));
  assert.deepEqual(out.oauthAccount, {
    emailAddress: "dono@exemplo.com",
    accountUuid: "acc-uuid-1",
    organizationUuid: "org-uuid-1",
    organizationName: "Org do Dono",
  });
  assert.deepEqual(Object.keys(out.claudeAiOauth).sort(), ["accessToken", "expiresAt", "refreshToken", "scopes"]);
  assert.equal(out.claudeAiOauth.expiresAt, clock.t + ACCESS_LIFE_S * SEC);

  fake.mode.account = false;
  const b = cl.start();
  const e = await rejectsCode(cl.finish(b.loginId, fake.authorize(b.authUrl)), "no_identity");
  assert.equal(e.status, 502);
});

test(`no máximo ${MAX_LOGINS} logins em andamento: o ${MAX_LOGINS + 1}º tira o mais antigo`, async () => {
  const { cl, fake } = unit();
  const first = cl.start();
  const pasted = fake.authorize(first.authUrl);
  for (let i = 0; i < MAX_LOGINS; i++) cl.start();
  assert.equal(cl.size(), MAX_LOGINS);
  await rejectsCode(cl.finish(first.loginId, pasted), "login_expired");
});

test("endereços da Anthropic: só https (http só em 127.0.0.1/localhost)", () => {
  assert.throws(() => createClaudeLogin({ anthropicTokenUrl: "http://anthropic.exemplo.com/v1/oauth/token" }), /https/);
  assert.throws(() => createClaudeLogin({ anthropicApiBase: "http://api.exemplo.com" }), /https/);
  assert.throws(() => createClaudeLogin({ anthropicTokenUrl: "não é endereço" }), /inválido/);
  assert.doesNotThrow(() => createClaudeLogin({ anthropicTokenUrl: "http://127.0.0.1:9/v1/oauth/token", anthropicApiBase: "http://localhost:9" }));
  assert.doesNotThrow(() => createClaudeLogin());
});

// ---------------------------------------------------------------------------
// Rotas do painel (servidor de verdade + Anthropic falsa num servidor local)
// ---------------------------------------------------------------------------

/** Engine falso: só o que o painel usa; storeFreshLogin registra as chamadas e cria/atualiza no cofre. */
class FakeEngine {
  constructor(store, now) {
    this.store = store;
    this.now = now;
    this.calls = [];
    this.loginError = null;
  }
  get st() {
    return this.store.state;
  }
  start() {}
  stop() {}
  rulesEffective() {
    return { ...RULE_DEFAULTS, ...(this.st.rules || {}) };
  }
  records() {
    return {};
  }
  devicesList() {
    return [];
  }
  status() {
    return {};
  }
  publicList() {
    const accounts = Object.values(this.st.accounts).map((a) => ({
      number: a.number,
      email: a.email,
      organizationName: a.orgName || "",
      organizationUuid: a.orgUuid || "",
      plan: a.plan || null,
      usageStatus: "unknown",
      usage: null,
      dead: false,
      cred: a.cred, // "vazamento" de propósito: o painel não pode deixar sair
    }));
    return { schemaVersion: 1, activeAccountNumber: null, accounts };
  }
  pushHistory(kind, text, deviceId) {
    if (!Array.isArray(this.st.history)) this.st.history = [];
    this.st.history.unshift({ ts: new Date(this.now()).toISOString(), kind, text, device: deviceId || null });
  }
  async addLogin(args) {
    // O painel não usa mais o addLogin (ele renovaria na hora um login que acabou de ser emitido).
    this.calls.push({ name: "addLogin", args: JSON.parse(JSON.stringify(args)), keys: Object.keys(args) });
    throw new Error("o painel não deveria chamar addLogin");
  }
  async storeFreshLogin(args) {
    this.calls.push({ name: "storeFreshLogin", args: JSON.parse(JSON.stringify(args)), keys: Object.keys(args) });
    if (this.loginError) throw Object.assign(new Error(this.loginError.message), this.loginError.code ? { code: this.loginError.code } : {});
    const email = args.oauthAccount.emailAddress;
    const found = Object.values(this.st.accounts).find((a) => a.email === email);
    if (found) {
      found.cred = { ...args.claudeAiOauth };
      found.gen += 1;
      return { number: found.number, created: false };
    }
    const number = this.st.nextNumber++;
    this.st.accounts[String(number)] = {
      number,
      email,
      orgUuid: args.oauthAccount.organizationUuid || null,
      orgName: args.oauthAccount.organizationName || null,
      plan: null,
      cred: { ...args.claudeAiOauth },
      gen: 1,
    };
    await this.store.save();
    return { number, created: true };
  }
}

/** engine: "fake" (FakeEngine) ou "real" (engine.js + anthropic.js contra a Anthropic falsa). */
async function setupRoutes(t, { engine: kind = "fake" } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-claudelogin-"));
  const keyFile = path.join(dir, "chave-mestra");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "dados"), keyFile });
  store.load();
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const fake = new FakeAnthropic();
  const fakeSrv = await startFakeServer(fake);
  const config = loadConfig({
    TLS_MODE: "off",
    DATA_DIR: dir,
    PUBLIC_URL,
    ADMIN_EMAILS: ADMIN,
    MASTER_KEY_FILE: keyFile,
    ANTHROPIC_TOKEN_URL: `${fakeSrv.base}/v1/oauth/token`,
    ANTHROPIC_API_BASE: fakeSrv.base,
    GOOGLE_CLIENT_ID_FILE: path.join(dir, "nao-existe-google-id"),
    GOOGLE_CLIENT_SECRET_FILE: path.join(dir, "nao-existe-google-secret"),
  });
  config.webDir = path.join(dir, "web");
  const { logs, log } = makeLogs();
  const engine =
    kind === "real"
      ? new Engine({ store, anthropic: createAnthropic({ tokenUrl: config.tokenUrl, apiBase: config.apiBase, now }), now, log, env: {} })
      : new FakeEngine(store, now);
  const app = createApp({ store, engine, config, now, log });
  const api = await listen(app.api);
  t.after(async () => {
    await close(api.server);
    await close(fakeSrv.server);
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const ctx = { dir, keyFile, store, clock, now, fake, config, logs, app, engine, port: api.port, sessionTokens: [] };
  ctx.session = async () => {
    const { id, token } = app.web.createSession({ email: ADMIN, ip: "127.0.0.1", ua: "teste" });
    await store.save();
    ctx.sessionTokens.push(token);
    return { id, token, csrf: store.state.webSessions[id].csrf };
  };
  return ctx;
}

/** Segredos que nunca saem numa resposta do painel (o authUrl do start leva o state: ele fica de fora só lá). */
function routeSecrets(ctx, { withState = true } = {}) {
  const states = new Set();
  for (const c of ctx.fake.codes.values()) states.add(c.state);
  const list = [...ctx.fake.secrets.filter((s) => withState || !states.has(s)), ...ctx.sessionTokens];
  for (const a of Object.values(ctx.store.state.accounts)) if (a.cred) list.push(a.cred.accessToken, a.cred.refreshToken);
  return list;
}

/**
 * Pedido ao painel. s = { token, csrf } (cookie + X-CSRF-Token); origin padrão = o do painel nos métodos que mudam algo.
 * Toda resposta passa pela checagem de segredos (sem os states quando `allowState`).
 */
function call(ctx, method, p, { s, body, origin, csrf, allowState = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = {};
    if (s && s.token) h.cookie = `sp_sess=${s.token}`;
    const o = origin === undefined ? (method === "GET" ? null : PUBLIC_URL) : origin;
    if (o) h.origin = o;
    const x = csrf === undefined ? s && s.csrf : csrf;
    if (x) h["x-csrf-token"] = x;
    if (data !== null) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: "127.0.0.1", port: ctx.port, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        try {
          assertNoSecrets([text], routeSecrets(ctx, { withState: !allowState }), `resposta de ${method} ${p}`);
          assert.ok(!/"(refreshToken|accessToken|refresh_token|access_token|code_verifier|verifier)"/.test(text), `resposta de ${method} ${p} com chave de token: ${text.slice(0, 300)}`);
          if (res.statusCode >= 400) {
            assert.ok(json && typeof json.error === "string" && typeof json.message === "string", `erro sem {error, message}: ${text}`);
            assert.ok(!/\n\s+at /.test(text), `erro com stack: ${text}`);
          }
        } catch (e) {
          reject(e);
          return;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

const startLogin = (ctx, s) => call(ctx, "POST", "/web/api/claude-login/start", { s, body: {}, allowState: true });
const finishLogin = (ctx, s, loginId, code) => call(ctx, "POST", "/web/api/claude-login/finish", { s, body: { loginId, code } });

function assertLogsClean(ctx) {
  assertNoSecrets(ctx.logs, [...routeSecrets(ctx), ...ctx.fake.calls.filter((c) => c.body && c.body.code_verifier).map((c) => c.body.code_verifier)], "log");
}

test("rotas: só o administrador com sessão, Origin do painel e X-CSRF-Token", async (t) => {
  const ctx = await setupRoutes(t);
  const s = await ctx.session();
  const r401 = await call(ctx, "POST", "/web/api/claude-login/start", { body: {} });
  assert.equal(r401.status, 401, r401.text);
  const rOrigin = await call(ctx, "POST", "/web/api/claude-login/start", { s, body: {}, origin: null });
  assert.equal(rOrigin.status, 403);
  assert.equal(rOrigin.json.error, "bad_origin");
  const rOrigin2 = await call(ctx, "POST", "/web/api/claude-login/finish", { s, body: { loginId: "x", code: "a#b" }, origin: "https://outro.exemplo.com" });
  assert.equal(rOrigin2.status, 403);
  const rCsrf = await call(ctx, "POST", "/web/api/claude-login/start", { s, body: {}, csrf: null });
  assert.equal(rCsrf.status, 403);
  assert.equal(rCsrf.json.error, "csrf");
  const rCsrf2 = await call(ctx, "POST", "/web/api/claude-login/finish", { s, body: { loginId: "x", code: "a#b" }, csrf: "errado" });
  assert.equal(rCsrf2.status, 403);
  const rGet = await call(ctx, "GET", "/web/api/claude-login/start", { s });
  assert.equal(rGet.status, 405);

  const ok = await startLogin(ctx, s);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(Object.keys(ok.json).sort(), ["authUrl", "expiresAt", "loginId"]);
  assert.equal(ok.headers["cache-control"], "no-store");
  const u = new URL(ok.json.authUrl);
  assert.equal(u.origin + u.pathname, AUTHORIZE_URL);
  assert.equal(u.searchParams.get("redirect_uri"), MANUAL_REDIRECT_URL);
  assert.equal(ctx.fake.calls.length, 0, "começar não fala com a Anthropic");
});

test("fluxo completo: start → entrar na conta → colar o código → storeFreshLogin com o refresh token; histórico; nada de token na resposta nem no log", async (t) => {
  const ctx = await setupRoutes(t);
  const s = await ctx.session();
  const st = await startLogin(ctx, s);
  assert.equal(st.status, 200, st.text);
  const pasted = ctx.fake.authorize(st.json.authUrl);

  const fin = await finishLogin(ctx, s, st.json.loginId, pasted);
  assert.equal(fin.status, 200, fin.text);
  assert.equal(fin.json.ok, true);
  assert.equal(fin.json.number, 1);
  assert.equal(fin.json.created, true);
  assert.equal(fin.json.email, "dono@exemplo.com");
  assert.match(fin.json.message, /^Conta 1 adicionada \(dono@exemplo\.com\)/);
  assert.ok(fin.json.state && Array.isArray(fin.json.state.accounts), "devolve o PanelState atualizado");
  assert.equal(fin.json.state.accounts.length, 1);

  // storeFreshLogin recebeu o login trocado agora (com o refresh token); o addLogin (que renova na hora) não
  const calls = ctx.engine.calls.filter((c) => c.name === "storeFreshLogin");
  assert.equal(ctx.engine.calls.filter((c) => c.name === "addLogin").length, 0);
  assert.equal(calls.length, 1);
  const args = calls[0].args;
  const issued = ctx.fake.issued[0];
  assert.equal(args.claudeAiOauth.refreshToken, issued.refresh);
  assert.equal(args.claudeAiOauth.accessToken, issued.access);
  assert.equal(args.claudeAiOauth.subscriptionType, "max");
  assert.deepEqual(args.claudeAiOauth.scopes, SCOPE_TEXT.split(" "));
  assert.equal(args.claudeAiOauth.refreshTokenExpiresAt, ctx.clock.t + LOGIN_LIFE_S * SEC);
  assert.deepEqual(args.oauthAccount, {
    emailAddress: "dono@exemplo.com",
    accountUuid: "acc-uuid-1",
    organizationUuid: "org-uuid-1",
    organizationName: "Org do Dono",
  });
  assert.deepEqual(calls[0].keys.sort(), ["claudeAiOauth", "oauthAccount", "plan"], "sem computador (nem deviceId)");
  assert.equal(args.plan, undefined);

  // a Anthropic falsa viu exatamente uma troca do código, com o PKCE certo
  assert.equal(ctx.fake.count("authorization_code"), 1);
  const ex = ctx.fake.calls.find((c) => c.kind === "authorization_code");
  assert.equal(ex.contentType, "application/json");
  assert.equal(sha256b64url(ex.body.code_verifier), new URL(st.json.authUrl).searchParams.get("code_challenge"));

  // histórico
  assert.equal(ctx.store.state.history[0].text, "Conta 1 adicionada pelo painel (login da assinatura)");
  assert.equal(ctx.store.state.history[0].device, null);

  // o mesmo login não termina duas vezes
  const again = await finishLogin(ctx, s, st.json.loginId, pasted);
  assert.equal(again.status, 410);
  assert.equal(again.json.error, "login_expired");
  assert.equal(again.json.restart, true);
  assert.equal(ctx.fake.count("authorization_code"), 1);

  assertLogsClean(ctx);
});

test("conta que já existe: created false, mensagem e histórico de atualizada", async (t) => {
  const ctx = await setupRoutes(t);
  const s = await ctx.session();
  for (let i = 0; i < 2; i++) {
    const st = await startLogin(ctx, s);
    const fin = await finishLogin(ctx, s, st.json.loginId, ctx.fake.authorize(st.json.authUrl));
    assert.equal(fin.status, 200, fin.text);
    assert.equal(fin.json.number, 1);
    assert.equal(fin.json.created, i === 0);
  }
  const last = ctx.store.state.history[0].text;
  assert.equal(last, "Conta 1 atualizada pelo painel (login da assinatura)");
  assert.equal(ctx.engine.calls.length, 2);
  assert.equal(ctx.engine.calls[1].args.claudeAiOauth.refreshToken, ctx.fake.issued[1].refresh);
  assertLogsClean(ctx);
});

test("erros em português: código mal colado, state errado, vencido, recusado, sem refresh token (storeFreshLogin não é chamado)", async (t) => {
  const ctx = await setupRoutes(t);
  const s = await ctx.session();
  const st = await startLogin(ctx, s);
  const pasted = ctx.fake.authorize(st.json.authUrl);
  const [code] = pasted.split("#");

  const noId = await finishLogin(ctx, s, "", pasted);
  assert.equal(noId.status, 400);
  assert.equal(noId.json.restart, true);
  const empty = await finishLogin(ctx, s, st.json.loginId, "  ");
  assert.equal(empty.status, 400);
  assert.equal(empty.json.error, "bad_code");
  assert.equal(empty.json.restart, false);
  const noHash = await finishLogin(ctx, s, st.json.loginId, code);
  assert.equal(noHash.status, 400);
  assert.equal(noHash.json.error, "bad_code");
  assert.match(noHash.json.message, /cole/);
  const notText = await call(ctx, "POST", "/web/api/claude-login/finish", { s, body: { loginId: st.json.loginId, code: 123 } });
  assert.equal(notText.status, 400);
  const wrong = await finishLogin(ctx, s, st.json.loginId, `${code}#outro-state`);
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.error, "wrong_state");
  assert.equal(wrong.json.restart, false);
  assert.match(wrong.json.message, /não é deste login/);
  assert.equal(ctx.fake.calls.length, 0, "nada foi à Anthropic");
  assert.equal(ctx.engine.calls.length, 0);

  // depois dos erros o login continua valendo
  const ok = await finishLogin(ctx, s, st.json.loginId, pasted);
  assert.equal(ok.status, 200, ok.text);

  // vencido
  const st2 = await startLogin(ctx, s);
  const pasted2 = ctx.fake.authorize(st2.json.authUrl);
  ctx.clock.t += 10 * MIN;
  const old = await finishLogin(ctx, s, st2.json.loginId, pasted2);
  assert.equal(old.status, 410);
  assert.equal(old.json.error, "login_expired");
  assert.match(old.json.message, /venceu/);

  // código que a Anthropic não aceita
  const st3 = await startLogin(ctx, s);
  const state3 = new URL(st3.json.authUrl).searchParams.get("state");
  const refused = await finishLogin(ctx, s, st3.json.loginId, `codigo-inventado#${state3}`);
  assert.equal(refused.status, 422);
  assert.equal(refused.json.error, "code_refused");
  assert.match(refused.json.message, /não aceitou o código/);

  // sem refresh token
  ctx.fake.mode.exchange = "no_refresh";
  const st4 = await startLogin(ctx, s);
  const noRefresh = await finishLogin(ctx, s, st4.json.loginId, ctx.fake.authorize(st4.json.authUrl));
  assert.equal(noRefresh.status, 502);
  assert.equal(noRefresh.json.error, "no_refresh_token");
  assert.match(noRefresh.json.message, /refresh token/);

  // falha da Anthropic
  ctx.fake.mode.exchange = "500";
  const st5 = await startLogin(ctx, s);
  const down = await finishLogin(ctx, s, st5.json.loginId, ctx.fake.authorize(st5.json.authUrl));
  assert.equal(down.status, 502);
  assert.equal(down.json.error, "anthropic_failed");

  assert.equal(ctx.engine.calls.length, 1, "só o login que deu certo chegou ao storeFreshLogin");
  assertLogsClean(ctx);
});

test("erros do storeFreshLogin viram mensagens do painel (dead_login 422, refresh_failed 503, identity_mismatch com o detalhe, sem código → 500)", async (t) => {
  const ctx = await setupRoutes(t);
  const s = await ctx.session();
  const cases = [
    { err: { code: "dead_login", message: "esse login não vale mais" }, status: 422, re: /recusou renovar/ },
    { err: { code: "refresh_failed", message: "não consegui renovar" }, status: 503, re: /não conseguiu guardar a conta/ },
    { err: { code: "identity_mismatch", message: "esse login é de outro@exemplo.com, não de dono@exemplo.com" }, status: 422, re: /outro@exemplo\.com/ },
    { err: { code: "codigo_novo_do_motor", message: "explicação do motor" }, status: 422, re: /explicação do motor/ },
  ];
  for (const c of cases) {
    ctx.engine.loginError = c.err;
    const st = await startLogin(ctx, s);
    const r = await finishLogin(ctx, s, st.json.loginId, ctx.fake.authorize(st.json.authUrl));
    assert.equal(r.status, c.status, r.text);
    assert.equal(r.json.error, c.err.code);
    assert.equal(r.json.restart, true);
    assert.match(r.json.message, c.re);
  }
  ctx.engine.loginError = { message: "TypeError interno com detalhe" };
  const st = await startLogin(ctx, s);
  const r = await finishLogin(ctx, s, st.json.loginId, ctx.fake.authorize(st.json.authUrl));
  assert.equal(r.status, 500);
  assert.equal(r.json.error, "internal");
  assert.ok(!r.text.includes("detalhe"));
  assert.equal(Object.keys(ctx.store.state.accounts).length, 0);
  assert.ok(!ctx.store.state.history.some((h) => /login da assinatura/.test(h.text)), "nada no histórico quando falha");
  assertLogsClean(ctx);
});

test("login começado numa sessão do painel não termina em outra", async (t) => {
  const ctx = await setupRoutes(t);
  const s1 = await ctx.session();
  const s2 = await ctx.session();
  const st = await startLogin(ctx, s1);
  const pasted = ctx.fake.authorize(st.json.authUrl);
  const other = await finishLogin(ctx, s2, st.json.loginId, pasted);
  assert.equal(other.status, 410);
  assert.equal(ctx.fake.calls.length, 0);
  const mine = await finishLogin(ctx, s1, st.json.loginId, pasted);
  assert.equal(mine.status, 200, mine.text);
});

test("fim a fim com o motor de verdade: a conta é guardada com o login da troca do código (SEM renovar na hora), gravada no cofre", async (t) => {
  const ctx = await setupRoutes(t, { engine: "real" });
  const s = await ctx.session();
  const st = await startLogin(ctx, s);
  assert.equal(st.status, 200, st.text);
  const fin = await finishLogin(ctx, s, st.json.loginId, ctx.fake.authorize(st.json.authUrl));
  assert.equal(fin.status, 200, fin.text);
  assert.equal(fin.json.number, 1);
  assert.equal(fin.json.created, true);

  // Só a troca do código: o motor não gastou o refresh token novinho; conferiu a identidade pelo perfil.
  const [exchanged] = ctx.fake.issued;
  assert.equal(ctx.fake.issued.length, 1);
  assert.equal(exchanged.grant, "authorization_code");
  assert.equal(ctx.fake.count("authorization_code"), 1);
  assert.equal(ctx.fake.count("refresh_token"), 0, "nada de renovação na hora");
  assert.equal(ctx.fake.count("profile"), 2, "o claudelogin lê o perfil e o motor confere a identidade com ele");

  const acc = ctx.store.state.accounts["1"];
  assert.equal(acc.email, "dono@exemplo.com");
  assert.equal(acc.orgUuid, "org-uuid-1");
  assert.equal(acc.orgName, "Org do Dono");
  assert.equal(acc.cred.refreshToken, exchanged.refresh);
  assert.equal(acc.cred.accessToken, exchanged.access);
  assert.equal(acc.cred.expiresAt, ctx.clock.t + ACCESS_LIFE_S * SEC);
  assert.equal(acc.cred.subscriptionType, "max");
  assert.equal(acc.cred.refreshTokenExpiresAt, ctx.clock.t + LOGIN_LIFE_S * SEC, "fim do login = o da troca do código");
  assert.deepEqual(acc.plan, { label: "Max" });
  assert.equal(acc.gen, 1);
  assert.equal(acc.dead, null);
  assert.deepEqual(acc.spentRefresh, [], "nada foi gasto");

  // gravado no disco antes de responder
  let disk = decrypt(loadKey(ctx.keyFile), fs.readFileSync(ctx.store.file));
  assert.equal(disk.accounts["1"].cred.refreshToken, exchanged.refresh);

  const texts = ctx.store.state.history.map((h) => h.text);
  assert.ok(texts.includes("Conta 1 adicionada pelo painel (login da assinatura)"), texts.join(" | "));
  assert.ok(texts.includes("Login da conta 1 recebido (login novo da assinatura, pelo painel)"), texts.join(" | "));

  // De novo com a mesma conta: atualiza (gen 2) com o login novo, ainda sem renovar.
  const st2 = await startLogin(ctx, s);
  const fin2 = await finishLogin(ctx, s, st2.json.loginId, ctx.fake.authorize(st2.json.authUrl));
  assert.equal(fin2.status, 200, fin2.text);
  assert.equal(fin2.json.number, 1);
  assert.equal(fin2.json.created, false);
  assert.match(fin2.json.message, /já estava no servidor/);
  assert.equal(ctx.fake.issued.length, 2);
  assert.equal(ctx.store.state.accounts["1"].cred.refreshToken, ctx.fake.issued[1].refresh);
  assert.equal(ctx.store.state.accounts["1"].gen, 2);
  assert.equal(ctx.fake.count("refresh_token"), 0);
  disk = decrypt(loadKey(ctx.keyFile), fs.readFileSync(ctx.store.file));
  assert.equal(disk.accounts["1"].cred.refreshToken, ctx.fake.issued[1].refresh);

  // Identidade errada (o perfil mostra outra conta): recusa sem mudar nada.
  const st3 = await startLogin(ctx, s);
  const pasted3 = ctx.fake.authorize(st3.json.authUrl);
  const realHandle = ctx.fake.handle.bind(ctx.fake);
  let profiles = 0;
  ctx.fake.handle = (method, pathname, headers, bodyText) => {
    const out = realHandle(method, pathname, headers, bodyText);
    // 1ª leitura do perfil (claudelogin) normal; a 2ª (a conferência do motor) diz que é outra pessoa.
    if (method === "GET" && pathname === "/api/oauth/profile" && ++profiles === 2) {
      return [200, { ...out[1], account: { ...out[1].account, email: "outra@exemplo.com" } }];
    }
    return out;
  };
  const fin3 = await finishLogin(ctx, s, st3.json.loginId, pasted3);
  ctx.fake.handle = realHandle;
  assert.equal(fin3.status, 422, fin3.text);
  assert.equal(fin3.json.error, "identity_mismatch");
  assert.equal(fin3.json.restart, true);
  assert.equal(ctx.store.state.accounts["1"].cred.refreshToken, ctx.fake.issued[1].refresh, "a conta continua com o login de antes");
  assert.equal(Object.keys(ctx.store.state.accounts).length, 1);
  assert.equal(ctx.fake.count("refresh_token"), 0);
  assertLogsClean(ctx);
});
