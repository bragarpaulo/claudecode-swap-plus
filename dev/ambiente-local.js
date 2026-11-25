#!/usr/bin/env node
"use strict";
// Ambiente local do Swap Plus: tudo nesta máquina, com dados SIMULADOS, sem banco e sem nada saindo para a internet.
//
//   node dev/ambiente-local.js [subir]   sobe o Anthropic/Google falso (127.0.0.1:3010) e o servidor Swap Plus de
//                                        verdade (API + painel em 127.0.0.1:3008, admin em 127.0.0.1:3009)
//   node dev/ambiente-local.js testes    roda todas as suítes offline e mostra um resumo (com os bloqueios de rede)
//   node dev/ambiente-local.js medir     medidas de desempenho antes (origin/main) e depois (este código)
//   node dev/ambiente-local.js cliente   o Swap Plus Cliente contra o servidor local (pareia e faz um ciclo)
//   node dev/ambiente-local.js vscode    abre o VS Code (Extension Development Host) com a extensão de plus/, isolado
//   node dev/ambiente-local.js limpar    apaga dev/.dados/ (pede confirmação; --sim pula)
//
// Tudo o que o ambiente grava fica em dev/.dados/ (fora do git). Nenhum comando daqui usa conta, servidor ou
// credencial de verdade: o servidor fala com o Anthropic/Google falso (dev/simulado/fora-falso.js) e todo processo
// Node iniciado aqui carrega dev/sem-internet.js (conexão fora do loopback falha com ENETUNREACH).

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const readline = require("readline");
const { spawn, spawnSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..");
const SEM_INTERNET = path.join(__dirname, "sem-internet.js");
const PORTAS_PADRAO = [3008, 3009, 3010];

/**
 * Portas: API + painel, admin e Anthropic/Google falso. Padrão 3008,3009,3010; outras com --portas 3018,3019,3020
 * (em qualquer posição) ou SWAP_PLUS_PORTAS=3018,3019,3020 — para dois ambientes na mesma pasta.
 */
function lerPortas(argv, env) {
  let txt = env.SWAP_PLUS_PORTAS || "";
  const i = argv.indexOf("--portas");
  if (i >= 0) txt = argv[i + 1] || "";
  const eq = argv.find((a) => a.startsWith("--portas="));
  if (eq) txt = eq.slice("--portas=".length);
  if (!String(txt).trim()) return PORTAS_PADRAO;
  const lista = String(txt).split(",").map((x) => Number(x.trim()));
  if (lista.length !== 3 || lista.some((n) => !Number.isInteger(n) || n < 1024 || n > 65535) || new Set(lista).size !== 3) {
    console.error(`--portas / SWAP_PLUS_PORTAS inválido: "${txt}". Use três portas diferentes de 1024 a 65535, ex.: --portas 3018,3019,3020`);
    process.exit(2);
  }
  return lista;
}
/** Tira o --portas (e o valor) dos argumentos dos subcomandos. */
function semPortas(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--portas") i++;
    else if (!argv[i].startsWith("--portas=")) out.push(argv[i]);
  }
  return out;
}
const [PORTA_API, PORTA_ADMIN, PORTA_FORA] = lerPortas(process.argv.slice(2), process.env);
const PORTAS_SAO_PADRAO = PORTA_API === PORTAS_PADRAO[0] && PORTA_ADMIN === PORTAS_PADRAO[1] && PORTA_FORA === PORTAS_PADRAO[2];
// Tudo o que o ambiente grava. Com outras portas, numa subpasta própria (outro cofre, outro perfil do VS Code).
const DADOS_RAIZ = path.join(__dirname, ".dados");
const DADOS = PORTAS_SAO_PADRAO ? DADOS_RAIZ : path.join(DADOS_RAIZ, `portas-${PORTA_API}`);
const URL_PAINEL = `http://127.0.0.1:${PORTA_API}`;
const ADMIN_EMAIL = "admin@local.test";
const { CLIENT_ID } = require("./simulado/fora-falso");

