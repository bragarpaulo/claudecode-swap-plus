"use strict";
// Testes do login dos serviços com Google (server.js + google.js).
// Um "Google falso" (servidor HTTP local em 127.0.0.1) serve a tela de login e o endpoint de token;
// GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL apontam para ele. Cofre de verdade numa pasta temporária
// (chave gerada aqui) e um engine mínimo (só o que as rotas usam).
// Rodar no servidor:  node --test server/test/*.test.js     (TEST_LOG=1 mostra os logs)

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const { Store, decrypt, loadKey } = require("../src/store");
const { createApp, loadConfig } = require("../src/server");

const PUBLIC_URL = "https://swap.exemplo.com";
const CALLBACK = `${PUBLIC_URL}/auth/google/callback`;
const CLIENT_ID = "123456-falso.apps.googleusercontent.com";
const CLIENT_SECRET = "segredo-google-de-teste-NAO-PODE-VAZAR";
const CSP = "default-src 'none'; style-src 'unsafe-inline'";
const MIN = 60 * 1000;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64json = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");
const bearer = (token) => ({ authorization: `Bearer ${token}` });
const pathOf = (url) => {
  const u = new URL(url);
  return u.pathname + u.search;
};

// ---------------------------------------------------------------------------
// Engine mínimo: as rotas do login só usam stateFor (no /v1/state) e pushHistory (+ addLogin, só registra).
// ---------------------------------------------------------------------------

class MiniEngine {
  constructor(store) {
    this.store = store;
    this.history = [];
    this.logins = []; // addLogin recebidos
  }
  start() {}
  stop() {}
  rulesEffective() {
    return {};
  }
  stateFor(deviceId) {
    const d = this.store.state.devices[deviceId];
    return { serverTime: Date.now(), version: "teste", device: d ? { id: d.id, name: d.name } : null, devices: [] };
  }
  pushHistory(kind, text, deviceId) {
    this.history.unshift({ kind, text, device: deviceId || null });
  }
  async addLogin(args) {
    this.logins.push(args);
    return { number: 1, created: true };
  }
}

// ---------------------------------------------------------------------------
// Google falso
// ---------------------------------------------------------------------------

function readAll(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function replyJson(res, status, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(b) });
  res.end(b);
}

/**
 * Tela de login: confere o pedido, "entra" com g.email e volta para o redirect_uri com code + state.
 * Token: confere client_id, client_secret, redirect_uri, uso único do code e o PKCE (S256), e devolve
 * um id_token (assinatura falsa). g.claims(t) sobrescreve campos do id_token; g.tokenFail força a
 * próxima resposta do endpoint de token.
 */
async function startFakeGoogle(now) {
  const g = {
    email: "ana@exemplo.com",
    claims: null,
    tokenFail: null,
    codes: new Map(), // code → { challenge, redirectUri, email, used }
    authCalls: [],
    tokenCalls: [],
    idTokens: [],
  };
  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, "http://127.0.0.1");
      if (req.method === "GET" && u.pathname === "/o/oauth2/v2/auth") {
        const p = Object.fromEntries(u.searchParams);
        g.authCalls.push(p);
        const okReq =
          p.client_id === CLIENT_ID &&
          p.response_type === "code" &&
          p.code_challenge_method === "S256" &&
          /^[A-Za-z0-9_-]{43}$/.test(p.code_challenge || "") &&
          !!p.state &&
          !!p.redirect_uri;
        if (!okReq) {
          res.writeHead(400);
          res.end("pedido inválido");
          return;
        }
        const code = `4/0-codigo-${crypto.randomBytes(12).toString("hex")}`;
        g.codes.set(code, { challenge: p.code_challenge, redirectUri: p.redirect_uri, email: g.email, used: false });
        const back = new URL(p.redirect_uri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", p.state);
        res.writeHead(302, { location: back.toString() });
        res.end();
        return;
      }
      if (req.method === "POST" && u.pathname === "/token") {
        const form = Object.fromEntries(new URLSearchParams(await readAll(req)));
        g.tokenCalls.push({ contentType: req.headers["content-type"], form });
        if (g.tokenFail) {
          const f = g.tokenFail;
          g.tokenFail = null;
          replyJson(res, f.status, f.body);
          return;
        }
        const c = g.codes.get(form.code);
        const pkceOk = !!c && crypto.createHash("sha256").update(String(form.code_verifier || "")).digest("base64url") === c.challenge;
        if (
          !c ||
          c.used ||
          !pkceOk ||
          form.client_id !== CLIENT_ID ||
          form.client_secret !== CLIENT_SECRET ||
          form.grant_type !== "authorization_code" ||
          form.redirect_uri !== c.redirectUri
        ) {
          replyJson(res, 400, { error: "invalid_grant", error_description: "Bad Request" });
          return;
        }
        c.used = true;
        const t = Math.floor(now() / 1000);
        const claims = {
          iss: "https://accounts.google.com",
          azp: CLIENT_ID,
          aud: CLIENT_ID,
          sub: "110169484474386276334",
          email: c.email,
          email_verified: true,
          at_hash: "hash-falso",
          iat: t,
          exp: t + 3600,
          ...(g.claims ? g.claims(t) : {}),
        };
        const idToken = [b64json({ alg: "RS256", kid: "chave-falsa", typ: "JWT" }), b64json(claims), "assinatura-falsa"].join(".");
        g.idTokens.push(idToken);
        replyJson(res, 200, {
          access_token: `ya29.acesso-falso-${crypto.randomBytes(8).toString("hex")}`,
          expires_in: 3599,
          scope: "openid https://www.googleapis.com/auth/userinfo.email",
          token_type: "Bearer",
          id_token: idToken,
        });
        return;
      }
      res.writeHead(404);
      res.end();
    } catch (e) {
      res.writeHead(500);
      res.end(String(e && e.message));
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  g.server = server;
  g.port = server.address().port;
  g.authUrl = `http://127.0.0.1:${g.port}/o/oauth2/v2/auth`;
  g.tokenUrl = `http://127.0.0.1:${g.port}/token`;
  return g;
}

