"use strict";
// Testes do cliente da Anthropic (server/src/anthropic.js) com um fetch de mentira.
// Nenhuma chamada de rede de verdade (o teste de redirecionamento usa um servidor em 127.0.0.1).
//
//   node --test server/test/anthropic.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const {
  createAnthropic,
  normalizeUsage,
  DEFAULT_TOKEN_URL,
  DEFAULT_API_BASE,
  MAX_RETRY_AFTER_SEC,
  MAX_EXPIRES_IN_SEC,
  TIMEOUT_MS,
  REFRESH_TIMEOUT_MS,
} = require("../src/anthropic");
const { windows } = require("../../plus/rules");

const TOKEN_URL = "https://anthropic.falsa/v1/oauth/token";
const API = "https://api.anthropic.falsa";
const NOW = Date.parse("2026-11-14T12:00:00Z");
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

function reply(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

/** Cliente com fetch falso: `answer` é uma Response, uma função (url, init) → Response, ou um Error (lançado). */
function client(answer, opts = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(url, init) : answer;
  };
  const api = createAnthropic({ tokenUrl: TOKEN_URL, apiBase: API, fetchImpl, now: () => NOW, ...opts });
  return { api, calls };
}

const CRED = {
  accessToken: "sk-ant-oat01-velho",
  refreshToken: "sk-ant-ort01-velho",
  expiresAt: NOW + 60 * 1000,
  scopes: ["user:inference"],
  subscriptionType: "max",
  rateLimitTier: "default_claude_max_20x",
};

// ------------------------------------------------------------------ refresh

test("refresh: manda client_id e refresh token e devolve a credencial nova", async () => {
  const { api, calls } = client(
    reply(200, { token_type: "Bearer", access_token: "sk-ant-oat01-novo", refresh_token: "sk-ant-ort01-novo", expires_in: 28800, scope: "user:inference user:profile" })
  );
  const r = await api.refresh(CRED);
  assert.equal(r.ok, true);
  assert.deepEqual(r.cred, {
    ...CRED,
    accessToken: "sk-ant-oat01-novo",
    refreshToken: "sk-ant-ort01-novo",
    expiresAt: NOW + 28800 * 1000,
    scopes: ["user:inference", "user:profile"],
  });
  assert.equal(r.account, undefined);
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, TOKEN_URL);
  assert.equal(init.method, "POST");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.equal(init.headers["User-Agent"], "swap-plus-server/2.0");
  assert.deepEqual(JSON.parse(init.body), { grant_type: "refresh_token", refresh_token: "sk-ant-ort01-velho", client_id: CLIENT_ID });
  assert.ok(init.signal instanceof AbortSignal, "toda chamada tem tempo máximo");
  assert.equal(init.redirect, "error", "o refresh token não segue redirecionamento");
});

test("refresh: sem refresh_token na resposta mantém o antigo; sem scope mantém os escopos", async () => {
  const { api } = client(reply(200, { access_token: "sk-ant-oat01-novo", expires_in: 3600 }));
  const r = await api.refresh(CRED);
  assert.equal(r.ok, true);
  assert.equal(r.cred.refreshToken, CRED.refreshToken);
  assert.deepEqual(r.cred.scopes, CRED.scopes);
  assert.equal(r.cred.expiresAt, NOW + 3600 * 1000);
  assert.equal(r.cred.subscriptionType, "max");
});

test("refresh: devolve a identidade que às vezes vem junto", async () => {
  const { api } = client(
    reply(200, { access_token: "a", expires_in: 10, account: { uuid: "u-1", email_address: "ana@x.com" }, organization: { uuid: "org-1" } })
  );
  const r = await api.refresh(CRED);
  assert.deepEqual(r.account, { uuid: "u-1", email: "ana@x.com", orgUuid: "org-1" });
});

