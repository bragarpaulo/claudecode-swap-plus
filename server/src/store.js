"use strict";
// Cofre do servidor: um arquivo JSON criptografado (AES-256-GCM).
//
// - A chave fica fora da pasta de dados (segredo do Docker), então um backup
//   ou cópia da pasta /data sozinha não abre os logins.
// - Gravação atômica e conferida: escreve tudo num temporário (nome com pid +
//   aleatório), força para o disco, lê de volta e abre com a chave; só então
//   renomeia por cima. Qualquer erro (ex.: disco cheio) apaga o temporário e
//   lança — o cofre principal fica como estava.
// - A versão anterior fica em store.enc.1 (hard link do arquivo atual, sem
//   copiar bytes) — se a atual não abrir, usa ela. Falha ao guardar a anterior
//   só vai para o log.
// - Trava da pasta (store.lock): dois servidores na mesma pasta renovariam o
//   mesmo refresh token (uso único) e matariam os logins. load() pega a trava
//   ou lança erro com code "BUSY"; close() solta (e o fim do processo também).
// - Perder uma gravação depois de renovar um login mataria a conta, por isso
//   quem renova grava ANTES de usar o token novo.
// - Reserva de espaço (store.reserve, 1 MB de bytes aleatórios, criada no load()): com o disco
//   cheio (ENOSPC), a gravação apaga a reserva e tenta mais uma vez — é o espaço para gravar o
//   login recém-renovado. A reserva é recriada numa gravação seguinte, quando houver espaço.

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const MAGIC = Buffer.from("SPS1");
const LOCK_STALE_MS = 30 * 1000; // trava sem sinal (mtime) há mais que isso = dono morto
const LOCK_TOUCH_MS = 10 * 1000; // quem segura a trava atualiza o mtime nesse intervalo
const RESERVE_BYTES = 1024 * 1024; // store.reserve: espaço guardado para a gravação que não pode falhar
const RESERVE_RETRY_MS = 60 * 1000; // não deu para criar a reserva: tenta de novo depois disso
const DISK_FULL = new Set(["ENOSPC", "EDQUOT"]);

const rand = () => crypto.randomBytes(6).toString("hex");

function loadKey(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  const key = Buffer.from(raw, /^[0-9a-f]{64}$/i.test(raw) ? "hex" : "base64");
  if (key.length !== 32) throw new Error(`chave mestra inválida em ${file}: precisa de 32 bytes (64 caracteres hex)`);
  return key;
}

function encrypt(key, obj) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
}

function decrypt(key, buf) {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error("arquivo não é um cofre do Swap Plus");
  const iv = buf.subarray(4, 16);
  const tag = buf.subarray(16, 32);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(buf.subarray(32)), d.final()]).toString("utf8"));
}

function emptyState() {
  return {
    version: 1,
    nextNumber: 1,
    accounts: {},
    devices: {},
    pairing: null,
    rules: null,
    autoSwitch: true,
    history: [],
    diag: {},
    allowedEmails: [], // contas Google que podem conectar serviços (minúsculas); o painel é só de ADMIN_EMAILS
    webSessions: {}, // sessões do painel web (só administrador): { id: { tokenHash, email, createdAt, lastSeen, expiresAt, ua, ip, csrf } }
  };
}

function codeError(message, code) {
  const e = new Error(message);
  if (code) e.code = code;
  return e;
}

/** Conteúdo da trava ({ pid, host, since, token }); null se não existe; {} se ilegível. Outros erros de leitura propagam. */
function readLock(file) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
  try {
    const j = JSON.parse(text);
    return j && typeof j === "object" && !Array.isArray(j) ? j : {};
  } catch {
    return {};
  }
}

