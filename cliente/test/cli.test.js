"use strict";
// Testes da linha de comando (src/cli.js): main(argv, deps) com o ambiente, a saída, a entrada, o relógio e a
// espera trocados, contra o servidor de mentira. Sempre com --dir e --pasta-claude numa pasta temporária e o
// claudeAuth gravando em arquivo (nunca no Keychain). Tudo o que cada comando mostra (saída, erros e log) é
// conferido: o token do cliente e os tokens de acesso não podem aparecer.
// Rodar:  node --test cliente/test/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Readable } = require("node:stream");

const { servidorFalso, pastaTemp, guardarAmbiente, auth } = require("./apoio");
const { Estado } = require("../src/estado");
const { main, lerArgumentos, saudavel, descrever, esperar, VERSAO } = require("../src/cli");

const SEG = 1000;
const MIN = 60 * SEG;
const POSIX = process.platform !== "win32";

// main() aponta o CLAUDE_CONFIG_DIR do processo para a pasta de login de cada teste: no fim, volta ao que era.
const restaurarAmbiente = guardarAmbiente(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"]);
test.before(() => auth._test.setStore("file"));
test.after(() => {
  auth._test.reset();
  restaurarAmbiente();
});

/**
 * Servidor de mentira com duas contas e uma pasta temporária para o cliente. `cli(args, deps)` roda um comando
 * e devolve { codigo, saida, erros, texto }; a cada comando confere que nenhum segredo foi mostrado.
 */
async function cenario(t) {
  auth._test.setStore("file");
  const servidor = await servidorFalso();
  servidor.novaConta(1);
  servidor.novaConta(2);
  servidor.atribuida = 1;
  const dir = pastaTemp("swap-plus-cli-");
  const pastaClaude = path.join(dir, "claude");
  const relogio = { t: Date.now() }; // parte da hora de verdade: o claudeAuth recusa acesso vencido pelo relógio real
  const esperas = [];
  const segredos = [servidor.token]; // o teste acrescenta outros (ex.: o pollToken do login com Google)
  t.after(async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    await servidor.fechar();
  });

  const semSegredos = (texto) => {
    for (const s of [...segredos, servidor.token, ...Object.values(servidor.contas).map((x) => x.accessToken)]) {
      assert.ok(!texto.includes(s), "um segredo (token do cliente, de acesso ou de consulta) apareceu no que o comando mostrou");
    }
    assert.ok(!texto.includes("sk-ant-"), "um token de acesso apareceu no que o comando mostrou");
  };

  const cli = async (args, deps = {}) => {
    const saida = [];
    const erros = [];
    const codigo = await main(["--dir", dir, "--pasta-claude", pastaClaude, "--nome", "cliente-cli", "--log", "debug", ...args], {
      env: {},
      saida: (x) => void saida.push(String(x)),
      erroSaida: (x) => void erros.push(String(x)),
      agora: () => relogio.t,
      espera: async (ms) => void esperas.push(ms),
      entrada: Readable.from([]),
      ...deps,
    });
    const r = { codigo, saida, erros, texto: [...saida, ...erros].join("\n") };
    semSegredos(r.texto);
    return r;
  };

  const arquivo = (nome) => path.join(dir, nome);
  const ler = (nome) => JSON.parse(fs.readFileSync(arquivo(nome), "utf8"));
  const lerCredencial = () => {
    try {
      return JSON.parse(fs.readFileSync(path.join(pastaClaude, ".credentials.json"), "utf8"));
    } catch {
      return null;
    }
  };
  const rotas = () => servidor.chamadas.map((x) => `${x.metodo} ${x.caminho}`);
  const corpos = (metodo, caminho) => servidor.chamadas.filter((x) => x.metodo === metodo && x.caminho === caminho).map((x) => x.corpo);
  return { servidor, dir, pastaClaude, relogio, esperas, segredos, semSegredos, cli, arquivo, ler, lerCredencial, rotas, corpos };
}

/** Código de conexão com o código de pareamento errado (o servidor recusa). */
function codigoErrado(servidor) {
  return "swapplus1:" + Buffer.from(JSON.stringify({ url: servidor.url, code: "ERRADO2345", fp: null })).toString("base64url");
}

/** Log que guarda o que o cliente registrou. */
function logGuardado() {
  const linhas = [];
  const guardar = (nivel) => (texto) => void linhas.push(`${nivel}: ${texto}`);
  return { linhas, debug: guardar("debug"), info: guardar("info"), warn: guardar("warn"), error: guardar("error") };
}

// ------------------------------------------------------------------ ajuda, versão, uso errado

test("ajuda (também sem comando, -h, --help): mostra o uso com todos os comandos e opções, sai com 0", async (t) => {
  const c = await cenario(t);
  for (const args of [["ajuda"], [], ["--help"], ["-h"], ["help"], ["status", "--help"]]) {
    const r = await c.cli(args);
    assert.equal(r.codigo, 0, JSON.stringify(args));
    assert.deepEqual(r.erros, []);
    assert.equal(r.saida.length, 1);
    assert.match(r.saida[0], /Uso: swap-plus-cliente <comando>/);
    for (const comando of ["conectar", "entrar", "rodar", "uma-vez", "status", "saude", "trocar", "limite", "desconectar", "ajuda"]) {
      assert.match(r.saida[0], new RegExp(`^  ${comando}( |$)`, "m"), `a ajuda fala de "${comando}"`);
    }
    for (const opcao of ["--dir", "--pasta-claude", "--presenca", "--modelos", "--nome", "--url", "--substituir-login", "--pasta-padrao", "--json"]) {
      assert.ok(r.saida[0].includes(opcao), `a ajuda fala de ${opcao}`);
    }
  }
  assert.equal(c.servidor.chamadas.length, 0);
  assert.deepEqual(fs.readdirSync(c.dir), [], "a ajuda não cria nada");
});