test("refresh: classifica os erros (só invalid_grant/invalid_client com 400/401/403 são definitivos)", async () => {
  const cases = [
    [400, { error: "invalid_grant", error_description: "Invalid refresh token" }, "invalid_grant"],
    [401, { error: "invalid_client" }, "invalid_client"],
    [403, { error: "invalid_grant" }, "invalid_grant"],
    [400, { error: "invalid_request" }, "transient"],
    [400, "isto não é json", "transient"],
    [500, { error: "invalid_grant" }, "transient"],
    [429, { error: "rate_limited" }, "transient"],
    [200, { expires_in: 10 }, "transient"], // sem access_token (e sem refresh token novo)
  ];
  for (const [status, body, error] of cases) {
    const { api } = client(reply(status, body));
    const r = await api.refresh(CRED);
    assert.equal(r.ok, false, `status ${status}`);
    assert.equal(r.error, error, `status ${status} ${JSON.stringify(body)}`);
    assert.equal(r.status, status);
    assert.equal(r.cred, undefined, "sem refresh token novo, nada para gravar");
  }
});

test("refresh: 200 com access_token mas sem expires_in válido → vale 1 h", async () => {
  for (const expires_in of [undefined, null, 0, -5, "abc", "", true, {}]) {
    const { api } = client(reply(200, { access_token: "sk-ant-oat01-novo", refresh_token: "sk-ant-ort01-novo", expires_in }));
    const r = await api.refresh(CRED);
    assert.equal(r.ok, true, `expires_in ${JSON.stringify(expires_in)}`);
    assert.equal(r.cred.expiresAt, NOW + 3600 * 1000, `expires_in ${JSON.stringify(expires_in)}`);
    assert.equal(r.cred.accessToken, "sk-ant-oat01-novo");
    assert.equal(r.cred.refreshToken, "sk-ant-ort01-novo");
  }
  const { api } = client(reply(200, { access_token: "a", expires_in: "7200" }));
  assert.equal((await api.refresh(CRED)).cred.expiresAt, NOW + 7200 * 1000, "número em texto vale");
});

test("refresh: 200 com refresh_token novo mas sem access_token → falha COM o cred novo (para gravar), acesso vencido", async () => {
  const { api } = client(reply(200, { refresh_token: "sk-ant-ort01-novo", expires_in: 28800, scope: "user:inference" }));
  assert.deepEqual(await api.refresh(CRED), {
    ok: false,
    error: "transient",
    status: 200,
    cred: { ...CRED, refreshToken: "sk-ant-ort01-novo", expiresAt: 0 },
  });
  // Sem refresh token novo (ausente, vazio ou o mesmo): nada para gravar. 200 sem nada que sirva é
  // corpo quebrado: ambíguo (a renovação pode ter acontecido lá).
  for (const body of [{ refresh_token: CRED.refreshToken }, { access_token: "  ", refresh_token: "" }, {}]) {
    const c = client(reply(200, body));
    assert.deepEqual(await c.api.refresh(CRED), { ok: false, error: "transient", status: 200, ambiguous: true }, JSON.stringify(body));
  }
});

test("refresh: mantém refreshTokenExpiresAt do cred (renovar o acesso não muda o fim do login)", async () => {
  const LOGIN_END = NOW + 20 * 24 * 3600 * 1000;
  const cred = { ...CRED, refreshTokenExpiresAt: LOGIN_END };
  // Sem refresh_token_expires_in, ou com valor que não serve: fica a data que já existia.
  for (const refresh_token_expires_in of [undefined, null, 0, -5, "abc", "", true, {}, 1e300]) {
    const body = { access_token: "sk-ant-oat01-novo", refresh_token: "sk-ant-ort01-novo", expires_in: 28800 };
    if (refresh_token_expires_in !== undefined) body.refresh_token_expires_in = refresh_token_expires_in;
    const { api } = client(reply(200, body));
    const r = await api.refresh(cred);
    assert.equal(r.ok, true, JSON.stringify(refresh_token_expires_in));
    assert.equal(r.cred.refreshTokenExpiresAt, LOGIN_END, `refresh_token_expires_in ${JSON.stringify(refresh_token_expires_in)}`);
    assert.equal(r.cred.expiresAt, NOW + 28800 * 1000);
  }
  // Falha que trouxe refresh token novo sem access token: o cred para gravar também mantém a data.
  const { api } = client(reply(200, { refresh_token: "sk-ant-ort01-novo" }));
  const r = await api.refresh(cred);
  assert.equal(r.ok, false);
  assert.deepEqual(r.cred, { ...cred, refreshToken: "sk-ant-ort01-novo", expiresAt: 0 });
  // Login antigo, sem o campo: continua sem (desconhecido), nunca vira "agora".
  const c2 = client(reply(200, { access_token: "a", expires_in: 3600 }));
  const r2 = await c2.api.refresh(CRED);
  assert.equal("refreshTokenExpiresAt" in r2.cred, false);
});

