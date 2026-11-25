"use strict";
// Swap Plus Cliente — conectar e desconectar do servidor.
//
// Cada cliente é um "computador" próprio no servidor (aparece no painel em Computadores, pode ser revogado
// sozinho). Dois jeitos de conectar, os mesmos da extensão:
//   · código de conexão ("swapplus1:..."), gerado pelo administrador no painel ou com o comando `pair` do servidor;
//   · login com Google: o cliente mostra um endereço, a pessoa entra pelo navegador de qualquer aparelho.
// O token recebido fica em conexao.json (0600) e só é enviado ao endereço em que foi emitido.

const { erro } = require("./arquivos");

const GOOGLE_CONSULTA_MS = 2000;
const GOOGLE_MAX_MS = 10 * 60 * 1000;
const GOOGLE_SEM_REDE_MAX_MS = 60 * 1000;
const GOOGLE_429_MS = 15 * 1000;

function conexaoAtual(estado) {
  try {
    return estado.conexao();
  } catch {
    return null; // arquivo quebrado: conectar de novo conserta
  }
}

/** Revoga no servidor o acesso antigo deste cliente (melhor esforço; quem já foi revogado não é chamado). */
async function revogar(lib, con) {
  if (!con || con.revogadoEm) return false;
  try {
    const c = lib.createServerClient({ url: con.url, token: con.token, fp: con.fp || null, tokenOrigin: con.url });
    await c.request("DELETE", `/v1/devices/${encodeURIComponent(con.deviceId)}`);
    return true;
  } catch {
    return false;
  }
}

function origem(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/**
 * Acesso atual deste cliente para mandar como `replaces` ao conectar de novo ao MESMO servidor (mesma origem): o
 * servidor troca o acesso antigo pelo novo e o nome não dá conflito com ele mesmo. Outro servidor: null.
 */
function substitui(estado, url) {
  const con = conexaoAtual(estado);
  if (!con || con.revogadoEm || !con.deviceId || !con.token) return null;
  const a = origem(con.url);
  return a && a === origem(url) ? { deviceId: con.deviceId, token: con.token } : null;
}

/** O servidor recusou o nome (já é de outro serviço): erro com a mensagem dele e como escolher outro nome. */
function nomeEmUso(cfg, mensagem) {
  const msg = String(mensagem || "Já existe um serviço com este nome; escolha outro ou desconecte o antigo no painel.").replace(/\.?$/, ".");
  return erro("nome_em_uso", `${msg} Nome usado: "${cfg.nome}". Rode de novo com --nome <outro nome> (ou SWAP_PLUS_NOME=<outro nome>).`);
}

async function guardar({ lib, estado, cfg, agora }, novo) {
  const antes = conexaoAtual(estado);
  if (antes && antes.deviceId !== novo.deviceId) await revogar(lib, antes);
  const con = { url: novo.url, fp: novo.fp || null, deviceId: novo.deviceId, token: novo.token, nome: cfg.nome, via: novo.via, conectadoEm: agora() };
  await estado.gravarConexao(con);
  estado.apagarAplicado(); // servidor (talvez) novo: a credencial gravada antes não vale como referência
  return con;
}

/** Conecta com o código de conexão. Erros do serverClient passam adiante (bad_connect_code, bad_url, 4xx do servidor...). */
async function conectarPorCodigo(deps, codigo) {
  const { lib, cfg } = deps;
  const p = lib.parseConnectCode(String(codigo || ""));
  let r;
  try {
    r = await lib.pair({ url: p.url, fp: p.fp, code: p.code, name: cfg.nome, platform: process.platform, replaces: substitui(deps.estado, p.url) });
  } catch (e) {
    if (e && e.code === "name_taken") throw nomeEmUso(cfg, e.message); // o código continua valendo para outro nome
    throw e;
  }
  return guardar(deps, { url: p.url, fp: p.fp, deviceId: r.deviceId, token: r.token, via: "codigo" });
}

/**
 * Conecta com login do Google. `mostrar(authUrl, expiraEm)` é chamado uma vez com o endereço para a pessoa abrir.
 * → conexão gravada; lança `google_negado` (com .email), `google_expirou`, `google_desligado`, `cancelado`,
 * `nome_em_uso` (o nome já é de outro serviço no servidor).
 */
async function entrarComGoogle(deps, { url, mostrar, parar = null }) {
  const { lib, cfg, agora, espera } = deps;
  if (!url) throw erro("sem_url", "Diga o endereço do servidor: --url https://... (ou SWAP_PLUS_URL).");
  let inicio;
  try {
    inicio = await lib.loginStart({ url, fp: null, name: cfg.nome, platform: process.platform, replaces: substitui(deps.estado, url) });
  } catch (e) {
    if (e && e.code === "name_taken") throw nomeEmUso(cfg, e.message);
    if (e && e.code === "google_off") throw erro("google_desligado", "O login com Google está desligado neste servidor. Use o código de conexão (swap-plus-cliente conectar).");
    throw e;
  }
  const t0 = agora();
  const limite = Math.min(t0 + GOOGLE_MAX_MS, inicio.expiresAt || Infinity);
  await mostrar(inicio.authUrl, limite);
  let semRedeDesde = 0;
  for (;;) {
    if (parar && parar.aborted) throw erro("cancelado", "Cancelado.");
    if (agora() >= limite) throw erro("google_expirou", "O tempo para entrar acabou. Rode o comando de novo.");
    let intervalo = GOOGLE_CONSULTA_MS;
    try {
      const r = await lib.loginPoll({ url, fp: null, sessionId: inicio.sessionId, pollToken: inicio.pollToken });
      semRedeDesde = 0;
      if (r.status === "ok") return guardar(deps, { url, fp: null, deviceId: r.deviceId, token: r.token, via: "google" });
      if (r.status === "denied") throw erro("google_negado", `A conta Google ${r.email || "usada"} não está liberada neste servidor. Peça ao administrador para liberar.`, { email: r.email || null });
      if (r.status === "expired") throw erro("google_expirou", "O tempo para entrar acabou. Rode o comando de novo.");
      if (r.status === "name_taken") throw nomeEmUso(cfg, r.message);
    } catch (e) {
      if (e && ["google_negado", "google_expirou", "nome_em_uso"].includes(e.code)) throw e;
      if (e && e.code === "name_taken") throw nomeEmUso(cfg, e.message); // servidor 2.8.0 respondendo 409 no poll
      const status = Number(e && e.status) || 0;
      if (status === 429) intervalo = GOOGLE_429_MS;
      else if (status === 0 || status >= 500) {
        // Rede caiu ou o servidor reiniciou: tolera por até 1 min seguido.
        if (!semRedeDesde) semRedeDesde = agora();
        if (agora() - semRedeDesde > GOOGLE_SEM_REDE_MAX_MS) throw e;
      } else throw e;
    }
    await espera(intervalo, parar);
  }
}

/** Desfaz a conexão: revoga no servidor (melhor esforço) e esquece o token. O login do Claude Code fica como está. */
async function desconectar({ lib, estado }) {
  const con = conexaoAtual(estado);
  const revogou = await revogar(lib, con);
  const havia = estado.apagarConexao();
  estado.apagarAplicado();
  estado.apagarSituacao(); // senão o "status" e o "saude" seguiriam dizendo "em dia" com o retrato antigo
  return { havia: havia || !!con, revogou };
}

module.exports = { conectarPorCodigo, entrarComGoogle, desconectar, revogar };
