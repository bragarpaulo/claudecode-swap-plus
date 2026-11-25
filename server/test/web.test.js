"use strict";
// Testes do painel web (web.js + as partes do login "web" em server.js/google.js).
// Um "Google falso" (servidor HTTP local em 127.0.0.1, igual ao de google.test.js) serve a tela de
// login e o endpoint de token. Cofre de verdade numa pasta temporária (chave gerada aqui), arquivos
// do painel de mentira numa pasta temporária (config.webDir) e um engine falso que trabalha no
// próprio cofre e "vaza" segredos de propósito (o painel não pode deixar sair).
// O painel é só do administrador (ADMIN_EMAILS; aqui, por padrão, ana@exemplo.com). As contas liberadas
// (allow) só conectam serviços.
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
const { emailKey, sameEmail } = require("../src/google");
const access = require("../src/access");
const { RULE_DEFAULTS } = require("../../plus/rules");

const PUBLIC_URL = "https://swap.exemplo.com";
const ORIGIN = PUBLIC_URL;
const CALLBACK = `${PUBLIC_URL}/auth/google/callback`;
const CLIENT_ID = "123456-falso.apps.googleusercontent.com";
const CLIENT_SECRET = "segredo-google-de-teste-NAO-PODE-VAZAR";
const REFRESH_SECRETO = "sk-ant-ort01-REFRESH-SECRETO-do-painel";
const ACESSO = "sk-ant-oat01-ACESSO-do-painel";
const PANEL_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'";
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const UA_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;
const ADMIN = "ana@exemplo.com"; // ADMIN_EMAILS padrão do setup()
const NOT_ADMIN_TEXT = "Esta conta pode conectar serviços, mas o painel é só do administrador.";

const INDEX_HTML = '<!doctype html>\n<html lang="pt-BR"><head><title>Swap Plus</title><link rel="stylesheet" href="/static/app.css"></head><body><script src="/static/app.js"></script></body></html>\n';
const APP_JS = "console.log('painel do Swap Plus');\n";
const APP_CSS = "body { color: #111; }\n";

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const b64json = (o) => Buffer.from(JSON.stringify(o), "utf8").toString("base64url");

// ---------------------------------------------------------------------------
// Engine falso: mesmos nomes do engine.js, trabalhando no cofre; registra as chamadas.
// ---------------------------------------------------------------------------

class FakeEngine {
  constructor(store, now) {
    this.store = store;
    this.now = now;
    this.calls = [];
    this.pausedUntil = null;
    this.setLoginError = null;
    // Presença por serviço ({ id: { lastContact, connected, presence } }). Vazio = como um motor antigo, que não
    // manda esses campos: o painel completa pelo `active`.
    this.presence = {};
  }
  get st() {
    return this.store.state;
  }
  rec(name, ...args) {
    this.calls.push({ name, args });
  }
  last(name) {
    for (let i = this.calls.length - 1; i >= 0; i--) if (this.calls[i].name === name) return this.calls[i];
    return null;
  }
  count(name) {
    return this.calls.filter((c) => c.name === name).length;
  }
  start() {}
  stop() {}
  rulesEffective() {
    return { ...RULE_DEFAULTS, ...(this.st.rules || {}) };
  }
  records() {
    const out = {};
    for (const a of Object.values(this.st.accounts)) {
      out[String(a.number)] = { disabled: !!a.disabled, threshold: a.threshold ?? null, priority: Number(a.priority) || 0, alias: a.alias || null };
    }
    return out;
  }
  devicesList(currentId = null) {
    this.rec("devicesList", currentId);
    return Object.values(this.st.devices).map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      googleEmail: d.googleEmail || null,
      createdAt: d.createdAt,
      lastSeen: d.lastSeen,
      assigned: d.assigned ?? null,
      current: d.id === currentId,
      active: this.now() - d.lastSeen <= 5 * MIN,
      tokenHash: d.tokenHash, // "vazamento": o painel não pode deixar sair
      ...(this.presence[d.id] || {}),
    }));
  }
  publicList(deviceId) {
    this.rec("publicList", deviceId);
    const names = (n) => Object.values(this.st.devices).filter((d) => d.assigned === n).map((d) => d.name);
    const accounts = Object.values(this.st.accounts)
      .sort((a, b) => a.number - b.number)
      .map((a) => ({
        number: a.number,
        email: a.email,
        organizationName: a.orgName || "",
        organizationUuid: a.orgUuid || "",
        plan: a.plan,
        alias: a.alias || null,
        active: false,
        disabled: !!a.disabled,
        usageStatus: a.dead ? "relogin_required" : a.usage ? "ok" : "unknown",
        usage: a.dead ? null : a.usage,
        usageAgeSeconds: a.dead ? null : 12,
        lastGoodUsage: a.lastGoodUsage || null,
        lastGoodAgeSeconds: null,
        dead: !!a.dead,
        assignedDevices: names(a.number),
        cred: a.cred, // "vazamento" de propósito
        refreshToken: REFRESH_SECRETO, // idem
      }));
    return { schemaVersion: 1, activeAccountNumber: null, accounts };
  }
  status() {
    return { usagePausedUntil: this.pausedUntil };
  }
  stateFor(deviceId) {
    const d = this.st.devices[deviceId];
    return { serverTime: this.now(), version: "teste", device: d ? { id: d.id, name: d.name } : null, devices: [] };
  }
  async setRules(arg) {
    this.rec("setRules", arg);
    if (arg.rules === null) this.st.rules = null;
    else if (arg.rules !== undefined) this.st.rules = { ...(this.st.rules || {}), ...arg.rules };
    if (arg.autoSwitch !== undefined) this.st.autoSwitch = arg.autoSwitch;
  }
  async updateAccount(number, patch) {
    this.rec("updateAccount", number, patch);
    Object.assign(this.st.accounts[String(number)], patch);
  }
  async removeAccount(number) {
    this.rec("removeAccount", number);
    delete this.st.accounts[String(number)];
  }
  async switchDevice(deviceId, number, by) {
    this.rec("switchDevice", deviceId, number, by);
    const d = this.st.devices[deviceId];
    if (number !== null && number !== undefined && !access.canUse(this.st, d, number)) {
      throw Object.assign(new Error(`a conta ${number} não está liberada para este serviço ("${d.name}")`), { code: "not_allowed" });
    }
    const from = d.assigned ?? null;
    const to = number ?? 2;
    d.assigned = to;
    return { switched: from !== to, from, to, text: `Troca manual para a conta ${to}` };
  }
  async setAccountDevices(number, devices) {
    this.rec("setAccountDevices", number, devices);
    const value = access.setAccountDevices(this.st, number, devices); // lança .code "not_found" / "invalid"
    return { number: Number(number), devices: value };
  }
  pushHistory(kind, text, deviceId) {
    this.rec("pushHistory", kind, text, deviceId);
    const dev = deviceId ? this.st.devices[deviceId] : null;
    const e = { ts: new Date(this.now()).toISOString(), kind, text, device: deviceId || null };
    if (dev) e.deviceName = dev.name;
    this.st.history.unshift(e);
    if (this.st.history.length > 100) this.st.history.length = 100;
  }
  async setLoginExpiresAt(number, ms) {
    this.rec("setLoginExpiresAt", number, ms);
    const fail = (code, message) => Object.assign(new Error(message), { code });
    if (this.setLoginError) throw fail(this.setLoginError, `erro ${this.setLoginError} do motor`);
    const a = this.st.accounts[String(number)];
    if (!a) throw fail("not_found", `a conta ${number} não existe`);
    if (ms < Date.UTC(2020, 0, 1)) throw fail("invalid", "data no passado distante demais");
    a.cred.refreshTokenExpiresAt = ms;
  }
}

function conta(number, email, t, extra = {}) {
  return {
    number,
    email,
    orgUuid: "org-1",
    orgName: "Empresa",
    plan: { label: "Team" },
    alias: null,
    oauthAccount: { emailAddress: email, organizationUuid: "org-1" },
    cred: {
      accessToken: ACESSO,
      refreshToken: REFRESH_SECRETO,
      expiresAt: t + 6 * 3600 * 1000,
      scopes: ["user:inference"],
      subscriptionType: "team",
      rateLimitTier: "x",
      ...(extra.cred || {}),
    },
    gen: 4,
    dead: extra.dead || null,
    disabled: false,
    threshold: null,
    priority: 0,
    usage: { fiveHour: { pct: 34, resetsAt: null }, sevenDay: { pct: 61, resetsAt: null } },
    usageFetchedAt: t,
    usageError: null,
    lastGoodUsage: null,
    lastGoodAt: null,
    nextPollAt: 0,
    pollBackoffUntil: 0,
    refreshBackoffUntil: 0,
    refreshFailures: 0,
    addedAt: t,
    lastRefreshAt: t - 3600 * 1000,
  };
}