test("refresh: refresh_token_expires_in numérico recalcula refreshTokenExpiresAt (agora + s)", async () => {
  const cred = { ...CRED, refreshTokenExpiresAt: NOW + 24 * 3600 * 1000 };
  const { api } = client(reply(200, { access_token: "a", refresh_token: "b", expires_in: 3600, refresh_token_expires_in: 30 * 24 * 3600 }));
  assert.equal((await api.refresh(cred)).cred.refreshTokenExpiresAt, NOW + 30 * 24 * 3600 * 1000);
  // Número em texto vale; cred sem o campo passa a ter.
  const c2 = client(reply(200, { access_token: "a", expires_in: 3600, refresh_token_expires_in: "86400" }));
  assert.equal((await c2.api.refresh(CRED)).cred.refreshTokenExpiresAt, NOW + 86400 * 1000);
  // Também no cred da falha com refresh token novo.
  const c3 = client(reply(200, { refresh_token: "sk-ant-ort01-novo", refresh_token_expires_in: 7200 }));
  const r3 = await c3.api.refresh(cred);
  assert.equal(r3.ok, false);
  assert.equal(r3.cred.refreshTokenExpiresAt, NOW + 7200 * 1000);
});

test("refresh: erro de rede vira transient (sem saber se saiu = ambíguo); sem refresh token nem chama", async () => {
  const { api } = client(new Error("ECONNRESET"));
  assert.deepEqual(await api.refresh(CRED), { ok: false, error: "transient", status: 0, ambiguous: true });
  const c2 = client(reply(200, {}));
  assert.equal((await c2.api.refresh({ accessToken: "x" })).error, "no_refresh_token");
  assert.equal(c2.calls.length, 0);
});

test("refresh: expires_in tem teto de 24 h (data absurda não deixa o acesso valendo por anos)", async () => {
  assert.equal(MAX_EXPIRES_IN_SEC, 24 * 3600);
  const cases = [
    [1e13, 24 * 3600],
    [1e300, 24 * 3600],
    [30 * 24 * 3600, 24 * 3600],
    ["999999999", 24 * 3600],
    [24 * 3600, 24 * 3600],
    [24 * 3600 - 1, 24 * 3600 - 1],
    [28800, 28800],
  ];
  for (const [expires_in, want] of cases) {
    const { api } = client(reply(200, { access_token: "sk-ant-oat01-novo", refresh_token: "sk-ant-ort01-novo", expires_in }));
    const r = await api.refresh(CRED);
    assert.equal(r.ok, true, String(expires_in));
    assert.equal(r.cred.expiresAt, NOW + want * 1000, `expires_in ${expires_in}`);
    assert.doesNotThrow(() => new Date(r.cred.expiresAt).toISOString());
  }
});

test("refresh: tempo máximo de 45 s (uso e perfil continuam com 15 s)", async (t) => {
  assert.equal(REFRESH_TIMEOUT_MS, 45000);
  assert.equal(TIMEOUT_MS, 15000);
  const seen = [];
  const real = AbortSignal.timeout;
  AbortSignal.timeout = (ms) => {
    seen.push(ms);
    return real.call(AbortSignal, ms);
  };
  t.after(() => {
    AbortSignal.timeout = real;
  });
  const { api } = client(() => reply(500, {}));
  await api.refresh(CRED);
  await api.usage("t");
  await api.profile("t");
  assert.deepEqual(seen, [45000, 15000, 15000]);
});

