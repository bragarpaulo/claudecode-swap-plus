"use strict";
// Testes de src/atividade.js: o que o cliente descobre olhando a pasta de login do Claude Code — último uso,
// modelos em uso e erro de limite nas transcrições. Só pastas temporárias; as datas dos arquivos são postas à mão.
// Rodar:  node --test cliente/test/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { pastaTemp, definirMtime, gravarTranscricao, linhaDeLimite, linhaDeModelo } = require("./apoio");
const { detectar, ehProprio, JANELA_MODELOS_MS } = require("../src/atividade");

const SEG = 1000;
const MIN = 60 * SEG;
const AGORA = Math.floor(Date.now() / 1000) * 1000; // segundo inteiro: vale em qualquer sistema de arquivos
const VELHO = AGORA - 24 * 60 * MIN;

/** Pasta de login temporária (ainda sem nada dentro). */
function pastaDeLogin(t) {
  const raiz = pastaTemp("swap-plus-atividade-");
  t.after(() => fs.rmSync(raiz, { recursive: true, force: true }));
  const pasta = path.join(raiz, "claude");
  fs.mkdirSync(pasta);
  return pasta;
}

/**
 * Criar arquivos mexe na data das pastas em volta. Depois de montar o cenário, tudo o que está no primeiro
 * nível da pasta fica com data antiga; o teste então marca só o que interessa.
 */
function envelhecer(pasta) {
  for (const nome of fs.readdirSync(pasta)) definirMtime(path.join(pasta, nome), VELHO);
}

test("pasta que não existe, ou vazia: nunca usada, sem modelos e sem limite", async (t) => {
  const pasta = pastaDeLogin(t);
  const nada = { ultimaAtividade: 0, modelos: [], limite: null };
  assert.deepEqual(await detectar(path.join(pasta, "nao-existe"), { agora: AGORA, desdeLimite: 0 }), nada);
  assert.deepEqual(await detectar(pasta, { agora: AGORA, desdeLimite: 0 }), nada);
  assert.deepEqual(await detectar(pasta), nada, "as opções são opcionais");
});

test("o que o próprio cliente grava (login, identidade, travas, temporários) não conta como uso", async (t) => {
  const pasta = pastaDeLogin(t);
  for (const arquivo of [".credentials.json", ".claude.json", ".config.json", ".credentials.json.1234.a1b2c3d4.tmp", ".claude.json.1234.a1b2c3d4.tmp"]) {
    fs.writeFileSync(path.join(pasta, arquivo), "{}");
    definirMtime(path.join(pasta, arquivo), AGORA);
  }
  for (const trava of [".oauth_refresh.lock", ".storage-write.lock", ".claude.json.lock", ".oauth_refresh.lock.takeover"]) {
    fs.mkdirSync(path.join(pasta, trava));
    definirMtime(path.join(pasta, trava), AGORA);
  }
  const r = await detectar(pasta, { agora: AGORA, desdeLimite: 0 });
  assert.equal(r.ultimaAtividade, 0);

  for (const nome of [".credentials.json", ".claude.json", ".config.json", "x.lock", "X.LOCK", "y.takeover", "z.tmp"]) assert.equal(ehProprio(nome), true, nome);
  for (const nome of ["sessions", "projects", "policy-limits.json", "settings.json", "credentials.json", "lock", "tmp", ".lockfile"]) assert.equal(ehProprio(nome), false, nome);
});

test("sessions/ e os outros arquivos que o Claude Code mexe no primeiro nível contam como uso, mesmo sem transcrição", async (t) => {
  const pasta = pastaDeLogin(t);
  fs.mkdirSync(path.join(pasta, "sessions"));
  fs.writeFileSync(path.join(pasta, "policy-limits.json"), "{}");
  fs.writeFileSync(path.join(pasta, ".credentials.json"), "{}");
  envelhecer(pasta);
  definirMtime(path.join(pasta, ".credentials.json"), AGORA); // do próprio cliente: não conta

  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, VELHO);

  definirMtime(path.join(pasta, "sessions"), AGORA - 5 * MIN);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, AGORA - 5 * MIN, "a data de sessions/");

  definirMtime(path.join(pasta, "policy-limits.json"), AGORA - 2 * MIN);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, AGORA - 2 * MIN, "vale o mais recente");
});

