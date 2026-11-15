"use strict";
// Testes de plus/claudeAuth.js e plus/serverClient.js (node:test).
// Rodar (no servidor):  node --test plus/test/clientlibs.test.js
//
// Segurança: tudo acontece em diretórios temporários (CLAUDE_CONFIG_DIR aponta
// para eles e cada teste confere isso) e o Keychain fica desligado
// (_test.setStore("file")) ou trocado por um falso em memória. Nunca toca no
// Keychain nem no ~/.claude.json de verdade.

const { test, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const https = require("node:https");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");

const auth = require("../claudeAuth");
const { createServerClient, parseConnectCode, pair, loginStart, loginPoll, originOf } = require("../serverClient");

const isWin = process.platform === "win32";
// realpath: no macOS o tmpdir é link (/var → /private/var) e a trava legada usa o caminho real.
const ROOT = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "swapplus-clientlibs-")));
const WARN_ENV = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"];
const ENV_KEYS = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", ...WARN_ENV];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

// Antes de qualquer chamada: nada de Keychain, nada fora do temporário.
delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
for (const k of WARN_ENV) delete process.env[k];
process.env.CLAUDE_CONFIG_DIR = path.join(ROOT, "inicial");
auth._test.setStore("file");

after(() => {
  auth._test.reset();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

let homeN = 0;
/** Confere que todos os caminhos do claudeAuth caem dentro do temporário. */
function assertInsideRoot() {
  const paths = [
    auth.configHome(),
    auth.globalConfigPath(),
    auth._test.credentialsPath(),
    auth._test.configLockDir(),
    auth._test.storageWriteLockDir(),
    ...auth._test.credentialLockDirs(),
  ];
  for (const p of paths) assert.ok(path.resolve(p).startsWith(ROOT), `caminho fora do temporário: ${p}`);
}
/** Pasta nova de configuração do Claude Code, dentro do temporário. */
function freshHome() {
  const dir = path.join(ROOT, `home-${++homeN}`);
  fs.mkdirSync(dir, { recursive: true });
  process.env.CLAUDE_CONFIG_DIR = dir;
  assertInsideRoot();
  return dir;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const modeOf = (f) => fs.statSync(f).mode & 0o777;
const age = (dir, ms) => {
  const t = new Date(Date.now() - ms);
  fs.utimesSync(dir, t, t);
};
const b64 = (obj) => Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
const randomFp = () => crypto.randomBytes(32).toString("hex").toUpperCase().match(/../g).join(":");
/** expiresAt no futuro (writeLive recusa credencial vencida). */
const future = (h = 8) => Date.now() + h * 3600 * 1000 + Math.floor(Math.random() * 1000);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const allLockDirs = () => [...auth._test.credentialLockDirs(), auth._test.storageWriteLockDir()];

/**
 * Roda fn como se fosse um Mac, com um Keychain falso em memória.
 * fake.sets conta gravações; fake.onSet(service, account, value) é chamado antes de gravar.
 */
async function withFakeMac(home, fn) {
  const items = new Map();
  const fake = {
    sets: 0,
    onSet: null,
    async get(service, account) {
      const k = service + "\0" + account;
      return items.has(k) ? items.get(k) : null;
    },
    async set(service, account, value) {
      fake.sets++;
      if (fake.onSet) fake.onSet(service, account, value);
      items.set(service + "\0" + account, value);
    },
  };
  // Ordem importa: o falso entra ANTES de ligar o "Mac".
  auth._test.setKeychain(fake);
  auth._test.setPlatform("darwin");
  auth._test.setStore(null);
  try {
    const service = auth._test.keychainServices()[0];
    const key = service + "\0" + auth._test.keychainAccount();
    return await fn({ items, fake, service, key, credFile: path.join(home, ".credentials.json") });
  } finally {
    auth._test.setKeychain(null);
    auth._test.setPlatform(null);
    auth._test.setStore("file");
  }
}

/** Separa a linha como o `security -i` (conferido no macOS): aspas duplas agrupam; dentro delas \" e \\ viram " e \. */
function securityWords(line) {
  const s = line.replace(/\n$/, "");
  const words = [];
  let i = 0;
  while (i < s.length) {
    while (s[i] === " " || s[i] === "\t") i++;
    if (i >= s.length) break;
    let w = "";
    if (s[i] === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length) i++;
        w += s[i++];
      }
      i++;
    } else {
      while (i < s.length && s[i] !== " " && s[i] !== "\t") w += s[i++];
    }
    words.push(w);
  }
  return words;
}

// ================================================================ parseConnectCode

test("parseConnectCode: código válido (com e sem impressão digital, colado com quebras)", () => {
  const fpLower = "ab:".repeat(31) + "ab";
  const code = "swapplus1:" + b64({ url: "https://203.0.113.5:8443/", code: "ABCDEFGHJK", fp: fpLower });
  assert.deepEqual(parseConnectCode(code), { url: "https://203.0.113.5:8443", code: "ABCDEFGHJK", fp: fpLower.toUpperCase() });

  const semFp = "swapplus1:" + b64({ url: "https://swap.exemplo.com", code: "ZXCVBNMLKJ", fp: null });
  const quebrado = "  " + semFp.slice(0, 20) + "\n" + semFp.slice(20) + "\r\n";
  assert.deepEqual(parseConnectCode(quebrado), { url: "https://swap.exemplo.com", code: "ZXCVBNMLKJ", fp: null });
});

test("parseConnectCode: prefixo errado", () => {
  const corpo = b64({ url: "https://1.2.3.4:8443", code: "ABCDEFGHJK", fp: null });
  assert.throws(() => parseConnectCode("swapplus2:" + corpo), (e) => e.code === "bad_connect_code" && /outra versão/.test(e.message));
  assert.throws(() => parseConnectCode("https://1.2.3.4:8443"), (e) => e.code === "bad_connect_code" && /swapplus1:/.test(e.message));
  assert.throws(() => parseConnectCode(corpo), (e) => e.code === "bad_connect_code" && /swapplus1:/.test(e.message));
  assert.throws(() => parseConnectCode(""), (e) => e.code === "bad_connect_code");
  assert.throws(() => parseConnectCode(null), (e) => e.code === "bad_connect_code");
});

test("parseConnectCode: base64 quebrado ou conteúdo inválido", () => {
  const inteiro = "swapplus1:" + b64({ url: "https://1.2.3.4:8443", code: "ABCDEFGHJK", fp: randomFp() });
  const quebrados = [
    "swapplus1:%%%não-é-base64%%%",
    "swapplus1:",
    "swapplus1:" + Buffer.from("isto não é json").toString("base64url"),
    "swapplus1:" + Buffer.from("[1,2]").toString("base64url"),
    inteiro.slice(0, Math.floor(inteiro.length / 2)), // cortado no meio
  ];
  for (const s of quebrados) {
    assert.throws(() => parseConnectCode(s), (e) => e.code === "bad_connect_code" && /quebrado/.test(e.message), s);
  }
  const fp = randomFp();
  assert.throws(() => parseConnectCode("swapplus1:" + b64({ code: "X", fp })), /endereço/);
  assert.throws(() => parseConnectCode("swapplus1:" + b64({ url: "ftp://a", code: "X" })), /endereço inválido/);
  assert.throws(() => parseConnectCode("swapplus1:" + b64({ url: "https://a", code: "" })), /pareamento/);
  assert.throws(() => parseConnectCode("swapplus1:" + b64({ url: "https://a", code: "X", fp: "12:34" })), /impressão digital inválida/);
  assert.throws(() => parseConnectCode("swapplus1:" + b64({ url: "http://127.0.0.1:8443", code: "X", fp })), /inconsistente/);
});

// ================================================================ serverClient: http e origem do token

test("serverClient: http:// só para localhost (bad_url) em createServerClient, parseConnectCode, pair, loginStart, loginPoll", async () => {
  const msg = "Use https:// (http:// só para localhost).";
  const isHttpErr = (e) => e.code === "bad_url" && e.message === msg;
  for (const url of ["http://swap.exemplo.com", "http://203.0.113.5:8080", "http://10.0.0.1", "http://localhost.exemplo.com", "http://127.0.0.2"]) {
    assert.throws(() => createServerClient({ url }), isHttpErr, url);
    assert.throws(() => createServerClient({ url, token: "t", tokenOrigin: url }), isHttpErr, url);
    assert.throws(() => parseConnectCode("swapplus1:" + b64({ url, code: "ABCDEFGHJK", fp: null })), isHttpErr, url);
    await assert.rejects(pair({ url, code: "ABCDEFGHJK", name: "x", platform: "linux" }), isHttpErr, url);
    await assert.rejects(loginStart({ url, name: "x", platform: "linux" }), isHttpErr, url);
    await assert.rejects(loginPoll({ url, sessionId: "s", pollToken: "p" }), isHttpErr, url);
  }
  for (const url of ["http://localhost:1", "http://LOCALHOST:1/base", "http://127.0.0.1:1", "http://[::1]:1"]) {
    assert.doesNotThrow(() => createServerClient({ url, token: "t", tokenOrigin: url }), url);
  }
  assert.deepEqual(parseConnectCode("swapplus1:" + b64({ url: "http://127.0.0.1:8080", code: "ABCDEFGHJK", fp: null })), {
    url: "http://127.0.0.1:8080",
    code: "ABCDEFGHJK",
    fp: null,
  });
  assert.doesNotThrow(() => createServerClient({ url: "https://swap.exemplo.com" }));
});

test("serverClient: o token só vale na origem que o emitiu (origin_mismatch)", () => {
  const isMismatch = (e) => e.code === "origin_mismatch" && e.message === "O acesso deste computador foi emitido para outro servidor. Conecte de novo.";
  const url = "https://swap.exemplo.com/base";
  assert.throws(() => createServerClient({ url, token: "t", tokenOrigin: "https://outro.exemplo.com" }), isMismatch, "outro host");
  assert.throws(() => createServerClient({ url, token: "t", tokenOrigin: "https://swap.exemplo.com:8443" }), isMismatch, "outra porta");
  assert.throws(() => createServerClient({ url: "http://127.0.0.1:8080", token: "t", tokenOrigin: "https://127.0.0.1:8080" }), isMismatch, "outro esquema");
  assert.throws(() => createServerClient({ url, token: "t", tokenOrigin: "nada" }), isMismatch, "origem ilegível");
  assert.throws(() => createServerClient({ url, token: "t", tokenOrigin: "" }), isMismatch, "origem vazia");
  for (const tokenOrigin of ["https://swap.exemplo.com", "https://SWAP.exemplo.com:443/base/", "https://swap.exemplo.com/outro-caminho"]) {
    assert.equal(createServerClient({ url, token: "t", tokenOrigin }).origin, "https://swap.exemplo.com", tokenOrigin);
  }
  // Sem token não há o que conferir; sem tokenOrigin, compatibilidade.
  assert.doesNotThrow(() => createServerClient({ url, tokenOrigin: "https://outro.exemplo.com" }));
  assert.doesNotThrow(() => createServerClient({ url, token: "t" }));
  assert.equal(originOf("https://a.exemplo.com:443/x?y#z"), "https://a.exemplo.com");
  assert.equal(originOf("http://[::1]:8080/x"), "http://[::1]:8080");
  assert.equal(originOf("ftp://a"), null);
  assert.equal(originOf(null), null);
});

// ================================================================ claudeAuth: login em arquivo

test("writeLive/readLive (arquivo): preserva mcpOAuth, não cria refreshToken, grava 0600", async () => {
  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  assert.equal(await auth.readLive(), null, "sem arquivo = sem login");

  const mcp = { "srv|abc123": { serverName: "srv", accessToken: "mcp-token", expiresAt: 123 } };
  fs.writeFileSync(
    credFile,
    JSON.stringify({
      claudeAiOauth: { accessToken: "velho", refreshToken: "sk-ant-ort-velho", expiresAt: 1, scopes: ["user:inference"] },
      mcpOAuth: mcp,
      trustedDeviceToken: "tdt",
    })
  );
  if (!isWin) fs.chmodSync(credFile, 0o644);

  const novo = {
    accessToken: "sk-ant-oat-novo",
    expiresAt: future(),
    scopes: ["user:inference", "user:profile"],
    subscriptionType: "max",
    rateLimitTier: "default_claude_max_20x",
  };
  assert.deepEqual(await auth.writeLive(novo), { store: "file" });

  const disk = readJson(credFile);
  assert.deepEqual(disk.claudeAiOauth, novo);
  assert.equal("refreshToken" in disk.claudeAiOauth, false, "não pode sobrar o refreshToken antigo");
  assert.deepEqual(disk.mcpOAuth, mcp);
  assert.equal(disk.trustedDeviceToken, "tdt", "sem dropTrustedDevice, mantém");
  if (!isWin) assert.equal(modeOf(credFile), 0o600);

  const live = await auth.readLive();
  assert.equal(live.source, "file");
  assert.deepEqual(live.claudeAiOauth, novo);
  assert.deepEqual(live.raw.mcpOAuth, mcp);

  for (const d of allLockDirs()) assert.equal(fs.existsSync(d), false, `trava não liberada: ${d}`);
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".tmp")), [], "sobrou temporário");
});