// ---------------------------------------------------------------------------
// Montagem
// ---------------------------------------------------------------------------

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

/** google: false = sem os arquivos do client id/secret (login com Google desligado). */
async function setup(t, { env = {}, google = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-google-"));
  const keyFile = path.join(dir, "chave-mestra");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "dados"), keyFile });
  store.load();
  const clock = { t: Date.now() };
  const now = () => clock.t;
  const fake = await startFakeGoogle(now);
  const idFile = path.join(dir, "google_client_id");
  const secretFile = path.join(dir, "google_client_secret");
  if (google) {
    fs.writeFileSync(idFile, `${CLIENT_ID}\n`);
    fs.writeFileSync(secretFile, `${CLIENT_SECRET}\n`);
  }
  const config = loadConfig({
    TLS_MODE: "off",
    DATA_DIR: dir,
    PUBLIC_URL,
    GOOGLE_CLIENT_ID_FILE: idFile,
    GOOGLE_CLIENT_SECRET_FILE: secretFile,
    GOOGLE_AUTH_URL: fake.authUrl,
    GOOGLE_TOKEN_URL: fake.tokenUrl,
    ...env,
  });
  const engine = new MiniEngine(store);
  const logs = [];
  const put = (...a) => {
    const line = a.map(String).join(" ");
    logs.push(line);
    if (process.env.TEST_LOG) console.log(line);
  };
  const log = { log: put, info: put, debug: put, warn: put, error: put };
  const app = createApp({ store, engine, config, now, log });
  const api = await listen(app.api);
  const admin = await listen(app.admin);
  t.after(async () => {
    await close(api.server);
    await close(admin.server);
    await close(fake.server);
    store.close(); // solta a trava da pasta (store.lock)
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, keyFile, store, engine, clock, config, app, fake, logs, api: api.port, admin: admin.port };
}

/** O que está gravado no cofre em disco (sem abrir um segundo Store na mesma pasta: a trava store.lock não deixa). */
function cofreEmDisco(ctx) {
  return decrypt(loadKey(ctx.keyFile), fs.readFileSync(ctx.store.file));
}

/** Requisição HTTP crua para a API/admin. */
function request(port, method, p, { body, headers = {}, agent = false } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    if (data !== null) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: "127.0.0.1", port, method, path: p, headers: h, agent }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    if (data !== null) req.write(data);
    req.end();
  });
}

/** GET numa URL absoluta (o Google falso). */
function getUrl(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8") }));
      res.on("error", reject);
    });
    req.on("error", reject);
  });
}

/** Página HTML com os cabeçalhos de segurança, sem script e sem recurso externo. */
function assertPage(r, status) {
  assert.equal(r.status, status, r.text);
  assert.match(String(r.headers["content-type"]), /^text\/html; charset=utf-8/);
  assert.equal(r.headers["content-security-policy"], CSP);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["referrer-policy"], "no-referrer");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.match(r.text, /^<!doctype html>/);
  assert.ok(!/<script/i.test(r.text), "página sem script");
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(r.text), "página sem recurso externo");
}

