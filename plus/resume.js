"use strict";
// Swap Plus — retomar a conversa sozinho depois da troca de conta (o lado de quem instala).
// Sem dependência do VS Code: a extensão usa, e os testes também.
//
// O Claude Code não tem comando para "mandar uma mensagem" numa conversa aberta. O que ele tem, documentado:
//   - ganchos (hooks) no settings.json dele — o `StopFailure` roda quando um turno acaba por erro da API;
//   - uma caixa de entrada por sessão, onde um processo filho da própria sessão (um gancho) pode postar.
// Então a peça que retoma a conversa é o script hooks/retomar.js, rodado pelo PRÓPRIO Claude Code em cada sessão
// (cada janela do VS Code, cada conversa). Daqui a extensão só:
//   1. copia o script para ~/.swap-plus/retomar.js (caminho que não muda quando a extensão atualiza);
//   2. põe (ou tira) a entrada dele no `hooks.StopFailure` do settings.json do Claude Code, sem mexer no resto;
//   3. grava ~/.swap-plus/retomar.json (ligado/desligado e o texto da mensagem);
//   4. grava ~/.swap-plus/aplicado.json cada vez que grava um login no Claude Code — é por esse arquivo que o
//      script sabe que a troca aconteceu.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const SCRIPT_NAME = "retomar.js";
const DEFAULT_TEXT = "Troquei de conta, pode continuar.";
const BACKUP_SUFFIX = ".antes-swap-plus";

/**
 * Pasta do Swap Plus fora do VS Code: ~/.swap-plus. Com CLAUDE_CONFIG_DIR (outra pasta de configuração do Claude
 * Code), fica dentro dela (<pasta>/swap-plus): a extensão e o script, que roda dentro do Claude Code, chegam ao mesmo
 * lugar, e cada instalação do Claude Code tem o seu. SWAP_PLUS_DIR manda em tudo (testes).
 */
function swapDir() {
  if (process.env.SWAP_PLUS_DIR) return process.env.SWAP_PLUS_DIR;
  if (process.env.CLAUDE_CONFIG_DIR) return path.join(process.env.CLAUDE_CONFIG_DIR, "swap-plus");
  return path.join(os.homedir(), ".swap-plus");
}

function claudeDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function fail(code, message) {
  return Object.assign(new Error(message), { code });
}

/** Grava o arquivo inteiro de uma vez (temporário + troca de nome): ninguém lê pela metade. */
function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  fs.writeFileSync(tmp, text);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try {
      fs.unlinkSync(tmp);
    } catch {}
    throw e;
  }
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e && e.code === "ENOENT") return null;
    throw e;
  }
}

/** O Swap Plus acabou de gravar um login no Claude Code (conta nova ou acesso renovado). Nunca lança. */
function markApplied({ number = null, gen = null } = {}, dir = swapDir()) {
  try {
    writeAtomic(path.join(dir, "aplicado.json"), JSON.stringify({ at: Date.now(), number, gen }) + "\n");
    return true;
  } catch {
    return false;
  }
}

/** Ligado/desligado e o texto da mensagem, para o script ler. Só regrava se mudou. */
function writeConfig({ enabled, text }, dir = swapDir()) {
  const said = typeof text === "string" && text.trim() ? text.trim().slice(0, 300) : DEFAULT_TEXT;
  const body = JSON.stringify({ enabled: enabled !== false, text: said }, null, 2) + "\n";
  const file = path.join(dir, "retomar.json");
  if (readText(file) === body) return false;
  writeAtomic(file, body);
  return true;
}

/** Copia o script para a pasta do Swap Plus (se o conteúdo mudou). → caminho de destino */
function installScript(source, dir = swapDir()) {
  const body = fs.readFileSync(source, "utf8");
  const dest = path.join(dir, SCRIPT_NAME);
  if (readText(dest) !== body) writeAtomic(dest, body);
  return dest;
}

/**
 * Como o Claude Code vai rodar o script: `node` se existir neste sistema (forma direta, sem shell); senão o próprio
 * executável do VS Code no modo Node (ELECTRON_RUN_AS_NODE), pela shell do sistema.
 *   hasNode / execPath / platform: só para os testes.
 */
