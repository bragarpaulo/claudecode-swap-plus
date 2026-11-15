"use strict";
// Testes da caixa de saída dos avisos ao dono (server/src/notify.js): formato igual ao do `servidor-aviso` do
// servidor, gravação atômica, limites, NOTICES_ENABLED=0 e "nunca lança". Tudo numa pasta temporária.
//
//   node --test server/test/notify.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  writeNotice,
  createNotifier,
  noticesEnabled,
  noticesDir,
  oneLine,
  manyLines,
  prune,
  SUBJECT_MAX,
  TEXT_MAX,
  KEEP_MS,
  MAX_FILES,
  ID_RE,
} = require("../src/notify");

const HOUR = 3600 * 1000;
const T = Date.parse("2026-11-15T13:04:05Z") + 678;

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-avisos-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function makeLogs() {
  const logs = [];
  const put = (...a) => logs.push(a.map(String).join(" "));
  return { logs, log: { info: put, warn: put, error: put, log: put } };
}

/** "AAAAMMDD-HHMMSS" no fuso local (o mesmo do id do aviso). */
function stamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const listDir = (folder) => (fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []);

test("writeNotice: aviso-AAAAMMDD-HHMMSS-<8 hex>.json em DATA_DIR/avisos (pasta 0700) com {id, assunto, texto, criado_em}", (t) => {
  const dir = tmpDir(t);
  const { logs, log } = makeLogs();
  const r = writeNotice(dir, { subject: "Swap Plus: atenção", text: "linha 1\nlinha 2 — ação" }, { env: {}, now: () => T, log });
  assert.equal(r.ok, true, JSON.stringify(r));

  const folder = path.join(dir, "avisos");
  assert.equal(noticesDir(dir), folder);
  assert.ok(fs.statSync(folder).isDirectory());
  assert.equal(fs.statSync(folder).mode & 0o777, 0o700, "pasta 0700");
  assert.deepEqual(listDir(folder), [`${r.id}.json`], "só o aviso (nenhum temporário sobrando)");
  assert.match(r.id, new RegExp(`^aviso-${stamp(T)}-[0-9a-f]{8}$`));
  assert.match(r.id, ID_RE);
  assert.match(r.id, /^aviso-[A-Za-z0-9_-]{14,74}$/, "o id casa com o que o servidor aceita");
  assert.equal(r.file, path.join(folder, `${r.id}.json`));
  assert.equal(fs.statSync(r.file).mode & 0o777, 0o600, "arquivo só do dono (o texto leva e-mails)");

  const raw = fs.readFileSync(r.file, "utf8");
  const obj = JSON.parse(raw);
  assert.deepEqual(Object.keys(obj), ["id", "assunto", "texto", "criado_em"], "mesma ordem do servidor-aviso");
  assert.deepEqual(obj, { id: r.id, assunto: "Swap Plus: atenção", texto: "linha 1\nlinha 2 — ação", criado_em: Math.floor(T / 1000) });
  assert.ok(Number.isInteger(obj.criado_em), "criado_em em segundos, inteiro");
  assert.equal(raw, JSON.stringify(obj), "JSON compacto");
  assert.ok(raw.includes("atenção") && raw.includes("—"), "UTF-8 cru (ensure_ascii=False), sem \\u");
  assert.ok(logs.some((l) => l.includes("Swap Plus: atenção")), "o log diz o assunto");

  // Dois avisos no mesmo segundo: ids diferentes, os dois na pasta.
  const r2 = writeNotice(dir, { subject: "Outro", text: "" }, { env: {}, now: () => T, log });
  assert.equal(r2.ok, true);
  assert.notEqual(r2.id, r.id);
  assert.deepEqual(listDir(folder), [`${r.id}.json`, `${r2.id}.json`].sort());
  assert.equal(JSON.parse(fs.readFileSync(r2.file, "utf8")).texto, "", "texto vazio vale (como no servidor-aviso)");
});

