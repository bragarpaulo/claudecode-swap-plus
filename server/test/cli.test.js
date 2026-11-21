"use strict";
// Testes da linha de comando do servidor (server/src/cli.js): os textos que ela escreve.
// O cli.js só fala com o admin local (http://127.0.0.1:ADMIN_PORT); aqui ele é um servidor HTTP de mentira numa
// porta livre, e cada comando roda num processo de verdade (node cli.js ...).
//
//   node --test server/test/cli.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const { execFile } = require("node:child_process");

const CLI = path.join(__dirname, "..", "src", "cli.js");
const MIN = 60 * 1000;

/** Roda `node cli.js ...args` → { code, stdout, stderr }. */
function run(args, port = 1) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { env: { ...process.env, ADMIN_PORT: String(port) }, timeout: 30000 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

/** Admin de mentira: responde o que o teste põe em `fake.replies` ("MÉTODO /caminho" → objeto, ou [status, objeto]). */
async function fakeAdmin(t) {
  const fake = { replies: {}, calls: [] };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const key = `${req.method} ${req.url}`;
      fake.calls.push({ key, body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null });
      const r = fake.replies[key];
      const [status, obj] = Array.isArray(r) && typeof r[0] === "number" ? r : [r === undefined ? 404 : 200, r === undefined ? { error: "not_found", message: "rota não encontrada" } : r];
      const body = JSON.stringify(obj);
      res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
      res.end(body);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => {
    server.closeAllConnections();
    server.close(() => resolve());
  }));
  fake.port = server.address().port;
  return fake;
}

const DEVICES = [
  { id: "aa11bb22cc33", name: "VS Code do Paulo", platform: "win32", googleEmail: "dono@exemplo.com", createdAt: Date.now() - 9 * 24 * 60 * MIN, lastSeen: Date.now() - 2 * MIN, assigned: 2, current: false },
  { id: "aa99ff00ee11", name: "Hermes (servidor)", platform: "linux", googleEmail: null, createdAt: Date.now() - 3 * 24 * 60 * MIN, lastSeen: Date.now() - 3 * 60 * MIN, assigned: null, current: false },
];

test("cli: a ajuda fala em serviços e os comandos continuam com os mesmos nomes", async () => {
  for (const args of [[], ["help"], ["--help"], ["-h"]]) {
    const r = await run(args);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /^Uso: node server\/src\/cli\.js <comando>/);
    for (const linha of [
      "pair           gera um código de conexão (vale 10 min, uso único) para ligar um serviço",
      "status         estado do servidor, contas e serviços",
      "devices        lista os serviços conectados",
      "revoke <id>    desconecta um serviço (o token dele para de valer na hora);",
      "Login com Google (a pessoa conecta um serviço com a conta Google dela):",
      "O administrador também conecta serviços, sem precisar estar na lista abaixo.",
      "allow <email>  libera a conta Google a conectar serviços (quantos quiser); ela NÃO entra no painel",
      "deny <email>   tira a conta da lista: não conecta serviços novos; os já conectados com ela",
      "auto on|off    liga ou desliga a troca automática (vale para todos os serviços)",
    ]) {
      assert.ok(r.stdout.includes(linha), `falta na ajuda: ${linha}`);
    }
    for (const cmd of ["pair", "status", "devices", "revoke <id>", "allow <email>", "deny <email>", "allowed", "rule <chave> <valor>", "auto on|off", "login-expires <n> <data>", "resumo"]) {
      assert.match(r.stdout, new RegExp(`\\n  ${cmd.replace(/[|<>]/g, "\\$&")}\\s`), `comando ${cmd}`);
    }
    assert.ok(!/computador/i.test(r.stdout), "a ajuda não fala mais em computador");
  }
  const r = await run(["nao-existe"]);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /^Comando desconhecido: nao-existe\n\nUso: /);
});

