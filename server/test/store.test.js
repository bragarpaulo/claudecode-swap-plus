"use strict";
// Testes do cofre (server/src/store.js): gravação conferida, cópia anterior por hard link,
// trava da pasta de dados (store.lock), reserva de espaço (store.reserve) e o que o load() faz
// com arquivos que não abrem.
// Pasta temporária e chave geradas aqui.
//
//   node --test server/test/store.test.js

const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Store, encrypt, decrypt, LOCK_STALE_MS, LOCK_TOUCH_MS } = require("../src/store");

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "swap-plus-cofre-"));
  const keyFile = path.join(dir, "chave-mestra");
  fs.writeFileSync(keyFile, crypto.randomBytes(32).toString("hex"), { mode: 0o600 });
  const dataDir = path.join(dir, "dados");
  const stores = [];
  const open = () => {
    const s = new Store({ dir: dataDir, keyFile });
    stores.push(s);
    return s;
  };
  t.after(() => {
    for (const s of stores) s.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    dataDir,
    keyFile,
    open,
    file: path.join(dataDir, "store.enc"),
    prev: path.join(dataDir, "store.enc.1"),
    lockFile: path.join(dataDir, "store.lock"),
  };
}

/** Guarda o que o cofre escreve no console.error (e não suja a saída do teste). */
function captureErrors(t) {
  const lines = [];
  const orig = console.error;
  console.error = (...a) => lines.push(a.map(String).join(" "));
  t.after(() => {
    console.error = orig;
  });
  return lines;
}

/** Troca fs[name] durante fn (o cofre chama fs.<name> na hora, então a troca vale para ele). */
function withFs(name, impl, fn) {
  const real = fs[name];
  fs[name] = impl(real);
  try {
    return fn();
  } finally {
    fs[name] = real;
  }
}

const temps = (dataDir) => fs.readdirSync(dataDir).filter((n) => n.includes(".tmp-") || n.includes(".velha-"));
const onDisk = (s, f) => decrypt(s.key, fs.readFileSync(f));

// ------------------------------------------------------------------ gravação conferida

test("gravação: erro no meio (disco cheio) lança, não troca o cofre nem a cópia anterior e apaga o temporário", async (t) => {
  const { dataDir, open, file, prev } = setup(t);
  const s = open();
  s.load();
  s.state.history = ["um"];
  s.saveSync();
  const mainBefore = fs.readFileSync(file);
  const prevBefore = fs.readFileSync(prev);

  s.state.history = ["dois"];
  withFs(
    "writeFileSync",
    (real) =>
      function (f, data, ...rest) {
        if (typeof f !== "number") return real.call(fs, f, data, ...rest);
        real.call(fs, f, data.subarray(0, 10), ...rest); // só um pedaço foi para o disco
        const e = new Error("ENOSPC: no space left on device, write");
        e.code = "ENOSPC";
        throw e;
      },
    () => assert.throws(() => s.saveSync(), (e) => e.code === "ENOSPC" && /ficou como estava/.test(e.message))
  );
  assert.ok(fs.readFileSync(file).equals(mainBefore), "o principal não mudou");
  assert.ok(fs.readFileSync(prev).equals(prevBefore), "a cópia anterior não mudou");
  assert.deepEqual(temps(dataDir), [], "nenhum temporário sobrou");

  // A gravação seguinte (com espaço) funciona.
  await s.save();
  assert.deepEqual(onDisk(s, file).history, ["dois"]);
});

test("gravação: temporário que não confere com o que devia ser gravado não vai para o lugar do principal", (t) => {
  const { dataDir, open, file } = setup(t);
  const s = open();
  s.load();
  const mainBefore = fs.readFileSync(file);
  s.state.history = ["perdido"];
  withFs(
    "writeFileSync",
    (real) =>
      function (f, data, ...rest) {
        // Gravação parcial "silenciosa" (sem erro): faltam os últimos bytes.
        if (typeof f === "number") return real.call(fs, f, data.subarray(0, data.length - 5), ...rest);
        return real.call(fs, f, data, ...rest);
      },
    () => assert.throws(() => s.saveSync(), /não confere \(\d+ de \d+ bytes no disco\).*ficou como estava/)
  );
  assert.ok(fs.readFileSync(file).equals(mainBefore), "o principal não mudou");
  assert.deepEqual(temps(dataDir), []);
});