test("versao: mostra a versão do pacote", async (t) => {
  const c = await cenario(t);
  const r = await c.cli(["versao"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida, [VERSAO]);
  assert.equal(VERSAO, require("../package.json").version);
  assert.match(VERSAO, /^\d+\.\d+\.\d+/);
});

// src/cli.js trata o comando "--version" (linha 165), mas lerArgumentos recusa antes qualquer "--algo" que não
// conhece (linha 67): hoje sai "Opção desconhecida: --version" com código 2.
test("--version: mostra a versão do pacote", async (t) => {
  const c = await cenario(t);
  const r = await c.cli(["--version"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida, [VERSAO]);
});

test("comando desconhecido, opção desconhecida ou opção sem valor: explica e sai com 2, sem tocar em nada", async (t) => {
  const c = await cenario(t);
  const casos = [
    [["dancar"], /Comando desconhecido: dancar/],
    [["status", "--inventada"], /Opção desconhecida: --inventada/],
    [["--inventada=1", "status"], /Opção desconhecida: --inventada=1/],
    [["status", "--url"], /Falta o valor de --url/],
  ];
  for (const [args, mensagem] of casos) {
    const r = await c.cli(args);
    assert.equal(r.codigo, 2, JSON.stringify(args));
    assert.deepEqual(r.saida, []);
    assert.equal(r.erros.length, 1);
    assert.match(r.erros[0], mensagem);
  }
  assert.equal(c.servidor.chamadas.length, 0);
  assert.deepEqual(fs.readdirSync(c.dir), []);
});

test("configuração inválida (presença, pasta de login igual à de dados, pasta padrão do Claude Code): sai com 2 antes de qualquer coisa", async (t) => {
  const c = await cenario(t);
  const casos = [
    [["status", "--presenca", "nunca"], /Presença inválida/],
    [["status", "--pasta-claude", c.dir], /não pode ser a própria pasta de dados/],
    // "status" só lê a pasta de dados: mesmo que a recusa falhasse, nada tocaria em ~/.claude.
    [["status", "--pasta-claude", "~/.claude"], /SWAP_PLUS_PASTA_PADRAO/],
  ];
  for (const [args, mensagem] of casos) {
    const r = await c.cli(args);
    assert.equal(r.codigo, 2, JSON.stringify(args));
    assert.deepEqual(r.saida, []);
    assert.match(r.erros.join("\n"), mensagem);
  }
  assert.equal(c.servidor.chamadas.length, 0);
  assert.deepEqual(fs.readdirSync(c.dir), []);
});

test("lerArgumentos: --opcao valor e --opcao=valor, chaves, comando e argumentos", () => {
  assert.deepEqual(lerArgumentos([]), { op: {}, comando: "ajuda", args: [] });
  assert.deepEqual(lerArgumentos(["trocar", "2"]), { op: {}, comando: "trocar", args: ["2"] });
  assert.deepEqual(lerArgumentos(["--dir", "/d", "status", "--json"]), { op: { dir: "/d", json: true }, comando: "status", args: [] });
  assert.deepEqual(lerArgumentos(["--dir=/d", "--pasta-claude=/c", "--presenca=sempre", "--modelos=claude-a,claude-b", "--nome=meu nome", "--url=https://x.exemplo.com/?a=b", "--log=debug", "rodar"]), {
    op: { dir: "/d", pastaClaude: "/c", presenca: "sempre", modelos: "claude-a,claude-b", nome: "meu nome", url: "https://x.exemplo.com/?a=b", log: "debug" },
    comando: "rodar",
    args: [],
  });
  assert.deepEqual(lerArgumentos(["conectar", "-", "--substituir-login", "--pasta-padrao"]), { op: { substituirLogin: true, pastaPadrao: true }, comando: "conectar", args: ["-"] });
  assert.deepEqual(lerArgumentos(["limite", "limite", "da", "sessão"]), { op: {}, comando: "limite", args: ["limite", "da", "sessão"] });
  assert.equal(lerArgumentos(["status", "-h"]).comando, "ajuda");
  assert.throws(() => lerArgumentos(["--nao-existe"]), { code: "uso" });
  assert.throws(() => lerArgumentos(["status", "--dir"]), { code: "uso" });
});

// ------------------------------------------------------------------ conectar

test("conectar <código>: pareia, guarda a conexão (0600), grava o login do Claude Code e sai com 0", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  const r = await c.cli(["conectar", servidor.codigoDeConexao()]);

  assert.equal(r.codigo, 0);
  assert.deepEqual(r.erros, []);
  assert.ok(r.saida.includes(`Conectado a ${servidor.url} como "cliente-cli".`));
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}em dia/, "termina mostrando a situação");
  assert.match(r.saida[r.saida.length - 1], /Conta: {5}1 · conta1@exemplo\.com · Max/);

  assert.deepEqual(c.corpos("POST", "/v1/pair"), [{ code: servidor.codigo, name: "cliente-cli", platform: process.platform }]);
  assert.deepEqual(c.rotas(), ["POST /v1/pair", "POST /v1/heartbeat", "GET /v1/credential"]);
  assert.equal(servidor.chamadas[0].autenticado, false);
  assert.equal(servidor.chamadas[1].autenticado, true);

  assert.deepEqual(c.ler("conexao.json"), { versao: 1, url: servidor.url, fp: null, deviceId: servidor.deviceId, token: servidor.token, nome: "cliente-cli", via: "codigo", conectadoEm: c.relogio.t });
  if (POSIX) {
    assert.equal(fs.statSync(c.arquivo("conexao.json")).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.join(c.pastaClaude, ".credentials.json")).mode & 0o777, 0o600);
  }
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.ok(!("refreshToken" in c.lerCredencial().claudeAiOauth));
  assert.equal(JSON.parse(fs.readFileSync(path.join(c.pastaClaude, ".claude.json"), "utf8")).oauthAccount.emailAddress, "conta1@exemplo.com");
  assert.equal(c.ler("situacao.json").estado, "ok");
  assert.equal(c.ler("aplicado.json").number, 1);
  assert.ok(!fs.readFileSync(c.arquivo("situacao.json"), "utf8").includes(servidor.token), "a situação gravada não tem o token");
});

