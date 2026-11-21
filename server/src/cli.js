#!/usr/bin/env node
"use strict";
// CLI de administração do Swap Plus Servidor.
// Fala com o admin local (http://127.0.0.1:ADMIN_PORT, sem senha), então roda no
// mesmo lugar que o servidor — no Docker, dentro do container:
//
//   docker exec swap-plus node /app/server/src/cli.js pair
//   docker exec swap-plus node /app/server/src/cli.js status
//   docker exec swap-plus node /app/server/src/cli.js devices
//   docker exec swap-plus node /app/server/src/cli.js revoke <id>
//   docker exec swap-plus node /app/server/src/cli.js allow <email>
//   docker exec swap-plus node /app/server/src/cli.js deny <email>
//   docker exec swap-plus node /app/server/src/cli.js allowed
//   docker exec swap-plus node /app/server/src/cli.js login-expires <n> <data ISO>

const { emailKey } = require("./google");

const ADMIN_PORT = Number(process.env.ADMIN_PORT) || 8444;
const BASE = `http://127.0.0.1:${ADMIN_PORT}`;

const USO = `Uso: node server/src/cli.js <comando>

  pair           gera um código de conexão (vale 10 min, uso único) para ligar um serviço
  status         estado do servidor, contas e serviços
  devices        lista os serviços conectados
  revoke <id>    desconecta um serviço (o token dele para de valer na hora);
                 basta o começo do id, se não houver outro igual

  Login com Google (a pessoa conecta um serviço com a conta Google dela):
  O painel web é só do ADMINISTRADOR (variável ADMIN_EMAILS no compose; muda só reiniciando).
  O administrador também conecta serviços, sem precisar estar na lista abaixo.
  allow <email>  libera a conta Google a conectar serviços (quantos quiser); ela NÃO entra no painel
  deny <email>   tira a conta da lista: não conecta serviços novos; os já conectados com ela
                 continuam (para desconectar um: revoke <id>). O administrador não sai por aqui.
  allowed        mostra o administrador, as contas liberadas e se o login com Google está ligado

  rule <chave> <valor>       muda uma regra de troca (ex.: rule devicePlacement together;
                 rule weeklyPct 96; rule strategy max)
  auto on|off    liga ou desliga a troca automática (vale para todos os serviços)

  login-expires <n> <data>   diz até quando vale o login da conta n (o painel avisa 3 dias antes);
                 data em ISO, ex.: 2026-12-01T18:00 (hora daqui) ou 2026-12-01 (meia-noite)

  resumo         manda agora ao dono o e-mail do resumo semanal (as contas que vencem nos próximos 7 dias);
                 o resumo automático sai toda semana e não muda por causa deste
  resumo ver     só mostra o texto do resumo, sem mandar e-mail
`;

class CliError extends Error {}

async function call(method, path, body) {
  let res;
  try {
    const headers = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    res = await fetch(BASE + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10 * 1000),
    });
  } catch (e) {
    const causa = (e && e.cause && e.cause.code) || (e && e.name === "TimeoutError" ? "sem resposta" : e && e.message);
    throw new CliError(
      `não consegui falar com o servidor em ${BASE} (${causa}).\n` +
        "Ele está rodando? Este comando precisa rodar no mesmo lugar que o servidor — no Docker:\n" +
        "  docker exec <nome-do-container> node /app/server/src/cli.js " +
        process.argv.slice(2).join(" ")
    );
  }
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {}
  if (!res.ok) throw new CliError((data && data.message) || `o servidor respondeu ${res.status}`);
  return data;
}

// ----- formatação -----

const pad = (n) => String(n).padStart(2, "0");

