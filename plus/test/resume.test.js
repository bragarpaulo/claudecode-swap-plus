"use strict";
// Testes da retomada automática depois da troca de conta:
//   - resume.js: põe e tira o gancho no settings.json do Claude Code sem mexer no resto, copia o script, grava a opção
//     e o marcador de "login gravado";
//   - hooks/retomar.js: rodado como o Claude Code roda (stdin com o evento StopFailure, a caixa de entrada no
//     ambiente), contra uma caixa de entrada de mentira (um servidor de socket local).
// Tudo em pastas temporárias (SWAP_PLUS_DIR e CLAUDE_CONFIG_DIR): nada da pasta do usuário é lido nem escrito.
//
//   node --test plus/test/resume.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const resume = require("../resume");

const SCRIPT = path.join(__dirname, "..", "hooks", "retomar.js");
const isWin = process.platform === "win32";

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-retomar-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, "swap");
  const claude = path.join(root, "claude");
  fs.mkdirSync(claude, { recursive: true });
  return { root, dir, claude, settingsFile: path.join(claude, "settings.json") };
}

const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const NODE_CMD = (script) => ({ type: "command", command: "node", args: [script], async: true });

// ------------------------------------------------------------------ resume.js

test("sync ligado: cria o settings.json com o gancho StopFailure, copia o script e grava a opção", (t) => {
  const { dir, settingsFile } = tmp(t);
  const script = path.join(dir, "retomar.js");
  const r = resume.sync({ enabled: true, scriptSource: SCRIPT, settingsFile, dir, command: NODE_CMD(script) });
  assert.deepEqual(r, { enabled: true, installed: true, changed: true, error: null });
  assert.deepEqual(read(settingsFile), { hooks: { StopFailure: [{ hooks: [{ type: "command", command: "node", args: [script], async: true }] }] } });
  assert.equal(fs.readFileSync(script, "utf8"), fs.readFileSync(SCRIPT, "utf8"));
  assert.deepEqual(read(path.join(dir, "retomar.json")), { enabled: true, text: "Troquei de conta, pode continuar." });
  // De novo: nada muda (nem o arquivo é regravado).
  const before = fs.statSync(settingsFile).mtimeMs;
  const again = resume.sync({ enabled: true, scriptSource: SCRIPT, settingsFile, dir, command: NODE_CMD(script) });
  assert.deepEqual(again, { enabled: true, installed: true, changed: false, error: null });
  assert.equal(fs.statSync(settingsFile).mtimeMs, before);
});

test("sync preserva o que já existe no settings.json (outras chaves, outros ganchos, outro StopFailure) e guarda uma cópia", (t) => {
  const { dir, settingsFile } = tmp(t);
  const script = path.join(dir, "retomar.js");
  const original = {
    model: "fable",
    theme: "dark",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo antes" }] }],
      StopFailure: [{ matcher: "server_error", hooks: [{ type: "command", command: "echo do-usuario" }] }],
    },
  };
  const originalText = JSON.stringify(original, null, 4) + "\n";
  fs.writeFileSync(settingsFile, originalText);
  const r = resume.sync({ enabled: true, scriptSource: SCRIPT, settingsFile, dir, command: NODE_CMD(script) });
  assert.equal(r.error, null);
  assert.equal(r.installed, true);
  const now = read(settingsFile);
  assert.equal(now.model, "fable");
  assert.equal(now.theme, "dark");
  assert.deepEqual(now.hooks.PreToolUse, original.hooks.PreToolUse);
  assert.deepEqual(now.hooks.StopFailure, [...original.hooks.StopFailure, { hooks: [NODE_CMD(script)] }]);
  assert.equal(fs.readFileSync(settingsFile + ".antes-swap-plus", "utf8"), originalText, "cópia do arquivo como estava");

  // Desligado: sai só a nossa entrada; a cópia de antes não é sobrescrita.
  const off = resume.sync({ enabled: false, scriptSource: SCRIPT, settingsFile, dir });
  assert.deepEqual(off, { enabled: false, installed: false, changed: true, error: null });
  assert.deepEqual(read(settingsFile), original);
  assert.equal(fs.readFileSync(settingsFile + ".antes-swap-plus", "utf8"), originalText);
  assert.deepEqual(read(path.join(dir, "retomar.json")), { enabled: false, text: "Troquei de conta, pode continuar." });
});