async function allow(ctx, email) {
  const r = await request(ctx.admin, "POST", "/admin/allow", { body: { email } });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

async function loginStart(ctx, { name = "Notebook", platform = "darwin", headers } = {}) {
  const r = await request(ctx.api, "POST", "/v1/login/start", { body: { name, platform }, headers });
  assert.equal(r.status, 200, r.text);
  return r.json;
}

function poll(ctx, s, headers) {
  return request(ctx.api, "POST", "/v1/login/poll", { body: { sessionId: s.sessionId, pollToken: s.pollToken }, headers });
}

/**
 * O navegador: abre o link do VS Code → 302 para o Google → entra com `email` → 302 de volta
 * para o retorno do servidor → página final.
 */
async function browserLogin(ctx, s, email = "ana@exemplo.com") {
  const redirect = await request(ctx.api, "GET", pathOf(s.authUrl));
  assert.equal(redirect.status, 302, redirect.text);
  const toGoogle = new URL(redirect.headers.location);
  ctx.fake.email = email;
  const g = await getUrl(toGoogle.toString());
  assert.equal(g.status, 302, g.text);
  const back = new URL(g.headers.location);
  assert.equal(back.origin + back.pathname, CALLBACK);
  const callbackPath = back.pathname + back.search;
  const page = await request(ctx.api, "GET", callbackPath);
  return { redirect, toGoogle, callbackPath, page };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test("login com Google: start → Google (PKCE + state) → callback cria o serviço → poll entrega uma vez → token funciona", async (t) => {
  const ctx = await setup(t);
  await allow(ctx, "  Ana@Exemplo.com ");
  assert.deepEqual(ctx.store.state.allowedEmails, ["ana@exemplo.com"]);

  const s = await loginStart(ctx, { name: "Notebook do Paulo" });
  assert.match(s.sessionId, /^[A-Za-z0-9_-]{22}$/); // 16 bytes
  assert.match(s.pollToken, /^[A-Za-z0-9_-]{43}$/); // 32 bytes
  assert.equal(s.authUrl, `${PUBLIC_URL}/auth/google/start?s=${s.sessionId}`);
  assert.equal(s.expiresAt, ctx.clock.t + 10 * MIN);
  const cofre = JSON.stringify(ctx.store.state);
  assert.ok(!cofre.includes(s.sessionId) && !cofre.includes(s.pollToken), "a sessão de login fica só na memória");

  let r = await poll(ctx, s);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { status: "pending" });

  const b = await browserLogin(ctx, s, "ana@exemplo.com");

  // 302 para o Google, com PKCE S256 e state
  assert.equal(b.redirect.headers["cache-control"], "no-store");
  assert.equal(b.redirect.headers["referrer-policy"], "no-referrer");
  assert.equal(b.toGoogle.origin + b.toGoogle.pathname, ctx.fake.authUrl);
  const q = Object.fromEntries(b.toGoogle.searchParams);
  assert.equal(q.client_id, CLIENT_ID);
  assert.equal(q.redirect_uri, CALLBACK);
  assert.equal(q.response_type, "code");
  assert.equal(q.scope, "openid email");
  assert.equal(q.code_challenge_method, "S256");
  assert.equal(q.prompt, "select_account");
  assert.match(q.state, /^[A-Za-z0-9_-]{22}$/);
  assert.notEqual(q.state, s.sessionId);
  assert.match(q.code_challenge, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!b.redirect.headers.location.includes(CLIENT_SECRET));

  // troca do code: form-urlencoded, com client_secret e o code_verifier do PKCE (o Google falso confere)
  assert.equal(ctx.fake.tokenCalls.length, 1);
  const tc = ctx.fake.tokenCalls[0];
  assert.match(String(tc.contentType), /^application\/x-www-form-urlencoded/);
  assert.equal(tc.form.grant_type, "authorization_code");
  assert.equal(tc.form.client_id, CLIENT_ID);
  assert.equal(tc.form.client_secret, CLIENT_SECRET);
  assert.equal(tc.form.redirect_uri, CALLBACK);
  assert.equal(crypto.createHash("sha256").update(tc.form.code_verifier).digest("base64url"), q.code_challenge);

  // página de sucesso
  assertPage(b.page, 200);
  assert.match(b.page.text, /Pronto! Conectado\./);
  assert.ok(b.page.text.includes("ana@exemplo.com"));
  assert.ok(b.page.text.includes("Notebook do Paulo"));

  // serviço criado e gravado
  const devs = Object.values(ctx.store.state.devices);
  assert.equal(devs.length, 1);
  const dev = devs[0];
  assert.equal(dev.name, "Notebook do Paulo");
  assert.equal(dev.platform, "darwin");
  assert.equal(dev.googleEmail, "ana@exemplo.com");
  assert.match(dev.tokenHash, /^[0-9a-f]{64}$/);
  assert.equal(typeof dev.createdAt, "number");
  assert.equal(dev.lastSeen, dev.createdAt);
  assert.ok(
    ctx.engine.history.some(
      (h) => h.kind === "device" && h.device === dev.id && h.text === 'Serviço "Notebook do Paulo" conectado com a conta Google ana@exemplo.com'
    ),
    "histórico"
  );
  const doDisco = { state: cofreEmDisco(ctx) };
  assert.equal(doDisco.state.devices[dev.id].googleEmail, "ana@exemplo.com");

  // poll entrega UMA vez
  r = await poll(ctx, s);
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.status, "ok");
  assert.equal(r.json.deviceId, dev.id);
  assert.match(r.json.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(dev.tokenHash, sha256(r.json.token));
  const token = r.json.token;
  r = await poll(ctx, s);
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "expired");

  // o token funciona
  r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(token) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.id, dev.id);
  r = await request(ctx.api, "GET", "/v1/devices", { headers: bearer(token) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.length, 1);
  assert.equal(r.json[0].googleEmail, "ana@exemplo.com");
  assert.equal(r.json[0].current, true);

  // nada de segredo na página, no 302, no cofre em claro nem no log
  const logText = ctx.logs.join("\n");
  const segredos = [token, s.pollToken, CLIENT_SECRET, tc.form.code_verifier, q.state, ...ctx.fake.codes.keys(), ...ctx.fake.idTokens];
  for (const seg of segredos) {
    assert.ok(!b.page.text.includes(seg), "a página não tem segredo");
    assert.ok(!logText.includes(seg), "o log não tem segredo");
  }
  assert.ok(!JSON.stringify(ctx.store.state).includes(token), "o token em claro não fica no cofre");
  assert.ok(logText.includes("ana@exemplo.com"), "o log diz quem conectou");
});

