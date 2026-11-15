"use strict";
// Testes do modo servidor da extensão Swap Plus (node:test).
// Rodar (no servidor):  node --test plus/test/servermode.test.js
//
// - O módulo `vscode` é simulado (como no smoke.js): configurações, globalState,
//   cofre de segredos em memória, notificações registradas com respostas
//   automáticas configuráveis (objeto `ui`), env.openExternal registrando o endereço.
// - Um servidor HTTP FALSO em 127.0.0.1 implementa as rotas da SPEC
//   (server/SPEC.md) com respostas controláveis e registro de cada chamada.
//   Como `fp` só vale com https, a conexão é http://127.0.0.1:<porta> com fp null.
// - Segurança: HOME, CLAUDE_CONFIG_DIR e TMPDIR apontam para um temporário (o
//   teste aborta se algum caminho do claudeAuth cair fora dele) e o claudeAuth
//   grava em arquivo (_test.setStore("file")): nunca toca no Keychain, no
//   ~/.claude.json nem na credencial de verdade.
// - O `swap-plus` é um script Node falso. O teste redireciona o execFile desse
//   caminho para `node <script>`: assim ele roda mesmo com o temporário montado
//   sem permissão de execução (noexec — comum em servidores e containers), que
//   era o que fazia os cenários 1 (envio dos logins) e 7 (modo local) falharem
//   no servidor sem chamar o swap-plus.
// - createServerClient é observado (sem o token): todo cliente com token tem de
//   levar tokenOrigin, e o POST /v1/logins vai com timeout de 45 s.
// - Os cenários rodam em ordem; cada um prepara o próprio estado.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");
const util = require("node:util");
const crypto = require("node:crypto");

const PLUS = path.join(__dirname, "..");
const T_MAX = 60000; // limite por cenário

// ================================================================ ambiente temporário

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "swapplus-servermode-"));
const HOME = path.join(ROOT, "home");
const CLAUDE_DIR = path.join(HOME, ".claude");
const TMP = path.join(ROOT, "tmp");
const BIN = path.join(ROOT, "bin");
for (const d of [HOME, CLAUDE_DIR, TMP, BIN]) fs.mkdirSync(d, { recursive: true });

// As três últimas mudam os avisos do claudeAuth.credentialStoreWarnings() (o servidor de testes pode tê-las definidas).
const ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PATH",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN",
];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
for (const k of ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN"]) delete process.env[k];
process.env.HOME = HOME;
process.env.USERPROFILE = HOME;
process.env.CLAUDE_CONFIG_DIR = CLAUDE_DIR;
delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
process.env.TMPDIR = TMP;
process.env.TMP = TMP;
process.env.TEMP = TMP;
process.env.PATH = BIN + path.delimiter + (process.env.PATH || "");

// swap-plus falso: o execFile desse caminho vira `node <script>` (o script não precisa de permissão de execução).
const SWAP_PLUS_EXE = path.join(BIN, "swap-plus");
const childProcess = require("node:child_process");
const execFileOrig = childProcess.execFile;
childProcess.execFile = function (file, ...rest) {
  if (file === SWAP_PLUS_EXE) {
    const args = Array.isArray(rest[0]) ? rest.shift() : [];
    return execFileOrig.call(this, process.execPath, [SWAP_PLUS_EXE, ...args], ...rest);
  }
  return execFileOrig.call(this, file, ...rest);
};

const auth = require("../claudeAuth");
auth._test.setStore("file"); // nunca o Keychain

const dentro = (p) => path.resolve(String(p)).startsWith(ROOT + path.sep);
for (const p of [
  os.homedir(),
  os.tmpdir(),
  auth.configHome(),
  auth.globalConfigPath(),
  auth._test.credentialsPath(),
  auth._test.configLockDir(),
  ...auth._test.credentialLockDirs(),
]) {
  if (!dentro(p)) throw new Error(`caminho fora do temporário (teste abortado para não tocar em nada de verdade): ${p}`);
}

// ================================================================ segredos de teste

// Todo token de teste leva a marca "SEGREDO": o cenário 9 procura a marca e cada token.
const SEGREDOS = new Set();
function segredo(tipo) {
  const s = `sk-ant-${tipo}-SEGREDO-${crypto.randomBytes(24).toString("hex")}`;
  SEGREDOS.add(s);
  return s;
}

const DEVICE_ID = "dev-teste";
const DEVICE_TOKEN = segredo("disp");
const MCP = { "srv|abc123": { serverName: "srv", accessToken: segredo("mcp"), expiresAt: 123 } };
const EXP_BASE = Date.now() + 8 * 3600e3;
const expOf = (n, g) => EXP_BASE + n * 60000 + g * 1000;
const acessos = new Map();
function acessoServidor(n, g) {
  const k = `${n}|${g}`;
  if (!acessos.has(k)) acessos.set(k, segredo(`oat01-servidor-c${n}g${g}`));
  return acessos.get(k);
}
const oauthAccountOf = (n) => ({ accountUuid: `acc-${n}`, emailAddress: `conta${n}@exemplo.com`, organizationUuid: `org-${n}`, organizationName: `Org ${n}` });
const SCOPES = ["user:inference", "user:profile"];
const credOf = (n, g) => ({ accessToken: acessoServidor(n, g), expiresAt: expOf(n, g), scopes: SCOPES, subscriptionType: "max", rateLimitTier: "default_claude_max_20x" });

const ACESSO_LOCAL = segredo("oat01-local");
const REFRESH_LOCAL = segredo("ort01-local");

// Chaves que a extensão usa (constantes de plus/extension.js).
const TOKEN_KEY = "swapPlus.server.token";
const META_KEY = "swapPlus.server";
const APPLIED_KEY = "swapPlus.server.applied";
const SENT_KEY = "swapPlus.server.sentLogin";
const MIGRATED_KEY = "swapPlus.server.migrated";
const HISTORY_KEY = "swapPlus.autoHistory";

// ================================================================ logs

const logs = [];
const origConsole = {};
for (const m of ["log", "info", "warn", "error", "debug"]) {
  origConsole[m] = console[m];
  console[m] = (...a) => {
    logs.push(util.format(...a));
    if (process.env.SWAP_PLUS_DEBUG) origConsole[m](...a);
  };
}

// ================================================================ swap-plus falso

const LISTA_LOCAL = {
  schemaVersion: 1,
  activeAccountNumber: 1,
  accounts: [
    {
      number: 1,
      email: "local1@exemplo.com",
      organizationName: "Org L1",
      organizationUuid: "org-l1",
      plan: { label: "Max" },
      usageStatus: "ok",
      usageAgeSeconds: 10,
      usage: {
        fiveHour: { pct: 5, resetsAt: new Date(Date.now() + 2 * 3600e3).toISOString() },
        sevenDay: { pct: 10, resetsAt: new Date(Date.now() + 50 * 3600e3).toISOString() },
      },
    },
  ],
};
const EXPORT_LOCAL = {
  version: 1,
  accounts: [
    {
      number: 1,
      email: "local1@exemplo.com",
      organizationUuid: "org-l1",
      credentials: { claudeAiOauth: { accessToken: ACESSO_LOCAL, refreshToken: REFRESH_LOCAL, expiresAt: Date.now() + 8 * 3600e3, scopes: SCOPES } },
      config: { oauthAccount: { emailAddress: "local1@exemplo.com", organizationUuid: "org-l1", organizationName: "Org L1" } },
    },
  ],
};

const swapPlusFalso = (() => {
  const exe = SWAP_PLUS_EXE;
  const log = path.join(ROOT, "swap-plus.log");
  const listFile = path.join(ROOT, "lista-local.json");
  const exportFile = path.join(ROOT, "export-local.json");
  fs.writeFileSync(listFile, JSON.stringify(LISTA_LOCAL));
  fs.writeFileSync(exportFile, JSON.stringify(EXPORT_LOCAL));
  const J = (v) => JSON.stringify(v);
  fs.writeFileSync(
    exe,
    [
      "#!/usr/bin/env node",
      "// swap-plus falso (teste): anota a chamada e responde como o motor.",
      'const fs = require("fs");',
      "const a = process.argv.slice(2);",
      `fs.appendFileSync(${J(log)}, a.join(" ") + "\\n");`,
      "switch (a[0]) {",
      `  case "list": process.stdout.write(fs.readFileSync(${J(listFile)}, "utf8")); break;`,
      `  case "status": process.stdout.write(${J('{"schemaVersion":1,"active":null,"totalManagedAccounts":1}\n')}); break;`,
      `  case "export": fs.copyFileSync(${J(exportFile)}, a[1]); break;`,
      `  case "config": process.stdout.write(${J('{"settings":[]}\n')}); break;`,
      `  case "--version": process.stdout.write(${J("swap-plus 9.9.9\n")}); break;`,
      "}",
      "",
    ].join("\n"),
    { mode: 0o755 }
  );
  return {
    exe,
    calls: () => (fs.existsSync(log) ? fs.readFileSync(log, "utf8").split("\n").filter(Boolean) : []),
    limpar: () => fs.rmSync(log, { force: true }),
  };
})();

// ================================================================ servidor falso

function criarServidorFalso() {
  const f = { server: null, port: 0, url: "", calls: [] };
  let seq = 0;

  f.reset = () => {
    f.accounts = [1, 2];
    f.assigned = 1;
    f.gen = 1;
    f.autoSwitch = true;
    f.fail = {}; // "MÉTODO /caminho" → { status, body }: resposta forçada
    f.authStatus = null; // ex.: 401 → toda rota autenticada responde isso
    f.handlers = {}; // "MÉTODO /caminho" → (call) => { status, body }
    f.google = []; // respostas do /v1/login/poll: "pending" | "ok" | "denied" | async () => uma delas
    f.sessions = new Map();
    f.devices = new Map(); // id → { token, name }
    f.pairCodes = new Map(); // código → { id }
    f.lastAuthUrl = null;
    f.lastGoogleDevice = null;
    f.history = [{ ts: new Date().toISOString(), kind: "info", text: "Servidor de teste no ar", device: null }];
  };
  f.reset();
  f.since = (mark) => f.calls.slice(mark);

  const resets = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const publicAccount = (n) => ({
    number: n,
    email: `conta${n}@exemplo.com`,
    organizationName: `Org ${n}`,
    organizationUuid: `org-${n}`,
    plan: { label: "Max" },
    alias: null,
    usageStatus: "ok",
    usage: { fiveHour: { pct: 10 * n, resetsAt: resets(2) }, sevenDay: { pct: 20, resetsAt: resets(50) } },
    usageAgeSeconds: 30,
    lastGoodUsage: null,
    lastGoodAgeSeconds: null,
    dead: false,
    assignedDevices: f.assigned === n ? ["PC de teste"] : [],
  });
  f.stateFor = (devId) => ({
    serverTime: new Date().toISOString(),
    version: "teste",
    device: { id: devId, name: (f.devices.get(devId) || {}).name || devId, assigned: f.assigned, lastSwitchAt: 0 },
    list: { schemaVersion: 1, activeAccountNumber: f.assigned, accounts: f.accounts.map(publicAccount) },
    records: {},
    rules: {},
    autoSwitch: f.autoSwitch,
    credential: f.assigned ? { number: f.assigned, gen: f.gen, expiresAt: expOf(f.assigned, f.gen) } : null,
    history: f.history,
    devices: [...f.devices].map(([id, d]) => ({ id, name: d.name, assigned: f.assigned, lastSeen: new Date().toISOString(), current: id === devId })),
    diag: {},
  });

  async function handle(req, res) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const text = Buffer.concat(chunks).toString("utf8");
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    const p = new URL(req.url, "http://x").pathname;
    const call = { method: req.method, path: p, auth: req.headers.authorization || null, body, at: Date.now() };
    f.calls.push(call);
    const send = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(obj === undefined ? "" : JSON.stringify(obj));
    };
    const key = `${req.method} ${p}`;
    try {
      if (f.fail[key]) {
        const x = f.fail[key];
        return send(x.status, x.body || { error: `http_${x.status}`, message: "Falha simulada." });
      }

      // ---- sem autenticação
      if (key === "POST /v1/pair") {
        const d = f.pairCodes.get(body && body.code);
        if (!d) return send(401, { error: "bad_code", message: "Código de pareamento inválido ou vencido." });
        f.pairCodes.delete(body.code);
        const token = segredo("disp-par");
        f.devices.set(d.id, { token, name: body.name });
        return send(200, { deviceId: d.id, token });
      }
      if (key === "POST /v1/login/start") {
        const id = `sess-${++seq}`;
        const pollToken = segredo("poll");
        f.sessions.set(id, { pollToken, name: body && body.name });
        f.lastAuthUrl = `${f.url}/auth/google/start?session=${id}`;
        return send(200, { sessionId: id, pollToken, authUrl: f.lastAuthUrl, expiresAt: Date.now() + 10 * 60e3 });
      }
      if (key === "POST /v1/login/poll") {
        const s = f.sessions.get(body && body.sessionId);
        if (!s || body.pollToken !== s.pollToken) return send(404, { error: "expired", message: "Sessão de login vencida." });
        let next = f.google.length ? f.google.shift() : "pending";
        if (typeof next === "function") next = await next(call);
        if (next === "pending") return send(200, { status: "pending" });
        if (next === "denied") return send(200, { status: "denied", email: "negado@exemplo.com" });
        if (next === "ok") {
          const id = `dev-google-${++seq}`;
          const token = segredo("disp-google");
          f.devices.set(id, { token, name: s.name });
          f.lastGoogleDevice = { id, token };
          return send(200, { status: "ok", deviceId: id, token });
        }
        return send(500, { error: "teste", message: "resposta de poll desconhecida no teste" });
      }

      // ---- com autenticação
      if (f.authStatus) return send(f.authStatus, { error: "unauthorized", message: "Acesso inválido ou revogado." });
      const m = /^Bearer (.+)$/.exec(call.auth || "");
      const dev = m ? [...f.devices].find(([, d]) => d.token === m[1]) : null;
      if (!dev) return send(401, { error: "unauthorized", message: "Acesso inválido ou revogado." });
      const devId = dev[0];
      call.device = devId;
      if (f.handlers[key]) {
        const r = await f.handlers[key](call);
        return send(r.status || 200, r.body);
      }
      let mm;
      if ((mm = /^\/v1\/devices\/([^/]+)$/.exec(p)) && req.method === "DELETE") {
        f.devices.delete(decodeURIComponent(mm[1]));
        return send(200, { ok: true });
      }
      if (/^\/v1\/accounts\/\d+$/.test(p) && (req.method === "PATCH" || req.method === "DELETE")) return send(200, f.stateFor(devId));
      switch (key) {
        case "POST /v1/heartbeat":
        case "GET /v1/state":
          return send(200, f.stateFor(devId));
        case "GET /v1/credential":
          if (!f.assigned) return send(409, { error: "no_account", message: "Nenhuma conta atribuída a este computador." });
          return send(200, { number: f.assigned, gen: f.gen, claudeAiOauth: credOf(f.assigned, f.gen), oauthAccount: oauthAccountOf(f.assigned) });
        case "POST /v1/logins":
          return send(200, { number: 3, created: true });
        case "POST /v1/switch":
          f.assigned = body && body.number != null ? Number(body.number) : 1;
          return send(200, f.stateFor(devId));
        case "POST /v1/events": {
          const from = f.assigned;
          const to = from === 1 ? 2 : 1;
          f.assigned = to;
          const t = `Trocou da conta ${from} para a conta ${to} (bateu o ${body && body.label})`;
          f.history = [{ ts: new Date().toISOString(), kind: "switch", text: t, device: devId }, ...f.history];
          return send(200, { switched: true, text: t, state: f.stateFor(devId) });
        }
        case "PUT /v1/rules":
          if (body && typeof body.autoSwitch === "boolean") f.autoSwitch = body.autoSwitch;
          return send(200, f.stateFor(devId));
        case "GET /v1/devices":
          return send(200, [...f.devices].map(([id, d]) => ({ id, name: d.name, platform: "linux", assigned: f.assigned, current: id === devId })));
        default:
          return send(404, { error: "not_found", message: "Rota desconhecida." });
      }
    } catch (e) {
      try {
        send(500, { error: "falso", message: String((e && e.message) || e) });
      } catch {}
    }
  }

  f.iniciar = (port = 0) =>
    new Promise((resolve, reject) => {
      const s = http.createServer((req, res) => {
        handle(req, res).catch(() => {});
      });
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => {
        f.server = s;
        f.port = s.address().port;
        f.url = `http://127.0.0.1:${f.port}`;
        resolve();
      });
    });
  f.parar = () =>
    new Promise((resolve) => {
      const s = f.server;
      f.server = null;
      if (!s) return resolve();
      if (s.closeAllConnections) s.closeAllConnections();
      s.close(() => resolve());
    });
  return f;
}