test("writeLive (arquivo): cria 0600 quando não existe; recusa credencial inválida ou vencida", async () => {
  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  const exp = future();
  await auth.writeLive({ accessToken: "a", expiresAt: exp, refreshToken: undefined });
  assert.deepEqual(readJson(credFile), { claudeAiOauth: { accessToken: "a", expiresAt: exp } });
  if (!isWin) assert.equal(modeOf(credFile), 0o600);

  const antes = fs.readFileSync(credFile, "utf8");
  for (const bad of [
    { accessToken: "", expiresAt: exp },
    { accessToken: "   ", expiresAt: exp },
    { accessToken: "x" },
    { accessToken: "x", expiresAt: 0 },
    { accessToken: "x", expiresAt: Date.now() - 1000 },
    { accessToken: "x", expiresAt: NaN },
    { accessToken: "x", expiresAt: String(exp) },
    null,
    [],
  ]) {
    await assert.rejects(auth.writeLive(bad), { code: "bad_credential" }, JSON.stringify(bad));
  }
  await assert.rejects(auth.writeLive({ accessToken: "x", expiresAt: exp }, { canReplace: "sim" }), { code: "bad_option" });
  assert.equal(fs.readFileSync(credFile, "utf8"), antes, "nada gravado com credencial inválida");
});