test("transcrição alterada conta como uso, inclusive a de um subagente", async (t) => {
  const pasta = pastaDeLogin(t);
  fs.mkdirSync(path.join(pasta, "sessions"));
  const principal = gravarTranscricao(pasta, { nome: "conversa", linhas: [{ type: "user" }] });
  const sub = gravarTranscricao(pasta, { sessao: "conversa", nome: "agente-1", linhas: [{ type: "user" }] });
  envelhecer(pasta);
  definirMtime(principal, VELHO);
  definirMtime(sub, VELHO);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, VELHO);

  definirMtime(principal, AGORA - 3 * MIN);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, AGORA - 3 * MIN, "a data da transcrição");

  definirMtime(sub, AGORA - 1 * MIN);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, AGORA - 1 * MIN, "a data da transcrição do subagente");
});

test("data de arquivo no futuro (relógio adiantado) é limitada ao agora", async (t) => {
  const pasta = pastaDeLogin(t);
  fs.mkdirSync(path.join(pasta, "sessions"));
  definirMtime(path.join(pasta, "sessions"), AGORA + 60 * MIN);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, AGORA);

  const transcricao = gravarTranscricao(pasta, { linhas: [{ type: "user" }] });
  envelhecer(pasta);
  definirMtime(transcricao, AGORA + 3 * 60 * MIN);
  assert.equal((await detectar(pasta, { agora: AGORA })).ultimaAtividade, AGORA, "vale também para as transcrições");
});

test("modelos: só das transcrições principais alteradas nos últimos 30 min; subagente e transcrição antiga ficam de fora", async (t) => {
  const pasta = pastaDeLogin(t);
  gravarTranscricao(pasta, { nome: "recente", linhas: [linhaDeModelo("claude-fable-5-2")], mtime: AGORA - 1 * MIN });
  gravarTranscricao(pasta, { nome: "no-limite", linhas: [linhaDeModelo("claude-opus-5-5")], mtime: AGORA - JANELA_MODELOS_MS });
  gravarTranscricao(pasta, { nome: "antiga", linhas: [linhaDeModelo("claude-sonnet-5")], mtime: AGORA - JANELA_MODELOS_MS - SEG });
  gravarTranscricao(pasta, { sessao: "recente", nome: "agente-1", linhas: [linhaDeModelo("claude-haiku-5")], mtime: AGORA });
  gravarTranscricao(pasta, { projeto: "outro-projeto", nome: "outra", linhas: [linhaDeModelo("claude-opus-5-1")], mtime: AGORA - 10 * MIN });

  const r = await detectar(pasta, { agora: AGORA });
  assert.equal(JANELA_MODELOS_MS, 30 * MIN);
  assert.deepEqual(r.modelos, ["claude-fable-5-2", "claude-opus-5-1", "claude-opus-5-5"], "mais recente primeiro; exatamente 30 min ainda vale");
});

test("modelos: vale o último modelo de cada transcrição; o mesmo modelo em duas transcrições aparece uma vez, na posição da mais recente", async (t) => {
  const pasta = pastaDeLogin(t);
  gravarTranscricao(pasta, {
    nome: "a",
    linhas: [linhaDeModelo("claude-fable-5-2"), linhaDeModelo("claude-sonnet-5"), { type: "user", message: { content: "troca para o opus" } }, linhaDeModelo("claude-opus-5-5")],
    mtime: AGORA - 8 * MIN,
  });
  gravarTranscricao(pasta, { nome: "b", linhas: [linhaDeModelo("claude-haiku-5")], mtime: AGORA - 4 * MIN });
  gravarTranscricao(pasta, { nome: "c", linhas: [linhaDeModelo("claude-opus-5-5")], mtime: AGORA - 2 * MIN });
  gravarTranscricao(pasta, { projeto: "outro-projeto", nome: "d", linhas: [linhaDeModelo("claude-haiku-5")], mtime: AGORA - 6 * MIN });

  const r = await detectar(pasta, { agora: AGORA });
  assert.deepEqual(r.modelos, ["claude-opus-5-5", "claude-haiku-5"]);
});