const fake = criarServidorFalso();

// ================================================================ clientes do servidor (observados, sem o token)

const serverLibMod = require("../serverClient");
const createServerClientOrig = serverLibMod.createServerClient;
const clientes = []; // { url, tokenOrigin, timeoutMs, comToken } — nunca o token
const pedidos = []; // { method, path, url, tokenOrigin, timeoutMs }
serverLibMod.createServerClient = function (opts = {}) {
  const c = createServerClientOrig.call(this, opts);
  const info = { url: c.url, tokenOrigin: opts.tokenOrigin, timeoutMs: opts.timeoutMs, comToken: !!opts.token };
  clientes.push(info);
  return { ...c, request: (method, p, body) => (pedidos.push({ method, path: p, ...info }), c.request(method, p, body)) };
};

// ================================================================ vscode falso

const manifest = JSON.parse(fs.readFileSync(path.join(PLUS, "package.json"), "utf8"));
const defaults = {};
for (const [k, v] of Object.entries(manifest.contributes.configuration.properties)) defaults[k] = v.default;
const store = {};
const cfgListeners = [];
const commands = {};
const notes = []; // { kind, message, detail, modal, buttons }
const opened = []; // endereços passados a env.openExternal
const progressMsgs = [];
const progressTokens = []; // { token, cancel() } dos withProgress canceláveis
const inputChecks = []; // { title, erro } do validateInput com a resposta dada
const barHistory = []; // tudo o que passou pela barra (texto e dica)
const panelMessages = []; // tudo o que foi para a tela (JSON)
const paineis = []; // telas criadas (para mandar mensagens como se fosse a pessoa clicando)
const items = [];

// Respostas automáticas: (mensagem, botões, nota) → resposta; null = fecha sem escolher.
const ui = {};
function resetUi() {
  for (const k of ["info", "warn", "error", "pick", "input"]) ui[k] = null;
}
resetUi();

function message(kind) {
  return (msg, ...rest) => {
    let opts = null;
    if (rest.length && rest[0] && typeof rest[0] === "object") opts = rest.shift();
    const buttons = rest.filter((x) => typeof x === "string");
    const note = { kind, message: String(msg), detail: opts && opts.detail ? String(opts.detail) : "", modal: !!(opts && opts.modal), buttons };
    notes.push(note);
    let answer;
    try {
      answer = ui[kind] ? ui[kind](note.message, buttons, note) : undefined;
    } catch {
      answer = undefined;
    }
    return Promise.resolve(answer);
  };
}

function getConfiguration(ns) {
  const full = (k) => (ns ? `${ns}.${k}` : k);
  return {
    get: (k, def) => {
      const key = full(k);
      if (key in store) return store[key];
      return key in defaults ? defaults[key] : def;
    },
    inspect: (k) => {
      const key = full(k);
      return { key, defaultValue: defaults[key], globalValue: key in store ? store[key] : undefined };
    },
    update: async (k, v) => {
      const key = full(k);
      if (v === undefined) delete store[key];
      else store[key] = v;
      for (const fn of [...cfgListeners]) fn({ affectsConfiguration: (q) => key === q || key.startsWith(q + ".") });
    },
  };
}