test("login com Google: conta não liberada → página de recusa e poll denied; nada é criado", async (t) => {
  const ctx = await setup(t);
  await allow(ctx, "ana@exemplo.com");
  const s = await loginStart(ctx);
  const b = await browserLogin(ctx, s, "Intruso@Fora.com");
  assertPage(b.page, 403);
  assert.match(b.page.text, /A conta Google <strong>intruso@fora\.com<\/strong> não está liberada neste servidor\./);
  assert.match(b.page.text, /Peça ao dono para liberar\./);
  assert.deepEqual(ctx.store.state.devices, {});

  let r = await poll(ctx, s);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { status: "denied", email: "intruso@fora.com" });
  r = await poll(ctx, s);
  assert.deepEqual(r.json, { status: "denied", email: "intruso@fora.com" }, "a recusa não some na primeira resposta");

  // abrir o link de novo mostra a mesma recusa, sem ir ao Google
  const antes = ctx.fake.authCalls.length;
  r = await request(ctx.api, "GET", pathOf(s.authUrl));
  assertPage(r, 403);
  assert.equal(ctx.fake.authCalls.length, antes);
  assert.ok(ctx.logs.some((l) => l.includes("intruso@fora.com") && l.includes("não está liberada")));
});

test("login com Google: id_token com aud, azp ou iss errados, vencido ou e-mail não confirmado → recusa", async (t) => {
  const ctx = await setup(t);
  await allow(ctx, "ana@exemplo.com");
  const s = await loginStart(ctx);
  const casos = [
    ["aud de outro cliente", () => ({ aud: "outro-cliente.apps.googleusercontent.com", azp: "outro-cliente.apps.googleusercontent.com" }), /Login recusado/],
    ["aud em lista sem o nosso", () => ({ aud: ["outro-cliente", "mais-um"] }), /Login recusado/],
    ["azp de outro cliente", () => ({ azp: "outro-cliente.apps.googleusercontent.com" }), /Login recusado/],
    ["iss errado", () => ({ iss: "https://accounts.google.com.golpe.example" }), /Login recusado/],
    ["vencido", (t) => ({ exp: t - 5 }), /Login recusado/],
    ["e-mail não confirmado", () => ({ email_verified: false }), /não está confirmado/],
  ];
  for (const [nome, claims, texto] of casos) {
    ctx.fake.claims = claims;
    const b = await browserLogin(ctx, s, "ana@exemplo.com");
    assertPage(b.page, 403);
    assert.match(b.page.text, texto, nome);
    assert.deepEqual(ctx.store.state.devices, {}, `${nome}: nada criado`);
    const r = await poll(ctx, s);
    assert.deepEqual(r.json, { status: "pending" }, `${nome}: a sessão continua esperando (dá para tentar de novo)`);
    assert.ok(!b.page.text.includes(ctx.fake.idTokens[ctx.fake.idTokens.length - 1]));
  }
  // Com a resposta certa, a mesma sessão conclui.
  ctx.fake.claims = null;
  const b = await browserLogin(ctx, s, "ana@exemplo.com");
  assertPage(b.page, 200);
  const r = await poll(ctx, s);
  assert.equal(r.json.status, "ok");
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);
});