function dispositivo(id, name, t, extra = {}) {
  return {
    id,
    name,
    platform: "darwin",
    googleEmail: null,
    tokenHash: sha256(`token-do-${id}`),
    createdAt: t,
    lastSeen: t,
    assigned: null,
    lastSwitchAt: 0,
    models: [],
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Google falso (o mesmo de google.test.js)
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

async function startFakeGoogle(now) {
  const g = { email: "ana@exemplo.com", codes: new Map(), authCalls: [], tokenCalls: [], idTokens: [] };
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
        g.tokenCalls.push({ form });
        const c = g.codes.get(form.code);
        const pkceOk = !!c && crypto.createHash("sha256").update(String(form.code_verifier || "")).digest("base64url") === c.challenge;
        if (!c || c.used || !pkceOk || form.client_id !== CLIENT_ID || form.client_secret !== CLIENT_SECRET || form.redirect_uri !== c.redirectUri) {
          replyJson(res, 400, { error: "invalid_grant" });
          return;
        }
        c.used = true;
        const t = Math.floor(now() / 1000);
        const claims = { iss: "https://accounts.google.com", azp: CLIENT_ID, aud: CLIENT_ID, sub: "1101", email: c.email, email_verified: true, iat: t, exp: t + 3600 };
        const idToken = [b64json({ alg: "RS256", typ: "JWT" }), b64json(claims), "assinatura-falsa"].join(".");
        g.idTokens.push(idToken);
        replyJson(res, 200, { access_token: `ya29.falso-${crypto.randomBytes(6).toString("hex")}`, expires_in: 3599, token_type: "Bearer", id_token: idToken });
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

/**
 * google: false = sem client id/secret (login com Google desligado).
 * webFiles: false = sem os arquivos do painel na pasta.
 * env: soma/troca variáveis (ex.: { ADMIN_EMAILS: "" } = sem administrador → painel desligado).
 * Kit de recuperação: MASTER_KEY_FILE = a chave mestra do cofre de teste; RESTIC_PASS_FILE = dir/restic_swap_plus_pass
 * (não existe até o teste criar).
 */
async function setup(t, { env = {}, google = true, webFiles = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-web-"));
  const keyFile = path.join(dir, "chave-mestra");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const store = new Store({ dir: path.join(dir, "dados"), keyFile });
  store.load();
  const clock = { t: Date.now() };
  const now = () => clock.t;
  store.state.accounts = {
    1: conta(1, "a@exemplo.com", clock.t, { cred: { refreshTokenExpiresAt: clock.t + 2 * DAY + 5 * MIN } }),
    2: conta(2, "b@exemplo.com", clock.t, { cred: { refreshTokenExpiresAt: clock.t + 20 * DAY } }),
    3: conta(3, "c@exemplo.com", clock.t, { dead: { reason: "relogin_required", at: clock.t } }),
  };
  await store.save();

  const fake = await startFakeGoogle(now);
  const idFile = path.join(dir, "google_client_id");
  const secretFile = path.join(dir, "google_client_secret");
  if (google) {
    fs.writeFileSync(idFile, `${CLIENT_ID}\n`);
    fs.writeFileSync(secretFile, `${CLIENT_SECRET}\n`);
  }
  const webDir = path.join(dir, "web");
  fs.mkdirSync(webDir);
  if (webFiles) {
    fs.writeFileSync(path.join(webDir, "index.html"), INDEX_HTML);
    fs.writeFileSync(path.join(webDir, "app.js"), APP_JS);
    fs.writeFileSync(path.join(webDir, "app.css"), APP_CSS);
  }
  fs.writeFileSync(path.join(dir, "segredo.txt"), "NAO-PODE-SAIR-pelo-painel"); // vizinho da pasta do painel

  const resticFile = path.join(dir, "restic_swap_plus_pass");
  const baseEnv = {
    TLS_MODE: "off",
    DATA_DIR: dir,
    PUBLIC_URL,
    GOOGLE_CLIENT_ID_FILE: idFile,
    GOOGLE_CLIENT_SECRET_FILE: secretFile,
    GOOGLE_AUTH_URL: fake.authUrl,
    GOOGLE_TOKEN_URL: fake.tokenUrl,
    ADMIN_EMAILS: ADMIN,
    MASTER_KEY_FILE: keyFile,
    RESTIC_PASS_FILE: resticFile,
    ...env,
  };
  const config = loadConfig(baseEnv);
  config.webDir = webDir;
  const engine = new FakeEngine(store, now);
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
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, keyFile, resticFile, store, engine, clock, now, log, baseEnv, config, app, fake, logs, api: api.port, admin: admin.port, tokens: [] };
}

/**
 * "Reinicia" o servidor com outras variáveis (ex.: ADMIN_EMAILS diferente): app novo no MESMO cofre (como depois de
 * um restart: as sessões do painel ficam no cofre). Devolve um ctx igual ao do setup, apontando para o app novo.
 */
async function restart(t, ctx, env = {}) {
  const config = loadConfig({ ...ctx.baseEnv, ...env });
  config.webDir = ctx.config.webDir;
  const app = createApp({ store: ctx.store, engine: ctx.engine, config, now: ctx.now, log: ctx.log });
  const api = await listen(app.api);
  const admin = await listen(app.admin);
  t.after(async () => {
    await close(api.server);
    await close(admin.server);
  });
  return { ...ctx, config, app, api: api.port, admin: admin.port };
}

function cofreEmDisco(ctx) {
  return decrypt(loadKey(ctx.keyFile), fs.readFileSync(ctx.store.file));
}

/** Segredos que nunca podem aparecer numa resposta do painel. */
function segredosDe(ctx) {
  const st = ctx.store.state;
  const out = ["refreshToken", "accessToken", "tokenHash", REFRESH_SECRETO, ACESSO, CLIENT_SECRET, ...ctx.tokens];
  for (const s of Object.values(st.webSessions || {})) out.push(s.tokenHash);
  for (const d of Object.values(st.devices || {})) out.push(d.tokenHash);
  return out.filter(Boolean);
}

/**
 * Requisição HTTP crua. Toda resposta passa pela checagem de segredos; erro JSON tem { error, message }.
 *   s       sessão do painel { token, csrf } → cookie sp_sess e X-CSRF-Token
 *   origin  cabeçalho Origin (padrão: o do painel nos métodos que mudam algo; null = sem)
 *   csrf    X-CSRF-Token (padrão: o da sessão; null = sem)
 */
function call(ctx, method, p, { s, body, raw, origin, csrf, headers = {}, port } = {}) {
  return new Promise((resolve, reject) => {
    const data = raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : null;
    const h = { ...headers };
    const cookies = [];
    if (s && s.token) cookies.push(`sp_sess=${s.token}`);
    if (h.cookie) cookies.push(h.cookie);
    if (cookies.length) h.cookie = cookies.join("; ");
    const o = origin === undefined ? (method === "GET" ? null : ORIGIN) : origin;
    if (o) h.origin = o;
    const x = csrf === undefined ? s && s.csrf : csrf;
    if (x) h["x-csrf-token"] = x;
    if (data !== null) {
      h["content-type"] = "application/json";
      h["content-length"] = Buffer.byteLength(data);
    }
    const req = http.request({ host: "127.0.0.1", port: port || ctx.api, method, path: p, headers: h, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {}
        try {
          for (const seg of segredosDe(ctx)) assert.ok(!text.includes(seg), `resposta de ${method} ${p} contém um segredo (${seg.slice(0, 12)}…)`);
          if (res.statusCode >= 400 && /json/.test(String(res.headers["content-type"]))) {
            assert.ok(json && typeof json.error === "string" && typeof json.message === "string", `erro sem {error, message}: ${text}`);
            assert.ok(!("stack" in json) && !/\n\s+at /.test(text), `erro com stack: ${text}`);
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

const adminCall = (ctx, method, p, opts = {}) => call(ctx, method, p, { origin: null, ...opts, port: ctx.admin });

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

/** Cookie `name` do Set-Cookie da resposta → { value, attrs: [..] } ou null. */
function cookieFrom(r, name) {
  const list = r.headers["set-cookie"] || [];
  for (const c of list) {
    const [first, ...attrs] = c.split(";").map((x) => x.trim());
    const i = first.indexOf("=");
    if (first.slice(0, i) === name) return { value: first.slice(i + 1), attrs, raw: c };
  }
  return null;
}

function assertCookieFlags(c, cookiePath, maxAge) {
  assert.ok(c, "cookie ausente");
  assert.ok(c.attrs.includes(`Path=${cookiePath}`), c.raw);
  assert.ok(c.attrs.includes(`Max-Age=${maxAge}`), c.raw);
  assert.ok(c.attrs.includes("HttpOnly"), c.raw);
  assert.ok(c.attrs.includes("Secure"), c.raw);
  assert.ok(c.attrs.includes("SameSite=Lax"), c.raw);
}

/** Página HTML do servidor (login): cabeçalhos de segurança, sem script, sem recurso externo. */
function assertPage(r, status) {
  assert.equal(r.status, status, r.text);
  assert.match(String(r.headers["content-type"]), /^text\/html; charset=utf-8/);
  assert.equal(r.headers["content-security-policy"], PAGE_CSP);
  assert.equal(r.headers["x-frame-options"], "DENY");
  assert.equal(r.headers["cache-control"], "no-store");
  assert.ok(!/<script/i.test(r.text), "página sem script");
  assert.ok(!/(src|href)\s*=\s*["']?(https?:)?\/\//i.test(r.text), "página sem recurso externo");
}

async function allow(ctx, email) {
  const r = await adminCall(ctx, "POST", "/admin/allow", { body: { email } });
  assert.equal(r.status, 200, r.text);
}

const sessionIdOf = (ctx, token) => {
  const e = Object.entries(ctx.store.state.webSessions).find(([, s]) => s.tokenHash === sha256(token));
  return e ? e[0] : null;
};

/**
 * O navegador: /web/login (302 + cookie sp_login) → Google falso (entra com `email`) → retorno do
 * servidor com o cookie sp_login. Se der certo: s = { token, csrf, id }.
 */
async function webLogin(ctx, email = "ana@exemplo.com", { ua = UA, cookie, headers = {}, loginPath = "/web/login" } = {}) {
  const start = await call(ctx, "GET", loginPath, { headers: { "user-agent": ua, ...headers } });
  assert.equal(start.status, 302, start.text);
  const loginCookie = cookieFrom(start, "sp_login");
  assert.ok(loginCookie && loginCookie.value, "cookie do login");
  const toGoogle = new URL(start.headers.location);
  ctx.fake.email = email;
  const g = await getUrl(toGoogle.toString());
  assert.equal(g.status, 302, g.text);
  const back = new URL(g.headers.location);
  assert.equal(back.origin + back.pathname, CALLBACK);
  const callbackPath = back.pathname + back.search;
  const cookies = [`sp_login=${loginCookie.value}`];
  if (cookie) cookies.push(cookie);
  const page = await call(ctx, "GET", callbackPath, { headers: { cookie: cookies.join("; "), "user-agent": ua, ...headers } });
  let s = null;
  const sc = cookieFrom(page, "sp_sess");
  if (page.status === 302 && sc && sc.value) {
    s = { token: sc.value };
    ctx.tokens.push(s.token);
    const me = await call(ctx, "GET", "/web/api/me", { s });
    assert.equal(me.status, 200, me.text);
    s.csrf = me.json.csrf;
    s.id = sessionIdOf(ctx, s.token);
  }
  return { start, loginCookie, toGoogle, callbackPath, page, s };
}

/**
 * Um serviço (VS Code) conectando com Google: /v1/login/start → link → Google falso (entra com `email`) →
 * retorno → poll. → { page (página final no navegador), poll (resposta do poll), token? }
 */
async function deviceLogin(ctx, email, name = "Notebook") {
  const st = await call(ctx, "POST", "/v1/login/start", { body: { name, platform: "darwin" }, origin: null });
  assert.equal(st.status, 200, st.text);
  const u = new URL(st.json.authUrl);
  const redirect = await call(ctx, "GET", u.pathname + u.search);
  assert.equal(redirect.status, 302, redirect.text);
  ctx.fake.email = email;
  const g = await getUrl(redirect.headers.location);
  assert.equal(g.status, 302, g.text);
  const back = new URL(g.headers.location);
  const page = await call(ctx, "GET", back.pathname + back.search);
  const poll = await call(ctx, "POST", "/v1/login/poll", { body: { sessionId: st.json.sessionId, pollToken: st.json.pollToken }, origin: null });
  const token = poll.json && poll.json.token;
  if (token) ctx.tokens.push(token);
  return { page, poll: poll.json, token };
}

// ---------------------------------------------------------------------------
// Testes
// ---------------------------------------------------------------------------

test("painel: login com Google (tipo web) → cookie sp_sess → /web/api/me; no cofre só o hash; recarregar o retorno não cria outra sessão", async (t) => {
  const ctx = await setup(t); // ana é a administradora (ADMIN_EMAILS); ela não precisa estar na lista de liberadas

  const b = await webLogin(ctx, "ana@exemplo.com");
  // /web/login: 302 para o Google com PKCE + state, mesmo cliente e mesmo retorno dos serviços
  const q = Object.fromEntries(b.toGoogle.searchParams);
  assert.equal(b.toGoogle.origin + b.toGoogle.pathname, ctx.fake.authUrl);
  assert.equal(q.client_id, CLIENT_ID);
  assert.equal(q.redirect_uri, CALLBACK);
  assert.equal(q.code_challenge_method, "S256");
  assert.equal(q.scope, "openid email");
  assert.match(q.state, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(b.start.headers["cache-control"], "no-store");
  assertCookieFlags(b.loginCookie, "/auth/google/", 600);

  // retorno: 302 para "/" com o cookie da sessão; o cookie do login é apagado
  assert.equal(b.page.status, 302, b.page.text);
  assert.equal(b.page.headers.location, "/");
  const sc = cookieFrom(b.page, "sp_sess");
  assertCookieFlags(sc, "/", 2592000);
  assert.match(sc.value, /^[A-Za-z0-9_-]{43}$/);
  assertCookieFlags(cookieFrom(b.page, "sp_login"), "/auth/google/", 0);
  assert.equal(cookieFrom(b.page, "sp_login").value, "");
  assert.ok(b.s, "sessão criada");

  // /web/api/me
  const me = await call(ctx, "GET", "/web/api/me", { s: b.s });
  assert.equal(me.status, 200);
  assert.deepEqual(Object.keys(me.json).sort(), ["admin", "csrf", "email", "expiresAt"]);
  assert.equal(me.json.email, "ana@exemplo.com");
  assert.equal(me.json.admin, true);
  assert.match(me.json.csrf, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(me.json.expiresAt, ctx.clock.t + 30 * DAY);
  assert.equal(me.headers["cache-control"], "no-store");

  // no cofre: só o sha256 do token
  const sessoes = ctx.store.state.webSessions;
  assert.equal(Object.keys(sessoes).length, 1);
  const [id, sess] = Object.entries(sessoes)[0];
  assert.equal(id, b.s.id);
  assert.deepEqual(Object.keys(sess).sort(), ["createdAt", "csrf", "email", "expiresAt", "ip", "lastSeen", "tokenHash", "ua"]);
  assert.equal(sess.tokenHash, sha256(b.s.token));
  assert.equal(sess.email, "ana@exemplo.com");
  assert.equal(sess.ua, "Chrome no macOS");
  assert.equal(sess.ip, "127.0.0.1");
  assert.equal(sess.expiresAt - sess.createdAt, 30 * DAY);
  assert.ok(!JSON.stringify(ctx.store.state).includes(b.s.token), "o token em claro não fica no cofre");
  assert.equal(cofreEmDisco(ctx).webSessions[id].tokenHash, sha256(b.s.token), "gravado no disco");
  assert.ok(ctx.store.state.history.some((h) => h.text === "Entrada no painel: ana@exemplo.com (Chrome no macOS)"));

  // recarregar o retorno: volta para "/" sem cookie novo e sem falar com o Google
  const trocas = ctx.fake.tokenCalls.length;
  const again = await call(ctx, "GET", b.callbackPath, { headers: { "user-agent": UA } });
  assert.equal(again.status, 302);
  assert.equal(again.headers.location, "/");
  assert.equal(cookieFrom(again, "sp_sess"), null);
  assert.equal(ctx.fake.tokenCalls.length, trocas);
  assert.equal(Object.keys(ctx.store.state.webSessions).length, 1);

  // o link de login do VS Code não aceita a sessão do painel; o poll também não
  const r = await call(ctx, "GET", "/auth/google/start?s=qualquer");
  assertPage(r, 404);

  // entrar de novo no mesmo navegador troca a sessão (a antiga para de valer)
  const b2 = await webLogin(ctx, "ana@exemplo.com", { cookie: `sp_sess=${b.s.token}` });
  assert.ok(b2.s);
  assert.equal(Object.keys(ctx.store.state.webSessions).length, 1);
  assert.equal((await call(ctx, "GET", "/web/api/me", { s: b.s })).status, 401);
  assert.equal((await call(ctx, "GET", "/web/api/me", { s: b2.s })).status, 200);

  // nada de token, cookie, csrf, code ou segredo no log
  const logText = ctx.logs.join("\n");
  for (const seg of [b.s.token, b.s.csrf, b2.s.token, b2.s.csrf, b.loginCookie.value, CLIENT_SECRET, ...ctx.fake.codes.keys(), ...ctx.fake.idTokens]) {
    assert.ok(!logText.includes(seg), "o log não tem segredo");
  }
  assert.ok(logText.includes("ana@exemplo.com entrou no painel"));
});

test("painel: conta não liberada → página de recusa e nenhuma sessão; retorno em outro navegador → recusa; Google desligado → 503", async (t) => {
  const ctx = await setup(t);

  const b = await webLogin(ctx, "Intruso@Fora.com");
  assertPage(b.page, 403);
  assert.match(b.page.text, /A conta Google <strong>intruso@fora\.com<\/strong> não está liberada para usar o painel/);
  assert.match(b.page.text, /href="\/web\/login"/, "botão para entrar com outra conta");
  assert.equal(cookieFrom(b.page, "sp_sess"), null);
  assert.deepEqual(ctx.store.state.webSessions, {});
  assert.deepEqual(ctx.store.state.devices, {}, "login do painel não cria serviço");
  assert.ok(ctx.logs.some((l) => l.includes("intruso@fora.com") && l.includes("não está liberada")));
  // recarregar mostra a mesma recusa
  const again = await call(ctx, "GET", b.callbackPath);
  assertPage(again, 403);

  // o retorno chega sem o cookie do login (outro navegador): recusa antes de falar com o Google
  ctx.fake.email = "ana@exemplo.com";
  const start = await call(ctx, "GET", "/web/login");
  const lc = cookieFrom(start, "sp_login");
  const g = await getUrl(start.headers.location);
  const back = new URL(g.headers.location);
  const cbPath = back.pathname + back.search;
  const trocas = ctx.fake.tokenCalls.length;
  let r = await call(ctx, "GET", cbPath);
  assertPage(r, 400);
  assert.match(r.text, /outro navegador/);
  assert.match(r.text, /href="\/"/, "botão de voltar ao painel");
  r = await call(ctx, "GET", cbPath, { headers: { cookie: "sp_login=" + "x".repeat(43) } });
  assertPage(r, 400);
  assert.equal(ctx.fake.tokenCalls.length, trocas, "não foi ao Google");
  assert.deepEqual(ctx.store.state.webSessions, {});
  // com o cookie certo, o mesmo retorno conclui
  r = await call(ctx, "GET", cbPath, { headers: { cookie: `sp_login=${lc.value}` } });
  assert.equal(r.status, 302, r.text);
  ctx.tokens.push(cookieFrom(r, "sp_sess").value);
  assert.equal(Object.keys(ctx.store.state.webSessions).length, 1);

  // login cancelado no Google: página com o caminho de volta ao painel
  const s2 = await call(ctx, "GET", "/web/login");
  const state = new URL(s2.headers.location).searchParams.get("state");
  r = await call(ctx, "GET", `/auth/google/callback?error=access_denied&state=${state}`, { headers: { cookie: `sp_login=${cookieFrom(s2, "sp_login").value}` } });
  assertPage(r, 400);
  assert.match(r.text, /cancelado/);
  assert.match(r.text, /Volte ao painel/);

  // Google desligado: /web/login → 503; a página continua saindo; /web/api/me diz que o Google está desligado
  const off = await setup(t, { google: false });
  r = await call(off, "GET", "/web/login");
  assertPage(r, 503);
  assert.match(r.text, /Login com Google desligado/);
  assert.equal(off.fake.authCalls.length, 0);
  r = await call(off, "GET", "/");
  assert.equal(r.status, 200);
  r = await call(off, "GET", "/web/api/me");
  assert.equal(r.status, 401);
  assert.equal(r.json.googleEnabled, false);
  assert.equal(r.json.login, "/web/login");
});

test("painel: CSRF e Origin — sem Origin, Origin errada, sem X-CSRF-Token ou com o de outra sessão → 403 e nada muda", async (t) => {
  const ctx = await setup(t, { env: { ADMIN_EMAILS: "ana@exemplo.com, bia@exemplo.com" } });
  await allow(ctx, "cris@exemplo.com");
  ctx.store.state.devices = { d1: dispositivo("d1", "Notebook", ctx.clock.t, { assigned: 1 }) };
  const { s } = await webLogin(ctx, "ana@exemplo.com");
  const { s: bia } = await webLogin(ctx, "bia@exemplo.com");
  const body = { rules: { sessionPct: 85 } };

  let r = await call(ctx, "PUT", "/web/api/rules", { s, body, origin: null });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "bad_origin");
  for (const o of ["https://golpe.exemplo", "http://swap.exemplo.com", "https://swap.exemplo.com:8443", "null"]) {
    r = await call(ctx, "PUT", "/web/api/rules", { s, body, origin: o });
    assert.equal(r.status, 403, o);
    assert.equal(r.json.error, "bad_origin", o);
  }
  r = await call(ctx, "PUT", "/web/api/rules", { s, body, csrf: null });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "csrf");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body, csrf: "x".repeat(43) });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "csrf");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body, csrf: bia.csrf });
  assert.equal(r.status, 403, "o csrf de outra sessão não serve");
  r = await call(ctx, "PUT", "/web/api/rules", { body, csrf: s.csrf });
  assert.equal(r.status, 401, "sem cookie: sem sessão");
  assert.equal(ctx.engine.count("setRules"), 0);

  // todas as rotas que mudam algo exigem o X-CSRF-Token
  const antes = JSON.stringify([ctx.store.state.devices, ctx.store.state.allowedEmails, ctx.store.state.accounts, ctx.store.state.pairing, Object.keys(ctx.store.state.webSessions)]);
  const mudam = [
    ["PATCH", "/web/api/accounts/1", { disabled: true }],
    ["DELETE", "/web/api/accounts/1"],
    ["POST", "/web/api/devices/d1/switch", { number: 2 }],
    ["DELETE", "/web/api/devices/d1"],
    ["POST", "/web/api/allowed", { email: "davi@exemplo.com" }],
    ["DELETE", "/web/api/allowed/cris%40exemplo.com"],
    ["POST", "/web/api/pair-code", {}],
    ["DELETE", `/web/api/sessions/${bia.id}`],
    ["POST", "/web/logout", {}],
  ];
  for (const [m, p, b] of mudam) {
    r = await call(ctx, m, p, { s, body: b, csrf: null });
    assert.equal(r.status, 403, `${m} ${p} sem csrf`);
    r = await call(ctx, m, p, { s, body: b, origin: "https://golpe.exemplo" });
    assert.equal(r.status, 403, `${m} ${p} de outra origem`);
  }
  assert.equal(
    JSON.stringify([ctx.store.state.devices, ctx.store.state.allowedEmails, ctx.store.state.accounts, ctx.store.state.pairing, Object.keys(ctx.store.state.webSessions)]),
    antes,
    "nada mudou"
  );
  for (const n of ["updateAccount", "removeAccount", "switchDevice", "setRules"]) assert.equal(ctx.engine.count(n), 0, n);

  // ler não precisa de Origin nem de csrf; mudar com tudo certo funciona
  r = await call(ctx, "GET", "/web/api/state", { s, csrf: null });
  assert.equal(r.status, 200);
  r = await call(ctx, "PUT", "/web/api/rules", { s, body });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.engine.count("setRules"), 1);
});

test("painel: cada rota chama o engine certo; PanelState no formato da WEB-SPEC; nenhum segredo sai", async (t) => {
  const ctx = await setup(t);
  const E = ctx.engine;
  const T = ctx.clock.t;
  ctx.store.state.devices = {
    d1: dispositivo("d1", "Notebook", T, { assigned: 1, googleEmail: "ana@exemplo.com" }),
    d2: dispositivo("d2", "iMac", T - 2 * 3600 * 1000, { lastSeen: T - 3600 * 1000 }),
  };
  E.pushHistory("switch", "Trocou da conta 2 para a conta 1", "d1");
  const { s } = await webLogin(ctx, "ana@exemplo.com");
  const me = "ana@exemplo.com";

  // ----- GET /web/api/state -----
  let r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.status, 200, r.text);
  const st = r.json;
  assert.deepEqual(
    Object.keys(st).sort(),
    ["accounts", "adminEmails", "allowedEmails", "autoSwitch", "devices", "diag", "google", "history", "me", "models", "ruleDefaults", "rules", "serverTime", "version", "warnings"]
  );
  assert.deepEqual(st.models, { fetchedAt: null, builtin: true, list: [] }, "motor que não tem catálogo de modelos (antigo): lista vazia, sem quebrar");
  assert.deepEqual(st.me, { email: me, admin: true });
  assert.deepEqual(st.adminEmails, [me]);
  assert.equal(st.serverTime, ctx.clock.t);
  assert.equal(typeof st.version, "string");
  assert.deepEqual(E.last("publicList").args, [null]);
  assert.deepEqual(E.last("devicesList").args, [null]);
  assert.equal(st.accounts.length, 3);
  assert.deepEqual(Object.keys(st.accounts[0]).sort(), [
    "accessExpiresAt",
    "alias",
    "assignedDevices",
    "dead",
    "devices",
    "disabled",
    "email",
    "gen",
    "lastGoodAgeSeconds",
    "lastGoodUsage",
    "lastRefreshAt",
    "loginExpiresAt",
    "modelThreshold",
    "number",
    "organizationName",
    "organizationUuid",
    "plan",
    "priority",
    "threshold",
    "usage",
    "usageAgeSeconds",
    "usageStatus",
    "weeklyThreshold",
  ]);
  assert.equal(st.accounts[0].weeklyThreshold, null, "sem linha própria do semanal: regra geral");
  assert.equal(st.accounts[0].modelThreshold, null, "sem linha própria do modelo: regra geral");
  const a1 = st.accounts[0];
  const raw1 = ctx.store.state.accounts["1"];
  assert.equal(a1.number, 1);
  assert.equal(a1.loginExpiresAt, raw1.cred.refreshTokenExpiresAt);
  assert.equal(a1.accessExpiresAt, raw1.cred.expiresAt);
  assert.equal(a1.lastRefreshAt, raw1.lastRefreshAt);
  assert.equal(a1.gen, 4);
  assert.deepEqual(a1.assignedDevices, [{ id: "d1", name: "Notebook" }]);
  assert.deepEqual(a1.plan, { label: "Team" });
  assert.equal(a1.usageStatus, "ok");
  assert.equal(st.accounts[2].dead, true);
  assert.equal(st.accounts[2].loginExpiresAt, null, "sem validade conhecida");
  assert.deepEqual(st.rules, E.rulesEffective());
  assert.deepEqual(st.ruleDefaults, RULE_DEFAULTS);
  assert.equal(st.autoSwitch, true);
  assert.equal(st.devices.length, 2);
  for (const d of st.devices) {
    assert.deepEqual(Object.keys(d).sort(), [
      "active",
      "allowedAccounts",
      "assigned",
      "connected",
      "createdAt",
      "googleEmail",
      "id",
      "lastContact",
      "lastSeen",
      "name",
      "platform",
      "presence",
    ]);
    assert.deepEqual(d.allowedAccounts, [1, 2, 3], "sem restrição: todas as contas");
  }
  assert.ok(st.accounts.every((a) => a.devices === null), "sem restrição: todos os serviços");
  assert.equal(st.devices.find((d) => d.id === "d1").active, true);
  assert.equal(st.devices.find((d) => d.id === "d2").active, false);
  // Presença. Este engine não manda lastContact/connected/presence (como um motor antigo): o painel completa pelo
  // `active` — conectado = ativo, presença "active" ou "none", último contato = lastSeen.
  const presenca = (state, id) => {
    const d = state.devices.find((x) => x.id === id);
    return [d.active, d.connected, d.presence, d.lastContact];
  };
  assert.deepEqual(presenca(st, "d1"), [true, true, "active", T]);
  assert.deepEqual(presenca(st, "d2"), [false, false, "none", T - 3600 * 1000]);
  // Com os campos do motor, eles saem como vieram (e só eles: a lista de campos é fechada).
  const comPresenca = async (p) => {
    E.presence = { d2: p };
    const x = await call(ctx, "GET", "/web/api/state", { s });
    assert.equal(x.status, 200, x.text);
    assert.deepEqual(Object.keys(x.json.devices.find((d) => d.id === "d2")).sort(), Object.keys(st.devices[0]).sort());
    return presenca(x.json, "d2");
  };
  assert.deepEqual(await comPresenca({ lastContact: T - 2 * MIN, connected: true, presence: "connected", contatos: "não sai" }), [false, true, "connected", T - 2 * MIN]);
  assert.deepEqual(await comPresenca({ lastContact: T - 3600 * 1000, connected: false, presence: "waiting" }), [false, false, "waiting", T - 3600 * 1000]);
  assert.deepEqual(await comPresenca({ lastContact: T - 9 * MIN, connected: false, presence: "none" }), [false, false, "none", T - 9 * MIN]);
  // Só "conectado", sem a presença: sai do que veio. Presença que o painel não conhece: também.
  assert.deepEqual(await comPresenca({ lastContact: T - MIN, connected: true }), [false, true, "connected", T - MIN]);
  assert.deepEqual(await comPresenca({ connected: true, presence: "dormindo" }), [false, true, "connected", T - 3600 * 1000]);
  assert.deepEqual(await comPresenca({ presence: 7 }), [false, false, "none", T - 3600 * 1000]);
  E.presence = {};
  assert.deepEqual(st.allowedEmails, [], "o administrador não depende da lista");
  assert.deepEqual(st.google, { enabled: true, callbackUrl: CALLBACK });
  const hTroca = st.history.find((h) => h.kind === "switch");
  assert.deepEqual(hTroca, { ts: hTroca.ts, kind: "switch", text: "Trocou da conta 2 para a conta 1", device: "d1", deviceName: "Notebook" });
  // avisos: login da conta 1 vence em ~2 dias; conta 3 morta; a 2 (20 dias) não avisa
  const kinds = st.warnings.map((w) => `${w.kind}:${w.account ?? "-"}`).sort();
  assert.deepEqual(kinds, ["account_dead:3", "login_expiring:1"]);
  for (const w of st.warnings) assert.ok(typeof w.text === "string" && w.text.length > 10);
  assert.match(st.warnings.find((w) => w.kind === "login_expiring").text, /vence em 2 dias/);
  for (const w of st.warnings) assert.ok(w.text.endsWith(`clique em “Entrar de novo” no cartão da conta ${w.account} (ou entre com ela no Claude Code de um serviço do administrador).`), w.text);
  // o engine "vazou" cred, refreshToken e tokenHash: nada disso sai
  assert.ok(!/"cred"\s*:/.test(r.text) && !r.text.includes(REFRESH_SECRETO) && !r.text.includes(ACESSO));
  assert.ok(st.accounts.every((a) => !("cred" in a) && !("refreshToken" in a)));
  assert.ok(st.devices.every((d) => !("tokenHash" in d)));

  // ----- PUT /web/api/rules → setRules -----
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { sessionPct: 85, desconhecida: 1 }, autoSwitch: false } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("setRules").args, [{ rules: { sessionPct: 85 }, autoSwitch: false }]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.state.rules.sessionPct, 85);
  assert.equal(r.json.state.autoSwitch, false);
  assert.equal(ctx.store.state.history[0].text, `Regras alteradas pelo painel (${me})`);
  const nRegras = () => ctx.store.state.history.filter((h) => h.text.startsWith("Regras alteradas pelo painel")).length;
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { sessionPct: 85 } } });
  assert.equal(r.status, 200);
  assert.equal(nRegras(), 1, "sem mudança, sem entrada no histórico");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { sessionPct: "muito" } } });
  assert.equal(r.status, 400);
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: {} });
  assert.equal(r.status, 400);
  // 2.5.6: "Mínimo de Fable sobrando no destino" (preferMinFreePct) é uma regra numérica como as outras.
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { preferMinFreePct: 20 } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("setRules").args[0].rules, { preferMinFreePct: 20 });
  assert.equal(r.json.state.rules.preferMinFreePct, 20);
  assert.equal(r.json.state.ruleDefaults.preferMinFreePct, 10, "o padrão vai junto, para o “Voltar ao padrão” e as dicas");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { preferMinFreePct: "20" } } });
  assert.equal(r.status, 400, "texto no lugar de número");

  // ----- PATCH /web/api/accounts/:n → updateAccount -----
  r = await call(ctx, "PATCH", "/web/api/accounts/2", { s, body: { disabled: true, alias: "Trabalho", threshold: "85", campoEstranho: 1 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("updateAccount").args, [2, { disabled: true, threshold: 85, alias: "Trabalho" }]);
  assert.equal(r.json.state.accounts.find((a) => a.number === 2).alias, "Trabalho");
  assert.equal(r.json.state.accounts.find((a) => a.number === 2).disabled, true);
  assert.equal(ctx.store.state.history[0].text, `Conta 2 ajustada pelo painel (${me}): fora da rotação, apelido "Trabalho", linha da sessão 85%`);
  r = await call(ctx, "PATCH", "/web/api/accounts/2", { s, body: { priority: 3 } });
  assert.deepEqual(E.last("updateAccount").args, [2, { priority: 3 }]);
  // linhas próprias do semanal e do modelo (50–100; null apaga = regra geral)
  r = await call(ctx, "PATCH", "/web/api/accounts/2", { s, body: { weeklyThreshold: 70, modelThreshold: "88" } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("updateAccount").args, [2, { weeklyThreshold: 70, modelThreshold: 88 }]);
  let a2 = r.json.state.accounts.find((a) => a.number === 2);
  assert.deepEqual([a2.threshold, a2.weeklyThreshold, a2.modelThreshold], [85, 70, 88]);
  assert.equal(ctx.store.state.history[0].text, `Conta 2 ajustada pelo painel (${me}): linha semanal 70%, linha do modelo 88%`);
  r = await call(ctx, "PATCH", "/web/api/accounts/2", { s, body: { threshold: null, weeklyThreshold: null, modelThreshold: null } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("updateAccount").args, [2, { threshold: null, weeklyThreshold: null, modelThreshold: null }]);
  a2 = r.json.state.accounts.find((a) => a.number === 2);
  assert.deepEqual([a2.threshold, a2.weeklyThreshold, a2.modelThreshold], [null, null, null]);
  assert.equal(ctx.store.state.history[0].text, `Conta 2 ajustada pelo painel (${me}): linha da sessão padrão, linha semanal padrão, linha do modelo padrão`);
  const nPatch = E.count("updateAccount");
  for (const body of [{ weeklyThreshold: 49 }, { modelThreshold: 101 }, { weeklyThreshold: "muito" }, { modelThreshold: true }, { threshold: 30 }]) {
    r = await call(ctx, "PATCH", "/web/api/accounts/2", { s, body });
    assert.equal(r.status, 400, JSON.stringify(body));
  }
  assert.equal(E.count("updateAccount"), nPatch, "recusado não chega no motor");
  r = await call(ctx, "PATCH", "/web/api/accounts/99", { s, body: { disabled: true } });
  assert.equal(r.status, 404);
  r = await call(ctx, "PATCH", "/web/api/accounts/2", { s, body: {} });
  assert.equal(r.status, 400);

  // ----- POST /web/api/devices/:id/switch → switchDevice(id, n, "painel") -----
  r = await call(ctx, "POST", "/web/api/devices/d1/switch", { s, body: { number: 2 } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("switchDevice").args, ["d1", 2, "painel"]);
  assert.equal(r.json.switched, true);
  assert.equal(r.json.text, "Troca manual para a conta 2");
  assert.deepEqual(ctx.store.state.history[0], {
    ts: ctx.store.state.history[0].ts,
    kind: "info",
    text: `Serviço "Notebook" passou para a conta 2 pelo painel (${me})`,
    device: "d1",
    deviceName: "Notebook",
  });
  r = await call(ctx, "POST", "/web/api/devices/d1/switch", { s, body: { number: null } });
  assert.equal(r.status, 200);
  assert.deepEqual(E.last("switchDevice").args, ["d1", null, "painel"]);
  r = await call(ctx, "POST", "/web/api/devices/d1/switch", { s, body: { number: 99 } });
  assert.equal(r.status, 404);
  r = await call(ctx, "POST", "/web/api/devices/d1/switch", { s, body: { number: "dois" } });
  assert.equal(r.status, 400);
  r = await call(ctx, "POST", "/web/api/devices/nao-existe/switch", { s, body: { number: 1 } });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "not_found", message: "serviço não encontrado" });

  // ----- DELETE /web/api/accounts/:n → removeAccount -----
  r = await call(ctx, "DELETE", "/web/api/accounts/3", { s });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("removeAccount").args, [3]);
  assert.equal(r.json.number, 3);
  assert.equal(ctx.store.state.history[0].text, `Conta 3 removida pelo painel (${me})`);
  r = await call(ctx, "DELETE", "/web/api/accounts/99", { s });
  assert.equal(r.status, 404);

  // ----- DELETE /web/api/devices/:id → revoga -----
  r = await call(ctx, "DELETE", "/web/api/devices/d2", { s });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.devices.d2, undefined);
  assert.equal(cofreEmDisco(ctx).devices.d2, undefined, "gravado");
  assert.ok(ctx.store.state.history.some((h) => h.text === `Serviço "iMac" desconectado (revogado pelo painel por ${me})`));
  r = await call(ctx, "DELETE", "/web/api/devices/d2", { s });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "not_found", message: "serviço não encontrado" }, "a mesma mensagem das outras rotas do serviço");

  // ----- POST /web/api/allowed → mesma lógica do admin allow -----
  r = await call(ctx, "POST", "/web/api/allowed", { s, body: { email: " Bia@Exemplo.COM " } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.email, "bia@exemplo.com");
  assert.equal(r.json.added, true);
  assert.equal(r.json.admin, false);
  assert.deepEqual(r.json.state.allowedEmails, ["bia@exemplo.com"]);
  assert.ok(ctx.store.state.history[0].text.includes(`bia@exemplo.com liberada`) && ctx.store.state.history[0].text.endsWith(`pelo painel (${me})`));
  r = await call(ctx, "POST", "/web/api/allowed", { s, body: { email: "bia@exemplo.com" } });
  assert.equal(r.json.added, false);
  r = await call(ctx, "POST", "/web/api/allowed", { s, body: { email: "sem-arroba" } });
  assert.equal(r.status, 400);
  // liberar o administrador não faz nada (ele não depende da lista)
  r = await call(ctx, "POST", "/web/api/allowed", { s, body: { email: "Ana@Exemplo.com" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.added, false);
  assert.equal(r.json.admin, true);
  assert.deepEqual(cofreEmDisco(ctx).allowedEmails, ["bia@exemplo.com"]);

  // ----- POST /web/api/pair-code → código de conexão de reserva -----
  r = await call(ctx, "POST", "/web/api/pair-code", { s, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.keys(r.json).sort(), ["code", "connect", "expiresAt"]);
  assert.match(r.json.code, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/);
  const dec = JSON.parse(Buffer.from(r.json.connect.slice("swapplus1:".length), "base64url").toString("utf8"));
  assert.deepEqual(dec, { url: PUBLIC_URL, code: r.json.code, fp: null });
  assert.equal(ctx.store.state.pairing.codeHash, sha256(r.json.code));
  assert.equal(r.json.expiresAt, ctx.clock.t + 10 * MIN);
  assert.equal(ctx.store.state.history[0].text, `Código de conexão gerado pelo painel (${me})`);
  // o código serve no /v1/pair
  r = await call(ctx, "POST", "/v1/pair", { body: { code: r.json.code, name: "Pelo painel", platform: "linux" }, origin: null });
  assert.equal(r.status, 200, r.text);

  // ----- GET /web/api/sessions -----
  r = await call(ctx, "GET", "/web/api/sessions", { s });
  assert.equal(r.status, 200);
  assert.equal(r.json.length, 1);
  assert.deepEqual(Object.keys(r.json[0]).sort(), ["createdAt", "current", "email", "expiresAt", "id", "ip", "lastSeen", "ua"]);
  assert.equal(r.json[0].id, s.id);
  assert.equal(r.json[0].current, true);
  assert.equal(r.json[0].ua, "Chrome no macOS");

  // rota desconhecida / método errado
  r = await call(ctx, "GET", "/web/api/nao-existe", { s });
  assert.equal(r.status, 404);
  r = await call(ctx, "GET", "/web/api/rules", { s });
  assert.equal(r.status, 405);

  // erro inesperado do engine → 500 genérico, sem detalhe
  E.removeAccount = async () => {
    throw new Error(`falha interna com ${ACESSO}`);
  };
  r = await call(ctx, "DELETE", "/web/api/accounts/1", { s });
  assert.equal(r.status, 500);
  assert.deepEqual(r.json, { error: "internal", message: "erro interno no servidor" });
});

test("e-mail: emailKey normaliza só para comparar (minúsculas; Gmail sem pontos e sem +algo); ADMIN_EMAILS lido na subida", () => {
  assert.equal(emailKey("Dono.Exemplo+x@googlemail.com"), "donoexemplo@gmail.com");
  assert.equal(emailKey(" DONOEXEMPLO@GMAIL.COM "), "donoexemplo@gmail.com");
  assert.equal(emailKey("d.o.n.o.e.x.e.m.p.l.o+trabalho+2@gmail.com"), "donoexemplo@gmail.com");
  assert.ok(sameEmail("Dono.Exemplo+x@googlemail.com", "donoexemplo@gmail.com"));
  // fora do Gmail, ponto e "+" podem ser contas diferentes: só minúsculas
  assert.equal(emailKey("Ana.Souza+x@Empresa.com"), "ana.souza+x@empresa.com");
  assert.ok(!sameEmail("ana.souza@empresa.com", "anasouza@empresa.com"));
  assert.ok(!sameEmail("ana+x@empresa.com", "ana@empresa.com"));
  for (const ruim of ["", "sem-arroba", "@gmail.com", "x@", "+x@gmail.com", "...@gmail.com", null, 42]) assert.equal(emailKey(ruim), "", String(ruim));
  assert.ok(!sameEmail("", ""));

  // ADMIN_EMAILS: vírgula (espaço e ; também), guardado como veio (aparado, minúsculas), repetido pela chave sai
  let c = loadConfig({ TLS_MODE: "off", ADMIN_EMAILS: " Donoexemplo@Gmail.com, outra@empresa.com;dono.exemplo+x@googlemail.com nada " });
  assert.deepEqual(c.adminEmails, ["donoexemplo@gmail.com", "outra@empresa.com"]);
  assert.deepEqual(c.adminEmailsInvalid, ["nada"], "entrada errada é ignorada (com aviso), não derruba o servidor");
  c = loadConfig({ TLS_MODE: "off" });
  assert.deepEqual(c.adminEmails, []);
  assert.equal(c.resticPassFile, "/run/secrets/restic_swap_plus_pass");
});

test("painel: só o administrador entra; conta liberada não-admin vê 'painel só do administrador' mas conecta serviço", async (t) => {
  const ctx = await setup(t); // ADMIN_EMAILS = ana@exemplo.com
  await allow(ctx, "bia@exemplo.com");

  // a administradora entra sem estar na lista de liberadas
  const { s: ana } = await webLogin(ctx, ADMIN);
  assert.ok(ana, "administradora entrou");
  let r = await call(ctx, "GET", "/web/api/state", { s: ana });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.me, { email: ADMIN, admin: true });
  assert.deepEqual(r.json.adminEmails, [ADMIN]);
  assert.deepEqual(r.json.allowedEmails, ["bia@exemplo.com"]);

  // bia está liberada, mas não é administradora: página própria, nenhuma sessão
  const b = await webLogin(ctx, "bia@exemplo.com");
  assertPage(b.page, 403);
  assert.ok(b.page.text.includes(NOT_ADMIN_TEXT), b.page.text);
  // o caminho para conectar usa o nome novo do cartão da extensão ("Conexão")
  assert.ok(b.page.text.includes("Para conectar um serviço: no VS Code, abra o Swap Plus e clique em Entrar com Google no cartão “Conexão”."), b.page.text);
  assert.match(b.page.text, /href="\/web\/login"/, "botão para entrar com outra conta");
  assert.equal(cookieFrom(b.page, "sp_sess"), null);
  assert.equal(cookieFrom(b.page, "sp_login").value, "", "o cookie do login é apagado");
  assert.equal(b.s, null);
  assert.deepEqual(Object.keys(ctx.store.state.webSessions), [ana.id]);
  assert.ok(ctx.logs.some((l) => l.includes("bia@exemplo.com") && l.includes("não é administrador")));
  const again = await call(ctx, "GET", b.callbackPath);
  assertPage(again, 403);
  assert.ok(again.text.includes(NOT_ADMIN_TEXT), "recarregar mostra a mesma recusa");

  // mas bia conecta serviço pelo VS Code
  const pcBia = await deviceLogin(ctx, "bia@exemplo.com", "PC da Bia");
  assertPage(pcBia.page, 200);
  assert.match(pcBia.page.text, /Pronto! Conectado\./);
  assert.equal(pcBia.poll.status, "ok");
  assert.equal(ctx.store.state.devices[pcBia.poll.deviceId].googleEmail, "bia@exemplo.com");
  // a administradora também conecta serviço, sem estar na lista
  const pcAna = await deviceLogin(ctx, ADMIN, "Mac da Ana");
  assert.equal(pcAna.poll.status, "ok");
  // quem não está em lugar nenhum não conecta
  const pcCris = await deviceLogin(ctx, "cris@exemplo.com", "PC da Cris");
  assertPage(pcCris.page, 403);
  assert.deepEqual(pcCris.poll, { status: "denied", email: "cris@exemplo.com" });

  // tirar a bia: não conecta serviços novos; o que ela já conectou continua
  r = await call(ctx, "DELETE", "/web/api/allowed/bia%40exemplo.com", { s: ana });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, true);
  assert.equal(r.json.panelSessions, 0);
  assert.deepEqual(r.json.devices, [{ id: pcBia.poll.deviceId, name: "PC da Bia" }]);
  assert.deepEqual(r.json.state.allowedEmails, []);
  assert.ok(ctx.store.state.history.some((h) => h.text.startsWith("Conta Google bia@exemplo.com tirada da lista") && h.text.endsWith(`pelo painel (${ADMIN})`)));
  r = await call(ctx, "GET", "/v1/state", { headers: { authorization: `Bearer ${pcBia.token}` }, origin: null });
  assert.equal(r.status, 200, "o serviço já conectado continua (revogar é à parte)");
  const pcBia2 = await deviceLogin(ctx, "bia@exemplo.com", "Outro PC da Bia");
  assert.deepEqual(pcBia2.poll, { status: "denied", email: "bia@exemplo.com" });

  // ADMIN_EMAILS não muda pelo painel nem pelo admin (não há rota)
  for (const [m, p] of [["POST", "/web/api/admins"], ["PUT", "/web/api/admin"], ["POST", "/web/api/admin-emails"]]) {
    r = await call(ctx, m, p, { s: ana, body: { email: "bia@exemplo.com" } });
    assert.equal(r.status, 404, `${m} ${p}`);
  }
  r = await adminCall(ctx, "POST", "/admin/admins", { body: { email: "bia@exemplo.com" } });
  assert.equal(r.status, 404);
  r = await adminCall(ctx, "GET", "/admin/allowed");
  assert.deepEqual(r.json.adminEmails, [ADMIN]);
});

