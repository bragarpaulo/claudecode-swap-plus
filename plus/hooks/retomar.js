#!/usr/bin/env node
"use strict";
// Swap Plus — retomar a conversa sozinho depois da troca de conta.
//
// O Claude Code roda este arquivo como gancho `StopFailure`: é o evento de quando um turno acaba por erro da API
// (a conta bateu o limite, o acesso foi cancelado). A conversa fica parada na tela. Este script espera o Swap Plus
// gravar a conta nova e então posta, na caixa de entrada da PRÓPRIA sessão, a mensagem "Troquei de conta, pode
// continuar." — e o Claude Code, com a sessão parada, começa um turno novo com ela, como se a pessoa tivesse digitado.
//
// De onde vem cada peça (documentação do Claude Code):
//   - gancho StopFailure: recebe no stdin { session_id, transcript_path, error, ... }; a saída dele é ignorada, por
//     isso quem faz a conversa andar é a mensagem na caixa de entrada, não o código de saída;
//   - caixa de entrada: CLAUDE_CODE_MESSAGING_SOCKET (pipe nomeado no Windows, socket Unix no resto) e
//     CLAUDE_CODE_MESSAGING_TOKEN, que o Claude Code põe no ambiente dos ganchos. A 1ª linha é a autenticação
//     ({"type":"auth","token":…}) e a 2ª a mensagem ({"type":"user","message":{"role":"user","content":…}}).
//
// Como ele sabe que a troca aconteceu: o Swap Plus (extensão ou cliente) grava ~/.swap-plus/aplicado.json cada vez
// que grava um login no Claude Code. Sem esse arquivo (versão antiga), vale a data do ~/.claude/.credentials.json.
//
// Regras:
//   - só age nos erros que são DA CONTA, os que uma conta nova resolve: `rate_limit` (limite de uso),
//     `authentication_failed` (acesso cancelado ou vencido: renovação, relogin), `billing_error`,
//     `account_on_hold` e `oauth_org_not_allowed`. Erro do servidor da Anthropic, do pedido ou do modelo: nada;
//   - só posta se houve login novo gravado pelo Swap depois do erro, ou até 20 s antes dele — troca automática,
//     troca manual no painel ou relogin, tanto faz. Espera até 30 min; sem login novo nesse tempo, desiste;
//   - uma retomada por troca: se a conta nova também falhar, espera a PRÓXIMA troca (não vira laço);
//   - no máximo 6 retomadas por hora por conversa;
//   - desligado em ~/.swap-plus/retomar.json ({ "enabled": false }), nada acontece;
//   - nunca escreve o token em lugar nenhum. O que fez fica em ~/.swap-plus/retomar.log.
//
// Sem dependências: roda com qualquer Node (inclusive o do VS Code, com ELECTRON_RUN_AS_NODE=1).

const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("net");

const num = (v, def) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : def);

// A mesma conta de resume.js (swapDir): ~/.swap-plus, ou <CLAUDE_CONFIG_DIR>/swap-plus quando a pasta do Claude Code é outra.
const DIR = process.env.SWAP_PLUS_DIR || (process.env.CLAUDE_CONFIG_DIR ? path.join(process.env.CLAUDE_CONFIG_DIR, "swap-plus") : path.join(os.homedir(), ".swap-plus"));
const WAIT_MS = num(process.env.SWAP_PLUS_RESUME_WAIT_MS, 30 * 60 * 1000); // quanto espera a troca (cobre troca manual e relogin)
const SETTLE_MS = num(process.env.SWAP_PLUS_RESUME_SETTLE_MS, 3000); // depois da troca, antes de postar
const SLACK_MS = 20 * 1000; // troca gravada até 20 s antes do erro também vale (o pedido já estava a caminho)
const POLL_MS = 1000;
const MAX_PER_HOUR = 6;
const LOG_MAX = 200 * 1024;

const DEFAULT_TEXT = "Troquei de conta, pode continuar.";
const OTHER_ACCOUNT = "a conta em uso não podia mais atender e o Swap Plus já gravou outro login";
const WHY = {
  rate_limit: "a conta em uso bateu o limite e o Swap Plus já trocou para outra",
  authentication_failed: "o acesso da conta foi renovado ou trocado e o Swap Plus já gravou o novo",
  billing_error: OTHER_ACCOUNT,
  account_on_hold: OTHER_ACCOUNT,
  oauth_org_not_allowed: OTHER_ACCOUNT,
};
const WATCHED = new Set(Object.keys(WHY));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readJson(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    return j && typeof j === "object" ? j : null;
  } catch {
    return null;
  }
}

function mtime(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

function log(session, error, what) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = path.join(DIR, "retomar.log");
    try {
      if (fs.statSync(file).size > LOG_MAX) fs.renameSync(file, file + ".1");
    } catch {}
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    const when = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
    fs.appendFileSync(file, `${when} sessão ${String(session || "?").slice(0, 8)} (${error || "?"}): ${what}\n`);
  } catch {}
}

