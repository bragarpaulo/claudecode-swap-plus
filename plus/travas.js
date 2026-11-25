"use strict";
// Travas entre janelas do VS Code (e entre processos) no mesmo computador, só com o sistema de arquivos.
//
// - withDirLock(dir, fn): roda fn com a trava `dir` (mkdir é atômico). Trava esquecida há mais de 5 s
//   (janela que fechou no meio) é tomada. Ocupada agora → null (fn não roda).
// - claimOnce(dir, key): reivindica `key` uma vez só por computador (arquivo criado com flag "wx").
//   true = esta janela ganhou; false = outra já tinha reivindicado.
// - sweepClaims(dir, maxAgeMs): apaga as reivindicações velhas.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const STALE_LOCK_MS = 5000;

/** Roda fn sob a trava `dir`. null = trava ocupada agora. Sem como travar (ex.: sem permissão): roda sem a trava. */
function withDirLock(dir, fn) {
  let made = false;
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
    made = true;
  } catch (e) {
    if (e.code !== "EEXIST") return fn();
    try {
      if (Date.now() - fs.statSync(dir).mtimeMs > STALE_LOCK_MS) {
        fs.rmdirSync(dir);
        fs.mkdirSync(dir, { mode: 0o700 });
        made = true;
      }
    } catch {}
    if (!made) return null;
  }
  try {
    return fn();
  } finally {
    try {
      fs.rmdirSync(dir);
    } catch {}
  }
}

/** Nome do arquivo da reivindicação (sha1 da chave: a chave pode ter qualquer caractere). */
const claimFile = (dir, key) => path.join(dir, crypto.createHash("sha1").update(String(key)).digest("hex"));

/** Reivindica `key` uma vez por computador. Sem como gravar (pasta sem permissão): true (melhor avisar do que calar). */
function claimOnce(dir, key) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(claimFile(dir, key), String(Date.now()), { flag: "wx", mode: 0o600 });
    return true;
  } catch (e) {
    return !(e && e.code === "EEXIST");
  }
}

/** Apaga as reivindicações com mais de maxAgeMs. → quantas apagou. */
function sweepClaims(dir, maxAgeMs, now = Date.now()) {
  let n = 0;
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!/^[0-9a-f]{40}$/.test(name)) continue;
    const f = path.join(dir, name);
    try {
      if (now - fs.statSync(f).mtimeMs > maxAgeMs) {
        fs.unlinkSync(f);
        n++;
      }
    } catch {}
  }
  return n;
}

module.exports = { withDirLock, claimOnce, sweepClaims, claimFile, STALE_LOCK_MS };
