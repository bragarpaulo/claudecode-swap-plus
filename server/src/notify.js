"use strict";
// Caixa de saída dos avisos ao dono (e-mail): o Swap Plus só ESCREVE um arquivo por aviso em DATA_DIR/avisos/.
// Um processo do host (fora do container) lê essa pasta a cada minuto e entrega ao Painel do Servidor, que manda
// o e-mail ao dono. Nada aqui usa rede, senha ou trava.
//
// Mesmo formato e mesmos limites do comando `servidor-aviso` do servidor (/usr/local/sbin/servidor-aviso):
// - arquivo `aviso-<AAAAMMDD-HHMMSS>-<8 hex>.json` (data e hora no fuso do servidor, TZ) com
//   {"id","assunto","texto","criado_em"} (criado_em = epoch em SEGUNDOS, inteiro), JSON compacto em UTF-8;
// - assunto em 1 linha, até 120 caracteres; texto até 2.000; sem caracteres de controle (no texto só a quebra de
//   linha fica); passou do limite → corta e põe "…". Assunto vazio = nada gravado;
// - id casando ^aviso-[A-Za-z0-9_-]{14,74}$;
// - gravação atômica: temporário `.<id>.tmp` (criado com O_EXCL) + rename. Quem lê a pasta nunca vê meio arquivo;
// - limpeza: avisos com mais de 48 h e o que passar de 500 arquivos saem (só arquivos aviso-*.json desta pasta).
// A pasta é criada com 0700 (e os arquivos 0600): o texto leva o e-mail das contas, e o host lê como root.
//
// Nunca lança: qualquer erro vai só para o log (quem avisa nunca falha por causa do aviso).
// NOTICES_ENABLED (opcional, padrão "1"): "0" (ou false/off/no/não) desliga — nada é gravado.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const NOTICES_SUBDIR = "avisos";
const SUBJECT_MAX = 120;
const TEXT_MAX = 2000;
const KEEP_MS = 48 * 3600 * 1000; // avisos mais velhos que isso saem da pasta
const MAX_FILES = 500; // e o excedente acima disso (os mais velhos primeiro)
const TMP_STALE_MS = 60 * 60 * 1000; // temporário esquecido (processo morreu no meio) sai depois de 1 h
const ID_RE = /^aviso-[A-Za-z0-9_-]{14,74}$/;
const FILE_RE = /^aviso-[A-Za-z0-9_-]{14,74}\.json$/;
const TMP_RE = /^\.aviso-[A-Za-z0-9_-]{14,74}\.tmp$/;
const OFF_RE = /^(0|false|off|no|nao|não|desligado)$/i;

const pad2 = (n) => String(n).padStart(2, "0");
const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v);

/** NOTICES_ENABLED: ausente/vazio = ligado (padrão "1"); "0" (false/off/no/não) = desligado. */
function noticesEnabled(env = process.env) {
  const v = env && env.NOTICES_ENABLED;
  if (v === undefined || v === null || String(v).trim() === "") return true;
  return !OFF_RE.test(String(v).trim());
}

/** A pasta dos avisos dentro da pasta de dados (DATA_DIR). */
function noticesDir(dataDir) {
  return path.join(String(dataDir), NOTICES_SUBDIR);
}

/** Corta em `max` caracteres (pontos de código, como o len() do Python): passou → `max - 1` + "…". */
function clip(s, max) {
  const cps = Array.from(s);
  if (cps.length <= max) return s;
  return cps.slice(0, max - 1).join("").trimEnd() + "…";
}

/** Assunto: uma linha só, sem caracteres de controle, espaços juntados (uma_linha do servidor-aviso). */
function oneLine(value, max = SUBJECT_MAX) {
  const s = String(value === undefined || value === null ? "" : value)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clip(s, max);
}

/** Texto: várias linhas; sem caracteres de controle além da quebra de linha (varias_linhas do servidor-aviso). */
function manyLines(value, max = TEXT_MAX) {
  let s = String(value === undefined || value === null ? "" : value)
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x09\x0b-\x1f\x7f]/g, " ");
  s = s
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return clip(s, max);
}

