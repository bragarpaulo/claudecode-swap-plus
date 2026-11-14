"use strict";
// Atualizações do Swap Plus, no mesmo esquema das extensões do VS Code:
// verifica ao abrir o VS Code, a cada 2 dias e ao fechar; instala sozinho se a
// opção do VS Code "extensions.autoUpdate" estiver ligada, senão só avisa.
// Tudo roda dentro do VS Code: ao fechar, só verifica e anota; a instalação
// acontece na próxima abertura. Nada fica rodando depois que ele fecha.
//
//   motor     → releases "plus-vX.Y.Z" de bragarpaulo/swap-plus (wheel montado e
//               testado pelo GitHub Actions a partir do original realiti4/claude-swap)
//   extensão  → releases "plus-vX.Y.Z" de bragarpaulo/swap-plus-vscode (.vsix)
//
// Quando o original lança versão nova e o fork ainda não preparou, pede ao
// GitHub para preparar (se o `gh` estiver logado nesta máquina).

const vscode = require("vscode");
const https = require("https");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");

const REPOS = {
  cli: "bragarpaulo/swap-plus",
  ext: "bragarpaulo/swap-plus-vscode",
  upstreamCli: "realiti4/claude-swap",
  upstreamExt: "smith89k/claude-swap-status",
};
const SYNC_WORKFLOW = "plus-sync.yml";
const STATE_KEY = "swapPlus.updates";
const PERIOD_MS = 48 * 3600e3; // a cada 2 dias
const UA = "swap-plus-vscode";

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

// ---------------------------------------------------------------- rede e processos

function request(url, { timeout = 10000, json = true, dest = null, redirects = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      { headers: { "User-Agent": UA, Accept: json ? "application/vnd.github+json" : "application/octet-stream" }, timeout },
      (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
          res.resume();
          resolve(request(new URL(res.headers.location, url).toString(), { timeout, json, dest, redirects: redirects - 1 }));
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
            resolve(json ? JSON.parse(s) : s);
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

const IS_WIN = process.platform === "win32";

/** Acha um executável (no Windows também com .exe/.cmd). */
function findBin(name) {
  const home = os.homedir();
  const dirs = [path.join(home, ".local", "bin"), path.join(home, ".cargo", "bin")];
  if (IS_WIN) {
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, "Programs", "GitHub CLI"));
    if (process.env.ProgramFiles) dirs.push(path.join(process.env.ProgramFiles, "GitHub CLI"));
  } else {
    dirs.push("/opt/homebrew/bin", "/usr/local/bin");
  }
  dirs.push(...(process.env.PATH || "").split(path.delimiter));
  const names = IS_WIN ? [`${name}.exe`, `${name}.cmd`, name] : [name];
  for (const d of dirs) {
    if (!d) continue;
    for (const n of names) {
      const p = path.join(d, n);
      try {
        fs.accessSync(p, IS_WIN ? fs.constants.F_OK : fs.constants.X_OK);
        if (fs.statSync(p).isFile()) return p;
      } catch {}
    }
  }
  return null;
}

function run(bin, args, timeout = 60000) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, stdout: stdout || "", stderr: stderr || "", error: err ? String(err.message || err) : null });
    });
  });
}

