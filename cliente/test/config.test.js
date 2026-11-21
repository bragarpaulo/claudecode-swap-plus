"use strict";
// Testes de src/config.js: opções da linha de comando > variáveis de ambiente > padrão, as pastas recusadas e o
// ambiente que o claudeAuth.js enxerga. resolver() só faz conta com caminhos: nada aqui lê nem grava em disco.
// Rodar:  node --test cliente/test/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");

const { guardarAmbiente, auth } = require("./apoio");
const { resolver, aplicarAmbiente, lerModelos, nomePadrao, expandir, mesmaPasta, PRESENCAS } = require("../src/config");

const CASA = os.homedir();
const DADOS = path.join(os.tmpdir(), "swap-plus-config-teste", "dados"); // só o caminho: a pasta não é criada
const LOGIN = path.join(os.tmpdir(), "swap-plus-config-teste", "login");
const SEM_CAIXA = process.platform === "win32" || process.platform === "darwin"; // nomes de pasta sem diferença de maiúsculas

function recusa(fn, code) {
  assert.throws(fn, (e) => {
    assert.equal(e.code, code);
    assert.ok(e.message && e.message.length > 20, "a recusa explica o motivo");
    return true;
  });
}

test("padrões: dados em ~/.swap-plus-cliente, login em <dados>/claude, presença auto, sem modelos, nome da máquina", () => {
  const cfg = resolver({}, {});
  assert.equal(cfg.dir, path.join(CASA, ".swap-plus-cliente"));
  assert.equal(cfg.pastaClaude, path.join(CASA, ".swap-plus-cliente", "claude"));
  assert.equal(cfg.pastaPadrao, false);
  assert.equal(cfg.presenca, "auto");
  assert.deepEqual(cfg.modelos, []);
  assert.equal(cfg.nome, nomePadrao());
  assert.ok(cfg.nome.length > 0 && cfg.nome.length <= 60);
  assert.equal(cfg.url, null);
  assert.equal(cfg.substituirLogin, false);
  assert.equal(cfg.logNivel, "info");
  assert.deepEqual(PRESENCAS, ["auto", "sempre"]);
});

test("só a pasta de dados informada: o login fica em <dados>/claude", () => {
  assert.equal(resolver({ dir: DADOS }, {}).pastaClaude, path.join(DADOS, "claude"));
  assert.equal(resolver({}, { SWAP_PLUS_CLIENTE_DIR: DADOS }).pastaClaude, path.join(DADOS, "claude"));
});

test("variáveis de ambiente valem quando a opção não foi dada", () => {
  const cfg = resolver(
    {},
    {
      SWAP_PLUS_CLIENTE_DIR: DADOS,
      SWAP_PLUS_CLAUDE_DIR: LOGIN,
      SWAP_PLUS_PRESENCA: "sempre",
      SWAP_PLUS_MODELOS: "claude-fable-5-2,claude-opus-5-5",
      SWAP_PLUS_NOME: "hermes-vps",
      SWAP_PLUS_URL: " https://swap.exemplo.com ",
      SWAP_PLUS_SUBSTITUIR_LOGIN: "1",
      SWAP_PLUS_LOG: "debug",
    }
  );
  assert.equal(cfg.dir, path.resolve(DADOS));
  assert.equal(cfg.pastaClaude, path.resolve(LOGIN));
  assert.equal(cfg.presenca, "sempre");
  assert.deepEqual(cfg.modelos, ["claude-fable-5-2", "claude-opus-5-5"]);
  assert.equal(cfg.nome, "hermes-vps");
  assert.equal(cfg.url, "https://swap.exemplo.com");
  assert.equal(cfg.substituirLogin, true);
  assert.equal(cfg.logNivel, "debug");
});