test("refresh: sem resposta (tempo esgotado, conexão caída, 5xx, corpo quebrado) é ambígua; o que nunca saiu (DNS, recusada) não é", async () => {
  const coded = (code, message = code) => Object.assign(new Error(message), { code });
  const net = (code) => new TypeError("fetch failed", { cause: coded(code, `${code} anthropic.falsa`) });

  // Nunca saiu daqui: o refresh token não chegou à Anthropic.
  const notSent = [
    ["ENOTFOUND", net("ENOTFOUND")],
    ["EAI_AGAIN", net("EAI_AGAIN")],
    ["ECONNREFUSED", net("ECONNREFUSED")],
    [
      "ECONNREFUSED nos dois endereços",
      new TypeError("fetch failed", { cause: Object.assign(new AggregateError([coded("ECONNREFUSED"), coded("ECONNREFUSED")]), { code: "ECONNREFUSED" }) }),
    ],
  ];
  for (const [label, err] of notSent) {
    const { api } = client(() => {
      throw err;
    });
    assert.deepEqual(await api.refresh(CRED), { ok: false, error: "transient", status: 0 }, label);
  }

  // Pode ter chegado lá (e gastado o refresh token).
  const lost = [
    ["tempo esgotado", new DOMException("The operation was aborted due to timeout", "TimeoutError")],
    ["ECONNRESET", net("ECONNRESET")],
    ["UND_ERR_SOCKET", net("UND_ERR_SOCKET")],
    ["sem código", new Error("rede")],
    ["um endereço recusou, o outro esgotou", new TypeError("fetch failed", { cause: new AggregateError([coded("ECONNREFUSED"), coded("ETIMEDOUT")]) })],
  ];
  for (const [label, err] of lost) {
    const { api } = client(() => {
      throw err;
    });
    assert.deepEqual(await api.refresh(CRED), { ok: false, error: "transient", status: 0, ambiguous: true }, label);
  }

  // Respostas: 5xx e corpo quebrado = ambígua; 4xx = o pedido foi recusado (nada gasto).
  const brokenBody = () =>
    new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("ECONNRESET"));
        },
      }),
      { status: 200 }
    );
  const cases = [
    ["500", () => reply(500, { error: "x" }), 500, true],
    ["503 html", () => reply(503, "<html>erro</html>"), 503, true],
    ["200 json quebrado", () => reply(200, "{ quebrado"), 200, true],
    ["200 lista", () => reply(200, []), 200, true],
    ["200 sem access_token", () => reply(200, { token_type: "Bearer" }), 200, true],
    ["200 com o corpo caindo no meio", brokenBody, 200, true],
    ["429", () => reply(429, { error: "rate_limited" }), 429, false],
    ["400 invalid_request", () => reply(400, { error: "invalid_request" }), 400, false],
    ["400 sem json", () => reply(400, "não é json"), 400, false],
  ];
  for (const [label, answer, status, ambiguous] of cases) {
    const { api } = client(answer);
    const r = await api.refresh(CRED);
    assert.equal(r.ok, false, label);
    assert.equal(r.error, "transient", label);
    assert.equal(r.status, status, label);
    assert.equal(r.ambiguous === true, ambiguous, label);
    assert.equal(r.cred, undefined, label);
  }

  // Respostas definitivas e a renovação incompleta (com o refresh token novo na mão) nunca são ambíguas.
  for (const [body, status] of [
    [{ error: "invalid_grant" }, 400],
    [{ error: "invalid_client" }, 401],
  ]) {
    const { api } = client(reply(status, body));
    const r = await api.refresh(CRED);
    assert.equal(r.error, body.error);
    assert.equal("ambiguous" in r, false);
  }
  const partial = await client(reply(200, { refresh_token: "sk-ant-ort01-novo" })).api.refresh(CRED);
  assert.equal(partial.ok, false);
  assert.equal("ambiguous" in partial, false);
  assert.equal(partial.cred.refreshToken, "sk-ant-ort01-novo");
});

// ------------------------------------------------------------------ uso

