"use strict";
// Apoio dos testes do cliente: um servidor Swap Plus de mentira (HTTP em 127.0.0.1, a API da server/SPEC.md que o
// cliente usa), pastas temporárias e um cliente montado com as bibliotecas de verdade (plus/serverClient.js e
// plus/claudeAuth.js gravando em arquivo, nunca no Keychain).

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const lib = require("../../plus/serverClient");
const auth = require("../../plus/claudeAuth");
const regras = require("../../plus/rules");
const modelSwitch = require("../../plus/modelSwitch");
const atividade = require("../src/atividade");
const config = require("../src/config");
const { Estado } = require("../src/estado");
const { Cliente } = require("../src/ciclo");

const logMudo = { debug() {}, info() {}, warn() {}, error() {} };
const logTeste = process.env.TEST_LOG ? { debug: console.log, info: console.log, warn: console.warn, error: console.error } : logMudo;

function pastaTemp(prefixo = "swap-plus-cliente-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefixo));
}

function conta(numero, extra = {}) {
  return {
    number: numero,
    email: `conta${numero}@exemplo.com`,
    organizationName: "Empresa de Teste",
    organizationUuid: `org-${numero}`,
    plan: { label: "Max" },
    alias: null,
    active: false,
    disabled: false,
    dead: false,
    usageStatus: "ok",
    usage: { fiveHour: { pct: 10, resetsAt: null }, sevenDay: { pct: 20, resetsAt: null } },
    usageAgeSeconds: 30,
    lastGoodUsage: null,
    lastGoodAgeSeconds: null,
    loginExpiresAt: null,
    accessExpiresAt: null,
    assignedDevices: [],
    ...extra,
  };
}

/**
 * Servidor de mentira. Campos que o teste mexe à vontade:
 *   s.contas        { n: { gen, accessToken, expiresAt, publica: conta(n) } }
 *   s.atribuida     número da conta deste cliente (null = sem conta)
 *   s.codigo        código de pareamento aceito
 *   s.token         token do dispositivo emitido no pareamento
 *   s.regras, s.registros, s.trocaAutomatica, s.avisos
 *   s.aoLimite      (rotulo) → { switched, text }  (pode mudar s.atribuida)
 *   s.aoBatimento   (corpo) → nada; roda antes da resposta do batimento (pode mudar s.atribuida: o servidor decidiu)
 *   s.melhorConta   conta que o servidor escolhe quando pedem "a melhor" (POST /v1/switch { number: null })
 *   s.proximaFalha  { status, corpo } devolvida uma vez no próximo pedido autenticado
 *   s.interceptar   (rota, corpo) → { status, corpo } | null: resposta trocada para um pedido autenticado
 *   s.derrubar      quantos dos próximos pedidos têm a conexão derrubada sem resposta (falha de rede)
 *   s.foraDoAr      true = toda conexão cai antes de qualquer pedido (servidor fora do ar, sem soltar a porta:
 *                   nenhum outro processo pode pegá-la no meio do teste); os pedidos não entram em s.chamadas
 *   s.chamadas      [{ metodo, caminho, corpo, autenticado }]
 *   s.fechar()      para de atender (a porta fica fechada); s.reabrir() volta a atender na mesma porta
 */