const rel = (p) => path.relative(process.cwd(), p) || ".";
const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/** Ambiente dos processos filhos: o bloqueio de rede sempre entra (somado a um NODE_OPTIONS que já exista). */
function envFilho(extra = {}) {
  const env = { ...process.env, ...extra };
  const req = `--require=${SEM_INTERNET}`;
  env.NODE_OPTIONS = [process.env.NODE_OPTIONS, req].filter(Boolean).join(" ");
  return env;
}

function garantirPasta(p) {
  fs.mkdirSync(p, { recursive: true, mode: 0o700 });
  return p;
}

/** Arquivo com um segredo fictício gerado aqui (0600), criado só se não existir. */
function garantirArquivo(p, conteudo) {
  if (!fs.existsSync(p)) fs.writeFileSync(p, conteudo, { mode: 0o600 });
  return p;
}

function portaLivre(porta) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", (e) => resolve(e.code === "EADDRINUSE" ? false : true));
    s.listen(porta, "127.0.0.1", () => s.close(() => resolve(true)));
  });
}

function pedir(metodo, url, corpo) {
  return new Promise((resolve, reject) => {
    const dados = corpo === undefined ? null : JSON.stringify(corpo);
    const req = http.request(url, { method: metodo, headers: dados ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(dados) } : {}, timeout: 5000 }, (res) => {
      const partes = [];
      res.on("data", (d) => partes.push(d));
      res.on("end", () => {
        const texto = Buffer.concat(partes).toString("utf8");
        let json = null;
        try {
          json = JSON.parse(texto);
        } catch {}
        resolve({ status: res.statusCode, json, texto });
      });
    });
    req.on("timeout", () => req.destroy(new Error("tempo esgotado")));
    req.on("error", reject);
    if (dados) req.write(dados);
    req.end();
  });
}

async function esperarNoAr(url, ms) {
  const fim = Date.now() + ms;
  while (Date.now() < fim) {
    try {
      const r = await pedir("GET", url);
      if (r.status === 200) return r;
    } catch {}
    await dormir(200);
  }
  return null;
}

/** Processo filho com a saída prefixada ("[servidor] ..."). */
function filho(nome, args, opts) {
  const p = spawn(process.execPath, args, { cwd: RAIZ, stdio: ["ignore", "pipe", "pipe"], ...opts });
  const prefixar = (stream, out) => {
    let resto = "";
    stream.on("data", (d) => {
      resto += d.toString("utf8");
      const linhas = resto.split("\n");
      resto = linhas.pop();
      for (const l of linhas) out.write(`[${nome}] ${l}\n`);
    });
    stream.on("end", () => resto && out.write(`[${nome}] ${resto}\n`));
  };
  prefixar(p.stdout, process.stdout);
  prefixar(p.stderr, process.stderr);
  return p;
}

// ---------------------------------------------------------------- subir

function arquivosDoServidor() {
  garantirPasta(DADOS);
  const chave = garantirArquivo(path.join(DADOS, "chave-mestra"), crypto.randomBytes(32).toString("hex") + "\n");
  const gid = garantirArquivo(path.join(DADOS, "google-client-id"), `${CLIENT_ID}\n`);
  const gsec = garantirArquivo(path.join(DADOS, "google-client-secret"), `simulado-${crypto.randomBytes(12).toString("hex")}\n`);
  const dataDir = garantirPasta(path.join(DADOS, "servidor"));
  return { chave, gid, gsec, dataDir };
}

function envServidor(a) {
  const fora = `http://127.0.0.1:${PORTA_FORA}`;
  return envFilho({
    TLS_MODE: "off",
    PUBLIC_URL: URL_PAINEL,
    PORT: String(PORTA_API),
    ADMIN_PORT: String(PORTA_ADMIN),
    DATA_DIR: a.dataDir,
    MASTER_KEY_FILE: a.chave,
    ANTHROPIC_API_BASE: fora,
    ANTHROPIC_TOKEN_URL: `${fora}/v1/oauth/token`,
    GOOGLE_AUTH_URL: `${fora}/google/auth`,
    GOOGLE_TOKEN_URL: `${fora}/google/token`,
    GOOGLE_CLIENT_ID_FILE: a.gid,
    GOOGLE_CLIENT_SECRET_FILE: a.gsec,
    ADMIN_EMAILS: ADMIN_EMAIL,
    // O servidor abre a porta em todas as interfaces (não tem opção de endereço); só 127.0.0.1 é aceito (os outros: 403).
    ALLOW_IPS: "127.0.0.1",
    NOTICES_ENABLED: "0",
    TZ: "America/Sao_Paulo",
  });
}

