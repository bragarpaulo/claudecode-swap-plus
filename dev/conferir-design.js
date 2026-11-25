#!/usr/bin/env node
"use strict";
// Conferência automática do padrão visual que o próprio projeto declara (roda no `node dev/ambiente-local.js testes`).
//
//   server/web/app.css   tipos só na escala 12/13/14/15/16/18/22 px (topo do arquivo);
//                        cores literais (#hex, rgb(), rgba()) só nos blocos de definição de variáveis.
//   plus/media/panel.css "Cores: sempre as variáveis --vscode-* do tema": idem para as cores.
//
// Fora da regra (de propósito):
//   - blocos de definição de variáveis: :root (inclusive dentro de @media (prefers-color-scheme: light)),
//     body.vscode-light, body.vscode-dark, body.vscode-high-contrast;
//   - o segundo argumento de var(--x, <reserva>): é a cor de reserva quando o tema não define a variável;
//   - sombras pretas translúcidas (box-shadow/text-shadow com rgba(0, 0, 0, …)): escurecem o fundo em qualquer tema.
//
// Uso: node dev/conferir-design.js [arquivo.css ...]   → sai 0 (tudo certo) ou 1 (lista arquivo:linha de cada desvio).

const fs = require("fs");
const path = require("path");

const RAIZ = path.join(__dirname, "..");
const ESCALA = new Set([12, 13, 14, 15, 16, 18, 22]);
const ARQUIVOS = [
  { arq: "server/web/app.css", tipos: true },
  { arq: "plus/media/panel.css", tipos: false },
];
const BLOCO_DE_VARIAVEIS = /^(:root|body\.vscode-(light|dark|high-contrast))$/;
const COR = /#[0-9a-fA-F]{3,8}\b|\brgba?\(/;
const SOMBRA_PRETA = /\brgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*[\d.]+\s*\)/g;

/** Tira os comentários mantendo as quebras de linha (os números de linha continuam certos). */
function semComentarios(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
}

/** Tira o segundo argumento de cada var(--x, reserva) (com parênteses aninhados). */
function semReservas(valor) {
  let out = "";
  let i = 0;
  while (i < valor.length) {
    const k = valor.indexOf("var(", i);
    if (k < 0) {
      out += valor.slice(i);
      break;
    }
    out += valor.slice(i, k) + "var(";
    let j = k + 4;
    let nivel = 1;
    let virgula = -1;
    for (; j < valor.length && nivel > 0; j++) {
      const ch = valor[j];
      if (ch === "(") nivel++;
      else if (ch === ")") nivel--;
      else if (ch === "," && nivel === 1 && virgula < 0) virgula = j;
    }
    out += (virgula > 0 ? valor.slice(k + 4, virgula) : valor.slice(k + 4, j - 1)) + ")";
    i = j;
  }
  return out;
}

/** Declarações { prop, valor, linha, blocos (seletores de fora para dentro) } de um CSS. */
function declaracoes(css) {
  const texto = semComentarios(css);
  const out = [];
  const pilha = [];
  let buf = "";
  let inicioBuf = 1;
  let linha = 1;
  let aspas = null;
  const fecharDecl = () => {
    const d = buf.trim();
    const c = d.indexOf(":");
    if (c > 0 && pilha.length) {
      out.push({ prop: d.slice(0, c).trim().toLowerCase(), valor: d.slice(c + 1).trim(), linha: inicioBuf, blocos: [...pilha] });
    }
    buf = "";
    inicioBuf = linha;
  };
  for (const ch of texto) {
    if (aspas) {
      buf += ch;
      if (ch === aspas) aspas = null;
    } else if (ch === '"' || ch === "'") {
      aspas = ch;
      buf += ch;
    } else if (ch === "{") {
      pilha.push(buf.trim().replace(/\s+/g, " "));
      buf = "";
      inicioBuf = linha;
    } else if (ch === "}") {
      fecharDecl();
      pilha.pop();
    } else if (ch === ";") {
      fecharDecl();
    } else {
      buf += ch;
    }
    if (ch === "\n") linha++;
    if (!buf.trim()) inicioBuf = linha;
  }
  return out;
}

/** Os desvios de um arquivo: [{ arq, linha, motivo }]. */
function conferir(arq, css, { tipos = true } = {}) {
  const desvios = [];
  for (const d of declaracoes(css)) {
    const definicao = d.blocos.some((b) => b.split(",").every((sel) => BLOCO_DE_VARIAVEIS.test(sel.trim())));
    if (tipos && d.prop === "font-size") {
      for (const m of d.valor.matchAll(/(\d+(?:\.\d+)?)px/g)) {
        if (!ESCALA.has(Number(m[1]))) desvios.push({ arq, linha: d.linha, motivo: `font-size ${m[1]}px fora da escala (12/13/14/15/16/18/22 px)` });
      }
    }
    if (definicao) continue;
    let valor = semReservas(d.valor);
    if (d.prop === "box-shadow" || d.prop === "text-shadow" || d.prop === "--shadow" || d.prop === "--shadow-sm") valor = valor.replace(SOMBRA_PRETA, "");
    const m = COR.exec(valor);
    if (m) desvios.push({ arq, linha: d.linha, motivo: `cor literal "${m[0].replace(/\($/, "(")}" em ${d.prop} (use uma variável do tema)` });
  }
  return desvios;
}

function main(argv) {
  const alvos = argv.length ? argv.map((a) => ({ arq: a, tipos: /app\.css$/.test(a) })) : ARQUIVOS;
  let todos = [];
  for (const { arq, tipos } of alvos) {
    const cheio = path.isAbsolute(arq) ? arq : path.join(RAIZ, arq);
    const nome = cheio.startsWith(RAIZ + path.sep) ? path.relative(RAIZ, cheio) : arq;
    todos = todos.concat(conferir(nome, fs.readFileSync(cheio, "utf8"), { tipos }));
  }
  if (!todos.length) {
    console.log(`conferir-design: tudo certo (${alvos.map((a) => a.arq).join(", ")}).`);
    return 0;
  }
  for (const d of todos) console.error(`${d.arq}:${d.linha}: ${d.motivo}`);
  console.error(`conferir-design: ${todos.length} desvio(s) do padrão visual.`);
  return 1;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { conferir, declaracoes, semReservas };