test("painel: deny do administrador → 409 (painel e CLI), mesmo escrito de outro jeito ou se ele estiver na lista", async (t) => {
  const ctx = await setup(t, { env: { ADMIN_EMAILS: "donoexemplo@gmail.com" } });
  const { s } = await webLogin(ctx, "donoexemplo@gmail.com");
  assert.ok(s);
  for (const forma of ["donoexemplo%40gmail.com", "DONO.exemplo%2Bqualquer%40googlemail.com"]) {
    const r = await call(ctx, "DELETE", `/web/api/allowed/${forma}`, { s });
    assert.equal(r.status, 409, forma);
    assert.equal(r.json.error, "admin");
    assert.match(r.json.message, /administrador/);
    assert.match(r.json.message, /ADMIN_EMAILS/);
  }
  let r = await adminCall(ctx, "POST", "/admin/deny", { body: { email: "Dono.Exemplo@gmail.com" } });
  assert.equal(r.status, 409, "pelo CLI (deny) também");
  assert.equal(r.json.error, "admin");
  // dado antigo: o administrador ainda está na lista de liberadas → também não sai (e nada muda)
  ctx.store.state.allowedEmails = ["donoexemplo@gmail.com"];
  r = await call(ctx, "DELETE", "/web/api/allowed/donoexemplo%40gmail.com", { s });
  assert.equal(r.status, 409);
  assert.deepEqual(ctx.store.state.allowedEmails, ["donoexemplo@gmail.com"]);
  assert.equal((await call(ctx, "GET", "/web/api/me", { s })).status, 200, "a sessão do administrador segue");
  // liberar o administrador não faz nada
  r = await adminCall(ctx, "POST", "/admin/allow", { body: { email: "dono.exemplo+x@googlemail.com" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.added, false);
  assert.equal(r.json.admin, true);
  assert.deepEqual(ctx.store.state.allowedEmails, ["donoexemplo@gmail.com"]);
});

test('e-mail normalizado: "Dono.Exemplo+x@googlemail.com" bate com donoexemplo@gmail.com (painel, lista, repetidos, serviços, deny)', async (t) => {
  const ctx = await setup(t, { env: { ADMIN_EMAILS: "donoexemplo@gmail.com" } });

  // login do painel: o Google devolve o e-mail escrito de outro jeito → é o administrador
  const b = await webLogin(ctx, "Dono.Exemplo+x@googlemail.com");
  assert.equal(b.page.status, 302, b.page.text);
  assert.ok(b.s, "entrou como administrador");
  let r = await call(ctx, "GET", "/web/api/me", { s: b.s });
  assert.equal(r.json.email, "dono.exemplo+x@googlemail.com", "guardado e mostrado como veio (minúsculas)");
  assert.equal(r.json.admin, true);
  r = await call(ctx, "GET", "/web/api/state", { s: b.s });
  assert.deepEqual(r.json.me, { email: "dono.exemplo+x@googlemail.com", admin: true });
  assert.deepEqual(r.json.adminEmails, ["donoexemplo@gmail.com"]);

  // login de serviço do administrador (escrito de outro jeito), sem estar na lista
  const pcAdm = await deviceLogin(ctx, "d.o.n.o.e.x.e.m.p.l.o@gmail.com", "Mac do dono");
  assert.equal(pcAdm.poll.status, "ok");

  // lista: guardada como veio; repetido pela chave não entra de novo
  r = await call(ctx, "POST", "/web/api/allowed", { s: b.s, body: { email: "Maria.Silva@gmail.com" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.email, "maria.silva@gmail.com");
  assert.equal(r.json.added, true);
  r = await adminCall(ctx, "POST", "/admin/allow", { body: { email: "mariasilva+trabalho@googlemail.com" } });
  assert.equal(r.json.added, false, "mesma conta Gmail");
  assert.deepEqual(ctx.store.state.allowedEmails, ["maria.silva@gmail.com"]);

  // serviço da Maria com o e-mail sem ponto: liberado
  const pc = await deviceLogin(ctx, "MariaSilva@gmail.com", "PC da Maria");
  assert.equal(pc.poll.status, "ok");
  // painel da Maria: liberada, mas não administradora
  const bm = await webLogin(ctx, "mariasilva@googlemail.com");
  assertPage(bm.page, 403);
  assert.ok(bm.page.text.includes(NOT_ADMIN_TEXT));

  // deny escrito de outro jeito tira a conta e acha o serviço dela
  r = await call(ctx, "DELETE", `/web/api/allowed/${encodeURIComponent("Maria.Silva+x@googlemail.com")}`, { s: b.s });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, true);
  assert.deepEqual(r.json.devices, [{ id: pc.poll.deviceId, name: "PC da Maria" }]);
  assert.deepEqual(ctx.store.state.allowedEmails, []);
  assert.deepEqual(cofreEmDisco(ctx).allowedEmails, []);
  const pc2 = await deviceLogin(ctx, "maria.silva@gmail.com", "Outro PC da Maria");
  assert.equal(pc2.poll.status, "denied");

  // derrubar sessões no deny também compara pela chave (sessão que sobrou de antes, de quem não é administrador)
  const T = ctx.clock.t;
  ctx.store.state.allowedEmails = ["joao.lima@gmail.com"];
  ctx.store.state.webSessions.velha = { tokenHash: sha256("x"), email: "joaolima@googlemail.com", createdAt: T, lastSeen: T, expiresAt: T + DAY, ua: null, ip: null, csrf: "c" };
  r = await adminCall(ctx, "POST", "/admin/deny", { body: { email: "JoaoLima+a@gmail.com" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.removed, true);
  assert.equal(r.json.panelSessions, 1);
  assert.equal(ctx.store.state.webSessions.velha, undefined);
  assert.ok(ctx.store.state.webSessions[b.s.id], "a sessão do administrador continua");
});

test("sem ADMIN_EMAILS → painel desligado (página explicando, /web/login e /web/api 503, aviso no log); os serviços seguem", async (t) => {
  const ctx = await setup(t, { env: { ADMIN_EMAILS: "" } });
  assert.ok(ctx.logs.some((l) => l.includes("ADMIN_EMAILS") && l.includes("DESLIGADO") && l.includes("(os serviços seguem funcionando)")), "aviso no log");

  let r = await call(ctx, "GET", "/");
  assertPage(r, 503);
  assert.match(r.text, /Painel desligado/);
  assert.match(r.text, /ADMIN_EMAILS/);
  assert.match(r.text, /Os serviços conectados continuam funcionando normalmente\./);
  r = await call(ctx, "GET", "/web/login");
  assertPage(r, 503);
  assert.match(r.text, /ADMIN_EMAILS/);
  assert.equal(cookieFrom(r, "sp_login"), null);
  assert.equal(ctx.fake.authCalls.length, 0, "nem vai ao Google");
  for (const p of ["/web/api/me", "/web/api/state", "/web/api/recovery-kit"]) {
    r = await call(ctx, "GET", p, { headers: { cookie: "sp_sess=" + "a".repeat(43) } });
    assert.equal(r.status, 503, p);
    assert.equal(r.json.error, "panel_off", p);
  }
  r = await call(ctx, "PUT", "/web/api/rules", { body: { autoSwitch: false } });
  assert.equal(r.status, 503);
  assert.equal(ctx.engine.count("setRules"), 0);
  r = await adminCall(ctx, "GET", "/admin/allowed");
  assert.deepEqual(r.json.adminEmails, []);
  // sessão que sobrou no cofre de antes: não vale e sai na limpeza
  const T = ctx.clock.t;
  ctx.store.state.webSessions.velha = { tokenHash: sha256("y"), email: ADMIN, createdAt: T, lastSeen: T, expiresAt: T + DAY, ua: null, ip: null, csrf: "c" };
  assert.equal(await ctx.app.sweepWebSessions(), 1);

  // os serviços continuam: conta liberada conecta pelo VS Code
  await allow(ctx, ADMIN);
  const pc = await deviceLogin(ctx, ADMIN, "Notebook");
  assert.equal(pc.poll.status, "ok");

  // ADMIN_EMAILS só com lixo: também desligado, e o log diz qual entrada foi ignorada
  const lixo = await setup(t, { env: { ADMIN_EMAILS: "nao-e-email" } });
  assert.ok(lixo.logs.some((l) => l.includes("nao-e-email") && l.includes("ignorada")));
  assertPage(await call(lixo, "GET", "/"), 503);
});

test("avisos do painel sem serviços, sem contas e com o login com Google desligado: os textos falam em “serviço”", async (t) => {
  const ctx = await setup(t, { google: false });
  // Sem o Google não dá para entrar pelo navegador: a sessão do administrador é criada direto.
  const { token } = ctx.app.web.createSession({ email: ADMIN, ip: "127.0.0.1", ua: UA });
  ctx.tokens.push(token);
  ctx.store.state.accounts = {};
  const r = await call(ctx, "GET", "/web/api/state", { s: { token } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(Object.fromEntries(r.json.warnings.map((w) => [w.kind, w.text])), {
    google_off: "O login com Google está desligado neste servidor: serviços novos só conectam com código de conexão e ninguém entra de novo no painel até ele voltar.",
    no_devices: "Nenhum serviço conectado: conecte um pelo VS Code (Swap Plus: Conectar ao servidor → Entrar com Google) ou gere um código de conexão.",
    no_accounts: "Nenhuma conta Claude no servidor ainda: conecte um serviço e envie os logins dele.",
  });
});

test("sessão de quem deixou de ser administrador (ADMIN_EMAILS mudou e o servidor reiniciou) → 401", async (t) => {
  const ctx = await setup(t, { env: { ADMIN_EMAILS: "ana@exemplo.com,bia@exemplo.com" } });
  const { s: ana } = await webLogin(ctx, "ana@exemplo.com");
  const { s: bia } = await webLogin(ctx, "bia@exemplo.com");
  const { s: bia2 } = await webLogin(ctx, "bia@exemplo.com", { ua: UA_IPHONE });
  assert.ok(ana && bia && bia2);
  assert.equal((await call(ctx, "GET", "/web/api/state", { s: bia })).status, 200);

  // reinicia só com a ana (as sessões ficam no cofre, como num restart de verdade)
  const ctx2 = await restart(t, ctx, { ADMIN_EMAILS: "ana@exemplo.com" });
  let r = await call(ctx2, "GET", "/web/api/state", { s: bia });
  assert.equal(r.status, 401, "bia não é mais administradora");
  assert.equal(r.json.error, "unauthorized");
  assert.equal(ctx.store.state.webSessions[bia.id], undefined, "a sessão dela sai do cofre");
  r = await call(ctx2, "GET", "/web/api/recovery-kit", { s: bia2 });
  assert.equal(r.status, 401, "nem o kit de recuperação");
  r = await call(ctx2, "PUT", "/web/api/rules", { s: bia2, body: { autoSwitch: false } });
  assert.equal(r.status, 401);
  assert.equal(ctx.engine.count("setRules"), 0);
  r = await call(ctx2, "GET", "/web/api/state", { s: ana });
  assert.equal(r.status, 200, "a ana continua");
  assert.deepEqual(r.json.adminEmails, ["ana@exemplo.com"]);
  // a limpeza periódica também tira as sessões de quem saiu
  const { s: bia3 } = await webLogin(ctx, "bia@exemplo.com"); // no app antigo ela ainda é administradora
  assert.ok(bia3);
  assert.equal(await ctx2.app.sweepWebSessions(), 1);
  assert.equal(ctx.store.state.webSessions[bia3.id], undefined);
  assert.ok(ctx.store.state.webSessions[ana.id]);
  // e ela não entra de novo no app novo
  const b = await webLogin(ctx2, "bia@exemplo.com");
  assertPage(b.page, 403);
});

test("painel: kit de recuperação (chave mestra + senha do backup) só com login de menos de 15 min, com CSRF, sem cache e sem log", async (t) => {
  const ctx = await setup(t);
  const chave = fs.readFileSync(ctx.keyFile, "utf8").trim();
  const { s } = await webLogin(ctx, ADMIN);

  let r = await call(ctx, "GET", "/web/api/recovery-kit", { s });
  assert.equal(r.status, 200, r.text);
  assert.match(String(r.headers["cache-control"]), /no-store/);
  assert.deepEqual(r.json.masterKey, { available: true, value: chave, file: ctx.keyFile });
  assert.equal(r.json.backupPassword.available, false, "sem o arquivo: não disponível");
  assert.equal(r.json.backupPassword.value, null);
  assert.match(r.json.backupPassword.why, /não existe/);
  assert.match(r.json.advice, /FORA deste servidor/);
  assert.equal(r.json.availableUntil, ctx.store.state.webSessions[s.id].createdAt + 15 * MIN);
  assert.equal(ctx.store.state.history[0].text, `Kit de recuperação visto pelo painel (${ADMIN})`);
  const vistos = () => ctx.store.state.history.filter((h) => h.text.startsWith("Kit de recuperação visto pelo painel")).length;
  assert.equal(vistos(), 1);

  // com a senha do backup
  fs.writeFileSync(ctx.resticFile, "senha-do-backup-123\n", { mode: 0o600 });
  r = await call(ctx, "GET", "/web/api/recovery-kit", { s });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.backupPassword, { available: true, value: "senha-do-backup-123", file: ctx.resticFile });

  // sem X-CSRF-Token → 403; sem sessão → 401
  r = await call(ctx, "GET", "/web/api/recovery-kit", { s, csrf: null });
  assert.equal(r.status, 403);
  assert.equal(r.json.error, "csrf");
  r = await call(ctx, "GET", "/web/api/recovery-kit");
  assert.equal(r.status, 401);

  // login com mais de 15 min → 403 reauth (com o caminho para entrar de novo), sem entregar nada
  ctx.clock.t += 15 * MIN;
  r = await call(ctx, "GET", "/web/api/recovery-kit", { s });
  assert.equal(r.status, 403, r.text);
  assert.equal(r.json.error, "reauth");
  assert.equal(r.json.login, "/web/login?next=acesso");
  assert.ok(!r.text.includes(chave) && !r.text.includes("senha-do-backup-123"));
  assert.equal(vistos(), 2, "a recusa não conta como visto");
  assert.equal((await call(ctx, "GET", "/web/api/state", { s })).status, 200, "o resto do painel segue normal");

  // entrar de novo (pelo link do kit: volta para a aba Acesso) → recente de novo
  const b = await webLogin(ctx, ADMIN, { loginPath: "/web/login?next=acesso", cookie: `sp_sess=${s.token}` });
  assert.equal(b.page.headers.location, "/#acesso");
  r = await call(ctx, "GET", "/web/api/recovery-kit", { s: b.s });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.masterKey.value, chave);
  // next fora da lista de abas é ignorado
  const b2 = await webLogin(ctx, ADMIN, { loginPath: "/web/login?next=https://golpe.exemplo" });
  assert.equal(b2.page.headers.location, "/");

  // os valores nunca vão para o log
  const logText = ctx.logs.join("\n");
  assert.ok(!logText.includes(chave), "a chave mestra não vai para o log");
  assert.ok(!logText.includes("senha-do-backup-123"), "a senha do backup não vai para o log");
  assert.ok(logText.includes(`kit de recuperação visto por ${ADMIN}`));
});

test("painel: sessão vale 30 dias; lastSeen sobe no máximo 1x/min sem gravar o cofre; logout e encerrar sessão", async (t) => {
  const ctx = await setup(t);
  const { s } = await webLogin(ctx, "ana@exemplo.com");
  const criada = ctx.clock.t;
  const sess = () => ctx.store.state.webSessions[s.id];

  ctx.clock.t += 30 * 1000;
  assert.equal((await call(ctx, "GET", "/web/api/state", { s })).status, 200);
  assert.equal(sess().lastSeen, criada, "menos de 1 min: não mexe");
  ctx.clock.t += 31 * 1000;
  assert.equal((await call(ctx, "GET", "/web/api/state", { s })).status, 200);
  const visto = ctx.clock.t;
  assert.equal(sess().lastSeen, visto, "passou de 1 min: atualiza");
  assert.equal(cofreEmDisco(ctx).webSessions[s.id].lastSeen, criada, "só na memória (não grava o cofre a cada pedido)");
  ctx.clock.t += 20 * 1000;
  await call(ctx, "GET", "/web/api/me", { s });
  assert.equal(sess().lastSeen, visto);

  // vence 30 dias depois de criada
  ctx.clock.t = criada + 30 * DAY - 1000;
  assert.equal((await call(ctx, "GET", "/web/api/me", { s })).status, 200);
  ctx.clock.t = criada + 30 * DAY + 1;
  let r = await call(ctx, "GET", "/web/api/me", { s });
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "unauthorized");
  assert.equal(ctx.store.state.webSessions[s.id], undefined, "a vencida sai do cofre");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { autoSwitch: false } });
  assert.equal(r.status, 401);
  assert.equal(ctx.engine.count("setRules"), 0);

  // logout: apaga a sessão e o cookie
  const { s: s2 } = await webLogin(ctx, "ana@exemplo.com");
  r = await call(ctx, "POST", "/web/logout", { s: s2, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true });
  const limpo = cookieFrom(r, "sp_sess");
  assertCookieFlags(limpo, "/", 0);
  assert.equal(limpo.value, "");
  assert.equal(ctx.store.state.webSessions[s2.id], undefined);
  assert.equal(cofreEmDisco(ctx).webSessions[s2.id], undefined);
  assert.equal((await call(ctx, "GET", "/web/api/me", { s: s2 })).status, 401);
  // logout sem sessão só apaga o cookie
  r = await call(ctx, "POST", "/web/logout", { body: {} });
  assert.equal(r.status, 200);
  assert.ok(cookieFrom(r, "sp_sess"));

  // encerrar outra sessão pela lista; encerrar a própria = sair
  const { s: s3 } = await webLogin(ctx, "ana@exemplo.com");
  const { s: s4 } = await webLogin(ctx, "ana@exemplo.com", { ua: UA_IPHONE });
  r = await call(ctx, "DELETE", `/web/api/sessions/${s4.id}`, { s: s3 });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.loggedOut, false);
  assert.deepEqual(r.json.sessions.map((x) => x.id), [s3.id]);
  assert.equal((await call(ctx, "GET", "/web/api/me", { s: s4 })).status, 401);
  assert.ok(ctx.store.state.history[0].text.includes("Safari no iOS"));
  r = await call(ctx, "DELETE", `/web/api/sessions/${s4.id}`, { s: s3 });
  assert.equal(r.status, 404);
  r = await call(ctx, "DELETE", `/web/api/sessions/${s3.id}`, { s: s3 });
  assert.equal(r.status, 200);
  assert.equal(r.json.loggedOut, true);
  assert.equal(cookieFrom(r, "sp_sess").value, "");
  assert.equal((await call(ctx, "GET", "/web/api/me", { s: s3 })).status, 401);

  // limpeza periódica tira as vencidas e grava
  const { s: s5 } = await webLogin(ctx, "ana@exemplo.com");
  ctx.clock.t += 31 * DAY;
  assert.equal(await ctx.app.sweepWebSessions(), 1);
  assert.equal(cofreEmDisco(ctx).webSessions[s5.id], undefined);
});

test("painel: arquivos com CSP e lista fixa (sem path traversal); a página sai mesmo sem sessão", async (t) => {
  const ctx = await setup(t);
  const seguranca = (r) => {
    assert.equal(r.headers["content-security-policy"], PANEL_CSP);
    assert.equal(r.headers["x-frame-options"], "DENY");
    assert.equal(r.headers["referrer-policy"], "no-referrer");
    assert.equal(r.headers["x-content-type-options"], "nosniff");
  };
  let r = await call(ctx, "GET", "/");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(r.text, INDEX_HTML);
  seguranca(r);
  r = await call(ctx, "GET", "/?qualquer=coisa");
  assert.equal(r.status, 200);
  assert.equal(r.text, INDEX_HTML);
  r = await call(ctx, "GET", "/static/app.js");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/javascript; charset=utf-8");
  assert.equal(r.text, APP_JS);
  seguranca(r);
  r = await call(ctx, "GET", "/static/app.css");
  assert.equal(r.status, 200);
  assert.equal(r.headers["content-type"], "text/css; charset=utf-8");
  assert.equal(r.text, APP_CSS);
  seguranca(r);

  for (const p of [
    "/static/../segredo.txt",
    "/static/..%2fsegredo.txt",
    "/static/%2e%2e/segredo.txt",
    "/static/%2e%2e%2f%2e%2e%2fsrc%2fserver.js",
    "/static/../../src/server.js",
    "/static//etc/passwd",
    "/static/index.html",
    "/static/app.js.map",
    "/static/APP.JS",
    "/static/",
    "/index.html",
    "/app.js",
    "/web/../segredo.txt",
    "/segredo.txt",
    "/web/app.js",
  ]) {
    r = await call(ctx, "GET", p);
    assert.equal(r.status, 404, `${p} → ${r.status}`);
    assert.ok(!r.text.includes("NAO-PODE-SAIR") && !r.text.includes("createApp") && !r.text.includes("root:"), p);
  }

  // sem sessão: a API do painel responde 401 (a página decide o que mostrar)
  r = await call(ctx, "GET", "/web/api/me");
  assert.equal(r.status, 401);
  assert.equal(r.json.error, "unauthorized");
  assert.equal(r.json.login, "/web/login");
  assert.equal(r.json.googleEnabled, true);
  assert.equal(r.headers["cache-control"], "no-store");
  r = await call(ctx, "GET", "/web/api/state", { headers: { cookie: "sp_sess=" + "a".repeat(43) } });
  assert.equal(r.status, 401);

  // sem os arquivos do painel: a página responde 503 (HTML), os arquivos 404
  const sem = await setup(t, { webFiles: false });
  r = await call(sem, "GET", "/");
  assertPage(r, 503);
  assert.match(r.text, /Painel não instalado/);
  r = await call(sem, "GET", "/static/app.js");
  assert.equal(r.status, 404);
});

// Os outros testes usam arquivos de mentira (config.webDir). Este lê os de verdade, em server/web, e confere o que
// dá para conferir sem navegador: o menu, a CSP (nada inline) e as peças da lista de contas da 2.5.1.
test('painel de verdade (server/web): menu "Contas · Serviços · Usuários", nada inline (CSP) e contas que abrem e fecham', () => {
  const webDir = path.join(__dirname, "..", "web");
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(webDir, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(webDir, "app.css"), "utf8");

  // Menu: só o nome da aba "Computadores" mudou para "Serviços" (o id da seção e o endereço continuam).
  const abas = [...html.matchAll(/<button type="button" class="tab" id="tab-([a-z]+)" data-sec="([a-z]+)"[^>]*><span>([^<]+)<\/span>/g)].map((m) => [m[1], m[2], m[3]]);
  assert.deepEqual(abas, [
    ["contas", "contas", "Contas"],
    ["computadores", "computadores", "Serviços"],
    ["usuarios", "usuarios", "Usuários"],
  ]);
  assert.match(html, /<h2 id="h-computadores" class="sechead">Serviços<\/h2>/);
  assert.ok(!/<span>Computadores<\/span>/.test(html), "sobrou a aba com o nome antigo");
  assert.ok(!/class="sechead">Computadores</.test(html), "sobrou o título antigo da página da aba");
  assert.match(js, /const SECTIONS = \["contas", "computadores", "usuarios"\]/, "o id da seção não mudou (#computadores)");

  // CSP do painel (script-src 'self'; style-src 'self'): nada de script ou estilo inline na página.
  assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>/i.test(html), "script inline");
  assert.ok(!/<style[\s>]/i.test(html), "<style> na página");
  assert.ok(!/\sstyle\s*=/i.test(html), 'atributo style="…"');
  assert.ok(!/\son[a-z]+\s*=\s*["']/i.test(html), "atributo on…= (evento inline)");
  assert.ok(!/\.innerHTML\b|\binsertAdjacentHTML\b|\beval\(|setAttribute\(\s*["']style["']/.test(js), "app.js: nada de innerHTML, eval ou style por atributo");
  assert.ok(!/@import|url\(\s*["']?(?:https?:)?\/\//i.test(css), "app.css: nada de fora do servidor");

  // Contas: a linha é um botão com aria-expanded/aria-controls; o que está aberto fica só na memória (por número).
  assert.match(js, /const acctExpanded = new Set\(\);/);
  assert.match(js, /class: "arow"/);
  assert.match(js, /"aria-expanded":/);
  assert.match(js, /"aria-controls": `acc-\$\{n\}-body`/);
  assert.match(js, /class: "abody", id: `acc-\$\{n\}-body`/);
  assert.ok(!/(?:local|session)Storage\.setItem\([^)]*(?:acct|conta)/i.test(js), "o aberto/fechado das contas não é gravado");
  // Alerta de login: os dois textos, e o piscar só no CSS (parado com prefers-reduced-motion).
  assert.match(js, /`Fazer login até \$\{when\}`/);
  assert.match(js, /`Login venceu \$\{/);
  assert.match(css, /\.ralert\s*\{[^}]*animation:\s*loginblink[^}]*infinite/);
  assert.match(css, /@keyframes loginblink\s*\{/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.ralert\s*\{[^}]*animation:\s*none/);
  assert.ok(!/setInterval\([^)]*(?:blink|pisca)/i.test(js), "o piscar não usa temporizador");
});

// 2.5.2: contas fora da troca no fim da lista (sem grupo), serviços em linhas que abrem e fecham, tabela de
// usuários (ordenar, confirmar na linha, mensagens no lugar) e uma busca em cada aba. Também lê os arquivos de verdade.
test("painel de verdade (server/web), 2.5.2: sem o grupo “Fora da troca”, serviços em linhas, tabela de usuários e busca em cada aba", () => {
  const webDir = path.join(__dirname, "..", "web");
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(webDir, "app.js"), "utf8").replace(/\r\n/g, "\n");
  const css = fs.readFileSync(path.join(webDir, "app.css"), "utf8").replace(/\r\n/g, "\n");

  // Contas: uma lista só (o grupo recolhido "Fora da troca (N)" saiu da tela, do JS e do CSS).
  for (const [nome, texto] of [["index.html", html], ["app.js", js], ["app.css", css]]) {
    assert.ok(!/outgroup|outOpen/.test(texto), `${nome}: sobrou o grupo "Fora da troca"`);
  }
  assert.ok(!/Fora da troca \(\$\{/.test(js), 'app.js: sobrou o título "Fora da troca (N)"');
  assert.match(js, /\.\.\.inQ\.filter\(inUse\), \.\.\.off\.filter\(inUse\), \.\.\.inQ\.filter\(\(a\) => !inUse\(a\)\), \.\.\.off\.filter\(\(a\) => !inUse\(a\)\)/, "ordem: em uso, fila, fora da troca no fim");

  // Busca: um campo por aba, com rótulo, contador "N de M" e botão de limpar; o texto fica só na memória.
  for (const [sec, rotulo] of [["contas", "Buscar nas contas"], ["computadores", "Buscar nos serviços"], ["usuarios", "Buscar nos usuários"]]) {
    assert.match(html, new RegExp(`<label class="visually-hidden" for="q-${sec}">${rotulo}</label>`), `rótulo da busca de ${sec}`);
    assert.match(html, new RegExp(`<input type="search" id="q-${sec}"[^>]*autocomplete="off"[^>]*aria-describedby="qn-${sec}"`), `campo de busca de ${sec}`);
    assert.match(html, new RegExp(`<button type="button" class="iconbtn clearbtn hidden" id="qx-${sec}" aria-label="Limpar a busca [^"]+">`), `botão de limpar de ${sec}`);
    assert.match(html, new RegExp(`id="qn-${sec}" role="status"`), `contador de ${sec}`);
  }
  assert.match(js, /const filters = \{ contas: "", computadores: "", usuarios: "" \};/);
  assert.match(js, /`\$\{shown\} de \$\{total\}`/);
  assert.match(js, /`Nada encontrado para “\$\{filters\[sec\]\.trim\(\)\}”`/);
  assert.match(js, /e\.key !== "Escape"/, "Esc limpa a busca");
  assert.ok(!/(?:local|session)Storage\.setItem\([^)]*(?:filter|busca|q-)/i.test(js), "a busca não é gravada");

  // A regra da busca, de verdade: tira do app.js o fold() e o searchFilter() e roda aqui (são funções sem tela).
  const foldSrc = /\n  const fold = \(v\) =>[\s\S]*?;\n/.exec(js);
  const filterSrc = /\n  function searchFilter\(sec, list, textsOf\) \{[\s\S]*?\n  \}\n/.exec(js);
  assert.ok(foldSrc && filterSrc, "não achei fold()/searchFilter() no app.js");
  const filters = { t: "" };
  const { fold, searchFilter } = new Function("filters", `${foldSrc[0]}${filterSrc[0]}return { fold, searchFilter };`)(filters);
  assert.equal(fold("Serviço  JOSÉ Antônio – Ação"), "servico  jose antonio – acao");
  const itens = [
    { n: 1, t: ["Conta 7", "ana@exemplo.com", "em uso em 2 serviços", "5º na fila"] },
    { n: 2, t: ["Conta 9", "bia@exemplo.com", "7º na fila", "sem leitura de uso", "Serviço de Rotinas"] },
    { n: 3, t: ["Conta 12", "José Antônio", "fora da troca", null] },
  ];
  const busca = (q) => {
    filters.t = q;
    return searchFilter("t", itens, (x) => x.t).map((x) => x.n);
  };
  assert.deepEqual(busca(""), [1, 2, 3]);
  assert.deepEqual(busca("   "), [1, 2, 3]);
  assert.deepEqual(busca("SERVICO"), [1, 2], "sem diferença de maiúsculas e acentos (acha “serviços” e “Serviço”)");
  assert.deepEqual(busca("SERVICO DE ROTINAS"), [2], "sem diferença de maiúsculas e acentos");
  assert.deepEqual(busca("jose antonio"), [3]);
  assert.deepEqual(busca("fila conta"), [1, 2], "várias palavras: todas, em qualquer ordem e campo");
  assert.deepEqual(busca("exemplo fora"), [], "todas precisam aparecer");
  assert.deepEqual(busca("7"), [1, 2]);
  assert.deepEqual(busca("conta 7"), [1], "a frase inteira ganha: não traz a 7ª da fila");
  assert.deepEqual(busca("em uso"), [1], 'a frase inteira ganha: não traz "sem leitura de uso"');

  // Serviços: linhas que abrem e fecham, como as contas (botão com aria-expanded/aria-controls; aberto só na memória).
  assert.match(html, /<div id="devices" class="services">/);
  assert.ok(!/deviceTile|class="tiles"|"card tile/.test(html + js), "sobrou a grade de quadradinhos");
  assert.match(js, /const svcExpanded = new Set\(\);/);
  assert.match(js, /"aria-controls": o\.id\("body"\)/);
  assert.match(js, /class: "abody sbody", id: id\("body"\), hidden: !open/);
  assert.match(js, /rowUsage\(o\.acc, `Conta \$\{o\.acc\.number\}`\)/, "a linha do serviço usa a mesma barra única das contas");
  assert.match(css, /\.accounts,\n\.services \{[^}]*grid-template-columns: minmax\(0, 1fr\)/, "contas e serviços: uma coluna");

  // Usuários: tabela com cabeçalhos que ordenam, liberar com a mensagem no lugar e "Tirar" confirmado na linha.
  const cabecalhos = [...html.matchAll(/<th scope="col" data-sort="([a-z]+)" aria-sort="[a-z]+"><button type="button" class="thsort">([^<]+)<\/button><\/th>/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(cabecalhos, [
    ["email", "Usuário"],
    ["role", "Situação"],
    ["services", "Serviços"],
  ]);
  assert.match(html, /<input type="email" id="allowEmail"[^>]*aria-describedby="allowMsg allowHint">/);
  assert.match(html, /<p id="allowMsg" class="fieldmsg hidden" role="status"><\/p>/);
  assert.match(html, /<p id="usersStatus" class="fieldmsg tablemsg hidden" role="status" tabindex="-1"><\/p>/);
  assert.match(js, /const ROLE_LABEL = \{ admin: "Administrador", user: "Liberado", gone: "Não liberado" \};/);
  const usuarios = js.slice(js.indexOf("\n  function userRows() {"), js.indexOf("\n  function renderGoogleInfo() {"));
  assert.ok(usuarios.length > 2000, "não achei o trecho da aba Usuários no app.js");
  assert.ok(!/confirmBox\(|window\.confirm|toast\(/.test(usuarios), "Usuários: confirmação e mensagens no lugar (sem janela nem aviso flutuante)");
  assert.match(usuarios, /"data-k": `user-yes-\$\{r\.key\}`, text: "Tirar usuário"/);
  assert.match(usuarios, /"data-k": `user-no-\$\{r\.key\}`, text: "Cancelar"/);
  for (const rota of ['api("POST", "/web/api/allowed", { email', 'api("DELETE", `/web/api/allowed/${encodeURIComponent(r.email)}`)']) {
    assert.ok(usuarios.includes(rota), `Usuários usa a rota que já existe: ${rota}`);
  }
  assert.deepEqual([...new Set([...usuarios.matchAll(/api\("([A-Z]+)", [`"](\/web\/api\/[a-z]+)/g)].map((m) => `${m[1]} ${m[2]}`))].sort(), ["DELETE /web/api/allowed", "POST /web/api/allowed"], "nenhuma rota inventada");
  // No celular a tabela vira cartões empilhados: o cabeçalho some e cada dado leva o nome da coluna.
  const celular = css.slice(css.indexOf("@media (max-width: 720px)"), css.indexOf("@media (max-width: 480px)"));
  assert.match(celular, /\.utable thead \{ display: none; \}/);
  assert.match(celular, /\.utable td\[data-label\]::before \{ content: attr\(data-label\) ": "/);
});

// 2.5.3: a presença dos serviços — quatro situações com os textos exatos, o resumo, a ordem, a busca e as bolinhas.
// Lê os arquivos de verdade e roda aqui o trecho de presença do app.js (são funções sem tela).
test("painel de verdade (server/web), 2.5.3: presença dos serviços (ativo agora, conectado, aguardando contato, sem contato) nos textos, no resumo, na ordem e na busca", () => {
  const webDir = path.join(__dirname, "..", "web");
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8").replace(/\r\n/g, "\n");
  const js = fs.readFileSync(path.join(webDir, "app.js"), "utf8").replace(/\r\n/g, "\n");
  const css = fs.readFileSync(path.join(webDir, "app.css"), "utf8").replace(/\r\n/g, "\n");

  const ini = js.indexOf("\n  // ------------------------------------------------------------ presença dos serviços");
  const fim = js.indexOf("\n  // ------------------------------------------------------------ ", ini + 10);
  assert.ok(ini > 0 && fim > ini, "não achei o trecho de presença no app.js");
  // O que o trecho usa do resto do app.js: hasOwn, fmtWhen (aqui um de mentira, para ver qual data ele recebe) e devName.
  const hasOwn = (o, k) => o !== null && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, k);
  const fmtWhen = (v) => (v ? `<${v}>` : null);
  const devName = (d) => d.name || "Serviço sem nome";
  const P = new Function("hasOwn", "fmtWhen", "devName", `${js.slice(ini, fim)}\nreturn { PRESENCE, presenceOf, presenceParts, presenceText, byPresence, servicesSummary };`)(hasOwn, fmtWhen, devName);

  // A situação é a que o servidor manda (presence). Servidor antigo, sem o campo (ou com um valor estranho): sai de active/connected.
  assert.deepEqual(Object.keys(P.PRESENCE), ["active", "connected", "waiting", "none"]);
  for (const p of ["active", "connected", "waiting", "none"]) assert.equal(P.presenceOf({ presence: p, active: p !== "active" }), p);
  assert.equal(P.presenceOf({ active: true }), "active");
  assert.equal(P.presenceOf({ active: false, connected: true }), "connected");
  assert.equal(P.presenceOf({ active: false }), "none");
  assert.equal(P.presenceOf({ presence: "dormindo", active: false, connected: true }), "connected");
  assert.equal(P.presenceOf({ presence: "constructor" }), "none");

  // Os textos, exatos.
  const d = (presence, extra = {}) => ({ name: "X", presence, ...extra });
  assert.equal(P.presenceText(d("active", { lastContact: 222 })), "ativo agora");
  assert.equal(P.presenceText(d("connected", { lastContact: 222 })), "conectado · sem uso agora");
  assert.equal(P.presenceText(d("waiting", { lastContact: 222 })), "aguardando contato · o servidor reiniciou há pouco");
  assert.equal(P.presenceText(d("none", { lastContact: 222, lastSeen: 111 })), "sem contato · visto <222>", "a data é a do último contato, não a do último uso");
  assert.equal(P.presenceText(d("none", { lastSeen: 111 })), "sem contato · visto <111>", "servidor antigo, sem lastContact: o lastSeen");
  assert.equal(P.presenceText(d("none", { lastContact: null, lastSeen: null })), "sem contato · ainda não apareceu");
  assert.deepEqual(P.presenceParts(d("active")), { p: "active", main: "ativo agora", detail: null });
  assert.deepEqual(P.presenceParts(d("connected")), { p: "connected", main: "conectado", detail: "sem uso agora" });
  assert.deepEqual(P.presenceParts(d("none", { lastContact: 5 })), { p: "none", main: "sem contato", detail: "visto <5>" });

  // O resumo: grupo vazio não aparece; singular e plural combinam; um serviço só não leva o número dentro.
  const n = (...ps) => ps.map((p, i) => ({ name: `S${i}`, presence: p }));
  assert.equal(P.servicesSummary(n("active", "active", "active", "connected", "none")), "5 serviços (3 ativos agora, 1 conectado, 1 sem contato)");
  assert.equal(P.servicesSummary(n("active")), "1 serviço (ativo agora)");
  assert.equal(P.servicesSummary(n("connected")), "1 serviço (conectado)");
  assert.equal(P.servicesSummary(n("waiting")), "1 serviço (aguardando contato)");
  assert.equal(P.servicesSummary(n("none")), "1 serviço (sem contato)");
  assert.equal(P.servicesSummary(n("connected", "connected")), "2 serviços (2 conectados)");
  assert.equal(P.servicesSummary(n("none", "active", "none")), "3 serviços (1 ativo agora, 2 sem contato)");
  assert.equal(P.servicesSummary(n("none", "waiting", "active", "waiting", "connected", "connected")), "6 serviços (1 ativo agora, 2 conectados, 2 aguardando contato, 1 sem contato)");
  assert.equal(P.servicesSummary([{ active: true }, { active: false }]), "2 serviços (1 ativo agora, 1 sem contato)", "servidor antigo");
  assert.equal(P.servicesSummary([]), "nenhum serviço");

  // A ordem da aba: ativos, conectados, aguardando contato, sem contato; dentro de cada grupo, por nome.
  const lista = [
    { name: "Zeta", presence: "none" },
    { name: "Beta", presence: "waiting" },
    { name: "Alfa", presence: "none" },
    { name: "Hermes", presence: "connected" },
    { name: "Mac", presence: "active" },
    { name: "Ábaco", presence: "active" },
    { name: "Delta", presence: "connected" },
  ];
  assert.deepEqual([...lista].sort(P.byPresence).map((x) => x.name), ["Ábaco", "Mac", "Delta", "Hermes", "Beta", "Alfa", "Zeta"]);

  // A tela usa essas funções: no resumo, na ordem, na busca, na bolinha e nos dois lugares do contato (linha e cartão).
  assert.match(js, /\n      servicesSummary\(devices\(\)\),\n/, "resumo");
  assert.match(js, /const list = \[\.\.\.devices\(\)\]\.sort\(byPresence\);/, "ordem da aba");
  const palavras = /\n  function serviceWords\(d\) \{[\s\S]*?\n  \}\n/.exec(js);
  assert.ok(palavras && /\n      presenceText\(d\),\n/.test(palavras[0]), "a busca dos serviços olha o texto da situação");
  const linha = /\n  function serviceRow\(d, o\) \{[\s\S]*?\n  \}\n/.exec(js);
  assert.ok(linha && /const pr = presenceParts\(d\);/.test(linha[0]) && /text: pr\.main/.test(linha[0]) && /class: "when", text: pr\.detail/.test(linha[0]), "linha do serviço: situação e detalhe");
  assert.match(linha[0], /class: "dot" \+ \(dot \? ` \$\{dot\}` : ""\)/, "a bolinha leva a cor da situação");
  assert.match(js, /h\("dd", \{ class: pr\.p === "active" \? "oktext" : null, text: presenceText\(d\) \}\)/, "cartão aberto: o texto inteiro");

  // Uma bolinha para cada situação, nos dois temas: verde (ativo), azul (conectado), contorno cinza (aguardando) e
  // a cinza cheia de sempre (sem contato).
  assert.deepEqual(Object.values(P.PRESENCE).map((x) => x.dot), ["on", "conn", "wait", ""]);
  assert.match(css, /\n\.dot \{[^}]*background: var\(--soft\)/);
  assert.match(css, /\n\.dot\.on \{[^}]*background: var\(--okfill\)/);
  assert.match(css, /\n\.dot\.conn \{[^}]*background: var\(--conn\)/);
  assert.match(css, /\n\.dot\.wait \{[^}]*background: transparent;[^}]*box-shadow: inset 0 0 0 2px var\(--soft\)/);
  const temaClaro = css.indexOf("@media (prefers-color-scheme: light)");
  const base = css.indexOf("/* ------------------------------------------------------------ base */");
  assert.ok(temaClaro > 0 && base > temaClaro);
  assert.match(css.slice(0, temaClaro), /\n  --conn: #[0-9a-f]{6};/, "azul do conectado no tema escuro");
  assert.match(css.slice(temaClaro, base), /\n    --conn: #[0-9a-f]{6};/, "azul do conectado no tema claro");

  // A legenda das quatro situações, na aba Serviços, com a mesma bolinha de cada uma.
  const aba = html.slice(html.indexOf('<section class="sec" id="sec-computadores"'), html.indexOf('<section class="sec" id="sec-usuarios"'));
  for (const [dot, nome] of [["dot on", "ativo agora"], ["dot conn", "conectado · sem uso agora"], ["dot wait", "aguardando contato"], ["dot", "sem contato"]]) {
    assert.ok(aba.includes(`<span class="${dot}" aria-hidden="true"></span><b>${nome}</b>`), `legenda: ${nome}`);
  }

  // A palavra "parado" saiu do painel.
  for (const [nome, texto] of [["index.html", html], ["app.js", js], ["app.css", css]]) {
    assert.ok(!/\bparad[oa]s?\b/i.test(texto), `${nome}: sobrou “parado”`);
  }

  // Histórico: a etiqueta do tipo leva o próprio tipo como classe ("kind info", "kind device"…). A grade de dados do
  // cartão da conta também se chama "info": o estilo dela vale só para o <dl> (senão a etiqueta "Info" ganha borda e espaço).
  assert.match(js, /h\("span", \{ class: "kind " \+ kind\.replace\(/);
  assert.match(css, /\ndl\.info \{\n  display: grid;/);
  assert.ok(!/(^|[\n,}]\s*)\.info\s*[,{]/.test(css), "app.css: seletor .info solto (pega a etiqueta “Info” do Histórico)");
});

// 2.5.3: tudo o que está conectado ao Swap é um "serviço". A palavra antiga só fica nos identificadores (id da seção,
// âncora, chaves do código) e onde é mesmo a máquina em que a pessoa está sentada.
test("painel e servidor de verdade, 2.5.3: “serviço” no lugar de “computador” (a palavra antiga só nos identificadores e na máquina da pessoa)", () => {
  const webDir = path.join(__dirname, "..", "web");
  const srcDir = path.join(__dirname, "..", "src");
  const ler = (dir, nome) => fs.readFileSync(path.join(dir, nome), "utf8").replace(/\r\n/g, "\n");
  const html = ler(webDir, "index.html");
  const js = ler(webDir, "app.js");

  // Rótulos fixos do painel.
  assert.match(html, /<legend>Serviços<\/legend>\n\s*<p class="hint">Vale para os serviços ativos agora\./, 'regra "Serviços: Separados / Juntos"');
  assert.match(html, /<span class="name">Separados <span class="tag">padrão<\/span><\/span>/);
  assert.match(html, /<span class="name">Juntos<\/span>/);
  assert.match(html, /<h3>Conectar um serviço<\/h3>/);
  assert.equal((js.match(/h\("legend", \{ text: "Serviços permitidos" \}\)/g) || []).length, 2, "Ajustes desta conta › Serviços permitidos");
  assert.match(js, /fact\("Serviços permitidos", permitted,/);
  assert.match(js, /fact\("Serviços nela",/);
  assert.match(js, /devs\.length === 1 \? "Em 1 serviço" : `Em \$\{devs\.length\} serviços`/, 'linha da conta: "Em 1 serviço" / "Em N serviços"');
  assert.match(js, /\n    device: "Serviço",\n/, "tipo do histórico");
  assert.match(js, /const devName = \(d\) => \(d && d\.name\) \|\| "Serviço sem nome";/);

  // O que manda a pessoa para a extensão usa os nomes novos dela: comando "Swap Plus: Configurações" e cartão "Conexão".
  assert.ok(html.includes("(comando “Swap Plus: Configurações”) e, no cartão “Conexão”, clique em <b>Entrar com Google</b>"));
  assert.ok(html.includes("(no mesmo cartão “Conexão”)"));
  assert.ok(js.includes("clique em “Entrar com Google” no cartão “Conexão”"));
  assert.ok(ler(srcDir, "server.js").includes("clique em Entrar com Google no cartão “Conexão”."));
  const fontes = fs.readdirSync(srcDir).filter((f) => f.endsWith(".js")).map((f) => [`src/${f}`, ler(srcDir, f)]);
  const tudo = [["web/index.html", html], ["web/app.js", js], ["web/app.css", ler(webDir, "app.css")], ...fontes];
  for (const [nome, texto] of tudo) {
    assert.ok(!/Configurar trocas automáticas|cartão “Servidor”/.test(texto), `${nome}: sobrou o nome antigo da tela ou do cartão da extensão`);
  }

  // A palavra antiga, arquivo por arquivo: tirando o que pode ficar (identificadores e a máquina da pessoa), não sobra nada.
  const PODE = {
    "web/index.html": [
      // ids e âncoras da aba (não mudam: endereços e ?next= antigos continuam valendo)
      '"computadores"',
      "tab-computadores",
      "sec-computadores",
      "h-computadores",
      "count-computadores",
      "qx-computadores",
      "qn-computadores",
      "q-computadores",
      // a máquina em que a pessoa está
      "No computador, abra o VS Code",
      "um arquivo no seu computador",
    ],
    "web/app.js": ['"computadores"', 'computadores: ""', 'computadores: "devices"', "filters.computadores", "count-computadores", '"#computadores"', "no computador, abra o VS Code"],
    "src/server.js": ['"geral", "computadores", "regras"'], // nomes de aba aceitos em /web/login?next=
    "src/web.js": ["um arquivo no seu computador"], // o conselho do kit de recuperação
  };
  for (const [nome, texto] of tudo) {
    let resto = texto;
    for (const p of PODE[nome] || []) {
      assert.ok(resto.includes(p), `${nome}: não achei o trecho permitido “${p}”`);
      resto = resto.split(p).join("");
    }
    const sobras = resto.split("\n").filter((l) => /computador/i.test(l)).map((l) => l.trim().slice(0, 140));
    assert.deepEqual(sobras, [], `${nome}: “computador” onde devia ser “serviço”`);
  }
  // ...e os identificadores não mudaram de nome (endereços #computadores e ?next=computadores continuam valendo).
  assert.match(html, /<section class="sec" id="sec-computadores" data-sec="computadores" aria-labelledby="h-computadores">/);
  assert.match(js, /const SECTIONS = \["contas", "computadores", "usuarios"\];/);
  assert.match(ler(srcDir, "server.js"), /const PANEL_SECTIONS = new Set\(\["geral", "computadores", "regras", "acesso", "historico"\]\);/);
});

test("painel de verdade (server/web), 2.5.6: campo “Mínimo de Fable sobrando no destino” nas regras de troca (mostra, valida e envia preferMinFreePct)", () => {
  const webDir = path.join(__dirname, "..", "web");
  const html = fs.readFileSync(path.join(webDir, "index.html"), "utf8").replace(/\r\n/g, "\n");
  const js = fs.readFileSync(path.join(webDir, "app.js"), "utf8").replace(/\r\n/g, "\n");

  // O campo, logo depois da "Margem da conta de destino", dentro dos "Ajustes finos".
  const fine = html.slice(html.indexOf('<fieldset class="card r-fine">'), html.indexOf('<div class="savebar">'));
  const ids = [...fine.matchAll(/<input type="number" id="(r[A-Za-z]+)" name="([A-Za-z]+)" min="(\d+)" max="(\d+)" step="1"/g)].map((m) => m.slice(1, 5));
  assert.deepEqual(ids, [
    ["rExpiring", "expiringHours", "1", "168"],
    ["rCooldown", "cooldownMin", "0", "240"],
    ["rMargin", "marginPct", "0", "30"],
    ["rPreferMin", "preferMinFreePct", "0", "50"],
  ]);
  assert.match(fine, /<label for="rPreferMin">Mínimo de Fable sobrando no destino<\/label>/);
  assert.match(fine, /id="rPreferMin"[^>]*aria-describedby="rPreferMinHint"><span class="unit" aria-hidden="true">%<\/span>/);
  const hint = /<small class="hint" id="rPreferMinHint">([^]*?)<\/small>/.exec(fine)[1];
  assert.equal(
    hint,
    'Numa troca que o servidor faz por conta própria (para aproveitar uma cota que vai zerar ou para renovar um login), a conta de destino precisa ter pelo menos isso do Fable sobrando. Troca obrigatória (conta na linha ou limite batido) não olha este número. De 0 a 50. Padrão: <span data-def="preferMinFreePct">10</span>.'
  );

  // app.js: a regra entra em tudo o que o formulário faz com as outras numéricas.
  const { RULE_DEFAULTS: REAL } = require("../../plus/rules");
  assert.equal(REAL.preferMinFreePct, 10);
  assert.match(js, /\n {4}preferMinFreePct: 10,/, "padrão no painel (igual ao do plus/rules.js)");
  const keys = JSON.parse(/const RULE_KEYS = (\[[^\]]+\]);/.exec(js)[1]);
  assert.ok(keys.includes("preferMinFreePct"), "RULE_KEYS: comparar, detectar mudança e enviar");
  assert.deepEqual(keys.filter((k) => !(k in REAL)), [], "toda regra do painel existe no plus/rules.js (senão o servidor a ignora)");
  assert.match(js, /\{ key: "preferMinFreePct", id: "rPreferMin", label: "Mínimo de Fable sobrando no destino", min: 0, max: 50 \}/, "NUM_FIELDS: preencher e validar a faixa");
  assert.match(js, /preferMinFreePct: numVal\(\$\("rPreferMin"\)\),/, "readRulesForm lê o campo");
  // Todo campo numérico do formulário tem a sua linha em NUM_FIELDS e é lido no readRulesForm.
  for (const [id, key] of ids) {
    assert.ok(js.includes(`{ key: "${key}", id: "${id}",`), `NUM_FIELDS sem ${key}`);
    assert.ok(js.includes(`${key}: numVal($("${id}")),`), `readRulesForm sem ${key}`);
  }
});

test("versão: server.js e engine.js dizem a mesma (é a do rodapé do painel)", () => {
  const { VERSION } = require("../src/server");
  assert.match(VERSION, /^\d+\.\d+\.\d+$/);
  assert.equal(require("../src/engine").VERSION, VERSION);
});

test("painel: 60 respostas 401 em 10 min bloqueiam só o painel (os serviços seguem); /web/login 20 por IP", async (t) => {
  const ctx = await setup(t);
  const { s } = await webLogin(ctx, "ana@exemplo.com");
  const devToken = crypto.randomBytes(32).toString("base64url");
  ctx.tokens.push(devToken);
  ctx.store.state.devices = { d1: dispositivo("d1", "Notebook", ctx.clock.t, { tokenHash: sha256(devToken) }) };

  for (let i = 1; i <= 60; i++) {
    const r = await call(ctx, "GET", "/web/api/me");
    assert.equal(r.status, 401, `pedido ${i}`);
  }
  let r = await call(ctx, "GET", "/web/api/me");
  assert.equal(r.status, 429);
  assert.equal(r.json.error, "too_many_attempts");
  assert.ok(Number(r.headers["retry-after"]) > 0);
  r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.status, 429, "o painel fica bloqueado para o IP inteiro");
  // os serviços não são afetados (contador à parte)
  r = await call(ctx, "GET", "/v1/health");
  assert.equal(r.status, 200);
  r = await call(ctx, "GET", "/v1/state", { headers: { authorization: `Bearer ${devToken}` } });
  assert.equal(r.status, 200, r.text);
  // passados 10 min, volta
  ctx.clock.t += 10 * MIN + 1;
  r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.status, 200);

  // /web/login: 20 por IP em 10 min (atrás do proxy, pelo X-Forwarded-For)
  const px = await setup(t, { env: { TRUST_PROXY: "1" } });
  const de = (ip) => ({ "x-forwarded-for": ip });
  for (let i = 1; i <= 20; i++) {
    r = await call(px, "GET", "/web/login", { headers: de("203.0.113.5") });
    assert.equal(r.status, 302, `login ${i}`);
  }
  r = await call(px, "GET", "/web/login", { headers: de("203.0.113.5") });
  assertPage(r, 429);
  assert.ok(Number(r.headers["retry-after"]) > 0);
  r = await call(px, "GET", "/web/login", { headers: de("203.0.113.6") });
  assert.equal(r.status, 302);
  // os logins do painel não ocupam a vez dos serviços
  r = await call(px, "POST", "/v1/login/start", { body: { name: "PC", platform: "linux" }, origin: null, headers: de("198.51.100.1") });
  assert.equal(r.status, 200, r.text);
  // o IP guardado na sessão é o do cliente (X-Forwarded-For)
  const b = await webLogin(px, "ana@exemplo.com", { headers: de("198.51.100.77") });
  assert.equal(px.store.state.webSessions[b.s.id].ip, "198.51.100.77");
});

test("admin: login-expires chama engine.setLoginExpiresAt; invalid → 400, not_found → 404; o painel mostra a validade", async (t) => {
  const ctx = await setup(t);
  const E = ctx.engine;
  const at = "2026-12-01T18:00:00-03:00";
  const ms = Date.parse(at);
  let r = await adminCall(ctx, "POST", "/admin/accounts/2/login-expires", { body: { at } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json, { ok: true, number: 2, loginExpiresAt: ms });
  assert.deepEqual(E.last("setLoginExpiresAt").args, [2, ms]);

  r = await adminCall(ctx, "POST", "/admin/accounts/2/login-expires", { body: { at: "ontem" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "bad_request");
  r = await adminCall(ctx, "POST", "/admin/accounts/2/login-expires", { body: {} });
  assert.equal(r.status, 400);
  r = await adminCall(ctx, "POST", "/admin/accounts/2/login-expires", { body: { at: 1764622800000 } });
  assert.equal(r.status, 400, "só texto ISO");
  r = await adminCall(ctx, "POST", "/admin/accounts/2/login-expires", { body: { at: "2001-01-01T00:00:00Z" } });
  assert.equal(r.status, 400);
  assert.equal(r.json.error, "invalid", "erro invalid do motor → 400");
  r = await adminCall(ctx, "POST", "/admin/accounts/99/login-expires", { body: { at } });
  assert.equal(r.status, 404);
  E.setLoginError = "not_found";
  r = await adminCall(ctx, "POST", "/admin/accounts/1/login-expires", { body: { at } });
  assert.equal(r.status, 404, "not_found do motor → 404");
  E.setLoginError = null;
  const chamadas = E.count("setLoginExpiresAt");
  r = await adminCall(ctx, "POST", "/admin/accounts/2/login-expires", { body: { at }, origin: "https://site.exemplo" });
  assert.equal(r.status, 403, "o admin não aceita navegador");
  assert.equal(E.count("setLoginExpiresAt"), chamadas);

  // status do admin e PanelState mostram a validade (sem token)
  r = await adminCall(ctx, "GET", "/admin/status");
  assert.equal(r.json.accounts.find((a) => a.number === 2).loginExpiresAt, ms);
  const { s } = await webLogin(ctx, "ana@exemplo.com");
  r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.json.accounts.find((a) => a.number === 2).loginExpiresAt, ms);
});

test("painel: serviços permitidos por conta (PUT /web/api/accounts/:n/devices) e PanelState com devices/allowedAccounts", async (t) => {
  const ctx = await setup(t);
  const E = ctx.engine;
  const T = ctx.clock.t;
  ctx.store.state.devices = {
    d1: dispositivo("d1", "Mac", T, { assigned: 1 }),
    d2: dispositivo("d2", "Windows", T),
  };
  const { s } = await webLogin(ctx, ADMIN);
  const me = ADMIN;
  const acc = (r, n) => r.json.state.accounts.find((a) => a.number === n);
  const dev = (r, id) => r.json.state.devices.find((d) => d.id === id);

  // Começo: todas as contas para todos os serviços.
  let r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.status, 200, r.text);
  assert.ok(r.json.accounts.every((a) => a.devices === null));
  assert.ok(r.json.devices.every((d) => JSON.stringify(d.allowedAccounts) === "[1,2,3]"));

  // Conta 1 só no Mac.
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: { devices: ["d1"] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("setAccountDevices").args, [1, ["d1"]]);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.number, 1);
  assert.deepEqual(r.json.devices, ["d1"]);
  assert.deepEqual(acc(r, 1).devices, ["d1"]);
  assert.equal(acc(r, 2).devices, null);
  assert.deepEqual(dev(r, "d1").allowedAccounts, [1, 2, 3]);
  assert.deepEqual(dev(r, "d2").allowedAccounts, [2, 3]);
  assert.equal(ctx.store.state.history[0].text, `Serviços da conta 1 ajustados pelo painel (${me}): "Mac"`);
  assert.deepEqual(cofreEmDisco(ctx).accountDevices, { 1: ["d1"] }, "gravado");

  // Nenhum serviço ([]) e de volta a todos (null escrito).
  r = await call(ctx, "PUT", "/web/api/accounts/2/devices", { s, body: { devices: [] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.devices, []);
  assert.deepEqual(acc(r, 2).devices, []);
  assert.deepEqual(dev(r, "d2").allowedAccounts, [3]);
  assert.equal(ctx.store.state.history[0].text, `Serviços da conta 2 ajustados pelo painel (${me}): nenhum serviço`);
  r = await call(ctx, "PUT", "/web/api/accounts/2/devices", { s, body: { devices: null } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.devices, null);
  assert.equal(acc(r, 2).devices, null);
  assert.deepEqual(dev(r, "d2").allowedAccounts, [2, 3]);
  assert.equal(ctx.store.state.history[0].text, `Serviços da conta 2 ajustados pelo painel (${me}): todos os serviços`);

  // Erros: sem a chave devices → 400 (null precisa vir escrito); lista inválida → 400 com a mensagem do motor;
  // conta que não existe → 404; sem Origin / sem CSRF → 403. Nada muda.
  const calls0 = E.count("setAccountDevices");
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: {} });
  assert.equal(r.status, 400, r.text);
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: { devices: "d1" } });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, "invalid");
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: { devices: ["d1", "nao-existe"] } });
  assert.equal(r.status, 400, r.text);
  assert.equal(r.json.error, "invalid");
  assert.match(r.json.message, /"nao-existe" não existe/);
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: { devices: ["d1", "d1"] } });
  assert.equal(r.status, 400, r.text);
  r = await call(ctx, "PUT", "/web/api/accounts/99/devices", { s, body: { devices: null } });
  assert.equal(r.status, 404, r.text);
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: { devices: null }, origin: null });
  assert.equal(r.status, 403);
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { s, body: { devices: null }, csrf: null });
  assert.equal(r.status, 403);
  r = await call(ctx, "PUT", "/web/api/accounts/1/devices", { body: { devices: null } });
  assert.equal(r.status, 401);
  r = await call(ctx, "GET", "/web/api/accounts/1/devices", { s });
  assert.equal(r.status, 405);
  assert.equal(E.count("setAccountDevices"), calls0 + 3, "só as listas inválidas chegaram ao motor");
  assert.deepEqual(ctx.store.state.accountDevices, { 1: ["d1"] }, "nada mudou");

  // Trocar o Windows para a conta 1 (não liberada para ele) pelo painel → 409 not_allowed.
  r = await call(ctx, "POST", "/web/api/devices/d2/switch", { s, body: { number: 1 } });
  assert.equal(r.status, 409, r.text);
  assert.equal(r.json.error, "not_allowed");
  assert.match(r.json.message, /não está liberada para este serviço/);
  assert.equal(ctx.store.state.devices.d2.assigned, null);

  // Desconectar o Mac tira ele da lista (que fica vazia: nenhum serviço, nunca "todos").
  r = await call(ctx, "DELETE", "/web/api/devices/d1", { s });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(acc(r, 1).devices, []);
  assert.deepEqual(dev(r, "d2").allowedAccounts, [2, 3]);
  assert.deepEqual(cofreEmDisco(ctx).accountDevices, { 1: [] });
});

test("painel: renomear serviço (PATCH /web/api/devices/:id { name }): 1 a 60 caracteres, sem controle; histórico", async (t) => {
  const ctx = await setup(t);
  const T = ctx.clock.t;
  ctx.store.state.devices = { d2: dispositivo("d2", "Windows", T) };
  const { s } = await webLogin(ctx, ADMIN);
  const me = ADMIN;

  let r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: "  PC da sala  " } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.id, "d2");
  assert.equal(r.json.name, "PC da sala");
  assert.equal(ctx.store.state.devices.d2.name, "PC da sala");
  assert.equal(r.json.state.devices.find((d) => d.id === "d2").name, "PC da sala");
  assert.equal(cofreEmDisco(ctx).devices.d2.name, "PC da sala", "gravado");
  const h = ctx.store.state.history[0];
  assert.deepEqual(h, { ts: h.ts, kind: "info", text: `Serviço "Windows" renomeado para "PC da sala" pelo painel (${me})`, device: "d2", deviceName: "PC da sala" });

  // Inválidos → 400 e nada muda.
  const ruins = ["", "   ", "x".repeat(61), "com\nquebra", "com\ttab", "nul\u0000", "‮esrever", 123, null, ["a"]];
  for (const name of ruins) {
    r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name } });
    assert.equal(r.status, 400, `${JSON.stringify(name)}: ${r.text}`);
  }
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: {} });
  assert.equal(r.status, 400);
  assert.equal(ctx.store.state.devices.d2.name, "PC da sala");
  // As mensagens falam em "serviço" (o painel mostra a mensagem do servidor como aviso).
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: "x".repeat(61) } });
  assert.equal(r.json.message, "o nome do serviço precisa ter de 1 a 60 caracteres");
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: "com\nquebra" } });
  assert.equal(r.json.message, "o nome do serviço não pode ter quebra de linha, tabulação nem caracteres de controle");

  // 60 caracteres (acento conta como um) servem; o mesmo nome de novo não repete no histórico.
  const quarenta = "é".repeat(60);
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: quarenta } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.devices.d2.name, quarenta);
  const n0 = ctx.store.state.history.length;
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: ` ${quarenta} ` } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.history.length, n0);

  // Serviço que não existe → 404; sem Origin / sem CSRF / sem sessão → recusado.
  r = await call(ctx, "PATCH", "/web/api/devices/nao-existe", { s, body: { name: "X" } });
  assert.equal(r.status, 404);
  assert.deepEqual(r.json, { error: "not_found", message: "serviço não encontrado" });
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: "Y" }, origin: null });
  assert.equal(r.status, 403);
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { s, body: { name: "Y" }, csrf: null });
  assert.equal(r.status, 403);
  r = await call(ctx, "PATCH", "/web/api/devices/d2", { body: { name: "Y" } });
  assert.equal(r.status, 401);
  assert.equal(ctx.store.state.devices.d2.name, quarenta);
});

// ---------------------------------------------------------------------------
// 2.6.0 — modelo preferido e modelo secundário, com o catálogo completo e o esforço de cada um
// ---------------------------------------------------------------------------

test("painel 2.6.0: o estado leva o catálogo de modelos; “Atualizar modelos” lê na hora; as regras de modelo e esforço chegam ao motor", async (t) => {
  const ctx = await setup(t);
  const E = ctx.engine;
  const T = ctx.clock.t;
  const lista = [
    { id: "claude-fable-5-2", name: "Claude Fable 5.2", line: "fable", createdAt: "2026-11-09T18:30:00Z", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5", line: "opus", createdAt: "2026-10-20T00:00:00Z", efforts: ["low", "medium", "high", "xhigh", "max"] },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", line: "haiku", createdAt: "2026-10-21T00:00:00Z", efforts: ["low", "medium", "high"] },
  ];
  let catalogo = { fetchedAt: T - 3600 * 1000, builtin: false, list: lista };
  let proxima = { ok: true, count: 4, fetchedAt: T };
  E.modelCatalog = () => catalogo;
  E.refreshModels = async () => {
    E.rec("refreshModels");
    if (proxima.ok) catalogo = { fetchedAt: proxima.fetchedAt, builtin: false, list: [...lista, { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", line: "sonnet", createdAt: null, efforts: ["low"] }] };
    return proxima;
  };
  const { s } = await webLogin(ctx, "ana@exemplo.com");

  // O estado leva o catálogo inteiro (é o que os dois seletores listam) e os padrões das regras novas.
  let r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.json.models, catalogo);
  assert.deepEqual(
    [r.json.rules.primaryModel, r.json.rules.primaryEffort, r.json.rules.secondaryModel, r.json.rules.secondaryEffort],
    ["claude-fable-5-2", "", "claude-opus-5-5", ""]
  );
  assert.deepEqual([r.json.ruleDefaults.primaryModel, r.json.ruleDefaults.secondaryModel], ["claude-fable-5-2", "claude-opus-5-5"]);

  // Botão “Atualizar modelos”: é uma ação (pede o CSRF, como as outras), chama o motor e devolve o estado novo.
  r = await call(ctx, "POST", "/web/api/models/refresh", { s, body: {}, csrf: "errado" });
  assert.equal(r.status, 403, "sem o CSRF certo, não");
  assert.equal(E.count("refreshModels"), 0);
  r = await call(ctx, "POST", "/web/api/models/refresh", { s, body: {} });
  assert.equal(r.status, 200, r.text);
  assert.equal(E.count("refreshModels"), 1);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.count, 4);
  assert.equal(r.json.message, "Lista de modelos atualizada: 4 modelos.");
  assert.equal(r.json.state.models.list.length, 4);
  assert.equal(r.json.state.models.fetchedAt, T);
  // Falhou: 502 com o motivo em português, e a lista de antes continua.
  for (const [error, re] of [
    ["no_account", /nenhuma conta está com o acesso valendo para fazer a consulta/],
    ["unauthorized", /a Anthropic recusou o acesso da conta usada na consulta/],
    ["rate_limited", /a Anthropic pediu para esperar/],
    ["bad_response", /a resposta da Anthropic veio num formato inesperado/],
    ["transient", /a Anthropic não respondeu/],
  ]) {
    proxima = { ok: false, error, status: 0 };
    r = await call(ctx, "POST", "/web/api/models/refresh", { s, body: {} });
    assert.equal(r.status, 502, error);
    assert.equal(r.json.error, "models_unavailable");
    assert.match(r.json.message, re);
    assert.match(r.json.message, /^Não consegui atualizar a lista de modelos: .*\. A lista de antes continua valendo\.$/);
  }
  r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.json.models.list.length, 4);
  // Quem não entrou no painel não atualiza nada.
  r = await call(ctx, "POST", "/web/api/models/refresh", { body: {} });
  assert.equal(r.status, 401);

  // As regras novas são texto curto: passam pelo mesmo PUT das outras e chegam ao motor como vieram.
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { primaryModel: "claude-fable-5-2", primaryEffort: "xhigh", secondaryModel: "claude-opus-5-5", secondaryEffort: "high" } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(E.last("setRules").args[0].rules, { primaryModel: "claude-fable-5-2", primaryEffort: "xhigh", secondaryModel: "claude-opus-5-5", secondaryEffort: "high" });
  assert.deepEqual([r.json.state.rules.primaryEffort, r.json.state.rules.secondaryEffort], ["xhigh", "high"]);
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { secondaryEffort: "" } } });
  assert.equal(r.status, 200, "esforço vazio = não mexer");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { primaryModel: 5 } } });
  assert.equal(r.status, 400, "número no lugar do ID");
  r = await call(ctx, "PUT", "/web/api/rules", { s, body: { rules: { secondaryModel: "claude-" + "x".repeat(70) } } });
  assert.equal(r.status, 400, "texto comprido demais");
});

test("painel de verdade (server/web), 2.6.0: “Modelo preferido” e “Modelo secundário” com o esforço, a lista do catálogo e o botão “Atualizar modelos”", () => {
  const web = path.join(__dirname, "..", "web");
  const html = fs.readFileSync(path.join(web, "index.html"), "utf8");
  const js = fs.readFileSync(path.join(web, "app.js"), "utf8");
  const css = fs.readFileSync(path.join(web, "app.css"), "utf8");
  const strat = /<fieldset class="card r-strat">([^]*?)<\/fieldset>/.exec(html)[1];

  // Os quatro seletores, na ordem, dentro do cartão da estratégia (o select antigo, só com o nome do limite, saiu).
  assert.deepEqual(
    [...strat.matchAll(/<label for="(r[A-Za-z]+)">([^<]+)<\/label>\s*<select id="\1" name="([A-Za-z]+)" aria-describedby="rModelsHint"><\/select>/g)].map((m) => m.slice(1, 4)),
    [
      ["rPrimary", "Modelo preferido", "primaryModel"],
      ["rPrimaryEffort", "Esforço do modelo preferido", "primaryEffort"],
      ["rSecondary", "Modelo secundário", "secondaryModel"],
      ["rSecondaryEffort", "Esforço do modelo secundário", "secondaryEffort"],
    ]
  );
  assert.ok(!html.includes('id="rPrefer"'), "o seletor antigo saiu");
  assert.equal(
    /<small class="hint" id="rModelsHint">([^]*?)<\/small>/.exec(strat)[1],
    "O preferido é o modelo que as conversas usam e o que o Swap procura nas contas: ao trocar, contas com ele ainda disponível vêm primeiro. Quando ele acaba em todas as contas, as conversas novas abrem no secundário, com o esforço escolhido. Conversa já aberta não muda de modelo sozinha (é um limite do Claude Code). “Padrão do Claude Code” no esforço = o Swap não mexe nele."
  );
  assert.match(strat, /<span id="rModelsInfo" class="muted small" role="status"><\/span>\s*<button type="button" id="rModelsRefresh" class="secondary" data-k="models-refresh">Atualizar modelos<\/button>/);
  // Onde as regras falavam “Opus 5.5” fixo, agora vai o nome do secundário escolhido (o texto do arquivo é o padrão).
  assert.equal([...html.matchAll(/<span data-model="secondary">Opus 5\.5<\/span>/g)].length, 4);
  assert.ok(!/[^>]Opus 5\.5/.test(html.replace(/<span data-model="secondary">Opus 5\.5<\/span>/g, "")), "nenhum “Opus 5.5” fixo sobrou nas regras");

  // app.js: padrões iguais aos do plus/rules.js, as quatro regras no que o formulário compara e envia.
  const { RULE_DEFAULTS: REAL, MODEL_EFFORTS } = require("../../plus/rules");
  for (const k of ["primaryModel", "primaryEffort", "secondaryModel", "secondaryEffort"]) {
    assert.ok(js.includes(`\n    ${k}: ${JSON.stringify(REAL[k])},`), `padrão de ${k} no painel igual ao do plus/rules.js`);
  }
  const keys = JSON.parse(/const RULE_KEYS = (\[[^\]]+\]);/.exec(js)[1]);
  for (const k of ["primaryModel", "primaryEffort", "secondaryModel", "secondaryEffort"]) assert.ok(keys.includes(k), `RULE_KEYS sem ${k}`);
  assert.ok(!keys.includes("preferModel"), "preferModel não é mais editado no painel: o servidor o acerta pelo modelo preferido");
  assert.deepEqual(keys.filter((k) => !(k in REAL)), []);
  for (const [k, id] of [["primaryModel", "rPrimary"], ["primaryEffort", "rPrimaryEffort"], ["secondaryModel", "rSecondary"], ["secondaryEffort", "rSecondaryEffort"]]) {
    assert.ok(js.includes(`${k}: $("${id}").value,`), `readRulesForm sem ${k}`);
  }
  assert.deepEqual(JSON.parse(/const EFFORT_KEYS = (\[[^\]]+\]);/.exec(js)[1]), MODEL_EFFORTS, "os esforços do painel são os que o Claude Code grava");
  assert.match(js, /const EFFORT_LABELS = \{ "": "Padrão do Claude Code", low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Muito alto" \};/);
  assert.ok(js.includes('api("POST", "/web/api/models/refresh", {})'), "o botão chama a ação do servidor");
  assert.ok(js.includes('$("rModelsRefresh").addEventListener("click", refreshModels);'));
  assert.ok(js.includes('toast("O modelo preferido e o secundário precisam ser diferentes.", "error");'), "não deixa salvar os dois iguais");
  assert.ok(js.includes("· atualizados em "), "linha “N modelos · atualizados em DD/MM HH:MM”");
  assert.ok(css.includes(".r-models {"), "os campos novos têm estilo");
});

// ---------------------------------------------------------------------------
// 2.8.0: nome único ao renomear; arquivos do painel com gzip, ETag e 304
// ---------------------------------------------------------------------------

test("2.8.0 painel: renomear para o nome de OUTRO serviço → 409 name_taken; o próprio com outra caixa pode (critério 18)", async (t) => {
  const ctx = await setup(t);
  const T = ctx.clock.t;
  ctx.store.state.devices = { a: dispositivo("a", "A", T), b: dispositivo("b", "B", T + 1) };
  const { s } = await webLogin(ctx, ADMIN);
  let r = await call(ctx, "PATCH", "/web/api/devices/b", { s, body: { name: "a" } });
  assert.equal(r.status, 409, r.text);
  assert.deepEqual(r.json, { error: "name_taken", message: "Já existe um serviço com este nome; escolha outro ou desconecte o antigo no painel." });
  assert.equal(ctx.store.state.devices.b.name, "B");
  r = await call(ctx, "PATCH", "/web/api/devices/a", { s, body: { name: "a" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.devices.a.name, "a");
});

test("2.8.0 painel: duplicados de antes da regra continuam; renomear um deles para nome livre funciona (critério 19)", async (t) => {
  const ctx = await setup(t);
  const T = ctx.clock.t;
  ctx.store.state.devices = { a: dispositivo("a", "NoteWin", T), b: dispositivo("b", "NoteWin", T + 1) };
  const { s } = await webLogin(ctx, ADMIN);
  let r = await call(ctx, "GET", "/web/api/state", { s });
  assert.equal(r.json.devices.filter((d) => d.name === "NoteWin").length, 2);
  r = await call(ctx, "PATCH", "/web/api/devices/b", { s, body: { name: "NoteWin (sala)" } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.devices.a.name, "NoteWin");
});

test("2.8.0 painel: nome de 55 caracteres renomeado para outro de 55 é aceito (critério 24)", async (t) => {
  const ctx = await setup(t);
  ctx.store.state.devices = { a: dispositivo("a", "x".repeat(55), ctx.clock.t) };
  const { s } = await webLogin(ctx, ADMIN);
  const r = await call(ctx, "PATCH", "/web/api/devices/a", { s, body: { name: "y".repeat(55) } });
  assert.equal(r.status, 200, r.text);
  assert.equal(ctx.store.state.devices.a.name, "y".repeat(55));
});

test("2.8.0 painel: estáticos com gzip, ETag e 304; API sem compressão (critérios 25–27)", async (t) => {
  const zlib = require("node:zlib");
  const ctx = await setup(t);
  const cru = (p, headers) =>
    new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: ctx.api, method: "GET", path: p, headers, agent: false }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on("error", reject);
      req.end();
    });
  const arquivos = { "/": INDEX_HTML, "/static/app.js": APP_JS, "/static/app.css": APP_CSS };
  for (const [p, texto] of Object.entries(arquivos)) {
    const g = await cru(p, { "accept-encoding": "gzip, deflate, br" });
    assert.equal(g.status, 200);
    assert.equal(g.headers["content-encoding"], "gzip", p);
    assert.equal(g.headers.vary, "Accept-Encoding");
    assert.equal(g.headers["cache-control"], "no-cache");
    assert.match(g.headers.etag, /^"sha256-[0-9a-f]{16}"$/);
    assert.ok(g.headers["content-security-policy"], "cabeçalhos de segurança continuam");
    assert.equal(zlib.gunzipSync(g.body).toString("utf8"), texto);
    // Sem Accept-Encoding (ou gzip;q=0): sem compressão, mesmo ETag.
    for (const h of [{}, { "accept-encoding": "gzip;q=0" }]) {
      const n = await cru(p, h);
      assert.equal(n.headers["content-encoding"], undefined);
      assert.equal(n.body.toString("utf8"), texto);
      assert.equal(n.headers.etag, g.headers.etag);
    }
    // Reabertura: 304 sem corpo.
    for (const inm of [g.headers.etag, `W/${g.headers.etag}`, `"outro", ${g.headers.etag}`]) {
      const c = await cru(p, { "if-none-match": inm, "accept-encoding": "gzip" });
      assert.equal(c.status, 304, inm);
      assert.equal(c.body.length, 0);
      assert.equal(c.headers.etag, g.headers.etag);
    }
    assert.equal((await cru(p, { "if-none-match": '"sha256-0000000000000000"' })).status, 200);
  }
  // Arquivo mudou no disco → conteúdo e ETag novos (cache recarrega pelo mtime).
  const antes = (await cru("/static/app.js", {})).headers.etag;
  const novo = "console.log('novo');\n";
  const arq = path.join(ctx.config.webDir, "app.js");
  fs.writeFileSync(arq, novo);
  const fut = new Date(Date.now() + 5000);
  fs.utimesSync(arq, fut, fut);
  const depois = await cru("/static/app.js", { "if-none-match": antes });
  assert.equal(depois.status, 200);
  assert.equal(depois.body.toString("utf8"), novo);
  assert.notEqual(depois.headers.etag, antes);
  // A API nunca comprime (leva acesso das contas).
  for (const p of ["/v1/health", "/web/api/state"]) {
    const r = await cru(p, { "accept-encoding": "gzip" });
    assert.equal(r.headers["content-encoding"], undefined, p);
  }
});
