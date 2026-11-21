"use strict";
// Swap Plus Cliente — linha de comando. `main(argv, deps)` devolve o código de saída; `deps` troca, nos testes,
// o ambiente, a saída, a entrada e as bibliotecas.

const path = require("path");
const config = require("./config");
const { Estado } = require("./estado");
const { travar, garantirPasta } = require("./arquivos");
const { Cliente, hora } = require("./ciclo");
const conexao = require("./conexao");

const VERSAO = require("../package.json").version;

const AJUDA = `Swap Plus Cliente ${VERSAO} — mantém um login do Claude Code em dia a partir do servidor Swap Plus, sem VS Code.

Uso: swap-plus-cliente <comando> [opções]

  conectar [código]   conecta este cliente ao servidor com o código de conexão ("swapplus1:...").
                      Sem o código (ou com "-"), lê da entrada padrão: o código não fica no histórico do terminal.
  entrar              conecta com login do Google: mostra um endereço para abrir no navegador (--url do servidor)
  rodar               fica rodando e mantém o login em dia (é o que o serviço/contêiner executa)
  uma-vez             faz um ciclo e sai
  status [--json]     mostra a situação deste cliente
  saude               sai com 0 se o login está em dia (para monitor e healthcheck)
  trocar [n]          pede ao servidor a conta n (sem n: a melhor conta)
  limite [texto]      avisa o servidor que a conta bateu o limite
  desconectar         desfaz a conexão com o servidor
  versao              mostra a versão do cliente
  ajuda

Opções (ou a variável de ambiente entre parênteses):
  --dir <pasta>            pasta de dados do cliente            (SWAP_PLUS_CLIENTE_DIR; padrão ~/.swap-plus-cliente)
  --pasta-claude <pasta>   pasta de login do Claude Code        (SWAP_PLUS_CLAUDE_DIR; padrão <dados>/claude)
  --presenca auto|sempre   quando contar como ativo no servidor (SWAP_PLUS_PRESENCA; padrão auto)
  --modelos <ids>          modelos em uso, separados por vírgula (SWAP_PLUS_MODELOS)
  --nome <nome>            nome no painel do servidor            (SWAP_PLUS_NOME; padrão o nome da máquina)
  --url <endereço>         servidor, para "entrar"               (SWAP_PLUS_URL)
  --substituir-login       gravar por cima de um login feito à mão na pasta (SWAP_PLUS_SUBSTITUIR_LOGIN=1)
  --pasta-padrao           aceitar ~/.claude como pasta de login (SWAP_PLUS_PASTA_PADRAO=1)
  --log info|debug|quieto  quanto escrever no log               (SWAP_PLUS_LOG; padrão info)
  --json                   mostrar a situação em JSON

Quem usa o Claude Code por este cliente aponta para a pasta de login: CLAUDE_CONFIG_DIR=<pasta>, ou, no Hermes,
a configuração claude_config_dir do plugin claude-subscription-directsdk.`;

const OPCOES = {
  "--dir": "dir",
  "--pasta-claude": "pastaClaude",
  "--presenca": "presenca",
  "--modelos": "modelos",
  "--nome": "nome",
  "--url": "url",
  "--log": "log",
};
const CHAVES = { "--substituir-login": "substituirLogin", "--pasta-padrao": "pastaPadrao", "--json": "json" };

function lerArgumentos(argv) {
  const op = {};
  const resto = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const igual = a.startsWith("--") ? a.indexOf("=") : -1;
    const nome = igual > 0 ? a.slice(0, igual) : a;
    if (OPCOES[nome]) {
      const v = igual > 0 ? a.slice(igual + 1) : argv[++i];
      if (v === undefined) throw Object.assign(new Error(`Falta o valor de ${nome}.`), { code: "uso" });
      op[OPCOES[nome]] = v;
    } else if (CHAVES[nome]) op[CHAVES[nome]] = true;
    else if (a === "-h" || a === "--help") resto.unshift("ajuda");
    else if (a === "--version" || a === "--versao") resto.unshift("versao");
    else if (a.startsWith("--")) throw Object.assign(new Error(`Opção desconhecida: ${a}. Veja: swap-plus-cliente ajuda`), { code: "uso" });
    else resto.push(a);
  }
  return { op, comando: resto[0] || "ajuda", args: resto.slice(1) };
}

