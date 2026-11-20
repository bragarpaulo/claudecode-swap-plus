"use strict";
// Atualizações da extensão Swap Plus, no mesmo esquema das extensões do VS Code:
// verifica ao abrir o VS Code, a cada 2 dias e ao fechar; instala sozinho se a
// opção do VS Code "extensions.autoUpdate" estiver ligada, senão só avisa.
// Tudo roda dentro do VS Code: ao fechar, só verifica e anota; a instalação
// acontece na próxima abertura. Nada fica rodando depois que ele fecha.
//
//   extensão  → releases "plus-vX.Y.Z" de bragarpaulo/claudecode-swap-plus (.vsix)
//   original  → tags "vX.Y.Z" de smith89k/claude-swap-status (só para avisar no histórico)
//
// 3.0: o motor antigo (CLI swap-plus) não é mais usado; o atualizador não o
// consulta, não instala nem atualiza.

const vscode = require("vscode");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");

const REPOS = {
  ext: "bragarpaulo/claudecode-swap-plus",
  upstreamExt: "smith89k/claude-swap-status",
};
const STATE_KEY = "swapPlus.updates";
const PERIOD_MS = 48 * 3600e3; // a cada 2 dias
const UA = "claudecode-swap-plus";

// ---------------------------------------------------------------- versões

function parseVersion(s) {
  const m = String(s || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return m ? m.slice(1, 4).map(Number) : null;
}

/** > 0 se a for mais nova que b; 0 se iguais ou se alguma não for versão. */
function cmpVersion(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

const newer = (a, b) => !!a && !!b && cmpVersion(a, b) > 0;

/** Release "plus-vX.Y.Z" mais nova de uma lista da API do GitHub. */
function pickPlusRelease(releases) {
  const r = (Array.isArray(releases) ? releases : [])
    .filter((x) => x && !x.draft && !x.prerelease && /^plus-v\d+\.\d+\.\d+$/.test(x.tag_name))
    .sort((a, b) => cmpVersion(b.tag_name, a.tag_name))[0];
  if (!r) return null;
  return {
    tag: r.tag_name,
    version: r.tag_name.slice("plus-v".length),
    url: r.html_url,
    assets: (r.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url })),
  };
}

/** Maior tag estável "vX.Y.Z" (betas ficam de fora), sem o "v". */
function pickStableTag(tags) {
  const v = (Array.isArray(tags) ? tags : [])
    .map((t) => (t && t.name) || "")
    .filter((n) => /^v\d+\.\d+\.\d+$/.test(n))
    .sort((a, b) => cmpVersion(b, a));
  return v[0] ? v[0].slice(1) : null;
}

// ---------------------------------------------------------------- rede

const RATE_LIMIT_MSG = "o GitHub limitou as consultas desta rede por agora (60 por hora sem login, somando todos os computadores da rede); a próxima verificação tenta de novo";

/**
 * GET simples. Com `etag`, pede "só se mudou" e a resposta 304 volta como
 * { notModified: true }. Sem login, o GitHub conta essa consulta no limite do
 * mesmo jeito; por isso a API é só a reserva (veja latestReleaseTag).
 */
function request(url, { timeout = 10000, json = true, dest = null, redirects = 5, etag = null, withMeta = false } = {}) {
  return new Promise((resolve, reject) => {
    const headers = { "User-Agent": UA, Accept: json ? "application/vnd.github+json" : "application/octet-stream" };
    if (etag) headers["If-None-Match"] = etag;
    const req = https.get(
      url,
      { headers, timeout },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          resolve(request(new URL(res.headers.location, url).toString(), { timeout, json, dest, redirects: redirects - 1 }));
          return;
        }
        if (res.statusCode === 304 && etag) {
          res.resume();
          resolve({ notModified: true });
          return;
        }
        if ((res.statusCode === 403 || res.statusCode === 429) && (res.headers["x-ratelimit-remaining"] === "0" || res.headers["retry-after"])) {
          res.resume();
          reject(new Error(RATE_LIMIT_MSG));
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`GitHub respondeu ${res.statusCode}`));
          return;
        }
        if (dest) {
          const out = fs.createWriteStream(dest, { mode: 0o600 });
          res.pipe(out);
          out.on("finish", () => out.close(() => resolve(dest)));
          out.on("error", reject);
          return;
        }
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          try {
            const s = Buffer.concat(chunks).toString("utf8");
            const body = json ? JSON.parse(s) : s;
            resolve(withMeta ? { body, etag: res.headers.etag || null } : body);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on("timeout", () => req.destroy(new Error("sem resposta do GitHub")));
    req.on("error", reject);
  });
}