test("cleanOauth/writeLive: refreshToken NUNCA é gravado", async () => {
  const exp = future();
  assert.deepEqual(auth._test.cleanOauth({ accessToken: "a", refreshToken: "sk-ant-ort-x", expiresAt: exp, scopes: ["s"], extra: undefined }), {
    accessToken: "a",
    expiresAt: exp,
    scopes: ["s"],
  });
  assert.equal("refreshToken" in auth._test.cleanOauth({ accessToken: "a", refreshToken: "", expiresAt: exp }), false, "nem refreshToken vazio");

  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  await auth.writeLive({ accessToken: "a", refreshToken: "sk-ant-ort-segredo", expiresAt: exp });
  assert.equal("refreshToken" in readJson(credFile).claudeAiOauth, false);
  assert.ok(!fs.readFileSync(credFile, "utf8").includes("sk-ant-ort-segredo"));

  await withFakeMac(home, async ({ items, key }) => {
    await auth.writeLive({ accessToken: "b", refreshToken: "sk-ant-ort-segredo", expiresAt: exp });
    assert.ok(!items.get(key).includes("sk-ant-ort-segredo"), "nem no Keychain");
    assert.equal("refreshToken" in JSON.parse(items.get(key)).claudeAiOauth, false);
  });
});

test("credencial atual ilegível: readLive lança live_unreadable e writeLive não sobrescreve (credentials_unreadable)", async () => {
  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  for (const broken of ["{ corrompido", "[1,2]", "null", "123"]) {
    fs.writeFileSync(credFile, broken);
    await assert.rejects(auth.readLive(), (e) => e.code === "live_unreadable" && e.reason === "invalid_json", broken);
    await assert.rejects(
      auth.writeLive({ accessToken: "novo", expiresAt: future() }),
      (e) => e.code === "credentials_unreadable" && e.path === credFile && /não vou sobrescrever/.test(e.message),
      broken
    );
    assert.equal(fs.readFileSync(credFile, "utf8"), broken, "arquivo intacto");
    for (const d of allLockDirs()) assert.equal(fs.existsSync(d), false, `trava não liberada: ${d}`);
  }
  // Vazio ou sem claudeAiOauth = não há login (null), não é erro.
  fs.writeFileSync(credFile, "  \n");
  assert.equal(await auth.readLive(), null);
  fs.writeFileSync(credFile, JSON.stringify({ mcpOAuth: {} }));
  assert.equal(await auth.readLive(), null, "sem claudeAiOauth = sem login");

  // macOS: item do Keychain ilegível também não é sobrescrito.
  fs.unlinkSync(credFile);
  await withFakeMac(home, async ({ items, key, fake, service }) => {
    items.set(key, "{ quebrado no keychain");
    await assert.rejects(
      auth.writeLive({ accessToken: "novo", expiresAt: future() }),
      (e) => e.code === "credentials_unreadable" && e.service === service
    );
    assert.equal(fake.sets, 0);
    assert.equal(items.get(key), "{ quebrado no keychain");
    await assert.rejects(auth.readLive(), (e) => e.code === "live_unreadable" && e.reason === "invalid_json");
  });
});

test("writeLive com dropTrustedDevice: tira trustedDeviceToken e trustedDeviceEnrolledAfterRefusalAtMs (padrão: mantém)", async () => {
  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  const original = {
    claudeAiOauth: { accessToken: "velho", expiresAt: 1 },
    trustedDeviceToken: "tdt",
    trustedDeviceEnrolledAfterRefusalAtMs: 123,
    mcpOAuth: { m: 1 },
  };
  fs.writeFileSync(credFile, JSON.stringify(original));
  await auth.writeLive({ accessToken: "a", expiresAt: future() });
  assert.equal(readJson(credFile).trustedDeviceToken, "tdt");
  assert.equal(readJson(credFile).trustedDeviceEnrolledAfterRefusalAtMs, 123);
  await auth.writeLive({ accessToken: "b", expiresAt: future() }, { dropTrustedDevice: true });
  const disk = readJson(credFile);
  assert.equal("trustedDeviceToken" in disk, false);
  assert.equal("trustedDeviceEnrolledAfterRefusalAtMs" in disk, false);
  assert.deepEqual(disk.mcpOAuth, { m: 1 });
  assert.equal(disk.claudeAiOauth.accessToken, "b");

  // Mac: some do Keychain e do arquivo reserva.
  fs.writeFileSync(credFile, JSON.stringify(original));
  await withFakeMac(home, async ({ items, key }) => {
    items.set(key, JSON.stringify(original));
    await auth.writeLive({ accessToken: "c", expiresAt: future() }, { dropTrustedDevice: true });
    for (const v of [JSON.parse(items.get(key)), readJson(credFile)]) {
      assert.equal("trustedDeviceToken" in v, false);
      assert.equal("trustedDeviceEnrolledAfterRefusalAtMs" in v, false);
      assert.equal(v.claudeAiOauth.accessToken, "c");
    }
  });
});

test("writeLive com canReplace (compare-and-swap): login novo com refresh token não é sobrescrito; leitura falha → não grava", async () => {
  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  const loginNovo = { claudeAiOauth: { accessToken: "do-navegador", refreshToken: "sk-ant-ort-novo", expiresAt: future() }, mcpOAuth: { m: 1 } };
  fs.writeFileSync(credFile, JSON.stringify(loginNovo));
  const antes = fs.readFileSync(credFile, "utf8");

  let got = null;
  await assert.rejects(
    auth.writeLive({ accessToken: "do-servidor", expiresAt: future() }, { canReplace: (cur) => ((got = cur), false) }),
    { code: "live_changed" }
  );
  assert.equal(fs.readFileSync(credFile, "utf8"), antes, "não gravou por cima do login novo");
  assert.equal(got.source, "file");
  assert.equal(got.claudeAiOauth.refreshToken, "sk-ant-ort-novo");
  assert.deepEqual(got.raw.mcpOAuth, { m: 1 });
  await assert.rejects(auth.writeLive({ accessToken: "x", expiresAt: future() }, { canReplace: async () => false }), { code: "live_changed" });
  await assert.rejects(auth.writeLive({ accessToken: "x", expiresAt: future() }, { canReplace: () => undefined }), { code: "live_changed" }, "só true libera");
  assert.equal(fs.readFileSync(credFile, "utf8"), antes);
  for (const d of allLockDirs()) assert.equal(fs.existsSync(d), false, `trava não liberada: ${d}`);

  await auth.writeLive({ accessToken: "do-servidor", expiresAt: future() }, { canReplace: async () => true });
  const disk = readJson(credFile);
  assert.equal(disk.claudeAiOauth.accessToken, "do-servidor");
  assert.equal("refreshToken" in disk.claudeAiOauth, false);
  assert.deepEqual(disk.mcpOAuth, { m: 1 });

  // Login atual sem refresh token (veio do servidor): nada a perder, nem pergunta.
  let called = false;
  await auth.writeLive({ accessToken: "outro", expiresAt: future() }, { canReplace: () => ((called = true), false) });
  assert.equal(called, false);
  assert.equal(readJson(credFile).claudeAiOauth.accessToken, "outro");

  // Leitura falha (JSON quebrado) → live_unreadable, nada gravado.
  fs.writeFileSync(credFile, "{ quebrado");
  await assert.rejects(
    auth.writeLive({ accessToken: "x", expiresAt: future() }, { canReplace: () => true }),
    (e) => e.code === "live_unreadable" && e.reason === "invalid_json"
  );
  assert.equal(fs.readFileSync(credFile, "utf8"), "{ quebrado");

  // Mac: relê o Keychain sob a trava; Keychain que não abre → live_unreadable, nada gravado.
  fs.unlinkSync(credFile);
  await withFakeMac(home, async ({ items, key, fake }) => {
    items.set(key, JSON.stringify(loginNovo));
    await assert.rejects(auth.writeLive({ accessToken: "x", expiresAt: future() }, { canReplace: () => false }), { code: "live_changed" });
    assert.equal(fake.sets, 0);
    fake.get = async () => {
      throw new Error("Keychain trancado");
    };
    await assert.rejects(
      auth.writeLive({ accessToken: "x", expiresAt: future() }, { canReplace: () => true }),
      (e) => e.code === "live_unreadable" && e.reason === "keychain_unavailable"
    );
    assert.equal(fake.sets, 0);
    assert.equal(items.get(key), JSON.stringify(loginNovo));
  });
});