test("usage: normaliza five_hour null, seven_day e limits com Fable", async () => {
  const { api, calls } = client(
    reply(200, {
      five_hour: null,
      seven_day: { utilization: 42.5, resets_at: "2026-11-18T03:00:00.000000+00:00" },
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
      limits: [
        { kind: "weekly_scoped", scope: { model: { display_name: "Fable" } }, percent: 63, resets_at: "2026-11-19T00:00:00Z" },
        { kind: "session", scope: {}, percent: 10 }, // sem modelo: não é limite por modelo
        { scope: { model: { display_name: "Texto" } }, percent: "12" }, // percent não numérico
        "lixo",
      ],
    })
  );
  const r = await api.usage("sk-ant-oat01-1");
  assert.deepEqual(r, {
    ok: true,
    usage: {
      sevenDay: { pct: 42.5, resetsAt: "2026-11-18T03:00:00.000000+00:00" },
      scoped: [{ name: "Fable", pct: 63, resetsAt: "2026-11-19T00:00:00Z" }],
    },
  });
  const { url, init } = calls[0];
  assert.equal(url, `${API}/api/oauth/usage`);
  assert.equal(init.method, "GET");
  assert.equal(init.headers.Authorization, "Bearer sk-ant-oat01-1");
  assert.equal(init.headers["anthropic-beta"], "oauth-2025-04-20");
  assert.ok(init.signal instanceof AbortSignal);
  assert.equal(init.redirect, "error");

  // O formato serve direto para o windows() do rules.js (o mesmo que a extensão usa).
  const w = windows({ usageStatus: "ok", usage: r.usage, usageAgeSeconds: 0 });
  assert.deepEqual(w.session, { pct: 0, resetsAt: null, idle: true });
  assert.equal(w.weekly.pct, 42.5);
  assert.deepEqual(w.models, [{ name: "Fable", pct: 63, resetsAt: "2026-11-19T00:00:00Z" }]);
});

test("normalizeUsage: utilization null fica pct null; janela vazia some; resets_at ausente vira null", () => {
  assert.deepEqual(normalizeUsage({ five_hour: { utilization: null, resets_at: null }, seven_day: { utilization: 0 } }), {
    fiveHour: { pct: null, resetsAt: null },
    sevenDay: { pct: 0, resetsAt: null },
  });
  assert.deepEqual(normalizeUsage({ five_hour: {}, seven_day: null }), {});
  assert.deepEqual(normalizeUsage({ five_hour: { utilization: 91, resets_at: "2026-11-14T15:00:00Z" } }), {
    fiveHour: { pct: 91, resetsAt: "2026-11-14T15:00:00Z" },
  });
});

test("usage: classifica os erros", async () => {
  const cases = [
    [reply(401, { error: "unauthorized" }), { ok: false, error: "unauthorized", status: 401, retryAfterSec: null }],
    [reply(429, {}, { "retry-after": "120" }), { ok: false, error: "rate_limited", status: 429, retryAfterSec: 120 }],
    [reply(429, {}, { "retry-after": new Date(NOW + 90 * 1000).toUTCString() }), { ok: false, error: "rate_limited", status: 429, retryAfterSec: 90 }],
    [reply(429, {}), { ok: false, error: "rate_limited", status: 429, retryAfterSec: null }],
    [reply(503, { error: "overloaded" }), { ok: false, error: "transient", status: 503, retryAfterSec: null }],
    [reply(200, "{ quebrado"), { ok: false, error: "bad_response", status: 200, retryAfterSec: null }],
    [reply(200, []), { ok: false, error: "bad_response", status: 200, retryAfterSec: null }],
    [reply(200, { five_hour: "x" }), { ok: false, error: "bad_response", status: 200, retryAfterSec: null }],
    [reply(200, { seven_day: { resets_at: "2026-11-18T00:00:00Z" } }), { ok: false, error: "bad_response", status: 200, retryAfterSec: null }],
    [reply(200, { five_hour: { utilization: -1 } }), { ok: false, error: "bad_response", status: 200, retryAfterSec: null }],
    [reply(200, { five_hour: { utilization: "50" } }), { ok: false, error: "bad_response", status: 200, retryAfterSec: null }],
  ];
  for (const [res, want] of cases) {
    const { api } = client(res);
    assert.deepEqual(await api.usage("t"), want);
  }
  const { api } = client(new Error("timeout"));
  assert.deepEqual(await api.usage("t"), { ok: false, error: "transient", status: 0, retryAfterSec: null });
});

test("usage: Retry-After tem teto de 6 h", async () => {
  assert.equal(MAX_RETRY_AFTER_SEC, 6 * 3600);
  const cases = [
    [reply(429, {}, { "retry-after": "999999" }), 6 * 3600],
    [reply(429, {}, { "retry-after": new Date(NOW + 3 * 24 * 3600 * 1000).toUTCString() }), 6 * 3600],
    [reply(503, {}, { "retry-after": "86400" }), 6 * 3600],
    [reply(429, {}, { "retry-after": String(6 * 3600 - 1) }), 6 * 3600 - 1],
  ];
  for (const [res, want] of cases) {
    const { api } = client(res);
    assert.equal((await api.usage("t")).retryAfterSec, want);
  }
});