test("modelos: o que não é claude-…, o que não é .jsonl e arquivo solto em projects/ não contam", async (t) => {
  const pasta = pastaDeLogin(t);
  gravarTranscricao(pasta, { nome: "sintetico", linhas: [linhaDeModelo("<synthetic>")], mtime: AGORA });
  gravarTranscricao(pasta, { nome: "outro", linhas: [linhaDeModelo("gpt-9")], mtime: AGORA });
  gravarTranscricao(pasta, { nome: "comprido", linhas: [linhaDeModelo("claude-" + "x".repeat(120))], mtime: AGORA });
  gravarTranscricao(pasta, { nome: "sem-modelo", linhas: [{ type: "user", message: { content: "oi" } }], mtime: AGORA });
  gravarTranscricao(pasta, { nome: "vazia", linhas: [], mtime: AGORA });
  const projeto = path.join(pasta, "projects", "projeto-de-teste");
  fs.writeFileSync(path.join(projeto, "notas.txt"), JSON.stringify(linhaDeModelo("claude-nao-e-transcricao")) + "\n");
  fs.writeFileSync(path.join(pasta, "projects", "solta.jsonl"), JSON.stringify(linhaDeModelo("claude-fora-de-projeto")) + "\n");
  // Com espaço depois dos dois-pontos não é como o Claude Code grava: não é lido.
  fs.writeFileSync(path.join(projeto, "formatado.jsonl"), '{"message": {"model": "claude-com-espaco"}}\n');

  const r = await detectar(pasta, { agora: AGORA });
  assert.deepEqual(r.modelos, []);
});

test("limite: procura também nas transcrições de subagentes (que não servem para os modelos) e devolve o erro", async (t) => {
  const pasta = pastaDeLogin(t);
  const ts = AGORA - 30 * SEG;
  const renova = Math.floor(AGORA / 1000) + 3600;
  gravarTranscricao(pasta, {
    sessao: "conversa",
    nome: "agente-1",
    linhas: [
      linhaDeModelo("claude-haiku-5"),
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: "rate_limit",
        timestamp: new Date(ts).toISOString(),
        quotaLimits: { status: "rejected", resetsAt: renova, rateLimitType: "seven_day_overage_included" },
        message: { model: "<synthetic>", content: [{ type: "text", text: "You've hit your Fable limit" }, { type: "text", text: "Switch to another model to continue." }] },
      },
    ],
    mtime: AGORA,
  });

  const r = await detectar(pasta, { agora: AGORA, desdeLimite: AGORA - 10 * MIN });
  assert.deepEqual(r.modelos, [], "transcrição de subagente não entra nos modelos");
  assert.deepEqual(r.limite, { ts, text: "You've hit your Fable limit Switch to another model to continue.", rateLimitType: "seven_day_overage_included", resetsAt: renova * 1000 });
});

test("limite: desdeLimite null (ou ausente) não procura; 0 procura tudo", async (t) => {
  const pasta = pastaDeLogin(t);
  gravarTranscricao(pasta, { linhas: [linhaDeLimite("You've hit your session limit · resets 3pm", AGORA - MIN)], mtime: AGORA });

  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: null })).limite, null);
  assert.equal((await detectar(pasta, { agora: AGORA })).limite, null);
  const r = await detectar(pasta, { agora: AGORA, desdeLimite: 0 });
  assert.equal(r.limite.ts, AGORA - MIN);
  assert.equal(r.limite.text, "You've hit your session limit · resets 3pm");
  assert.equal(r.limite.rateLimitType, null);
  assert.equal(r.limite.resetsAt, null);
});