test("gravação: temporário com pid + aleatório; sobras de gravações interrompidas somem no load", (t) => {
  const { dataDir, open } = setup(t);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(dataDir, "store.enc.tmp-123"), "sobra");
  fs.writeFileSync(path.join(dataDir, "store.enc.1.tmp-123-abcdef"), "sobra");
  fs.writeFileSync(path.join(dataDir, "store.reserve.tmp-123-abcdef"), "sobra");
  const s = open();
  s.load();
  assert.deepEqual(fs.readdirSync(dataDir).sort(), ["store.enc", "store.lock", "store.reserve"]);

  const opened = [];
  withFs(
    "openSync",
    (real) =>
      function (f, ...rest) {
        if (rest[0] === "wx") opened.push(String(f)); // só a criação do temporário (a leitura de volta abre com "r")
        return real.call(fs, f, ...rest);
      },
    () => {
      s.saveSync();
      s.saveSync();
    }
  );
  const tmpNames = opened.map((n) => path.basename(n));
  assert.equal(tmpNames.length, 2);
  for (const n of tmpNames) assert.match(n, new RegExp(`^store\\.enc\\.tmp-${process.pid}-[0-9a-f]{12}$`));
  assert.notEqual(tmpNames[0], tmpNames[1], "cada gravação usa um nome novo");
});

// ------------------------------------------------------------------ cópia anterior (.1)

test("cópia anterior: store.enc.1 é hard link do cofre anterior (mesmo arquivo, nenhum byte copiado)", (t) => {
  const { dataDir, open, file, prev } = setup(t);
  const s = open();
  s.load();
  assert.equal(fs.existsSync(prev), false, "na criação não há anterior");
  s.state.history = ["a"];
  s.saveSync();
  const inoA = fs.statSync(file).ino;
  s.state.history = ["b"];
  withFs(
    "copyFileSync",
    () => () => {
      throw new Error("não devia copiar bytes");
    },
    () => s.saveSync()
  );
  const st = fs.statSync(prev);
  assert.equal(st.ino, inoA, "a .1 é o arquivo anterior (hard link)");
  assert.equal(st.nlink, 1, "o principal novo é outro arquivo");
  assert.notEqual(fs.statSync(file).ino, inoA);
  assert.deepEqual(onDisk(s, prev).history, ["a"]);
  assert.deepEqual(onDisk(s, file).history, ["b"]);
  assert.deepEqual(temps(dataDir), []);
});

test("cópia anterior: falha no hard link só vai para o log (uma vez) e a gravação principal segue", (t) => {
  const { dataDir, open, file, prev } = setup(t);
  const s = open();
  s.load();
  s.state.history = ["a"];
  s.saveSync(); // .1 = vazio, principal = a
  const errors = captureErrors(t);
  withFs(
    "linkSync",
    () => () => {
      const e = new Error("EPERM: operation not permitted, link");
      e.code = "EPERM";
      throw e;
    },
    () => {
      s.state.history = ["b"];
      s.saveSync();
      s.state.history = ["c"];
      s.saveSync();
    }
  );
  assert.deepEqual(onDisk(s, file).history, ["c"], "o principal foi gravado");
  assert.deepEqual(onDisk(s, prev).history, [], "a .1 ficou a de antes");
  assert.equal(errors.filter((l) => l.includes("cópia anterior")).length, 1, "avisa uma vez, não a cada gravação");
  assert.deepEqual(temps(dataDir), []);
});

// ------------------------------------------------------------------ reserva de espaço (store.reserve)

const RESERVE_BYTES = 1024 * 1024;

function enospc() {
  const e = new Error("ENOSPC: no space left on device, write");
  e.code = "ENOSPC";
  return e;
}

test("reserva: load cria store.reserve (1 MB); disco cheio apaga a reserva, tenta de novo e grava; a reserva volta na gravação seguinte", async (t) => {
  const { dataDir, open, file } = setup(t);
  const errors = captureErrors(t);
  const s = open();
  s.load();
  const reserve = path.join(dataDir, "store.reserve");
  assert.equal(fs.statSync(reserve).size, RESERVE_BYTES);
  assert.equal(fs.statSync(reserve).mode & 0o777, 0o600);

  // Disco cheio na 1ª tentativa (ex.: o login acabou de ser renovado): a reserva libera o espaço.
  s.state.history = ["login renovado"];
  let fails = 1;
  withFs(
    "writeFileSync",
    (real) =>
      function (f, data, ...rest) {
        if (typeof f === "number" && fails > 0) {
          fails--;
          throw enospc();
        }
        return real.call(fs, f, data, ...rest);
      },
    () => s.saveSync()
  );
  assert.deepEqual(onDisk(s, file).history, ["login renovado"], "gravou na 2ª tentativa");
  assert.equal(fs.existsSync(reserve), false, "a reserva foi usada");
  assert.ok(errors.some((l) => l.includes("apaguei a reserva")));
  assert.deepEqual(temps(dataDir), [], "nenhum temporário sobrou");

  // Com espaço de novo: a gravação seguinte recria a reserva.
  s.state.history = ["com espaço"];
  await s.save();
  assert.equal(fs.statSync(reserve).size, RESERVE_BYTES, "reserva recriada");
  assert.deepEqual(onDisk(s, file).history, ["com espaço"]);
  assert.deepEqual(temps(dataDir), []);
});