class MarkdownString {
  constructor(value) {
    this.value = value || "";
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendText(s) {
    this.value += s;
    return this;
  }
}

const vscodeMock = {
  MarkdownString,
  ThemeColor: class {
    constructor(id) {
      this.id = id;
    }
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ConfigurationTarget: { Global: 1 },
  ViewColumn: { One: 1 },
  ProgressLocation: { Notification: 15 },
  QuickPickItemKind: { Separator: -1 },
  env: {
    appRoot: "/nao-existe",
    openExternal: async (u) => {
      opened.push(String(u));
      return true;
    },
    clipboard: { writeText: async () => {} },
  },
  Uri: {
    joinPath: (base, ...p) => ({ fsPath: path.join(base.fsPath, ...p), toString() { return this.fsPath; } }),
    file: (p) => ({ fsPath: p, toString() { return p; } }),
    parse: (s) => ({ fsPath: s, toString() { return s; } }),
  },
  window: {
    createStatusBarItem: (id) => {
      let text = "";
      let tooltip = "";
      const it = {
        id,
        shown: false,
        get text() {
          return text;
        },
        set text(v) {
          text = String(v);
          barHistory.push(text);
        },
        get tooltip() {
          return tooltip;
        },
        set tooltip(v) {
          tooltip = v;
          barHistory.push(typeof v === "string" ? v : (v && v.value) || "");
        },
        show() {
          it.shown = true;
        },
        hide() {
          it.shown = false;
        },
        dispose() {},
      };
      items.push(it);
      return it;
    },
    showInformationMessage: message("info"),
    showWarningMessage: message("warn"),
    showErrorMessage: message("error"),
    showQuickPick: (list, opts) => Promise.resolve(ui.pick ? ui.pick(list, opts || {}) : undefined),
    showInputBox: (opts) => {
      const o = opts || {};
      const a = ui.input ? ui.input(o) : undefined;
      if (a !== undefined && typeof o.validateInput === "function") inputChecks.push({ title: o.title, erro: o.validateInput(a) });
      return Promise.resolve(a);
    },
    withProgress: async (opts, fn) => {
      const listeners = new Set();
      const token = {
        isCancellationRequested: false,
        onCancellationRequested: (cb) => {
          listeners.add(cb);
          return { dispose: () => listeners.delete(cb) };
        },
      };
      const ctl = {
        token,
        cancel() {
          if (token.isCancellationRequested) return;
          token.isCancellationRequested = true;
          for (const cb of [...listeners]) cb();
        },
      };
      if (opts && opts.cancellable) progressTokens.push(ctl);
      if (opts && opts.title) progressMsgs.push(String(opts.title));
      return fn({ report: (m) => progressMsgs.push(String((m && m.message) || "")) }, token);
    },
    showSaveDialog: () => Promise.resolve(undefined),
    showOpenDialog: () => Promise.resolve(undefined),
    createTerminal: () => ({ show() {}, sendText() {} }),
    createWebviewPanel: () => {
      const p = {
        webview: {
          cspSource: "vscode-resource:",
          html: "",
          asWebviewUri: (u) => `webview://${u.fsPath}`,
          postMessage: (m) => {
            panelMessages.push(JSON.stringify(m));
            return Promise.resolve(true);
          },
          onDidReceiveMessage: (fn) => {
            p.receive = fn;
            return { dispose() {} };
          },
        },
        onDidDispose: (fn) => {
          p.onDispose = fn;
          return { dispose() {} };
        },
        reveal() {},
        dispose() {
          if (p.onDispose) p.onDispose();
        },
      };
      paineis.push(p);
      return p;
    },
  },
  workspace: {
    getConfiguration,
    onDidChangeConfiguration: (fn) => {
      cfgListeners.push(fn);
      return { dispose: () => cfgListeners.includes(fn) && cfgListeners.splice(cfgListeners.indexOf(fn), 1) };
    },
  },
  commands: {
    registerCommand: (id, fn) => {
      commands[id] = fn;
      return { dispose() {} };
    },
    executeCommand: () => Promise.resolve(),
  },
};

const origLoad = Module._load;
Module._load = function (request) {
  if (request === "vscode") return vscodeMock;
  return origLoad.apply(this, arguments);
};

// globalState e cofre de segredos em memória.
const gs = new Map();
const globalState = {
  get: (k, d) => (gs.has(k) ? gs.get(k) : d),
  update: async (k, v) => {
    if (v === undefined) gs.delete(k);
    else gs.set(k, JSON.parse(JSON.stringify(v)));
  },
  keys: () => [...gs.keys()],
  setKeysForSync() {},
};
const secretMap = new Map();
const secretListeners = [];
const secrets = {
  get: async (k) => secretMap.get(k),
  store: async (k, v) => {
    secretMap.set(k, String(v));
    for (const fn of [...secretListeners]) fn({ key: k });
  },
  delete: async (k) => {
    secretMap.delete(k);
    for (const fn of [...secretListeners]) fn({ key: k });
  },
  onDidChange: (fn) => {
    secretListeners.push(fn);
    return { dispose: () => secretListeners.includes(fn) && secretListeners.splice(secretListeners.indexOf(fn), 1) };
  },
};

const context = {
  subscriptions: [],
  extensionUri: { fsPath: PLUS },
  extensionPath: PLUS,
  extension: { packageJSON: manifest },
  globalState,
  secrets,
};

const ext = require(path.join(PLUS, manifest.main));
const T = ext._test;
const cfgApi = getConfiguration("swapPlus");

// ================================================================ utilitários

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(cond, ms, what) {
  const t0 = Date.now();
  for (;;) {
    let ok = false;
    try {
      ok = await cond();
    } catch {
      ok = false;
    }
    if (ok) return;
    if (Date.now() - t0 > ms) throw new Error(`tempo esgotado esperando: ${what}`);
    await sleep(20);
  }
}

const ciclo = () => T.refreshFresh(); // espera o ciclo em andamento e roda um novo
/** Mensagem da tela, como se a pessoa clicasse (espera o tratamento terminar). */
const tela = (m) => paineis[paineis.length - 1].receive(m);
const bar = () => items.find((i) => i.id === "swapPlus.main");
const is = (method, p) => (c) => c.method === method && (p instanceof RegExp ? p.test(c.path) : c.path === p);
const isHeartbeat = is("POST", "/v1/heartbeat");
const isCredential = is("GET", "/v1/credential");
const isLogins = is("POST", "/v1/logins");
const isEvents = is("POST", "/v1/events");

const credFile = () => auth._test.credentialsPath();
const cfgFile = () => auth.globalConfigPath();
const lerTexto = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null);
function escreverLogin(oauth) {
  fs.writeFileSync(credFile(), JSON.stringify({ claudeAiOauth: oauth, mcpOAuth: MCP }), { mode: 0o600 });
}
const lerLogin = () => JSON.parse(fs.readFileSync(credFile(), "utf8"));
function escreverConta(oauthAccount) {
  fs.writeFileSync(cfgFile(), JSON.stringify({ numStartups: 3, projects: { "/projeto": { allowedTools: [] } }, oauthAccount }, null, 2) + "\n");
}
const lerConta = () => JSON.parse(fs.readFileSync(cfgFile(), "utf8"));

/** Login novo do Claude Code (entrou pelo navegador: tem refreshToken). */
function loginNovo(tag, email, org) {
  const oauth = {
    accessToken: segredo(`oat01-${tag}`),
    refreshToken: segredo(`ort01-${tag}`),
    expiresAt: Date.now() + 8 * 3600e3 + Math.floor(Math.random() * 1e6),
    scopes: SCOPES,
    subscriptionType: "max",
  };
  const oauthAccount = { accountUuid: `acc-${tag}`, emailAddress: email, organizationUuid: org, organizationName: `Org ${tag}` };
  escreverLogin(oauth);
  escreverConta(oauthAccount);
  return { oauth, oauthAccount };
}

function escreverTranscricao(pasta, nome, linhas) {
  const dir = path.join(CLAUDE_DIR, "projects", pasta);
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, nome);
  fs.writeFileSync(f, linhas.join("\n") + "\n");
  return f;
}
const linhaConversa = (model) => JSON.stringify({ type: "assistant", timestamp: new Date().toISOString(), message: { model, content: [{ type: "text", text: "ok" }] } });
// Formato que scanLimitErrors espera (o erro que o Claude Code grava quando bate o limite).
const linhaLimite = (text) =>
  JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: new Date().toISOString(), message: { model: "<synthetic>", content: [{ type: "text", text }] } });

async function limparLimite() {
  await globalState.update("swapPlus.lastLimitHit", 0);
  await globalState.update("swapPlus.lastAutoSwitch", 0);
  fs.rmSync(path.join(TMP, "swap-plus-limit.lock"), { force: true });
}

const codigoConexao = (code, url = fake.url) => "swapplus1:" + Buffer.from(JSON.stringify({ url, code, fp: null }), "utf8").toString("base64url");

/** Volta ao modo local sem conexão (pelo comando de desconectar, como a pessoa faria). */
async function desconectar() {
  const prev = ui.warn;
  ui.warn = (_m, b) => (b.includes("Desconectar e usar o modo local") ? "Desconectar e usar o modo local" : undefined);
  try {
    await commands["swapPlus.disconnectServer"]();
  } finally {
    ui.warn = prev;
  }
  if (T.serverMode()) await cfgApi.update("mode", "local");
  if (store["swapPlus.enabled"] === false) await cfgApi.update("enabled", true);
  await ciclo();
}

/**
 * Este computador conectado ao servidor falso (como se outra janela tivesse
 * conectado), com a conta 1 atribuída e o primeiro ciclo já feito.
 * Ordem: modo local primeiro (para o ciclo), depois ligado, estado, modo servidor.
 */
async function prepararServidor() {
  resetUi();
  if (T.serverMode()) await cfgApi.update("mode", "local");
  if (store["swapPlus.enabled"] === false) await cfgApi.update("enabled", true);
  await ciclo();
  fake.reset();
  fake.devices.set(DEVICE_ID, { token: DEVICE_TOKEN, name: "PC de teste" });
  await secrets.store(TOKEN_KEY, DEVICE_TOKEN);
  await globalState.update(META_KEY, { url: fake.url, fp: null, deviceId: DEVICE_ID, name: "PC de teste", via: "code", connectedAt: Date.now() - 60000 });
  await globalState.update(APPLIED_KEY, undefined);
  await globalState.update(SENT_KEY, undefined);
  fs.rmSync(T.ownerFile(), { force: true }); // esta janela volta a ser a dona no 1º ciclo
  Object.assign(T.srv, { rejected: null, loginRetry: null, applyFail: null, discard: null, expectNumber: null });
  fs.rmSync(path.join(CLAUDE_DIR, "projects"), { recursive: true, force: true });
  await limparLimite();
  escreverLogin({ accessToken: segredo("oat01-antigo"), expiresAt: Date.now() + 3600e3, scopes: ["user:inference"] });
  escreverConta(oauthAccountOf(1));
  await cfgApi.update("mode", "server");
  await ciclo();
}

/** As consultas do login com Google esperam 2 s entre si; no teste, 20 ms. */
function acelerarConsultas() {
  const orig = global.setTimeout;
  global.setTimeout = function (fn, ms, ...rest) {
    return orig.call(this, fn, ms === 2000 ? 20 : ms, ...rest);
  };
  return () => {
    global.setTimeout = orig;
  };
}

/** Texto com os tokens trocados (para mensagens de falha não repetirem o segredo). */
const semSegredo = (s) => String(s).replace(/\S*SEGREDO\S*/g, "<token>");

/**
 * Nenhum token em notificações, histórico, logs, tela, barra, globalState, configurações
 * nem nos arquivos do temporário. Todo segredo de teste tem a marca "SEGREDO".
 */
function conferirSemTokens() {
  const tmpFiles = fs
    .readdirSync(TMP, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => [`temporário ${d.name}`, fs.readFileSync(path.join(TMP, d.name), "utf8")]);
  const lugares = [
    ...notes.map((n) => [`notificação (${n.kind})`, [n.message, n.detail, ...n.buttons].join("\n")]),
    ["histórico", JSON.stringify(globalState.get(HISTORY_KEY) || [])],
    ["histórico da tela", JSON.stringify(T.historyPayload())],
    ...logs.map((l) => ["log", l]),
    ["globalState", JSON.stringify([...gs])],
    ["configurações", JSON.stringify(store)],
    ...barHistory.map((b) => ["barra", b]),
    ...progressMsgs.map((p) => ["progresso", p]),
    ...panelMessages.map((m) => ["tela", m]),
    ["clientes do servidor", JSON.stringify([clientes, pedidos])],
    ...tmpFiles,
  ];
  assert.ok(notes.length > 0, "há notificações para conferir");
  assert.ok(logs.some((l) => l.includes("[swap-plus]")), "há logs da extensão para conferir");
  assert.ok(panelMessages.length > 0, "há mensagens da tela para conferir");
  assert.ok(SEGREDOS.size > 10);
  // Todo segredo de teste tem a marca: sem a marca no texto, nenhum token (nem pedaço) está lá.
  for (const [onde, texto] of lugares) {
    const t = String(texto);
    if (!t.includes("SEGREDO")) continue;
    const qual = [...SEGREDOS].find((x) => t.includes(x));
    const tipo = qual ? qual.split("-SEGREDO-")[0] : "pedaço de token";
    assert.fail(`token (${tipo}) vazou em ${onde}: ${semSegredo(t).slice(0, 300)}`);
  }
}

