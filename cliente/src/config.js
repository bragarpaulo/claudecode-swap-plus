"use strict";
// Swap Plus Cliente — configuração: opções da linha de comando > variáveis de ambiente > padrão.
//
//   SWAP_PLUS_CLIENTE_DIR     pasta de dados do cliente (conexão com o servidor, situação). Padrão: ~/.swap-plus-cliente
//   SWAP_PLUS_CLAUDE_DIR      pasta de login do Claude Code que ESTE cliente mantém. Padrão: <pasta de dados>/claude
//   SWAP_PLUS_PRESENCA        auto (padrão) | sempre
//   SWAP_PLUS_MODELOS         modelos em uso, separados por vírgula (opcional; ver LEIA-ME)
//   SWAP_PLUS_NOME            nome deste cliente no painel do servidor. Padrão: o nome da máquina
//   SWAP_PLUS_URL             endereço do servidor para "entrar" (login com Google)
//   SWAP_PLUS_SUBSTITUIR_LOGIN=1   gravar por cima de um login feito à mão na pasta (com refresh token)
//   SWAP_PLUS_PASTA_PADRAO=1  aceitar a pasta padrão do Claude Code (~/.claude) como pasta de login
//   SWAP_PLUS_LOG             info (padrão) | debug | quieto
//
// A pasta de login é só deste cliente: quem usa o Claude Code por ele aponta para ela (CLAUDE_CONFIG_DIR, ou a
// configuração `claude_config_dir` do plugin do Hermes). A pasta padrão (~/.claude) é a da extensão do VS Code:
// dois clientes gravando nela brigariam (cada um é um computador no servidor, talvez em contas diferentes).

const os = require("os");
const path = require("path");
const { erro } = require("./arquivos");

const PRESENCAS = ["auto", "sempre"];
const VERDADE = /^(1|true|sim|yes|on)$/i;

function expandir(p) {
  const s = String(p || "").trim();
  if (!s) return "";
  if (s === "~") return os.homedir();
  if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(os.homedir(), s.slice(2));
  return s;
}

function mesmaPasta(a, b) {
  const n = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  return n(a) === n(b);
}

/** `filho` fica dentro de `pai` (em qualquer nível)? */
function dentroDe(filho, pai) {
  const n = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" || process.platform === "darwin" ? r.toLowerCase() : r;
  };
  const rel = path.relative(n(pai), n(filho));
  return !!rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function nomePadrao() {
  const h = String(os.hostname() || "")
    .replace(/\.local$/i, "")
    .trim();
  return (h || "cliente").slice(0, 60);
}

/** "claude-fable-5-2, claude-opus-5-5" → ids válidos (até 20, cada um até 100 caracteres, sem repetir). */
function lerModelos(v) {
  const out = [];
  for (const parte of String(v || "").split(/[\s,;]+/)) {
    const id = parte.trim();
    if (!id || id.length > 100 || !/^claude-[A-Za-z0-9._\-[\]]+$/.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= 20) break;
  }
  return out;
}

/**
 * @param {object} op  opções da linha de comando (dir, pastaClaude, presenca, modelos, nome, url, substituirLogin, pastaPadrao)
 * @param {object} env
 */
function resolver(op = {}, env = process.env) {
  const dir = path.resolve(expandir(op.dir || env.SWAP_PLUS_CLIENTE_DIR) || path.join(os.homedir(), ".swap-plus-cliente"));
  const pastaClaude = path.resolve(expandir(op.pastaClaude || env.SWAP_PLUS_CLAUDE_DIR) || path.join(dir, "claude"));
  const padraoDoClaude = path.join(os.homedir(), ".claude");
  const ehPadrao = mesmaPasta(pastaClaude, padraoDoClaude);
  if (ehPadrao && !(op.pastaPadrao === true || VERDADE.test(String(env.SWAP_PLUS_PASTA_PADRAO || "")))) {
    throw erro(
      "pasta_padrao",
      `A pasta de login escolhida (${pastaClaude}) é a pasta padrão do Claude Code, a mesma que a extensão Swap Plus do VS Code mantém. ` +
        "Use uma pasta só deste cliente (SWAP_PLUS_CLAUDE_DIR). Se nesta máquina não há extensão e você quer mesmo a pasta padrão, defina SWAP_PLUS_PASTA_PADRAO=1."
    );
  }
  if (mesmaPasta(pastaClaude, dir)) {
    throw erro("pasta_igual", "A pasta de login do Claude Code não pode ser a própria pasta de dados do cliente: nela fica o acesso ao servidor.");
  }
  if (dentroDe(dir, pastaClaude)) {
    // Quem usa o Claude Code enxerga a pasta de login inteira: o acesso do cliente ao servidor ficaria à vista. E o
    // cliente tomaria as próprias gravações por uso do Claude Code (nunca ficaria parado).
    throw erro(
      "pasta_dentro",
      `A pasta de dados do cliente (${dir}) não pode ficar dentro da pasta de login do Claude Code (${pastaClaude}). O contrário pode: a pasta de login dentro da de dados.`
    );
  }
  const presenca = String(op.presenca || env.SWAP_PLUS_PRESENCA || "auto")
    .trim()
    .toLowerCase();
  if (!PRESENCAS.includes(presenca)) throw erro("presenca_invalida", `Presença inválida: "${presenca}". Use auto ou sempre.`);
  const nome = String(op.nome || env.SWAP_PLUS_NOME || nomePadrao())
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .trim()
    .slice(0, 60);
  const logNivel = String(op.log || env.SWAP_PLUS_LOG || "info")
    .trim()
    .toLowerCase();
  return {
    dir,
    pastaClaude,
    pastaPadrao: ehPadrao,
    presenca,
    modelos: lerModelos(op.modelos || env.SWAP_PLUS_MODELOS),
    nome: nome || nomePadrao(),
    url: String(op.url || env.SWAP_PLUS_URL || "").trim() || null,
    substituirLogin: op.substituirLogin === true || VERDADE.test(String(env.SWAP_PLUS_SUBSTITUIR_LOGIN || "")),
    logNivel: ["debug", "info", "quieto"].includes(logNivel) ? logNivel : "info",
  };
}

/**
 * O claudeAuth.js (o mesmo da extensão) acha a pasta de login pelas variáveis do Claude Code. Aqui elas passam a
 * apontar para a pasta deste cliente. Na pasta padrão a variável fica de fora: com ela definida, no macOS o
 * Claude Code procuraria outro item do Keychain.
 */
function aplicarAmbiente(cfg, env = process.env) {
  if (cfg.pastaPadrao) delete env.CLAUDE_CONFIG_DIR;
  else env.CLAUDE_CONFIG_DIR = cfg.pastaClaude;
  delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
}

module.exports = { resolver, aplicarAmbiente, lerModelos, nomePadrao, expandir, mesmaPasta, dentroDe, PRESENCAS };