test("writeNotice: gravação atômica — temporário .<id>.tmp com O_EXCL, completo antes do rename; falha no meio não deixa nada", (t) => {
  const dir = tmpDir(t);
  const { log } = makeLogs();
  const realOpen = fs.openSync;
  const realRename = fs.renameSync;
  const opened = [];
  let seen = null;
  fs.openSync = (p, flags, mode) => {
    opened.push({ p: String(p), flags, mode });
    return realOpen(p, flags, mode);
  };
  fs.renameSync = (from, to) => {
    seen = { from: String(from), to: String(to), destBefore: fs.existsSync(to), content: fs.readFileSync(from, "utf8") };
    return realRename(from, to);
  };
  let r;
  try {
    r = writeNotice(dir, { subject: "Atômico", text: "corpo" }, { env: {}, now: () => T, log });
  } finally {
    fs.openSync = realOpen;
    fs.renameSync = realRename;
  }
  assert.equal(r.ok, true);
  const folder = noticesDir(dir);
  const tmp = opened.find((o) => path.basename(o.p).endsWith(".tmp"));
  assert.ok(tmp, "abriu um temporário");
  assert.equal(path.dirname(tmp.p), folder, "o temporário fica na mesma pasta (rename atômico)");
  assert.equal(path.basename(tmp.p), `.${r.id}.tmp`);
  assert.equal(tmp.flags, "wx", "O_EXCL: nunca escreve por cima de outro");
  assert.equal(seen.from, tmp.p);
  assert.equal(seen.to, r.file);
  assert.equal(seen.destBefore, false, "o aviso só aparece com o rename");
  assert.deepEqual(JSON.parse(seen.content), JSON.parse(fs.readFileSync(r.file, "utf8")), "o temporário já estava completo");

  // Rename que falha: nenhum aviso pela metade e nenhum temporário sobrando; não lança.
  fs.renameSync = () => {
    throw Object.assign(new Error("EIO: i/o error, rename"), { code: "EIO" });
  };
  let r2;
  try {
    r2 = writeNotice(dir, { subject: "Falha", text: "x" }, { env: {}, now: () => T + 1000, log });
  } finally {
    fs.renameSync = realRename;
  }
  assert.deepEqual(r2, { ok: false, error: "EIO" });
  assert.deepEqual(listDir(folder), [`${r.id}.json`], "só o aviso que deu certo");
});

test("limites do servidor-aviso: assunto 1 linha até 120, texto até 2.000, sem caracteres de controle", (t) => {
  // as regras (uma_linha / varias_linhas do servidor-aviso)
  assert.equal(oneLine("  Olá\n\tmundo\x07  de\r\nnovo "), "Olá mundo de novo");
  assert.equal(oneLine("a".repeat(SUBJECT_MAX)), "a".repeat(SUBJECT_MAX));
  assert.equal(oneLine("a".repeat(SUBJECT_MAX + 1)), `${"a".repeat(SUBJECT_MAX - 1)}…`);
  assert.equal(oneLine(`${"a".repeat(SUBJECT_MAX - 2)}   bbbb`), `${"a".repeat(SUBJECT_MAX - 2)}…`, "corta e tira o espaço antes do …");
  assert.equal(Array.from(oneLine("😀".repeat(200))).length, SUBJECT_MAX, "conta caracteres (pontos de código), como o len() do Python");
  assert.equal(oneLine(null), "");
  assert.equal(manyLines("a\r\nb\rc\n\n\n\nd\x01e  \t f "), "a\nb\nc\n\nd e f");
  assert.equal(manyLines("  \n\n x \x00\x7f y \n\n\n"), "x y");
  assert.equal(manyLines("t".repeat(TEXT_MAX)), "t".repeat(TEXT_MAX));
  assert.equal(manyLines("t".repeat(TEXT_MAX + 50)), `${"t".repeat(TEXT_MAX - 1)}…`);

  // no arquivo
  const dir = tmpDir(t);
  const { log } = makeLogs();
  const r = writeNotice(dir, { subject: `Linha 1\nLinha 2\x1b[31m ${"x".repeat(300)}`, text: `Oi\x00 \x08você\r\n${"y".repeat(3000)}` }, { env: {}, now: () => T, log });
  assert.equal(r.ok, true);
  const obj = JSON.parse(fs.readFileSync(r.file, "utf8"));
  assert.ok(!/[\x00-\x1f\x7f]/.test(obj.assunto), "assunto sem controle (nem quebra de linha)");
  assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(obj.texto), "texto sem controle além da quebra de linha");
  assert.equal(Array.from(obj.assunto).length, SUBJECT_MAX);
  assert.ok(obj.assunto.startsWith("Linha 1 Linha 2 [31m x"));
  assert.ok(obj.assunto.endsWith("…"));
  assert.equal(Array.from(obj.texto).length, TEXT_MAX);
  assert.ok(obj.texto.startsWith("Oi você\nyyy"));
  assert.ok(obj.texto.endsWith("…"));

  // assunto vazio (ou só espaços/controle): nada gravado, não lança
  const files = listDir(noticesDir(dir));
  for (const subject of ["", "   ", "\n\t\x00", undefined]) {
    const bad = writeNotice(dir, { subject, text: "corpo" }, { env: {}, now: () => T, log });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "assunto_vazio");
  }
  assert.deepEqual(listDir(noticesDir(dir)), files);
});