test("limite: só erros depois de desdeLimite, em arquivos alterados depois de desdeLimite; entre vários, o mais novo", async (t) => {
  const pasta = pastaDeLogin(t);
  const desde = AGORA - 10 * MIN;
  // Erro novo, mas num arquivo que não mudou desde então (data antiga): nem é aberto.
  gravarTranscricao(pasta, { nome: "parada", linhas: [linhaDeLimite("erro em arquivo parado", AGORA - MIN)], mtime: desde });
  // Arquivo alterado depois, com um erro antigo e outro exatamente no instante de corte: não contam.
  gravarTranscricao(pasta, { nome: "antigos", linhas: [linhaDeLimite("erro antigo", desde - MIN), linhaDeLimite("erro no instante de corte", desde)], mtime: AGORA });
  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: desde })).limite, null);

  gravarTranscricao(pasta, { nome: "novos", linhas: [linhaDeLimite("primeiro", desde + 2 * MIN), linhaDeLimite("o mais novo", desde + 5 * MIN), linhaDeLimite("segundo", desde + 3 * MIN)], mtime: AGORA });
  gravarTranscricao(pasta, { projeto: "outro-projeto", nome: "outro", linhas: [linhaDeLimite("de outro projeto", desde + 4 * MIN)], mtime: AGORA });
  const r = await detectar(pasta, { agora: AGORA, desdeLimite: desde });
  assert.equal(r.limite.text, "o mais novo");
  assert.equal(r.limite.ts, desde + 5 * MIN);

  // Avançando o corte para o erro já visto, ele não volta.
  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: desde + 5 * MIN })).limite, null);
});

test("limite: só a mensagem marcada pelo Claude Code conta; conversa que cita o erro, outros erros e linhas quebradas não", async (t) => {
  const pasta = pastaDeLogin(t);
  const ts = new Date(AGORA - MIN).toISOString();
  gravarTranscricao(pasta, {
    linhas: [
      { type: "user", timestamp: ts, message: { content: "o print mostra You've hit your session limit · resets 3pm" } },
      { type: "assistant", isApiErrorMessage: true, error: "overloaded", timestamp: ts, message: { content: [{ type: "text", text: "Overloaded" }] } },
      { type: "assistant", isApiErrorMessage: false, error: "rate_limit", timestamp: ts, message: { content: [{ type: "text", text: "não é erro da API" }] } },
      { type: "assistant", error: "rate_limit", timestamp: ts, message: { content: [{ type: "text", text: 'cita "isApiErrorMessage":true no texto' }] } },
      '{"isApiErrorMessage":true,"error":"rate_limit","timestamp":"' + ts + '","message":{"content":[{"type":"text","text":"linha cortada no me',
    ],
    mtime: AGORA,
  });
  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: 0 })).limite, null);
});

test("limite: linha sem data vale a data do arquivo; texto simples e rate_limit_info também são lidos", async (t) => {
  const pasta = pastaDeLogin(t);
  const renova = Math.floor(AGORA / 1000) + 1800;
  gravarTranscricao(pasta, {
    nome: "sem-data",
    linhas: [{ type: "assistant", isApiErrorMessage: true, error: "rate_limit", message: { content: "You've hit your weekly limit" }, apiErrorParams: { rate_limit_info: { rateLimitType: "seven_day", resetsAt: renova } } }],
    mtime: AGORA - 2 * MIN,
  });
  const r = await detectar(pasta, { agora: AGORA, desdeLimite: AGORA - 10 * MIN });
  assert.deepEqual(r.limite, { ts: AGORA - 2 * MIN, text: "You've hit your weekly limit", rateLimitType: "seven_day", resetsAt: renova * 1000 });
});

test("transcrição grande: só o fim do arquivo é lido, e a primeira linha cortada não atrapalha", async (t) => {
  const pasta = pastaDeLogin(t);
  const enchimento = { type: "user", message: { content: "x".repeat(1000) } };
  const linhas = [linhaDeLimite("erro lá no começo do arquivo", AGORA - 5 * MIN), linhaDeModelo("claude-do-comeco")];
  for (let i = 0; i < 400; i++) linhas.push(enchimento); // ~400 KB: passa das duas caudas (128 KB e 256 KB)
  gravarTranscricao(pasta, { nome: "grande", linhas, mtime: AGORA });

  let r = await detectar(pasta, { agora: AGORA, desdeLimite: 0 });
  assert.deepEqual(r.modelos, [], "o modelo citado só no começo de um arquivo grande não é visto");
  assert.equal(r.limite, null, "nem o erro que ficou para trás");

  const arquivo = path.join(pasta, "projects", "projeto-de-teste", "grande.jsonl");
  fs.appendFileSync(arquivo, JSON.stringify(linhaDeModelo("claude-fable-5-2")) + "\n" + JSON.stringify(linhaDeLimite("erro no fim", AGORA - MIN)) + "\n");
  definirMtime(arquivo, AGORA);
  r = await detectar(pasta, { agora: AGORA, desdeLimite: 0 });
  assert.deepEqual(r.modelos, ["claude-fable-5-2"]);
  assert.equal(r.limite.text, "erro no fim");
});

