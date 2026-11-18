"use strict";
// Swap Plus — cliente da API do Swap Plus Servidor (modo servidor da extensão).
//
// - createServerClient({ url, token, fp, tokenOrigin }) → { request(method, path, body), url, fp, origin }
//   JSON de ida e volta, timeout de 15 s, https/http do próprio Node.
//   IMPORTANTE: quem passa `token` DEVE passar também `tokenOrigin` = a origem
//   (ou o endereço) do servidor que EMITIU esse token (o endereço guardado na
//   hora de conectar, não o das configurações). Se a origem de `url` for outra,
//   lança origin_mismatch e nada sai — assim um endereço trocado nas
//   configurações (ex.: settings.json de um projeto aberto) não recebe o token.
//   Sem tokenOrigin a conferência não é feita (só por compatibilidade).
// - Só https://. http:// é aceito apenas para localhost / 127.0.0.1 / [::1]
//   (testes e túnel local); fora disso: erro bad_url. Vale para
//   createServerClient, parseConnectCode, pair, loginStart e loginPoll.
// - Nunca segue redirecionamento: o http/https do Node não segue e uma resposta
//   3xx vira erro (code "http_3xx"). O pedido (e o token) só vai para o
//   host:porta de `url`.
// - Com `fp` (impressão digital sha256 do certificado, formato do Node
//   "AA:BB:...", vinda do código de conexão) aceita SÓ o certificado com essa
//   impressão digital — é o caso do servidor com certificado próprio.
//   Sem `fp`, validação TLS normal (servidor atrás de proxy com certificado público).
// - parseConnectCode("swapplus1:...") → { url, code, fp }
// - pair({ url, fp, code, name, platform }) → { deviceId, token }
// - loginStart({ url, fp, name, platform }) → { sessionId, pollToken, authUrl, expiresAt }
// - loginPoll({ url, fp, sessionId, pollToken }) → { status: "pending" } |
//   { status: "ok", deviceId, token } | { status: "denied", email } | { status: "expired" }
//   (entrar com a conta Google: o navegador abre authUrl e a extensão consulta o resultado)
//
// Toda requisição leva User-Agent "SwapPlus-VSCode/<versão>" e Accept JSON: o
// servidor fica atrás da Cloudflare, que recusa cliente sem User-Agent ou com o
// padrão de bibliotecas.
//
// Sobre a fixação da impressão digital: no Node, checkServerIdentity só é chamado
// quando a cadeia do certificado já foi aceita (num certificado próprio ela nunca
// é), e com rejectUnauthorized:false um erro dele não derruba a conexão. Por isso
// a conferência que vale é feita aqui mesmo: abre o TLS, compara
// getPeerCertificate().fingerprint256 e só então manda o pedido HTTP por esse
// socket. Com impressão digital diferente nenhum byte do pedido (nem o token) sai.
//
// O token do dispositivo nunca entra em mensagem de erro nem em log.

const http = require("http");
const https = require("https");
const net = require("net");
const tls = require("tls");

const TIMEOUT_MS = 15000;
// Node tenta cada endereço (IPv6 e IPv4 da Cloudflare, intercalados) por só 250 ms e desiste com ETIMEDOUT
// se nenhum conectar nesse tempo. Em rede com 300–500 ms até a Cloudflare (medido no Mac do Paulo em 18/11:
// 1 em cada 4 pedidos falhava em ~0,5 s), isso virava "servidor fora do ar" com o servidor no ar. Com 2,5 s
// ainda falhava 1 em 30 (pacote perdido no Wi-Fi: o macOS reenvia a abertura da conexão depois de 1 s e de 3 s).
// 6 s por endereço cobre isso; IPv6 sem rota falha na hora, então o pior caso real fica dentro dos 15 s.
const ATTEMPT_MS = 6000;
const MAX_BODY = 4 * 1024 * 1024;
const CONNECT_PREFIX = "swapplus1:";

let userAgent = "SwapPlus-VSCode";
try {
  const v = require("./package.json").version;
  if (v) userAgent += "/" + v;
} catch {}