test("sync desligado num settings.json que só tinha o nosso gancho: as listas vazias somem", (t) => {
  const { dir, settingsFile } = tmp(t);
  const script = path.join(dir, "retomar.js");
  fs.writeFileSync(settingsFile, JSON.stringify({ model: "fable" }, null, 2) + "\n");
  resume.sync({ enabled: true, scriptSource: SCRIPT, settingsFile, dir, command: NODE_CMD(script) });
  assert.ok(read(settingsFile).hooks.StopFailure);
  resume.sync({ enabled: false, scriptSource: SCRIPT, settingsFile, dir });
  assert.deepEqual(read(settingsFile), { model: "fable" });
  // Desligado e sem settings.json: não cria o arquivo.
  fs.rmSync(settingsFile);
  const r = resume.sync({ enabled: false, scriptSource: SCRIPT, settingsFile, dir });
  assert.equal(r.error, null);
  assert.equal(fs.existsSync(settingsFile), false);
});

test("sync troca a entrada antiga pela nova (caminho ou forma do comando mudou) sem duplicar", (t) => {
  const { dir, settingsFile } = tmp(t);
  const script = path.join(dir, "retomar.js");
  const old = { type: "command", command: `ELECTRON_RUN_AS_NODE=1 '/Applications/Code.app/Electron' '/Users/p/.swap-plus/retomar.js'`, async: true };
  fs.writeFileSync(settingsFile, JSON.stringify({ hooks: { StopFailure: [{ hooks: [old] }, { hooks: [{ type: "command", command: "echo outro" }] }] } }));
  const r = resume.sync({ enabled: true, scriptSource: SCRIPT, settingsFile, dir, command: NODE_CMD(script) });
  assert.equal(r.changed, true);
  assert.deepEqual(read(settingsFile).hooks.StopFailure, [{ hooks: [{ type: "command", command: "echo outro" }] }, { hooks: [NODE_CMD(script)] }]);
});

test("settings.json que não é JSON válido (ou não é objeto): não mexe, e diz por quê", (t) => {
  const { dir, settingsFile } = tmp(t);
  for (const bad of ["{ isto não é json", "[1, 2]", '"texto"']) {
    fs.writeFileSync(settingsFile, bad);
    const r = resume.sync({ enabled: true, scriptSource: SCRIPT, settingsFile, dir });
    assert.equal(r.installed, false);
    assert.equal(r.error.code, "invalid_settings");
    assert.match(r.error.message, /não mexi nele/);
    assert.equal(fs.readFileSync(settingsFile, "utf8"), bad, "o arquivo ficou como estava");
  }
});

test("o texto da opção: aparado, no máximo 300 caracteres; vazio vira o padrão", (t) => {
  const { dir } = tmp(t);
  assert.equal(resume.writeConfig({ enabled: true, text: "  Conta nova, segue.  " }, dir), true);
  assert.deepEqual(read(path.join(dir, "retomar.json")), { enabled: true, text: "Conta nova, segue." });
  assert.equal(resume.writeConfig({ enabled: true, text: "Conta nova, segue." }, dir), false, "igual: não regrava");
  resume.writeConfig({ enabled: true, text: "x".repeat(500) }, dir);
  assert.equal(read(path.join(dir, "retomar.json")).text.length, 300);
  resume.writeConfig({ enabled: true, text: "   " }, dir);
  assert.equal(read(path.join(dir, "retomar.json")).text, resume.DEFAULT_TEXT);
});

