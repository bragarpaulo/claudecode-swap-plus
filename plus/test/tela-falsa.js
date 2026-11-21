"use strict";
// A tela de configurações (plus/media/panel.html + panel.js) rodando dentro do Node, para os testes.
//
// É um DOM mínimo de mentira: só o que o panel.js usa (criar elementos, textos, atributos, classes,
// eventos, foco) e um relógio falso para os temporizadores. Não desenha nada e não lê o CSS: serve para
// conferir que a tela não quebra com nenhum estado, o texto que ela escreve e as mensagens que ela
// manda para a extensão. O panel.html e o panel.js são os de verdade, lidos de plus/media.
//
//   const { abrirTela } = require("./tela-falsa");
//   const tela = abrirTela();          // carrega a tela; tela.levar() devolve o que ela mandou
//   tela.entregar(estado);             // como a extensão faz com postMessage
//   tela.clicar(tela.botao("Sair"));

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const MEDIA = path.join(__dirname, "..", "media");
const SEM_FILHOS = new Set(["meta", "link", "input", "br", "hr", "img"]);

class No {
  constructor() {
    this.parentElement = null;
    this.ownerDocument = null;
  }
}

class Texto extends No {
  constructor(valor) {
    super();
    this.nodeValue = String(valor);
  }
  get textContent() {
    return this.nodeValue;
  }
}

class Elemento extends No {
  constructor(tag, doc) {
    super();
    this.tagName = String(tag).toUpperCase();
    this.ownerDocument = doc;
    this.children = []; // elementos e textos, na ordem
    this.attrs = {};
    this.ouvintes = {};
    this.style = {};
    this.disabled = false;
    this.checked = false;
    this.open = false;
    this.value = "";
    this.min = "";
    this.max = "";
  }

  // ---- atributos e classes
  setAttribute(k, v) {
    this.attrs[k] = String(v);
    if (k === "disabled" || k === "checked" || k === "open") this[k] = true;
    if (k === "value" || k === "min" || k === "max") this[k] = String(v);
  }
  getAttribute(k) {
    return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
  }
  removeAttribute(k) {
    delete this.attrs[k];
  }
  get id() {
    return this.attrs.id || "";
  }
  set id(v) {
    this.attrs.id = String(v);
  }
  get className() {
    return this.attrs.class || "";
  }
  set className(v) {
    this.attrs.class = String(v);
  }
  get classList() {
    const el = this;
    const ler = () => el.className.split(/\s+/).filter(Boolean);
    const gravar = (l) => (el.className = l.join(" "));
    return {
      contains: (c) => ler().includes(c),
      add: (c) => ler().includes(c) || gravar([...ler(), c]),
      remove: (c) => gravar(ler().filter((x) => x !== c)),
      toggle: (c, force) => {
        const tem = ler().includes(c);
        const quer = force === undefined ? !tem : !!force;
        if (quer && !tem) gravar([...ler(), c]);
        if (!quer && tem) gravar(ler().filter((x) => x !== c));
        return quer;
      },
    };
  }

  // ---- filhos e texto
  get textContent() {
    return this.children.map((c) => c.textContent).join("");
  }
  set textContent(v) {
    this.replaceChildren(...(v === "" || v === null || v === undefined ? [] : [String(v)]));
  }
  append(...filhos) {
    for (const f of filhos) {
      // como no navegador: o que não é nó vira texto (um null esquecido apareceria como "null" na tela)
      const no = f instanceof No ? f : new Texto(f);
      if (no.parentElement) no.parentElement.children = no.parentElement.children.filter((x) => x !== no);
      no.parentElement = this;
      no.ownerDocument = this.ownerDocument;
      this.children.push(no);
    }
  }
  replaceChildren(...filhos) {
    const doc = this.ownerDocument;
    const foco = doc && doc.activeElement;
    for (const c of this.children) c.parentElement = null;
    this.children = [];
    this.append(...filhos);
    // o elemento com o foco saiu da tela: o foco volta para o <body>, como no navegador
    if (foco && foco !== doc.body && !doc.body.contains(foco)) doc.activeElement = doc.body;
  }
  contains(outro) {
    for (let n = outro; n; n = n.parentElement) if (n === this) return true;
    return false;
  }
  /** Todos os elementos de dentro, na ordem do documento. */
  todos() {
    const out = [];
    for (const c of this.children) {
      if (!(c instanceof Elemento)) continue;
      out.push(c, ...c.todos());
    }
    return out;
  }