function fail(code, message, status, extra) {
  const e = new Error(message);
  e.code = code;
  e.status = status || 0;
  if (extra) Object.assign(e, extra);
  return e;
}

/** "aa:bb:..." ou 64 hex corridos → "AA:BB:..." (formato do Node). null se inválida. */
function normalizeFingerprint(fp) {
  if (typeof fp !== "string") return null;
  const hex = fp.replace(/[\s:]/g, "").toUpperCase();
  if (!/^[0-9A-F]{64}$/.test(hex)) return null;
  return hex.match(/../g).join(":");
}

const HTTP_LOCAL_ONLY = "Use https:// (http:// só para localhost).";
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

/** localhost, 127.0.0.1 ou [::1] (o URL do Node já normaliza maiúsculas e "127.1"). */
function isLoopbackHost(hostname) {
  return LOOPBACK_HOSTS.has(String(hostname || "").toLowerCase());
}

/** http:// fora do próprio computador: o token e os logins passariam sem criptografia. */
function insecureHttp() {
  return fail("bad_url", HTTP_LOCAL_ONLY, 0, { reason: "insecure_http" });
}

function parseBaseUrl(url) {
  let u;
  try {
    u = new URL(String(url || "").trim());
  } catch {
    throw fail("bad_url", "Endereço do servidor inválido.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw fail("bad_url", "O endereço do servidor precisa começar com https://.");
  if (u.username || u.password) throw fail("bad_url", "O endereço do servidor não pode ter usuário/senha.");
  if (u.protocol === "http:" && !isLoopbackHost(u.hostname)) throw insecureHttp();
  return u;
}

/** Origem ("https://host[:porta]") de um endereço http/https; null se não der para ler. */
function originOf(url) {
  try {
    const u = new URL(String(url == null ? "" : url).trim());
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    return u.origin;
  } catch {
    return null;
  }
}

function statusMessage(status) {
  switch (status) {
    case 400:
      return "O servidor recusou o pedido (dados inválidos).";
    case 401:
      return "Este computador não está autorizado no servidor (acesso inválido ou revogado). Conecte de novo.";
    case 403:
      return "O servidor recusou o acesso a partir deste endereço.";
    case 404:
      return "Rota não encontrada no servidor (versões diferentes?).";
    case 409:
      return "O servidor recusou o pedido por conflito.";
    case 413:
      return "Pedido grande demais para o servidor.";
    case 429:
      return "Muitas tentativas no servidor; espere alguns minutos.";
    default:
      if (status >= 300 && status < 400) {
        return `O servidor mandou para outro endereço (status ${status}); o Swap Plus não segue redirecionamentos. Confira o endereço do servidor.`;
      }
      return status >= 500 ? `Erro no servidor (status ${status}).` : `O servidor respondeu com status ${status}.`;
  }
}

const TLS_ERROR = /CERT|SELF_SIGNED|UNABLE_TO_VERIFY|ERR_TLS|ERR_SSL|EPROTO|HOSTNAME/;
const NET_MESSAGES = {
  ECONNREFUSED: "O servidor recusou a conexão (está no ar? a porta está certa?).",
  ENOTFOUND: "Não encontrei o endereço do servidor.",
  EAI_AGAIN: "Não consegui resolver o endereço do servidor (sem internet?).",
  ECONNRESET: "A conexão com o servidor caiu no meio.",
  ETIMEDOUT: "O servidor não respondeu (tempo esgotado).",
  EHOSTUNREACH: "Servidor inacessível a partir daqui.",
  ENETUNREACH: "Sem rede até o servidor.",
};

function networkError(e) {
  const c = e && e.code;
  if (typeof c === "string" && TLS_ERROR.test(c)) {
    return fail(
      "tls",
      "Não consegui uma conexão segura com o servidor (certificado não confiável, ou o endereço não é https). Se o servidor usa certificado próprio, conecte pelo código de conexão (ele traz a impressão digital).",
      0,
      { cause: e, netCode: c }
    );
  }
  return fail("network", NET_MESSAGES[c] || `Falha de rede ao falar com o servidor${c ? ` (${c})` : ""}.`, 0, { cause: e, netCode: c });
}

/**
 * Cliente da API.
 * @param {{ url: string, token?: string|null, fp?: string|null, tokenOrigin?: string|null, timeoutMs?: number }} opts
 *   tokenOrigin: origem (ou endereço completo) do servidor que emitiu `token`.
 *   Quem passa token DEVE passar tokenOrigin; se não bater com a origem de
 *   `url`, lança origin_mismatch (nada é enviado). null/undefined = sem
 *   conferência (compatibilidade).
 * @returns {{ request(method: string, path: string, body?: any): Promise<any>, url: string, fp: string|null, origin: string }}
 * Lança na hora (sem rede): bad_url (inclusive http:// fora do localhost),
 * bad_fp, origin_mismatch.
 * request resolve com o JSON da resposta 2xx (null se vazia) e rejeita com Error
 * { status, code, message, body? }: code/message vêm do corpo { error, message }
 * do servidor; status 0 nos erros locais (code "timeout", "network", "tls",
 * "fingerprint_mismatch", "bad_response"). Redirecionamento (3xx) não é
 * seguido: vira erro "http_3xx".
 */
function createServerClient({ url, token = null, fp = null, tokenOrigin = null, timeoutMs = TIMEOUT_MS } = {}) {
  const base = parseBaseUrl(url);
  const pin = fp ? normalizeFingerprint(fp) : null;
  if (fp && !pin) throw fail("bad_fp", "Impressão digital do certificado inválida.");
  if (pin && base.protocol !== "https:") throw fail("bad_url", "Com impressão digital o endereço do servidor precisa ser https://.");
  if (token && tokenOrigin != null) {
    // O token só vale no servidor que o emitiu (origem ilegível também não passa).
    const issued = originOf(tokenOrigin);
    if (!issued || issued !== base.origin) {
      throw fail("origin_mismatch", "O acesso deste computador foi emitido para outro servidor. Conecte de novo.");
    }
  }
  const isHttps = base.protocol === "https:";
  const host = base.hostname.replace(/^\[|\]$/g, ""); // IPv6 vem entre colchetes
  const port = Number(base.port) || (isHttps ? 443 : 80);
  const prefix = base.pathname.replace(/\/+$/, "");

  function request(method, reqPath, body) {
    return new Promise((resolve, reject) => {
      const rel = String(reqPath || "/").startsWith("/") ? String(reqPath || "/") : "/" + reqPath;
      const payload = body === undefined ? null : Buffer.from(JSON.stringify(body), "utf8");
      const headers = { Accept: "application/json", "User-Agent": userAgent };
      if (token) headers.Authorization = `Bearer ${token}`;
      if (payload) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = payload.length;
      }

      let done = false;
      let req = null;
      let sock = null;
      const finish = (error, value) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (error) {
          if (req) req.destroy();
          if (sock) sock.destroy();
          reject(error);
        } else resolve(value);
      };
      const timer = setTimeout(
        () => finish(fail("timeout", `O servidor não respondeu em ${Math.round(timeoutMs / 1000)} s.`, 0)),
        timeoutMs
      );

      const onResponse = (res) => {
        const chunks = [];
        let size = 0;
        res.on("data", (c) => {
          size += c.length;
          if (size > MAX_BODY) return finish(fail("bad_response", "Resposta do servidor grande demais.", res.statusCode));
          chunks.push(c);
        });
        res.on("error", (e) => finish(networkError(e)));
        res.on("end", () => {
          const status = res.statusCode;
          const text = Buffer.concat(chunks).toString("utf8");
          let data = null;
          let isJson = true;
          if (text.trim()) {
            try {
              data = JSON.parse(text);
            } catch {
              isJson = false;
            }
          }
          if (status >= 200 && status < 300) {
            if (!isJson) return finish(fail("bad_response", "O servidor respondeu algo que não é JSON.", status));
            return finish(null, data);
          }
          const obj = isJson && data && typeof data === "object" ? data : null;
          const code = obj && typeof obj.error === "string" && obj.error ? obj.error : `http_${status}`;
          const message = obj && typeof obj.message === "string" && obj.message ? obj.message : statusMessage(status);
          finish(fail(code, message, status, obj ? { body: obj } : undefined));
        });
      };

      const send = (socket) => {
        // Sempre o host:porta de `url` (o http/https do Node não segue redirecionamento).
        const options = { method, host, port, path: prefix + rel, headers, autoSelectFamilyAttemptTimeout: ATTEMPT_MS };
        if (socket) options.createConnection = () => socket; // socket já conferido; sem agente
        else options.agent = false;
        try {
          req = (isHttps ? https : http).request(options, onResponse);
        } catch (e) {
          return finish(networkError(e));
        }
        req.on("error", (e) => finish(networkError(e)));
        req.end(payload || undefined);
      };

      if (!pin) return send(null);

      // Certificado fixado: abre o TLS, confere a impressão digital, só então envia.
      const matches = (cert) => !!cert && normalizeFingerprint(cert.fingerprint256 || "") === pin;
      try {
        sock = tls.connect({
          host,
          port,
          autoSelectFamilyAttemptTimeout: ATTEMPT_MS,
          servername: net.isIP(host) ? undefined : host,
          rejectUnauthorized: false, // a cadeia não importa: vale a impressão digital
          checkServerIdentity: (_h, cert) =>
            matches(cert) ? undefined : fail("fingerprint_mismatch", "Impressão digital do certificado diferente.", 0),
        });
      } catch (e) {
        return finish(networkError(e));
      }
      sock.on("error", (e) => finish(networkError(e)));
      sock.once("secureConnect", () => {
        if (!matches(sock.getPeerCertificate())) {
          return finish(
            fail(
              "fingerprint_mismatch",
              "O certificado do servidor não é o esperado (impressão digital diferente). Nada foi enviado. Se o certificado do servidor foi trocado, conecte de novo com um código novo.",
              0
            )
          );
        }
        send(sock);
      });
    });
  }

  return { request, url: base.href, fp: pin, origin: base.origin };
}