async function servidorFalso(agora = Date.now) {
  const s = {
    contas: {},
    atribuida: null,
    codigo: "ABCDEFGH23",
    token: "tok-" + crypto.randomBytes(24).toString("base64url"),
    deviceId: "dev-" + crypto.randomBytes(6).toString("hex"),
    regras: { ...regras.RULE_DEFAULTS },
    registros: {},
    trocaAutomatica: true,
    avisos: [],
    aoLimite: null,
    aoBatimento: null,
    melhorConta: null,
    proximaFalha: null,
    interceptar: null,
    derrubar: 0,
    foraDoAr: false,
    chamadas: [],
    revogados: [],
    google: null, // { sessionId, pollToken, respostas: [{ status } | { http: 429 }, ..] } — uma resposta por consulta
    nomesUsados: new Set(), // servidor 2.8.0+: nomes já usados por outro serviço → 409 name_taken
  };
  s.novaConta = (n, extra = {}) => {
    s.contas[n] = { gen: 1, accessToken: `sk-ant-oat01-ACESSO-conta${n}-g1`, expiresAt: agora() + 6 * 3600 * 1000, publica: conta(n, extra) };
    return s.contas[n];
  };
  /** Renovação no servidor: token e validade novos, gen sobe. */
  s.renovar = (n) => {
    const c = s.contas[n];
    c.gen += 1;
    c.accessToken = `sk-ant-oat01-ACESSO-conta${n}-g${c.gen}`;
    c.expiresAt = agora() + 8 * 3600 * 1000 + c.gen;
    return c;
  };
  s.estado = () => {
    const c = s.atribuida !== null ? s.contas[s.atribuida] : null;
    const viva = c && !c.publica.dead;
    return {
      serverTime: agora(),
      version: "9.9.9-teste",
      device: { id: s.deviceId, name: "teste", assigned: s.atribuida, lastSwitchAt: 0, canUploadLogins: true },
      list: { schemaVersion: 1, activeAccountNumber: s.atribuida, accounts: Object.values(s.contas).map((x) => ({ ...x.publica, active: x.publica.number === s.atribuida })) },
      records: s.registros,
      rules: s.regras,
      autoSwitch: s.trocaAutomatica,
      credential: viva ? { number: c.publica.number, gen: c.gen, expiresAt: c.expiresAt } : null,
      history: [],
      devices: [],
      diag: {},
      warnings: s.avisos,
    };
  };
  s.contar = (metodo, caminho) => s.chamadas.filter((c) => c.metodo === metodo && c.caminho === caminho).length;

  const servidor = http.createServer((req, res) => {
    const partes = [];
    req.on("data", (d) => partes.push(d));
    req.on("end", () => {
      let corpo = null;
      try {
        corpo = partes.length ? JSON.parse(Buffer.concat(partes).toString("utf8")) : null;
      } catch {}
      const caminho = req.url.split("?")[0];
      const autenticado = req.headers.authorization === `Bearer ${s.token}`;
      s.chamadas.push({ metodo: req.method, caminho, corpo, autenticado, ua: req.headers["user-agent"] || null });
      if (s.derrubar > 0) {
        s.derrubar -= 1;
        req.socket.destroy(); // o cliente vê a conexão cair no meio (erro de rede)
        return;
      }
      const responder = (status, obj) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      const rota = `${req.method} ${caminho}`;
      if ((rota === "POST /v1/pair" || rota === "POST /v1/login/start") && corpo && s.nomesUsados.has(corpo.name)) {
        return responder(409, { error: "name_taken", message: "Já existe um serviço com este nome; escolha outro ou desconecte o antigo no painel." });
      }
      if (rota === "POST /v1/pair") {
        if (!corpo || corpo.code !== s.codigo) return responder(403, { error: "bad_code", message: "Código inválido ou vencido." });
        s.pareado = { name: corpo.name, platform: corpo.platform, ...(corpo.replaces ? { replaces: corpo.replaces } : {}) };
        return responder(200, { deviceId: s.deviceId, token: s.token });
      }
      if (rota === "POST /v1/login/start") {
        if (!s.google) return responder(503, { error: "google_off", message: "Login com Google desligado." });
        return responder(200, { sessionId: s.google.sessionId, pollToken: s.google.pollToken, authUrl: `http://127.0.0.1:${servidor.address().port}/auth/google/start?s=${s.google.sessionId}`, expiresAt: agora() + 600000 });
      }
      if (rota === "POST /v1/login/poll") {
        const r = (s.google && s.google.respostas.shift()) || { status: "pending" };
        if (r.http) return responder(r.http, r.corpo || { error: `http_${r.http}`, message: "falha de teste" }); // ex.: { http: 429 }
        if (r.status === "expired") return responder(404, { error: "expired", message: "Venceu." });
        return responder(200, r.status === "ok" ? { status: "ok", deviceId: s.deviceId, token: s.token } : r);
      }
      if (!autenticado) return responder(401, { error: "unauthorized", message: "Token inválido." });
      if (s.proximaFalha) {
        const f = s.proximaFalha;
        s.proximaFalha = null;
        return responder(f.status, f.corpo || { error: `http_${f.status}`, message: "falha de teste" });
      }
      const trocada = s.interceptar ? s.interceptar(rota, corpo) : null;
      if (trocada) return responder(trocada.status || 200, trocada.corpo === undefined ? {} : trocada.corpo);
      if (rota === "POST /v1/heartbeat") {
        if (s.aoBatimento) s.aoBatimento(corpo);
        return responder(200, s.estado());
      }
      if (rota === "GET /v1/state") return responder(200, s.estado());
      if (rota === "GET /v1/credential") {
        const c = s.atribuida !== null ? s.contas[s.atribuida] : null;
        if (!c || c.publica.dead) return responder(409, { error: "no_account", message: "Sem conta." });
        return responder(200, {
          number: c.publica.number,
          gen: c.gen,
          claudeAiOauth: { accessToken: c.accessToken, expiresAt: c.expiresAt, scopes: ["user:inference", "user:profile"], subscriptionType: "max", rateLimitTier: "default_claude_max_20x", refreshTokenExpiresAt: agora() + 30 * 86400000 },
          oauthAccount: { emailAddress: c.publica.email, organizationUuid: c.publica.organizationUuid, organizationName: c.publica.organizationName, accountUuid: `acc-${c.publica.number}` },
        });
      }
      if (rota === "POST /v1/events") {
        const r = s.aoLimite ? s.aoLimite(corpo && corpo.label) : { switched: false, text: "nada a fazer" };
        return responder(200, { ...r, state: s.estado() });
      }
      if (rota === "POST /v1/switch") {
        if (corpo && corpo.number !== null && corpo.number !== undefined) s.atribuida = corpo.number;
        else if (s.melhorConta !== null) s.atribuida = s.melhorConta;
        return responder(200, s.estado());
      }
      if (req.method === "DELETE" && caminho.startsWith("/v1/devices/")) {
        s.revogados.push(decodeURIComponent(caminho.slice("/v1/devices/".length)));
        return responder(200, { ok: true });
      }
      return responder(404, { error: "not_found", message: "Rota desconhecida." });
    });
  });
  servidor.on("connection", (soquete) => {
    if (s.foraDoAr) soquete.destroy();
  });
  await new Promise((r) => servidor.listen(0, "127.0.0.1", r));
  const porta = servidor.address().port;
  s.url = `http://127.0.0.1:${porta}`;
  s.codigoDeConexao = () => "swapplus1:" + Buffer.from(JSON.stringify({ url: s.url, code: s.codigo, fp: null })).toString("base64url");
  s.fechar = () => new Promise((r) => servidor.close(r));
  /** Depois de `fechar()`: volta a atender na mesma porta (o servidor "voltou"). */
  s.reabrir = () =>
    new Promise((resolve, reject) => {
      servidor.once("error", reject);
      servidor.listen(porta, "127.0.0.1", () => {
        servidor.removeListener("error", reject);
        resolve();
      });
    });
  return s;
}