  // ---- eventos e foco
  addEventListener(tipo, fn) {
    (this.ouvintes[tipo] = this.ouvintes[tipo] || []).push(fn);
  }
  disparar(tipo) {
    for (const fn of [...(this.ouvintes[tipo] || [])]) fn({ type: tipo, target: this, currentTarget: this });
  }
  focus() {
    if (!this.disabled && this.ownerDocument) this.ownerDocument.activeElement = this;
  }
}

class Documento {
  constructor() {
    this.raiz = new Elemento("#documento", this);
    this.body = null;
    this.activeElement = null;
  }
  createElement(tag) {
    return new Elemento(tag, this);
  }
  getElementById(id) {
    return this.raiz.todos().find((e) => e.attrs.id === id) || null;
  }
  /** Só o seletor que o panel.js usa: "[atributo]". */
  querySelectorAll(seletor) {
    const m = /^\[([\w-]+)\]$/.exec(seletor);
    if (!m) throw new Error(`a tela falsa não conhece o seletor ${seletor}`);
    return this.raiz.todos().filter((e) => e.getAttribute(m[1]) !== null);
  }
}

/** Lê o panel.html (marcação simples e bem formada) para a árvore de mentira. */
function lerHtml(html, doc) {
  const pilha = [doc.raiz];
  const re = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+)/gi;
  for (const m of html.matchAll(re)) {
    const topo = pilha[pilha.length - 1];
    if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) {
        while (pilha.length > 1 && pilha[pilha.length - 1].tagName.toLowerCase() !== tag) pilha.pop();
        if (pilha.length > 1) pilha.pop();
        continue;
      }
      const el = doc.createElement(tag);
      for (const a of m[3].matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) el.setAttribute(a[1], a[2] ?? a[3] ?? a[4] ?? "");
      topo.append(el);
      if (tag === "body") doc.body = el;
      if (!SEM_FILHOS.has(tag)) pilha.push(el);
    } else if (m[4] && m[4].trim()) {
      topo.append(m[4].replace(/\s+/g, " "));
    }
  }
  if (!doc.body) throw new Error("panel.html sem <body>");
  doc.activeElement = doc.body;
}

/**
 * Carrega a tela de verdade no DOM de mentira.
 * guardado: o que vscode.getState() devolve (o que a tela lembrou da outra vez).
 */