test("login com Google: sessão vencida e pollToken errado → 404; link vencido → página de erro; serviço não buscado é desfeito", async (t) => {
  const ctx = await setup(t);
  await allow(ctx, "ana@exemplo.com");
  const s = await loginStart(ctx);

  // pollToken errado responde igual a sessão inexistente (não revela que ela existe)
  let r = await request(ctx.api, "POST", "/v1/login/poll", { body: { sessionId: s.sessionId, pollToken: "x".repeat(43) } });
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "expired");
  const semSessao = await request(ctx.api, "POST", "/v1/login/poll", { body: { sessionId: "y".repeat(22), pollToken: s.pollToken } });
  assert.equal(semSessao.status, 404);
  assert.deepEqual(semSessao.json, r.json, "mesma resposta nos dois casos");
  r = await request(ctx.api, "POST", "/v1/login/poll", { body: { sessionId: s.sessionId } });
  assert.equal(r.status, 400);
  r = await poll(ctx, s);
  assert.deepEqual(r.json, { status: "pending" }, "com o pollToken certo a sessão existe");

  // vence em 10 min
  ctx.clock.t += 10 * MIN + 1;
  r = await poll(ctx, s);
  assert.equal(r.status, 404);
  assert.equal(r.json.error, "expired");
  r = await request(ctx.api, "GET", pathOf(s.authUrl));
  assertPage(r, 404);
  assert.match(r.text, /venceu/);
  r = await request(ctx.api, "GET", "/auth/google/callback?code=abc&state=qualquer");
  assertPage(r, 400);
  assert.equal(ctx.fake.tokenCalls.length, 0, "não foi ao Google");

  // Serviço criado, mas o VS Code não buscou o acesso a tempo: desfeito quando a sessão vence.
  const s2 = await loginStart(ctx, { name: "Esquecido" });
  const b = await browserLogin(ctx, s2, "ana@exemplo.com");
  assertPage(b.page, 200);
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);
  ctx.clock.t += 4 * MIN; // depois do retorno do Google ainda há tempo para buscar
  r = await poll(ctx, { sessionId: s2.sessionId, pollToken: "z".repeat(43) });
  assert.equal(r.status, 404);
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);
  ctx.clock.t += 15 * MIN;
  r = await poll(ctx, s2);
  assert.equal(r.status, 404);
  assert.deepEqual(ctx.store.state.devices, {});
  assert.ok(ctx.engine.history.some((h) => h.kind === "device" && h.text.includes('"Esquecido" desconectado')));
  const doDisco = { state: cofreEmDisco(ctx) };
  assert.deepEqual(doDisco.state.devices, {});
});

