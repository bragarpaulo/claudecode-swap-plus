"use strict";
// Nomes dos serviços: comparação ("é o mesmo nome?") e corte por tamanho sem quebrar emoji.
//
// Regra (aprovada em 2026-11-25): dois serviços não podem ter o mesmo nome. "Mesmo nome" não diferencia
// maiúsculas em nenhum alfabeto (NoteWin = notewin, ÇAÇA = çaça, Σ = σ = ς), ignora espaços nas pontas e
// espaços repetidos, mas o acento conta (José ≠ Jose). A forma composta e a decomposta do mesmo acento são iguais.

/**
 * Chave de comparação do nome. toUpperCase().toLowerCase() é o "case folding" completo disponível no
 * JavaScript sem biblioteca: junta σ/ς/Σ e ß/SS. NFC antes e depois junta as formas do mesmo acento.
 * NFKC não: juntaria caracteres diferentes (ﬁ e fi).
 */
function chaveNome(s) {
  return String(s == null ? "" : s)
    .normalize("NFC")
    .replace(/\s+/gu, " ")
    .trim()
    .toUpperCase()
    .toLowerCase()
    .normalize("NFC");
}

/** Corta o texto em `max` pontos de código (nunca deixa meio emoji / surrogate solto). */
function cortar(s, max) {
  const t = String(s == null ? "" : s);
  if (t.length <= max) return t; // caminho rápido: em unidades UTF-16 já cabe
  return [...t].slice(0, max).join("");
}

/**
 * Serviço com o mesmo nome (pela chaveNome) em `devices` (objeto id → serviço), ou null.
 * `ignorar`: id(s) que ficam fora da conferência (o próprio serviço, ou o que está sendo substituído).
 */
function nomeEmUso(devices, nome, ignorar = []) {
  const fora = new Set((Array.isArray(ignorar) ? ignorar : [ignorar]).filter(Boolean));
  const k = chaveNome(nome);
  for (const d of Object.values(devices || {})) {
    if (!d || typeof d !== "object" || fora.has(d.id)) continue;
    if (chaveNome(d.name) === k) return d;
  }
  return null;
}

const NOME_EM_USO_MSG = "Já existe um serviço com este nome; escolha outro ou desconecte o antigo no painel.";

module.exports = { chaveNome, cortar, nomeEmUso, NOME_EM_USO_MSG };