test("opções da linha de comando valem mais que as variáveis de ambiente", () => {
  const env = {
    SWAP_PLUS_CLIENTE_DIR: path.join(os.tmpdir(), "do-ambiente", "dados"),
    SWAP_PLUS_CLAUDE_DIR: path.join(os.tmpdir(), "do-ambiente", "login"),
    SWAP_PLUS_PRESENCA: "sempre",
    SWAP_PLUS_MODELOS: "claude-do-ambiente",
    SWAP_PLUS_NOME: "nome-do-ambiente",
    SWAP_PLUS_URL: "https://ambiente.exemplo.com",
    SWAP_PLUS_LOG: "debug",
  };
  const cfg = resolver({ dir: DADOS, pastaClaude: LOGIN, presenca: "auto", modelos: "claude-da-opcao", nome: "nome-da-opcao", url: "https://opcao.exemplo.com", log: "quieto" }, env);
  assert.equal(cfg.dir, path.resolve(DADOS));
  assert.equal(cfg.pastaClaude, path.resolve(LOGIN));
  assert.equal(cfg.presenca, "auto");
  assert.deepEqual(cfg.modelos, ["claude-da-opcao"]);
  assert.equal(cfg.nome, "nome-da-opcao");
  assert.equal(cfg.url, "https://opcao.exemplo.com");
  assert.equal(cfg.logNivel, "quieto");

  // Cada uma por si: a opção de uma não apaga a variável das outras.
  const misto = resolver({ dir: DADOS }, env);
  assert.equal(misto.dir, path.resolve(DADOS));
  assert.equal(misto.pastaClaude, path.resolve(env.SWAP_PLUS_CLAUDE_DIR));
  assert.equal(misto.nome, "nome-do-ambiente");
});

test("~ no começo do caminho vira a pasta do usuário (opção e variável)", () => {
  assert.equal(expandir("~"), CASA);
  assert.equal(expandir("~/dados-swap"), path.join(CASA, "dados-swap"));
  assert.equal(expandir("~\\dados-swap"), path.join(CASA, "dados-swap"));
  assert.equal(expandir("  ~/dados-swap  "), path.join(CASA, "dados-swap"));
  assert.equal(expandir("~outro/dados"), "~outro/dados", "~usuario não é expandido");
  assert.equal(expandir(""), "");
  assert.equal(expandir(undefined), "");

  const porOpcao = resolver({ dir: "~/dados-swap", pastaClaude: "~/login-hermes" }, {});
  assert.equal(porOpcao.dir, path.join(CASA, "dados-swap"));
  assert.equal(porOpcao.pastaClaude, path.join(CASA, "login-hermes"));

  const porVariavel = resolver({}, { SWAP_PLUS_CLIENTE_DIR: "~/dados-swap", SWAP_PLUS_CLAUDE_DIR: "~/login-hermes" });
  assert.equal(porVariavel.dir, path.join(CASA, "dados-swap"));
  assert.equal(porVariavel.pastaClaude, path.join(CASA, "login-hermes"));
});

test("caminho relativo vira absoluto", () => {
  const cfg = resolver({ dir: "dados-relativos" }, {});
  assert.equal(cfg.dir, path.resolve("dados-relativos"));
  assert.ok(path.isAbsolute(cfg.pastaClaude));
});

test("recusa a pasta padrão do Claude Code (~/.claude) como pasta de login", () => {
  const padrao = path.join(CASA, ".claude");
  recusa(() => resolver({ dir: DADOS, pastaClaude: "~/.claude" }, {}), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS, pastaClaude: padrao }, {}), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS, pastaClaude: padrao + path.sep }, {}), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS, pastaClaude: path.join(CASA, "x", "..", ".claude") }, {}), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS }, { SWAP_PLUS_CLAUDE_DIR: "~/.claude" }), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS, pastaClaude: "~/.claude" }, { SWAP_PLUS_PASTA_PADRAO: "0" }), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS, pastaClaude: "~/.claude" }, { SWAP_PLUS_PASTA_PADRAO: "" }), "pasta_padrao");
  recusa(() => resolver({ dir: DADOS, pastaClaude: "~/.claude", pastaPadrao: "sim" }, {}), "pasta_padrao"); // a opção só vale como true
  if (SEM_CAIXA) recusa(() => resolver({ dir: DADOS, pastaClaude: path.join(CASA, ".CLAUDE") }, {}), "pasta_padrao");
  else assert.equal(resolver({ dir: DADOS, pastaClaude: path.join(CASA, ".CLAUDE") }, {}).pastaPadrao, false, "com diferença de maiúsculas é outra pasta");

  // Pasta vizinha de nome parecido não é a padrão.
  assert.equal(resolver({ dir: DADOS, pastaClaude: path.join(CASA, ".claude-hermes") }, {}).pastaPadrao, false);
  assert.equal(resolver({ dir: DADOS, pastaClaude: path.join(CASA, ".claude", "hermes") }, {}).pastaPadrao, false);
});