function abrirTela({ guardado } = {}) {
  const doc = new Documento();
  lerHtml(fs.readFileSync(path.join(MEDIA, "panel.html"), "utf8"), doc);

  const enviadas = []; // o que a tela mandou para a extensão
  const erros = []; // erros que escaparam (num clique ou num temporizador)
  let memoria = guardado;
  let adquirida = false;

  // relógio falso: os temporizadores da tela só andam com tela.avancar(ms)
  let agora = 1800000000000;
  let fila = [];
  let seq = 0;
  const marcar = (fn, ms) => {
    fila.push({ id: ++seq, em: agora + Math.max(0, Number(ms) || 0), fn });
    return seq;
  };
  const desmarcar = (id) => {
    fila = fila.filter((t) => t.id !== id);
  };

  const janela = {
    ouvintes: {},
    addEventListener(tipo, fn) {
      (this.ouvintes[tipo] = this.ouvintes[tipo] || []).push(fn);
    },
  };
  /** Roda o que a tela faria num evento; um erro que escapar fica anotado (no navegador iria para window.onerror). */
  const seguro = (fn) => {
    try {
      fn();
    } catch (e) {
      erros.push(e);
      for (const o of janela.ouvintes.error || []) o({ error: e, message: String(e && e.message) });
    }
  };

  const contexto = {
    document: doc,
    window: janela,
    Node: No,
    setTimeout: marcar,
    clearTimeout: desmarcar,
    Date: { now: () => agora },
    console,
    acquireVsCodeApi() {
      if (adquirida) throw new Error("An instance of the VS Code API has already been acquired");
      adquirida = true;
      return {
        // como no VS Code, a mensagem atravessa como cópia (JSON)
        postMessage: (m) => enviadas.push(JSON.parse(JSON.stringify(m))),
        getState: () => memoria,
        setState: (v) => (memoria = JSON.parse(JSON.stringify(v))),
      };
    },
  };
  const arquivo = path.join(MEDIA, "panel.js");
  vm.runInNewContext(fs.readFileSync(arquivo, "utf8"), contexto, { filename: arquivo });

  const tela = {
    doc,
    enviadas,
    erros,
    $: (id) => doc.getElementById(id),
    /** Tira e devolve as mensagens mandadas até agora. */
    levar: () => enviadas.splice(0),
    guardado: () => memoria,
    /** Entrega uma mensagem da extensão (cópia JSON, como o VS Code). */
    entregar(msg) {
      const data = msg === undefined ? undefined : JSON.parse(JSON.stringify(msg));
      for (const fn of janela.ouvintes.message || []) seguro(() => fn({ data }));
    },
    /** Adianta o relógio, rodando os temporizadores que vencerem (na ordem). */
    avancar(ms) {
      const ate = agora + ms;
      for (;;) {
        const prox = fila.filter((t) => t.em <= ate).sort((a, b) => a.em - b.em || a.id - b.id)[0];
        if (!prox) break;
        fila = fila.filter((t) => t !== prox);
        agora = prox.em;
        seguro(prox.fn);
      }
      agora = ate;
    },
    /** O texto que a pessoa lê num pedaço da tela (cada trecho separado por um espaço). */
    texto(el) {
      if (!el) return "(não existe)";
      const partes = [];
      const andar = (n) => {
        if (n instanceof Texto) {
          const t = n.nodeValue.replace(/\s+/g, " ").trim();
          if (t) partes.push(t);
        } else if (!(n.tagName === "SCRIPT" || n.classList.contains("hidden"))) n.children.forEach(andar);
      };
      andar(el);
      return partes.join(" ");
    },
    /** À mostra = nem ele nem quem está em volta tem a classe "hidden". */
    visivel(el) {
      for (let n = el; n; n = n.parentElement) if (n.classList.contains("hidden")) return false;
      return !!el;
    },
    botoes: (raiz) => (raiz || doc.body).todos().filter((e) => e.tagName === "BUTTON"),
    botao: (rotulo, raiz) => tela.botoes(raiz).find((b) => b.textContent.trim() === rotulo) || null,
    /** Linha de uma conta em "Trocar de conta" e o botão dela. */
    linha: (n) => doc.getElementById("acctList").todos().find((e) => e.getAttribute("data-n") === String(n)) || null,
    botaoDaConta: (n) => (tela.linha(n) ? tela.botoes(tela.linha(n))[0] : null),
    /** Clique como o do navegador: controle desabilitado não recebe; caixa de marcar inverte; <summary> abre/fecha. */
    clicar(el) {
      if (!el) throw new Error("clicar: o elemento não existe");
      if (el.disabled) return;
      el.focus();
      if (el.tagName === "INPUT" && el.getAttribute("type") === "checkbox") {
        el.checked = !el.checked;
        seguro(() => el.disparar("click"));
        seguro(() => el.disparar("change"));
      } else if (el.tagName === "SUMMARY") {
        const d = el.parentElement;
        d.open = !d.open;
        seguro(() => d.disparar("toggle"));
      } else {
        seguro(() => el.disparar("click"));
      }
    },
    /** Evento forçado (um script pode disparar um clique até num controle desabilitado). */
    forcar(el, tipo = "click") {
      seguro(() => el.disparar(tipo));
    },
    /** Mexe num slider: solta = true também dispara o "change" (soltou o mouse ou usou o teclado). */
    mover(el, valor, solta = true) {
      el.value = String(valor);
      seguro(() => el.disparar("input"));
      if (solta) seguro(() => el.disparar("change"));
    },
  };
  return tela;
}

/** A tela está de pé: nenhum erro escapou, nenhum aviso de erro ao desenhar, nenhum valor vazio escrito, os cartões no lugar. */
function inteira(tela, onde) {
  assert.equal(tela.erros.length, 0, `${onde}: erro que escapou: ${tela.erros.map((e) => (e && e.stack) || e).join("\n")}`);
  assert.ok(tela.$("renderError").classList.contains("hidden"), `${onde}: aviso de erro ao desenhar: ${tela.$("renderError").textContent}`);
  assert.doesNotMatch(tela.texto(tela.doc.body), /\b(null|undefined|NaN)\b|\[object /, `${onde}: valor vazio escrito na tela`);
  for (const id of ["connCard", "acctCard", "more", "btnPanel"]) assert.ok(tela.$(id) !== null, `${onde}: ${id} continua na tela`);
}

module.exports = { abrirTela, inteira, MEDIA };