// ================================================================ claudeAuth: macOS com Keychain falso

test("writeLive/readLive (macOS, Keychain simulado): serviço do perfil; arquivo reserva regravado SEM copiar nada do Keychain", async () => {
  const home = freshHome();
  await withFakeMac(home, async ({ items, key, service, credFile, fake }) => {
    const expected = "Claude Code-credentials-" + crypto.createHash("sha256").update(home.normalize("NFC")).digest("hex").slice(0, 8);
    assert.deepEqual(auth._test.keychainServices(), [expected], "com CLAUDE_CONFIG_DIR o Claude Code usa o serviço com sufixo");
    assert.equal(service, expected);
    const calls = [];
    const get0 = fake.get;
    fake.get = async (s, a) => (calls.push(s), get0(s, a));
    fake.onSet = (s) => calls.push(s);

    items.set(
      key,
      JSON.stringify({ claudeAiOauth: { accessToken: "velho", refreshToken: "rt", expiresAt: 1 }, mcpOAuth: { x: 1 }, pluginSecrets: { p: "segredo-do-plugin" } })
    );
    fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "mais-velho", expiresAt: 0 }, soNoArquivo: 1 }));
    age(credFile, 120000);

    const novo = { accessToken: "novo", expiresAt: future() };
    assert.deepEqual(await auth.writeLive(novo), { store: "keychain" });
    assert.deepEqual(JSON.parse(items.get(key)), { claudeAiOauth: novo, mcpOAuth: { x: 1 }, pluginSecrets: { p: "segredo-do-plugin" } });
    const file = readJson(credFile);
    assert.deepEqual(file, { claudeAiOauth: novo, soNoArquivo: 1 }, "arquivo = o que ele tinha + o login novo");
    assert.equal("mcpOAuth" in file, false, "mcpOAuth do Keychain não vai para o disco");
    assert.equal("pluginSecrets" in file, false, "pluginSecrets do Keychain não vai para o disco");
    assert.ok(Date.now() - fs.statSync(credFile).mtimeMs < 5000, "mtime do arquivo reserva mudou (o Claude Code recarrega)");
    if (!isWin) assert.equal(modeOf(credFile), 0o600);

    // A cada writeLive o arquivo é regravado de novo.
    age(credFile, 120000);
    const novo2 = { accessToken: "novo2", expiresAt: future() };
    await auth.writeLive(novo2);
    assert.deepEqual(readJson(credFile), { claudeAiOauth: novo2, soNoArquivo: 1 });
    assert.ok(Date.now() - fs.statSync(credFile).mtimeMs < 5000);

    const live = await auth.readLive();
    assert.equal(live.source, "keychain");
    assert.deepEqual(live.claudeAiOauth, novo2);
    assert.ok(calls.every((s) => s === service), "só o serviço deste perfil");

    // Arquivo reserva ilegível: o Keychain é gravado e o arquivo fica como estava.
    fs.writeFileSync(credFile, "{ quebrado");
    await auth.writeLive({ accessToken: "novo3", expiresAt: future() });
    assert.equal(JSON.parse(items.get(key)).claudeAiOauth.accessToken, "novo3");
    assert.equal(fs.readFileSync(credFile, "utf8"), "{ quebrado");

    fs.unlinkSync(credFile);
    await auth.writeLive({ accessToken: "outro", expiresAt: future() });
    assert.equal(fs.existsSync(credFile), false, "no Mac nunca cria o arquivo reserva");

    fake.get = async () => {
      throw new Error("Keychain trancado");
    };
    const antes = items.get(key);
    await assert.rejects(auth.writeLive(novo), { code: "keychain_unavailable" });
    assert.equal(items.get(key), antes, "não grava às cegas");
    await assert.rejects(auth.readLive(), (e) => e.code === "live_unreadable" && e.reason === "keychain_unavailable");
  });
});

test("writeLive (macOS): Keychain vazio usa o arquivo reserva como base", async () => {
  const home = freshHome();
  await withFakeMac(home, async ({ items, key, credFile }) => {
    fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "do-arquivo", expiresAt: 1 }, mcpOAuth: { f: 1 } }));
    const novo = { accessToken: "novo", expiresAt: future() };
    await auth.writeLive(novo);
    assert.deepEqual(JSON.parse(items.get(key)), { claudeAiOauth: novo, mcpOAuth: { f: 1 } });
    assert.deepEqual(readJson(credFile), { claudeAiOauth: novo, mcpOAuth: { f: 1 } });
  });
});

test("Keychain: o segredo nunca vai nos argumentos do `security`: hex pelo stdin; longo vai como texto (-w); grande demais → erro", () => {
  const value = JSON.stringify({ claudeAiOauth: { accessToken: "segredo", expiresAt: 1 } });
  const c = auth._test.securityAddCommand("paulo", "Claude Code-credentials", value);
  assert.equal(c.mode, "stdin");
  assert.equal(c.encoding, "hex");
  assert.deepEqual(c.args, ["-i"]);
  assert.ok(c.input.startsWith('add-generic-password -U -a "paulo" -s "Claude Code-credentials" -X '));
  assert.ok(!c.input.includes("segredo"), "o segredo só vai em hex");
  const hex = /-X ([0-9a-f]+)\n$/.exec(c.input)[1];
  assert.equal(Buffer.from(hex, "hex").toString("utf8"), value);

  // Em hex não cabe, como texto cabe: -w com aspas, ainda pelo stdin.
  const medio = JSON.stringify({
    claudeAiOauth: { accessToken: "sk-ant-oat01-" + "a".repeat(2500), expiresAt: 1 },
    mcpOAuth: { 'srv"x': { accessToken: 'barra\\e"aspas', nome: "João d'Ávila" } },
  });
  const m = auth._test.securityAddCommand("paulo", "Claude Code-credentials", medio);
  assert.equal(m.mode, "stdin");
  assert.equal(m.encoding, "text");
  assert.deepEqual(m.args, ["-i"], "nada do segredo nos argumentos");
  assert.ok(Buffer.byteLength(m.input, "utf8") <= auth._test.lineLimit);
  assert.equal(m.input.indexOf("\n"), m.input.length - 1, "uma linha só");
  assert.deepEqual(securityWords(m.input), ["add-generic-password", "-U", "-a", "paulo", "-s", "Claude Code-credentials", "-w", medio]);

  // Nem como texto cabe: erro, sem cair na linha de comando.
  assert.throws(() => auth._test.securityAddCommand("paulo", "Claude Code-credentials", "x".repeat(5000)), { code: "keychain_payload_too_large" });

  const q = auth._test.securityAddCommand('pa"u\\lo', "s", "v");
  assert.ok(q.input.includes('-a "pa\\"u\\\\lo"'));
  assert.equal(securityWords(q.input)[3], 'pa"u\\lo');
});

test("Keychain: CR/LF (e NUL) recusados na linha do `security -i`", () => {
  for (const bad of ["pa\nulo", "pa\rulo", "pa\0ulo", "paulo\r\n"]) {
    assert.throws(() => auth._test.securityAddCommand(bad, "s", "v"), { code: "keychain_bad_value" }, JSON.stringify(bad));
    assert.throws(() => auth._test.securityAddCommand("paulo", bad, "v"), { code: "keychain_bad_value" }, JSON.stringify(bad));
    assert.throws(() => auth._test.quoteSecurity(bad), { code: "keychain_bad_value" });
  }
  // Em hex a quebra de linha do valor não importa; como texto (-w), é recusada.
  assert.equal(auth._test.securityAddCommand("paulo", "s", "a\nb").encoding, "hex");
  assert.throws(() => auth._test.securityAddCommand("paulo", "s", "x".repeat(2100) + "\n"), { code: "keychain_bad_value" });
});