test("aceita a pasta padrão quando pedido: --pasta-padrao ou SWAP_PLUS_PASTA_PADRAO=1", () => {
  const padrao = path.join(CASA, ".claude");
  const porOpcao = resolver({ dir: DADOS, pastaClaude: "~/.claude", pastaPadrao: true }, {});
  assert.equal(porOpcao.pastaClaude, padrao);
  assert.equal(porOpcao.pastaPadrao, true);
  for (const v of ["1", "true", "sim", "yes", "on", "SIM", "True"]) {
    const cfg = resolver({ dir: DADOS, pastaClaude: "~/.claude" }, { SWAP_PLUS_PASTA_PADRAO: v });
    assert.equal(cfg.pastaPadrao, true, `SWAP_PLUS_PASTA_PADRAO=${v}`);
  }
  // A permissão sozinha não muda a pasta: sem escolher ~/.claude, o login continua em <dados>/claude.
  const semEscolher = resolver({ dir: DADOS, pastaPadrao: true }, {});
  assert.equal(semEscolher.pastaClaude, path.join(DADOS, "claude"));
  assert.equal(semEscolher.pastaPadrao, false);
});

test("recusa pasta de login igual à pasta de dados (nela fica o acesso ao servidor)", () => {
  recusa(() => resolver({ dir: DADOS, pastaClaude: DADOS }, {}), "pasta_igual");
  recusa(() => resolver({}, { SWAP_PLUS_CLIENTE_DIR: DADOS, SWAP_PLUS_CLAUDE_DIR: DADOS }), "pasta_igual");
  recusa(() => resolver({ dir: DADOS, pastaClaude: DADOS + path.sep }, {}), "pasta_igual");
  recusa(() => resolver({ dir: DADOS, pastaClaude: path.join(DADOS, "claude", "..") }, {}), "pasta_igual");
  recusa(() => resolver({ dir: "~/x", pastaClaude: path.join(CASA, "x") }, {}), "pasta_igual");
  if (SEM_CAIXA) recusa(() => resolver({ dir: DADOS, pastaClaude: DADOS.toUpperCase() }, {}), "pasta_igual");
});

test("mesmaPasta: compara caminhos resolvidos (sem diferenciar maiúsculas no Windows e no macOS)", () => {
  assert.equal(mesmaPasta(DADOS, path.join(DADOS, "a", "..")), true);
  assert.equal(mesmaPasta(DADOS, DADOS + path.sep), true);
  assert.equal(mesmaPasta(DADOS, LOGIN), false);
  assert.equal(mesmaPasta(DADOS, path.join(DADOS, "claude")), false);
  assert.equal(mesmaPasta(DADOS, DADOS.toUpperCase()), SEM_CAIXA || DADOS === DADOS.toUpperCase());
});

test("presença: auto ou sempre (sem diferenciar maiúsculas nem espaços); outra coisa é recusada", () => {
  assert.equal(resolver({ dir: DADOS, presenca: "sempre" }, {}).presenca, "sempre");
  assert.equal(resolver({ dir: DADOS, presenca: " SEMPRE " }, {}).presenca, "sempre");
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_PRESENCA: "Auto" }).presenca, "auto");
  recusa(() => resolver({ dir: DADOS, presenca: "nunca" }, {}), "presenca_invalida");
  recusa(() => resolver({ dir: DADOS }, { SWAP_PLUS_PRESENCA: "as-vezes" }), "presenca_invalida");
  recusa(() => resolver({ dir: DADOS, presenca: "auto sempre" }, {}), "presenca_invalida");
});

test("lerModelos: separa por vírgula, espaço ou ponto e vírgula; só ids claude-…; sem repetir; no máximo 20", () => {
  assert.deepEqual(lerModelos("claude-fable-5-2, claude-opus-5-5"), ["claude-fable-5-2", "claude-opus-5-5"]);
  assert.deepEqual(lerModelos("claude-a;claude-b claude-c\n claude-d,,claude-a"), ["claude-a", "claude-b", "claude-c", "claude-d"]);
  assert.deepEqual(lerModelos("claude-opus-5-5[1m], claude-3.5_sonnet"), ["claude-opus-5-5[1m]", "claude-3.5_sonnet"]);
  assert.deepEqual(lerModelos('gpt-9, fable, claude-, CLAUDE-x, claude-com"aspas, claude-ok, claude-é'), ["claude-ok"]);
  assert.deepEqual(lerModelos(`claude-${"x".repeat(93)}, claude-${"y".repeat(94)}`), [`claude-${"x".repeat(93)}`], "até 100 caracteres");
  assert.deepEqual(lerModelos(""), []);
  assert.deepEqual(lerModelos(undefined), []);
  assert.deepEqual(lerModelos(null), []);
  const muitos = Array.from({ length: 25 }, (_, i) => `claude-m${i}`);
  assert.deepEqual(lerModelos(muitos.join(",")), muitos.slice(0, 20));
});

