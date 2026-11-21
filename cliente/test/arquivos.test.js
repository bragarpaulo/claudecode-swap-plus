"use strict";
// Testes de src/arquivos.js: leitura tolerante, gravação atômica (0600, sem temporário esquecido) e a trava
// "um só cliente rodando por pasta de dados". Só pastas temporárias.
// Rodar:  node --test cliente/test/*.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { pastaTemp } = require("./apoio");
const { lerJson, gravarJson, garantirPasta, apagar, travar, erro } = require("../src/arquivos");

const POSIX = process.platform !== "win32";
const MIN = 60 * 1000;

function pasta(t) {
  const dir = pastaTemp("swap-plus-arquivos-");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const modo = (caminho) => fs.statSync(caminho).mode & 0o777;

// ------------------------------------------------------------------ gravarJson

test("gravarJson: cria a pasta que falta, grava JSON legível (0600) e não deixa temporário", async (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "dados", "dentro", "estado.json");
  await gravarJson(arquivo, { numero: 1, texto: "acentuação", lista: [1, 2], nada: null });

  const texto = fs.readFileSync(arquivo, "utf8");
  assert.deepEqual(JSON.parse(texto), { numero: 1, texto: "acentuação", lista: [1, 2], nada: null });
  assert.ok(texto.endsWith("}\n"), "termina com quebra de linha");
  assert.ok(texto.includes('\n  "numero": 1'), "indentado, para a pessoa conseguir ler");
  assert.deepEqual(fs.readdirSync(path.dirname(arquivo)), ["estado.json"], "nenhum .tmp ficou para trás");
  if (POSIX) {
    assert.equal(modo(arquivo), 0o600);
    assert.equal(modo(path.join(dir, "dados")), 0o700, "a pasta criada é só do dono");
    assert.equal(modo(path.join(dir, "dados", "dentro")), 0o700);
  }
});

test("gravarJson por cima: troca o conteúdo inteiro e o arquivo fica 0600 mesmo que o antigo fosse mais aberto", async (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "estado.json");
  fs.writeFileSync(arquivo, JSON.stringify({ antigo: true, comprido: "x".repeat(5000) }), { mode: 0o644 });
  if (POSIX) fs.chmodSync(arquivo, 0o644);

  await gravarJson(arquivo, { novo: 1 });
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, "utf8")), { novo: 1 });
  assert.deepEqual(fs.readdirSync(dir), ["estado.json"]);
  if (POSIX) assert.equal(modo(arquivo), 0o600);

  await gravarJson(arquivo, { novo: 2 });
  assert.deepEqual(lerJson(arquivo), { novo: 2 });
  assert.deepEqual(fs.readdirSync(dir), ["estado.json"]);
});

test("gravarJson com outro modo pedido", { skip: !POSIX && "permissões POSIX não valem no Windows" }, async (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "publico.json");
  await gravarJson(arquivo, { a: 1 }, 0o640);
  assert.equal(modo(arquivo), 0o640);
});

test("gravarJson que falha no meio: lança, não deixa temporário e o arquivo que já existia fica inteiro", async (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "estado.json");
  await gravarJson(arquivo, { valor: "antes" });

  const circular = { nome: "não dá para virar JSON" };
  circular.eu = circular;
  await assert.rejects(gravarJson(arquivo, circular), TypeError);
  assert.deepEqual(fs.readdirSync(dir), ["estado.json"], "o temporário aberto foi apagado");
  assert.deepEqual(lerJson(arquivo), { valor: "antes" });

  // Arquivo novo: a falha não deixa nem o arquivo nem o temporário.
  const outro = path.join(dir, "outro.json");
  await assert.rejects(gravarJson(outro, circular), TypeError);
  assert.deepEqual(fs.readdirSync(dir), ["estado.json"]);
});

test("gravarJson: a pasta-mãe é um arquivo → lança sem deixar nada", async (t) => {
  const dir = pasta(t);
  fs.writeFileSync(path.join(dir, "nao-e-pasta"), "x");
  await assert.rejects(gravarJson(path.join(dir, "nao-e-pasta", "estado.json"), { a: 1 }), (e) => ["ENOTDIR", "EEXIST", "ENOENT"].includes(e.code));
  assert.deepEqual(fs.readdirSync(dir), ["nao-e-pasta"]);
  assert.equal(fs.readFileSync(path.join(dir, "nao-e-pasta"), "utf8"), "x");
});

test("gravarJson: gravações seguidas do mesmo arquivo deixam sempre um JSON inteiro, o da última", async (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "situacao.json");
  for (let i = 0; i < 20; i++) {
    await gravarJson(arquivo, { ciclo: i, enchimento: "y".repeat(i * 100) });
    assert.equal(lerJson(arquivo).ciclo, i);
  }
  assert.deepEqual(fs.readdirSync(dir), ["situacao.json"]);
});

