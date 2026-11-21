"use strict";
// Swap Plus Cliente — arquivos pequenos de estado: leitura tolerante, gravação atômica (temporário + rename,
// 0600) e a trava que garante um só cliente rodando por pasta de dados. Sem dependências.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function erro(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

/** Objeto JSON do arquivo; null se não existe; lança `arquivo_ilegivel` se existe e não é um objeto JSON. */
function lerJson(file) {
  let txt;
  try {
    txt = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw erro("arquivo_ilegivel", `Não consegui ler ${file}: ${e.message}`, { file });
  }
  let data;
  try {
    data = JSON.parse(txt);
  } catch {
    throw erro("arquivo_ilegivel", `O arquivo ${file} não é um JSON válido.`, { file });
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw erro("arquivo_ilegivel", `O arquivo ${file} não tem o formato esperado.`, { file });
  return data;
}

/** Pasta só do dono (0700). No Windows o modo não vale; a pasta do usuário já é só dele. */
function garantirPasta(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/**
 * Grava JSON de forma atômica: temporário exclusivo na mesma pasta (0600), fsync e rename por cima.
 * No Windows o rename falha se alguém estiver lendo o arquivo na hora: tenta de novo algumas vezes.
 */
async function gravarJson(file, data, mode = 0o600) {
  garantirPasta(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  let fh = null;
  try {
    fh = await fs.promises.open(tmp, "wx", mode);
    await fh.writeFile(JSON.stringify(data, null, 2) + "\n", "utf8");
    if (process.platform !== "win32") await fh.chmod(mode); // o umask pode ter tirado bits
    await fh.sync();
    await fh.close();
    fh = null;
    for (let i = 0; ; i++) {
      try {
        await fs.promises.rename(tmp, file);
        break;
      } catch (e) {
        const ocupado = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(e.code);
        if (!ocupado || i >= 9) throw e;
        await sleep(50 * (i + 1));
      }
    }
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fs.promises.unlink(tmp).catch(() => {});
    throw e;
  }
}

function apagar(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

/**
 * Trava "um só rodando": arquivo com { id, pid, em }. Quem roda renova `em` a cada ciclo; parada há mais de
 * `velhoMs` (processo morto sem soltar) pode ser tomada.
 *   → { renovar(), soltar(), id } | null (outro cliente está rodando nesta pasta)
 */
function travar(file, { agora = Date.now, velhoMs = 3 * 60 * 1000 } = {}) {
  garantirPasta(path.dirname(file));
  const id = `${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
  const conteudo = () => JSON.stringify({ id, pid: process.pid, em: agora() }) + "\n";
  // Criar: exclusivo (falha se já existe). Renovar: temporário + rename, para ninguém ler o arquivo pela metade
  // (uma leitura quebrada faria um segundo cliente tomar a trava de quem está vivo).
  const criar = () => fs.writeFileSync(file, conteudo(), { flag: "wx", mode: 0o600 });
  const regravar = () => {
    const tmp = `${file}.${id}.tmp`;
    try {
      fs.writeFileSync(tmp, conteudo(), { flag: "w", mode: 0o600 });
      fs.renameSync(tmp, file);
    } catch (e) {
      apagar(tmp);
      throw e;
    }
  };
  for (let tentativa = 0; tentativa < 2; tentativa++) {
    try {
      criar();
      break;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      let atual = null;
      try {
        atual = JSON.parse(fs.readFileSync(file, "utf8"));
      } catch {}
      const em = atual && Number(atual.em);
      const viva = Number.isFinite(em) && agora() - em <= velhoMs;
      if (viva || tentativa === 1) return null;
      apagar(file); // velha (ou ilegível): toma
    }
  }
  const minha = () => {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8")).id === id;
    } catch {
      return false;
    }
  };
  return {
    id,
    /** false = a trava não é mais deste processo (alguém tomou): quem roda deve parar. */
    renovar() {
      if (!minha()) return false;
      try {
        regravar();
      } catch {
        // Não conseguiu regravar agora (no Windows, alguém lendo o arquivo): a trava continua sendo deste processo.
      }
      return true;
    },
    soltar() {
      if (minha()) apagar(file);
    },
  };
}

module.exports = { lerJson, gravarJson, garantirPasta, apagar, travar, erro, sleep };