function criarLog(nivel, saida, erroSaida) {
  const carimbo = () => {
    const d = new Date();
    const dois = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${dois(d.getMonth() + 1)}-${dois(d.getDate())} ${dois(d.getHours())}:${dois(d.getMinutes())}:${dois(d.getSeconds())}`;
  };
  const linha = (para, rotulo) => (texto) => para(`[${carimbo()}] ${rotulo}${texto}`);
  const nada = () => {};
  return {
    debug: nivel === "debug" ? linha(saida, "(detalhe) ") : nada,
    info: nivel === "quieto" ? nada : linha(saida, ""),
    warn: linha(erroSaida, "ATENÇÃO: "),
    error: linha(erroSaida, "ERRO: "),
  };
}

/** Espera que termina na hora se `parar` (AbortSignal) disparar. */
function esperar(ms, parar) {
  return new Promise((resolve) => {
    if (parar && parar.aborted) return resolve();
    const fim = () => {
      clearTimeout(timer);
      if (parar) parar.removeEventListener("abort", fim);
      resolve();
    };
    const timer = setTimeout(fim, ms);
    if (parar) parar.addEventListener("abort", fim, { once: true });
  });
}

async function lerEntrada(entrada) {
  const partes = [];
  for await (const p of entrada) partes.push(typeof p === "string" ? Buffer.from(p) : p);
  return Buffer.concat(partes).toString("utf8").trim();
}

const ESTADOS = {
  ok: "em dia",
  sem_conta: "sem conta",
  offline: "sem contato com o servidor",
  revogado: "acesso revogado",
  desconectado: "não conectado",
  bloqueado: "não pode gravar o login",
  pendente: "credencial ainda não gravada",
};

function descrever(s, agora) {
  const linhas = [];
  linhas.push(`Situação:  ${ESTADOS[s.estado] || s.estado}${s.mensagem ? ` — ${s.mensagem}` : ""}`);
  if (s.servidor) linhas.push(`Servidor:  ${s.servidor}  (este cliente: ${s.cliente})`);
  if (s.conta) {
    const c = s.conta;
    linhas.push(`Conta:     ${c.numero}${c.apelido ? ` (${c.apelido})` : ""}${c.email ? ` · ${c.email}` : ""}${c.plano ? ` · ${c.plano}` : ""}`);
  }
  if (s.acessoExpiraEm) {
    const min = Math.round((s.acessoExpiraEm - agora) / 60000);
    linhas.push(`Acesso:    válido até ${hora(s.acessoExpiraEm)} (${min > 0 ? `faltam ${min} min` : "VENCIDO"})`);
  }
  linhas.push(`Presença:  ${s.presenca && s.presenca.ativo ? "ativo" : "parado"} (modo ${s.presenca ? s.presenca.modo : "?"})`);
  linhas.push(`Login em:  ${s.pastaClaude}`);
  if (s.em) linhas.push(`Conferido: ${hora(s.em)} (há ${Math.max(0, Math.round((agora - s.em) / 1000))} s)`);
  for (const a of s.avisos || []) linhas.push(`Aviso:     ${a}`);
  return linhas.join("\n");
}

/** O login está em dia? situação recente (o cliente está rodando), estado ok e acesso com folga. */
function saudavel(s, agora) {
  if (!s) return { ok: false, motivo: "sem situação gravada: o cliente nunca rodou nesta pasta de dados" };
  if (agora - Number(s.em || 0) > 3 * 60 * 1000) return { ok: false, motivo: "a situação está velha: o cliente não está rodando" };
  if (s.estado !== "ok") return { ok: false, motivo: `${ESTADOS[s.estado] || s.estado}${s.mensagem ? `: ${s.mensagem}` : ""}` };
  if (!(Number(s.acessoExpiraEm) - agora > 2 * 60 * 1000)) return { ok: false, motivo: "o acesso gravado está vencido ou vence em menos de 2 min" };
  return { ok: true, motivo: "em dia" };
}

async function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const saida = deps.saida || ((t) => console.log(t));
  const erroSaida = deps.erroSaida || ((t) => console.error(t));
  const agora = deps.agora || Date.now;

  let lido;
  try {
    lido = lerArgumentos(argv);
  } catch (e) {
    erroSaida(e.message);
    return 2;
  }
  const { op, comando, args } = lido;
  if (comando === "ajuda" || comando === "help") {
    saida(AJUDA);
    return 0;
  }
  if (comando === "versao") {
    saida(VERSAO);
    return 0;
  }

  let cfg;
  try {
    cfg = config.resolver(op, env);
  } catch (e) {
    erroSaida(e.message);
    return 2;
  }
  // Daqui em diante o claudeAuth.js enxerga a pasta de login deste cliente. Vale sempre no ambiente do
  // processo (é onde o claudeAuth lê), mesmo quando a configuração veio de um `env` trocado nos testes.
  config.aplicarAmbiente(cfg);
  const lib = deps.lib || require("../../plus/serverClient");
  const auth = deps.auth || require("../../plus/claudeAuth");
  if (typeof lib.setUserAgent === "function") lib.setUserAgent(`SwapPlus-Cliente/${VERSAO}`);
  const estado = new Estado(cfg.dir);
  const log = deps.log || criarLog(cfg.logNivel, saida, erroSaida);
  const novoCliente = () =>
    new Cliente({
      cfg,
      estado,
      lib,
      auth,
      regras: deps.regras || require("../../plus/rules"),
      modelSwitch: deps.modelSwitch || require("../../plus/modelSwitch"),
      atividade: deps.atividade || require("./atividade"),
      agora,
      log,
      espera: deps.espera || esperar,
      versao: VERSAO,
    });
  const depsConexao = { lib, estado, cfg, agora, espera: deps.espera || esperar };
  const mostrar = (s) => saida(op.json ? JSON.stringify(s, null, 2) : descrever(s, agora()));

  try {
    switch (comando) {
      case "conectar": {
        let codigo = args[0];
        if (!codigo || codigo === "-") codigo = await lerEntrada(deps.entrada || process.stdin);
        if (!codigo) {
          erroSaida('Faltou o código de conexão ("swapplus1:..."). Passe como argumento ou pela entrada padrão.');
          return 2;
        }
        // O código pode vir no meio de um texto (a saída inteira do comando `pair` do servidor, encanada): só ele serve.
        const achado = /swapplus\d+:[A-Za-z0-9_\-+/]+={0,2}/i.exec(codigo);
        if (achado) codigo = achado[0];
        garantirPasta(cfg.dir);
        const con = await conexao.conectarPorCodigo(depsConexao, codigo);
        saida(`Conectado a ${con.url} como "${con.nome}".`);
        const s = await novoCliente().ciclo({ forcar: true });
        mostrar(s);
        return s.estado === "ok" || s.estado === "sem_conta" ? 0 : 1;
      }
      case "entrar": {
        garantirPasta(cfg.dir);
        const controle = new AbortController();
        const aoSinal = () => controle.abort();
        process.once("SIGINT", aoSinal);
        try {
          const con = await conexao.entrarComGoogle(depsConexao, {
            url: cfg.url,
            parar: controle.signal,
            mostrar: (authUrl, ate) => saida(`Abra este endereço no navegador (de qualquer aparelho) e entre com a sua conta Google, até ${hora(ate)}:\n\n  ${authUrl}\n\nAguardando...`),
          });
          saida(`Conectado a ${con.url} como "${con.nome}".`);
        } finally {
          process.removeListener("SIGINT", aoSinal);
        }
        const s = await novoCliente().ciclo({ forcar: true });
        mostrar(s);
        return s.estado === "ok" || s.estado === "sem_conta" ? 0 : 1;
      }
      case "rodar": {
        garantirPasta(cfg.dir);
        const trava = travar(estado.arqTrava, { agora });
        if (!trava) {
          erroSaida(`Já há um cliente rodando com a pasta de dados ${cfg.dir}. (Se ele morreu sem avisar, a trava se solta sozinha em 3 min.)`);
          return 1;
        }
        const controle = new AbortController();
        const aoSinal = () => controle.abort();
        process.once("SIGINT", aoSinal);
        process.once("SIGTERM", aoSinal);
        log.info(`Swap Plus Cliente ${VERSAO} — dados em ${cfg.dir}, login do Claude Code em ${cfg.pastaClaude}, presença ${cfg.presenca}`);
        try {
          await novoCliente().rodar({
            parar: deps.parar || controle.signal,
            aCadaCiclo: () => {
              if (trava.renovar()) return true;
              log.error("outro cliente assumiu esta pasta de dados; encerrando este.");
              return false;
            },
          });
        } finally {
          process.removeListener("SIGINT", aoSinal);
          process.removeListener("SIGTERM", aoSinal);
          trava.soltar();
        }
        log.info("encerrado.");
        return 0;
      }
      case "uma-vez": {
        garantirPasta(cfg.dir);
        const s = await novoCliente().ciclo({ forcar: true });
        mostrar(s);
        return s.estado === "ok" ? 0 : 1;
      }
      case "status": {
        const s = estado.situacao();
        let con = null;
        try {
          con = estado.conexao();
        } catch {}
        if (!s) {
          saida(op.json ? JSON.stringify({ estado: con ? "nunca_rodou" : "desconectado" }) : con ? `Conectado a ${con.url}, mas o cliente ainda não rodou. Rode: swap-plus-cliente rodar` : "Este cliente ainda não foi conectado ao servidor. Rode: swap-plus-cliente conectar <código de conexão>");
          return 1;
        }
        mostrar(s);
        return s.estado === "ok" ? 0 : 1;
      }
      case "saude": {
        const r = saudavel(estado.situacao(), agora());
        saida(r.ok ? "ok" : `problema: ${r.motivo}`);
        return r.ok ? 0 : 1;
      }
      case "trocar": {
        const n = args[0] === undefined ? null : Number(args[0]);
        if (n !== null && (!Number.isInteger(n) || n <= 0)) {
          erroSaida("Diga o número da conta (ou nada, para a melhor conta).");
          return 2;
        }
        const s = await novoCliente().trocar(n);
        mostrar(s);
        return s.estado === "ok" ? 0 : 1;
      }
      case "limite": {
        const s = await novoCliente().informarLimite(args.join(" ") || "limite de uso");
        if (s.limite) saida(s.limite.trocou ? `O servidor trocou de conta${s.limite.texto ? `: ${s.limite.texto}` : "."}` : `O servidor não trocou de conta${s.limite.texto ? `: ${s.limite.texto}` : "."}`);
        mostrar(s);
        return s.estado === "ok" ? 0 : 1;
      }
      case "desconectar": {
        const r = await conexao.desconectar(depsConexao);
        saida(!r.havia ? "Este cliente não estava conectado." : r.revogou ? "Desconectado: o servidor revogou este cliente." : "Desconectado aqui. (Não consegui avisar o servidor: revogue este cliente no painel, em Computadores.)");
        saida(`O login do Claude Code em ${cfg.pastaClaude} não foi apagado: ele deixa de ser renovado e vence sozinho em algumas horas.`);
        return 0;
      }
      default:
        erroSaida(`Comando desconhecido: ${comando}. Veja: swap-plus-cliente ajuda`);
        return 2;
    }
  } catch (e) {
    // Mensagens do serverClient e do claudeAuth já vêm em português e sem segredo.
    erroSaida(`Não deu certo: ${(e && e.message) || e}${e && e.code ? ` [${e.code}]` : ""}`);
    return 1;
  }
}

module.exports = { main, lerArgumentos, saudavel, descrever, esperar, VERSAO, dir: path.resolve(__dirname, "..") };