async function subir() {
  const t0 = Date.now();
  for (const [porta, quem] of [
    [PORTA_API, "API + painel"],
    [PORTA_ADMIN, "admin"],
    [PORTA_FORA, "Anthropic/Google falso"],
  ]) {
    if (!(await portaLivre(porta))) {
      console.error(`A porta ${porta} (${quem}) já está em uso em 127.0.0.1. Feche o que está nela (talvez outro "node dev/ambiente-local.js") e rode de novo.`);
      return 1;
    }
  }
  const a = arquivosDoServidor();
  perfilVscode(); // F5 (.vscode/launch.json) e o subcomando vscode usam este perfil isolado
  const { semear } = require("./simulado/semear");
  const s = await semear({ dir: a.dataDir, keyFile: a.chave });
  console.log(s.semeou ? `Cofre semeado com os dados simulados: ${s.contas} contas, ${s.servicos} serviço(s).` : `Cofre já tinha dados (${s.contas} contas, ${s.servicos} serviço(s)): nada semeado de novo.`);

  const fora = filho("fora-falso", [path.join(__dirname, "simulado", "fora-falso.js"), String(PORTA_FORA)], { env: envFilho() });
  const servidor = filho("servidor", [path.join(RAIZ, "server", "src", "server.js")], { env: envServidor(a) });
  const filhos = [fora, servidor];
  let saindo = false;
  const encerrar = async (codigo) => {
    if (saindo) return;
    saindo = true;
    console.log("\nEncerrando (o servidor grava o cofre)...");
    for (const p of filhos) if (p.exitCode === null) p.kill("SIGTERM");
    await Promise.all(filhos.map((p) => (p.exitCode !== null ? null : new Promise((r) => p.once("exit", r)))));
    process.exit(codigo);
  };
  process.on("SIGINT", () => encerrar(0));
  process.on("SIGTERM", () => encerrar(0));
  for (const p of filhos) {
    p.once("exit", (code) => {
      if (!saindo) {
        console.error(`\nUm processo do ambiente parou (código ${code}). Encerrando o resto.`);
        encerrar(1);
      }
    });
  }

  const ok = await esperarNoAr(`http://127.0.0.1:${PORTA_ADMIN}/v1/health`, 15000);
  if (!ok || !(await esperarNoAr(`http://127.0.0.1:${PORTA_FORA}/`, 3000))) {
    console.error("O ambiente não respondeu em 15 s (veja as mensagens acima).");
    await encerrar(1);
    return 1;
  }
  const pc = await pedir("POST", `http://127.0.0.1:${PORTA_ADMIN}/admin/pair-code`);
  const seg = ((Date.now() - t0) / 1000).toFixed(1);
  const op = PORTAS_SAO_PADRAO ? "" : ` --portas ${PORTA_API},${PORTA_ADMIN},${PORTA_FORA}`;
  console.log(`
==================================================================================
 Swap Plus — ambiente local no ar em ${seg} s (servidor ${ok.json && ok.json.version}; dados SIMULADOS)

 Painel:              ${URL_PAINEL}/
                      entre com "Entrar com Google" → ${ADMIN_EMAIL} (Google simulado)
 Admin local:         http://127.0.0.1:${PORTA_ADMIN}/v1/health
 Código de conexão:   ${pc.json && pc.json.connect ? pc.json.connect : "(não gerado: " + pc.texto + ")"}
                      (vale 10 min e uma vez; outro: node server/src/cli.js pair com ADMIN_PORT=${PORTA_ADMIN})
 Conta liberada:      pessoa@local.test (conecta serviços; não abre o painel)

 Mudar o uso de uma conta ao vivo (ex.: conta 1 a 95% na sessão):
   curl -s -X POST http://127.0.0.1:${PORTA_FORA}/_simular/uso -H 'Content-Type: application/json' \\
        -d '{"conta":1,"sessao":95}'
   O servidor relê o uso no ritmo de verdade (orçamento da Anthropic): conta em uso perto de uma linha a cada
   2,5 min, longe das linhas a cada 10 min, as outras a cada 20 min. O número novo pode levar até 10 min.
 Outro terminal:      node dev/ambiente-local.js cliente${op}   |   node dev/ambiente-local.js vscode${op}
 Dados em:            ${rel(DADOS)}/  (apagar: node dev/ambiente-local.js limpar${op})
 Ctrl+C encerra tudo.
==================================================================================
`);
  return new Promise(() => {}); // fica no ar até o Ctrl+C
}