test("nome: sem caracteres de controle, até 60 caracteres; vazio vira o nome da máquina", () => {
  assert.equal(resolver({ dir: DADOS, nome: "  hermes\tda\nvps  " }, {}).nome, "hermes da vps");
  assert.equal(resolver({ dir: DADOS, nome: "n".repeat(100) }, {}).nome, "n".repeat(60));
  assert.equal(resolver({ dir: DADOS, nome: "   " }, {}).nome, nomePadrao());
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_NOME: "" }).nome, nomePadrao());
  assert.ok(nomePadrao().length > 0 && nomePadrao().length <= 60);
});

test("log (debug, info ou quieto; outro valor vira info), endereço vazio vira null, substituirLogin só com valor verdadeiro", () => {
  assert.equal(resolver({ dir: DADOS, log: "QUIETO" }, {}).logNivel, "quieto");
  assert.equal(resolver({ dir: DADOS, log: "tagarela" }, {}).logNivel, "info");
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_LOG: "debug" }).logNivel, "debug");

  assert.equal(resolver({ dir: DADOS, url: "   " }, {}).url, null);
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_URL: "" }).url, null);

  assert.equal(resolver({ dir: DADOS, substituirLogin: true }, {}).substituirLogin, true);
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_SUBSTITUIR_LOGIN: "sim" }).substituirLogin, true);
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_SUBSTITUIR_LOGIN: "0" }).substituirLogin, false);
  assert.equal(resolver({ dir: DADOS }, { SWAP_PLUS_SUBSTITUIR_LOGIN: "nao" }).substituirLogin, false);
  assert.equal(resolver({ dir: DADOS, substituirLogin: "1" }, {}).substituirLogin, false, "a opção só vale como true");
});

test("aplicarAmbiente (num ambiente passado): CLAUDE_CONFIG_DIR vira a pasta de login; na pasta padrão a variável sai; CLAUDE_SECURESTORAGE_CONFIG_DIR sempre sai", () => {
  const env = { CLAUDE_CONFIG_DIR: "/outra/pasta", CLAUDE_SECURESTORAGE_CONFIG_DIR: "/guardado/em/outro/lugar", OUTRA: "fica" };
  const cfg = resolver({ dir: DADOS, pastaClaude: LOGIN }, {});
  aplicarAmbiente(cfg, env);
  assert.deepEqual(env, { CLAUDE_CONFIG_DIR: path.resolve(LOGIN), OUTRA: "fica" });

  const envPadrao = { CLAUDE_CONFIG_DIR: "/outra/pasta", CLAUDE_SECURESTORAGE_CONFIG_DIR: "", OUTRA: "fica" };
  aplicarAmbiente(resolver({ dir: DADOS, pastaClaude: "~/.claude", pastaPadrao: true }, {}), envPadrao);
  assert.deepEqual(envPadrao, { OUTRA: "fica" });

  const envVazio = {};
  aplicarAmbiente(cfg, envVazio);
  assert.deepEqual(envVazio, { CLAUDE_CONFIG_DIR: path.resolve(LOGIN) });
});

test("aplicarAmbiente (no ambiente do processo): o claudeAuth passa a enxergar a pasta de login deste cliente", (t) => {
  t.after(guardarAmbiente(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]));
  process.env.CLAUDE_CONFIG_DIR = path.join(os.tmpdir(), "swap-plus-config-teste", "pasta-de-antes");
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = path.join(os.tmpdir(), "swap-plus-config-teste", "guardado-em-outro-lugar");

  const cfg = resolver({ dir: DADOS, pastaClaude: LOGIN }, {});
  aplicarAmbiente(cfg);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, cfg.pastaClaude);
  assert.ok(!("CLAUDE_SECURESTORAGE_CONFIG_DIR" in process.env));
  assert.equal(auth.configHome(), cfg.pastaClaude);
  assert.equal(auth._test.credentialsPath(), path.join(cfg.pastaClaude, ".credentials.json"));
  assert.equal(auth.globalConfigPath(), path.join(cfg.pastaClaude, ".claude.json"));

  // Na pasta padrão a variável sai (só contas com caminhos: nada é lido de ~/.claude).
  process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
  aplicarAmbiente(resolver({ dir: DADOS, pastaClaude: "~/.claude", pastaPadrao: true }, {}));
  assert.ok(!("CLAUDE_CONFIG_DIR" in process.env));
  assert.ok(!("CLAUDE_SECURESTORAGE_CONFIG_DIR" in process.env));
  assert.equal(auth.configHome(), path.join(CASA, ".claude"));
});