// src/cli.js linha 182 só chama lib.setUserAgent "se existir". Quando este teste foi escrito, plus/serverClient.js
// tinha a função (ainda sem commit) e o teste passava; durante a mesma sessão o arquivo voltou a ser o do último
// commit, sem ela: o cliente passa a sair como "SwapPlus-VSCode/<versão da extensão>", sem erro nem aviso.
// Com a função de volta em plus/serverClient.js este teste passa: é só tirar o `todo`.
// A biblioteca da extensão (plus/serverClient.js) fica como está, a pedido do dono: o cliente não muda nada nela.
// Por isso ele vai com o User-Agent dela. Se um dia ela oferecer setUserAgent, o cli.js passa a se apresentar
// como SwapPlus-Cliente/<versão> (a chamada já está lá, condicionada a existir).
test("toda chamada ao servidor leva um User-Agent SwapPlus- (o servidor fica atrás da Cloudflare, que recusa cliente sem ele)", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  await c.cli(["uma-vez"]);
  await c.cli(["desconectar"]);
  assert.deepEqual(c.rotas(), ["POST /v1/pair", "POST /v1/heartbeat", "GET /v1/credential", "POST /v1/heartbeat", `DELETE /v1/devices/${c.servidor.deviceId}`]);
  for (const chamada of c.servidor.chamadas) assert.match(String(chamada.ua), /^SwapPlus-/, `${chamada.metodo} ${chamada.caminho}`);
});

test("conectar cria a pasta de dados que ainda não existe, só para o dono", async (t) => {
  const c = await cenario(t);
  const dados = path.join(c.dir, "ainda", "nao-existe");
  const r = await c.cli(["conectar", c.servidor.codigoDeConexao(), "--dir", dados, "--pasta-claude", path.join(dados, "claude")]);
  assert.equal(r.codigo, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dados, "conexao.json"), "utf8")).deviceId, c.servidor.deviceId);
  assert.ok(fs.existsSync(path.join(dados, "claude", ".credentials.json")));
  if (POSIX) assert.equal(fs.statSync(dados).mode & 0o777, 0o700);
});

test('conectar sem o código, ou com "-": lê o código da entrada (inteira, em pedaços, texto ou bytes)', async (t) => {
  const c = await cenario(t);
  const codigo = c.servidor.codigoDeConexao();

  let r = await c.cli(["conectar"], { entrada: Readable.from([codigo + "\n"]) });
  assert.equal(r.codigo, 0);
  assert.equal(c.ler("conexao.json").token, c.servidor.token);

  async function* emPedacos() {
    yield Buffer.from(codigo.slice(0, 14));
    yield codigo.slice(14, 40);
    yield Buffer.from(codigo.slice(40) + "\r\n");
  }
  fs.rmSync(c.arquivo("conexao.json"));
  r = await c.cli(["conectar", "-"], { entrada: emPedacos() });
  assert.equal(r.codigo, 0);
  assert.equal(c.ler("conexao.json").token, c.servidor.token);
  assert.equal(c.servidor.chamadas.filter((x) => x.caminho === "/v1/pair").length, 2);
});

test("conectar sem código nenhum (argumento e entrada vazios): explica e sai com 2", async (t) => {
  const c = await cenario(t);
  for (const entrada of [Readable.from([]), Readable.from(["  \n"])]) {
    const r = await c.cli(["conectar"], { entrada });
    assert.equal(r.codigo, 2);
    assert.match(r.erros.join("\n"), /Faltou o código de conexão/);
  }
  assert.equal(c.servidor.chamadas.length, 0);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);
});

test("conectar com código recusado pelo servidor, ou que nem é um código: sai com 1 e nada fica guardado", async (t) => {
  const c = await cenario(t);
  let r = await c.cli(["conectar", codigoErrado(c.servidor)]);
  assert.equal(r.codigo, 1);
  assert.match(r.erros.join("\n"), /Não deu certo: Código inválido ou vencido\. \[bad_code\]/);
  assert.deepEqual(c.rotas(), ["POST /v1/pair"]);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);
  assert.equal(c.lerCredencial(), null);
  assert.ok(!r.texto.includes("Conectado a"));

  r = await c.cli(["conectar", "isto-nao-e-um-codigo"]);
  assert.equal(r.codigo, 1);
  assert.match(r.erros.join("\n"), /\[bad_connect_code\]/);
  assert.equal(c.servidor.chamadas.length, 1, "código que nem é um código não chega ao servidor");
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);

  // http:// fora do próprio computador: o token passaria sem criptografia.
  const inseguro = "swapplus1:" + Buffer.from(JSON.stringify({ url: "http://servidor.exemplo.com", code: "ABCDEFGH23", fp: null })).toString("base64url");
  r = await c.cli(["conectar", inseguro]);
  assert.equal(r.codigo, 1);
  assert.match(r.erros.join("\n"), /\[bad_url\]/);
  assert.equal(c.servidor.chamadas.length, 1);
});

test("conectar num servidor sem conta para este cliente: conecta, avisa que não há conta e sai com 0", async (t) => {
  const c = await cenario(t);
  c.servidor.atribuida = null;
  const r = await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  assert.equal(r.codigo, 0);
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}sem conta/);
  assert.equal(c.ler("conexao.json").deviceId, c.servidor.deviceId);
  assert.equal(c.lerCredencial(), null);
});

test("conectar de novo: revoga no servidor o acesso anterior quando o id do cliente mudou, e grava o login pela conexão nova", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);
  const antigo = servidor.deviceId;

  servidor.deviceId = "dev-novo-0123456789";
  c.relogio.t += MIN;
  const r = await c.cli(["conectar", servidor.codigoDeConexao()]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(servidor.revogados, [antigo]);
  const rotas = c.rotas();
  assert.deepEqual(rotas.slice(3), ["POST /v1/pair", `DELETE /v1/devices/${antigo}`, "POST /v1/heartbeat", "GET /v1/credential"], "revoga só depois de o pareamento novo dar certo");
  assert.equal(servidor.chamadas[4].autenticado, true);
  assert.equal(c.ler("conexao.json").deviceId, "dev-novo-0123456789");
  assert.equal(c.ler("conexao.json").conectadoEm, c.relogio.t);
});

test("conectar de novo com o mesmo id: nada a revogar; código recusado: a conexão anterior fica como estava", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);
  const antes = fs.readFileSync(c.arquivo("conexao.json"), "utf8");

  let r = await c.cli(["conectar", codigoErrado(servidor)]);
  assert.equal(r.codigo, 1);
  assert.deepEqual(servidor.revogados, []);
  assert.equal(fs.readFileSync(c.arquivo("conexao.json"), "utf8"), antes);

  r = await c.cli(["conectar", servidor.codigoDeConexao()]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(servidor.revogados, [], "o servidor devolveu o mesmo id: o cliente não revoga a si mesmo");
  assert.equal(c.rotas().filter((x) => x.startsWith("DELETE")).length, 0);
});