// ================================================================ ciclo de vida

const timersDoActivate = [];

before(async () => {
  // O swap-plus falso precisa rodar (os cenários do modo local e do envio dos logins dependem dele).
  const v = await new Promise((resolve) =>
    childProcess.execFile(swapPlusFalso.exe, ["--version"], { timeout: 20000 }, (e, out, err) => resolve({ e, out: String(out || ""), err: String(err || "") }))
  );
  if (v.e || !/swap-plus 9\.9\.9/.test(v.out)) throw new Error(`o swap-plus falso não rodou: ${v.e ? v.e.code || v.e.message : ""} ${v.err}`.trim());
  swapPlusFalso.limpar();
  await fake.iniciar();
  Object.assign(store, {
    "swapPlus.updates.enabled": false, // sem GitHub
    "swapPlus.executablePath": swapPlusFalso.exe,
    "swapPlus.server.url": fake.url, // nunca o endereço padrão
    "swapPlus.mode": "local",
  });
  T.setLimitRoot(path.join(CLAUDE_DIR, "projects"));
  // Timers que o activate cria e o deactivate não limpa (atualizador, linhas do motor): limpos no fim.
  const st = global.setTimeout;
  const si = global.setInterval;
  global.setTimeout = function (...a) {
    const h = st.apply(this, a);
    timersDoActivate.push(h);
    return h;
  };
  global.setInterval = function (...a) {
    const h = si.apply(this, a);
    timersDoActivate.push(h);
    return h;
  };
  try {
    ext.activate(context);
  } finally {
    global.setTimeout = st;
    global.setInterval = si;
  }
  // Tela aberta: tudo o que vai para ela entra na busca de tokens do cenário 9.
  commands["swapPlus.openSettings"]();
  await ciclo();
});

after(async () => {
  try {
    resetUi();
    if (store["swapPlus.enabled"] !== false) await cfgApi.update("enabled", false); // para qualquer contato com o servidor
    await ciclo().catch(() => {});
    await ext.deactivate();
  } finally {
    for (const h of timersDoActivate) clearTimeout(h); // clearTimeout também limpa intervalos
    for (const s of context.subscriptions) {
      try {
        if (s && typeof s.dispose === "function") s.dispose();
      } catch {}
    }
    await fake.parar();
    Module._load = origLoad;
    childProcess.execFile = execFileOrig;
    serverLibMod.createServerClient = createServerClientOrig;
    for (const m of Object.keys(origConsole)) console[m] = origConsole[m];
    auth._test.reset();
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    fs.rmSync(ROOT, { recursive: true, force: true });
  }
});

// ================================================================ cenários

test("1. conectar com código: token no cofre, modo servidor; oferta de envio só com contas locais", { timeout: T_MAX }, async () => {
  resetUi();
  await desconectar();
  fake.reset();
  fs.rmSync(path.join(HOME, ".claude-swap-backup"), { recursive: true, force: true });
  fs.rmSync(credFile(), { force: true });
  fs.rmSync(cfgFile(), { force: true });

  // a) sem contas no motor local
  fake.pairCodes.set("PAREAR0001", { id: "dev-1" });
  const code1 = codigoConexao("PAREAR0001");
  ui.input = (o) => (/nome deste computador/.test(o.title || "") ? "PC de teste" : code1);
  let mark = fake.calls.length;
  let n0 = notes.length;
  const c0 = inputChecks.length;
  await commands["swapPlus.connectServer"]("code");

  assert.ok(fake.devices.has("dev-1"), "o servidor falso pareou o computador");
  const token1 = fake.devices.get("dev-1").token;
  assert.equal(await secrets.get(TOKEN_KEY), token1, "token do dispositivo vai para o cofre de segredos");
  assert.equal(store["swapPlus.mode"], "server");
  assert.equal(T.serverMode(), true);
  assert.equal(T.serverStatus(), "online");
  const meta = globalState.get(META_KEY);
  assert.equal(meta.deviceId, "dev-1");
  assert.equal(meta.url, fake.url);
  assert.equal(meta.fp, null);
  assert.equal(JSON.stringify(meta).includes(token1), false, "o token não vai para o globalState");
  assert.ok(
    inputChecks.slice(c0).every((x) => x.erro === null || x.erro === undefined),
    "o código de conexão passa na validação do campo"
  );

  let calls = fake.since(mark);
  const pairCall = calls.find(is("POST", "/v1/pair"));
  assert.ok(pairCall, "chamou POST /v1/pair");
  assert.equal(pairCall.auth, null, "pareamento vai sem token");
  assert.deepEqual(pairCall.body, { code: "PAREAR0001", name: "PC de teste", platform: process.platform });
  const hb = calls.find(isHeartbeat);
  assert.ok(hb, "fez o batimento depois de conectar");
  assert.equal(hb.auth, `Bearer ${token1}`);
  assert.equal(calls.filter(isLogins).length, 0);
  let novas = notes.slice(n0);
  assert.ok(!novas.some((n) => /Enviar os logins deste computador/.test(n.message)), "sem contas locais: não oferece o envio");
  assert.ok(novas.some((n) => n.kind === "info" && /conectado ao servidor 127\.0\.0\.1:\d+/.test(n.message)));
  assert.equal(lerLogin().claudeAiOauth.accessToken, acessoServidor(1, 1), "gravou o acesso da conta atribuída");

  // b) com contas no motor local (sequence.json) → oferece e envia
  fs.mkdirSync(path.join(HOME, ".claude-swap-backup"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".claude-swap-backup", "sequence.json"), JSON.stringify({ accounts: { 1: { alias: null } } }));
  fake.pairCodes.set("PAREAR0002", { id: "dev-2" });
  const code2 = codigoConexao("PAREAR0002");
  ui.input = (o) => (/nome deste computador/.test(o.title || "") ? "PC de teste" : code2);
  ui.warn = (_m, b) => (b.includes("Conectar de novo") ? "Conectar de novo" : undefined);
  ui.info = (_m, b) => (b.includes("Enviar os logins") ? "Enviar os logins" : undefined);
  mark = fake.calls.length;
  n0 = notes.length;
  swapPlusFalso.limpar();
  await commands["swapPlus.connectServer"]("code");

  const token2 = fake.devices.get("dev-2").token;
  assert.equal(await secrets.get(TOKEN_KEY), token2);
  novas = notes.slice(n0);
  assert.ok(novas.some((n) => /Enviar os logins deste computador para o servidor\?/.test(n.message)), "com contas locais: oferece o envio");
  calls = fake.since(mark);
  const del = calls.find(is("DELETE", "/v1/devices/dev-1"));
  assert.ok(del, "a conexão anterior foi revogada no servidor");
  assert.equal(del.auth, `Bearer ${token1}`);
  assert.equal(fake.devices.has("dev-1"), false);
  const ups = calls.filter(isLogins);
  assert.equal(
    ups.length,
    1,
    `um login local enviado (avisos: ${notes.slice(n0).filter((n) => n.kind !== "info").map((n) => semSegredo(n.message)).join(" | ") || "nenhum"}; motor: ${swapPlusFalso.calls().join(" | ") || "não chamado"})`
  );
  assert.equal(ups[0].auth, `Bearer ${token2}`);
  assert.equal(ups[0].body.claudeAiOauth.refreshToken, REFRESH_LOCAL);
  assert.equal(ups[0].body.oauthAccount.emailAddress, "local1@exemplo.com");
  assert.deepEqual(ups[0].body.plan, { label: "Max" }, "plano vem do swap-plus list --json");
  const motor = swapPlusFalso.calls();
  assert.ok(motor.includes("list --json"), motor.join(" | "));
  assert.ok(motor.some((l) => /^export \S+contas\.cswap$/.test(l)), motor.join(" | "));
  assert.deepEqual(fs.readdirSync(TMP).filter((f) => f.startsWith("swap-plus-envio-")), [], "o temporário do export foi apagado");
  assert.ok(novas.some((n) => /1 login aceito pelo servidor/.test(n.message)), "mostra quantos foram aceitos");
  assert.ok((globalState.get(MIGRATED_KEY) || {})[fake.url], "anota que este servidor já recebeu os logins");
});

