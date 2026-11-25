#!/usr/bin/env node
"use strict";
// Medidas de desempenho ANTES × DEPOIS, na mesma execução (node dev/ambiente-local.js medir).
//
//   antes  = o código de origin/main (ou --antes <ref>), extraído com `git archive <ref> plus server` numa pasta temporária
//   depois = o código desta pasta
//
// 1. Transcrições do Claude Code: 300 projetos × 40 transcrições antigas + 5 recentes, numa pasta temporária.
//    Mediana de 10 execuções de scanLimitErrors e de detectModels. No "depois", cada execução é como um tique de
//    verdade: o resultado de 10 s já venceu (o vigia roda a cada 15 s), as listas das pastas valem pelo mtime.
// 2. Varreduras completas por minuto com 3 janelas do VS Code (relógio simulado: 1 minuto de tiques de 15 s do vigia
//    do limite e de 30 s do ciclo, em cada janela). Antes: toda janela varre. Depois: só a dona varre, e o
//    inventário serve o limite e o modelo em uso.
// 3. Painel web: bytes na primeira abertura (index.html + app.js + app.css, com Accept-Encoding: gzip) e numa
//    reabertura (com If-None-Match), contra os dois servidores de verdade em portas livres (127.0.0.1, sem rede).
//
// Resultado: tabela no terminal e dev/.dados/medidas.json.
// Uso: node dev/medir-desempenho.js [--antes <ref>] [--projetos 300] [--arquivos 40] [--vezes 10]

const fs = require("fs");
const http = require("http");
const net = require("net");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync, execFileSync } = require("child_process");

const RAIZ = path.resolve(__dirname, "..");
const DADOS = path.join(__dirname, ".dados");

function opcao(args, nome, padrao) {
  const i = args.indexOf(nome);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : padrao;
}

const mediana = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// ---------------------------------------------------------------- trabalhador (roda num processo próprio)

/**
 * Carrega o extension.js de `pastaPlus` com um vscode de mentira e mede. Saída: JSON numa linha.
 * HOME e CLAUDE_CONFIG_DIR já apontam para a pasta temporária (o "antes" lê ~/.claude/projects fixo).
 */