test("opções pelo ambiente (deps.env): SWAP_PLUS_CLIENTE_DIR, SWAP_PLUS_CLAUDE_DIR e SWAP_PLUS_NOME valem sem as opções", async (t) => {
  const c = await cenario(t);
  const saida = [];
  const erros = [];
  const codigo = await main(["conectar", c.servidor.codigoDeConexao()], {
    env: { SWAP_PLUS_CLIENTE_DIR: c.dir, SWAP_PLUS_CLAUDE_DIR: c.pastaClaude, SWAP_PLUS_NOME: "nome-do-ambiente", SWAP_PLUS_LOG: "quieto" },
    saida: (x) => void saida.push(String(x)),
    erroSaida: (x) => void erros.push(String(x)),
    agora: () => c.relogio.t,
    espera: async () => {},
    entrada: Readable.from([]),
  });
  assert.equal(codigo, 0);
  assert.deepEqual(erros, []);
  assert.equal(c.ler("conexao.json").nome, "nome-do-ambiente");
  assert.equal(c.servidor.pareado.name, "nome-do-ambiente");
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, c.servidor.contas[1].accessToken);
  assert.equal(saida.length, 2, 'com o log "quieto" só aparecem a confirmação e a situação');
  c.semSegredos([...saida, ...erros].join("\n"));
});

// ------------------------------------------------------------------ entrar (login com Google)

test("entrar --url: mostra o endereço para abrir no navegador, consulta até o servidor liberar e conecta", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  servidor.google = { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789", respostas: [{ status: "pending" }, { status: "ok" }] };
  c.segredos.push(servidor.google.pollToken);

  const r = await c.cli(["entrar", "--url", servidor.url]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.erros, []);
  const authUrl = `${servidor.url}/auth/google/start?s=sessao-0123456789`;
  const iEndereco = r.saida.findIndex((x) => x.includes(authUrl));
  const iConectado = r.saida.indexOf(`Conectado a ${servidor.url} como "cliente-cli".`);
  assert.ok(iEndereco >= 0, "mostra o endereço");
  assert.match(r.saida[iEndereco], /Abra este endereço no navegador/);
  assert.ok(iConectado > iEndereco, "só diz que conectou depois");
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}em dia/);

  assert.deepEqual(c.corpos("POST", "/v1/login/start"), [{ name: "cliente-cli", platform: process.platform, caps: ["name_taken"] }]);
  assert.deepEqual(c.corpos("POST", "/v1/login/poll"), [
    { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789" },
    { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789" },
  ]);
  assert.deepEqual(c.esperas, [2000], "entre uma consulta e outra, 2 s");
  assert.deepEqual(c.ler("conexao.json"), { versao: 1, url: servidor.url, fp: null, deviceId: servidor.deviceId, token: servidor.token, nome: "cliente-cli", via: "google", conectadoEm: c.relogio.t });
  if (POSIX) assert.equal(fs.statSync(c.arquivo("conexao.json")).mode & 0o777, 0o600);
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("entrar com o endereço em SWAP_PLUS_URL", async (t) => {
  const c = await cenario(t);
  c.servidor.google = { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789", respostas: [{ status: "ok" }] };
  c.segredos.push(c.servidor.google.pollToken);
  const r = await c.cli(["entrar"], { env: { SWAP_PLUS_URL: c.servidor.url } });
  assert.equal(r.codigo, 0);
  assert.equal(c.ler("conexao.json").via, "google");
});

test("entrar: conta Google não liberada → sai com 1, diz qual conta e nada fica guardado", async (t) => {
  const c = await cenario(t);
  c.servidor.google = { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789", respostas: [{ status: "pending" }, { status: "denied", email: "fulano@gmail.com" }] };
  c.segredos.push(c.servidor.google.pollToken);
  const r = await c.cli(["entrar", "--url", c.servidor.url]);
  assert.equal(r.codigo, 1);
  assert.match(r.erros.join("\n"), /fulano@gmail\.com não está liberada neste servidor/);
  assert.match(r.erros.join("\n"), /\[google_negado\]/);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);
  assert.equal(c.lerCredencial(), null);
  assert.ok(!r.texto.includes("Conectado a"));
});

test("entrar: login com Google desligado no servidor → sai com 1 e indica o código de conexão", async (t) => {
  const c = await cenario(t);
  c.servidor.google = null;
  const r = await c.cli(["entrar", "--url", c.servidor.url]);
  assert.equal(r.codigo, 1);
  assert.match(r.erros.join("\n"), /login com Google está desligado neste servidor/);
  assert.match(r.erros.join("\n"), /código de conexão \(swap-plus-cliente conectar\)/);
  assert.deepEqual(c.rotas(), ["POST /v1/login/start"]);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);
});

test("entrar: o tempo do login acabou no servidor → sai com 1; sem o endereço do servidor → explica e não sai com 0", async (t) => {
  const c = await cenario(t);
  c.servidor.google = { sessionId: "sessao-0123456789", pollToken: "consulta-SEGREDO-0123456789", respostas: [{ status: "expired" }] };
  c.segredos.push(c.servidor.google.pollToken);
  let r = await c.cli(["entrar", "--url", c.servidor.url]);
  assert.equal(r.codigo, 1);
  assert.match(r.erros.join("\n"), /O tempo para entrar acabou/);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);

  const antes = c.servidor.chamadas.length;
  r = await c.cli(["entrar"]);
  assert.notEqual(r.codigo, 0);
  assert.match(r.erros.join("\n"), /Diga o endereço do servidor: --url/);
  assert.equal(c.servidor.chamadas.length, antes);
});

// ------------------------------------------------------------------ status, uma-vez, saude

test("status antes de conectar e antes de rodar: diz o que falta e sai com 1; --json também", async (t) => {
  const c = await cenario(t);
  let r = await c.cli(["status"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida.join("\n"), /ainda não foi conectado ao servidor.*conectar/);
  r = await c.cli(["status", "--json"]);
  assert.equal(r.codigo, 1);
  assert.deepEqual(JSON.parse(r.saida.join("\n")), { estado: "desconectado" });

  // Conectado (conexão guardada), mas nenhum ciclo rodou ainda.
  await new Estado(c.dir).gravarConexao({ url: c.servidor.url, fp: null, deviceId: c.servidor.deviceId, token: c.servidor.token, nome: "cliente-cli", via: "codigo", conectadoEm: c.relogio.t });
  r = await c.cli(["status"]);
  assert.equal(r.codigo, 1);
  assert.ok(r.saida.join("\n").includes(`Conectado a ${c.servidor.url}, mas o cliente ainda não rodou`));
  r = await c.cli(["status", "--json"]);
  assert.equal(r.codigo, 1);
  assert.deepEqual(JSON.parse(r.saida.join("\n")), { estado: "nunca_rodou" });
  assert.equal(c.servidor.chamadas.length, 0, "status não fala com o servidor");
});

test("uma-vez e depois status: em dia, sai com 0; --json é um JSON válido e sem segredos", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);
  const chamadasAntes = servidor.chamadas.length;

  c.relogio.t += 10 * SEG;
  let r = await c.cli(["uma-vez"]);
  assert.equal(r.codigo, 0);
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}em dia/);
  assert.equal(servidor.chamadas.length, chamadasAntes + 1, "um ciclo forçado: um batimento (o login já estava em dia)");

  c.relogio.t += 20 * SEG;
  const chamadas = servidor.chamadas.length;
  r = await c.cli(["status"]);
  assert.equal(r.codigo, 0);
  assert.equal(r.saida.length, 1);
  const texto = r.saida[0];
  assert.match(texto, /^Situação: {2}em dia$/m);
  assert.ok(texto.includes(`Servidor:  ${servidor.url}  (este cliente: cliente-cli)`));
  assert.match(texto, /^Conta: {5}1 · conta1@exemplo\.com · Max$/m);
  assert.match(texto, /^Acesso: {4}válido até \d\d\/\d\d \d\d:\d\d \(faltam \d+ min\)$/m);
  assert.match(texto, /^Presença: {2}ativo \(modo auto\)$/m);
  assert.ok(texto.includes(`Login em:  ${c.pastaClaude}`));
  assert.match(texto, /^Conferido: .*\(há 20 s\)$/m);

  r = await c.cli(["status", "--json"]);
  assert.equal(r.codigo, 0);
  assert.equal(r.saida.length, 1);
  const json = JSON.parse(r.saida[0]);
  assert.equal(json.estado, "ok");
  assert.equal(json.servidor, servidor.url);
  assert.equal(json.cliente, "cliente-cli");
  assert.equal(json.pastaClaude, c.pastaClaude);
  assert.deepEqual(json.conta, { numero: 1, email: "conta1@exemplo.com", apelido: null, plano: "Max" });
  assert.equal(json.acessoExpiraEm, servidor.contas[1].expiresAt);
  assert.equal(json.em, c.relogio.t - 20 * SEG);
  assert.equal(json.versao, VERSAO);
  assert.ok(!("token" in json) && !("accessToken" in json));
  assert.ok(!r.saida[0].includes(servidor.token) && !r.saida[0].includes(servidor.contas[1].accessToken), "nenhum segredo no JSON");
  assert.equal(servidor.chamadas.length, chamadas, "status não fala com o servidor");
});