test("2. conectar com Google: navegador, pending → ok; negado; cancelado sem sobrar dispositivo", { timeout: T_MAX }, async () => {
  resetUi();
  await desconectar();
  fake.reset();
  ui.input = (o) => (/nome deste computador/.test(o.title || "") ? "PC Google" : undefined);
  const restaurar = acelerarConsultas();
  try {
    // a) negado → mensagem com o e-mail
    fake.google = ["pending", "denied"];
    let n0 = notes.length;
    let o0 = opened.length;
    await commands["swapPlus.connectServer"]("google");
    const err = notes.slice(n0).find((n) => n.kind === "error" && /negado@exemplo\.com/.test(n.message));
    assert.ok(err, "avisa que a conta Google foi negada, com o e-mail");
    assert.match(err.message, /não está liberada neste servidor/);
    assert.equal(opened.length, o0 + 1, "abriu o navegador");
    assert.equal(await secrets.get(TOKEN_KEY), undefined);
    assert.equal(T.serverMode(), false);

    // b) cancelado enquanto a consulta está no ar; o "ok" chega depois → a extensão revoga
    let chegou;
    const chegada = new Promise((r) => (chegou = r));
    let liberar;
    const liberado = new Promise((r) => (liberar = r));
    fake.google = [
      async () => {
        chegou();
        await liberado;
        return "ok";
      },
    ];
    let mark = fake.calls.length;
    n0 = notes.length;
    const p0 = progressTokens.length;
    const conectando = commands["swapPlus.connectServer"]("google");
    try {
      await chegada;
      assert.ok(progressTokens.length > p0, "a espera do Google é cancelável");
      progressTokens[progressTokens.length - 1].cancel();
      await conectando;
    } finally {
      liberar(); // a resposta "ok" do servidor só sai depois do cancelamento
    }
    await waitFor(() => fake.since(mark).some(is("DELETE", /^\/v1\/devices\//)), 5000, "revogação do acesso criado depois do cancelamento");
    const orfao = fake.lastGoogleDevice;
    assert.ok(orfao, "o servidor criou o acesso depois do cancelamento");
    const del = fake.since(mark).find(is("DELETE", `/v1/devices/${orfao.id}`));
    assert.ok(del, "revogou exatamente o acesso órfão");
    assert.equal(del.auth, `Bearer ${orfao.token}`);
    assert.equal(fake.devices.size, 0, "nenhum dispositivo sobrou no servidor");
    assert.equal(await secrets.get(TOKEN_KEY), undefined, "nada guardado no cofre");
    assert.equal(T.serverMode(), false);
    assert.ok(notes.slice(n0).some((n) => /conexão com o Google cancelada/.test(n.message)));

    // c) pending, pending, ok → conectado
    fake.google = ["pending", "pending", "ok"];
    mark = fake.calls.length;
    n0 = notes.length;
    o0 = opened.length;
    await commands["swapPlus.connectServer"]("google");
    const calls = fake.since(mark);
    const start = calls.filter(is("POST", "/v1/login/start"));
    assert.equal(start.length, 1);
    assert.equal(start[0].auth, null);
    assert.deepEqual(start[0].body, { name: "PC Google", platform: process.platform });
    assert.equal(opened.length, o0 + 1);
    assert.equal(opened[opened.length - 1], fake.lastAuthUrl, "openExternal recebeu o authUrl do servidor");
    const polls = calls.filter(is("POST", "/v1/login/poll"));
    assert.equal(polls.length, 3, "consultou até chegar o ok");
    for (const p of polls) {
      assert.equal(p.auth, null);
      assert.deepEqual(Object.keys(p.body).sort(), ["pollToken", "sessionId"]);
    }
    const dev = fake.lastGoogleDevice;
    assert.ok(fake.devices.has(dev.id));
    assert.equal(await secrets.get(TOKEN_KEY), dev.token);
    assert.equal(T.serverMode(), true);
    assert.equal(T.serverStatus(), "online");
    const meta = globalState.get(META_KEY);
    assert.equal(meta.via, "google");
    assert.equal(meta.deviceId, dev.id);
    assert.equal(meta.fp, null);
    assert.ok(calls.some((c) => isHeartbeat(c) && c.auth === `Bearer ${dev.token}`), "batimento com o token novo");
    assert.ok(notes.slice(n0).some((n) => n.kind === "info" && /conectado ao servidor/.test(n.message)));
    assert.ok((globalState.get(HISTORY_KEY) || []).some((h) => /entrou com Google/.test(h.text)));
  } finally {
    restaurar();
  }
});

test("3. ciclo: batimento sem tokens; gen novo → acesso do servidor sem refreshToken; oauthAccount e mcpOAuth", { timeout: T_MAX }, async () => {
  await prepararServidor();
  swapPlusFalso.limpar();
  escreverTranscricao("modelo", "conversa.jsonl", [linhaConversa("claude-fable-5-2")]);

  // O 1º ciclo (prepararServidor) já gravou o acesso da conta 1.
  let disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(1, 1));

  // a) nada mudou: só o batimento, com modelos e o login atual SEM tokens
  let mark = fake.calls.length;
  await ciclo();
  let calls = fake.since(mark);
  const hb = calls.find(isHeartbeat);
  assert.ok(hb, "batimento");
  assert.equal(hb.auth, `Bearer ${DEVICE_TOKEN}`);
  assert.deepEqual(hb.body.models, ["claude-fable-5-2"]);
  assert.deepEqual(hb.body.live, { email: "conta1@exemplo.com", orgUuid: "org-1", expiresAt: expOf(1, 1) });
  const hbText = JSON.stringify(hb.body);
  assert.ok(!/accessToken|refreshToken|SEGREDO/.test(hbText), `batimento com token: ${semSegredo(hbText)}`);
  assert.equal(calls.filter(isCredential).length, 0, "nada mudou: não busca a credencial");

  // b) gen novo → GET /v1/credential → grava sem refreshToken, preservando mcpOAuth
  mark = fake.calls.length;
  fake.gen = 2;
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isCredential).length, 1);
  disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(1, 2));
  assert.equal("refreshToken" in disk.claudeAiOauth, false);
  assert.deepEqual(disk.mcpOAuth, MCP, "mcpOAuth preservado");

  // c) o servidor troca a conta → ~/.claude.json recebe o oauthAccount (o resto fica)
  mark = fake.calls.length;
  fake.assigned = 2;
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isCredential).length, 1);
  disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(2, 2));
  assert.equal("refreshToken" in disk.claudeAiOauth, false);
  assert.deepEqual(disk.mcpOAuth, MCP);
  const conta = lerConta();
  assert.deepEqual(conta.oauthAccount, oauthAccountOf(2));
  assert.equal(conta.numStartups, 3, "o resto do ~/.claude.json fica");
  assert.deepEqual(conta.projects, { "/projeto": { allowedTools: [] } });
  if (process.platform !== "win32") assert.equal(fs.statSync(credFile()).mode & 0o777, 0o600);

  // d) o batimento seguinte já informa a conta nova e não regrava
  mark = fake.calls.length;
  await ciclo();
  calls = fake.since(mark);
  assert.deepEqual(calls.find(isHeartbeat).body.live, { email: "conta2@exemplo.com", orgUuid: "org-2", expiresAt: expOf(2, 2) });
  assert.equal(calls.filter(isCredential).length, 0);
  assert.match(bar().text, /\$\(cloud\)/);
  assert.match(bar().text, /Sessão \(5h\)/);
  assert.deepEqual(swapPlusFalso.calls(), [], "no modo servidor o motor local (swap-plus) não é chamado");
});

test("4. login novo: POST /v1/logins UMA vez com o refreshToken e depois o acesso do servidor por cima; 422", { timeout: T_MAX }, async () => {
  await prepararServidor();

  // a) aceito
  let mark = fake.calls.length;
  let n0 = notes.length;
  const novo = loginNovo("novo", "nova@exemplo.com", "org-nova");
  await ciclo();
  let calls = fake.since(mark);
  const ups = calls.filter(isLogins);
  assert.equal(ups.length, 1);
  assert.deepEqual(ups[0].body.claudeAiOauth, novo.oauth, "vai o login inteiro, com o refreshToken");
  assert.deepEqual(ups[0].body.oauthAccount, novo.oauthAccount);
  const iUp = calls.indexOf(ups[0]);
  const iCred = calls.findIndex(isCredential);
  assert.ok(iCred > iUp, "a credencial do servidor só é buscada depois do envio");
  assert.deepEqual(calls.find(isHeartbeat).body.live, { email: "nova@exemplo.com", orgUuid: "org-nova", expiresAt: novo.oauth.expiresAt });
  let disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(1, 1), "o login local foi sobrescrito pelo do servidor");
  assert.equal("refreshToken" in disk.claudeAiOauth, false);
  assert.deepEqual(disk.mcpOAuth, MCP);
  assert.deepEqual(lerConta().oauthAccount, oauthAccountOf(1));
  assert.ok(notes.slice(n0).some((n) => /login da conta 3 enviado ao servidor \(conta nova\)/.test(n.message)));
  await ciclo();
  await ciclo();
  assert.equal(fake.since(mark).filter(isLogins).length, 1, "não reenvia");

  // b) 422 dead_login → grava a do servidor
  fake.handlers["POST /v1/logins"] = () => ({ status: 422, body: { error: "dead_login", message: "O login não vale mais." } });
  mark = fake.calls.length;
  const morto = loginNovo("morto", "morta@exemplo.com", "org-morta");
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1);
  assert.equal(calls.filter(isCredential).length, 1);
  disk = lerLogin();
  assert.notEqual(disk.claudeAiOauth.accessToken, morto.oauth.accessToken);
  assert.deepEqual(disk.claudeAiOauth, credOf(1, 1));
  assert.deepEqual(lerConta().oauthAccount, oauthAccountOf(1));
  assert.ok((globalState.get(HISTORY_KEY) || []).some((h) => /morta@exemplo\.com recusado pelo servidor/.test(h.text)));
  await ciclo();
  assert.equal(fake.since(mark).filter(isLogins).length, 1, "login morto não é reenviado");

  // c) 422 por outro motivo → não grava por cima e não reenvia em seguida
  fake.handlers["POST /v1/logins"] = () => ({ status: 422, body: { error: "identity_mismatch", message: "Não bate." } });
  mark = fake.calls.length;
  n0 = notes.length;
  loginNovo("recusado", "outra@exemplo.com", "org-outra");
  const antes = lerTexto(credFile());
  const contaAntes = lerTexto(cfgFile());
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1);
  assert.equal(calls.filter(isCredential).length, 0, "não busca a credencial do servidor");
  assert.equal(lerTexto(credFile()), antes, "login recusado fica como está");
  assert.equal(lerTexto(cfgFile()), contaAntes);
  assert.ok(notes.slice(n0).some((n) => n.kind === "warn" && /recusou o login de outra@exemplo\.com/.test(n.message)));
  assert.match(bar().text, /login do Claude Code recusado pelo servidor/);
  await ciclo();
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1, "não reenvia logo em seguida");
  assert.equal(calls.filter(isCredential).length, 0);
  assert.equal(lerTexto(credFile()), antes);
});

test("5. servidor fora do ar: nada gravado e barra “fora do ar”; 401: para de chamar o servidor", { timeout: T_MAX }, async () => {
  await prepararServidor();
  const loginAntes = lerTexto(credFile());
  const contaAntes = lerTexto(cfgFile());

  // a) batimento ok, mas a credencial falha (503)
  let mark = fake.calls.length;
  fake.gen = 2;
  fake.fail["GET /v1/credential"] = { status: 503, body: { error: "indisponivel", message: "Servidor ocupado." } };
  await ciclo();
  assert.equal(fake.since(mark).filter(isCredential).length, 1);
  assert.equal(lerTexto(credFile()), loginAntes, "nada gravado na credencial");
  assert.equal(lerTexto(cfgFile()), contaAntes);
  assert.equal(T.serverStatus(), "offline");
  assert.match(bar().text, /servidor fora do ar/);
  delete fake.fail["GET /v1/credential"];

  // b) servidor parado (conexão recusada)
  const port = fake.port;
  await fake.parar();
  try {
    await ciclo();
    assert.equal(T.serverStatus(), "offline");
    assert.match(bar().text, /servidor fora do ar/);
    assert.equal(lerTexto(credFile()), loginAntes);
    assert.equal(lerTexto(cfgFile()), contaAntes);
    // Login novo enquanto o servidor está fora: fica como está (nem envia, nem grava por cima).
    loginNovo("fora", "fora@exemplo.com", "org-fora");
    const comNovo = lerTexto(credFile());
    const contaNova = lerTexto(cfgFile());
    await ciclo();
    assert.equal(lerTexto(credFile()), comNovo);
    assert.equal(lerTexto(cfgFile()), contaNova);
    assert.equal(T.serverStatus(), "offline");
    fs.writeFileSync(credFile(), loginAntes);
    fs.writeFileSync(cfgFile(), contaAntes);
  } finally {
    await fake.iniciar(port);
  }

  // c) 401 → revogado: não chama mais
  fake.authStatus = 401;
  mark = fake.calls.length;
  const n0 = notes.length;
  await ciclo();
  assert.ok(fake.since(mark).some(isHeartbeat));
  assert.equal(T.serverStatus(), "revoked");
  assert.match(bar().text, /servidor recusou este computador/);
  assert.equal(notes.slice(n0).filter((n) => /recusou o acesso deste computador/.test(n.message)).length, 1);
  assert.ok(globalState.get(META_KEY).revokedAt, "anota a revogação");
  const depois = fake.calls.length;
  await ciclo();
  await ciclo();
  await T.checkLimitErrors();
  await sleep(100);
  assert.equal(fake.calls.length, depois, "depois do 401 nenhuma chamada ao servidor");
  assert.equal(lerTexto(credFile()), loginAntes);
  assert.equal(lerTexto(cfgFile()), contaAntes);
});