// ------------------------------------------------------------------ lerJson

test("lerJson: arquivo que não existe → null", (t) => {
  const dir = pasta(t);
  assert.equal(lerJson(path.join(dir, "nao-existe.json")), null);
  assert.equal(lerJson(path.join(dir, "pasta-que-nao-existe", "x.json")), null);
});

test("lerJson: JSON quebrado, vazio, lista ou valor solto → lança arquivo_ilegivel, com o caminho", (t) => {
  const dir = pasta(t);
  const casos = { "quebrado.json": '{ "a": 1', "vazio.json": "", "lista.json": "[1, 2]", "numero.json": "42", "texto.json": '"oi"', "nulo.json": "null" };
  for (const [nome, conteudo] of Object.entries(casos)) {
    const arquivo = path.join(dir, nome);
    fs.writeFileSync(arquivo, conteudo);
    assert.throws(
      () => lerJson(arquivo),
      (e) => {
        assert.equal(e.code, "arquivo_ilegivel", nome);
        assert.equal(e.file, arquivo);
        assert.ok(e.message.includes(arquivo), "a mensagem diz qual arquivo");
        return true;
      }
    );
  }
});

test("lerJson: uma pasta no lugar do arquivo → arquivo_ilegivel (não é o mesmo que não existir)", (t) => {
  const dir = pasta(t);
  fs.mkdirSync(path.join(dir, "e-pasta.json"));
  assert.throws(() => lerJson(path.join(dir, "e-pasta.json")), { code: "arquivo_ilegivel" });
});

test("lerJson devolve o objeto gravado, com espaços e quebras de linha em volta", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "ok.json");
  fs.writeFileSync(arquivo, '\n  { "a": { "b": [1] } }  \n');
  assert.deepEqual(lerJson(arquivo), { a: { b: [1] } });
});

// ------------------------------------------------------------------ apagar, garantirPasta, erro

test("apagar: true quando apagou, false quando não havia; garantirPasta aceita pasta que já existe; erro() leva código e extras", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "x.json");
  fs.writeFileSync(arquivo, "{}");
  assert.equal(apagar(arquivo), true);
  assert.equal(fs.existsSync(arquivo), false);
  assert.equal(apagar(arquivo), false);

  garantirPasta(path.join(dir, "a", "b"));
  garantirPasta(path.join(dir, "a", "b"));
  assert.ok(fs.statSync(path.join(dir, "a", "b")).isDirectory());
  if (POSIX) assert.equal(modo(path.join(dir, "a", "b")), 0o700);

  const e = erro("meu_codigo", "minha mensagem", { status: 200, file: "x" });
  assert.ok(e instanceof Error);
  assert.equal(e.code, "meu_codigo");
  assert.equal(e.message, "minha mensagem");
  assert.equal(e.status, 200);
  assert.equal(e.file, "x");
});

// ------------------------------------------------------------------ travar

test("travar: a primeira pega (arquivo 0600 com id, pid e hora); a segunda na mesma pasta é recusada", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "dados", "rodando.json");
  const relogio = { t: Date.now() };
  const agora = () => relogio.t;

  const primeira = travar(arquivo, { agora });
  assert.ok(primeira, "a primeira trava é concedida (e a pasta é criada)");
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, "utf8")), { id: primeira.id, pid: process.pid, em: relogio.t });
  if (POSIX) assert.equal(modo(arquivo), 0o600);

  assert.equal(travar(arquivo, { agora }), null, "outro cliente na mesma pasta é recusado");
  relogio.t += 3 * MIN; // exatamente no limite ainda está viva
  assert.equal(travar(arquivo, { agora }), null);
  assert.equal(JSON.parse(fs.readFileSync(arquivo, "utf8")).id, primeira.id, "a tentativa recusada não mexe na trava");
});

test("travar: trava velha (dono morto sem soltar) é tomada; o dono antigo percebe no renovar() e o soltar() dele não apaga a do novo", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "rodando.json");
  const relogio = { t: Date.now() };
  const agora = () => relogio.t;

  const antiga = travar(arquivo, { agora });
  relogio.t += 3 * MIN + 1;
  const nova = travar(arquivo, { agora });
  assert.ok(nova, "passados 3 min sem renovar, a trava pode ser tomada");
  assert.notEqual(nova.id, antiga.id);
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, "utf8")), { id: nova.id, pid: process.pid, em: relogio.t });

  assert.equal(antiga.renovar(), false, "o dono antigo descobre que perdeu a trava");
  assert.equal(JSON.parse(fs.readFileSync(arquivo, "utf8")).id, nova.id, "e o renovar() dele não escreve por cima");
  antiga.soltar();
  assert.ok(fs.existsSync(arquivo), "o soltar() de quem perdeu não apaga a trava do novo dono");
  assert.equal(nova.renovar(), true);

  nova.soltar();
  assert.equal(fs.existsSync(arquivo), false);
});