async function trabalhador(pastaPlus, raizProjetos, vezes) {
  // Relógio que dá para adiantar (simulação dos tiques). Trocado ANTES de carregar o módulo: o inventário guarda Date.now.
  const realNow = Date.now.bind(Date);
  let adiantado = 0;
  Date.now = () => realNow() + adiantado;
  const Module = require("module");
  const vscodeMock = {
    MarkdownString: class {
      appendMarkdown() {
        return this;
      }
      appendText() {
        return this;
      }
    },
    ThemeColor: class {},
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1 },
    ViewColumn: { One: 1 },
    ProgressLocation: { Notification: 15 },
    QuickPickItemKind: { Separator: -1 },
    env: { appRoot: "/nao-existe" },
    Uri: { file: (p) => ({ fsPath: p }) },
    window: { showInformationMessage: async () => {}, showWarningMessage: async () => {}, showErrorMessage: async () => {} },
    workspace: { getConfiguration: () => ({ get: () => undefined, update: async () => {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => {} },
  };
  const load = Module._load;
  Module._load = function (req) {
    if (req === "vscode") return vscodeMock;
    return load.apply(this, arguments);
  };
  const T = require(path.join(pastaPlus, "extension.js"))._test;
  const inv = T.transcripts || null; // só no "depois"
  const tempo = async (fn) => {
    if (inv) inv.invalidate(); // tique de verdade: o resultado de 10 s já venceu
    const t0 = process.hrtime.bigint();
    await fn();
    return Number(process.hrtime.bigint() - t0) / 1e6;
  };
  const since = Date.now() - 10 * 60 * 1000;
  // Primeira execução (fria: o sistema de arquivos e, no depois, as listas das pastas ainda não lidas).
  const fria = { scan: await tempo(() => T.scanLimitErrors(since, raizProjetos)), detect: await tempo(() => T.detectModels(Date.now())) };
  const scan = [];
  const detect = [];
  let achou = null;
  let modelos = null;
  for (let i = 0; i < vezes; i++) {
    scan.push(await tempo(async () => (achou = await T.scanLimitErrors(since, raizProjetos))));
    detect.push(await tempo(async () => (modelos = await T.detectModels(Date.now()))));
  }
  // Simulação de 1 minuto com 3 janelas: quantas varreduras COMPLETAS acontecem.
  // Antes: cada chamada varre tudo (não há inventário). Depois: só a dona chama; o inventário conta as varreduras.
  let varreduras = 0;
  if (inv) {
    inv.invalidate();
    const s0 = inv.stats.scans;
    const inicio = adiantado;
    for (let t = 0; t < 60; t++) {
      adiantado = inicio + t * 1000;
      // janela dona: vigia do limite a cada 15 s e ciclo (modelo em uso) a cada 30 s, defasados como no VS Code
      if (t % 15 === 0) await T.scanLimitErrors(since, raizProjetos);
      if (t % 30 === 7) await T.detectModels(Date.now());
      // janelas 2 e 3: não varrem (checkLimitErrors volta sem varrer fora da dona; o modelo vem do arquivo da dona)
    }
    varreduras = inv.stats.scans - s0;
    adiantado = inicio;
  } else {
    for (let janela = 0; janela < 3; janela++) {
      for (let t = 0; t < 60; t++) {
        if (t % 15 === 0) {
          await T.scanLimitErrors(since, raizProjetos);
          varreduras++;
        }
        if (t % 30 === 7) {
          await T.detectModels(Date.now());
          varreduras++;
        }
      }
    }
  }
  process.stdout.write(
    JSON.stringify({ fria, scan, detect, varreduras, conferencia: { limite: achou ? path.basename(achou.file) : null, modelos: (modelos || []).map((m) => m.id) } }) + "\n"
  );
}

// ---------------------------------------------------------------- montagem das transcrições

function montarTranscricoes(raiz, projetos, arquivos) {
  const antigo = new Date(Date.now() - 2 * 24 * 3600 * 1000);
  const linhaAntiga = JSON.stringify({ type: "assistant", timestamp: antigo.toISOString(), message: { model: "claude-opus-5-5", content: [{ type: "text", text: "resposta antiga" }] } }) + "\n";
  for (let p = 0; p < projetos; p++) {
    const dir = path.join(raiz, `-home-pessoa-projeto-${String(p).padStart(3, "0")}`);
    fs.mkdirSync(dir, { recursive: true });
    for (let a = 0; a < arquivos; a++) {
      const f = path.join(dir, `${crypto.randomUUID()}.jsonl`);
      fs.writeFileSync(f, linhaAntiga.repeat(20));
      fs.utimesSync(f, antigo, antigo);
    }
    fs.utimesSync(dir, antigo, antigo);
  }
  // 5 recentes: conversas de agora (modelo em uso), uma delas com o erro de limite.
  const agora = new Date();
  for (let r = 0; r < 5; r++) {
    const dir = path.join(raiz, `-home-pessoa-projeto-${String(r * 7).padStart(3, "0")}`);
    const linhas = [JSON.stringify({ type: "assistant", timestamp: agora.toISOString(), message: { model: r % 2 ? "claude-fable-5-2" : "claude-opus-5-5", content: [{ type: "text", text: "ok" }] } })];
    if (r === 4) {
      linhas.push(JSON.stringify({ type: "assistant", isApiErrorMessage: true, error: "rate_limit", timestamp: agora.toISOString(), message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your 5-hour limit" }] } }));
    }
    fs.writeFileSync(path.join(dir, `recente-${r}.jsonl`), linhas.join("\n") + "\n");
  }
}

function rodarTrabalhador(pastaPlus, home, vezes) {
  const raizProjetos = path.join(home, ".claude", "projects");
  const r = spawnSync(process.execPath, [__filename, "--trabalhador", pastaPlus, raizProjetos, String(vezes)], {
    encoding: "utf8",
    env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), TMPDIR: path.join(home, "tmp") },
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) throw new Error(`medida falhou em ${pastaPlus}:\n${r.stderr}`);
  return JSON.parse(r.stdout.trim().split("\n").pop());
}

// ---------------------------------------------------------------- painel web

function portaLivre() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

function get(porta, caminho, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port: porta, path: caminho, headers, agent: false }, (res) => {
      let n = 0;
      res.on("data", (d) => (n += d.length));
      res.on("end", () => resolve({ status: res.statusCode, bytes: n, etag: res.headers.etag || null, gzip: res.headers["content-encoding"] === "gzip" }));
    });
    req.on("error", reject);
    req.end();
  });
}