// ---------------------------------------------------------------- testes

function jsDe(dir) {
  const out = [];
  const andar = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === "node_modules" || e.name === ".dados") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) andar(p);
      else if (e.name.endsWith(".js")) out.push(p);
    }
  };
  andar(dir);
  return out.sort();
}

function rodarSuite(s, pastaLogs) {
  const log = path.join(pastaLogs, `${s.id}.log`);
  const bloqueios = path.join(pastaLogs, `${s.id}.bloqueios`);
  fs.rmSync(bloqueios, { force: true });
  const t0 = Date.now();
  const r = spawnSync(s.cmd[0], s.cmd.slice(1), {
    cwd: s.cwd || RAIZ,
    env: envFilho({ SEM_INTERNET_LOG: bloqueios, NODE_TEST_CONTEXT: undefined }),
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  const texto = `${r.stdout || ""}${r.stderr || ""}`;
  fs.writeFileSync(log, texto);
  const linhasBloq = fs.existsSync(bloqueios) ? fs.readFileSync(bloqueios, "utf8").split("\n").filter(Boolean) : [];
  const num = (re) => {
    const m = texto.match(re);
    return m ? Number(m[m.length - 1].replace(/\D+/g, "")) : null;
  };
  return {
    ...s,
    ok: r.status === 0,
    status: r.status,
    seg: (Date.now() - t0) / 1000,
    pass: num(/^ℹ pass \d+/gm),
    fail: num(/^ℹ fail \d+/gm),
    bloqueios: linhasBloq,
    log,
    texto,
  };
}

async function testes() {
  const pastaLogs = garantirPasta(path.join(DADOS, "testes"));
  const node = process.execPath;
  const arquivos = [...jsDe(path.join(RAIZ, "plus")), ...jsDe(path.join(RAIZ, "server", "src")), ...jsDe(path.join(RAIZ, "cliente", "src")), ...jsDe(path.join(RAIZ, "cliente", "bin")), ...jsDe(__dirname)];
  const suites = [
    { id: "sintaxe", nome: `node --check (${arquivos.length} arquivos)`, cmd: [node, "-e", `for (const f of ${JSON.stringify(arquivos)}) { const r = require("child_process").spawnSync(process.execPath, ["--check", f], { encoding: "utf8" }); if (r.status) { console.error(r.stderr); process.exit(1); } } console.log("sintaxe ok")`] },
    { id: "extensao-rapido", nome: "extensão (rápido): smoke.js --unit", cmd: [node, "plus/test/smoke.js", "--unit"] },
    { id: "extensao", nome: "extensão: plus/test/*.test.js", cmd: [node, "--test", ...fs.readdirSync(path.join(RAIZ, "plus", "test")).filter((f) => f.endsWith(".test.js")).map((f) => `plus/test/${f}`)] },
    { id: "servidor", nome: "servidor: server/test/*.test.js", cmd: [node, "--test", ...fs.readdirSync(path.join(RAIZ, "server", "test")).filter((f) => f.endsWith(".test.js")).map((f) => `server/test/${f}`)] },
    { id: "cliente", nome: "cliente: cliente/test/*.test.js", cwd: path.join(RAIZ, "cliente"), cmd: [node, "--test", ...fs.readdirSync(path.join(RAIZ, "cliente", "test")).filter((f) => f.endsWith(".test.js")).map((f) => `test/${f}`)] },
    { id: "design", nome: "design: dev/conferir-design.js", cmd: [node, "dev/conferir-design.js"] },
  ];
  const res = [];
  for (const s of suites) {
    if (process.stdout.isTTY) process.stdout.write(`… ${s.nome}`);
    const r = rodarSuite(s, pastaLogs);
    res.push(r);
    process.stdout.write(`${process.stdout.isTTY ? "\r\x1b[K" : ""}${r.ok ? "ok    " : "FALHOU"}  ${s.nome} (${r.seg.toFixed(1)} s)\n`);
    if (!r.ok) console.log(r.texto.split("\n").slice(-40).join("\n"));
  }
  const totalBloq = res.reduce((n, r) => n + r.bloqueios.length, 0);
  console.log("\nResumo");
  console.log("  suíte                                     resultado   testes ok / falhas   tempo     bloqueios");
  for (const r of res) {
    const testesTxt = r.pass === null ? "-" : `${r.pass} / ${r.fail}`;
    console.log(`  ${r.nome.slice(0, 40).padEnd(41)} ${(r.ok ? "passou" : "FALHOU").padEnd(11)} ${testesTxt.padEnd(20)} ${(r.seg.toFixed(1) + " s").padEnd(9)} ${r.bloqueios.length}`);
  }
  console.log(`\n  [sem-internet] bloqueios no total: ${totalBloq}${totalBloq ? " (esperado 0 — quem tentou sair:)" : " (nada tentou sair para a internet)"}`);
  for (const r of res) for (const l of r.bloqueios.slice(0, 20)) console.log(`    ${r.id}: ${l}`);
  console.log(`  Saídas completas: ${rel(pastaLogs)}/<suíte>.log`);
  const falhas = res.filter((r) => !r.ok).length;
  console.log(falhas ? `\n${falhas} suíte(s) falharam.` : "\nTodas as suítes passaram.");
  return falhas ? 1 : 0;
}

// ---------------------------------------------------------------- medir

function medir(args) {
  const r = spawnSync(process.execPath, [path.join(__dirname, "medir-desempenho.js"), ...args], { cwd: RAIZ, stdio: "inherit", env: envFilho() });
  return r.status === null ? 1 : r.status;
}

// ---------------------------------------------------------------- cliente

function opcao(args, nome, padrao) {
  const i = args.indexOf(nome);
  if (i >= 0 && args[i + 1]) return args[i + 1];
  const eq = args.find((a) => a.startsWith(`${nome}=`));
  return eq ? eq.slice(nome.length + 1) : padrao;
}

async function cliente(args) {
  const saude = await esperarNoAr(`http://127.0.0.1:${PORTA_ADMIN}/v1/health`, 1500);
  if (!saude) {
    console.error(`O servidor local não está no ar (127.0.0.1:${PORTA_ADMIN}). Em outro terminal: node dev/ambiente-local.js`);
    return 1;
  }
  const base = path.resolve(opcao(args, "--dados", path.join(DADOS, "cliente")));
  if (!base.startsWith(DADOS + path.sep)) {
    console.error(`--dados precisa ficar dentro de ${rel(DADOS)}/ (é o que o "limpar" apaga).`);
    return 2;
  }
  const nome = opcao(args, "--nome", "Cliente (simulado)");
  const home = garantirPasta(base);
  const pastaClaude = garantirPasta(path.join(home, ".claude"));
  const dirDados = garantirPasta(path.join(home, "dados"));
  const pc = await pedir("POST", `http://127.0.0.1:${PORTA_ADMIN}/admin/pair-code`);
  if (pc.status !== 200 || !pc.json || !pc.json.connect) {
    console.error(`Não consegui gerar o código de conexão: ${pc.texto}`);
    return 1;
  }
  console.log(`Cliente isolado: HOME=${rel(home)}  CLAUDE_CONFIG_DIR=${rel(pastaClaude)}  nome "${nome}"`);
  const r = spawnSync(
    process.execPath,
    [path.join(RAIZ, "cliente", "bin", "swap-plus-cliente.js"), "conectar", pc.json.connect, "--dir", dirDados, "--pasta-claude", pastaClaude, "--nome", nome],
    {
      cwd: RAIZ,
      stdio: "inherit",
      env: envFilho({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: pastaClaude, SWAP_PLUS_PASTA_PADRAO: "1", TMPDIR: garantirPasta(path.join(home, "tmp")) }),
    }
  );
  const cred = path.join(pastaClaude, ".credentials.json");
  if (fs.existsSync(cred)) {
    const tok = (JSON.parse(fs.readFileSync(cred, "utf8")).claudeAiOauth || {}).accessToken || "";
    console.log(`\nLogin gravado em ${rel(cred)}: ${/SIMULADO/.test(tok) ? `token simulado (${tok.replace(/^(sk-ant-oat01-SIMULADO-\d+)-.*/, "$1-…")})` : "ATENÇÃO: o token não é o simulado"}`);
  }
  return r.status === null ? 1 : r.status;
}

// ---------------------------------------------------------------- vscode

function acharCode() {
  if (process.env.CODE_BIN) return fs.existsSync(process.env.CODE_BIN) ? process.env.CODE_BIN : null;
  for (const d of String(process.env.PATH || "").split(path.delimiter)) {
    for (const n of process.platform === "win32" ? ["code.cmd", "code.exe"] : ["code"]) {
      const p = path.join(d, n);
      try {
        fs.accessSync(p, fs.constants.X_OK);
        return p;
      } catch {}
    }
  }
  return null;
}

/** Perfil isolado do VS Code (dev/.dados/vscode) com as configurações do ambiente local. Usado pelo `vscode` e pelo F5. */
function perfilVscode() {
  const raiz = garantirPasta(path.join(DADOS, "vscode"));
  const userDir = garantirPasta(path.join(raiz, "user-data"));
  const extDir = garantirPasta(path.join(raiz, "extensions"));
  const home = garantirPasta(path.join(DADOS, "home"));
  const claude = garantirPasta(path.join(home, ".claude"));
  const tmp = garantirPasta(path.join(DADOS, "tmp"));
  // Configurações do perfil isolado: o servidor local, sem atualizações (GitHub) e sem o que o próprio VS Code tenta
  // na internet (boas-vindas com login no GitHub, Copilot, telemetria). Chave que já existe no arquivo não é mexida.
  const settings = path.join(garantirPasta(path.join(userDir, "User")), "settings.json");
  const padrao = {
    "swapPlus.server.url": URL_PAINEL,
    "swapPlus.updates.enabled": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoCheckUpdates": false,
    "extensions.autoUpdate": false,
    "workbench.enableExperiments": false,
    "workbench.startupEditor": "none",
    "chat.disableAIFeatures": true,
    "github.gitAuthentication": false,
  };
  let atual = {};
  try {
    atual = JSON.parse(fs.readFileSync(settings, "utf8"));
  } catch {}
  if (atual && typeof atual === "object" && (Object.keys(padrao).some((k) => !(k in atual)) || atual["swapPlus.server.url"] !== URL_PAINEL)) {
    fs.writeFileSync(settings, JSON.stringify({ ...padrao, ...atual, "swapPlus.server.url": URL_PAINEL }, null, 2) + "\n");
  }
  return { userDir, extDir, home, claude, tmp };
}

async function vscode(args) {
  const code = acharCode();
  if (!code) {
    console.error(`O VS Code não está instalado (não achei "code" no PATH; CODE_BIN também serve).
Para instalar (usa a internet; o ambiente e os testes não):
  sudo snap install code --classic
  ou baixe o .deb em https://code.visualstudio.com/ e rode: sudo apt install ./code_*.deb
  sem root: baixe o .tar.gz (Linux x64) do mesmo site, descompacte e rode com CODE_BIN=<pasta>/bin/code
Em máquina sem tela: xvfb-run -a node dev/ambiente-local.js vscode --no-sandbox`);
    return 2;
  }
  const { userDir, extDir, home, claude, tmp } = perfilVscode();
  const saude = await esperarNoAr(`http://127.0.0.1:${PORTA_ADMIN}/v1/health`, 1000);
  if (!saude) console.warn(`Aviso: o servidor local não está no ar (rode "node dev/ambiente-local.js" em outro terminal antes de conectar).`);
  // --password-store=basic: sem chaveiro do sistema (máquina sem tela) o VS Code pararia numa pergunta; os segredos
  // deste perfil são só os do ambiente simulado.
  const cmd = [`--extensionDevelopmentPath=${path.join(RAIZ, "plus")}`, `--user-data-dir=${userDir}`, `--extensions-dir=${extDir}`, "--disable-extensions", "--new-window", "--disable-workspace-trust", "--password-store=basic", ...args];
  console.log(`Abrindo o VS Code isolado (HOME=${rel(home)}, CLAUDE_CONFIG_DIR=${rel(claude)}). Conecte com o código de conexão do "subir".`);
  // O VS Code cria o socket principal em XDG_RUNTIME_DIR (ou, sem ele, dentro do --user-data-dir). Caminho de socket Unix
  // passa de 107 caracteres fácil com o repositório numa pasta funda ("listen EINVAL"): usa uma pasta curta.
  let runtime = process.env.XDG_RUNTIME_DIR;
  if (!runtime || !fs.existsSync(runtime)) {
    runtime = path.join("/tmp", `swap-plus-vscode-${typeof process.getuid === "function" ? process.getuid() : "u"}`);
    garantirPasta(runtime);
  }
  const p = spawn(code, cmd, { stdio: "inherit", env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: claude, TMPDIR: tmp, XDG_RUNTIME_DIR: runtime, VSCODE_CLI: undefined } });
  return new Promise((resolve) => p.on("exit", (c) => resolve(c === null ? 1 : c)));
}

// ---------------------------------------------------------------- limpar

async function limpar(args) {
  if (!fs.existsSync(DADOS)) {
    console.log(`Nada a apagar (${rel(DADOS)}/ não existe).`);
    return 0;
  }
  if (!(DADOS === DADOS_RAIZ || path.dirname(DADOS) === DADOS_RAIZ) || path.dirname(DADOS_RAIZ) !== __dirname) throw new Error("pasta de dados inesperada; nada apagado");
  if (!args.includes("--sim")) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const resp = await new Promise((r) => rl.question(`Apagar ${rel(DADOS)}/ (cofre simulado, logins simulados, VS Code isolado, medidas)? [s/N] `, r));
    rl.close();
    if (!/^s(im)?$/i.test(String(resp).trim())) {
      console.log("Nada apagado.");
      return 0;
    }
  }
  fs.rmSync(DADOS, { recursive: true, force: true });
  console.log(`Apagado: ${rel(DADOS)}/`);
  return 0;
}