test("login com Google desligado (sem client id) → 503 google_off; o pareamento por código continua", async (t) => {
  const ctx = await setup(t, { google: false });
  let r = await request(ctx.api, "POST", "/v1/login/start", { body: { name: "x" } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "google_off");
  assert.match(r.json.message, /não está ligado/);
  assert.ok(!r.text.includes(ctx.dir), "a mensagem pública não mostra caminhos de arquivo");
  r = await request(ctx.api, "POST", "/v1/login/poll", { body: { sessionId: "a", pollToken: "b" } });
  assert.equal(r.status, 503);
  assert.equal(r.json.error, "google_off");
  r = await request(ctx.api, "GET", "/auth/google/start?s=abc");
  assertPage(r, 503);
  assert.match(r.text, /Login com Google desligado/);
  r = await request(ctx.api, "GET", "/auth/google/callback?code=abc&state=def");
  assertPage(r, 503);
  assert.equal(ctx.fake.authCalls.length + ctx.fake.tokenCalls.length, 0);

  // o admin explica por quê
  r = await request(ctx.admin, "GET", "/admin/allowed");
  assert.equal(r.status, 200);
  assert.equal(r.json.enabled, false);
  assert.match(r.json.offReason, /client id/);
  r = await request(ctx.admin, "GET", "/admin/status");
  assert.equal(r.json.google.enabled, false);
  // liberar e-mail funciona mesmo desligado (fica pronto para quando ligar)
  await allow(ctx, "ana@exemplo.com");

  // o pareamento por código continua
  const pc = await request(ctx.admin, "POST", "/admin/pair-code");
  assert.equal(pc.status, 200, pc.text);
  r = await request(ctx.api, "POST", "/v1/pair", { body: { code: pc.json.code, name: "Por código", platform: "linux" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.devices[r.json.deviceId].googleEmail, null);
  r = await request(ctx.api, "GET", "/v1/devices", { headers: bearer(r.json.token) });
  assert.equal(r.json[0].googleEmail, null);
});

test("configuração: client id/secret lidos dos arquivos na subida; faltando secret ou PUBLIC_URL fica desligado; o secret não aparece", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-google-cfg-"));
  try {
    const idFile = path.join(dir, "id");
    const secretFile = path.join(dir, "secret");
    const env = { TLS_MODE: "off", PUBLIC_URL: `${PUBLIC_URL}/`, GOOGLE_CLIENT_ID_FILE: idFile, GOOGLE_CLIENT_SECRET_FILE: secretFile };
    let c = loadConfig(env);
    assert.equal(c.google.enabled, false);
    assert.match(c.google.offReason, /client id/);

    fs.writeFileSync(idFile, `${CLIENT_ID}\n`);
    c = loadConfig(env);
    assert.equal(c.google.enabled, false);
    assert.match(c.google.offReason, /client secret/);

    fs.writeFileSync(secretFile, `  ${CLIENT_SECRET}  \n`);
    c = loadConfig(env);
    assert.equal(c.google.enabled, true);
    assert.equal(c.google.offReason, null);
    assert.equal(c.google.clientId, CLIENT_ID);
    assert.equal(c.google.clientSecret, CLIENT_SECRET);
    assert.equal(c.google.redirectUri, CALLBACK);
    assert.equal(c.google.authUrl, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(c.google.tokenUrl, "https://oauth2.googleapis.com/token");
    assert.ok(!JSON.stringify(c).includes(CLIENT_SECRET), "o secret não aparece se a configuração for serializada");

    c = loadConfig({ ...env, PUBLIC_URL: "" });
    assert.equal(c.google.enabled, false);
    assert.match(c.google.offReason, /PUBLIC_URL/);

    assert.throws(() => loadConfig({ ...env, GOOGLE_TOKEN_URL: "ftp://x.exemplo" }), /GOOGLE_TOKEN_URL/);
    assert.throws(() => loadConfig({ ...env, GOOGLE_AUTH_URL: "não é url" }), /GOOGLE_AUTH_URL/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("login com Google: limites por IP (start 10, callback 30, poll 600 em 10 min) e no máximo 50 sessões", async (t) => {
  const ctx = await setup(t, { env: { TRUST_PROXY: "1" } });
  const de = (ip) => ({ "x-forwarded-for": ip });

  // start: 10 por IP
  for (let i = 1; i <= 10; i++) await loginStart(ctx, { headers: de("203.0.113.1") });
  let r = await request(ctx.api, "POST", "/v1/login/start", { body: { name: "x" }, headers: de("203.0.113.1") });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "too_many_requests");
  assert.ok(Number(r.headers["retry-after"]) > 0);
  await loginStart(ctx, { headers: de("203.0.113.2") }); // outro IP segue livre

  // no máximo 50 sessões vivas no servidor
  for (let i = 3; i <= 41; i++) await loginStart(ctx, { headers: de(`203.0.113.${i}`) }); // 11 + 39 = 50
  r = await request(ctx.api, "POST", "/v1/login/start", { body: { name: "x" }, headers: de("198.51.100.9") });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "too_many_logins");
  assert.ok(Number(r.headers["retry-after"]) > 0);

  // passados 10 min: as sessões venceram e o limite do IP zerou
  ctx.clock.t += 10 * MIN + 1;
  await loginStart(ctx, { headers: de("203.0.113.1") });

  // callback: 30 por IP (página HTML)
  for (let i = 1; i <= 30; i++) {
    r = await request(ctx.api, "GET", `/auth/google/callback?code=c${i}&state=nao-existe`, { headers: de("192.0.2.7") });
    assertPage(r, 400);
  }
  r = await request(ctx.api, "GET", "/auth/google/callback?code=c&state=nao-existe", { headers: de("192.0.2.7") });
  assertPage(r, 429);
  assert.ok(Number(r.headers["retry-after"]) > 0);
  r = await request(ctx.api, "GET", "/auth/google/callback?code=c&state=nao-existe", { headers: de("192.0.2.8") });
  assertPage(r, 400);

  // poll: 600 por IP
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  t.after(() => agent.destroy());
  const body = { sessionId: "z".repeat(22), pollToken: "z".repeat(43) };
  for (let i = 1; i <= 600; i++) {
    r = await request(ctx.api, "POST", "/v1/login/poll", { body, headers: de("192.0.2.50"), agent });
    assert.equal(r.status, 404, `poll ${i}`);
  }
  r = await request(ctx.api, "POST", "/v1/login/poll", { body, headers: de("192.0.2.50"), agent });
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "too_many_requests");
  r = await request(ctx.api, "POST", "/v1/login/poll", { body, headers: de("192.0.2.51"), agent });
  assert.equal(r.status, 404);
  assert.equal(ctx.fake.tokenCalls.length, 0);
});

test("callback: login cancelado no Google, troca recusada e retorno repetido não criam nada a mais", async (t) => {
  const ctx = await setup(t);
  await allow(ctx, "ana@exemplo.com");
  const s = await loginStart(ctx);

  // a pessoa cancela no Google
  let r = await request(ctx.api, "GET", pathOf(s.authUrl));
  assert.equal(r.status, 302);
  const state = new URL(r.headers.location).searchParams.get("state");
  r = await request(ctx.api, "GET", `/auth/google/callback?error=access_denied&state=${state}`);
  assertPage(r, 400);
  assert.match(r.text, /cancelado/);
  r = await request(ctx.api, "GET", `/auth/google/callback?error=${encodeURIComponent("<script>alert(1)</script>")}&state=${state}`);
  assertPage(r, 400);
  assert.ok(!r.text.includes("alert(1)"), "o que vem na query não entra na página");
  assert.equal(ctx.fake.tokenCalls.length, 0);
  assert.deepEqual((await poll(ctx, s)).json, { status: "pending" });

  // code inventado: o Google recusa a troca → página de erro, nada criado
  r = await request(ctx.api, "GET", `/auth/google/callback?code=codigo-inventado&state=${state}`);
  assertPage(r, 502);
  assert.equal(ctx.fake.tokenCalls.length, 1);
  // Google fora do ar; e resposta sem id_token
  ctx.fake.tokenFail = { status: 500, body: { erro: "fora do ar" } };
  r = await request(ctx.api, "GET", `/auth/google/callback?code=outro&state=${state}`);
  assertPage(r, 502);
  ctx.fake.tokenFail = { status: 200, body: { access_token: "ya29.sem-id-token", token_type: "Bearer" } };
  r = await request(ctx.api, "GET", `/auth/google/callback?code=mais-um&state=${state}`);
  assertPage(r, 502);
  assert.ok(!r.text.includes("ya29."));
  assert.deepEqual(ctx.store.state.devices, {});
  assert.deepEqual((await poll(ctx, s)).json, { status: "pending" });

  // agora sim
  const b = await browserLogin(ctx, s, "ana@exemplo.com");
  assertPage(b.page, 200);
  const trocas = ctx.fake.tokenCalls.length;

  // recarregar a página de retorno (mesmo code e state): mostra o mesmo resultado sem ir ao Google de novo
  r = await request(ctx.api, "GET", b.callbackPath);
  assertPage(r, 200);
  assert.match(r.text, /Pronto!/);
  assert.equal(ctx.fake.tokenCalls.length, trocas);
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);

  // depois que o VS Code buscou o acesso, o link de retorno não vale mais
  assert.equal((await poll(ctx, s)).json.status, "ok");
  r = await request(ctx.api, "GET", b.callbackPath);
  assertPage(r, 400);
  assert.equal(ctx.fake.tokenCalls.length, trocas);
  assert.equal(Object.keys(ctx.store.state.devices).length, 1);

  // sem state; método errado nas rotas do navegador → página (não JSON)
  r = await request(ctx.api, "GET", "/auth/google/callback?code=abc");
  assertPage(r, 400);
  r = await request(ctx.api, "POST", "/auth/google/start");
  assertPage(r, 405);
});

test("a mesma conta Google conecta vários serviços; cada um é revogável sozinho; nomes escapados na página", async (t) => {
  const ctx = await setup(t);
  await allow(ctx, "ana@exemplo.com");
  const conectados = [];
  for (const name of ["Notebook", "iMac", '<img src=x onerror="alert(1)">']) {
    const s = await loginStart(ctx, { name });
    const b = await browserLogin(ctx, s, "ana@exemplo.com");
    assertPage(b.page, 200);
    if (name.startsWith("<")) {
      assert.ok(!b.page.text.includes("<img"), "nome escapado");
      assert.ok(b.page.text.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;"));
    }
    const r = await poll(ctx, s);
    assert.equal(r.json.status, "ok");
    conectados.push(r.json);
  }
  const devs = Object.values(ctx.store.state.devices);
  assert.equal(devs.length, 3);
  assert.ok(devs.every((d) => d.googleEmail === "ana@exemplo.com"));
  assert.equal(new Set(devs.map((d) => d.tokenHash)).size, 3);

  // o primeiro revoga o segundo; os outros continuam
  let r = await request(ctx.api, "DELETE", `/v1/devices/${conectados[1].deviceId}`, { headers: bearer(conectados[0].token) });
  assert.equal(r.status, 200, r.text);
  r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(conectados[1].token) });
  assert.equal(r.status, 401);
  for (const k of [0, 2]) {
    r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(conectados[k].token) });
    assert.equal(r.status, 200);
  }
  // o admin revoga o terceiro
  r = await request(ctx.admin, "DELETE", `/admin/devices/${conectados[2].deviceId}`);
  assert.equal(r.status, 200);
  r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(conectados[2].token) });
  assert.equal(r.status, 401);
  r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(conectados[0].token) });
  assert.equal(r.status, 200);
});