test("hookCommand: `node` direto quando existe; senão o executável do VS Code no modo Node, pela shell do sistema", () => {
  assert.deepEqual(resume.hookCommand("/h/.swap-plus/retomar.js", { hasNode: true }), { type: "command", command: "node", args: ["/h/.swap-plus/retomar.js"], async: true });
  assert.deepEqual(resume.hookCommand("/Users/p/.swap-plus/retomar.js", { hasNode: false, platform: "darwin", execPath: "/Applications/Visual Studio Code.app/Contents/MacOS/Electron" }), {
    type: "command",
    command: "ELECTRON_RUN_AS_NODE=1 '/Applications/Visual Studio Code.app/Contents/MacOS/Electron' '/Users/p/.swap-plus/retomar.js'",
    async: true,
  });
  assert.equal(
    resume.hookCommand("C:\\Users\\O'Neil\\.swap-plus\\retomar.js", { hasNode: false, platform: "win32", execPath: "C:\\Program Files\\Microsoft VS Code\\Code.exe" }).command,
    "$env:ELECTRON_RUN_AS_NODE='1'; & 'C:\\Program Files\\Microsoft VS Code\\Code.exe' 'C:\\Users\\O''Neil\\.swap-plus\\retomar.js'"
  );
});

test("markApplied grava quando o login foi gravado; swapDir acompanha CLAUDE_CONFIG_DIR", (t) => {
  const { dir, claude } = tmp(t);
  const t0 = Date.now();
  assert.equal(resume.markApplied({ number: 6, gen: 28 }, dir), true);
  const m = read(path.join(dir, "aplicado.json"));
  assert.ok(m.at >= t0 && m.at <= Date.now());
  assert.equal(m.number, 6);
  assert.equal(m.gen, 28);
  const saved = { a: process.env.SWAP_PLUS_DIR, b: process.env.CLAUDE_CONFIG_DIR };
  t.after(() => {
    for (const [k, v] of [["SWAP_PLUS_DIR", saved.a], ["CLAUDE_CONFIG_DIR", saved.b]]) v === undefined ? delete process.env[k] : (process.env[k] = v);
  });
  delete process.env.SWAP_PLUS_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  assert.equal(resume.swapDir(), path.join(claude, "swap-plus"));
  delete process.env.CLAUDE_CONFIG_DIR;
  assert.equal(resume.swapDir(), path.join(os.homedir(), ".swap-plus"));
  process.env.SWAP_PLUS_DIR = dir;
  assert.equal(resume.swapDir(), dir);
});

// ------------------------------------------------------------------ hooks/retomar.js

/** Caixa de entrada de mentira: guarda as linhas de cada conexão. */
function inbox(t, root) {
  const sock = isWin ? `\\\\.\\pipe\\swap-plus-teste-${crypto.randomBytes(6).toString("hex")}` : path.join(root, "caixa.sock");
  const got = [];
  const server = net.createServer((c) => {
    let buf = "";
    c.on("data", (d) => (buf += d));
    c.on("end", () => got.push(buf.split("\n").filter(Boolean).map((l) => JSON.parse(l))));
    c.on("error", () => {});
  });
  t.after(() => new Promise((r) => server.close(() => r())));
  return new Promise((resolve) => server.listen(sock, () => resolve({ sock, got })));
}

/** Roda o script como o Claude Code roda: o evento no stdin, a caixa de entrada no ambiente. → { code, ms } */
function runHook({ dir, claude, input, sock, token = "tok-de-teste", waitMs = 4000, more = {} }) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, SWAP_PLUS_DIR: dir, CLAUDE_CONFIG_DIR: claude, SWAP_PLUS_RESUME_WAIT_MS: String(waitMs), SWAP_PLUS_RESUME_SETTLE_MS: "50", ...more };
    delete env.CLAUDE_CODE_MESSAGING_SOCKET;
    delete env.CLAUDE_CODE_MESSAGING_TOKEN;
    delete env.CLAUDE_CODE_SESSION_ID;
    if (sock) env.CLAUDE_CODE_MESSAGING_SOCKET = sock;
    if (sock && token) env.CLAUDE_CODE_MESSAGING_TOKEN = token;
    const t0 = Date.now();
    const p = spawn(process.execPath, [SCRIPT], { env, stdio: ["pipe", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("exit", (code) => resolve({ code, ms: Date.now() - t0, err }));
    p.stdin.end(JSON.stringify(input));
  });
}