// ---------------------------------------------------------------- principal

const AJUDA = `Uso: node dev/ambiente-local.js [subir|testes|medir|cliente|vscode|limpar]
  subir     (padrão) Anthropic/Google falso em 127.0.0.1:${PORTA_FORA} + servidor Swap Plus em 127.0.0.1:${PORTA_API} (admin ${PORTA_ADMIN})
  testes    todas as suítes offline, com o resumo e os bloqueios de rede
  medir     desempenho antes (origin/main) × depois
  cliente   Swap Plus Cliente contra o servidor local [--dados dev/.dados/<pasta>] [--nome <nome>]
  --portas A,B,C   (em qualquer subcomando; ou SWAP_PLUS_PORTAS) outras portas para API, admin e falso — dados em
                   dev/.dados/portas-A/ (dois ambientes na mesma pasta)
  vscode    Extension Development Host com plus/, isolado em dev/.dados/ (precisa do VS Code)
  limpar    apaga dev/.dados/ [--sim]`;

async function main(argv) {
  const [cmd = "subir", ...args] = semPortas(argv);
  switch (cmd) {
    case "subir":
      return subir();
    case "testes":
      return testes();
    case "medir":
      return medir(args);
    case "cliente":
      return cliente(args);
    case "vscode":
      return vscode(args);
    case "limpar":
      return limpar(args);
    case "ajuda":
    case "--help":
    case "-h":
      console.log(AJUDA);
      return 0;
    default:
      console.error(`Subcomando desconhecido: ${cmd}\n${AJUDA}`);
      return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(e && e.stack ? e.stack : e);
      process.exit(1);
    }
  );
}

module.exports = { main, envFilho, PORTA_API, PORTA_ADMIN, PORTA_FORA };