test("NOTICES_ENABLED: padrão ligado; \"0\" desliga (nada gravado, nem a pasta)", (t) => {
  for (const env of [{}, { NOTICES_ENABLED: "" }, { NOTICES_ENABLED: "1" }, { NOTICES_ENABLED: "sim" }, { NOTICES_ENABLED: " 1 " }]) {
    assert.equal(noticesEnabled(env), true, JSON.stringify(env));
  }
  for (const v of ["0", " 0 ", "false", "OFF", "no", "não"]) assert.equal(noticesEnabled({ NOTICES_ENABLED: v }), false, v);

  const dir = tmpDir(t);
  const { logs, log } = makeLogs();
  const r = writeNotice(dir, { subject: "Desligado", text: "x" }, { env: { NOTICES_ENABLED: "0" }, now: () => T, log });
  assert.deepEqual(r, { ok: false, skipped: "disabled" });
  assert.equal(fs.existsSync(noticesDir(dir)), false, "nem a pasta é criada");
  assert.equal(logs.length, 0, "desligado não é erro");

  const off = createNotifier({ dir, env: { NOTICES_ENABLED: "0" }, now: () => T, log });
  assert.equal(off.enabled, false);
  assert.deepEqual(off({ subject: "Desligado", text: "x" }), { ok: false, skipped: "disabled" });
  assert.equal(fs.existsSync(noticesDir(dir)), false);

  const on = createNotifier({ dir, env: {}, now: () => T, log });
  assert.equal(on.enabled, true);
  assert.equal(on.dir, noticesDir(dir));
  const ok = on({ subject: "Ligado", text: "x" });
  assert.equal(ok.ok, true);
  assert.deepEqual(listDir(noticesDir(dir)), [`${ok.id}.json`]);
});

test("writeNotice nunca lança: pasta inválida, pasta que é arquivo, aviso que não é objeto, log que lança", (t) => {
  const dir = tmpDir(t);
  const { logs, log } = makeLogs();
  assert.deepEqual(writeNotice(undefined, { subject: "a", text: "b" }, { env: {}, log }), { ok: false, error: "sem_pasta" });
  assert.deepEqual(writeNotice("  ", { subject: "a", text: "b" }, { env: {}, log }), { ok: false, error: "sem_pasta" });
  const file = path.join(dir, "um-arquivo");
  fs.writeFileSync(file, "x");
  const r = writeNotice(file, { subject: "a", text: "b" }, { env: {}, now: () => T, log });
  assert.equal(r.ok, false);
  assert.equal(typeof r.error, "string");
  assert.equal(writeNotice(dir, null, { env: {}, log }).ok, false);
  assert.equal(writeNotice(dir, "texto", { env: {}, log }).ok, false);
  assert.ok(logs.filter((l) => l.includes("[avisos] não consegui gravar")).length >= 4, "os erros vão para o log");

  const boom = () => {
    throw new Error("log quebrado");
  };
  const angry = { info: boom, warn: boom, error: boom, log: boom };
  assert.doesNotThrow(() => writeNotice(file, { subject: "a", text: "b" }, { env: {}, now: () => T, log: angry }));
  assert.equal(writeNotice(dir, { subject: "a", text: "b" }, { env: {}, now: () => T, log: angry }).ok, true);
  assert.doesNotThrow(() =>
    writeNotice(dir, { subject: "a", text: "b" }, {
      env: {},
      now: () => {
        throw new Error("relógio quebrado");
      },
      log: angry,
    })
  );
});

test("limpeza: avisos com mais de 48 h e o excedente acima de 500 saem (só aviso-*.json); temporário esquecido sai depois de 1 h", (t) => {
  const dir = tmpDir(t);
  const folder = noticesDir(dir);
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  const real = Date.now();
  const put = (name, ageMs) => {
    const p = path.join(folder, name);
    fs.writeFileSync(p, "{}");
    const s = (real - ageMs) / 1000;
    fs.utimesSync(p, s, s);
    return name;
  };
  const old = put("aviso-20261110-120000-aaaaaaaa.json", KEEP_MS + HOUR);
  const fresh = put("aviso-20261115-120000-bbbbbbbb.json", HOUR);
  const other = put("outra-coisa.json", KEEP_MS + HOUR);
  const oldTmp = put(".aviso-20261115-110000-cccccccc.tmp", 2 * HOUR);
  const newTmp = put(".aviso-20261115-120000-dddddddd.tmp", 60 * 1000);

  const { log } = makeLogs();
  const r = writeNotice(dir, { subject: "Novo", text: "x" }, { env: {}, now: () => T, log });
  assert.equal(r.ok, true);
  const left = listDir(folder);
  assert.ok(!left.includes(old), "o de mais de 48 h saiu");
  assert.ok(!left.includes(oldTmp), "o temporário esquecido saiu");
  for (const keep of [fresh, other, newTmp, `${r.id}.json`]) assert.ok(left.includes(keep), `${keep} fica`);

  // Mais de 500: saem os mais velhos.
  for (let i = 0; i < MAX_FILES + 5; i++) put(`aviso-20261115-130000-${String(i).padStart(8, "0")}.json`, (MAX_FILES + 10 - i) * 1000);
  prune(folder, Date.now());
  const notices = listDir(folder).filter((n) => /^aviso-.*\.json$/.test(n));
  assert.equal(notices.length, MAX_FILES);
  assert.ok(!notices.includes(fresh), "o mais velho saiu primeiro");
  assert.ok(notices.includes(`aviso-20261115-130000-${String(MAX_FILES + 4).padStart(8, "0")}.json`), "o mais novo fica");
  assert.ok(listDir(folder).includes(other), "arquivo que não é aviso nunca sai");
});