/** HEAD sem seguir o redirecionamento; devolve o endereço para onde o GitHub manda. */
function headLocation(url, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method: "HEAD", headers: { "User-Agent": UA }, timeout }, (res) => {
      res.resume();
      resolve(res.headers.location || null);
    });
    req.on("timeout", () => req.destroy(new Error("sem resposta do GitHub")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * Tag da release mais nova pelo link /releases/latest do site do GitHub, que
 * redireciona para ela. Não usa a API, então não gasta o limite de 60
 * consultas por hora (que vale para a rede inteira, sem login).
 */
async function latestReleaseTag(repo, timeout) {
  const loc = await headLocation(`https://github.com/${repo}/releases/latest`, timeout);
  const m = loc && loc.match(/\/releases\/tag\/([^/?#]+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Release plus-vX.Y.Z montada a partir da tag; os arquivos têm endereço previsível. */
function plusReleaseFromTag(repo, tag, assetName) {
  const version = tag.slice("plus-v".length);
  const name = assetName(version);
  return {
    tag,
    version,
    url: `https://github.com/${repo}/releases/tag/${tag}`,
    assets: [{ name, url: `https://github.com/${repo}/releases/download/${tag}/${name}` }],
  };
}

const VSIX_NAME = () => "swap-plus.vsix";

/** Trava entre janelas do VS Code: no máximo uma verificação por intervalo. */
function claim(name, ms) {
  const file = path.join(os.tmpdir(), `swap-plus-${name}.lock`);
  try {
    const now = Date.now();
    let last = 0;
    try {
      last = Number(fs.readFileSync(file, "utf8")) || 0;
    } catch {}
    if (now - last < ms) return false;
    fs.writeFileSync(file, String(now));
    return true;
  } catch {
    return true;
  }
}

// ---------------------------------------------------------------- atualizador

/**
 * deps: { context, cfg, pushHistory(entries), postState(),
 *         overrides?: { autoUpdate } }   (overrides só para testes)
 */
function createUpdater(deps) {
  const { context } = deps;
  const pkg = (context.extension && context.extension.packageJSON) || require("./package.json");
  const extVersion = pkg.version;
  const upstreamExtBase = (pkg.swapPlus && pkg.swapPlus.upstreamExtension) || null;
  const ov = deps.overrides || {};
  let timer = null;
  let busy = null;

  const getState = () => context.globalState.get(STATE_KEY) || {};
  const setState = (patch) => context.globalState.update(STATE_KEY, { ...getState(), ...patch });
  const enabled = () => deps.cfg().get("updates.enabled") !== false;
  const autoUpdate = () => {
    if (typeof ov.autoUpdate === "boolean") return ov.autoUpdate;
    const v = vscode.workspace.getConfiguration("extensions").get("autoUpdate");
    return v !== false && v !== "off";
  };

  /** Reserva (só se o link de "última release" falhar): API, guardando a última resposta com a ETag. */
  async function apiGet(url, pick, timeout) {
    const cache = getState().http || {};
    const hit = cache[url];
    const res = await request(url, { timeout, etag: hit && hit.etag, withMeta: true });
    if (res.notModified) return hit.value;
    const value = pick(res.body);
    if (res.etag) {
      const fresh = { ...(getState().http || {}), [url]: { etag: res.etag, value } };
      await setState({ http: fresh });
    }
    return value;
  }

  async function latestPlus(repo, assetName, timeout) {
    try {
      const tag = await latestReleaseTag(repo, timeout);
      if (tag && /^plus-v\d+\.\d+\.\d+$/.test(tag)) return plusReleaseFromTag(repo, tag, assetName);
    } catch {}
    return apiGet(`https://api.github.com/repos/${repo}/releases?per_page=20`, pickPlusRelease, timeout);
  }

  async function latestStable(repo, timeout) {
    try {
      const tag = await latestReleaseTag(repo, timeout);
      if (tag && /^v\d+\.\d+\.\d+$/.test(tag)) return tag.slice(1);
    } catch {}
    return apiGet(`https://api.github.com/repos/${repo}/tags?per_page=100`, pickStableTag, timeout);
  }

  async function check({ reason = "manual", timeout = 10000 } = {}) {
    const [extRel, upExt] = await Promise.allSettled([latestPlus(REPOS.ext, VSIX_NAME, timeout), latestStable(REPOS.upstreamExt, timeout)]);
    const val = (p) => (p.status === "fulfilled" ? p.value : null);
    const errors = [extRel, upExt].filter((p) => p.status === "rejected").map((p) => String(p.reason && p.reason.message ? p.reason.message : p.reason));
    const r = {
      ts: new Date().toISOString(),
      reason,
      ext: { installed: extVersion, latest: val(extRel) ? val(extRel).version : null, upstream: val(upExt), base: upstreamExtBase, release: val(extRel) },
      error: errors.length ? errors[0] : null,
    };
    await setState({ last: r });
    return r;
  }

  async function applyExt(release) {
    const asset = release.assets.find((a) => /\.vsix$/.test(a.name));
    if (!asset) return false;
    const dest = path.join(os.tmpdir(), `swap-plus-${release.version}-${process.pid}.vsix`);
    try {
      await request(asset.url, { json: false, dest, timeout: 30000 });
      const head = fs.readFileSync(dest).subarray(0, 2).toString("latin1");
      if (head !== "PK") throw new Error("o arquivo baixado não é uma extensão");
      await vscode.commands.executeCommand("workbench.extensions.installExtension", vscode.Uri.file(dest));
    } catch (e) {
      vscode.window.showErrorMessage(`Swap Plus: não consegui atualizar a extensão: ${e && e.message ? e.message : e}`);
      return false;
    }
    await deps.pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Extensão atualizada para ${release.version} (vale depois de recarregar)` }]);
    vscode.window
      .showInformationMessage(`Swap Plus ${release.version} instalada. Recarregue a janela para usar a versão nova.`, "Recarregar agora")
      .then((c) => c && vscode.commands.executeCommand("workbench.action.reloadWindow"));
    return true;
  }

  async function offer(text, action) {
    const choice = await vscode.window.showInformationMessage(`Swap Plus: ${text}`, "Atualizar");
    if (choice) await action();
  }

  async function runCheck({ reason = "manual" } = {}) {
    if (!enabled() && reason !== "manual") return null;
    if (busy) return busy;
    if (reason !== "manual" && !claim("update", 10 * 60e3)) return null;
    busy = (async () => {
      const r = await check({ reason });
      const auto = autoUpdate() || reason === "manual";
      const tasks = [];

      const extRel = r.ext.release;
      if (extRel && newer(extRel.version, extVersion)) {
        tasks.push(auto ? applyExt(extRel) : offer(`extensão ${extRel.version} disponível (instalada: ${extVersion}).`, () => applyExt(extRel)));
      }

      if (newer(r.ext.upstream, r.ext.base) && getState().extNotified !== r.ext.upstream) {
        await setState({ extNotified: r.ext.upstream });
        await deps.pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `A extensão original (de onde o Swap Plus nasceu) lançou ${r.ext.upstream}. Só informativo: o Swap Plus segue o próprio caminho` }]);
      }

      await Promise.all(tasks);
      deps.postState();
      return r;
    })().finally(() => {
      busy = null;
    });
    return busy;
  }

  /**
   * Ao fechar: verificação rápida (até 3 s) que só anota o resultado. Se houver
   * versão nova, ela é instalada na próxima abertura, dentro do VS Code.
   */
  async function onClose() {
    if (!enabled() || !claim("close", 2 * 60e3)) return null;
    try {
      const r = await Promise.race([check({ reason: "close", timeout: 2500 }), new Promise((res) => setTimeout(() => res(null), 3000))]);
      if (!r) return null;
      const pending = !!r.ext.release && newer(r.ext.release.version, extVersion);
      await setState({ pendingOnOpen: !!pending });
      return r;
    } catch {
      return null;
    }
  }

  function start() {
    if (timer) clearInterval(timer);
    // Se o fechamento anterior achou versão nova, instala logo; senão espera o VS Code assentar.
    const delay = getState().pendingOnOpen ? 3000 : 20000;
    setTimeout(() => {
      setState({ pendingOnOpen: false });
      runCheck({ reason: "open" }).catch(() => {});
    }, delay);
    timer = setInterval(() => runCheck({ reason: "periodic" }).catch(() => {}), PERIOD_MS);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function summary() {
    const last = getState().last || null;
    return {
      enabled: enabled(),
      autoUpdate: autoUpdate(),
      pendingOnOpen: !!getState().pendingOnOpen,
      extInstalled: extVersion,
      last: last
        ? {
            ts: last.ts,
            reason: last.reason,
            error: last.error,
            ext: { installed: extVersion, latest: (last.ext || {}).latest || null, upstream: (last.ext || {}).upstream || null, base: (last.ext || {}).base || null },
          }
        : null,
    };
  }

  return { start, stop, runCheck, onClose, check, summary, applyExt };
}

module.exports = { createUpdater, cmpVersion, pickPlusRelease, pickStableTag, request, latestReleaseTag, RATE_LIMIT_MSG, REPOS };