test("Keychain: login grande demais → keychain_payload_too_large sem gravar nada", async () => {
  const home = freshHome();
  await withFakeMac(home, async ({ items, key, fake, credFile }) => {
    const grande = { claudeAiOauth: { accessToken: "velho", expiresAt: 1 }, mcpOAuth: { srv: { accessToken: "t".repeat(5000) } } };
    items.set(key, JSON.stringify(grande));
    fs.writeFileSync(credFile, JSON.stringify({ claudeAiOauth: { accessToken: "velho", expiresAt: 1 } }));
    const arquivoAntes = fs.readFileSync(credFile, "utf8");
    await assert.rejects(auth.writeLive({ accessToken: "novo", expiresAt: future() }), { code: "keychain_payload_too_large" });
    assert.equal(fake.sets, 0, "o Keychain não foi chamado");
    assert.equal(items.get(key), JSON.stringify(grande));
    assert.equal(fs.readFileSync(credFile, "utf8"), arquivoAntes, "nem o arquivo reserva");
    for (const d of allLockDirs()) assert.equal(fs.existsSync(d), false, `trava não liberada: ${d}`);
  });
});

test("Keychain: mensagem de erro do `security` só traz código/sinal (nunca a mensagem do processo)", () => {
  const hex = Buffer.from('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-segredo"}}').toString("hex");
  const cmdErr = Object.assign(new Error(`Command failed: /usr/bin/security add-generic-password -X ${hex}`), { code: 1 });
  const e1 = auth._test.securityError("add-generic-password", { code: 1, stderr: `falhou ${hex}`, err: cmdErr, timedOut: false });
  assert.equal(e1.code, "keychain_error");
  assert.match(e1.message, /código 1/);
  const sigErr = Object.assign(new Error(`killed ${hex}`), { code: null, signal: "SIGKILL" });
  const e2 = auth._test.securityError("find-generic-password", { code: -1, stderr: hex, err: sigErr, timedOut: false });
  assert.match(e2.message, /SIGKILL/);
  const e3 = auth._test.securityError("x", { code: -1, stderr: "", err: Object.assign(new Error(`spawn ${hex}`), { code: "ENOENT" }), timedOut: false });
  assert.match(e3.message, /ENOENT/);
  const e4 = auth._test.securityError("x", { code: -1, stderr: "", err: Object.assign(new Error("x"), { code: hex }), timedOut: false });
  const e5 = auth._test.securityError("x", { code: -1, stderr: hex, err: Object.assign(new Error(hex), { killed: true }), timedOut: true });
  assert.match(e5.message, /demorou/);
  for (const e of [e1, e2, e3, e4, e5]) {
    assert.ok(!e.message.includes(hex) && !e.message.includes("segredo"), e.message);
    assert.equal(e.cause, undefined);
  }
});

// ================================================================ claudeAuth: avisos

test("credentialStoreWarnings: variáveis que passam na frente e o Gerenciador de Credenciais do Windows", () => {
  const home = freshHome();
  try {
    assert.deepEqual(auth.credentialStoreWarnings(), []);
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-ant-oat01-segredo";
    process.env.ANTHROPIC_API_KEY = "sk-ant-api03-segredo";
    const w = auth.credentialStoreWarnings();
    assert.equal(w.length, 2);
    assert.match(w[0], /CLAUDE_CODE_OAUTH_TOKEN/);
    assert.match(w[1], /ANTHROPIC_API_KEY/);
    assert.ok(w.every((s) => typeof s === "string" && !s.includes("segredo")), "nunca mostra o valor");
    delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;

    process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
    auth._test.setPlatform("linux");
    assert.deepEqual(auth.credentialStoreWarnings(), [], "fora do Windows não se aplica");
    auth._test.setPlatform("win32");
    const w2 = auth.credentialStoreWarnings();
    assert.equal(w2.length, 1);
    assert.match(w2[0], /Gerenciador de Credenciais do Windows/);
    assert.match(w2[0], /ignorada/);
    delete process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN;
    assert.deepEqual(auth.credentialStoreWarnings(), [], "sem variável e sem ~/.claude.json");

    const cfg = path.join(home, ".claude.json");
    assert.equal(auth.globalConfigPath(), cfg);
    const casos = [
      [{ cachedGrowthBookFeatures: { tengu_windows_credman: true } }, 1],
      [{ cachedStatsigGates: { tengu_windows_credman: true } }, 1],
      [{ cachedGrowthBookFeatures: { tengu_windows_credman: { value: true } } }, 1],
      [{ cachedGrowthBookFeatures: { outro: 1, grupo: { tengu_windows_credman: "true" } } }, 1],
      [{ cachedGrowthBookFeatures: { tengu_windows_credman: false } }, 0],
      [{ cachedStatsigGates: { outra_flag: true } }, 0],
      [{ projects: { tengu_windows_credman: true } }, 0], // fora de cache de recursos
      [[1, 2], 0],
    ];
    for (const [data, n] of casos) {
      fs.writeFileSync(cfg, JSON.stringify(data));
      assert.equal(auth.credentialStoreWarnings().length, n, JSON.stringify(data));
    }
    fs.writeFileSync(cfg, "{ quebrado");
    assert.deepEqual(auth.credentialStoreWarnings(), [], "JSON quebrado: sem aviso e sem lançar");
  } finally {
    auth._test.setPlatform(null);
    for (const k of WARN_ENV) delete process.env[k];
  }
});

// ================================================================ claudeAuth: ~/.claude.json

test("writeOauthAccount: troca só o oauthAccount, preserva o resto e as permissões; liveIdentity lê", async () => {
  const home = freshHome();
  const cfg = path.join(home, ".claude.json");
  assert.equal(auth.globalConfigPath(), cfg);
  const original = {
    numStartups: 7,
    projects: { "/x": { allowedTools: [] } },
    oauthAccount: { emailAddress: "a@exemplo.com", organizationUuid: "org-a" },
    userID: "u",
  };
  fs.writeFileSync(cfg, JSON.stringify(original, null, 2) + "\n");
  if (!isWin) fs.chmodSync(cfg, 0o644);

  const conta = { accountUuid: "acc-b", emailAddress: "B@Exemplo.com", organizationUuid: "org-b", organizationName: "Org B" };
  const r = await auth.writeOauthAccount(conta);
  assert.equal(r.changed, true);
  const text = fs.readFileSync(cfg, "utf8");
  const disk = JSON.parse(text);
  assert.deepEqual(disk, { ...original, oauthAccount: conta });
  assert.deepEqual(Object.keys(disk), Object.keys(original), "ordem das chaves mantida");
  assert.ok(text.endsWith("\n"));
  if (!isWin) assert.equal(modeOf(cfg), 0o644, "permissões preservadas");
  assert.deepEqual(await auth.liveIdentity(), { email: "b@exemplo.com", orgUuid: "org-b" });

  assert.equal((await auth.writeOauthAccount(conta)).changed, false, "igual: não regrava");
  assert.equal(fs.existsSync(auth._test.configLockDir()), false, "trava liberada");
  await assert.rejects(auth.writeOauthAccount({ organizationUuid: "x" }), { code: "bad_oauth_account" });
});