test("admin: allow / deny / allowed (minúsculas, gravado no cofre); deny não derruba quem já conectou", async (t) => {
  const ctx = await setup(t);
  let r = await request(ctx.admin, "GET", "/admin/allowed");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { enabled: true, offReason: null, callbackUrl: CALLBACK, adminEmails: [], allowedEmails: [], pendingLogins: 0 });

  r = await request(ctx.admin, "POST", "/admin/allow", { body: { email: " Bia@Exemplo.COM " } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.email, "bia@exemplo.com");
  assert.equal(r.json.added, true);
  r = await request(ctx.admin, "POST", "/admin/allow", { body: { email: "bia@exemplo.com" } });
  assert.equal(r.json.added, false);
  await allow(ctx, "ana@exemplo.com");
  r = await request(ctx.admin, "GET", "/admin/allowed");
  assert.deepEqual(r.json.allowedEmails, ["ana@exemplo.com", "bia@exemplo.com"]);
  for (const ruim of ["", "sem-arroba", "a@b", "<x>@y.com", 42, null]) {
    r = await request(ctx.admin, "POST", "/admin/allow", { body: { email: ruim } });
    assert.equal(r.status, 400, `"${ruim}"`);
  }
  const doDisco = { state: cofreEmDisco(ctx) };
  assert.deepEqual(doDisco.state.allowedEmails, ["ana@exemplo.com", "bia@exemplo.com"]);
  r = await request(ctx.admin, "GET", "/admin/status");
  assert.equal(r.json.google.enabled, true);
  assert.deepEqual(r.json.google.allowedEmails, ["ana@exemplo.com", "bia@exemplo.com"]);
  assert.ok(!r.text.includes(CLIENT_SECRET), "o status não mostra o client secret");

  // bia conecta um serviço; depois é tirada da lista
  const s = await loginStart(ctx, { name: "PC da Bia" });
  await browserLogin(ctx, s, "bia@exemplo.com");
  const ok = (await poll(ctx, s)).json;
  assert.equal(ok.status, "ok");
  r = await request(ctx.admin, "POST", "/admin/deny", { body: { email: "BIA@exemplo.com" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, true);
  assert.deepEqual(r.json.devices, [{ id: ok.deviceId, name: "PC da Bia" }]);
  assert.deepEqual(r.json.google.allowedEmails, ["ana@exemplo.com"]);
  r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(ok.token) });
  assert.equal(r.status, 200, "o serviço já conectado continua (revogar é à parte)");
  // mas um login novo com ela é recusado
  const s2 = await loginStart(ctx);
  const b = await browserLogin(ctx, s2, "bia@exemplo.com");
  assertPage(b.page, 403);
  assert.deepEqual((await poll(ctx, s2)).json, { status: "denied", email: "bia@exemplo.com" });

  r = await request(ctx.admin, "POST", "/admin/deny", { body: { email: "ninguem@exemplo.com" } });
  assert.equal(r.json.removed, false);
  r = await request(ctx.admin, "POST", "/admin/deny", { body: {} });
  assert.equal(r.status, 400);
  // o admin não aceita navegador
  r = await request(ctx.admin, "POST", "/admin/allow", { body: { email: "x@y.com" }, headers: { origin: "https://site.exemplo" } });
  assert.equal(r.status, 403);
});