test("6. Swap Plus desligado: nenhuma chamada ao servidor e nada gravado", { timeout: T_MAX }, async () => {
  await prepararServidor();
  await cfgApi.update("enabled", false);
  await ciclo();
  const mark = fake.calls.length;
  fake.gen = 2; // haveria credencial nova
  loginNovo("desligado", "desligado@exemplo.com", "org-d"); // e login novo para enviar
  const loginAntes = lerTexto(credFile());
  const contaAntes = lerTexto(cfgFile());
  await limparLimite();
  const tr = escreverTranscricao("desligado", "c.jsonl", [linhaLimite("You've hit your 5-hour limit · resets 10:20pm")]);
  try {
    await commands["swapPlus.refreshStatus"]();
    assert.equal(await T.checkLimitErrors(), null);
    await commands["swapPlus.switchAccount"]();
    await commands["swapPlus.switchBest"]();
    assert.equal(await T.syncCredential(null, { credential: { number: 1, gen: 99, expiresAt: 1 }, list: { accounts: [] } }), null);
    await ciclo();
    await sleep(200);
    assert.equal(fake.calls.length, mark, `chamadas com o Swap Plus desligado: ${fake.since(mark).map((c) => `${c.method} ${c.path}`).join(", ")}`);
    assert.equal(lerTexto(credFile()), loginAntes, "nada gravado na credencial");
    assert.equal(lerTexto(cfgFile()), contaAntes);
    assert.match(bar().text, /Swap Plus desligado/);
    assert.equal(T.serverStatus(), "off");
  } finally {
    fs.rmSync(tr, { force: true });
  }
});

test("7. modo local: nenhuma chamada ao servidor, mesmo conectado", { timeout: T_MAX }, async () => {
  await prepararServidor();
  await cfgApi.update("mode", "local");
  await ciclo();
  const mark = fake.calls.length;
  swapPlusFalso.limpar();
  fake.gen = 2;
  loginNovo("local", "conta-local@exemplo.com", "org-x");
  const loginAntes = lerTexto(credFile());
  await limparLimite();
  const tr = escreverTranscricao("local", "c.jsonl", [linhaLimite("You've hit your weekly limit")]);
  try {
    await commands["swapPlus.refreshStatus"]();
    await T.checkLimitErrors();
    await T.syncMotorLines();
    await commands["swapPlus.switchAccount"]();
    await ciclo();
    await sleep(200);
    assert.equal(fake.calls.length, mark, `chamadas no modo local: ${fake.since(mark).map((c) => `${c.method} ${c.path}`).join(", ")}`);
    assert.ok(
      swapPlusFalso.calls().includes("list --json"),
      `o ciclo local rodou (com o swap-plus falso); chamadas: ${swapPlusFalso.calls().join(" | ") || "nenhuma"}; erro: ${T.buildPayload().error || "-"}`
    );
    assert.equal(lerTexto(credFile()), loginAntes, "o modo local não mexe no login aqui");
    assert.equal(T.serverStatus(), "local");
    assert.equal(await secrets.get(TOKEN_KEY), DEVICE_TOKEN, "continua conectado");
  } finally {
    fs.rmSync(tr, { force: true });
  }
});

test("8. limite nas transcrições → POST /v1/events uma vez e grava a conta escolhida", { timeout: T_MAX }, async () => {
  await prepararServidor();
  await limparLimite();
  const mark = fake.calls.length;
  const n0 = notes.length;
  const tr = escreverTranscricao("limite", "conversa.jsonl", [
    linhaConversa("claude-fable-5-2"),
    linhaLimite("You've hit your 5-hour limit · resets 10:20pm (America/Sao_Paulo)"),
  ]);
  try {
    await T.checkLimitErrors(); // (ou o vigia de 15 s pega antes; vale o que chegar ao servidor)
    await waitFor(
      () => fake.since(mark).some(isEvents) && lerLogin().claudeAiOauth.accessToken === acessoServidor(2, 1),
      5000,
      "evento de limite e gravação da conta 2"
    );
    assert.equal(await T.checkLimitErrors(), null, "o mesmo erro não dispara de novo");
    await sleep(100);
    const ev = fake.since(mark).filter(isEvents);
    assert.equal(ev.length, 1);
    assert.deepEqual(ev[0].body, { kind: "limit_hit", label: "limite da sessão de 5h" });
    assert.equal(ev[0].auth, `Bearer ${DEVICE_TOKEN}`);
    const disk = lerLogin();
    assert.deepEqual(disk.claudeAiOauth, credOf(2, 1));
    assert.equal("refreshToken" in disk.claudeAiOauth, false);
    assert.deepEqual(lerConta().oauthAccount, oauthAccountOf(2));
    assert.ok(notes.slice(n0).some((n) => n.kind === "info" && /para a conta 2/.test(n.message)));
  } finally {
    fs.rmSync(tr, { force: true });
  }
});

test("9. nenhum token em notificações, histórico, logs, tela, barra, globalState ou temporários", { timeout: T_MAX }, async () => {
  await prepararServidor();
  // Mais caminhos com token por perto: login aceito, recusado, servidor que devolve o token no erro.
  loginNovo("nove-a", "nove-a@exemplo.com", "org-9a");
  await ciclo();
  fake.handlers["POST /v1/logins"] = () => ({ status: 422, body: { error: "identity_mismatch", message: "Não bate." } });
  loginNovo("nove-b", "nove-b@exemplo.com", "org-9b");
  await ciclo();
  const c = loginNovo("nove-c", "nove-c@exemplo.com", "org-9c");
  fake.handlers["POST /v1/logins"] = () => ({
    status: 422,
    body: { error: "erro_estranho", message: `recusei ${c.oauth.refreshToken} / ${c.oauth.accessToken}` },
  });
  await ciclo();
  const aviso = notes.find((n) => /nove-c@exemplo\.com/.test(n.message));
  assert.ok(aviso, "avisou a recusa do login");
  assert.match(aviso.message, /recusei …/, "o token devolvido pelo servidor foi escondido");
  fake.fail["POST /v1/heartbeat"] = { status: 503, body: { error: "ocupado", message: `falhou com ${DEVICE_TOKEN}` } };
  await ciclo();
  assert.equal(T.serverStatus(), "offline");
  delete fake.fail["POST /v1/heartbeat"];

  conferirSemTokens();
});

// ================================================================ cenários da revisão final

const isState = is("GET", "/v1/state");
const isSwitch = is("POST", "/v1/switch");
const isRules = is("PUT", "/v1/rules");
const credBody = () => ({ status: 200, body: { number: fake.assigned, gen: fake.gen, claudeAiOauth: credOf(fake.assigned, fake.gen), oauthAccount: oauthAccountOf(fake.assigned) } });
/** Resposta lenta do servidor: o handler espera `liberar()`. */
function segurar() {
  const h = { no: false };
  h.solto = new Promise((r) => (h.liberar = r));
  h.handler = async (call) => {
    h.no = true;
    await h.solto;
    h.no = false;
    return { status: 200, body: fake.stateFor(call.device) };
  };
  return h;
}
const AVISO_LOGIN = /o login do Claude Code é feito pelo Swap Plus/;

test("10. o token só vai para o endereço em que foi emitido; scope machine e pasta não confiável no package.json", { timeout: T_MAX }, async () => {
  // a) package.json
  const props = manifest.contributes.configuration.properties;
  for (const k of ["swapPlus.mode", "swapPlus.server.url", "swapPlus.enabled", "swapPlus.executablePath"]) {
    assert.equal(props[k].scope, "machine", `${k} só nas configurações do usuário`);
  }
  assert.equal(manifest.capabilities && manifest.capabilities.untrustedWorkspaces && manifest.capabilities.untrustedWorkspaces.supported, false);

  await prepararServidor();
  assert.equal(T.serverStatus(), "online");
  const comToken = clientes.filter((c) => c.comToken);
  assert.ok(comToken.length > 0);
  for (const c of comToken) assert.ok(typeof c.tokenOrigin === "string" && c.tokenOrigin, `cliente com token sem tokenOrigin (${c.url})`);

  // b) endereço trocado nas configurações: nada vai para o novo (nem o token), nem para o antigo
  const outro = criarServidorFalso();
  await outro.iniciar();
  try {
    const mark = fake.calls.length;
    await cfgApi.update("server.url", outro.url);
    fake.gen = 2;
    await ciclo();
    await limparLimite();
    const tr = escreverTranscricao("endereco", "c.jsonl", [linhaLimite("You've hit your 5-hour limit · resets 10:20pm")]);
    try {
      await T.checkLimitErrors();
      await commands["swapPlus.switchBest"]();
      await T.serverSwitch(2);
      await ciclo();
      await sleep(100);
    } finally {
      fs.rmSync(tr, { force: true });
    }
    assert.equal(outro.calls.length, 0, "nada (nem o token) foi para o endereço novo");
    assert.equal(fake.since(mark).length, 0, `nada para o antigo enquanto o endereço está trocado: ${fake.since(mark).map((c) => `${c.method} ${c.path}`).join(", ")}`);
    assert.equal(T.serverStatus(), "disconnected");
    assert.match(bar().text, /o endereço mudou/);
    assert.match(T.buildPayload().server.statusText, /o endereço do servidor mudou/);
    assert.equal(T.buildPayload().server.addressChanged, true);
    assert.equal(lerLogin().claudeAiOauth.accessToken, acessoServidor(1, 1), "nada gravado");

    // c) endereço de volta: online de novo, no servidor da conexão
    await cfgApi.update("server.url", fake.url);
    await ciclo();
    assert.equal(T.serverStatus(), "online");
    assert.ok(fake.since(mark).some(isHeartbeat));
    assert.deepEqual(lerLogin().claudeAiOauth, credOf(1, 2));
    assert.equal(outro.calls.length, 0);
  } finally {
    await cfgApi.update("server.url", fake.url);
    await outro.parar();
  }

  // d) conexão sem o endereço em que o token foi emitido: desconectado, sem chamadas
  await ciclo(); // assenta o ciclo que a mudança de endereço acima disparou
  const meta = globalState.get(META_KEY);
  await globalState.update(META_KEY, { ...meta, url: undefined });
  try {
    const mark = fake.calls.length;
    await ciclo();
    assert.equal(fake.since(mark).length, 0);
    assert.equal(T.serverStatus(), "disconnected");
    assert.match(T.buildPayload().server.statusText, /desconectado/);
  } finally {
    await globalState.update(META_KEY, meta);
  }
  await ciclo();
  assert.equal(T.serverStatus(), "online");
});