test("reserva: disco cheio também na 2ª tentativa → lança ENOSPC, o cofre fica como estava e nada sobra", (t) => {
  const { dataDir, open, file, prev } = setup(t);
  captureErrors(t);
  const s = open();
  s.load();
  s.state.history = ["um"];
  s.saveSync();
  const mainBefore = fs.readFileSync(file);
  const prevBefore = fs.readFileSync(prev);
  s.state.history = ["perdido"];
  withFs(
    "writeFileSync",
    (real) =>
      function (f, data, ...rest) {
        if (typeof f === "number") throw enospc();
        return real.call(fs, f, data, ...rest);
      },
    () => assert.throws(() => s.saveSync(), (e) => e.code === "ENOSPC" && /ficou como estava/.test(e.message))
  );
  assert.ok(fs.readFileSync(file).equals(mainBefore), "o principal não mudou");
  assert.ok(fs.readFileSync(prev).equals(prevBefore), "a cópia anterior não mudou");
  assert.equal(fs.existsSync(path.join(dataDir, "store.reserve")), false, "a reserva foi gasta tentando");
  assert.deepEqual(temps(dataDir), []);
  // Sem reserva para apagar, o ENOSPC seguinte lança direto (uma tentativa só).
  let writes = 0;
  withFs(
    "writeFileSync",
    (real) =>
      function (f, data, ...rest) {
        if (typeof f === "number") {
          writes++;
          throw enospc();
        }
        return real.call(fs, f, data, ...rest);
      },
    () => assert.throws(() => s.saveSync(), (e) => e.code === "ENOSPC")
  );
  assert.equal(writes, 1);
});

test("reserva: sem espaço para criar a reserva, o load e as gravações seguem (sem temporário) e ela só é tentada de novo mais tarde", (t) => {
  const { dataDir, open, file } = setup(t);
  const errors = captureErrors(t);
  const s = open();
  const reserve = path.join(dataDir, "store.reserve");
  withFs(
    "writeFileSync",
    (real) =>
      function (f, data, ...rest) {
        if (typeof f === "number" && data && data.length === RESERVE_BYTES) throw enospc();
        return real.call(fs, f, data, ...rest);
      },
    () => s.load()
  );
  assert.ok(fs.existsSync(file), "o cofre foi criado");
  assert.equal(fs.existsSync(reserve), false);
  assert.deepEqual(temps(dataDir), [], "o temporário da reserva não sobra");
  assert.equal(errors.filter((l) => l.includes("reserva de espaço")).length, 1, "avisa uma vez");

  s.state.history = ["x"];
  s.saveSync();
  assert.deepEqual(onDisk(s, file).history, ["x"]);
  assert.equal(fs.existsSync(reserve), false, "dentro da espera não tenta de novo a cada gravação");
});

// ------------------------------------------------------------------ load

test("load: só a cópia anterior e ela não abre → lança e NÃO cria cofre vazio", (t) => {
  const { dataDir, open, file, prev, lockFile } = setup(t);
  captureErrors(t);
  fs.mkdirSync(dataDir, { recursive: true });
  const deOutraChave = encrypt(crypto.randomBytes(32), { version: 1, accounts: { 1: { number: 1 } } });
  fs.writeFileSync(prev, deOutraChave);
  const s = open();
  assert.throws(() => s.load(), /cópia anterior store\.enc\.1.*não abre.*não crio um cofre vazio/);
  assert.equal(fs.existsSync(file), false, "nenhum cofre vazio criado");
  assert.ok(fs.readFileSync(prev).equals(deOutraChave), "a cópia anterior ficou intacta");
  assert.equal(s.state, null);
  assert.equal(fs.existsSync(lockFile), false, "soltou a trava ao falhar");

  // Principal que não abre (com ou sem .1 ilegível) continua lançando.
  fs.writeFileSync(file, "lixo");
  assert.throws(() => open().load(), /o cofre existe mas não abre/);
  assert.equal(fs.readFileSync(file, "utf8"), "lixo");
});