test("writeOauthAccount: recusa ~/.claude.json corrompido sem sobrescrever", async () => {
  const home = freshHome();
  const cfg = path.join(home, ".claude.json");
  for (const broken of ['{"projects": {"/x": ', "", "[1,2,3]", "null"]) {
    fs.writeFileSync(cfg, broken);
    await assert.rejects(
      auth.writeOauthAccount({ emailAddress: "a@b.c" }),
      (e) => e.code === "config_unreadable" && /não vou sobrescrever/.test(e.message),
      JSON.stringify(broken)
    );
    assert.equal(fs.readFileSync(cfg, "utf8"), broken, "arquivo intacto");
    assert.equal(fs.existsSync(auth._test.configLockDir()), false, "trava liberada");
  }
  assert.equal(await auth.liveIdentity(), null);
});

test("writeOauthAccount: cria 0600 quando não existe; grava através de link simbólico", async () => {
  const home = freshHome();
  const cfg = path.join(home, ".claude.json");
  assert.equal(await auth.liveIdentity(), null);
  await auth.writeOauthAccount({ emailAddress: "a@b.c" });
  assert.deepEqual(readJson(cfg), { oauthAccount: { emailAddress: "a@b.c" } });
  if (isWin) return; // link simbólico no Windows exige privilégio
  assert.equal(modeOf(cfg), 0o600);

  const real = path.join(home, "real-claude.json");
  fs.renameSync(cfg, real);
  fs.symlinkSync(real, cfg);
  await auth.writeOauthAccount({ emailAddress: "z@b.c" });
  assert.ok(fs.lstatSync(cfg).isSymbolicLink(), "o link continua sendo link");
  assert.equal(readJson(real).oauthAccount.emailAddress, "z@b.c");
});

test("globalConfigPath: usa o .config.json legado quando o Claude Code usaria", () => {
  const home = freshHome();
  assert.equal(auth.globalConfigPath(), path.join(home, ".claude.json"));
  fs.writeFileSync(path.join(home, ".config.json"), "{}");
  assert.equal(auth.globalConfigPath(), path.join(home, ".config.json"));
});

// ================================================================ travas

test("travas: velha (mais de 60 s) é tomada; as duas ficam seguras durante fn e somem depois", async () => {
  const home = freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  assert.equal(primary, path.join(home, ".oauth_refresh.lock"));
  assert.equal(legacy, home + ".lock");
  fs.mkdirSync(primary);
  age(primary, 120000);
  fs.mkdirSync(legacy);
  age(legacy, 90000);

  const t0 = Date.now();
  const v = await auth.withClaudeCredentialLocks(async () => {
    for (const d of [primary, legacy]) {
      assert.ok(fs.statSync(d).isDirectory());
      assert.ok(Date.now() - fs.statSync(d).mtimeMs < 5000, "trava retomada com mtime novo");
    }
    return 42;
  });
  assert.equal(v, 42);
  assert.ok(Date.now() - t0 < 3000, "não esperou o prazo");
  for (const d of [primary, legacy]) {
    assert.equal(fs.existsSync(d), false);
    assert.equal(fs.existsSync(d + ".takeover"), false);
  }
});

test("travas: a legada usa o caminho real de configHome (CLAUDE_CONFIG_DIR por link simbólico)", { skip: isWin && "link simbólico no Windows exige privilégio" }, async () => {
  const real = path.join(ROOT, `real-${++homeN}`);
  fs.mkdirSync(real);
  const link = path.join(ROOT, `link-${homeN}`);
  fs.symlinkSync(real, link);
  process.env.CLAUDE_CONFIG_DIR = link;
  assertInsideRoot();
  const [primary, legacy] = auth._test.credentialLockDirs();
  assert.equal(primary, path.join(link, ".oauth_refresh.lock"));
  assert.equal(legacy, real + ".lock", "realpath(configHome) + .lock, como o proper-lockfile do Claude Code");
  await auth.withClaudeCredentialLocks(async () => {
    assert.ok(fs.existsSync(real + ".lock"));
    assert.equal(fs.existsSync(link + ".lock"), false);
  });
  assert.equal(fs.existsSync(real + ".lock"), false);

  // configHome que ainda não existe: resolve a pasta-mãe.
  const novo = path.join(link, "ainda-nao-existe");
  process.env.CLAUDE_CONFIG_DIR = novo;
  assert.equal(auth._test.credentialLockDirs()[1], path.join(real, "ainda-nao-existe") + ".lock");
});

test("travas: nova (de outro processo) faz esperar até ser liberada", async () => {
  freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  fs.mkdirSync(primary);
  const t0 = Date.now();
  setTimeout(() => fs.rmdirSync(primary), 700);
  let waited = -1;
  await auth.withClaudeCredentialLocks(async () => {
    waited = Date.now() - t0;
  });
  assert.ok(waited >= 650, `esperou só ${waited} ms`);
  assert.ok(waited < 5000, `esperou demais: ${waited} ms`);
  assert.equal(fs.existsSync(primary), false);
  assert.equal(fs.existsSync(legacy), false);
});

test("travas: a do login com 20 s não é roubada (limite 60 s) e dá lock_timeout", async () => {
  freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  fs.mkdirSync(primary);
  age(primary, 20000);
  const saved = auth._test.timings.waitMs;
  auth._test.timings.waitMs = 700;
  try {
    let ran = false;
    const t0 = Date.now();
    await assert.rejects(
      auth.withClaudeCredentialLocks(async () => {
        ran = true;
      }),
      (e) => e.code === "lock_timeout" && e.lockPath === primary && /alguns segundos/.test(e.message)
    );
    assert.equal(ran, false);
    assert.ok(Date.now() - t0 >= 600);
    assert.ok(fs.existsSync(primary), "não roubou a trava");
    assert.equal(fs.existsSync(legacy), false, "nem pegou a legada");
  } finally {
    auth._test.timings.waitMs = saved;
    fs.rmdirSync(primary);
  }
});

test("travas: libera no finally (erro em fn, e a 1ª quando a 2ª não sai)", async () => {
  freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  await assert.rejects(
    auth.withClaudeCredentialLocks(async () => {
      assert.ok(fs.existsSync(primary) && fs.existsSync(legacy));
      throw new Error("falhou de propósito");
    }),
    /falhou de propósito/
  );
  assert.equal(fs.existsSync(primary), false);
  assert.equal(fs.existsSync(legacy), false);

  fs.mkdirSync(legacy); // legada ocupada (nova)
  const saved = auth._test.timings.waitMs;
  auth._test.timings.waitMs = 700;
  try {
    await assert.rejects(auth.withClaudeCredentialLocks(async () => {}), (e) => e.code === "lock_timeout" && e.lockPath === legacy);
    assert.equal(fs.existsSync(primary), false, "a primária foi devolvida");
    assert.ok(fs.existsSync(legacy));
  } finally {
    auth._test.timings.waitMs = saved;
    fs.rmdirSync(legacy);
  }
});

test("travas: quem segura atualiza o mtime", async () => {
  freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  const saved = auth._test.timings.touchMs;
  auth._test.timings.touchMs = 100;
  try {
    await auth.withClaudeCredentialLocks(async () => {
      age(primary, 30000);
      age(legacy, 30000);
      await sleep(450);
      assert.ok(Date.now() - fs.statSync(primary).mtimeMs < 2000, "primária não foi tocada");
      assert.ok(Date.now() - fs.statSync(legacy).mtimeMs < 2000, "legada não foi tocada");
    });
  } finally {
    auth._test.timings.touchMs = saved;
  }
});