/**
 * Embrulha o claudeAuth de verdade: conta as chamadas de cada função e deixa o teste trocar uma delas
 * (ex.: `espiao.trocas.writeLive = async () => { throw ... }`; apagar a troca volta à função de verdade).
 */
function authEspiao(real = auth) {
  const chamadas = { readLive: 0, writeLive: 0, writeOauthAccount: 0, liveIdentity: 0, credentialStoreWarnings: 0 };
  const trocas = {};
  const espiao = { chamadas, trocas, _test: real._test };
  for (const nome of Object.keys(chamadas)) {
    espiao[nome] = (...args) => {
      chamadas[nome] += 1;
      return (trocas[nome] || real[nome])(...args);
    };
  }
  return espiao;
}

/** Data de alteração (ms) de um arquivo ou pasta. */
function definirMtime(caminho, ms) {
  const d = new Date(ms);
  fs.utimesSync(caminho, d, d);
}

/**
 * Grava uma transcrição do Claude Code na pasta de login: projects/<projeto>/<nome>.jsonl ou, com `sessao`,
 * a de um subagente: projects/<projeto>/<sessao>/subagents/<nome>.jsonl. `linhas`: objetos (viram JSON) ou texto.
 * `mtime` (ms) acerta a data de alteração do arquivo. → caminho do arquivo
 */
function gravarTranscricao(pastaClaude, { projeto = "projeto-de-teste", nome = "sessao-1", sessao = null, linhas = [], mtime = null } = {}) {
  const dir = sessao ? path.join(pastaClaude, "projects", projeto, sessao, "subagents") : path.join(pastaClaude, "projects", projeto);
  fs.mkdirSync(dir, { recursive: true });
  const arquivo = path.join(dir, `${nome}.jsonl`);
  fs.writeFileSync(arquivo, linhas.map((l) => (typeof l === "string" ? l : JSON.stringify(l)) + "\n").join(""));
  if (mtime !== null) definirMtime(arquivo, mtime);
  return arquivo;
}