test("11. “Enviar os logins deste computador” só no modo servidor; no modo local a lista da tela é a do motor", { timeout: T_MAX }, async () => {
  await prepararServidor();
  fs.mkdirSync(path.join(HOME, ".claude-swap-backup"), { recursive: true });
  fs.writeFileSync(path.join(HOME, ".claude-swap-backup", "sequence.json"), JSON.stringify({ accounts: { 1: { alias: null } } }));
  assert.equal(T.buildPayload().server.canMigrate, true, "modo servidor, conectado e com contas locais: pode enviar");

  await cfgApi.update("mode", "local");
  await ciclo();
  const mark = fake.calls.length;
  const n0 = notes.length;
  swapPlusFalso.limpar();
  await tela({ type: "migrate" });
  assert.equal(fake.since(mark).length, 0, "nenhuma chamada ao servidor no modo local");
  assert.ok(!swapPlusFalso.calls().some((l) => l.startsWith("export")), `o motor não exporta nada: ${swapPlusFalso.calls().join(" | ")}`);
  assert.ok(notes.slice(n0).some((n) => /só funciona no modo servidor/.test(n.message)), "explica que é só no modo servidor");
  assert.equal(T.buildPayload().server.canMigrate, false, "o botão some no modo local");

  // Estado do servidor chegando no modo local (ex.: resposta atrasada) não muda a lista da tela.
  assert.equal(T.applyStateResponse(fake.stateFor(DEVICE_ID)), false);
  assert.deepEqual(
    T.buildPayload().accounts.map((a) => a.email),
    ["local1@exemplo.com"],
    "a lista continua a do motor deste computador"
  );
  assert.doesNotMatch(bar().text, /\$\(cloud\)/);
});

test("12. compare-and-swap: login novo que aparece no meio fica; leitura que falha não grava nem zera o “recusado”", { timeout: T_MAX }, async () => {
  await prepararServidor();

  // a) o 1º login vai para o servidor; enquanto a credencial é buscada, a pessoa entra com OUTRA conta
  let meio = null;
  fake.handlers["GET /v1/credential"] = () => {
    if (!meio) meio = loginNovo("meio", "meio@exemplo.com", "org-meio");
    return credBody();
  };
  const primeiro = loginNovo("primeiro", "primeiro@exemplo.com", "org-p");
  const mark = fake.calls.length;
  const n0 = notes.length;
  await ciclo();
  let calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1);
  assert.deepEqual(calls.filter(isLogins)[0].body.claudeAiOauth, primeiro.oauth);
  assert.equal(calls.filter(isCredential).length, 1);
  assert.ok(meio, "o login do meio apareceu durante a busca da credencial");
  let disk = lerLogin();
  assert.equal(disk.claudeAiOauth.refreshToken, meio.oauth.refreshToken, "o login novo do meio não foi sobrescrito");
  assert.equal(disk.claudeAiOauth.accessToken, meio.oauth.accessToken);
  assert.deepEqual(disk.mcpOAuth, MCP);
  assert.ok(!notes.slice(n0).some((n) => n.kind === "error"), "pula o ciclo sem aviso de erro");

  // próximo ciclo: o do meio vai para o servidor e então o acesso do servidor vai por cima
  delete fake.handlers["GET /v1/credential"];
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 2);
  assert.deepEqual(calls.filter(isLogins)[1].body.claudeAiOauth, meio.oauth);
  disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(1, 1));
  assert.equal("refreshToken" in disk.claudeAiOauth, false);

  // b) login recusado → “recusado”; depois o login fica ilegível: nada enviado, nada gravado, “recusado” fica
  fake.handlers["POST /v1/logins"] = () => ({ status: 422, body: { error: "identity_mismatch", message: "Não bate." } });
  loginNovo("recusado12", "r12@exemplo.com", "org-r12");
  await ciclo();
  assert.match(bar().text, /recusado pelo servidor/);
  const quebrado = "{ isto não é JSON";
  fs.writeFileSync(credFile(), quebrado, { mode: 0o600 });
  fake.gen = 3;
  const mark2 = fake.calls.length;
  await ciclo();
  const c2 = fake.since(mark2);
  assert.equal(c2.filter(isLogins).length, 0, "sem ler o login, nada é enviado");
  assert.equal(c2.filter(isCredential).length, 0, "nem buscado/gravado");
  assert.equal(lerTexto(credFile()), quebrado, "nada gravado por cima do login ilegível");
  assert.match(bar().text, /recusado pelo servidor/, "o “recusado” não foi zerado pela leitura que falhou");
  assert.ok(T.buildPayload().server.rejected, "a tela continua mostrando a recusa");
});

test("13. 422 stale_login → gasto e grava a do servidor; refresh_failed → tenta de novo em ~1 min sem aviso; POST /v1/logins com 90 s", { timeout: T_MAX }, async () => {
  await prepararServidor();

  // a) stale_login: o servidor já renovou esse login (o daqui está gasto)
  fake.handlers["POST /v1/logins"] = () => ({ status: 422, body: { error: "stale_login", message: "esse login já foi renovado pelo servidor" } });
  loginNovo("velho", "conta1@exemplo.com", "org-1");
  let mark = fake.calls.length;
  let n0 = notes.length;
  const p0 = pedidos.length;
  await ciclo();
  let calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1);
  assert.equal(calls.filter(isCredential).length, 1, "grava a conta do servidor");
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(1, 1));
  assert.ok(!notes.slice(n0).some((n) => n.kind === "warn" || n.kind === "error"), "sem aviso");
  await ciclo();
  assert.equal(fake.since(mark).filter(isLogins).length, 1, "login gasto não é reenviado");
  const posts = pedidos.slice(p0).filter((x) => x.method === "POST" && x.path === "/v1/logins");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].timeoutMs, 90000, "POST /v1/logins com timeout de 90 s");
  assert.ok(posts[0].tokenOrigin, "e com tokenOrigin");

  // b) refresh_failed: o servidor não conseguiu conferir agora → espera ~1 min, sem aviso e sem gravar por cima
  fake.handlers["POST /v1/logins"] = () => ({ status: 422, body: { error: "refresh_failed", message: "não consegui renovar esse login agora" } });
  const novo = loginNovo("tentar", "tentar@exemplo.com", "org-t");
  mark = fake.calls.length;
  n0 = notes.length;
  const antes = lerTexto(credFile());
  await ciclo();
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1, "não reenvia antes de ~1 min");
  assert.equal(calls.filter(isCredential).length, 0, "não grava por cima");
  assert.equal(lerTexto(credFile()), antes);
  assert.ok(!notes.slice(n0).some((n) => n.kind === "warn" || n.kind === "error"), "sem aviso");
  assert.doesNotMatch(bar().text, /recusado/);

  // passou 1 min: tenta de novo (agora aceito) e grava a do servidor
  T.srv.loginRetry.at -= 61000;
  delete fake.handlers["POST /v1/logins"];
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 2, "tentou de novo depois de ~1 min");
  assert.deepEqual(calls.filter(isLogins)[1].body.claudeAiOauth, novo.oauth);
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(1, 1));
});

test("14. enviado sem como gravar a do servidor: tira só o refreshToken; falha espera 1 min, troca manual não; sem “agora na conta N” se não gravou", { timeout: T_MAX }, async () => {
  await prepararServidor();

  // a) 409 no_account logo depois do envio
  fake.handlers["GET /v1/credential"] = () => ({ status: 409, body: { error: "no_account", message: "Nenhuma conta atribuída." } });
  const a = loginNovo("semconta", "semconta@exemplo.com", "org-s");
  let mark = fake.calls.length;
  let n0 = notes.length;
  await ciclo();
  assert.equal(fake.since(mark).filter(isLogins).length, 1);
  let disk = lerLogin();
  assert.equal("refreshToken" in disk.claudeAiOauth, false, "refresh token tirado do login enviado");
  assert.equal(disk.claudeAiOauth.accessToken, a.oauth.accessToken, "o acesso atual fica");
  assert.equal(disk.claudeAiOauth.expiresAt, a.oauth.expiresAt);
  assert.deepEqual(disk.mcpOAuth, MCP);
  assert.ok(notes.slice(n0).some((n) => n.kind === "warn" && /tirei daqui o refresh token/.test(n.message)));
  await ciclo();
  assert.equal(fake.since(mark).filter(isLogins).length, 1, "não reenvia");

  // b) gravação que falha depois do envio (credencial do servidor vencida → recusada pelo writeLive)
  fake.handlers["GET /v1/credential"] = () => ({
    status: 200,
    body: { number: 1, gen: fake.gen, claudeAiOauth: { ...credOf(1, fake.gen), expiresAt: Date.now() - 60000 }, oauthAccount: oauthAccountOf(1) },
  });
  const b = loginNovo("falha", "falha@exemplo.com", "org-f");
  mark = fake.calls.length;
  n0 = notes.length;
  await ciclo();
  disk = lerLogin();
  assert.equal("refreshToken" in disk.claudeAiOauth, false, "refresh token tirado");
  assert.equal(disk.claudeAiOauth.accessToken, b.oauth.accessToken);
  assert.equal(notes.slice(n0).filter((n) => n.kind === "error" && /não consegui gravar o login da conta 1/.test(n.message)).length, 1);

  // c) ciclo seguinte: espera 1 min depois da falha (não busca de novo)
  mark = fake.calls.length;
  await ciclo();
  assert.equal(fake.since(mark).filter(isCredential).length, 0, "espera 1 min depois da falha");

  // d) a troca manual não espera
  delete fake.handlers["GET /v1/credential"];
  n0 = notes.length;
  await T.serverSwitch(1);
  assert.equal(fake.since(mark).filter(isCredential).length, 1, "a troca manual tenta na hora");
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(1, 1));
  assert.ok(notes.slice(n0).some((n) => n.kind === "info" && /agora na conta 1/.test(n.message)));

  // e) sem gravar: nada de “agora na conta N”
  fake.handlers["GET /v1/credential"] = () => ({ status: 409, body: { error: "no_account", message: "Nenhuma conta." } });
  n0 = notes.length;
  await T.serverSwitch(2);
  assert.ok(!notes.slice(n0).some((n) => /agora na conta/.test(n.message)), "não diz que trocou");
  assert.ok(notes.slice(n0).some((n) => n.kind === "warn" && /não gravei aqui/.test(n.message)), "diz que não gravou e por quê");
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(1, 1), "o login ficou como estava");
});