test("travas: trava trocada por outro processo (ex.: depois de o Mac dormir) não é renovada nem removida", async () => {
  freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  const antiga = primary + ".antiga";
  const saved = auth._test.timings.touchMs;
  auth._test.timings.touchMs = 100;
  try {
    await auth.withClaudeCredentialLocks(async () => {
      // Outro processo tomou a primária: a nossa saiu dali e ele criou outra no lugar.
      // (rename em vez de rmdir: o inode antigo continua ocupado, então a nova é outra pasta)
      fs.renameSync(primary, antiga);
      fs.mkdirSync(primary);
      age(primary, 30000);
      await sleep(450);
      assert.ok(Date.now() - fs.statSync(primary).mtimeMs > 20000, "não pode renovar a trava dos outros");
    });
    assert.ok(fs.existsSync(primary), "a trava do outro não pode ser removida");
    assert.equal(fs.existsSync(legacy), false, "a nossa (legada) foi liberada");
  } finally {
    auth._test.timings.touchMs = saved;
    fs.rmSync(primary, { recursive: true, force: true });
    fs.rmSync(antiga, { recursive: true, force: true });
  }
});

test("travas: writeLive dentro de withClaudeCredentialLocks não trava em si mesmo", async () => {
  const home = freshHome();
  const t0 = Date.now();
  await auth.withClaudeCredentialLocks(() => auth.writeLive({ accessToken: "x", expiresAt: future() }));
  assert.ok(Date.now() - t0 < 3000);
  assert.ok(fs.existsSync(path.join(home, ".credentials.json")));
  for (const d of allLockDirs()) assert.equal(fs.existsSync(d), false, `trava não liberada: ${d}`);
});

test("travas: callback que roda depois da liberação NÃO herda as travas", async () => {
  const home = freshHome();
  const [primary] = auth._test.credentialLockDirs();
  let open;
  const gate = new Promise((r) => (open = r));
  let later;
  await auth.withClaudeCredentialLocks(async () => {
    // Promessa solta: o callback roda no contexto daqui, mas só depois da liberação.
    later = gate.then(() => auth.writeLive({ accessToken: "depois", expiresAt: future() }));
    later.catch(() => {});
  });
  fs.mkdirSync(primary); // outro processo pega a trava depois que liberamos
  const saved = auth._test.timings.waitMs;
  auth._test.timings.waitMs = 700;
  try {
    open();
    await assert.rejects(later, (e) => e.code === "lock_timeout" && e.lockPath === primary);
    assert.equal(fs.existsSync(path.join(home, ".credentials.json")), false, "não gravou sem a trava");
  } finally {
    auth._test.timings.waitMs = saved;
    fs.rmdirSync(primary);
  }
});

test("travas: writeLive grava sob .oauth_refresh.lock, a legada e .storage-write.lock (sem .owner); solta tudo", async () => {
  const home = freshHome();
  const [primary, legacy] = auth._test.credentialLockDirs();
  const storage = auth._test.storageWriteLockDir();
  assert.equal(storage, path.join(home, ".storage-write.lock"));
  await withFakeMac(home, async ({ fake }) => {
    let seen = null;
    fake.onSet = () => {
      seen = [primary, legacy, storage].map((d) => fs.existsSync(d));
    };
    await auth.writeLive({ accessToken: "a", expiresAt: future() });
    assert.deepEqual(seen, [true, true, true], "as três seguras durante a gravação");
  });
  for (const d of [primary, legacy, storage]) assert.equal(fs.existsSync(d), false, `trava não liberada: ${d}`);
  assert.equal(fs.existsSync(primary + ".owner"), false, "nunca cria o .owner");
  assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith(".owner")), []);
});

test("travas: .storage-write.lock é velha com 15 s; nova faz writeLive desistir sem gravar", async () => {
  const home = freshHome();
  const credFile = path.join(home, ".credentials.json");
  const storage = auth._test.storageWriteLockDir();
  fs.mkdirSync(storage);
  age(storage, 20000);
  await auth.writeLive({ accessToken: "a", expiresAt: future() });
  assert.equal(fs.existsSync(storage), false);
  assert.equal(readJson(credFile).claudeAiOauth.accessToken, "a");

  const antes = fs.readFileSync(credFile, "utf8");
  fs.mkdirSync(storage);
  age(storage, 5000);
  const saved = auth._test.timings.waitMs;
  auth._test.timings.waitMs = 700;
  try {
    await assert.rejects(auth.writeLive({ accessToken: "b", expiresAt: future() }), (e) => e.code === "lock_timeout" && e.lockPath === storage);
    assert.equal(fs.readFileSync(credFile, "utf8"), antes, "nada gravado");
    for (const d of auth._test.credentialLockDirs()) assert.equal(fs.existsSync(d), false, `trava não devolvida: ${d}`);
    assert.ok(fs.existsSync(storage), "a trava do outro continua");
  } finally {
    auth._test.timings.waitMs = saved;
    fs.rmdirSync(storage);
  }
});

test("travas: ~/.claude.json.lock é velha com 10 s; nova faz writeOauthAccount desistir sem gravar", async () => {
  const home = freshHome();
  const cfg = path.join(home, ".claude.json");
  const lock = auth._test.configLockDir();
  assert.equal(lock, cfg + ".lock");
  fs.mkdirSync(lock);
  age(lock, 20000);
  await auth.writeOauthAccount({ emailAddress: "a@b.c" });
  assert.equal(fs.existsSync(lock), false);

  fs.mkdirSync(lock);
  age(lock, 3000);
  const saved = auth._test.timings.waitMs;
  auth._test.timings.waitMs = 700;
  try {
    await assert.rejects(auth.writeOauthAccount({ emailAddress: "z@b.c" }), { code: "lock_timeout" });
    assert.equal(readJson(cfg).oauthAccount.emailAddress, "a@b.c");
  } finally {
    auth._test.timings.waitMs = saved;
    fs.rmdirSync(lock);
  }
});

// ================================================================ serverClient

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}
function closeServer(server) {
  if (server.closeAllConnections) server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

/** Servidor de mentira: registra o que recebeu e responde como a API. */
function handler(seen) {
  return (req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body });
      const send = (status, obj, raw) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(raw !== undefined ? raw : JSON.stringify(obj));
      };
      const route = req.url.replace(/^\/base/, "");
      if (route === "/v1/health") return send(200, { ok: true, version: "teste" });
      if (route === "/v1/pair" && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        if (b.code === "ABCDEFGHJK") return send(200, { deviceId: "dev-1", token: "tok-1" });
        return send(401, { error: "bad_code", message: "Código de pareamento inválido ou vencido." });
      }
      if (route === "/v1/login/start" && req.method === "POST") {
        const b = JSON.parse(body || "{}");
        const authUrl =
          b.name === "http-fora" ? "http://login.exemplo.com/entrar" : b.name === "http-local" ? "http://127.0.0.1:1/entrar" : "https://accounts.google.com/o/oauth2/v2/auth?x=1";
        return send(200, { sessionId: "s-1", pollToken: "p-1", authUrl, expiresAt: Date.now() + 600000 });
      }
      if (route === "/v1/credential") return send(409, { error: "no_account", message: "Nenhuma conta atribuída a este computador." });
      if (route === "/v1/echo") return send(200, { got: JSON.parse(body || "null") });
      if (route === "/v1/texto") return send(200, null, "<html>oi</html>");
      if (route === "/v1/quebra") return send(500, null, "Internal Server Error");
      if (route === "/v1/lento") return; // nunca responde
      send(404, { error: "not_found", message: "Rota desconhecida." });
    });
  };
}