// ------------------------------------------------------------------ aviso de limite deixado na pasta (1.1.0)

/** Quem chama o Claude Code (o Hermes) deixa o aviso em swap-plus/limite.json, dentro da pasta de login. */
function avisar(pasta, corpo) {
  const dir = path.join(pasta, "swap-plus");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "limite.json"), typeof corpo === "string" ? corpo : JSON.stringify(corpo));
}

test("aviso de limite na pasta (swap-plus/limite.json): vale quando é mais novo que desdeLimite; a pasta dos recados não conta como uso", async (t) => {
  const pasta = pastaDeLogin(t);
  avisar(pasta, { at: AGORA - 10 * SEG });
  definirMtime(path.join(pasta, "swap-plus"), AGORA);
  const r = await detectar(pasta, { agora: AGORA, desdeLimite: AGORA - MIN });
  assert.deepEqual(r.limite, { ts: AGORA - 10 * SEG, text: "", rateLimitType: null, resetsAt: null, aviso: true });
  assert.equal(r.ultimaAtividade, 0, "o recado não é sinal de uso do Claude Code");
  assert.equal(ehProprio("swap-plus"), true);

  // Mais velho que desdeLimite (já avisado, ou de antes de o cliente subir): não vale.
  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: AGORA - 10 * SEG })).limite, null);
  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: AGORA })).limite, null);
  // desdeLimite null: não procura.
  assert.equal((await detectar(pasta, { agora: AGORA })).limite, null);
});

test("aviso de limite: texto, tipo e hora de renovação passam adiante; arquivo quebrado, sem data ou com data no futuro não vale", async (t) => {
  const pasta = pastaDeLogin(t);
  const TEXTO = "You have hit your Fable limit · resets 10pm";
  avisar(pasta, { at: AGORA - SEG, text: TEXTO, rateLimitType: "seven_day_overage_included", resetsAt: AGORA + 60 * MIN, outra: "coisa" });
  assert.deepEqual((await detectar(pasta, { agora: AGORA, desdeLimite: 0 })).limite, {
    ts: AGORA - SEG,
    text: TEXTO,
    rateLimitType: "seven_day_overage_included",
    resetsAt: AGORA + 60 * MIN,
    aviso: true,
  });
  avisar(pasta, { at: AGORA - SEG, text: "x".repeat(1000), rateLimitType: 7, resetsAt: "amanhã" });
  const longo = (await detectar(pasta, { agora: AGORA, desdeLimite: 0 })).limite;
  assert.equal(longo.text.length, 400);
  assert.equal(longo.rateLimitType, null);
  assert.equal(longo.resetsAt, null);

  for (const ruim of ["{ isto não é json", "[]", '"texto"', JSON.stringify({ text: "sem data" }), JSON.stringify({ at: "ontem" }), JSON.stringify({ at: AGORA + 6 * MIN })]) {
    avisar(pasta, ruim);
    assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: 0 })).limite, null, ruim);
  }
  avisar(pasta, { at: AGORA + 4 * MIN }); // relógios um pouco diferentes entre quem avisa e o cliente: vale
  assert.equal((await detectar(pasta, { agora: AGORA, desdeLimite: 0 })).limite.ts, AGORA + 4 * MIN);
});

test("aviso de limite e erro na transcrição ao mesmo tempo: vale o mais novo dos dois", async (t) => {
  const pasta = pastaDeLogin(t);
  gravarTranscricao(pasta, { linhas: [linhaDeLimite("You have hit your session limit · resets 3pm", AGORA - 30 * SEG)], mtime: AGORA - 30 * SEG });
  avisar(pasta, { at: AGORA - 5 * SEG });
  let r = await detectar(pasta, { agora: AGORA, desdeLimite: AGORA - MIN });
  assert.equal(r.limite.aviso, true, "o aviso é mais novo");
  avisar(pasta, { at: AGORA - 50 * SEG });
  r = await detectar(pasta, { agora: AGORA, desdeLimite: AGORA - MIN });
  assert.equal(r.limite.aviso, undefined, "o erro da transcrição é mais novo");
  assert.match(r.limite.text, /session limit/);
});