/**
 * Lê o código de conexão: "swapplus1:" + base64url(JSON { url, code, fp }).
 * → { url, code, fp } (fp normalizado "AA:BB:..." ou null). Lança Error com
 * code "bad_connect_code" e mensagem em português — ou "bad_url" ("Use
 * https:// (http:// só para localhost).") quando o código traz http:// fora do localhost.
 */
function parseConnectCode(str) {
  const s = String(str == null ? "" : str).replace(/\s+/g, ""); // colado com quebras de linha
  const bad = (msg) => fail("bad_connect_code", msg);
  if (!s) throw bad("Cole o código de conexão (ele começa com swapplus1:).");
  const m = /^swapplus(\d+):(.*)$/i.exec(s);
  if (!m) throw bad("Isso não é um código de conexão do Swap Plus (ele começa com swapplus1:).");
  if (m[1] !== "1") throw bad(`Código de conexão de outra versão (swapplus${m[1]}:). Atualize a extensão e o servidor para a mesma versão.`);
  const b64 = m[2];
  const broken = "O código de conexão está incompleto ou quebrado. Copie de novo, inteiro, a saída de `node server/src/cli.js pair`.";
  if (!b64 || !/^[A-Za-z0-9_\-+/]+={0,2}$/.test(b64)) throw bad(broken);
  let obj;
  try {
    obj = JSON.parse(Buffer.from(b64, "base64url").toString("utf8"));
  } catch {
    throw bad(broken);
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) throw bad(broken);

  if (typeof obj.url !== "string" || !obj.url) throw bad("O código de conexão não traz o endereço do servidor.");
  let base;
  try {
    base = parseBaseUrl(obj.url);
  } catch (e) {
    if (e && e.reason === "insecure_http") throw e; // mesmo erro (bad_url) do createServerClient
    throw bad(`O código de conexão traz um endereço inválido: ${e.message}`);
  }
  const code = typeof obj.code === "string" ? obj.code.trim() : "";
  if (!code) throw bad("O código de conexão não traz o código de pareamento.");
  let fp = null;
  if (obj.fp != null && obj.fp !== "") {
    fp = normalizeFingerprint(obj.fp);
    if (!fp) throw bad("O código de conexão traz uma impressão digital inválida.");
    if (base.protocol !== "https:") throw bad("O código de conexão traz impressão digital com endereço http:// (inconsistente).");
  }
  return { url: base.href.replace(/\/+$/, ""), code, fp };
}