test("serverClient (http): JSON, prefixo de caminho, erros com .status e .code, pair, loginStart", async () => {
  const seen = [];
  const server = http.createServer(handler(seen));
  const port = await listen(server);
  const url = `http://127.0.0.1:${port}`;
  try {
    const c = createServerClient({ url, token: "tok-teste", tokenOrigin: url });
    assert.equal(c.origin, url);
    assert.deepEqual(await c.request("GET", "/v1/health"), { ok: true, version: "teste" });
    assert.equal(seen.at(-1).auth, "Bearer tok-teste");
    assert.deepEqual(await c.request("POST", "/v1/echo", { a: [1, "ç"] }), { got: { a: [1, "ç"] } });

    const comBase = createServerClient({ url: url + "/base/", token: "t", tokenOrigin: url });
    assert.deepEqual(await comBase.request("GET", "v1/health"), { ok: true, version: "teste" });
    assert.equal(seen.at(-1).url, "/base/v1/health");

    await assert.rejects(c.request("GET", "/v1/credential"), (e) => e.status === 409 && e.code === "no_account" && /Nenhuma conta/.test(e.message));
    await assert.rejects(c.request("GET", "/v1/texto"), (e) => e.code === "bad_response" && e.status === 200);
    await assert.rejects(c.request("GET", "/v1/quebra"), (e) => e.status === 500 && e.code === "http_500" && /Erro no servidor/.test(e.message));
    await assert.rejects(
      createServerClient({ url, timeoutMs: 300 }).request("GET", "/v1/lento"),
      (e) => e.code === "timeout" && e.status === 0
    );

    assert.deepEqual(await pair({ url, code: "ABCDEFGHJK", name: "Mac do teste", platform: "darwin" }), { deviceId: "dev-1", token: "tok-1" });
    assert.equal(seen.at(-1).auth, null, "pareamento vai sem token");
    assert.deepEqual(JSON.parse(seen.at(-1).body), { code: "ABCDEFGHJK", name: "Mac do teste", platform: "darwin" });
    await assert.rejects(pair({ url, code: "ERRADO", name: "x", platform: "linux" }), (e) => e.status === 401 && e.code === "bad_code");

    const ls = await loginStart({ url, name: "ok", platform: "linux" });
    assert.equal(ls.authUrl, "https://accounts.google.com/o/oauth2/v2/auth?x=1");
    assert.equal((await loginStart({ url, name: "http-local", platform: "linux" })).authUrl, "http://127.0.0.1:1/entrar");
    await assert.rejects(loginStart({ url, name: "http-fora", platform: "linux" }), { code: "bad_response" }, "authUrl http:// fora do localhost");
  } finally {
    await closeServer(server);
  }

  await assert.rejects(createServerClient({ url: "http://127.0.0.1:1" }).request("GET", "/v1/health"), (e) => e.code === "network" && e.status === 0);
  assert.throws(() => createServerClient({ url: "http://127.0.0.1:1", fp: randomFp() }), { code: "bad_url" });
  assert.throws(() => createServerClient({ url: "https://127.0.0.1:1", fp: "AA:BB" }), { code: "bad_fp" });
  assert.throws(() => createServerClient({ url: "nada" }), { code: "bad_url" });
});

test("serverClient: não segue redirecionamento (o token não vai para outro host)", async () => {
  const seenOther = [];
  const other = http.createServer(handler(seenOther));
  const otherPort = await listen(other);
  const redir = http.createServer((req, res) => {
    req.resume();
    res.writeHead(302, { Location: `http://127.0.0.1:${otherPort}/v1/health` });
    res.end();
  });
  const port = await listen(redir);
  try {
    const url = `http://127.0.0.1:${port}`;
    await assert.rejects(
      createServerClient({ url, token: "tok-segredo", tokenOrigin: url }).request("GET", "/v1/health"),
      (e) => e.status === 302 && e.code === "http_302" && /redirecionamento/.test(e.message) && !e.message.includes("tok-segredo")
    );
    await sleep(100);
    assert.equal(seenOther.length, 0, "o outro servidor não recebeu nada");
  } finally {
    await closeServer(redir);
    await closeServer(other);
  }
});

// Certificado próprio gerado na hora pelo openssl (o mesmo tipo de cert do servidor).
let tlsMaterial = null;
let tlsSkip = false;
try {
  const dir = fs.mkdtempSync(path.join(ROOT, "tls-"));
  const key = path.join(dir, "key.pem");
  const cert = path.join(dir, "cert.pem");
  execFileSync(
    "openssl",
    ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=swap-plus-teste"],
    { stdio: "ignore", timeout: 30000 }
  );
  tlsMaterial = { key: fs.readFileSync(key), cert: fs.readFileSync(cert) };
} catch (e) {
  tlsSkip = `openssl indisponível para gerar o certificado de teste (${e.code || e.message})`;
}

test("serverClient (https com certificado próprio): impressão digital fixada", { skip: tlsSkip }, async (t) => {
  const seen = [];
  const server = https.createServer(tlsMaterial, handler(seen));
  const port = await listen(server);
  const url = `https://127.0.0.1:${port}`;
  const fp = new crypto.X509Certificate(tlsMaterial.cert).fingerprint256;
  try {
    await t.test("impressão digital certa: responde e manda o token", async () => {
      const c = createServerClient({ url, token: "tok-teste", fp, tokenOrigin: url });
      assert.deepEqual(await c.request("GET", "/v1/health"), { ok: true, version: "teste" });
      assert.equal(seen.at(-1).auth, "Bearer tok-teste");
      const lower = createServerClient({ url, token: "tok-teste", fp: fp.toLowerCase(), tokenOrigin: url });
      assert.deepEqual(await lower.request("GET", "/v1/health"), { ok: true, version: "teste" });
    });

    await t.test("impressão digital diferente: recusa sem enviar nenhum pedido", async () => {
      let wrong;
      do wrong = randomFp();
      while (wrong === fp);
      const before = seen.length;
      await assert.rejects(
        createServerClient({ url, token: "tok-teste", fp: wrong, tokenOrigin: url }).request("POST", "/v1/echo", { segredo: 1 }),
        (e) => e.code === "fingerprint_mismatch" && e.status === 0 && !e.message.includes("tok-teste")
      );
      assert.equal(seen.length, before, "o servidor não pode ter recebido o pedido");
    });

    await t.test("sem impressão digital: validação TLS normal recusa o certificado próprio", async () => {
      const before = seen.length;
      await assert.rejects(createServerClient({ url, token: "tok-teste", tokenOrigin: url }).request("GET", "/v1/health"), (e) => e.code === "tls" && e.status === 0);
      assert.equal(seen.length, before);
    });

    await t.test("origem diferente: nada sai, nem com a impressão digital certa", () => {
      const before = seen.length;
      assert.throws(() => createServerClient({ url, token: "tok-teste", fp, tokenOrigin: "https://outro.exemplo.com" }), { code: "origin_mismatch" });
      assert.equal(seen.length, before);
    });

    await t.test("código de conexão → pair pelo canal fixado", async () => {
      const code = "swapplus1:" + b64({ url, code: "ABCDEFGHJK", fp });
      const parsed = parseConnectCode(code);
      assert.deepEqual(await pair({ ...parsed, name: "PC de teste", platform: "win32" }), { deviceId: "dev-1", token: "tok-1" });
      await assert.rejects(pair({ ...parsed, fp: randomFp(), name: "x", platform: "x" }), { code: "fingerprint_mismatch" });
    });
  } finally {
    await closeServer(server);
  }
});