test("uma-vez --json: a última coisa mostrada é a situação em JSON", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  const r = await c.cli(["uma-vez", "--json"]);
  assert.equal(r.codigo, 0);
  const json = JSON.parse(r.saida[r.saida.length - 1]);
  assert.equal(json.estado, "ok");
  assert.equal(json.conta.numero, 1);
});

test("uma-vez sem conexão, sem conta ou com o servidor fora do ar: sai com 1, e o status passa a dizer o mesmo", async (t) => {
  const c = await cenario(t);
  let r = await c.cli(["uma-vez"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}não conectado/);
  assert.equal(c.servidor.chamadas.length, 0);
  assert.equal((await c.cli(["status"])).codigo, 1);

  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  c.servidor.atribuida = null;
  r = await c.cli(["uma-vez"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}sem conta/);
  r = await c.cli(["status"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[0], /^Situação: {2}sem conta/);

  c.servidor.foraDoAr = true;
  r = await c.cli(["uma-vez"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}sem contato com o servidor/);
  assert.deepEqual(c.esperas, [2000], "uma segunda tentativa antes de desistir");
  r = await c.cli(["status", "--json"]);
  assert.equal(r.codigo, 1);
  assert.equal(JSON.parse(r.saida[0]).estado, "offline");
});

test('saude: "ok" (0) logo depois de um ciclo em dia; "problema" (1) quando a situação tem mais de 3 min', async (t) => {
  const c = await cenario(t);
  let r = await c.cli(["saude"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[0], /^problema: sem situação gravada/);

  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  r = await c.cli(["uma-vez"]);
  assert.equal(r.codigo, 0);
  const chamadas = c.servidor.chamadas.length;

  r = await c.cli(["saude"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida, ["ok"]);
  assert.deepEqual(r.erros, []);

  c.relogio.t += 3 * MIN;
  r = await c.cli(["saude"]);
  assert.equal(r.codigo, 0, "exatamente 3 min ainda vale");

  c.relogio.t += 1;
  r = await c.cli(["saude"]);
  assert.equal(r.codigo, 1);
  assert.equal(r.saida.length, 1);
  assert.match(r.saida[0], /^problema: a situação está velha: o cliente não está rodando$/);
  assert.equal(c.servidor.chamadas.length, chamadas, "saude não fala com o servidor");

  // Um ciclo novo e volta a estar em dia.
  await c.cli(["uma-vez"]);
  r = await c.cli(["saude"]);
  assert.equal(r.codigo, 0);
});

test("saude quando a situação não é em dia (sem conta, sem contato com o servidor): problema, com o motivo", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);

  c.servidor.atribuida = null;
  await c.cli(["uma-vez"]);
  let r = await c.cli(["saude"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[0], /^problema: sem conta: /);

  c.servidor.atribuida = 1;
  await c.cli(["uma-vez"]);
  assert.equal((await c.cli(["saude"])).codigo, 0);

  c.servidor.foraDoAr = true;
  await c.cli(["uma-vez"]);
  r = await c.cli(["saude"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[0], /^problema: sem contato com o servidor: /);
});

test("saude: acesso gravado que vence em menos de 2 min é problema, mesmo com a situação recente e em dia", async (t) => {
  const c = await cenario(t);
  c.servidor.contas[1].expiresAt = c.relogio.t + 4 * MIN; // ainda válido pelo relógio de verdade
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);

  let r = await c.cli(["saude"]);
  assert.equal(r.codigo, 0);

  c.relogio.t += 2 * MIN; // faltam exatamente 2 min
  r = await c.cli(["saude"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[0], /^problema: o acesso gravado está vencido ou vence em menos de 2 min$/);
});

test("saudavel e descrever (funções puras): limites de tempo e o que aparece no texto", () => {
  const agora = 1_800_000_000_000;
  const ok = { em: agora, estado: "ok", mensagem: null, acessoExpiraEm: agora + 60 * MIN, presenca: { modo: "sempre", ativo: true }, pastaClaude: "/login", servidor: "https://s.exemplo.com", cliente: "c1", conta: { numero: 3, apelido: "reserva", email: "a@x.com", plano: "Max" }, avisos: ["o login vence amanhã"] };
  assert.deepEqual(saudavel(ok, agora), { ok: true, motivo: "em dia" });
  assert.equal(saudavel(null, agora).ok, false);
  assert.equal(saudavel(ok, agora + 3 * MIN).ok, true);
  assert.equal(saudavel(ok, agora + 3 * MIN + 1).ok, false);
  assert.equal(saudavel({ ...ok, em: undefined }, agora).ok, false, "situação sem hora conta como velha");
  assert.equal(saudavel({ ...ok, estado: "pendente", mensagem: "gravação falhou" }, agora).motivo, "credencial ainda não gravada: gravação falhou");
  assert.equal(saudavel({ ...ok, estado: "bloqueado" }, agora).ok, false);
  assert.equal(saudavel({ ...ok, acessoExpiraEm: agora + 2 * MIN + 1 }, agora).ok, true);
  assert.equal(saudavel({ ...ok, acessoExpiraEm: agora + 2 * MIN }, agora).ok, false);
  assert.equal(saudavel({ ...ok, acessoExpiraEm: null }, agora).ok, false);

  const texto = descrever(ok, agora + 30 * SEG);
  assert.match(texto, /^Situação: {2}em dia$/m);
  assert.match(texto, /^Servidor: {2}https:\/\/s\.exemplo\.com {2}\(este cliente: c1\)$/m);
  assert.match(texto, /^Conta: {5}3 \(reserva\) · a@x\.com · Max$/m);
  assert.match(texto, /\(faltam 60 min\)$/m);
  assert.match(texto, /^Presença: {2}ativo \(modo sempre\)$/m);
  assert.match(texto, /^Login em: {2}\/login$/m);
  assert.match(texto, /\(há 30 s\)$/m);
  assert.match(texto, /^Aviso: {5}o login vence amanhã$/m);

  const vencido = descrever({ ...ok, estado: "offline", mensagem: "O servidor recusou a conexão.", conta: null, acessoExpiraEm: agora - MIN, presenca: { modo: "auto", ativo: false }, avisos: [] }, agora);
  assert.match(vencido, /^Situação: {2}sem contato com o servidor — O servidor recusou a conexão\.$/m);
  assert.match(vencido, /\(VENCIDO\)$/m);
  assert.match(vencido, /^Presença: {2}parado \(modo auto\)$/m);
  assert.ok(!/^Conta:/m.test(vencido));
});

// ------------------------------------------------------------------ trocar, limite

test("trocar 2: pede a conta 2 ao servidor, grava o login dela e sai com 0; sem número pede a melhor", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);

  let r = await c.cli(["trocar", "2"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(c.corpos("POST", "/v1/switch"), [{ number: 2 }]);
  assert.match(r.saida[r.saida.length - 1], /^Conta: {5}2 · conta2@exemplo\.com/m);
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);
  assert.equal(c.ler("situacao.json").conta.numero, 2);

  servidor.melhorConta = 1;
  r = await c.cli(["trocar"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(c.corpos("POST", "/v1/switch"), [{ number: 2 }, { number: null }]);
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("trocar abc (ou 0, negativo, quebrado): sai com 2 sem falar com o servidor; trocar sem conexão: sai com 1", async (t) => {
  const c = await cenario(t);
  let r = await c.cli(["trocar", "2"]);
  assert.equal(r.codigo, 1);
  assert.match(r.saida[r.saida.length - 1], /^Situação: {2}não conectado/);
  assert.equal(c.servidor.chamadas.length, 0);

  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  const antes = c.servidor.chamadas.length;
  for (const n of ["abc", "0", "-1", "1.5", "2x"]) {
    r = await c.cli(["trocar", n]);
    assert.equal(r.codigo, 2, `trocar ${n}`);
    assert.match(r.erros.join("\n"), /Diga o número da conta/);
    assert.deepEqual(r.saida, []);
  }
  assert.equal(c.servidor.chamadas.length, antes);
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, c.servidor.contas[1].accessToken);
});

test("limite: avisa o servidor (POST /v1/events) e conta se ele trocou de conta", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);

  let r = await c.cli(["limite"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(c.corpos("POST", "/v1/events"), [{ kind: "limit_hit", label: "limite de uso" }]);
  assert.ok(r.saida.includes("O servidor não trocou de conta: nada a fazer"));
  assert.match(r.saida[r.saida.length - 1], /^Conta: {5}1 /m);

  servidor.aoLimite = () => {
    servidor.atribuida = 2;
    return { switched: true, text: "conta 1 no limite da sessão; agora na conta 2" };
  };
  r = await c.cli(["limite", "limite", "da", "sessão", "de", "5h"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(c.corpos("POST", "/v1/events")[1], { kind: "limit_hit", label: "limite da sessão de 5h" });
  assert.ok(r.saida.includes("O servidor trocou de conta: conta 1 no limite da sessão; agora na conta 2"));
  assert.match(r.saida[r.saida.length - 1], /^Conta: {5}2 /m);
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[2].accessToken);

  servidor.aoLimite = () => ({ switched: false });
  r = await c.cli(["limite"]);
  assert.ok(r.saida.includes("O servidor não trocou de conta."), "sem texto do servidor, a frase termina aí");
});

// ------------------------------------------------------------------ desconectar

test("desconectar: revoga no servidor, esquece a conexão e deixa o login do Claude Code onde está", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);
  const loginAntes = fs.readFileSync(path.join(c.pastaClaude, ".credentials.json"), "utf8");

  const r = await c.cli(["desconectar"]);
  assert.equal(r.codigo, 0);
  assert.deepEqual(r.erros, []);
  assert.deepEqual(r.saida, ["Desconectado: o servidor revogou este cliente.", `O login do Claude Code em ${c.pastaClaude} não foi apagado: ele deixa de ser renovado e vence sozinho em algumas horas.`]);
  assert.deepEqual(servidor.revogados, [servidor.deviceId]);
  const apagar = servidor.chamadas[servidor.chamadas.length - 1];
  assert.equal(`${apagar.metodo} ${apagar.caminho}`, `DELETE /v1/devices/${servidor.deviceId}`);
  assert.equal(apagar.autenticado, true);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false, "a conexão (com o token) é apagada");
  assert.equal(fs.existsSync(c.arquivo("aplicado.json")), false);
  assert.equal(fs.readFileSync(path.join(c.pastaClaude, ".credentials.json"), "utf8"), loginAntes, "o login do Claude Code fica como estava");
  assert.ok(fs.existsSync(path.join(c.pastaClaude, ".claude.json")));

  // Desconectado, um ciclo não fala mais com o servidor.
  const chamadas = servidor.chamadas.length;
  const depois = await c.cli(["uma-vez"]);
  assert.equal(depois.codigo, 1);
  assert.match(depois.saida[depois.saida.length - 1], /^Situação: {2}não conectado/);
  assert.equal(servidor.chamadas.length, chamadas);
});

test("desconectar sem estar conectado: avisa e sai com 0; com o servidor fora do ar: desconecta aqui e pede para revogar no painel", async (t) => {
  const c = await cenario(t);
  let r = await c.cli(["desconectar"]);
  assert.equal(r.codigo, 0);
  assert.equal(r.saida[0], "Este cliente não estava conectado.");
  assert.equal(c.servidor.chamadas.length, 0);

  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  c.servidor.foraDoAr = true;
  r = await c.cli(["desconectar"]);
  assert.equal(r.codigo, 0);
  assert.match(r.saida[0], /^Desconectado aqui\. \(Não consegui avisar o servidor: revogue este cliente no painel/);
  assert.deepEqual(c.servidor.revogados, []);
  assert.equal(fs.existsSync(c.arquivo("conexao.json")), false);
  assert.ok(c.lerCredencial(), "o login do Claude Code continua lá");
});

// "desconectar" (src/cli.js linha 306, src/conexao.js linha 97) apaga a conexão mas deixa o situacao.json do último
// ciclo; "status" (linha 272) e "saude" (linha 285) só olham esse arquivo: seguem dizendo "em dia" (saude, por 3 min).
test("depois de desconectar, status e saude não dizem mais que está em dia", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  assert.equal((await c.cli(["status"])).codigo, 0);
  await c.cli(["desconectar"]);

  const status = await c.cli(["status"]);
  assert.equal(status.codigo, 1);
  assert.ok(!/em dia/.test(status.texto));
  const saude = await c.cli(["saude"]);
  assert.equal(saude.codigo, 1);
});

// ------------------------------------------------------------------ rodar

test("rodar com o sinal de parada já disparado: não faz ciclo nenhum, solta a trava e sai com 0", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  const chamadas = c.servidor.chamadas.length;
  const sinais = [process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")];

  const r = await c.cli(["rodar"], { parar: AbortSignal.abort() });
  assert.equal(r.codigo, 0);
  assert.equal(c.servidor.chamadas.length, chamadas);
  assert.deepEqual(c.esperas, []);
  assert.match(r.saida[0], new RegExp(`Swap Plus Cliente ${VERSAO.replace(/\./g, "\\.")} — dados em `));
  assert.ok(r.saida[0].includes(c.dir) && r.saida[0].includes(c.pastaClaude));
  assert.match(r.saida[r.saida.length - 1], /encerrado\.$/);
  assert.equal(fs.existsSync(c.arquivo("rodando.json")), false, "a trava é solta na saída");
  assert.deepEqual([process.listenerCount("SIGINT"), process.listenerCount("SIGTERM")], sinais, "os tratadores de sinal são retirados");
});

test("rodar: primeiro ciclo forçado grava o login; a trava fica segura enquanto roda e é solta quando o sinal dispara", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await new Estado(c.dir).gravarConexao({ url: servidor.url, fp: null, deviceId: servidor.deviceId, token: servidor.token, nome: "cliente-cli", via: "codigo", conectadoEm: c.relogio.t });
  const controle = new AbortController();
  const esperas = [];
  let travaDurante = null;

  const r = await c.cli(["rodar"], {
    parar: controle.signal,
    espera: async (ms, parar) => {
      esperas.push([ms, parar]);
      travaDurante = c.ler("rodando.json");
      c.relogio.t += ms;
      if (esperas.length === 2) controle.abort();
    },
  });

  assert.equal(r.codigo, 0);
  assert.deepEqual(
    esperas.map((e) => e[0]),
    [30 * SEG, 30 * SEG]
  );
  assert.ok(esperas.every((e) => e[1] === controle.signal), "a espera recebe o sinal de parada");
  assert.deepEqual(c.rotas(), ["POST /v1/heartbeat", "GET /v1/credential"], "primeiro ciclo forçado; o segundo, parado, não chama");
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
  assert.equal(c.ler("situacao.json").estado, "ok");
  assert.equal(c.ler("situacao.json").versao, VERSAO);
  assert.equal(travaDurante.pid, process.pid);
  assert.equal(travaDurante.em, c.relogio.t - 30 * SEG, "a trava é renovada a cada ciclo");
  assert.equal(fs.existsSync(c.arquivo("rodando.json")), false);
  assert.match(r.saida.join("\n"), /em dia — conta 1/);
  assert.match(r.saida[r.saida.length - 1], /encerrado\.$/);
});

test("um segundo rodar na mesma pasta de dados é recusado (sai com 1) e não atrapalha o primeiro", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);

  // O primeiro fica parado na espera entre ciclos até o teste liberar.
  const controle = new AbortController();
  let chegouNaEspera;
  const naEspera = new Promise((r) => (chegouNaEspera = r));
  let liberar;
  const liberado = new Promise((r) => (liberar = r));
  const primeiro = c.cli(["rodar"], {
    parar: controle.signal,
    espera: async () => {
      chegouNaEspera();
      await liberado;
    },
  });
  await naEspera;
  const trava = fs.readFileSync(c.arquivo("rodando.json"), "utf8");

  const segundo = await c.cli(["rodar"], { parar: AbortSignal.abort() });
  assert.equal(segundo.codigo, 1);
  assert.match(segundo.erros.join("\n"), /Já há um cliente rodando com a pasta de dados/);
  assert.ok(segundo.erros.join("\n").includes(c.dir));
  assert.equal(fs.readFileSync(c.arquivo("rodando.json"), "utf8"), trava, "a trava do primeiro fica intacta");

  // Os outros comandos continuam valendo com o cliente rodando.
  assert.equal((await c.cli(["status"])).codigo, 0);
  assert.equal((await c.cli(["trocar", "2"])).codigo, 0);

  controle.abort();
  liberar();
  assert.equal((await primeiro).codigo, 0);
  assert.equal(fs.existsSync(c.arquivo("rodando.json")), false);

  // Solta a trava, outro rodar entra.
  const terceiro = await c.cli(["rodar"], { parar: AbortSignal.abort() });
  assert.equal(terceiro.codigo, 0);
});