async function medirPainel(pastaServidor, tmp) {
  const dir = fs.mkdtempSync(path.join(tmp, "painel-"));
  const chave = path.join(dir, "chave");
  fs.writeFileSync(chave, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const [porta, admin] = [await portaLivre(), await portaLivre()];
  const p = spawn(process.execPath, [path.join(pastaServidor, "src", "server.js")], {
    env: {
      ...process.env,
      TLS_MODE: "off",
      PORT: String(porta),
      ADMIN_PORT: String(admin),
      PUBLIC_URL: `http://127.0.0.1:${porta}`,
      DATA_DIR: path.join(dir, "dados"),
      MASTER_KEY_FILE: chave,
      ADMIN_EMAILS: "admin@local.test",
      ALLOW_IPS: "127.0.0.1",
      NOTICES_ENABLED: "0",
      ANTHROPIC_API_BASE: "http://127.0.0.1:9",
      ANTHROPIC_TOKEN_URL: "http://127.0.0.1:9/v1/oauth/token",
      GOOGLE_CLIENT_ID_FILE: path.join(dir, "nao-existe"),
      GOOGLE_CLIENT_SECRET_FILE: path.join(dir, "nao-existe"),
    },
    stdio: "ignore",
  });
  try {
    const fim = Date.now() + 15000;
    for (;;) {
      try {
        if ((await get(admin, "/v1/health", {})).status === 200) break;
      } catch {}
      if (Date.now() > fim) throw new Error(`o servidor de ${pastaServidor} não subiu`);
      await new Promise((r) => setTimeout(r, 100));
    }
    const arquivos = ["/", "/static/app.js", "/static/app.css"];
    const primeira = [];
    const reabertura = [];
    for (const a of arquivos) {
      const r = await get(porta, a, { "Accept-Encoding": "gzip, deflate, br" });
      primeira.push({ arquivo: a, bytes: r.bytes, gzip: r.gzip });
      const h = { "Accept-Encoding": "gzip, deflate, br" };
      if (r.etag) h["If-None-Match"] = r.etag;
      const r2 = await get(porta, a, h);
      reabertura.push({ arquivo: a, status: r2.status, bytes: r2.bytes });
    }
    return { primeira, reabertura, total1: primeira.reduce((n, x) => n + x.bytes, 0), total2: reabertura.reduce((n, x) => n + x.bytes, 0) };
  } finally {
    p.kill("SIGTERM");
    await new Promise((r) => p.once("exit", r));
  }
}

// ---------------------------------------------------------------- principal

async function principal(args) {
  const ref = opcao(args, "--antes", "origin/main");
  const projetos = Number(opcao(args, "--projetos", 300));
  const arquivos = Number(opcao(args, "--arquivos", 40));
  const vezes = Number(opcao(args, "--vezes", 10));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-medir-"));
  try {
    // "Antes": o código de `ref`, extraído com git archive.
    const antes = path.join(tmp, "antes");
    fs.mkdirSync(antes);
    let commit;
    try {
      commit = execFileSync("git", ["rev-parse", "--short", ref], { cwd: RAIZ, encoding: "utf8" }).trim();
      const tar = execFileSync("git", ["archive", ref, "plus", "server"], { cwd: RAIZ, maxBuffer: 256 * 1024 * 1024 });
      execFileSync("tar", ["-x", "-C", antes], { input: tar });
    } catch (e) {
      console.error(`Não consegui extrair ${ref} com git archive (${e.message.split("\n")[0]}). Use --antes <ref> (ex.: main).`);
      return 1;
    }
    const depoisCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: RAIZ, encoding: "utf8" }).trim();
    const sujo = execFileSync("git", ["status", "--porcelain", "plus", "server"], { cwd: RAIZ, encoding: "utf8" }).trim() ? " + alterações não gravadas" : "";
    console.log(`Antes: ${ref} (${commit})   Depois: esta pasta (${depoisCommit}${sujo})`);
    console.log(`Montando ${projetos} projetos × ${arquivos} transcrições antigas + 5 recentes...`);
    const home = path.join(tmp, "home");
    fs.mkdirSync(path.join(home, "tmp"), { recursive: true });
    montarTranscricoes(path.join(home, ".claude", "projects"), projetos, arquivos);

    console.log(`Medindo as transcrições (${vezes} execuções de cada, antes e depois)...`);
    const tA = rodarTrabalhador(path.join(antes, "plus"), home, vezes);
    const tD = rodarTrabalhador(path.join(RAIZ, "plus"), home, vezes);
    console.log("Medindo o painel web (dois servidores locais em portas livres)...");
    const pA = await medirPainel(path.join(antes, "server"), tmp);
    const pD = await medirPainel(path.join(RAIZ, "server"), tmp);

    const r = (x) => Math.round(x);
    const pct = (d, a) => (a ? `${Math.round((d / a) * 100)}%` : "-");
    const linhas = [
      ["scanLimitErrors — mediana (ms)", r(mediana(tA.scan)), r(mediana(tD.scan)), pct(mediana(tD.scan), mediana(tA.scan)), "≤ 40%"],
      ["detectModels — mediana (ms)", r(mediana(tA.detect)), r(mediana(tD.detect)), pct(mediana(tD.detect), mediana(tA.detect)), ""],
      ["scanLimitErrors — 1ª execução, fria (ms)", r(tA.fria.scan), r(tD.fria.scan), pct(tD.fria.scan, tA.fria.scan), ""],
      ["varreduras completas/min, 3 janelas", tA.varreduras, tD.varreduras, pct(tD.varreduras, tA.varreduras), "antes 18, depois ≤ 4"],
      ["painel: 1ª abertura com gzip (bytes)", pA.total1, pD.total1, pct(pD.total1, pA.total1), "≤ 30%"],
      ["painel: reabertura com If-None-Match (bytes)", pA.total2, pD.total2, pct(pD.total2, pA.total2), "0 (304)"],
    ];
    const w = [46, 10, 10, 8, 22];
    const fmt = (cols) => cols.map((c, i) => String(c).padEnd(w[i])).join(" ");
    console.log("\n" + fmt(["medida", "antes", "depois", "dep/ant", "meta"]));
    console.log(fmt(w.map((n) => "-".repeat(n))));
    for (const l of linhas) console.log(fmt(l));
    console.log(`\nReabertura (depois): ${pD.reabertura.map((x) => `${x.arquivo} → ${x.status}, ${x.bytes} bytes`).join("; ")}`);
    console.log(`Conferência (as duas versões acham o mesmo): limite em ${tA.conferencia.limite} / ${tD.conferencia.limite}; modelos ${tA.conferencia.modelos.join(",")} / ${tD.conferencia.modelos.join(",")}`);
    const metas = {
      scan40: mediana(tD.scan) <= 0.4 * mediana(tA.scan),
      varreduras: tA.varreduras === 18 && tD.varreduras <= 4,
      gzip30: pD.total1 <= 0.3 * pA.total1,
      reabertura304: pD.reabertura.every((x) => x.status === 304 && x.bytes === 0),
      mesmoResultado: tA.conferencia.limite === tD.conferencia.limite && tA.conferencia.modelos.join() === tD.conferencia.modelos.join(),
    };
    const out = {
      quando: new Date().toISOString(),
      node: process.version,
      maquina: `${os.platform()} ${os.arch()}, ${os.cpus().length} CPU`,
      antes: { ref, commit },
      depois: { commit: depoisCommit + sujo },
      transcricoes: { projetos, arquivos, recentes: 5, vezes, antes: tA, depois: tD },
      painel: { antes: pA, depois: pD },
      metas,
    };
    fs.mkdirSync(DADOS, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(DADOS, "medidas.json"), JSON.stringify(out, null, 2) + "\n");
    const ok = Object.values(metas).every(Boolean);
    console.log(`\nMetas: ${Object.entries(metas).map(([k, v]) => `${k} ${v ? "ok" : "NÃO"}`).join(" · ")}`);
    console.log(`Gravado em ${path.relative(process.cwd(), path.join(DADOS, "medidas.json"))}`);
    return ok ? 0 : 1;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === "--trabalhador") {
    trabalhador(args[1], args[2], Number(args[3]) || 10).then(
      () => process.exit(0),
      (e) => {
        console.error(e && e.stack ? e.stack : e);
        process.exit(1);
      }
    );
  } else {
    principal(args).then(
      (c) => process.exit(c),
      (e) => {
        console.error(e && e.stack ? e.stack : e);
        process.exit(1);
      }
    );
  }
}