test("cli: devices, status, pair e revoke escrevem “serviço” (lista, vazio, erros e sucesso)", async (t) => {
  const fake = await fakeAdmin(t);
  const out = [];
  const go = async (...args) => {
    const r = await run(args, fake.port);
    out.push(r.stdout, r.stderr);
    return r;
  };

  // devices
  fake.replies["GET /admin/devices"] = DEVICES;
  let r = await go("devices");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Serviços conectados \(2\):\n  aa11bb22cc33  VS Code do Paulo\n      win32 · conta 2 · visto há 2 min · conectado em \d\d\/\d\d \d\d:\d\d · com a conta Google dono@exemplo\.com\n  aa99ff00ee11  Hermes \(servidor\)\n      linux · sem conta · visto há 3 h · conectado em \d\d\/\d\d \d\d:\d\d · por código de conexão\n\nPara desconectar um: node server\/src\/cli\.js revoke <id>\n$/);
  fake.replies["GET /admin/devices"] = [];
  r = await go("devices");
  assert.equal(r.stdout, "Nenhum serviço conectado. Para ligar um: node server/src/cli.js pair\n");

  // status: sem contas e com dois serviços
  fake.replies["GET /admin/status"] = {
    ok: true,
    version: "9.9.9",
    serverTime: Date.now(),
    uptimeSec: 3700,
    tlsMode: "off",
    publicUrl: "https://swap.exemplo.com",
    fingerprint: null,
    allowIps: [],
    trustProxy: false,
    autoSwitch: true,
    rules: { sessionPct: 90, weeklyPct: 80, modelPct: 95, strategy: "max" },
    pairing: null,
    google: { enabled: true, adminEmails: [], allowedEmails: [], pendingLogins: 0 },
    accounts: [],
    devices: DEVICES,
    diag: {},
    history: [],
  };
  r = await go("status");
  assert.equal(r.code, 0, r.stderr);
  assert.ok(r.stdout.includes("Contas (0):\n  nenhuma ainda — conecte um serviço e envie os logins dele\n"), r.stdout);
  assert.ok(r.stdout.includes("\nServiços (2):\n  aa11bb22cc33  VS Code do Paulo (win32) · conta 2 · visto há 2 min · Google dono@exemplo.com\n  aa99ff00ee11  Hermes (servidor) (linux) · sem conta · visto há 3 h\n"), r.stdout);
  assert.ok(r.stdout.includes("Administrador: nenhum — ADMIN_EMAILS não definido: o painel web está DESLIGADO (os serviços seguem funcionando)"), r.stdout);
  fake.replies["GET /admin/status"].accounts = [{ number: 3, email: "c@exemplo.com", dead: "relogin_required", devices: [] }];
  fake.replies["GET /admin/status"].devices = [];
  r = await go("status");
  assert.ok(r.stdout.includes("PRECISA DE LOGIN NOVO (faça login com essa conta num serviço conectado)"), r.stdout);
  assert.ok(r.stdout.includes("\nServiços (0):\n  nenhum — rode: node server/src/cli.js pair\n"), r.stdout);

  // pair
  fake.replies["POST /admin/pair-code"] = { code: "ABCDE23456", connect: "swapplus1:xyz", url: "https://swap.exemplo.com", fp: null, expiresAt: Date.now() + 10 * MIN };
  r = await go("pair");
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /^Código de conexão \(vale 10 min, uso único — vale para UM serviço\):\n\nswapplus1:xyz\n/);
  assert.ok(r.stdout.includes("Código curto: ABCDE-23456 (válido até "));
  assert.ok(r.stdout.endsWith("Para outro serviço, rode o pair de novo (gerar um código novo invalida o anterior).\n"));

  // revoke: id que não existe, começo que serve para dois, e o que desconecta (basta o começo do id)
  fake.replies["GET /admin/devices"] = DEVICES;
  r = await go("revoke", "zz");
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Erro: nenhum serviço com id "zz" (veja os ids com: devices)\n');
  r = await go("revoke", "aa");
  assert.equal(r.code, 1);
  assert.equal(r.stderr, 'Erro: "aa" serve para mais de um serviço: aa11bb22cc33 (VS Code do Paulo), aa99ff00ee11 (Hermes (servidor))\n');
  fake.replies["DELETE /admin/devices/aa99ff00ee11"] = { ok: true };
  r = await go("revoke", "aa99");
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.stdout, 'Serviço "Hermes (servidor)" (aa99ff00ee11) desconectado. O token dele não vale mais.\n');
  assert.equal(fake.calls.at(-1).key, "DELETE /admin/devices/aa99ff00ee11");

  assert.ok(!/computador/i.test(out.join("\n")), "nenhuma saída fala mais em computador");
});