test("rodar: outro cliente tomou a trava → este avisa e encerra, sem apagar a trava do outro", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  const doOutro = JSON.stringify({ id: "999999-aabbccddeeff", pid: 999999, em: c.relogio.t }) + "\n";
  const esperas = [];

  const r = await c.cli(["rodar"], {
    parar: new AbortController().signal, // nunca dispara: quem encerra é a trava perdida
    espera: async (ms) => {
      esperas.push(ms);
      assert.ok(esperas.length < 5, "o cliente deveria ter encerrado ao perder a trava");
      c.relogio.t += ms;
      if (esperas.length === 1) fs.writeFileSync(c.arquivo("rodando.json"), doOutro);
    },
  });

  assert.equal(r.codigo, 0);
  assert.deepEqual(esperas, [30 * SEG], "no ciclo seguinte à perda da trava, encerra sem esperar mais");
  assert.match(r.erros.join("\n"), /outro cliente assumiu esta pasta de dados; encerrando este\./);
  assert.equal(fs.readFileSync(c.arquivo("rodando.json"), "utf8"), doOutro);
});

test("rodar com uma trava velha (cliente que morreu há mais de 3 min): assume e roda", async (t) => {
  const c = await cenario(t);
  await c.cli(["conectar", c.servidor.codigoDeConexao()]);
  fs.writeFileSync(c.arquivo("rodando.json"), JSON.stringify({ id: "999999-aabbccddeeff", pid: 999999, em: c.relogio.t - 3 * MIN - 1 }) + "\n");
  const controle = new AbortController();

  const r = await c.cli(["rodar"], { parar: controle.signal, espera: async () => controle.abort() });
  assert.equal(r.codigo, 0);
  assert.match(r.saida[r.saida.length - 1], /encerrado\.$/);
  assert.equal(fs.existsSync(c.arquivo("rodando.json")), false);

  // Trava recente de outro cliente: recusado.
  fs.writeFileSync(c.arquivo("rodando.json"), JSON.stringify({ id: "999999-aabbccddeeff", pid: 999999, em: c.relogio.t - 3 * MIN }) + "\n");
  assert.equal((await c.cli(["rodar"], { parar: AbortSignal.abort() })).codigo, 1);
});