/** aviso-AAAAMMDD-HHMMSS-<8 hex> (hora local, fuso do servidor). */
function newId(ms) {
  const d = new Date(ms);
  const day = `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`;
  const time = `${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
  return `aviso-${day}-${time}-${crypto.randomBytes(4).toString("hex")}`;
}

function makeLog(log) {
  const pick = (k) => {
    const fn = log && typeof log[k] === "function" ? log[k].bind(log) : log && typeof log.log === "function" ? log.log.bind(log) : null;
    return (msg) => {
      try {
        if (fn) fn(msg);
      } catch {}
    };
  };
  return { info: pick("info"), warn: pick("warn"), error: pick("error") };
}

/** Motivo curto de um erro de arquivo (código do sistema, ou a mensagem), para o log. */
function why(e) {
  if (e && typeof e.code === "string" && e.code) return e.code;
  return String((e && e.message) || e || "erro").slice(0, 200);
}

/**
 * Tira os avisos velhos (mais de 48 h) e o excedente acima de 500, e temporários esquecidos.
 * Usa o relógio de verdade (o mtime dos arquivos é do relógio de verdade). Nunca lança. → quantos saíram
 */
function prune(folder, realNow = Date.now()) {
  let names;
  try {
    names = fs.readdirSync(folder);
  } catch {
    return 0;
  }
  const notices = [];
  let removed = 0;
  for (const name of names) {
    const file = path.join(folder, name);
    if (FILE_RE.test(name)) {
      try {
        notices.push([fs.statSync(file).mtimeMs, file]);
      } catch {}
    } else if (TMP_RE.test(name)) {
      try {
        if (realNow - fs.statSync(file).mtimeMs > TMP_STALE_MS) {
          fs.unlinkSync(file);
          removed += 1;
        }
      } catch {}
    }
  }
  notices.sort((a, b) => a[0] - b[0]);
  const excess = Math.max(0, notices.length - MAX_FILES);
  notices.forEach(([mtime, file], i) => {
    if (i < excess || realNow - mtime > KEEP_MS) {
      try {
        fs.unlinkSync(file);
        removed += 1;
      } catch {}
    }
  });
  return removed;
}

/**
 * writeNotice(dir, { subject, text }, { env?, now?, log? })
 *   dir   pasta de dados (DATA_DIR); o aviso vai para <dir>/avisos/ (criada com 0700 se faltar)
 *   env   para ler NOTICES_ENABLED (padrão process.env)
 *   now   relógio (ms) para o id e o criado_em (padrão Date.now)
 * → { ok: true, id, file, assunto, texto } | { ok: false, skipped: "disabled" } | { ok: false, error }
 * Nunca lança.
 */
function writeNotice(dir, notice, { env = process.env, now = Date.now, log = console } = {}) {
  const L = makeLog(log);
  let assunto = "";
  try {
    if (!noticesEnabled(env)) return { ok: false, skipped: "disabled" };
    if (typeof dir !== "string" || !dir.trim()) throw Object.assign(new Error("pasta de dados não definida"), { code: "sem_pasta" });
    const n = isObj(notice) ? notice : {};
    assunto = oneLine(n.subject, SUBJECT_MAX);
    if (!assunto) throw Object.assign(new Error("assunto vazio"), { code: "assunto_vazio" });
    const texto = manyLines(n.text, TEXT_MAX);
    let t = Number(now());
    if (!Number.isFinite(t) || t <= 0) t = Date.now();
    const folder = noticesDir(dir);
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { recursive: true, mode: 0o700 });

    for (let attempt = 0; attempt < 3; attempt++) {
      const id = newId(t);
      if (!ID_RE.test(id)) throw Object.assign(new Error("id fora do formato"), { code: "id_invalido" });
      const file = path.join(folder, `${id}.json`);
      const tmp = path.join(folder, `.${id}.tmp`);
      if (fs.existsSync(file)) continue; // o mesmo id (quase impossível): sorteia outro
      let fd;
      try {
        fd = fs.openSync(tmp, "wx", 0o600);
      } catch (e) {
        if (e && e.code === "EEXIST") continue;
        throw e;
      }
      try {
        fs.writeFileSync(fd, JSON.stringify({ id, assunto, texto, criado_em: Math.floor(t / 1000) }), "utf8");
        fs.fsyncSync(fd);
        fs.closeSync(fd);
        fd = null;
        fs.renameSync(tmp, file);
      } catch (e) {
        if (fd !== null && fd !== undefined) {
          try {
            fs.closeSync(fd);
          } catch {}
        }
        try {
          fs.unlinkSync(tmp);
        } catch {}
        throw e;
      }
      L.info(`[avisos] aviso ao dono gravado (${id}): ${assunto}`);
      prune(folder);
      return { ok: true, id, file, assunto, texto };
    }
    throw Object.assign(new Error("não achei um nome livre para o aviso"), { code: "sem_nome" });
  } catch (e) {
    L.error(`[avisos] não consegui gravar o aviso ao dono${assunto ? ` ("${assunto}")` : ""}: ${why(e)}`);
    return { ok: false, error: why(e) };
  }
}

/**
 * createNotifier({ dir, env?, now?, log? }) → notify({ subject, text }) (o writeNotice com a pasta e o relógio
 * presos). notify.enabled = NOTICES_ENABLED desta subida; notify.dir = a pasta dos avisos. Nunca lança.
 */
function createNotifier({ dir, env = process.env, now = Date.now, log = console } = {}) {
  const notify = (notice) => writeNotice(dir, notice, { env, now, log });
  notify.enabled = noticesEnabled(env);
  notify.dir = typeof dir === "string" && dir.trim() ? noticesDir(dir) : null;
  return notify;
}

module.exports = {
  writeNotice,
  createNotifier,
  noticesEnabled,
  noticesDir,
  oneLine,
  manyLines,
  prune,
  NOTICES_SUBDIR,
  SUBJECT_MAX,
  TEXT_MAX,
  KEEP_MS,
  MAX_FILES,
  ID_RE,
  FILE_RE,
};
