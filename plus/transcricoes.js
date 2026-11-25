"use strict";
// Inventário das transcrições do Claude Code (<pasta de config>/projects/**.jsonl), compartilhado pela procura do
// limite batido (scanLimitErrors) e pela detecção do modelo em uso (detectModels).
//
// Antes cada uma varria a pasta inteira, em série (readdir + stat de um arquivo de cada vez), em toda janela do
// VS Code. Agora (3.6.0):
//   - uma lista só: { file, mtimeMs, size, sub } de cada .jsonl (sub = transcrição de subagente,
//     <projeto>/<sessão>/subagents/*.jsonl);
//   - a lista de arquivos de cada pasta só é relida quando o mtime da pasta muda (criar/apagar arquivo muda o mtime
//     da pasta; acrescentar linhas não, por isso o stat de cada arquivo continua a cada varredura);
//   - stat com até 32 em paralelo;
//   - o resultado vale por até 10 s, e uma varredura em andamento é aproveitada por quem pedir no meio.

const fs = require("fs");
const path = require("path");

const TTL_MS = 10 * 1000;
const PARALLEL = 32;

/** fn(item) para cada item, no máximo `n` ao mesmo tempo. → resultados na ordem dos itens. */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * createInventory({ ttlMs, parallel, now }) → { list(root), invalidate(), stats }
 *   list(root): Promise<[{ file, mtimeMs, size, sub }]> (pasta que não existe → [])
 *   stats: { scans (varreduras completas), cacheHits, dirReads (readdir feitos), dirReuses (listas reaproveitadas) }
 */
function createInventory({ ttlMs = TTL_MS, parallel = PARALLEL, now = Date.now } = {}) {
  const dirCache = new Map(); // pasta → { mtimeMs, entries: [{ name, dir, file }] }
  const results = new Map(); // root → { at, files }
  const running = new Map(); // root → Promise
  const stats = { scans: 0, cacheHits: 0, dirReads: 0, dirReuses: 0 };

  /** Itens da pasta (nome, é pasta, é arquivo), relidos só quando o mtime dela muda. null = não existe/não abre. */
  async function listDir(dir) {
    let st;
    try {
      st = await fs.promises.stat(dir);
    } catch {
      dirCache.delete(dir);
      return null;
    }
    if (!st.isDirectory()) return null;
    const hit = dirCache.get(dir);
    if (hit && hit.mtimeMs === st.mtimeMs) {
      stats.dirReuses++;
      return hit.entries;
    }
    let ents;
    try {
      ents = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      dirCache.delete(dir);
      return null;
    }
    stats.dirReads++;
    const entries = ents.map((e) => ({ name: e.name, dir: e.isDirectory(), file: e.isFile() }));
    dirCache.set(dir, { mtimeMs: st.mtimeMs, entries });
    return entries;
  }

  async function scan(root) {
    stats.scans++;
    const top = await listDir(root);
    if (!top) return [];
    const candidates = []; // { file, sub }
    const seenDirs = new Set([root]);
    await mapLimit(
      top.filter((e) => e.dir),
      parallel,
      async (proj) => {
        const dir = path.join(root, proj.name);
        seenDirs.add(dir);
        const ents = (await listDir(dir)) || [];
        const sessions = [];
        for (const e of ents) {
          if (e.file && e.name.endsWith(".jsonl")) candidates.push({ file: path.join(dir, e.name), sub: false });
          else if (e.dir) sessions.push(path.join(dir, e.name, "subagents"));
        }
        for (const sub of sessions) {
          const sents = await listDir(sub);
          if (!sents) continue;
          seenDirs.add(sub);
          for (const e of sents) if (e.file && e.name.endsWith(".jsonl")) candidates.push({ file: path.join(sub, e.name), sub: true });
        }
      }
    );
    // Pastas que sumiram saem do cache (não cresce para sempre).
    for (const d of dirCache.keys()) if ((d === root || d.startsWith(root + path.sep)) && !seenDirs.has(d)) dirCache.delete(d);
    const files = await mapLimit(candidates, parallel, async (c) => {
      try {
        const st = await fs.promises.stat(c.file);
        return { file: c.file, mtimeMs: st.mtimeMs, size: st.size, sub: c.sub };
      } catch {
        return null;
      }
    });
    return files.filter(Boolean);
  }

  function list(root) {
    const r = results.get(root);
    if (r && now() - r.at < ttlMs) {
      stats.cacheHits++;
      return Promise.resolve(r.files);
    }
    if (running.has(root)) return running.get(root);
    const p = scan(root)
      .then((files) => {
        results.set(root, { at: now(), files });
        return files;
      })
      .finally(() => running.delete(root));
    running.set(root, p);
    return p;
  }

  /** Esquece os resultados (a próxima list varre de novo; as listas das pastas continuam valendo pelo mtime). */
  function invalidate() {
    results.clear();
  }

  return { list, invalidate, stats };
}

module.exports = { createInventory, mapLimit, TTL_MS, PARALLEL };
