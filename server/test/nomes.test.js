"use strict";
// Nome único dos serviços (2.8.0): chaveNome (o que conta como "o mesmo nome") e cortar (tamanho por ponto de código).

const test = require("node:test");
const assert = require("node:assert/strict");
const { chaveNome, cortar, nomeEmUso, NOME_EM_USO_MSG } = require("../src/nomes");

const igual = (a, b) => assert.equal(chaveNome(a), chaveNome(b), `${JSON.stringify(a)} devia ser igual a ${JSON.stringify(b)}`);
const diferente = (a, b) => assert.notEqual(chaveNome(a), chaveNome(b), `${JSON.stringify(a)} devia ser diferente de ${JSON.stringify(b)}`);

test("chaveNome: maiúsculas não contam em nenhum alfabeto (critérios 12 e 13)", () => {
  igual("NoteWin", "notewin");
  igual("NoteWin", "NOTEWIN");
  igual("ÇAÇA", "çaça");
  igual("Σίσυφος", "ΣΊΣΥΦΟΣ");
  igual("Σίσυφος", "σίσυφοσ"); // σ final (ς) = σ = Σ
  igual("straße", "STRASSE");
  diferente("Σίσυφος", "Sisyphos");
  diferente("Σίσυφος", "Σισυφος"); // sem acento
});

test("chaveNome: acento conta; composto e decomposto são iguais (critério 14)", () => {
  diferente("José", "Jose");
  igual("José", "José");
  igual("JOSÉ", "josé");
});

test("chaveNome: espaços nas pontas e repetidos não contam (critério 12)", () => {
  igual(" NoteWin ", "NoteWin");
  igual("Note  Win", "Note Win");
  igual("Note\tWin", "Note Win");
  igual("Note Win", "Note Win");
  diferente("NoteWin", "Note Win");
  assert.equal(chaveNome(null), "");
});

test("cortar: por ponto de código, nunca meio emoji (critério 23)", () => {
  const nome = "NoteWin 😀".repeat(10);
  const c = cortar(nome, 60);
  assert.equal([...c].length, 60);
  assert.ok(!/[\uD800-\uDFFF]/u.test(c.normalize()), "surrogate solto");
  assert.equal(cortar("abc", 60), "abc");
  assert.equal(cortar("😀😀😀", 2), "😀😀");
  assert.equal(cortar("x".repeat(59) + "😀😀", 60), "x".repeat(59) + "😀");
});

test("nomeEmUso: acha o outro serviço com o mesmo nome; o ignorado fica fora", () => {
  const devs = { a: { id: "a", name: "NoteWin" }, b: { id: "b", name: "Hermes" } };
  assert.equal(nomeEmUso(devs, "notewin").id, "a");
  assert.equal(nomeEmUso(devs, "notewin", ["a"]), null);
  assert.equal(nomeEmUso(devs, "Outro"), null);
  assert.equal(nomeEmUso({}, "x"), null);
  assert.equal(NOME_EM_USO_MSG, "Já existe um serviço com este nome; escolha outro ou desconecte o antigo no painel.");
});