/** Linha de transcrição com o erro de limite, como o Claude Code grava. `tipo` vira quotaLimits.rateLimitType. */
function linhaDeLimite(texto, ts, tipo = null) {
  const linha = { type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: new Date(ts).toISOString(), message: { content: [{ type: "text", text: texto }] } };
  if (tipo) linha.quotaLimits = { rateLimitType: tipo };
  return linha;
}

/** Linha de transcrição de uma resposta do modelo `id`. */
function linhaDeModelo(id, ts = Date.now()) {
  return { type: "assistant", timestamp: new Date(ts).toISOString(), message: { role: "assistant", model: id, content: [{ type: "text", text: "ok" }] } };
}

/** Guarda variáveis de ambiente do processo e devolve a função que as põe de volta como estavam. */
function guardarAmbiente(nomes) {
  const antes = {};
  for (const n of nomes) antes[n] = Object.prototype.hasOwnProperty.call(process.env, n) ? process.env[n] : undefined;
  return () => {
    for (const n of nomes) {
      if (antes[n] === undefined) delete process.env[n];
      else process.env[n] = antes[n];
    }
  };
}

/**
 * Monta um cliente de verdade em pastas temporárias. `relogio.t` é o "agora" (o teste avança à mão).
 * `conectar: true` grava a conexão com o token do servidor de mentira.
 * Trocáveis: `auth` (ex.: authEspiao()), `atividade`, `log` e `aoEsperar(ms, parar)` — chamado a cada espera que o
 * cliente pede (a espera nunca dorme de verdade), para o teste avançar o relógio ou parar o `rodar()`.
 */
async function montar({
  servidor,
  presenca = "auto",
  modelos = "",
  substituirLogin = false,
  conectar = true,
  t0 = Date.now(),
  auth: authDoTeste = null,
  atividade: atividadeDoTeste = null,
  log = logTeste,
  aoEsperar = null,
} = {}) {
  // O relógio do teste parte da hora de verdade: o claudeAuth recusa gravar um acesso já vencido pelo relógio real.
  const dir = pastaTemp();
  const pastaClaude = path.join(dir, "claude");
  const relogio = { t: t0 };
  const agora = () => relogio.t;
  const cfg = config.resolver({ dir, pastaClaude, presenca, modelos, nome: "cliente-de-teste", substituirLogin }, {});
  config.aplicarAmbiente(cfg);
  auth._test.setStore("file");
  const estado = new Estado(dir);
  if (conectar && servidor) await estado.gravarConexao({ url: servidor.url, fp: null, deviceId: servidor.deviceId, token: servidor.token, nome: cfg.nome, via: "codigo", conectadoEm: agora() });
  const esperas = [];
  const espera = async (ms, parar) => {
    esperas.push(ms);
    if (aoEsperar) await aoEsperar(ms, parar);
  };
  const cliente = new Cliente({ cfg, estado, lib, auth: authDoTeste || auth, regras, modelSwitch, atividade: atividadeDoTeste || atividade, agora, log, espera, versao: "teste" });
  const lerCredencial = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pastaClaude, ".credentials.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const lerGlobal = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pastaClaude, ".claude.json"), "utf8"));
    } catch {
      return null;
    }
  };
  /** Simula o Claude Code sendo usado agora (como o plugin do Hermes: mexe em sessions/, sem transcrição). */
  const usarClaude = () => {
    fs.mkdirSync(path.join(pastaClaude, "sessions"), { recursive: true });
    const d = new Date(relogio.t);
    fs.utimesSync(path.join(pastaClaude, "sessions"), d, d);
  };
  const limpar = () => {
    auth._test.reset();
    fs.rmSync(dir, { recursive: true, force: true });
  };
  return { dir, pastaClaude, relogio, agora, cfg, estado, cliente, esperas, lerCredencial, lerGlobal, usarClaude, limpar };
}

module.exports = {
  servidorFalso,
  montar,
  conta,
  pastaTemp,
  logTeste,
  authEspiao,
  definirMtime,
  gravarTranscricao,
  linhaDeLimite,
  linhaDeModelo,
  guardarAmbiente,
  lib,
  auth,
  regras,
  modelSwitch,
  atividade,
  config,
};