test("15. fila única: troca espera o ciclo; desligar no meio do ciclo não grava; desligar espera o ciclo terminar", { timeout: T_MAX }, async () => {
  await prepararServidor();

  // a) troca manual pedida durante o batimento: só sai depois do ciclo
  const h1 = segurar();
  let sobrepos = false;
  fake.handlers["POST /v1/heartbeat"] = h1.handler;
  fake.handlers["POST /v1/switch"] = (call) => {
    if (h1.no) sobrepos = true;
    fake.assigned = call.body && call.body.number != null ? Number(call.body.number) : 1;
    return { status: 200, body: fake.stateFor(call.device) };
  };
  const mark = fake.calls.length;
  const c1 = ciclo();
  await waitFor(() => h1.no, 5000, "batimento no ar");
  const troca = T.serverSwitch(2);
  await sleep(150);
  assert.equal(fake.since(mark).filter(isSwitch).length, 0, "a troca espera o ciclo terminar");
  h1.liberar();
  await c1;
  await troca;
  assert.equal(sobrepos, false, "nunca ao mesmo tempo");
  assert.equal(fake.since(mark).filter(isSwitch).length, 1);
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(2, 1));

  // b) desligado (pelas configurações) no meio do batimento: o ciclo não busca nem grava
  const h2 = segurar();
  fake.handlers = { "POST /v1/heartbeat": h2.handler };
  fake.gen = 5;
  const antes = lerTexto(credFile());
  const mark2 = fake.calls.length;
  const c2 = ciclo();
  await waitFor(() => h2.no, 5000, "batimento no ar");
  await cfgApi.update("enabled", false);
  h2.liberar();
  await c2;
  await sleep(50);
  assert.equal(fake.since(mark2).filter(isCredential).length, 0, "desligado no meio: não busca nem grava");
  assert.equal(lerTexto(credFile()), antes);
  await cfgApi.update("enabled", true);
  await ciclo();

  // c) desligar pelo comando espera o ciclo em andamento terminar
  const h3 = segurar();
  fake.handlers = { "POST /v1/heartbeat": h3.handler };
  const c3 = ciclo();
  await waitFor(() => h3.no, 5000, "batimento no ar");
  let desligou = false;
  const t = commands["swapPlus.toggleEnabled"]().then(() => (desligou = true));
  await sleep(150);
  assert.equal(desligou, false, "desligar espera o ciclo em andamento");
  assert.notEqual(store["swapPlus.enabled"], false, "continua ligado até o ciclo terminar");
  h3.liberar();
  await c3;
  await t;
  assert.equal(store["swapPlus.enabled"], false);
  fake.handlers = {};
  await cfgApi.update("enabled", true);
  await ciclo();
});

test("16. modo servidor desliga a tela de login do Claude Code (aviso uma vez) e devolve o valor de antes ao sair", { timeout: T_MAX }, async () => {
  const cc = getConfiguration("claudeCode");
  await prepararServidor();
  await T.syncLoginPrompt();
  assert.equal(store["claudeCode.disableLoginPrompt"], true);
  assert.equal(T.buildPayload().server.loginPromptOff, true);
  assert.equal(notes.filter((n) => AVISO_LOGIN.test(n.message)).length, 1, "avisa uma vez só");

  // a) voltar ao modo local pela tela (com confirmação): volta a “não definido”, como era antes
  ui.warn = (_m, b) => (b.includes("Voltar ao modo local") ? "Voltar ao modo local" : undefined);
  await tela({ type: "setMode", mode: "local" });
  ui.warn = null;
  await T.syncLoginPrompt();
  assert.equal(T.serverMode(), false);
  assert.equal("claudeCode.disableLoginPrompt" in store, false, "voltou a não estar definido");

  // b) com valor anterior false: liga no modo servidor e volta false ao desconectar
  await cc.update("disableLoginPrompt", false);
  await cfgApi.update("mode", "server");
  await T.syncLoginPrompt();
  await ciclo();
  assert.equal(store["claudeCode.disableLoginPrompt"], true);
  await desconectar();
  await T.syncLoginPrompt();
  assert.equal(store["claudeCode.disableLoginPrompt"], false, "volta ao valor de antes");
  await cc.update("disableLoginPrompt", undefined);
  assert.equal(notes.filter((n) => AVISO_LOGIN.test(n.message)).length, 1, "o aviso não se repete");
});

test("17. troca de conta tira o dispositivo confiável; Windows com o Gerenciador de Credenciais: não grava e explica", { timeout: T_MAX }, async () => {
  await prepararServidor();
  // R2: mesma conta (gen novo) mantém; outra conta tira
  fs.writeFileSync(credFile(), JSON.stringify({ ...lerLogin(), trustedDeviceToken: "tdt-teste", trustedDeviceEnrolledAfterRefusalAtMs: 123 }), { mode: 0o600 });
  fake.gen = 2;
  await ciclo();
  let disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(1, 2));
  assert.equal(disk.trustedDeviceToken, "tdt-teste", "mesma conta: o dispositivo confiável fica");
  assert.equal(disk.trustedDeviceEnrolledAfterRefusalAtMs, 123);
  fake.assigned = 2;
  await ciclo();
  disk = lerLogin();
  assert.deepEqual(disk.claudeAiOauth, credOf(2, 2));
  assert.equal("trustedDeviceToken" in disk, false, "outra conta: tira o dispositivo confiável da anterior");
  assert.equal("trustedDeviceEnrolledAfterRefusalAtMs" in disk, false);
  assert.deepEqual(disk.mcpOAuth, MCP);

  // R3: Claude Code (Windows) lendo do Gerenciador de Credenciais → não grava e explica (barra e tela)
  process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN = "1";
  auth._test.setPlatform("win32");
  try {
    fake.gen = 3;
    const antes = lerTexto(credFile());
    const mark = fake.calls.length;
    await ciclo();
    const calls = fake.since(mark);
    assert.ok(calls.some(isHeartbeat), "o batimento continua");
    assert.equal(calls.filter(isCredential).length, 0, "não busca nem grava a credencial");
    assert.equal(lerTexto(credFile()), antes);
    assert.match(bar().text, /não consegue trocar o login aqui/);
    assert.match(String(bar().tooltip), /Gerenciador de Credenciais do Windows/);
    const sv = T.buildPayload().server;
    assert.equal(sv.storeBlocked, true);
    assert.ok(sv.storeWarnings.some((w) => /Gerenciador de Credenciais do Windows/.test(w)));
  } finally {
    delete process.env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN;
    auth._test.setPlatform(null);
  }
  await ciclo();
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(2, 3), "sem o aviso, volta a gravar");
  assert.equal(T.buildPayload().server.storeWarnings.length, 0);
});

test("18. várias janelas: só a dona faz o batimento e grava; trava de envio entre janelas", { timeout: T_MAX }, async () => {
  await prepararServidor();
  const f = T.ownerFile();

  // a) outra janela é a dona (viva): esta só lê o estado
  fs.writeFileSync(f, JSON.stringify({ id: "outra-janela", at: Date.now() }));
  fake.gen = 4;
  const antes = lerTexto(credFile());
  let mark = fake.calls.length;
  await ciclo();
  let calls = fake.since(mark);
  assert.equal(calls.filter(isState).length, 1, "lê o estado");
  assert.equal(calls.filter(isHeartbeat).length, 0, "não faz o batimento");
  assert.equal(calls.filter(isCredential).length, 0, "não grava");
  assert.equal(lerTexto(credFile()), antes);
  assert.equal(T.buildPayload().server.otherWindow, true);

  // b) a dona parou de renovar há mais de 25 s: esta janela assume
  fs.writeFileSync(f, JSON.stringify({ id: "outra-janela", at: Date.now() - 26000 }));
  mark = fake.calls.length;
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isHeartbeat).length, 1);
  assert.equal(calls.filter(isCredential).length, 1);
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(1, 4));
  assert.notEqual(JSON.parse(fs.readFileSync(f, "utf8")).id, "outra-janela");

  // c) troca pedida nesta janela com outra dona viva: esta assume e grava
  fs.writeFileSync(f, JSON.stringify({ id: "outra-janela", at: Date.now() }));
  await T.serverSwitch(2);
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(2, 4));

  // d) outra janela está enviando este login (trava por login): não envia de novo nem grava por cima
  const n = loginNovo("trava", "trava@exemplo.com", "org-trava");
  const dir = T.uploadLockDir(T.loginKey({ oauth: n.oauth }));
  fs.mkdirSync(dir);
  mark = fake.calls.length;
  try {
    const antes2 = lerTexto(credFile());
    await ciclo();
    calls = fake.since(mark);
    assert.equal(calls.filter(isLogins).length, 0, "outra janela está enviando");
    assert.equal(lerTexto(credFile()), antes2, "nada por cima do login que está indo");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  await ciclo();
  calls = fake.since(mark);
  assert.equal(calls.filter(isLogins).length, 1, "livre a trava, envia");
  assert.deepEqual(lerLogin().claudeAiOauth, credOf(2, 4));
});

test("19. 1ª conexão a um servidor: oferece levar as regras deste computador (uma vez por servidor)", { timeout: T_MAX }, async () => {
  resetUi();
  await desconectar();
  const outro = criarServidorFalso();
  await outro.iniciar();
  const BTN = "Usar as regras deste computador no servidor";
  try {
    await cfgApi.update("rules.sessionSwitchPct", 85);
    await cfgApi.update("rules.strategy", "headroom");
    // swapPlus.autoSwitch.enabled: aqui false (padrão); no servidor falso: true
    outro.pairCodes.set("REGRAS0001", { id: "dev-regras" });
    ui.input = (o) => (/nome deste computador/.test(o.title || "") ? "PC regras" : codigoConexao("REGRAS0001", outro.url));
    ui.info = (_m, b) => (b.includes(BTN) ? BTN : undefined);
    let n0 = notes.length;
    await commands["swapPlus.connectServer"]("code");
    assert.equal(T.serverStatus(), "online");
    const oferta = notes.slice(n0).find((n) => n.buttons.includes(BTN));
    assert.ok(oferta, "ofereceu levar as regras");
    assert.match(oferta.detail, /Troca na sessão de 5h: aqui 85% · no servidor 90%/);
    assert.match(oferta.detail, /Troca automática: aqui desligada · no servidor ligada/);
    const puts = outro.calls.filter(isRules);
    assert.equal(puts.length, 1, "PUT /v1/rules");
    assert.equal(puts[0].body.autoSwitch, false);
    assert.equal(puts[0].body.rules.sessionPct, 85);
    assert.equal(puts[0].body.rules.strategy, "headroom");
    assert.deepEqual(
      Object.keys(puts[0].body.rules).sort(),
      ["cooldownMin", "expiringHours", "marginPct", "modelPct", "onModelLimit", "preferModel", "sessionPct", "strategy", "weeklyPct"]
    );
    assert.equal(fake.calls.filter(isRules).length, 0, "nada no outro servidor");

    // conectar de novo ao mesmo servidor: não pergunta outra vez
    outro.pairCodes.set("REGRAS0002", { id: "dev-regras-2" });
    ui.input = (o) => (/nome deste computador/.test(o.title || "") ? "PC regras" : codigoConexao("REGRAS0002", outro.url));
    ui.warn = (_m, b) => (b.includes("Conectar de novo") ? "Conectar de novo" : undefined);
    n0 = notes.length;
    await commands["swapPlus.connectServer"]("code");
    assert.ok(!notes.slice(n0).some((n) => n.buttons.includes(BTN)), "uma vez por servidor");
    assert.equal(outro.calls.filter(isRules).length, 1);
  } finally {
    resetUi();
    await desconectar();
    await cfgApi.update("server.url", fake.url);
    await cfgApi.update("rules.sessionSwitchPct", undefined);
    await cfgApi.update("rules.strategy", undefined);
    await outro.parar();
  }
});

test("20. de novo, depois dos cenários novos: nenhum token em lugar nenhum; todo cliente com token leva tokenOrigin", { timeout: T_MAX }, async () => {
  const comToken = clientes.filter((c) => c.comToken);
  assert.ok(comToken.length > 0);
  for (const c of comToken) assert.ok(typeof c.tokenOrigin === "string" && c.tokenOrigin, `cliente com token sem tokenOrigin (${c.url})`);
  conferirSemTokens();
});
