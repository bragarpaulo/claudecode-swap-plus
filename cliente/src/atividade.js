"use strict";
// Swap Plus Cliente — o que dá para saber olhando a pasta de login do Claude Code (sem falar com ninguém):
//
//   · quando o Claude Code foi usado por último com este login (para o cliente só contar como "ativo" no
//     servidor enquanto alguém está usando);
//   · quais modelos estão em uso e se a conta bateu um limite — só quando o Claude Code grava transcrições
//     (uso direto, `claude -p`). O plugin do Hermes roda com --no-session-persistence: não deixa transcrição.
//
// Sinal de uso: a data de alteração do que o Claude Code cria e mexe no primeiro nível da pasta (sessions/,
// policy-limits.json, remote-settings.json…: mudam a cada execução, mesmo sem transcrição) e das transcrições em
// projects/. O que o próprio cliente grava (o login, a identidade, as travas) não conta.

const fs = require("fs");
const path = require("path");

const JANELA_MODELOS_MS = 30 * 60 * 1000; // modelo usado nos últimos 30 min = em uso (igual à extensão)
const CAUDA_MODELO = 256 * 1024;
const CAUDA_LIMITE = 128 * 1024;
const MODELO_RE = /"model":"(claude-[^"]+)"/g;

// Arquivos que o cliente grava (ou as travas que ele pega) na pasta de login: não são sinal de uso.
const PROPRIOS = new Set([".credentials.json", ".claude.json", ".config.json"]);
function ehProprio(nome) {
  return PROPRIOS.has(nome) || /\.(lock|takeover|tmp)$/i.test(nome);
}

async function lerCauda(file, bytes) {
  const fh = await fs.promises.open(file, "r");
  try {
    const st = await fh.stat();
    const tam = Math.min(st.size, bytes);
    if (tam <= 0) return "";
    const buf = Buffer.alloc(tam);
    await fh.read(buf, 0, tam, st.size - tam);
    return buf.toString("utf8");
  } finally {
    await fh.close();
  }
}

/** Transcrições: projects/<projeto>/*.jsonl e projects/<projeto>/<sessão>/subagents/*.jsonl. → [{ file, mtimeMs, sub }] */
async function transcricoes(pasta) {
  const raiz = path.join(pasta, "projects");
  const out = [];
  let projetos = [];
  try {
    projetos = await fs.promises.readdir(raiz, { withFileTypes: true });
  } catch {
    return out;
  }
  const juntar = async (file, sub) => {
    try {
      const st = await fs.promises.stat(file);
      if (st.isFile()) out.push({ file, mtimeMs: st.mtimeMs, sub });
    } catch {}
  };
  for (const p of projetos) {
    if (!p.isDirectory()) continue;
    const dir = path.join(raiz, p.name);
    let itens = [];
    try {
      itens = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of itens) {
      if (e.isFile() && e.name.endsWith(".jsonl")) await juntar(path.join(dir, e.name), false);
      else if (e.isDirectory()) {
        const sub = path.join(dir, e.name, "subagents");
        let filhos = [];
        try {
          filhos = await fs.promises.readdir(sub);
        } catch {
          continue;
        }
        for (const f of filhos) if (f.endsWith(".jsonl")) await juntar(path.join(sub, f), true);
      }
    }
  }
  return out;
}

/** Erro de limite mais novo nas transcrições alteradas depois de `desdeMs` (mesma leitura da extensão). */
async function limiteMaisNovo(arquivos, desdeMs) {
  let achado = null;
  for (const a of arquivos) {
    if (a.mtimeMs <= desdeMs) continue;
    let cauda;
    try {
      cauda = await lerCauda(a.file, CAUDA_LIMITE);
    } catch {
      continue;
    }
    for (const linha of cauda.split("\n")) {
      if (!linha.includes('"isApiErrorMessage":true') || !linha.includes('"rate_limit"')) continue;
      let d;
      try {
        d = JSON.parse(linha);
      } catch {
        continue;
      }
      if (!d || d.isApiErrorMessage !== true || d.error !== "rate_limit") continue;
      const ts = Date.parse(d.timestamp) || a.mtimeMs;
      if (ts <= desdeMs) continue;
      const c = d.message && d.message.content;
      const text = Array.isArray(c) ? c.map((x) => (x && x.text) || "").join(" ") : String(c || "");
      const q = d.quotaLimits || (d.apiErrorParams && d.apiErrorParams.rate_limit_info) || null;
      const rateLimitType = q && typeof q.rateLimitType === "string" ? q.rateLimitType : null;
      const resetsAt = q && Number(q.resetsAt) > 0 ? Number(q.resetsAt) * 1000 : null;
      if (!achado || ts > achado.ts) achado = { ts, text, rateLimitType, resetsAt };
    }
  }
  return achado;
}

/**
 * @param {string} pasta  pasta de login do Claude Code
 * @param {{ agora?: number, desdeLimite?: number|null }} op  desdeLimite: só erros de limite depois desse instante (null = não procurar)
 * @returns {Promise<{ ultimaAtividade: number, modelos: string[], limite: object|null }>}
 *   ultimaAtividade: epoch ms do último uso visto (0 = nunca); modelos: mais recente primeiro.
 */
async function detectar(pasta, { agora = Date.now(), desdeLimite = null } = {}) {
  let ultima = 0;
  let itens = [];
  try {
    itens = await fs.promises.readdir(pasta, { withFileTypes: true });
  } catch {
    return { ultimaAtividade: 0, modelos: [], limite: null };
  }
  for (const e of itens) {
    if (ehProprio(e.name)) continue;
    try {
      const st = await fs.promises.stat(path.join(pasta, e.name));
      if (st.mtimeMs > ultima) ultima = st.mtimeMs;
    } catch {}
  }
  const arquivos = await transcricoes(pasta);
  const vistos = new Map(); // id → mtime mais novo
  for (const a of arquivos) {
    if (a.mtimeMs > ultima) ultima = a.mtimeMs;
    if (a.sub || agora - a.mtimeMs > JANELA_MODELOS_MS) continue; // modelos: só a conversa principal, como a extensão
    let cauda;
    try {
      cauda = await lerCauda(a.file, CAUDA_MODELO);
    } catch {
      continue;
    }
    let m;
    let id = null;
    MODELO_RE.lastIndex = 0;
    while ((m = MODELO_RE.exec(cauda))) id = m[1];
    if (id && id.length <= 100 && (!vistos.has(id) || vistos.get(id) < a.mtimeMs)) vistos.set(id, a.mtimeMs);
  }
  const modelos = [...vistos.entries()].sort((x, y) => y[1] - x[1]).map((x) => x[0]);
  const limite = desdeLimite === null || desdeLimite === undefined ? null : await limiteMaisNovo(arquivos, desdeLimite);
  // Relógio de arquivo adiantado não pode prender o cliente em "ativo" para sempre.
  return { ultimaAtividade: Math.min(ultima, agora), modelos, limite };
}

module.exports = { detectar, ehProprio, JANELA_MODELOS_MS };