test("load: principal estragado → usa a .1; a gravação seguinte não troca a .1 boa pelo principal estragado", (t) => {
  const { open, file, prev } = setup(t);
  const errors = captureErrors(t);
  const a = open();
  a.load();
  a.state.history = ["bom"];
  a.saveSync();
  a.state.history = ["bom2"];
  a.saveSync();
  a.close();
  fs.writeFileSync(file, "estragado");

  const b = open();
  assert.deepEqual(b.load().history, ["bom"]);
  assert.ok(errors.some((l) => l.includes("usando a cópia anterior")));
  b.state.history = ["novo"];
  b.saveSync();
  assert.deepEqual(onDisk(b, file).history, ["novo"]);
  assert.deepEqual(onDisk(b, prev).history, ["bom"], "a .1 boa ficou");
  b.state.history = ["novo2"];
  b.saveSync();
  assert.deepEqual(onDisk(b, prev).history, ["novo"], "daí em diante a .1 volta a ser a anterior");
});

// ------------------------------------------------------------------ trava da pasta

test("trava: segundo servidor na mesma pasta → BUSY; close() solta e não grava mais", async (t) => {
  const { open, lockFile } = setup(t);
  const a = open();
  a.load();
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.equal(typeof lock.since, "string");
  assert.equal(fs.statSync(lockFile).mode & 0o777, 0o600);
  assert.ok(LOCK_TOUCH_MS < LOCK_STALE_MS);

  const b = open();
  assert.throws(
    () => b.load(),
    (e) => e.code === "BUSY" && /outro servidor está usando esta pasta de dados/.test(e.message) && e.message.includes(`pid ${process.pid}`)
  );
  assert.equal(b.state, null);
  assert.ok(fs.existsSync(lockFile), "a recusa não mexe na trava do outro");

  await a.save();
  a.close();
  assert.equal(fs.existsSync(lockFile), false, "close() apaga a trava");
  assert.throws(() => a.saveSync(), (e) => e.code === "CLOSED");
  await assert.rejects(a.save(), (e) => e.code === "CLOSED");

  b.load(); // agora abre
  assert.notEqual(JSON.parse(fs.readFileSync(lockFile, "utf8")).token, lock.token);
});

test("trava: só é velha com mtime de mais de 30 s; a velha é assumida", (t) => {
  const { dataDir, open, lockFile } = setup(t);
  const errors = captureErrors(t);
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, host: "outro-container", since: "2026-11-14T12:00:00.000Z", token: "de-outro" }));
  const recente = new Date(Date.now() - LOCK_STALE_MS + 10 * 1000);
  fs.utimesSync(lockFile, recente, recente);
  assert.throws(() => open().load(), (e) => e.code === "BUSY" && /pid 999999 em outro-container/.test(e.message));

  const velha = new Date(Date.now() - LOCK_STALE_MS - 5 * 1000);
  fs.utimesSync(lockFile, velha, velha);
  const s = open();
  s.load();
  const lock = JSON.parse(fs.readFileSync(lockFile, "utf8"));
  assert.equal(lock.pid, process.pid);
  assert.notEqual(lock.token, "de-outro");
  assert.ok(errors.some((l) => l.includes("trava velha")));
  assert.deepEqual(temps(dataDir), [], "a trava velha tirada do caminho não sobra");
});

test("trava: o sinal de vida atualiza o mtime; trava tomada por outro → não grava mais (BUSY) e não apaga a do outro", (t) => {
  const { open, lockFile } = setup(t);
  const errors = captureErrors(t);
  const s = open();
  s.load();
  const antiga = new Date(Date.now() - 25 * 1000);
  fs.utimesSync(lockFile, antiga, antiga);
  s.touchLock();
  assert.ok(Date.now() - fs.statSync(lockFile).mtimeMs < 5 * 1000, "mtime atualizado");

  // Trava apagada por alguém: pega de novo e segue gravando.
  fs.unlinkSync(lockFile);
  s.saveSync();
  assert.ok(fs.existsSync(lockFile));

  // Outro processo assumiu a trava (este ficou parado mais de 30 s, por exemplo).
  const outra = JSON.stringify({ pid: 4242, token: "de-outro" });
  fs.writeFileSync(lockFile, outra);
  assert.throws(() => s.saveSync(), (e) => e.code === "BUSY");
  assert.ok(errors.some((l) => l.includes("agora é de outro processo")));
  s.touchLock(); // não mexe na do outro
  s.close();
  assert.equal(fs.readFileSync(lockFile, "utf8"), outra, "a trava do outro ficou");
});