function lastLine(s) {
  const lines = String(s || "").trim().split("\n").filter(Boolean);
  return lines.length ? lines[lines.length - 1] : "";
}

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
 * deps: { context, cfg, cliVersion(): Promise<string|null>, onCliUpdated(), pushHistory(entries), postState(),
 *         overrides?: { uv, gh, code, autoUpdate } }   (overrides só para testes)
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

  async function check({ reason = "manual", timeout = 10000 } = {}) {
    const [cliRel, extRel, upCli, upExt, installed] = await Promise.allSettled([
      request(`https://api.github.com/repos/${REPOS.cli}/releases?per_page=20`, { timeout }).then(pickPlusRelease),
      request(`https://api.github.com/repos/${REPOS.ext}/releases?per_page=20`, { timeout }).then(pickPlusRelease),
      request(`https://api.github.com/repos/${REPOS.upstreamCli}/tags?per_page=100`, { timeout }).then(pickStableTag),
      request(`https://api.github.com/repos/${REPOS.upstreamExt}/tags?per_page=100`, { timeout }).then(pickStableTag),
      deps.cliVersion(),
    ]);
    const val = (p) => (p.status === "fulfilled" ? p.value : null);
    const errors = [cliRel, extRel, upCli, upExt].filter((p) => p.status === "rejected").map((p) => String(p.reason && p.reason.message ? p.reason.message : p.reason));
    const r = {
      ts: new Date().toISOString(),
      reason,
      cli: { installed: val(installed), latest: val(cliRel) ? val(cliRel).version : null, upstream: val(upCli), release: val(cliRel) },
      ext: { installed: extVersion, latest: val(extRel) ? val(extRel).version : null, upstream: val(upExt), base: upstreamExtBase, release: val(extRel) },
      error: errors.length ? errors[0] : null,
    };
    await setState({ last: r });
    return r;
  }

  async function applyCli(release) {
    const uv = ov.uv || findBin("uv");
    if (!uv) {
      vscode.window.showWarningMessage(`Swap Plus: o motor ${release.version} está disponível, mas falta o uv nesta máquina. Instale com: curl -LsSf https://astral.sh/uv/install.sh | sh`);
      return false;
    }
    const whl = release.assets.find((a) => /\.whl$/.test(a.name));
    const spec = whl ? whl.url : `git+https://github.com/${REPOS.cli}@${release.tag}`;
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Swap Plus: atualizando o motor para ${release.version}...`, cancellable: false },
      () => run(uv, ["tool", "install", "--force", "--reinstall", spec], 300000)
    );
    const now = await deps.cliVersion();
    if (res.code !== 0 || cmpVersion(now, release.version) !== 0) {
      vscode.window.showErrorMessage(`Swap Plus: não consegui atualizar o motor: ${lastLine(res.stderr) || res.error || `versão instalada continua ${now}`}`);
      return false;
    }
    await deps.pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `Motor atualizado para ${release.version}` }]);
    await deps.onCliUpdated();
    vscode.window.showInformationMessage(`Swap Plus: motor atualizado para ${release.version}.`);
    return true;
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

  /** O original lançou versão que o fork ainda não preparou: pede ao GitHub (uma vez por versão). */
  async function maybeDispatch(version) {
    if (getState().dispatched === version) return;
    const gh = ov.gh || findBin("gh");
    if (!gh) return;
    const res = await run(gh, ["workflow", "run", SYNC_WORKFLOW, "-R", REPOS.cli], 30000);
    if (res.code === 0) {
      await setState({ dispatched: version });
      await deps.pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `O claude-swap original lançou ${version}; pedi ao GitHub para testar e preparar o motor` }]);
    }
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

      const cliRel = r.cli.release;
      if (cliRel && !r.cli.installed) {
        tasks.push(offer(`o motor (swap-plus) não está instalado nesta máquina. Instalar a versão ${cliRel.version}?`, () => applyCli(cliRel)));
      } else if (cliRel && newer(cliRel.version, r.cli.installed)) {
        tasks.push(auto ? applyCli(cliRel) : offer(`motor ${cliRel.version} disponível (instalado: ${r.cli.installed}).`, () => applyCli(cliRel)));
      }

      const extRel = r.ext.release;
      if (extRel && newer(extRel.version, extVersion)) {
        tasks.push(auto ? applyExt(extRel) : offer(`extensão ${extRel.version} disponível (instalada: ${extVersion}).`, () => applyExt(extRel)));
      }

      if (r.cli.upstream && (!r.cli.latest || newer(r.cli.upstream, r.cli.latest))) tasks.push(maybeDispatch(r.cli.upstream));

      if (newer(r.ext.upstream, r.ext.base) && getState().extNotified !== r.ext.upstream) {
        await setState({ extNotified: r.ext.upstream });
        await deps.pushHistory([{ ts: new Date().toISOString(), kind: "info", text: `A extensão original lançou ${r.ext.upstream}; o GitHub abriu um aviso no seu repositório para avaliar` }]);
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
      const pending = (r.cli.release && r.cli.installed && newer(r.cli.release.version, r.cli.installed)) || (r.ext.release && newer(r.ext.release.version, extVersion));
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
            cli: { installed: last.cli.installed, latest: last.cli.latest, upstream: last.cli.upstream },
            ext: { installed: extVersion, latest: last.ext.latest, upstream: last.ext.upstream, base: last.ext.base },
          }
        : null,
    };
  }

  return { start, stop, runCheck, onClose, check, summary, applyCli, applyExt };
}

module.exports = { createUpdater, cmpVersion, pickPlusRelease, pickStableTag, findBin, REPOS };