test("cli: allow, deny, allowed, rule e auto escrevem “serviço”", async (t) => {
  const fake = await fakeAdmin(t);
  const google = { enabled: true, offReason: null, callbackUrl: "https://swap.exemplo.com/auth/google/callback", adminEmails: ["dono@exemplo.com"], allowedEmails: ["bia@exemplo.com"], pendingLogins: 0 };
  const out = [];
  const go = async (...args) => {
    const r = await run(args, fake.port);
    assert.equal(r.code, 0, r.stderr);
    out.push(r.stdout);
    return r.stdout;
  };

  fake.replies["POST /admin/allow"] = { ok: true, email: "bia@exemplo.com", added: true, admin: false, google };
  assert.ok((await go("allow", "bia@exemplo.com")).startsWith("Conta Google bia@exemplo.com liberada: ela pode conectar serviços (quantos quiser). O painel web continua só do administrador.\n"));
  assert.deepEqual(fake.calls.at(-1), { key: "POST /admin/allow", body: { email: "bia@exemplo.com" } });
  fake.replies["POST /admin/allow"] = { ok: true, email: "dono@exemplo.com", added: false, admin: true, google };
  assert.equal(await go("allow", "dono@exemplo.com"), "dono@exemplo.com é o administrador (ADMIN_EMAILS): já conecta serviços e entra no painel, sem precisar estar na lista.\n");

  fake.replies["POST /admin/deny"] = { ok: true, email: "bia@exemplo.com", removed: true, devices: [{ id: "aa11bb22cc33", name: "Notebook da Bia" }], panelSessions: 0, google };
  assert.equal(
    await go("deny", "bia@exemplo.com"),
    "Conta Google bia@exemplo.com tirada da lista: ela não conecta mais serviços novos.\n\n" +
      "Serviços já conectados com ela (continuam funcionando até você desconectar):\n  aa11bb22cc33  Notebook da Bia\n" +
      "Para desconectar um: node server/src/cli.js revoke <id>\n"
  );

  fake.replies["GET /admin/allowed"] = google;
  assert.ok((await go("allowed")).includes("\nContas que podem conectar serviços (1; não entram no painel):\n  bia@exemplo.com\n"));
  fake.replies["GET /admin/allowed"] = { ...google, allowedEmails: [] };
  assert.ok((await go("allowed")).endsWith("Nenhuma conta Google liberada para conectar serviços. Para liberar: node server/src/cli.js allow pessoa@empresa.com\n"));

  fake.replies["PUT /admin/rules"] = { ok: true, rules: { devicePlacement: "together" }, autoSwitch: false };
  assert.equal(await go("rule", "devicePlacement", "together"), 'Regra devicePlacement = "together". Vale agora, para todos os serviços.\n');
  assert.deepEqual(fake.calls.at(-1), { key: "PUT /admin/rules", body: { rules: { devicePlacement: "together" } } });
  // 2.5.6: o mínimo de Fable no destino vai como número.
  fake.replies["PUT /admin/rules"] = { ok: true, rules: { preferMinFreePct: 20 }, autoSwitch: false };
  assert.equal(await go("rule", "preferMinFreePct", "20"), "Regra preferMinFreePct = 20. Vale agora, para todos os serviços.\n");
  assert.deepEqual(fake.calls.at(-1), { key: "PUT /admin/rules", body: { rules: { preferMinFreePct: 20 } } });
  assert.equal(await go("auto", "off"), "Troca automática desligada (vale para todos os serviços).\n");
  assert.deepEqual(fake.calls.at(-1), { key: "PUT /admin/rules", body: { autoSwitch: false } });

  assert.ok(!/computador/i.test(out.join("\n")), "nenhuma saída fala mais em computador");
});