test("rodar começa sem conexão e passa a funcionar quando o conectar é feito, sem reiniciar", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  const controle = new AbortController();
  const situacoes = [];
  let conectou = null;

  const r = await c.cli(["rodar"], {
    parar: controle.signal,
    espera: async (ms) => {
      situacoes.push(c.ler("situacao.json").estado);
      c.relogio.t += ms;
      if (situacoes.length === 1) conectou = await c.cli(["conectar", servidor.codigoDeConexao()]); // "em outro terminal"
      if (situacoes.length === 3) controle.abort();
    },
  });

  assert.equal(r.codigo, 0);
  assert.equal(conectou.codigo, 0);
  assert.match(r.erros.join("\n"), /desconectado: Este cliente ainda não foi conectado ao servidor/);
  assert.deepEqual(situacoes, ["desconectado", "ok", "ok"], "o cliente que já estava rodando passa a usar a conexão nova no ciclo seguinte");
  assert.equal(c.ler("situacao.json").estado, "ok");
  assert.equal(c.lerCredencial().claudeAiOauth.accessToken, servidor.contas[1].accessToken);
});

test("rodar com deps.log: o log vai para quem foi passado, e nele não há segredo", async (t) => {
  const c = await cenario(t);
  const { servidor } = c;
  await c.cli(["conectar", servidor.codigoDeConexao()]);
  const log = logGuardado();
  const controle = new AbortController();
  let n = 0;

  const r = await c.cli(["rodar", "--presenca", "sempre"], {
    log,
    parar: controle.signal,
    espera: async (ms) => {
      c.relogio.t += ms;
      n += 1;
      if (n === 1) servidor.renovar(1);
      if (n === 2) servidor.atribuida = 2;
      if (n === 3) servidor.token = "token-que-o-servidor-nao-aceita-mais"; // 401
      if (n === 4) controle.abort();
    },
  });

  assert.equal(r.codigo, 0);
  assert.deepEqual(r.saida, [], "nada do log vai para a saída quando há um log próprio");
  assert.deepEqual(r.erros, []);
  const texto = log.linhas.join("\n");
  assert.match(texto, /^info: Swap Plus Cliente /m);
  assert.match(texto, /^info: conta trocada: agora na conta 2 \(antes 1\)/m);
  assert.match(texto, /^error: revogado: /m);
  assert.match(texto, /^info: encerrado\.$/m);
  assert.ok(c.ler("conexao.json").revogadoEm > 0, "o 401 fica registrado na conexão");
  const token = c.ler("conexao.json").token;
  assert.ok(!texto.includes(token), "o token do cliente não vai para o log");
  assert.ok(!texto.includes("sk-ant-"), "nenhum token de acesso vai para o log");
  for (const conta of Object.values(servidor.contas)) assert.ok(!texto.includes(conta.accessToken));
});

test("esperar (a espera de verdade do rodar): termina na hora quando o sinal dispara, sem deixar temporizador para trás", async () => {
  const t0 = Date.now();
  await esperar(60 * MIN, AbortSignal.abort());
  const controle = new AbortController();
  const p = esperar(60 * MIN, controle.signal);
  setImmediate(() => controle.abort());
  await p;
  await esperar(5);
  await esperar(5, new AbortController().signal);
  assert.ok(Date.now() - t0 < 5000, "nenhuma das esperas ficou até o fim do prazo");
});