/**
 * Pareia este computador com o servidor (POST /v1/pair, sem autenticação).
 * → { deviceId, token }. O token vale só para originOf(url): guarde esse
 * endereço junto e passe-o como tokenOrigin no createServerClient.
 * Lança bad_url (http:// fora do localhost) ou o erro do request (ex.: código vencido/errado).
 */
async function pair({ url, fp = null, code, name, platform }) {
  const client = createServerClient({ url, fp });
  const r = await client.request("POST", "/v1/pair", { code, name, platform });
  if (!r || typeof r.deviceId !== "string" || !r.deviceId || typeof r.token !== "string" || !r.token) {
    throw fail("bad_response", "O servidor não devolveu o acesso deste computador.", 200);
  }
  return { deviceId: r.deviceId, token: r.token };
}

const isText = (v) => typeof v === "string" && v.length > 0;

/** Horário vindo do servidor (ms ou texto ISO) em ms; null se não der para ler. */
function toMs(v) {
  const n = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/**
 * Entrar com a conta Google, passo 1 (POST /v1/login/start, sem autenticação).
 * → { sessionId, pollToken, authUrl, expiresAt (ms ou null) }. authUrl é o
 * endereço que o navegador abre (só https://; http:// só para localhost).
 * pollToken é segredo: não vai para log nem para mensagem. Lança bad_url
 * (http:// fora do localhost) ou o erro do request (ex.: code "google_off",
 * status 503, quando o servidor não está com o login do Google ligado).
 */
async function loginStart({ url, fp = null, name, platform }) {
  const client = createServerClient({ url, fp });
  const r = await client.request("POST", "/v1/login/start", { name, platform });
  if (!r || !isText(r.sessionId) || !isText(r.pollToken) || !isText(r.authUrl)) {
    throw fail("bad_response", "O servidor não devolveu o endereço para entrar com o Google.", 200);
  }
  let auth;
  try {
    auth = new URL(r.authUrl);
  } catch {
    auth = null;
  }
  const authOk = !!auth && (auth.protocol === "https:" || (auth.protocol === "http:" && isLoopbackHost(auth.hostname)));
  if (!authOk) {
    throw fail("bad_response", "O servidor devolveu um endereço inválido para entrar com o Google.", 200);
  }
  return { sessionId: r.sessionId, pollToken: r.pollToken, authUrl: r.authUrl, expiresAt: toMs(r.expiresAt) };
}

/**
 * Entrar com a conta Google, passo 2 (POST /v1/login/poll, sem autenticação).
 * → { status: "pending" } | { status: "ok", deviceId, token } | { status: "denied", email }
 *   | { status: "expired" } (o servidor responde 404 { error: "expired" }).
 * O token devolvido vale só para originOf(url) (use como tokenOrigin).
 * Lança bad_url (http:// fora do localhost); os outros erros vêm do request
 * (ex.: code "google_off", status 503).
 */
async function loginPoll({ url, fp = null, sessionId, pollToken }) {
  const client = createServerClient({ url, fp });
  let r;
  try {
    r = await client.request("POST", "/v1/login/poll", { sessionId, pollToken });
  } catch (e) {
    if (e && (e.code === "expired" || e.status === 404)) return { status: "expired" };
    throw e;
  }
  const st = r && typeof r.status === "string" ? r.status : "";
  if (st === "pending") return { status: "pending" };
  if (st === "ok") {
    if (!isText(r.deviceId) || !isText(r.token)) throw fail("bad_response", "O servidor não devolveu o acesso deste computador.", 200);
    return { status: "ok", deviceId: r.deviceId, token: r.token };
  }
  if (st === "denied") return { status: "denied", email: isText(r.email) ? r.email : null };
  if (st === "expired") return { status: "expired" };
  throw fail("bad_response", "O servidor respondeu algo inesperado ao login com Google.", 200);
}

module.exports = { createServerClient, parseConnectCode, pair, loginStart, loginPoll, normalizeFingerprint, originOf, isLoopbackHost, TIMEOUT_MS };