/** Idade (ms) do último sinal da trava (mtime); null se não existe. */
function lockAge(file) {
  try {
    return Date.now() - fs.statSync(file).mtimeMs;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function describeLock(info, age) {
  const who = info && info.pid ? `pid ${info.pid}${info.host ? ` em ${info.host}` : ""}` : "dono desconhecido";
  const since = info && info.since ? `, desde ${info.since}` : "";
  return `${who}${since}, último sinal há ${Math.max(0, Math.round((age || 0) / 1000))} s`;
}

function busyError(lockFile, detail) {
  return codeError(
    `outro servidor está usando esta pasta de dados (${path.dirname(lockFile)}; trava ${path.basename(lockFile)}: ${detail}). ` +
      "Dois servidores na mesma pasta renovam o mesmo login e matam as contas: pare o outro. " +
      `Se não há outro, espere ${LOCK_STALE_MS / 1000} s (a trava vence sozinha) ou apague ${lockFile}.`,
    "BUSY"
  );
}

// Travas soltas no fim do processo (process.exit ou fim normal). SIGKILL não passa
// por aqui: a trava fica e vence em LOCK_STALE_MS.
const withLock = new Set();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on("exit", () => {
    for (const s of [...withLock]) s.releaseLock();
  });
}

class Store {
  constructor({ dir, keyFile }) {
    this.dir = dir;
    this.file = path.join(dir, "store.enc");
    this.lockFile = path.join(dir, "store.lock");
    this.reserveFile = path.join(dir, "store.reserve");
    this.reserveOk = false; // a reserva de espaço está no disco
    this.reserveRetryAt = 0; // não deu para criar a reserva: só tenta de novo depois disso
    this.key = loadKey(keyFile);
    this.state = null;
    this.writing = Promise.resolve();
    this.lockToken = null; // trava nossa (null = sem trava)
    this.lockBody = null;
    this.lockTimer = null;
    this.lockLost = false; // a trava passou para outro processo: não grava mais
    this.closed = false;
    this.mainBad = false; // o principal não abriu no load (a .1 é a cópia boa)
    this.warned = {};
  }

  load() {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    this.closed = false;
    this.acquireLock();
    try {
      this.removeTemps();
      const state = this.readState();
      this.keepReserve(true);
      return state;
    } catch (e) {
      this.releaseLock();
      throw e;
    }
  }

  readState() {
    const prev = this.file + ".1";
    const unreadable = [];
    for (const f of [this.file, prev]) {
      if (!fs.existsSync(f)) continue;
      try {
        this.state = { ...emptyState(), ...decrypt(this.key, fs.readFileSync(f)) };
        if (f === prev) {
          this.mainBad = true;
          console.error(`[cofre] ${path.basename(this.file)} ${unreadable.length ? "não abriu" : "não existe"}; usando a cópia anterior`);
        }
        return this.state;
      } catch (e) {
        unreadable.push(path.basename(f));
        console.error(`[cofre] não consegui abrir ${path.basename(f)}: ${e.message}`);
      }
    }
    if (unreadable.includes(path.basename(this.file))) {
      throw new Error("o cofre existe mas não abre com esta chave (chave errada?) — nada foi alterado");
    }
    if (unreadable.length) {
      // Só sobrou a cópia anterior e ela não abre: criar um cofre vazio por cima apagaria os logins de vez.
      throw new Error(
        `só achei a cópia anterior ${path.basename(prev)} e ela não abre com esta chave (chave errada?) — nada foi alterado; não crio um cofre vazio`
      );
    }
    this.state = emptyState();
    this.saveSync();
    return this.state;
  }

  saveSync() {
    if (this.closed) throw codeError("o cofre já foi fechado (close()); nada gravado", "CLOSED");
    if (this.lockToken || this.lockLost) this.assertLock();
    const data = encrypt(this.key, this.state);
    let usedReserve = false;
    try {
      this.writeVerified(data);
    } catch (e) {
      // Disco cheio: a reserva é exatamente para isto (gravar o login recém-renovado). Apaga e tenta mais uma vez.
      if (!DISK_FULL.has(e.code) || !this.dropReserve()) throw e;
      usedReserve = true;
      console.error(
        `[cofre] disco cheio ao gravar: apaguei a reserva ${path.basename(this.reserveFile)} (${RESERVE_BYTES / 1024 / 1024} MB) e tento de novo — libere espaço no disco`
      );
      this.writeVerified(data); // falhou de novo: lança (o cofre anterior ficou como estava)
    }
    this.mainBad = false;
    try {
      const dfd = fs.openSync(this.dir, "r");
      fs.fsyncSync(dfd);
      fs.closeSync(dfd);
    } catch {}
    if (!usedReserve) this.keepReserve(); // recria a reserva quando houver espaço (não na mesma gravação que a usou)
  }

  /** Grava `data` num temporário, confere, guarda a anterior (.1) e põe no lugar do principal. Erro → lança (temporário apagado). */
  writeVerified(data) {
    const tmp = `${this.file}.tmp-${process.pid}-${rand()}`;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, data); // grava tudo ou lança (ex.: ENOSPC) — writeSync sozinho pode gravar só parte
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      // Confere o que ficou no disco antes de pôr no lugar do principal.
      const back = fs.readFileSync(tmp);
      if (!back.equals(data)) throw new Error(`o temporário gravado não confere (${back.length} de ${data.length} bytes no disco)`);
      decrypt(this.key, back);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw codeError(`${e.message} (o cofre anterior ficou como estava)`, e.code);
    }
    this.keepPrevious();
    try {
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      throw codeError(`${e.message} (o cofre anterior ficou como estava)`, e.code);
    }
  }

  // ------------------------------------------------------------------ reserva de espaço

  /**
   * Garante store.reserve (RESERVE_BYTES de bytes aleatórios: disco com compressão não "economiza" a reserva).
   * Grava num temporário e renomeia. Nunca lança; sem espaço, tenta de novo depois de RESERVE_RETRY_MS (`force` ignora a espera).
   */
  keepReserve(force = false) {
    if (this.reserveOk || this.closed) return;
    if (!force && Date.now() < this.reserveRetryAt) return;
    try {
      const st = fs.statSync(this.reserveFile);
      if (st.isFile() && st.size >= RESERVE_BYTES) {
        this.reserveOk = true;
        return;
      }
    } catch {}
    const tmp = `${this.reserveFile}.tmp-${process.pid}-${rand()}`;
    try {
      const fd = fs.openSync(tmp, "wx", 0o600);
      try {
        fs.writeFileSync(fd, crypto.randomBytes(RESERVE_BYTES));
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, this.reserveFile);
      this.reserveOk = true;
      this.reserveRetryAt = 0;
      this.warned.reserve = null;
    } catch (e) {
      try {
        fs.unlinkSync(tmp);
      } catch {}
      this.reserveRetryAt = Date.now() + RESERVE_RETRY_MS;
      this.warnOnce("reserve", e, `[cofre] não consegui criar a reserva de espaço ${path.basename(this.reserveFile)}: ${e.message} — tento de novo mais tarde`);
    }
  }

  /** Apaga a reserva para liberar espaço. true se havia reserva para apagar. */
  dropReserve() {
    this.reserveOk = false;
    try {
      fs.unlinkSync(this.reserveFile);
      return true;
    } catch {
      return false;
    }
  }

  /** store.enc.1 = o store.enc atual, por hard link (link num temporário + rename; sem copiar bytes). Falha só vai para o log. */
  keepPrevious() {
    if (this.mainBad) return; // o principal não abriu no load: a .1 é a única cópia boa, não troca por ele
    const prev = this.file + ".1";
    const tmp = `${prev}.tmp-${process.pid}-${rand()}`;
    try {
      fs.linkSync(this.file, tmp);
    } catch (e) {
      if (e.code !== "ENOENT") this.warnOnce("previous", e, `[cofre] não consegui guardar a cópia anterior (${path.basename(prev)}): ${e.message} — a gravação continua`);
      return;
    }
    try {
      fs.renameSync(tmp, prev);
    } catch (e) {
      this.warnOnce("previous", e, `[cofre] não consegui guardar a cópia anterior (${path.basename(prev)}): ${e.message} — a gravação continua`);
    } finally {
      // rename entre dois nomes do mesmo arquivo não faz nada e deixa o temporário: apaga sempre.
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  }

  /** Grava agora (em série com outras gravações). */
  save() {
    // Uma gravação que falhou não pode travar as próximas: a fila continua mesmo depois de um erro
    // (quem chamou recebe o erro dele).
    const p = this.writing.catch(() => {}).then(() => this.saveSync());
    this.writing = p.catch(() => {});
    return p;
  }

  /** Solta a trava da pasta. Grave antes (await save()): depois de fechado o cofre não grava mais. */
  close() {
    this.releaseLock();
    this.closed = true;
  }

  // ------------------------------------------------------------------ trava da pasta

  /** Cria store.lock com "wx"; trava velha (mtime > 30 s) é tirada do caminho. Ocupada → erro code BUSY. */
  acquireLock() {
    if (this.lockToken) return;
    const token = crypto.randomBytes(16).toString("hex");
    const body = `${JSON.stringify({ pid: process.pid, host: os.hostname(), since: new Date().toISOString(), token })}\n`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.writeFileSync(this.lockFile, body, { flag: "wx", mode: 0o600 });
        this.lockToken = token;
        this.lockBody = body;
        this.lockLost = false;
        withLock.add(this);
        hookExit();
        this.lockTimer = setInterval(() => this.touchLock(), LOCK_TOUCH_MS);
        this.lockTimer.unref();
        return;
      } catch (e) {
        if (e.code !== "EEXIST") throw e;
      }
      const age = lockAge(this.lockFile);
      if (age === null) continue; // sumiu entre uma coisa e outra: tenta de novo
      const info = readLock(this.lockFile);
      if (age <= LOCK_STALE_MS) throw busyError(this.lockFile, describeLock(info, age));
      // Velha: tira do caminho com rename (atômico) e confere se o que saiu é mesmo a velha —
      // outro processo pode ter assumido no meio tempo.
      const aside = `${this.lockFile}.velha-${process.pid}-${rand()}`;
      try {
        fs.renameSync(this.lockFile, aside);
      } catch (e) {
        if (e.code === "ENOENT") continue;
        throw e;
      }
      const asideAge = lockAge(aside);
      if (asideAge !== null && asideAge <= LOCK_STALE_MS) {
        // Tirei a trava nova de outro processo: devolve e desiste.
        try {
          fs.linkSync(aside, this.lockFile);
        } catch {}
        try {
          fs.unlinkSync(aside);
        } catch {}
        throw busyError(this.lockFile, describeLock(readLock(this.lockFile), asideAge));
      }
      try {
        fs.unlinkSync(aside);
      } catch {}
      console.error(`[cofre] trava velha em ${path.basename(this.lockFile)} (${describeLock(info, age)}); o dono parou — assumindo`);
    }
    throw busyError(this.lockFile, "outro processo pegou a trava ao mesmo tempo");
  }

  /** true se a trava ainda é nossa. Se o arquivo sumiu, tenta pegar de novo. Erro de leitura propaga. */
  checkLock() {
    const info = readLock(this.lockFile);
    if (info && info.token === this.lockToken) return true;
    if (info === null) {
      try {
        fs.writeFileSync(this.lockFile, this.lockBody, { flag: "wx", mode: 0o600 });
        console.error(`[cofre] a trava ${path.basename(this.lockFile)} tinha sumido; peguei de novo`);
        return true;
      } catch {}
    }
    return false;
  }

  /** Antes de gravar: a trava precisa ser nossa (senão outro processo é o dono do cofre agora). */
  assertLock() {
    if (!this.lockLost && this.checkLock()) return;
    this.markLost();
    throw busyError(this.lockFile, "a trava agora é de outro processo; este não grava mais o cofre por cima dele");
  }

  markLost() {
    if (!this.lockLost) {
      console.error(`[cofre] a trava ${path.basename(this.lockFile)} agora é de outro processo: este servidor não grava mais o cofre (pare um dos dois)`);
    }
    this.lockLost = true;
    if (this.lockTimer) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }
  }

  /** Sinal de vida: atualiza o mtime da trava (a cada LOCK_TOUCH_MS). */
  touchLock() {
    if (!this.lockToken || this.lockLost) return;
    try {
      if (!this.checkLock()) {
        this.markLost();
        return;
      }
      const t = new Date();
      fs.utimesSync(this.lockFile, t, t);
      this.warned.touch = null;
    } catch (e) {
      this.warnOnce("touch", e, `[cofre] não consegui atualizar a trava ${path.basename(this.lockFile)}: ${e.message}`);
    }
  }

  /** Solta a trava (só se ainda for nossa). Chamado por close() e no fim do processo. */
  releaseLock() {
    if (this.lockTimer) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }
    withLock.delete(this);
    const token = this.lockToken;
    this.lockToken = null;
    this.lockBody = null;
    if (!token || this.lockLost) return;
    try {
      const info = readLock(this.lockFile);
      if (info && info.token === token) fs.unlinkSync(this.lockFile);
    } catch {}
  }

  /** Log sem repetir o mesmo erro a cada gravação/sinal. */
  warnOnce(kind, e, message) {
    const k = (e && (e.code || e.message)) || "?";
    if (this.warned[kind] !== k) console.error(message);
    this.warned[kind] = k;
  }

  /** Apaga temporários de gravações interrompidas (só com a trava na mão: ninguém mais grava aqui). */
  removeTemps() {
    const base = path.basename(this.file);
    let names;
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(`${base}.tmp-`) || n.startsWith(`${base}.1.tmp-`) || n.startsWith(`${path.basename(this.reserveFile)}.tmp-`)) {
        try {
          fs.unlinkSync(path.join(this.dir, n));
        } catch {}
      }
    }
  }
}

module.exports = { Store, encrypt, decrypt, loadKey, emptyState, LOCK_STALE_MS, LOCK_TOUCH_MS };