function hookCommand(script, { hasNode = null, execPath = process.execPath, platform = process.platform } = {}) {
  const node = hasNode === null ? nodeAvailable() : hasNode;
  if (node) return { type: "command", command: "node", args: [script], async: true };
  const q = platform === "win32" ? (s) => `'${String(s).replace(/'/g, "''")}'` : (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const command = platform === "win32" ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${q(execPath)} ${q(script)}` : `ELECTRON_RUN_AS_NODE=1 ${q(execPath)} ${q(script)}`;
  return { type: "command", command, async: true };
}

function nodeAvailable() {
  try {
    const r = spawnSync("node", ["--version"], { timeout: 5000, windowsHide: true, encoding: "utf8" });
    return r.status === 0 && /^v\d+/.test(String(r.stdout || "").trim());
  } catch {
    return false;
  }
}

/** A entrada é a nossa? Reconhecida pelo caminho do script: …/.swap-plus/retomar.js, …/swap-plus/retomar.js ou a pasta dada. */
function isOurs(handler, dir = swapDir()) {
  if (!handler || typeof handler !== "object") return false;
  const norm = (v) => String(v).replace(/\\+/g, "/").replace(/\/+/g, "/");
  const s = norm(JSON.stringify(handler));
  return s.includes(`${norm(dir)}/${SCRIPT_NAME}`) || /\/\.?swap-plus\/retomar\.js/.test(s);
}

function isObj(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Tira as nossas entradas de hooks.StopFailure (e as listas que ficarem vazias). → true se tirou alguma */
function stripOurs(settings, dir) {
  if (!isObj(settings.hooks) || !Array.isArray(settings.hooks.StopFailure)) return false;
  let removed = false;
  const groups = [];
  for (const g of settings.hooks.StopFailure) {
    if (!isObj(g) || !Array.isArray(g.hooks)) {
      groups.push(g);
      continue;
    }
    const keep = g.hooks.filter((h) => !isOurs(h, dir));
    if (keep.length !== g.hooks.length) removed = true;
    if (keep.length) groups.push(keep.length === g.hooks.length ? g : { ...g, hooks: keep });
  }
  if (!removed) return false;
  if (groups.length) settings.hooks.StopFailure = groups;
  else delete settings.hooks.StopFailure;
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  return true;
}

/**
 * Lê o settings.json do Claude Code. Não existe → {}. Existe e não é um objeto JSON → erro `invalid_settings`
 * (não mexemos num arquivo que não entendemos).
 */
function readSettings(file) {
  const text = readText(file);
  if (text === null || !text.trim()) return { text, settings: {} };
  let settings;
  try {
    settings = JSON.parse(text.replace(/^﻿/, ""));
  } catch {
    throw fail("invalid_settings", `o ${path.basename(file)} do Claude Code não é um JSON válido; não mexi nele`);
  }
  if (!isObj(settings)) throw fail("invalid_settings", `o ${path.basename(file)} do Claude Code não é um objeto; não mexi nele`);
  return { text, settings };
}

function writeSettings(file, before, settings) {
  const body = JSON.stringify(settings, null, 2) + "\n";
  if (before !== null && before.replace(/^﻿/, "") === body) return false;
  // Uma cópia do arquivo como estava antes da primeira mudança do Swap Plus (só uma vez).
  if (before !== null && readText(file + BACKUP_SUFFIX) === null) {
    try {
      fs.writeFileSync(file + BACKUP_SUFFIX, before);
    } catch {}
  }
  writeAtomic(file, body);
  return true;
}

/** Põe a nossa entrada em hooks.StopFailure (uma só; as outras entradas e chaves ficam como estão). → true se gravou */
function installHook(script, { settingsFile = path.join(claudeDir(), "settings.json"), dir = swapDir(), command = null } = {}) {
  const { text, settings } = readSettings(settingsFile);
  const want = command || hookCommand(script);
  const cur = isObj(settings.hooks) && Array.isArray(settings.hooks.StopFailure) ? settings.hooks.StopFailure : [];
  // Já está igualzinha (uma entrada nossa, sozinha no grupo dela)? Nada a fazer.
  const ours = cur.filter((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h, dir)));
  if (ours.length === 1 && ours[0].hooks.length === 1 && JSON.stringify(ours[0].hooks[0]) === JSON.stringify(want) && ours[0].matcher === undefined) return false;
  stripOurs(settings, dir);
  if (!isObj(settings.hooks)) settings.hooks = {};
  if (!Array.isArray(settings.hooks.StopFailure)) settings.hooks.StopFailure = [];
  settings.hooks.StopFailure.push({ hooks: [want] });
  return writeSettings(settingsFile, text, settings);
}

/** Tira a nossa entrada. → true se gravou */
function uninstallHook({ settingsFile = path.join(claudeDir(), "settings.json"), dir = swapDir() } = {}) {
  const { text, settings } = readSettings(settingsFile);
  if (text === null) return false;
  if (!stripOurs(settings, dir)) return false;
  return writeSettings(settingsFile, text, settings);
}

/** O gancho está instalado? (nunca lança) */
function installed({ settingsFile = path.join(claudeDir(), "settings.json"), dir = swapDir() } = {}) {
  try {
    const { settings } = readSettings(settingsFile);
    const cur = isObj(settings.hooks) && Array.isArray(settings.hooks.StopFailure) ? settings.hooks.StopFailure : [];
    return cur.some((g) => isObj(g) && Array.isArray(g.hooks) && g.hooks.some((h) => isOurs(h, dir)));
  } catch {
    return false;
  }
}

/**
 * Deixa tudo como a opção pede. Ligado: script copiado, gancho instalado, retomar.json com enabled true.
 * Desligado: gancho fora e enabled false (o script, se alguma sessão antiga ainda o chamar, não faz nada).
 * → { enabled, installed, changed, error: null | { code, message } }  (nunca lança)
 */
function sync({ enabled, text = "", scriptSource, settingsFile, dir = swapDir(), command = null } = {}) {
  const out = { enabled: !!enabled, installed: false, changed: false, error: null };
  const opts = { settingsFile: settingsFile || path.join(claudeDir(), "settings.json"), dir };
  try {
    if (writeConfig({ enabled: !!enabled, text }, dir)) out.changed = true;
    if (enabled) {
      const script = installScript(scriptSource, dir);
      if (installHook(script, { ...opts, command })) out.changed = true;
    } else if (uninstallHook(opts)) out.changed = true;
  } catch (e) {
    out.error = { code: (e && e.code) || "error", message: String((e && e.message) || e) };
  }
  out.installed = installed(opts);
  return out;
}

module.exports = {
  DEFAULT_TEXT,
  SCRIPT_NAME,
  swapDir,
  claudeDir,
  markApplied,
  writeConfig,
  installScript,
  hookCommand,
  installHook,
  uninstallHook,
  installed,
  sync,
};