// ------------------------------------------------------------------ perfil

test("profile: lê uuid, e-mail e organização", async () => {
  const { api, calls } = client(reply(200, { account: { uuid: "u-1", email_address: "Ana@X.com", full_name: "Ana" }, organization: { uuid: "org-1", name: "X" } }));
  assert.deepEqual(await api.profile("sk-ant-oat01-1"), { uuid: "u-1", email: "Ana@X.com", orgUuid: "org-1" });
  assert.equal(calls[0].url, `${API}/api/oauth/profile`);
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-ant-oat01-1");
  assert.ok(calls[0].init.signal instanceof AbortSignal);
  assert.equal(calls[0].init.redirect, "error");

  // O motor Python lê account.email: os dois nomes valem.
  const c2 = client(reply(200, { account: { uuid: "u-2", email: "bia@x.com" } }));
  assert.deepEqual(await c2.api.profile("t"), { uuid: "u-2", email: "bia@x.com", orgUuid: null });
});

test("profile: qualquer falha vira null", async () => {
  for (const answer of [reply(401, {}), reply(500, {}), reply(200, "não é json"), reply(200, { account: { email_address: "x@y.com" } }), reply(200, {}), new Error("rede")]) {
    const { api } = client(answer);
    assert.equal(await api.profile("t"), null);
  }
});

// ------------------------------------------------------------------ endereços

test("usa os endereços padrão e aceita apiBase com barra no fim", async () => {
  const seen = [];
  const fetchImpl = async (url) => {
    seen.push(url);
    return reply(500, {});
  };
  const api = createAnthropic({ fetchImpl });
  await api.refresh(CRED);
  await api.usage("t");
  assert.deepEqual(seen, [DEFAULT_TOKEN_URL, `${DEFAULT_API_BASE}/api/oauth/usage`]);
  assert.equal(DEFAULT_TOKEN_URL, "https://platform.claude.com/v1/oauth/token");
  assert.equal(DEFAULT_API_BASE, "https://api.anthropic.com");

  const { api: api2, calls } = client(reply(500, {}), { apiBase: `${API}/` });
  await api2.profile("t");
  assert.equal(calls[0].url, `${API}/api/oauth/profile`);
});

test("endereços: só https; http só em 127.0.0.1/localhost", () => {
  const fetchImpl = async () => reply(500, {});
  const bad = [
    ["http://anthropic.falsa/v1/oauth/token", API],
    [TOKEN_URL, "http://api.anthropic.falsa"],
    [TOKEN_URL, "http://10.0.0.5:8080"],
    ["http://localhost.exemplo.com/v1/oauth/token", API],
    [TOKEN_URL, "http://127.0.0.1.nip.io"],
    ["ftp://anthropic.falsa/token", API],
    ["isto não é endereço", API],
  ];
  for (const [tokenUrl, apiBase] of bad) {
    assert.throws(() => createAnthropic({ tokenUrl, apiBase, fetchImpl }), /precisa ser https|inválido/, `${tokenUrl} ${apiBase}`);
  }
  for (const host of ["127.0.0.1:9", "localhost:9"]) {
    assert.doesNotThrow(() => createAnthropic({ tokenUrl: `http://${host}/v1/oauth/token`, apiBase: `http://${host}`, fetchImpl }), host);
  }
});

test("redirecionamento é recusado nas três chamadas (nada segue para o endereço do redirecionamento)", async (t) => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    if (req.url.startsWith("/desvio")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: "a", expires_in: 3600, account: { uuid: "u" } }));
      return;
    }
    res.writeHead(307, { location: `/desvio${req.url}` });
    res.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = createAnthropic({ tokenUrl: `${base}/v1/oauth/token`, apiBase: base }); // fetch de verdade
  // O pedido chegou a um servidor (que respondeu com redirecionamento): ambíguo, por cautela.
  assert.deepEqual(await api.refresh(CRED), { ok: false, error: "transient", status: 0, ambiguous: true });
  assert.deepEqual(await api.usage("t"), { ok: false, error: "transient", status: 0, retryAfterSec: null });
  assert.equal(await api.profile("t"), null);
  assert.deepEqual(hits, ["/v1/oauth/token", "/api/oauth/usage", "/api/oauth/profile"]);
});
