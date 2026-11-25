"use strict";
// Bloqueio de rede para o ambiente local: nada sai para a internet.
//
// Entra em todo processo Node que o dev/ambiente-local.js inicia, por
//   NODE_OPTIONS=--require <caminho absoluto>/dev/sem-internet.js
// (vale também para os processos que esses processos abrem, como os de cada arquivo do `node --test`).
//
// Troca net.Socket.prototype.connect (http, https, tls e fetch passam por ele), dns.lookup e dns.promises.lookup.
// Destino que não seja 127.0.0.1, ::1, localhost ou socket Unix/pipe falha com ENETUNREACH.
// Cada tentativa vai para o stderr como "[sem-internet] bloqueado: <host>:<porta>" e, se SEM_INTERNET_LOG apontar
// para um arquivo, é anotada nele (uma linha por bloqueio, com o pid e o script) para o resumo do `testes`.
//
// Teste rápido:
//   NODE_OPTIONS=--require ./dev/sem-internet.js node -e "fetch('https://example.com').then(()=>console.log('saiu'),e=>console.log('bloqueado'))"

const fs = require("fs");
const net = require("net");
const dns = require("dns");

if (!global.__semInternet) {
  global.__semInternet = { bloqueios: 0 };
  const LOCAIS = new Set(["127.0.0.1", "::1", "localhost", "::ffff:127.0.0.1", "[::1]"]);
  const local = (host) => host === undefined || host === null || host === "" || LOCAIS.has(String(host).toLowerCase());

  function anotar(host, port) {
    global.__semInternet.bloqueios++;
    const linha = `[sem-internet] bloqueado: ${host}:${port === undefined || port === null ? "?" : port}`;
    try {
      process.stderr.write(`${linha}\n`);
    } catch {}
    const log = process.env.SEM_INTERNET_LOG;
    if (log) {
      try {
        fs.appendFileSync(log, `${linha} (pid ${process.pid}, ${process.argv.slice(1).join(" ").slice(0, 200)})\n`);
      } catch {}
    }
  }

  function erro(host, port) {
    const e = new Error(`[sem-internet] conexão bloqueada no ambiente local: ${host}:${port}`);
    e.code = "ENETUNREACH";
    e.errno = -101;
    e.syscall = "connect";
    e.address = host;
    e.port = port;
    return e;
  }

  /** Para onde o connect vai: { path } (socket Unix/pipe) ou { host, port }. */
  function destino(args) {
    let a = args;
    if (Array.isArray(a[0])) a = a[0]; // net.connect() já normalizado: [options, cb]
    const o = a[0];
    if (o !== null && typeof o === "object") return o.path ? { path: o.path } : { host: o.host, port: o.port };
    if (typeof o === "string" && !/^\d+$/.test(o)) return { path: o };
    return { host: typeof a[1] === "string" ? a[1] : undefined, port: o };
  }

  const connectOrig = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (...args) {
    const d = destino(args);
    if (d.path || local(d.host)) return connectOrig.apply(this, args);
    anotar(d.host, d.port);
    const e = erro(d.host, d.port);
    process.nextTick(() => this.destroy(e));
    return this;
  };

  const lookupOrig = dns.lookup;
  dns.lookup = function (host, ...rest) {
    if (local(host) || net.isIP(String(host)) && local(host)) return lookupOrig.call(this, host, ...rest);
    const cb = rest.find((x) => typeof x === "function");
    anotar(host, "dns");
    if (cb) process.nextTick(() => cb(erro(host, "dns")));
    return {};
  };
  const promLookupOrig = dns.promises.lookup;
  dns.promises.lookup = function (host, ...rest) {
    if (local(host)) return promLookupOrig.call(this, host, ...rest);
    anotar(host, "dns");
    return Promise.reject(erro(host, "dns"));
  };
}

module.exports = global.__semInternet;