test("logins: com Google só o serviço do administrador envia; conta liberada que não é administradora → 403 not_admin sem chamar o engine", async (t) => {
  const ctx = await setup(t, { env: { ADMIN_EMAILS: "dono.exemplo@gmail.com" } });
  await allow(ctx, "bia@exemplo.com"); // pode conectar serviços, mas não é administradora
  const conecta = async (name, email) => {
    const s = await loginStart(ctx, { name });
    const b = await browserLogin(ctx, s, email);
    assertPage(b.page, 200);
    const r = await poll(ctx, s);
    assert.equal(r.json && r.json.status, "ok", r.text);
    return r.json; // { deviceId, token }
  };
  const dono = await conecta("Notebook do dono", "DonoExemplo@gmail.com"); // o administrador conecta sem estar na lista
  const bia = await conecta("PC da Bia", "bia@exemplo.com");
  const SEGREDO = "sk-ant-ort01-SEGREDO-DO-LOGIN-ENVIADO";
  const login = {
    claudeAiOauth: { accessToken: "a", refreshToken: SEGREDO, expiresAt: 1 },
    oauthAccount: { emailAddress: "c@exemplo.com", organizationUuid: "org-1" },
  };

  let r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(dono.token) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.canUploadLogins, true);
  r = await request(ctx.api, "GET", "/v1/state", { headers: bearer(bia.token) });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.device.canUploadLogins, false);

  r = await request(ctx.api, "POST", "/v1/logins", { headers: bearer(dono.token), body: login });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.engine.logins.length, 1);
  assert.equal(ctx.engine.logins[0].deviceId, dono.deviceId);

  r = await request(ctx.api, "POST", "/v1/logins", { headers: bearer(bia.token), body: login });
  assert.equal(r.status, 403, r.text);
  assert.deepEqual(r.json, {
    error: "not_admin",
    message: "Só os serviços do administrador enviam logins ao servidor. Este serviço usa as contas do servidor.",
  });
  assert.equal(ctx.engine.logins.length, 1, "o engine não foi chamado");
  r = await request(ctx.api, "POST", "/v1/logins", { headers: bearer(bia.token), body: login });
  assert.equal(r.status, 403, r.text);

  // histórico uma vez (no mesmo dia) e log, sem token
  const recusas = ctx.engine.history.filter((h) => /^Login recusado/.test(h.text));
  assert.deepEqual(recusas, [{ kind: "alert", text: 'Login recusado de "PC da Bia": só o administrador envia logins', device: bia.deviceId }]);
  const logText = ctx.logs.join("\n");
  assert.ok(logText.includes('login recusado de "PC da Bia"'), "registrado no log");
  for (const seg of [SEGREDO, bia.token, dono.token]) assert.ok(!logText.includes(seg), "nada de token no log");
});