function readStdin() {
  return new Promise((resolve) => {
    let buf = "";
    const done = () => {
      try {
        resolve(JSON.parse(buf) || {});
      } catch {
        resolve({});
      }
    };
    if (process.stdin.isTTY) return resolve({});
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (buf += d));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
    setTimeout(done, 5000).unref(); // stdin que nunca fecha: segue com o que chegou
  });
}

/** Quando o Swap Plus gravou um login pela última vez (ms), pelo marcador dele ou, na falta, pelo arquivo do Claude Code. */
function lastApplied() {
  const marker = path.join(DIR, "aplicado.json");
  const j = readJson(marker);
  const fromMarker = Math.max(j && Number(j.at) > 0 ? Number(j.at) : 0, mtime(marker));
  const cred = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude"), ".credentials.json");
  return Math.max(fromMarker, mtime(cred));
}

/**
 * Espera uma troca que sirva para ESTE erro: gravada depois dele (ou até 20 s antes) e que esta conversa ainda não
 * usou para retomar (`used`). Sem isso, uma conta nova que também falha faria a mesma troca retomar a conversa de
 * novo e de novo. → quando foi gravada (ms), ou 0 se o prazo acabou.
 */
async function waitForSwap(t0, used) {
  const end = t0 + WAIT_MS;
  for (;;) {
    const at = lastApplied();
    if (at >= t0 - SLACK_MS && at > used) return at;
    if (Date.now() >= end) return 0;
    await sleep(POLL_MS);
  }
}

/** O que esta conversa já fez: { at: [horas das retomadas da última hora], used: a troca da última retomada }. */
function stateFile(session) {
  return path.join(os.tmpdir(), `swap-plus-retomar-${String(session || "x").replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64)}.json`);
}

function readState(session) {
  const prev = readJson(stateFile(session)) || {};
  const now = Date.now();
  return { at: (Array.isArray(prev.at) ? prev.at : []).filter((t) => Number(t) > now - 3600 * 1000), used: Number(prev.used) > 0 ? Number(prev.used) : 0 };
}

/** No máximo MAX_PER_HOUR retomadas por hora por conversa. true = pode (e anota esta, com a troca que ela usou). */
function underCap(session, usedNow) {
  const st = readState(session);
  if (st.at.length >= MAX_PER_HOUR) return false;
  st.at.push(Date.now());
  st.used = Math.max(st.used, usedNow);
  try {
    fs.writeFileSync(stateFile(session), JSON.stringify(st));
  } catch {}
  return true;
}

function post(socket, token, text) {
  return new Promise((resolve, reject) => {
    const lines = [];
    if (token) lines.push(JSON.stringify({ type: "auth", token }));
    lines.push(JSON.stringify({ type: "user", message: { role: "user", content: text } }));
    const c = net.connect(socket, () => {
      c.write(lines.join("\n") + "\n", () => c.end());
    });
    c.on("error", reject);
    c.on("close", () => resolve());
    c.setTimeout(10000, () => c.destroy(new Error("sem resposta da caixa de entrada")));
  });
}

async function main() {
  const input = await readStdin();
  const error = String(input.error || "");
  const session = String(input.session_id || process.env.CLAUDE_CODE_SESSION_ID || "");
  if (!WATCHED.has(error)) return;
  const cfg = readJson(path.join(DIR, "retomar.json")) || {};
  if (cfg.enabled === false) return;
  const socket = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
  const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  if (!socket) return log(session, error, "esta sessão não tem caixa de entrada; nada enviado");
  const t0 = Date.now();
  const at = await waitForSwap(t0, readState(session).used);
  if (!at) return log(session, error, `o Swap Plus não trocou de conta em ${WAIT_MS >= 60000 ? Math.round(WAIT_MS / 60000) + " min" : Math.round(WAIT_MS / 1000) + " s"}; nada enviado`);
  if (!underCap(session, at)) return log(session, error, `já foram ${MAX_PER_HOUR} retomadas nesta conversa na última hora; nada enviado`);
  await sleep(SETTLE_MS);
  const said = typeof cfg.text === "string" && cfg.text.trim() ? cfg.text.trim().slice(0, 300) : DEFAULT_TEXT;
  const text = `${said}\n\n(Mensagem automática do Swap Plus: ${WHY[error]}. Continue de onde parou.)`;
  try {
    await post(socket, token, text);
    log(session, error, `conta gravada ${Math.max(0, Math.round((at - t0) / 1000))} s depois do erro; mensagem enviada: “${said}”`);
  } catch (e) {
    log(session, error, `não consegui postar na caixa de entrada (${(e && (e.code || e.message)) || e})`);
  }
}

main()
  .catch((e) => log("", "", `erro inesperado: ${(e && e.message) || e}`))
  .then(() => process.exit(0));