function fmtDate(v) {
  if (v === null || v === undefined || v === "") return "—";
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtFull(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtTime(v) {
  const d = new Date(v);
  if (isNaN(d.getTime())) return "—";
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAgo(v, now = Date.now()) {
  if (v === null || v === undefined || v === 0) return "nunca";
  const t = new Date(v).getTime();
  if (isNaN(t)) return "—";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "agora há pouco";
  const m = Math.round(s / 60);
  if (m < 60) return `há ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} dias`;
}

function fmtDuration(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d} d ${h} h`;
  if (h) return `${h} h ${m} min`;
  return `${m} min`;
}

const fmtPct = (w) => (w && typeof w.pct === "number" ? `${Math.round(w.pct)}%` : "—");

function fmtUsage(u) {
  if (!u) return null;
  const parts = [];
  if (u.fiveHour) parts.push(`5h ${fmtPct(u.fiveHour)}`);
  if (u.sevenDay) parts.push(`semanal ${fmtPct(u.sevenDay)}`);
  for (const s of u.scoped || []) parts.push(`${s.name} ${fmtPct(s)}`);
  return parts.length ? parts.join(" · ") : "sem uso aberto";
}

function fmtError(e) {
  if (!e) return "";
  if (typeof e === "string") return e;
  return e.error || e.reason || e.message || JSON.stringify(e);
}

function shortCode(code) {
  return code && code.length === 10 ? `${code.slice(0, 5)}-${code.slice(5)}` : code;
}

// ----- comandos -----

async function cmdPair() {
  const r = await call("POST", "/admin/pair-code");
  console.log("Código de conexão (vale 10 min, uso único — vale para UM serviço):");
  console.log("");
  console.log(r.connect);
  console.log("");
  console.log("No VS Code: Ctrl/Cmd+Shift+P → Swap Plus: Conectar ao servidor → cole o código.");
  console.log("");
  console.log(`Servidor: ${r.url}`);
  if (r.fp) console.log(`Impressão digital do certificado: ${r.fp}`);
  console.log(`Código curto: ${shortCode(r.code)} (válido até ${fmtTime(r.expiresAt)})`);
  console.log("Para outro serviço, rode o pair de novo (gerar um código novo invalida o anterior).");
}

async function cmdStatus() {
  const s = await call("GET", "/admin/status");
  const now = s.serverTime || Date.now();
  const devName = new Map((s.devices || []).map((d) => [d.id, d.name]));

  console.log(`Swap Plus Servidor ${s.version} · no ar há ${fmtDuration(s.uptimeSec)}`);
  console.log(
    `Endereço: ${s.publicUrl || "(PUBLIC_URL não definido)"} · ${s.tlsMode === "self" ? "certificado próprio" : "TLS no proxy"}`
  );
  if (s.fingerprint) console.log(`Impressão digital: ${s.fingerprint}`);
  console.log(`IPs aceitos: ${s.allowIps && s.allowIps.length ? s.allowIps.join(", ") : "todos"}${s.trustProxy ? " (via X-Forwarded-For)" : ""}`);
  console.log(`Troca automática: ${s.autoSwitch ? "ligada" : "desligada"}`);
  if (s.rules) {
    const r = s.rules;
    console.log(`Regras: sessão ${r.sessionPct}% · semanal ${r.weeklyPct}% · modelo ${r.modelPct}% · estratégia ${r.strategy}`);
  }

  const accounts = s.accounts || [];
  console.log("");
  console.log(`Contas (${accounts.length}):`);
  if (!accounts.length) console.log("  nenhuma ainda — conecte um serviço e envie os logins dele");
  for (const a of accounts) {
    const head = [`#${a.number} ${a.email || "?"}`];
    if (a.alias) head.push(`“${a.alias}”`);
    if (a.plan) head.push(a.plan);
    if (a.orgName) head.push(a.orgName);
    console.log(`  ${head.join(" · ")}`);
    if (a.dead) {
      console.log("      PRECISA DE LOGIN NOVO (faça login com essa conta num serviço conectado)");
    } else {
      const parts = [];
      const usage = fmtUsage(a.usage);
      if (usage) parts.push(`${usage} (lido ${fmtAgo(a.usageFetchedAt, now)})`);
      else if (a.lastGoodUsage) parts.push(`${fmtUsage(a.lastGoodUsage)} (último bom ${fmtAgo(a.lastGoodAt, now)})`);
      else parts.push("uso ainda não lido");
      if (a.usageError) parts.push(`erro na leitura: ${fmtError(a.usageError)}`);
      console.log(`      ${parts.join(" · ")}`);
      const cred = [`acesso vence ${fmtDate(a.accessExpiresAt)}`, `renovado ${a.lastRefreshAt ? fmtDate(a.lastRefreshAt) : "ainda não"}`];
      if (a.loginExpiresAt) cred.push(`login vale até ${fmtFull(a.loginExpiresAt)}`);
      if (a.refreshFailures) cred.push(`${a.refreshFailures} falha(s) seguidas ao renovar`);
      console.log(`      ${cred.join(" · ")}`);
    }
    const flags = [];
    if (a.disabled) flags.push("fora da rotação");
    if (a.devices && a.devices.length) flags.push(`em uso por: ${a.devices.join(", ")}`);
    if (flags.length) console.log(`      ${flags.join(" · ")}`);
  }

  const devices = s.devices || [];
  console.log("");
  console.log(`Serviços (${devices.length}):`);
  if (!devices.length) console.log("  nenhum — rode: node server/src/cli.js pair");
  for (const d of devices) {
    const via = d.googleEmail ? ` · Google ${d.googleEmail}` : "";
    console.log(`  ${d.id}  ${d.name} (${d.platform || "?"}) · ${d.assigned != null ? `conta ${d.assigned}` : "sem conta"} · visto ${fmtAgo(d.lastSeen, now)}${via}`);
  }

  console.log("");
  console.log(
    s.pairing
      ? `Pareamento: código ativo até ${fmtTime(s.pairing.expiresAt)} (${s.pairing.attempts || 0} erro(s))`
      : "Pareamento: nenhum código ativo"
  );
  if (s.google) {
    console.log(adminLine(s.google));
    console.log(googleLine(s.google));
  }
  const v = s.diag && s.diag.oldTokenValidAfterRefresh;
  console.log(
    `Diagnóstico: acesso antigo continua valendo depois de renovar: ${v === true ? "sim" : v === false ? "não" : "ainda não testado"}`
  );

  const hist = s.history || [];
  if (hist.length) {
    console.log("");
    console.log("Últimos eventos:");
    for (const h of hist.slice(0, 10)) {
      const who = h.device && devName.has(h.device) ? `${devName.get(h.device)}: ` : "";
      console.log(`  ${fmtDate(h.ts)}  ${who}${h.text}`);
    }
  }
}

async function cmdDevices() {
  const list = await call("GET", "/admin/devices");
  if (!list.length) {
    console.log("Nenhum serviço conectado. Para ligar um: node server/src/cli.js pair");
    return;
  }
  const now = Date.now();
  console.log(`Serviços conectados (${list.length}):`);
  for (const d of list) {
    console.log(`  ${d.id}  ${d.name}`);
    console.log(
      `      ${d.platform || "?"} · ${d.assigned != null ? `conta ${d.assigned}` : "sem conta"} · visto ${fmtAgo(d.lastSeen, now)} · conectado em ${fmtDate(d.createdAt)}` +
        (d.googleEmail ? ` · com a conta Google ${d.googleEmail}` : " · por código de conexão")
    );
  }
  console.log("");
  console.log("Para desconectar um: node server/src/cli.js revoke <id>");
}

// ----- login com Google -----

function googleLine(g) {
  if (!g.enabled) return `Login com Google: desligado (${g.offReason || "não configurado"})`;
  const n = (g.allowedEmails || []).length;
  return `Login com Google: ligado · ${n} conta(s) liberada(s)${g.pendingLogins ? ` · ${g.pendingLogins} login(s) em andamento` : ""}`;
}

/** "Administrador: x (ADMIN_EMAILS) — só ele entra no painel", ou o aviso de painel desligado. */
function adminLine(g) {
  const list = (g && g.adminEmails) || [];
  if (!list.length) return "Administrador: nenhum — ADMIN_EMAILS não definido: o painel web está DESLIGADO (os serviços seguem funcionando)";
  return list.length === 1
    ? `Administrador: ${list[0]} (ADMIN_EMAILS, definido no servidor) — só ele entra no painel`
    : `Administradores: ${list.join(", ")} (ADMIN_EMAILS, definidos no servidor) — só eles entram no painel`;
}

const isAdminOf = (g, email) => ((g && g.adminEmails) || []).some((a) => emailKey(a) === emailKey(email));

function googleOffWarning(g) {
  if (g && !g.enabled) {
    console.log("");
    console.log(`Atenção: o login com Google está desligado neste servidor (${g.offReason || "não configurado"}).`);
    console.log("Monte o client id e o client secret do Google (GOOGLE_CLIENT_ID_FILE / GOOGLE_CLIENT_SECRET_FILE) e reinicie.");
  }
}

async function cmdAllow(email) {
  if (!email) throw new CliError("diga qual: node server/src/cli.js allow pessoa@empresa.com");
  const r = await call("POST", "/admin/allow", { email });
  if (r.admin) {
    console.log(`${r.email} é o administrador (ADMIN_EMAILS): já conecta serviços e entra no painel, sem precisar estar na lista.`);
    return;
  }
  console.log(
    r.added
      ? `Conta Google ${r.email} liberada: ela pode conectar serviços (quantos quiser). O painel web continua só do administrador.`
      : `A conta Google ${r.email} já estava liberada.`
  );
  console.log("No VS Code: Ctrl/Cmd+Shift+P → Swap Plus: Conectar ao servidor → Entrar com Google.");
  googleOffWarning(r.google);
}

async function cmdDeny(email) {
  if (!email) throw new CliError("diga qual: node server/src/cli.js deny pessoa@empresa.com");
  const r = await call("POST", "/admin/deny", { email });
  console.log(
    r.removed
      ? `Conta Google ${r.email} tirada da lista: ela não conecta mais serviços novos.`
      : `A conta Google ${r.email} não estava na lista.`
  );
  if (r.panelSessions) console.log(`${r.panelSessions} sessão(ões) dela no painel web encerrada(s).`);
  const devs = r.devices || [];
  if (devs.length) {
    console.log("");
    console.log(`Serviços já conectados com ela (continuam funcionando até você desconectar):`);
    for (const d of devs) console.log(`  ${d.id}  ${d.name}`);
    console.log("Para desconectar um: node server/src/cli.js revoke <id>");
  }
}

async function cmdAllowed() {
  const g = await call("GET", "/admin/allowed");
  console.log(adminLine(g));
  console.log(googleLine(g));
  if (g.callbackUrl) console.log(`Endereço de retorno (cadastre no Google Cloud): ${g.callbackUrl}`);
  const list = g.allowedEmails || [];
  console.log("");
  if (!list.length) {
    console.log("Nenhuma conta Google liberada para conectar serviços. Para liberar: node server/src/cli.js allow pessoa@empresa.com");
    return;
  }
  console.log(`Contas que podem conectar serviços (${list.length}; não entram no painel):`);
  for (const e of list) console.log(`  ${e}${isAdminOf(g, e) ? "  (é o administrador: não depende da lista)" : ""}`);
}

/** "2026-12-01" → meia-noite daqui; o resto vai para o Date (ISO, com ou sem fuso). null se não for data. */
function parseWhen(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : /^\d{4}-\d{2}-\d{2}T/.test(s) ? new Date(s) : null;
  return d && !isNaN(d.getTime()) ? d : null;
}

async function cmdLoginExpires(nArg, atArg) {
  if (!nArg || !/^\d{1,6}$/.test(nArg) || !atArg) {
    throw new CliError("diga a conta e a data: node server/src/cli.js login-expires <número da conta> <data ISO>   (ex.: login-expires 2 2026-12-01T18:00)");
  }
  const d = parseWhen(atArg);
  if (!d) throw new CliError(`data inválida: "${atArg}" (use ISO, ex.: 2026-12-01T18:00 ou 2026-12-01T18:00:00-03:00)`);
  const r = await call("POST", `/admin/accounts/${nArg}/login-expires`, { at: d.toISOString() });
  console.log(`Conta ${r.number}: o login vale até ${fmtFull(r.loginExpiresAt)}.`);
  console.log("O painel avisa quando faltarem menos de 3 dias.");
}

async function cmdRule(key, value) {
  if (!key || value === undefined) throw new CliError("diga a regra e o valor: node server/src/cli.js rule <chave> <valor>   (ex.: rule devicePlacement together)");
  const v = /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
  const r = await call("PUT", "/admin/rules", { rules: { [key]: v } });
  console.log(`Regra ${key} = ${JSON.stringify(r.rules[key])}. Vale agora, para todos os serviços.`);
}

async function cmdAuto(onoff) {
  if (onoff !== "on" && onoff !== "off") throw new CliError("use: node server/src/cli.js auto on   (ou auto off)");
  const r = await call("PUT", "/admin/rules", { autoSwitch: onoff === "on" });
  console.log(`Troca automática ${r.autoSwitch ? "ligada" : "desligada"} (vale para todos os serviços).`);
}

async function cmdRevoke(idArg) {
  if (!idArg) throw new CliError("diga qual: node server/src/cli.js revoke <id>   (veja os ids com: devices)");
  const list = await call("GET", "/admin/devices");
  const exact = list.find((d) => d.id === idArg);
  const matches = exact ? [exact] : list.filter((d) => d.id.startsWith(idArg));
  if (matches.length === 0) throw new CliError(`nenhum serviço com id "${idArg}" (veja os ids com: devices)`);
  if (matches.length > 1) {
    throw new CliError(`"${idArg}" serve para mais de um serviço: ${matches.map((d) => `${d.id} (${d.name})`).join(", ")}`);
  }
  const d = matches[0];
  await call("DELETE", `/admin/devices/${encodeURIComponent(d.id)}`);
  console.log(`Serviço "${d.name}" (${d.id}) desconectado. O token dele não vale mais.`);
}

async function cmdResumo(arg) {
  if (arg !== undefined && arg !== "ver") throw new CliError("use: node server/src/cli.js resumo   (ou: resumo ver, para só mostrar)");
  const r = await call("POST", "/admin/weekly-notice", { preview: arg === "ver" });
  if (arg === "ver") console.log("Assim sairia o resumo semanal agora (nada foi enviado):\n");
  else if (r.sent) console.log("Resumo semanal enviado ao dono (chega por e-mail em cerca de 1 minuto):\n");
  else console.log(`O resumo NÃO foi enviado: ${r.why === "disabled" || r.why === "off" ? "os avisos por e-mail estão desligados (NOTICES_ENABLED)" : "o aviso não pôde ser gravado (veja o log do servidor)"}.\n`);
  console.log(`Assunto: ${r.subject}\n`);
  console.log(r.text);
}

async function main(argv) {
  const [cmd, arg, arg2] = argv;
  switch (cmd) {
    case "resumo":
      return cmdResumo(arg);
    case "pair":
      return cmdPair();
    case "status":
      return cmdStatus();
    case "devices":
      return cmdDevices();
    case "revoke":
      return cmdRevoke(arg);
    case "allow":
      return cmdAllow(arg);
    case "deny":
      return cmdDeny(arg);
    case "allowed":
      return cmdAllowed();
    case "login-expires":
      return cmdLoginExpires(arg, arg2);
    case "rule":
      return cmdRule(arg, arg2);
    case "auto":
      return cmdAuto(arg);
    case undefined:
    case "help":
    case "-h":
    case "--help":
      process.stdout.write(USO);
      return;
    default:
      process.stderr.write(`Comando desconhecido: ${cmd}\n\n${USO}`);
      process.exitCode = 2;
  }
}

main(process.argv.slice(2)).catch((e) => {
  process.stderr.write(`Erro: ${e instanceof CliError ? e.message : e && e.message ? e.message : e}\n`);
  process.exitCode = 1;
});