test("travar: renovar() atualiza a hora e mantém a trava viva", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "rodando.json");
  const relogio = { t: Date.now() };
  const agora = () => relogio.t;

  const minha = travar(arquivo, { agora });
  for (let i = 0; i < 8; i++) {
    relogio.t += MIN; // 8 min ao todo, renovando a cada minuto
    assert.equal(minha.renovar(), true);
    assert.equal(JSON.parse(fs.readFileSync(arquivo, "utf8")).em, relogio.t);
    assert.equal(travar(arquivo, { agora }), null, "renovada, ninguém toma");
  }
  assert.deepEqual(fs.readdirSync(dir), ["rodando.json"], "renovar não deixa temporário para trás");
  relogio.t += 3 * MIN + 1;
  assert.ok(travar(arquivo, { agora }), "sem renovar por mais de 3 min, pode ser tomada");
});

test("travar: renovar() que não consegue regravar agora não entrega a trava (ela continua deste processo)", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "rodando.json");
  const relogio = { t: Date.now() };
  const agora = () => relogio.t;

  const minha = travar(arquivo, { agora });
  const t0 = relogio.t;
  // Algo impede a regravação (aqui: uma pasta no lugar do temporário que o renovar usa).
  const estorvo = `${arquivo}.${minha.id}.tmp`;
  fs.mkdirSync(estorvo);
  relogio.t += MIN;
  assert.equal(minha.renovar(), true, "a trava continua sendo deste processo");
  assert.deepEqual(JSON.parse(fs.readFileSync(arquivo, "utf8")), { id: minha.id, pid: process.pid, em: t0 }, "o arquivo ficou como estava");
  assert.equal(travar(arquivo, { agora }), null);

  fs.rmdirSync(estorvo);
  relogio.t += MIN;
  assert.equal(minha.renovar(), true);
  assert.equal(JSON.parse(fs.readFileSync(arquivo, "utf8")).em, relogio.t, "passado o problema, volta a renovar");
});

test("travar: velhoMs muda o prazo para a trava ser considerada velha", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "rodando.json");
  const relogio = { t: Date.now() };
  const agora = () => relogio.t;

  travar(arquivo, { agora, velhoMs: 1000 });
  relogio.t += 1000;
  assert.equal(travar(arquivo, { agora, velhoMs: 1000 }), null);
  relogio.t += 1;
  assert.ok(travar(arquivo, { agora, velhoMs: 1000 }));
});

test("travar: arquivo de trava ilegível, vazio ou sem hora é tomado", (t) => {
  const dir = pasta(t);
  for (const [i, lixo] of ["{ quebrado", "", "{}", '{"id":"x","pid":1,"em":"ontem"}', "[]", "null"].entries()) {
    const arquivo = path.join(dir, `rodando-${i}.json`);
    fs.writeFileSync(arquivo, lixo);
    const trava = travar(arquivo);
    assert.ok(trava, `trava com conteúdo ${JSON.stringify(lixo)} é tomada`);
    assert.equal(JSON.parse(fs.readFileSync(arquivo, "utf8")).id, trava.id);
  }
});

test("travar: soltar() libera para o próximo; soltar de novo, ou renovar depois de soltar, não faz mal", (t) => {
  const dir = pasta(t);
  const arquivo = path.join(dir, "rodando.json");

  const primeira = travar(arquivo);
  assert.ok(primeira);
  primeira.soltar();
  assert.equal(fs.existsSync(arquivo), false);
  primeira.soltar();
  assert.equal(primeira.renovar(), false, "depois de soltar, a trava não é mais dela");
  assert.equal(fs.existsSync(arquivo), false, "e o renovar() não recria o arquivo");

  const segunda = travar(arquivo);
  assert.ok(segunda, "liberada, o próximo pega na hora");
  primeira.soltar();
  assert.ok(fs.existsSync(arquivo), "o soltar() atrasado da primeira não apaga a trava da segunda");
  assert.equal(segunda.renovar(), true);
  segunda.soltar();
});

test("travar: duas pastas de dados diferentes não se atrapalham", (t) => {
  const dir = pasta(t);
  const a = travar(path.join(dir, "a", "rodando.json"));
  const b = travar(path.join(dir, "b", "rodando.json"));
  assert.ok(a && b);
  assert.notEqual(a.id, b.id);
  a.soltar();
  assert.equal(b.renovar(), true);
  b.soltar();
});