const event = (session, error = "rate_limit") => ({ hook_event_name: "StopFailure", session_id: session, transcript_path: "/x/y.jsonl", cwd: "/x", error, last_assistant_message: "You've hit your limit" });
const sid = () => crypto.randomUUID();
const logOf = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, "retomar.log"), "utf8");
  } catch {
    return "";
  }
};
const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

test("retomar.js: limite batido e o Swap grava a conta nova → posta a autenticação e a mensagem na caixa de entrada da sessão", async (t) => {
  const { root, dir, claude } = tmp(t);
  const { sock, got } = await inbox(t, root);
  const session = sid();
  setTimeout(() => resume.markApplied({ number: 6, gen: 3 }, dir), 400); // a troca chega depois do erro
  const r = await runHook({ dir, claude, input: event(session), sock });
  await settle();
  assert.equal(r.code, 0, r.err);
  assert.equal(got.length, 1, "uma conexão");
  assert.deepEqual(got[0][0], { type: "auth", token: "tok-de-teste" });
  assert.equal(got[0][1].type, "user");
  assert.equal(got[0][1].message.role, "user");
  assert.match(got[0][1].message.content, /^Troquei de conta, pode continuar\.\n\n\(Mensagem automática do Swap Plus: a conta em uso bateu o limite/);
  assert.equal(got[0].length, 2);
  const log = logOf(dir);
  assert.match(log, new RegExp(`sessão ${session.slice(0, 8)} \\(rate_limit\\): conta gravada \\d+ s depois do erro; mensagem enviada`));
  assert.ok(!log.includes("tok-de-teste"), "o token não vai para o registro");

  // A conta nova também falha: o MESMO marcador não retoma de novo (não vira laço); só a próxima troca.
  const again = await runHook({ dir, claude, input: event(session), sock, waitMs: 1200 });
  await settle();
  assert.equal(again.code, 0);
  assert.equal(got.length, 1, "nada novo postado");
  assert.match(logOf(dir), /não trocou de conta em 1 s; nada enviado/);
  setTimeout(() => resume.markApplied({ number: 9, gen: 1 }, dir), 300);
  await runHook({ dir, claude, input: event(session), sock });
  await settle();
  assert.equal(got.length, 2, "troca nova: retoma");
});

test("retomar.js: troca gravada até 20 s ANTES do erro também vale; mais velha que isso, espera uma nova", async (t) => {
  const { root, dir, claude } = tmp(t);
  const { sock, got } = await inbox(t, root);
  fs.mkdirSync(dir, { recursive: true });
  const marker = path.join(dir, "aplicado.json");
  const at = (ms) => {
    fs.writeFileSync(marker, JSON.stringify({ at: ms, number: 1, gen: 1 }));
    fs.utimesSync(marker, ms / 1000, ms / 1000);
  };
  at(Date.now() - 5000);
  await runHook({ dir, claude, input: event(sid()), sock, waitMs: 1000 });
  await settle();
  assert.equal(got.length, 1, "5 s antes: vale");
  at(Date.now() - 60000);
  await runHook({ dir, claude, input: event(sid()), sock, waitMs: 1000 });
  await settle();
  assert.equal(got.length, 1, "1 min antes: não vale");
});

test("retomar.js: acesso cancelado e os outros erros DA CONTA retomam com o motivo certo; erro do servidor, do pedido ou do modelo não faz nada", async (t) => {
  const { root, dir, claude } = tmp(t);
  const { sock, got } = await inbox(t, root);
  resume.markApplied({ number: 6, gen: 4 }, dir);
  await runHook({ dir, claude, input: event(sid(), "authentication_failed"), sock });
  await settle();
  assert.equal(got.length, 1);
  assert.match(got[0][1].message.content, /o acesso da conta foi renovado ou trocado/);
  // Os outros erros da conta (cobrança, conta suspensa, organização não permitida) também retomam depois de um login novo.
  for (const error of ["billing_error", "account_on_hold", "oauth_org_not_allowed"]) {
    resume.markApplied({ number: 8, gen: 1 }, dir);
    await runHook({ dir, claude, input: event(sid(), error), sock });
  }
  await settle();
  assert.equal(got.length, 4);
  assert.match(got[3][1].message.content, /a conta em uso não podia mais atender/);
  for (const error of ["server_error", "invalid_request", "model_not_found", "max_output_tokens", "cloud_credential_error", "unknown", ""]) {
    resume.markApplied({ number: 7, gen: 1 }, dir);
    const r = await runHook({ dir, claude, input: event(sid(), error), sock, waitMs: 800 });
    assert.equal(r.code, 0);
    assert.ok(r.ms < 3000, `${error || "(vazio)"}: sai na hora, sem esperar`);
  }
  await settle();
  assert.equal(got.length, 4, "nada postado para os erros que não são da conta");
});

test("retomar.js: desligado na opção não posta; texto próprio vai no lugar do padrão", async (t) => {
  const { root, dir, claude } = tmp(t);
  const { sock, got } = await inbox(t, root);
  resume.writeConfig({ enabled: false, text: "" }, dir);
  resume.markApplied({ number: 6, gen: 4 }, dir);
  const off = await runHook({ dir, claude, input: event(sid()), sock, waitMs: 800 });
  await settle();
  assert.equal(off.code, 0);
  assert.equal(got.length, 0);
  resume.writeConfig({ enabled: true, text: "Conta nova, pode seguir." }, dir);
  resume.markApplied({ number: 6, gen: 5 }, dir);
  await runHook({ dir, claude, input: event(sid()), sock });
  await settle();
  assert.equal(got.length, 1);
  assert.match(got[0][1].message.content, /^Conta nova, pode seguir\.\n\n\(Mensagem automática do Swap Plus/);
});

test("retomar.js: sem caixa de entrada, sem troca no prazo, ou caixa fora do ar → sai limpo (código 0) e registra", async (t) => {
  const { dir, claude } = tmp(t);
  resume.markApplied({ number: 6, gen: 4 }, dir);
  const a = await runHook({ dir, claude, input: event(sid()), sock: null });
  assert.equal(a.code, 0);
  assert.match(logOf(dir), /esta sessão não tem caixa de entrada; nada enviado/);
  // Caixa que não existe (a sessão fechou): tenta, falha e registra.
  const gone = isWin ? "\\\\.\\pipe\\swap-plus-nao-existe-" + crypto.randomBytes(4).toString("hex") : path.join(dir, "nao-existe.sock");
  resume.markApplied({ number: 6, gen: 5 }, dir);
  const b = await runHook({ dir, claude, input: event(sid()), sock: gone });
  assert.equal(b.code, 0);
  assert.match(logOf(dir), /não consegui postar na caixa de entrada \(E[A-Z]+\)/);
  // Entrada que não é JSON: sai sem fazer nada.
  const c = await new Promise((resolve) => {
    const p = spawn(process.execPath, [SCRIPT], { env: { ...process.env, SWAP_PLUS_DIR: dir, CLAUDE_CONFIG_DIR: claude }, stdio: ["pipe", "ignore", "ignore"] });
    p.on("exit", (code) => resolve(code));
    p.stdin.end("isto não é json");
  });
  assert.equal(c, 0);
});

test("retomar.js: no máximo 6 retomadas por hora na mesma conversa", async (t) => {
  const { root, dir, claude } = tmp(t);
  const { sock, got } = await inbox(t, root);
  const session = sid();
  for (let i = 1; i <= 7; i++) {
    await settle(15);
    resume.markApplied({ number: i, gen: 1 }, dir); // uma troca nova a cada vez
    await runHook({ dir, claude, input: event(session), sock, waitMs: 800 });
  }
  await settle();
  assert.equal(got.length, 6);
  assert.match(logOf(dir), /já foram 6 retomadas nesta conversa na última hora; nada enviado/);
  t.after(() => fs.rmSync(path.join(os.tmpdir(), `swap-plus-retomar-${session}.json`), { force: true }));
});
