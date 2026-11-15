"use strict";
// Swap Plus — leitura e gravação do login do Claude Code (modo servidor).
//
// Onde o Claude Code guarda o login:
//   - macOS: Keychain, serviço "Claude Code-credentials", conta = $USER (senão o
//     usuário do sistema). Com CLAUDE_CONFIG_DIR (ou CLAUDE_SECURESTORAGE_CONFIG_DIR)
//     o nome do serviço ganha um sufixo: "-" + 8 primeiros hex do sha256 do valor
//     da variável (NFC, sem resolver o caminho) — igual ao Claude Code.
//     Se o Keychain não tem o item, o Claude Code lê o arquivo (abaixo).
//   - Windows e Linux: <configHome>/.credentials.json (0600), onde
//     configHome = CLAUDE_CONFIG_DIR || ~/.claude
//     (ou CLAUDE_SECURESTORAGE_CONFIG_DIR quando definida; vazia = ~/.claude).
//   O JSON tem a chave claudeAiOauth (o login) e outras que NÃO são nossas
//   (mcpOAuth, mcpOAuthClientConfig, pluginSecrets, trustedDeviceToken...):
//   writeLive troca só claudeAiOauth e preserva o resto (com dropTrustedDevice
//   tira também trustedDeviceToken e trustedDeviceEnrolledAfterRefusalAtMs, que
//   são da conta — o próprio Claude Code apaga os dois no /login).
//   No Mac, se o arquivo reserva existe, writeLive o regrava a cada vez (o Claude
//   Code só percebe a troca feita no Keychain quando o mtime dele muda), mas só
//   com o que o PRÓPRIO arquivo já tinha + o claudeAiOauth novo: nada do Keychain
//   (mcpOAuth, pluginSecrets...) é copiado para o disco.
//   O cliente nunca grava refreshToken (no modo servidor só o servidor renova),
//   nem accessToken vazio ou expiresAt vencido (é a marca de "login morto" do
//   Claude Code). Credencial atual ilegível nunca é sobrescrita.
//
// Travas (as mesmas do Claude Code, pacote proper-lockfile; conferido no motor
// swap-plus/src/claude_swap/claude_locks.py e no Claude Code 2.1.325):
//   - a trava é um DIRETÓRIO; mkdir atômico é a exclusão mútua;
//   - login: primeiro <configHome>/.oauth_refresh.lock, depois a legada
//     realpath(<configHome>) + ".lock" (~/.claude.lock). Velhas só depois de 60 s;
//   - em volta da gravação, dentro dessas duas: <configHome>/.storage-write.lock
//     (velha depois de 15 s). Libera na ordem inversa;
//   - NÃO criamos o "<trava>.owner" (sem ele o Claude Code nunca rouba a nossa);
//   - ~/.claude.json: trava ~/.claude.json.lock, velha depois de 10 s;
//   - quem segura atualiza o mtime (aqui a cada 3 s; o Claude Code faz a cada 5 s),
//     mas só enquanto a trava ainda é a nossa (mesmo ino e birthtime de quando a
//     criamos). Se outro a tomou (ex.: o Mac dormiu, ela ficou velha e foi
//     tomada), paramos de mexer nela e a liberação NÃO a remove;
//   - espera no máximo ~9 s por trava, tentando a cada 250–500 ms;
//   - trava velha (mtime mais antigo que o limite) é tomada, com o diretório
//     irmão "<trava>.takeover" para que dois que esperam não tomem juntos;
//   - sempre libera no finally (no Windows o rmdir tenta de novo em EPERM/EBUSY).
//
// Keychain (macOS): o segredo NUNCA vai nos argumentos do processo `security`
// (a lista de processos é visível para outros programas). Vai pelo stdin do
// `security -i`: em hex (-X) ou, se a linha passar do limite, como texto entre
// aspas (-w; o `security -i` desfaz \" e \\). Se nem assim couber:
// keychain_payload_too_large, sem gravar nada. Erros do `security` só trazem
// código de saída/sinal (a mensagem do processo pode conter o segredo em hex).
//
// Nada aqui imprime token. Os objetos devolvidos por readLive() têm segredos:
// quem chama não deve registrá-los em log.

const { execFile } = require("child_process");
const { AsyncLocalStorage } = require("async_hooks");
const crypto = require("crypto");
const fs = require("fs");
const fsp = fs.promises;
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const KEYCHAIN_SERVICE = "Claude Code-credentials";
const SECURITY = "/usr/bin/security"; // caminho fixo: um "security" falso no PATH não pega o segredo
const KEYCHAIN_TIMEOUT_MS = 5000;
const KEYCHAIN_NOT_FOUND = 44; // errSecItemNotFound
// `security -i` lê o stdin com buffer de 4096 bytes por linha; linha maior é
// cortada no meio e corrompe a gravação. 64 bytes de folga, como no motor.
const SECURITY_STDIN_LINE_LIMIT = 4096 - 64;

// Chaves do topo da credencial que são da CONTA (apagadas com dropTrustedDevice).
const TRUSTED_DEVICE_KEYS = ["trustedDeviceToken", "trustedDeviceEnrolledAfterRefusalAtMs"];

// Tempos das travas (mutável só pelos testes, via _test.timings).
const LOCK = {
  waitMs: 9000, // espera máxima POR trava
  touchMs: 3000, // atualiza o mtime enquanto segura
  credStaleMs: 60000, // travas do login: velhas depois de 60 s
  storageStaleMs: 15000, // .storage-write.lock: velha depois de 15 s
  configStaleMs: 10000, // trava do ~/.claude.json: velha depois de 10 s
  takeoverStaleMs: 5000, // "<trava>.takeover" esquecido por quem morreu no meio
};

// Ganchos de teste: forçar arquivo, simular plataforma, trocar o Keychain por um falso.
const hooks = { store: null, platform: null, keychain: null };

// Travas que o contexto assíncrono atual já segura (permite chamar writeLive
// dentro de withClaudeCredentialLocks sem travar em si mesmo). Cada withLocks
// guarda { own: Set(diretórios que ELE pegou), active, parent }; no finally
// active=false, então um callback que rode depois da liberação (setTimeout,
// promessa solta) não acha que ainda segura a trava.
const heldLocks = new AsyncLocalStorage();

// ------------------------------------------------------------ utilidades

function fail(code, message, extra) {
  const e = new Error(message);
  e.code = code;
  if (extra) Object.assign(e, extra);
  return e;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, Math.max(0, ms)));
}

function isPlainObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function platform() {
  return hooks.platform || process.platform;
}

function useKeychain() {
  return platform() === "darwin" && hooks.store !== "file";
}

/** Código de erro do sistema (EACCES...) ou genérico: nunca a mensagem. */
function errCode(e) {
  return e && typeof e.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(e.code) ? e.code : "erro";
}

// ------------------------------------------------------------ caminhos

/** Pasta de configuração do Claude Code: CLAUDE_CONFIG_DIR || ~/.claude. */
function configHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

/**
 * Arquivo de configuração global do Claude Code (onde fica o oauthAccount).
 * Regra do Claude Code: <configHome>/.config.json (legado) quando é arquivo comum
 * e não está vazio — ou está vazio, é gravável e não existe .claude.json —;
 * senão (CLAUDE_CONFIG_DIR || ~)/.claude.json.
 */
function globalConfigPath() {
  const base = process.env.CLAUDE_CONFIG_DIR || os.homedir();
  const global = path.join(base, ".claude.json");
  const legacy = path.join(configHome(), ".config.json");
  try {
    const st = fs.statSync(legacy);
    if (st.isFile() && (st.size > 0 || ((st.mode & 0o222) !== 0 && !fs.existsSync(global)))) return legacy;
  } catch {}
  return global;
}

/** Onde fica o .credentials.json (Windows/Linux; no Mac é o reserva do Keychain). */
function credentialsPath() {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) {
    return path.join(secure || path.join(os.homedir(), ".claude"), ".credentials.json");
  }
  return path.join(configHome(), ".credentials.json");
}

/**
 * Caminho real, como o proper-lockfile do Claude Code calcula a trava (links
 * resolvidos com fs.realpath). Se o caminho ainda não existe, resolve só a
 * pasta-mãe; se nem ela, o caminho absoluto.
 */
function realPathLoose(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch {}
  try {
    return path.join(fs.realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {}
  return abs;
}

/** Travas do login, na ordem do Claude Code: primária e depois a legada (realpath(configHome) + ".lock"). */
function credentialLockDirs() {
  const home = path.resolve(configHome());
  return [path.join(home, ".oauth_refresh.lock"), realPathLoose(home) + ".lock"];
}

/** Trava que o Claude Code segura em toda escrita na credencial. */
function storageWriteLockDir() {
  return path.join(path.resolve(configHome()), ".storage-write.lock");
}

function configLockDir() {
  return globalConfigPath() + ".lock";
}

// ------------------------------------------------------------ travas

function lockTimeout(dir) {
  return fail(
    "lock_timeout",
    `O Claude Code está mexendo no login agora (trava ${path.basename(dir)} ocupada). Tente de novo em alguns segundos.`,
    { lockPath: dir }
  );
}

/** Dorme no máximo o que sobra do prazo (nunca passa do limite). */
function nap(ms, start) {
  const left = LOCK.waitMs - (performance.now() - start);
  return sleep(Math.min(ms, Math.max(0, left)));
}

/** Identidade de uma trava: muda se alguém a remover e criar de novo. */
async function lockIdentity(dir) {
  const st = await fsp.stat(dir, { bigint: true });
  return { ino: st.ino, birthtimeMs: st.birthtimeMs, birthtimeNs: st.birthtimeNs };
}

/** Identidade atual, ou null se a trava sumiu. Outros erros sobem. */
async function currentIdentity(dir) {
  try {
    return await lockIdentity(dir);
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

function sameLock(a, b) {
  return !!a && !!b && a.ino === b.ino && a.birthtimeMs === b.birthtimeMs && a.birthtimeNs === b.birthtimeNs;
}

async function rmdirWithRetry(dir) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rmdir(dir);
    } catch (e) {
      // Windows: antivírus/indexador com a pasta aberta.
      const busy = process.platform === "win32" && (e.code === "EPERM" || e.code === "EBUSY");
      if (!busy || i >= 9) throw e;
      await sleep(50 * (i + 1));
    }
  }
}

/** Remove a trava se ela continua velha, sob "<trava>.takeover". true = removeu. */
async function removeIfStillStale(dir, staleMs) {
  const takeover = dir + ".takeover";
  try {
    await fsp.mkdir(takeover);
  } catch (e) {
    if (e.code === "EEXIST") {
      // Outro está tomando agora; se o .takeover ficou para trás (dono morreu), limpa.
      try {
        const st = await fsp.lstat(takeover);
        if (Date.now() - st.mtimeMs > LOCK.takeoverStaleMs) {
          if (st.isDirectory()) await fsp.rmdir(takeover);
          else await fsp.unlink(takeover);
        }
      } catch {}
    }
    return false;
  }
  try {
    // Confere de novo lá dentro: quem veio antes pode já ter tomado a trava.
    const st = await fsp.stat(dir);
    if (Date.now() - st.mtimeMs <= staleMs) return false;
    await fsp.rmdir(dir);
    return true;
  } catch {
    return false;
  } finally {
    await fsp.rmdir(takeover).catch(() => {});
  }
}

/** Pega uma trava (diretório). Devolve a função que libera. Lança lock_timeout. */
async function acquireLock(dir, staleMs) {
  await fsp.mkdir(path.dirname(dir), { recursive: true });
  const start = performance.now();
  let mine = null;
  for (;;) {
    let made = false;
    try {
      await fsp.mkdir(dir); // sem recursive: precisa falhar se já existe
      made = true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (made) {
      // Guarda a identidade da trava que criamos: depois só mexemos nela se ainda for esta.
      try {
        mine = await lockIdentity(dir);
        break;
      } catch (e) {
        if (e.code !== "ENOENT") {
          await fsp.rmdir(dir).catch(() => {});
          throw e;
        }
        // Sumiu logo depois de criada: tenta de novo.
      }
    }
    if (performance.now() - start > LOCK.waitMs) throw lockTimeout(dir);
    let st;
    try {
      st = await fsp.stat(dir);
    } catch (e) {
      // Sumiu entre o mkdir e o stat (ou é link quebrado): tenta de novo logo.
      if (e.code === "ENOENT") {
        await nap(50, start);
        continue;
      }
      throw e;
    }
    if (Date.now() - st.mtimeMs > staleMs) {
      // Dono morto segundo o protocolo: remove e tenta pegar de novo.
      if (!(await removeIfStillStale(dir, staleMs))) await nap(50, start);
      continue;
    }
    await nap(250 + Math.random() * 250, start);
  }

  // Seguramos: mantém o mtime novo para ninguém achar que a trava é velha —
  // mas só enquanto ela ainda é a nossa.
  let lost = false;
  let busy = false;
  let warned = false;
  const timer = setInterval(async () => {
    if (lost || busy) return;
    busy = true;
    try {
      const cur = await currentIdentity(dir);
      if (!sameLock(cur, mine)) {
        lost = true;
        clearInterval(timer);
        console.warn(`[swap-plus] a trava ${dir} não é mais a nossa (sumiu ou foi tomada por outro processo); parei de renová-la`);
        return;
      }
      const now = new Date();
      await fsp.utimes(dir, now, now);
    } catch (e) {
      if (!warned) {
        warned = true;
        console.warn(`[swap-plus] não consegui atualizar a trava ${dir}: ${errCode(e)}`);
      }
    } finally {
      busy = false;
    }
  }, LOCK.touchMs);
  if (timer.unref) timer.unref();

  return async function release() {
    clearInterval(timer);
    let cur;
    try {
      cur = await currentIdentity(dir);
    } catch (e) {
      // Sem conferir que é a nossa, não remove (fica velha e o protocolo resolve).
      console.warn(`[swap-plus] não consegui conferir a trava ${dir} para liberá-la: ${errCode(e)}`);
      return;
    }
    if (!cur) {
      console.warn(`[swap-plus] a trava ${dir} sumiu enquanto estava conosco (tomada como velha?)`);
      return;
    }
    if (!sameLock(cur, mine)) {
      console.warn(`[swap-plus] a trava ${dir} foi tomada por outro processo enquanto estava conosco; não a removi`);
      return;
    }
    try {
      await rmdirWithRetry(dir);
    } catch (e) {
      if (e.code === "ENOENT") console.warn(`[swap-plus] a trava ${dir} sumiu enquanto estava conosco (tomada como velha?)`);
      else console.warn(`[swap-plus] não consegui liberar a trava ${dir}: ${errCode(e)}`);
    }
  };
}

/** Diretórios de trava que o contexto atual segura DE FATO (só os ainda ativos). */
function heldDirs(ctx) {
  const out = new Set();
  for (let c = ctx; c; c = c.parent) if (c.active) for (const d of c.own) out.add(d);
  return out;
}

/** Roda fn segurando as travas (em ordem). Reentrante no mesmo contexto assíncrono. */
async function withLocks(specs, fn) {
  const parent = heldLocks.getStore() || null;
  const held = heldDirs(parent);
  const needed = specs.filter((s) => !held.has(s.dir));
  if (!needed.length) return await fn();
  const ctx = { own: new Set(), active: true, parent };
  const releases = [];
  try {
    for (const s of needed) {
      releases.push(await acquireLock(s.dir, s.staleMs));
      ctx.own.add(s.dir);
    }
    return await heldLocks.run(ctx, () => fn());
  } finally {
    ctx.active = false; // callbacks que rodarem depois daqui pegam as travas de novo
    for (const release of releases.reverse()) await release();
  }
}

/**
 * Roda fn() segurando as travas do login do Claude Code (primária e legada).
 * Devolve o que fn devolver. Lança lock_timeout se o Claude Code segurar demais.
 * writeLive() chamado lá dentro (e aguardado lá dentro) não pega as travas de novo.
 */
function withClaudeCredentialLocks(fn) {
  const [primary, legacy] = credentialLockDirs();
  return withLocks(
    [
      { dir: primary, staleMs: LOCK.credStaleMs },
      { dir: legacy, staleMs: LOCK.credStaleMs },
    ],
    fn
  );
}

function withStorageWriteLock(fn) {
  return withLocks([{ dir: storageWriteLockDir(), staleMs: LOCK.storageStaleMs }], fn);
}

function withConfigLock(fn) {
  return withLocks([{ dir: configLockDir(), staleMs: LOCK.configStaleMs }], fn);
}

// ------------------------------------------------------------ arquivos

/** Texto do arquivo, ou null se não existe. Outros erros sobem. */
async function readTextFile(file) {
  try {
    const text = await fsp.readFile(file, "utf8");
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

/** Grava ATRAVÉS de um link simbólico (o rename por cima do link o desfaria). */
async function resolveLinkTarget(file) {
  let st;
  try {
    st = await fsp.lstat(file);
  } catch {
    return file;
  }
  if (!st.isSymbolicLink()) return file;
  try {
    return await fsp.realpath(file);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // Link quebrado: grava onde ele aponta.
    return path.resolve(path.dirname(file), await fsp.readlink(file));
  }
}

async function renameWithRetry(from, to) {
  for (let i = 0; ; i++) {
    try {
      return await fsp.rename(from, to);
    } catch (e) {
      // Windows: antivírus/indexador ou o próprio Claude Code com o arquivo aberto.
      const busy = process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(e.code);
      if (!busy || i >= 9) throw e;
      await sleep(50 * (i + 1));
    }
  }
}

/** Gravação atômica: temporário ao lado (já com `mode`), fsync, rename por cima. */
async function atomicWrite(file, text, mode) {
  const target = await resolveLinkTarget(file);
  const tmp = path.join(
    path.dirname(target),
    `${path.basename(target).slice(0, 40)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`
  );
  let fh = null;
  try {
    fh = await fsp.open(tmp, "wx", mode);
    await fh.writeFile(text, "utf8");
    if (process.platform !== "win32") await fh.chmod(mode); // o umask pode ter tirado bits
    try {
      await fh.sync();
    } catch (e) {
      if (!["EINVAL", "ENOTSUP", "EPERM", "ENOSYS"].includes(e.code)) throw e;
    }
    await fh.close();
    fh = null;
    await renameWithRetry(tmp, target);
  } catch (e) {
    if (fh) await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
}

// ------------------------------------------------------------ Keychain (macOS)

/** Nome da conta no Keychain, igual ao getUsername() do Claude Code. */
function keychainAccount() {
  if (process.env.USER) return process.env.USER;
  try {
    const u = os.userInfo().username;
    if (u) return u;
  } catch {}
  return "claude-code-user";
}

function hashedService(value) {
  const digest = crypto.createHash("sha256").update(String(value).normalize("NFC"), "utf8").digest("hex");
  return `${KEYCHAIN_SERVICE}-${digest.slice(0, 8)}`;
}

function isDefaultProfile() {
  try {
    return fs.realpathSync(configHome()) === fs.realpathSync(path.join(os.homedir(), ".claude"));
  } catch {
    return false;
  }
}

/**
 * Serviços do Keychain com o login deste ambiente, na ordem de leitura.
 * O primeiro é o que o Claude Code lê (e o único que gravamos); o segundo só
 * existe quando CLAUDE_CONFIG_DIR aponta para o próprio ~/.claude.
 */
function keychainServices() {
  const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  if (secure !== undefined) return [secure ? hashedService(secure) : KEYCHAIN_SERVICE];
  const dir = process.env.CLAUDE_CONFIG_DIR;
  if (!dir) return [KEYCHAIN_SERVICE];
  const list = [hashedService(dir)];
  if (isDefaultProfile()) list.push(KEYCHAIN_SERVICE);
  return list;
}

function runSecurity(args, input) {
  return new Promise((resolve) => {
    let child;
    try {
      child = execFile(
        SECURITY,
        args,
        { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: "utf8" },
        (err, stdout, stderr) => {
          let code = 0;
          if (err) code = typeof err.code === "number" ? err.code : -1;
          resolve({ code, stdout: stdout || "", stderr: String(stderr || "").trim(), timedOut: !!(err && err.killed), err });
        }
      );
    } catch (err) {
      return resolve({ code: -1, stdout: "", stderr: "", timedOut: false, err });
    }
    if (child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(input === undefined ? undefined : input);
    }
  });
}

/**
 * Erro do `security` SEM a mensagem do processo nem o stderr (podem conter o
 * comando com o segredo em hex): só código de saída, sinal ou código do sistema.
 */
function securityError(op, r) {
  const err = r && r.err;
  const signal = err && typeof err.signal === "string" && /^SIG[A-Z0-9]+$/.test(err.signal) ? err.signal : null;
  let why;
  if (r && r.timedOut) why = `demorou mais de ${KEYCHAIN_TIMEOUT_MS / 1000} s`;
  else if (signal) why = `interrompido pelo sinal ${signal}`;
  else if (!r || r.code === -1) why = err && typeof err.code === "string" && /^[A-Z][A-Z0-9_]*$/.test(err.code) ? err.code : "não consegui rodar";
  else why = `código ${Number(r.code)}`;
  return fail("keychain_error", `security ${op} falhou (${why})`, { exitCode: r ? r.code : -1, signal });
}

/** Aspas para uma linha do `security -i` (ele re-separa a linha e desfaz \" e \\). */
function quoteSecurity(value) {
  const s = String(value);
  // Quebra de linha terminaria a linha no meio (o resto viraria outro comando); NUL a cortaria.
  if (/[\r\n\0]/.test(s)) {
    throw fail("keychain_bad_value", "Valor com quebra de linha não pode ir para o Keychain pelo `security -i`. Nada foi gravado.");
  }
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function payloadTooLarge(bytes) {
  return fail(
    "keychain_payload_too_large",
    "O login do Claude Code ficou grande demais para gravar no Keychain com segurança (pela linha de comando o segredo ficaria visível para outros programas). Nada foi gravado. Remova do Claude Code os logins de MCP que você não usa e tente de novo.",
    { bytes }
  );
}

/**
 * Como gravar no Keychain: SEMPRE pelo stdin do `security -i` (o segredo não
 * aparece na lista de processos). Primeiro em hexadecimal (-X); se a linha
 * passar do limite do stdin, como texto entre aspas (-w); se ainda passar,
 * lança keychain_payload_too_large. Lança keychain_bad_value se conta/serviço
 * (ou o texto, no modo -w) tiver quebra de linha.
 * → { mode: "stdin", encoding: "hex" | "text", args: ["-i"], input }
 */
function securityAddCommand(account, service, value) {
  const head = `add-generic-password -U -a ${quoteSecurity(account)} -s ${quoteSecurity(service)}`;
  const fits = (line) => Buffer.byteLength(line, "utf8") <= SECURITY_STDIN_LINE_LIMIT;
  const hexLine = `${head} -X ${Buffer.from(String(value), "utf8").toString("hex")}\n`;
  if (fits(hexLine)) return { mode: "stdin", encoding: "hex", args: ["-i"], input: hexLine };
  const textLine = `${head} -w ${quoteSecurity(value)}\n`;
  if (fits(textLine)) return { mode: "stdin", encoding: "text", args: ["-i"], input: textLine };
  throw payloadTooLarge(Buffer.byteLength(textLine, "utf8"));
}

/** Valor do item, ou null se não existe. Lança keychain_error (trancado, negado, demora). */
async function realKeychainGet(service, account) {
  let last = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runSecurity(["find-generic-password", "-a", account, "-w", "-s", service]);
    if (r.code === 0) {
      let v = r.stdout.endsWith("\n") ? r.stdout.slice(0, -1) : r.stdout;
      // `-w` devolve em hex quando o conteúdo tem bytes não imprimíveis (ex.: acentos).
      if (v && v[0] !== "{" && /^[0-9a-fA-F]+$/.test(v) && v.length % 2 === 0) {
        const decoded = Buffer.from(v, "hex").toString("utf8");
        if (decoded.trimStart().startsWith("{")) v = decoded;
      }
      return v;
    }
    if (r.code === KEYCHAIN_NOT_FOUND) return null;
    last = r;
    if (attempt === 0) await sleep(300); // Keychain ocupado logo depois de acordar etc.
  }
  throw securityError("find-generic-password", last);
}

async function realKeychainSet(service, account, value) {
  const cmd = securityAddCommand(account, service, value); // nunca pela linha de comando
  const r = await runSecurity(cmd.args, cmd.input);
  if (r.code !== 0) throw securityError("add-generic-password", r);
}

function keychainGet(service, account) {
  return hooks.keychain ? hooks.keychain.get(service, account) : realKeychainGet(service, account);
}

function keychainSet(service, account, value) {
  return hooks.keychain ? hooks.keychain.set(service, account, value) : realKeychainSet(service, account, value);
}

const KEYCHAIN_UNAVAILABLE_MSG =
  "Não consegui ler o login do Claude Code no Keychain (trancado ou sem permissão). Desbloqueie o Keychain e tente de novo.";

function keychainUnavailable(cause) {
  return fail("keychain_unavailable", KEYCHAIN_UNAVAILABLE_MSG, { cause });
}

// ------------------------------------------------------------ login (claudeAiOauth)

/** JSON da credencial: {} se vazia; null se não é um objeto JSON válido. */
function parseCredentialText(text) {
  if (text == null || !String(text).trim()) return {};
  try {
    const v = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

/** Objeto JSON, ou null (vazio ou inválido). Para o ~/.claude.json. */
function parseJsonObject(text) {
  if (!text || !String(text).trim()) return null;
  try {
    const v = JSON.parse(text);
    return isPlainObject(v) ? v : null;
  } catch {
    return null;
  }
}

function keychainWhere(service) {
  return `O login do Claude Code no Keychain (serviço "${service}")`;
}

function fileWhere(file) {
  return `O arquivo ${file}`;
}

/** "Não consegui ler o login atual": o chamador distingue de "não há login" (null). */
function liveUnreadable(reason, message, extra) {
  return fail("live_unreadable", message, { reason, ...(extra || {}) });
}

function liveInvalidJson(where, extra) {
  return liveUnreadable("invalid_json", `${where} não é um JSON válido; não consegui ler o login atual.`, extra);
}

function liveFileError(file, e) {
  return liveUnreadable(errCode(e), `Não consegui ler ${file} (${errCode(e)}).`, { path: file, cause: e });
}

/** Credencial atual ilegível: NÃO sobrescreve (perderia mcpOAuth etc.), igual ao writeOauthAccount. */
function credentialsUnreadable(where, extra) {
  return fail(
    "credentials_unreadable",
    `${where} existe mas não é um JSON válido — não vou sobrescrever (perderia o que mais está guardado nele, como os logins de MCP). Conserte ou apague e entre de novo no Claude Code, e tente de novo.`,
    extra
  );
}

/** Texto do login atual e de onde veio. null = não há login. Lança live_unreadable. */
async function readCurrentText() {
  const file = credentialsPath();
  const readFile = async () => {
    try {
      return await readTextFile(file);
    } catch (e) {
      throw liveFileError(file, e);
    }
  };
  if (useKeychain()) {
    let kcError = null;
    for (const service of keychainServices()) {
      try {
        const v = await keychainGet(service, keychainAccount());
        if (v) return { text: v, source: "keychain", where: keychainWhere(service), service };
      } catch (e) {
        kcError = e;
        break;
      }
    }
    // O Claude Code também cai no arquivo quando o Keychain não tem (ou não abre).
    const text = await readFile();
    if (text !== null) return { text, source: "file", where: fileWhere(file), path: file };
    if (kcError) throw liveUnreadable("keychain_unavailable", KEYCHAIN_UNAVAILABLE_MSG, { cause: kcError });
    return null;
  }
  const text = await readFile();
  return text === null ? null : { text, source: "file", where: fileWhere(file), path: file };
}

/**
 * Login atual do Claude Code.
 * → { claudeAiOauth, raw, source } | null
 *   raw = o JSON inteiro da credencial (com mcpOAuth etc.); source = "keychain" | "file".
 *   null = NÃO HÁ login (nenhuma credencial, vazia, ou sem claudeAiOauth).
 * Lança live_unreadable quando NÃO CONSEGUIU LER (e.reason: "keychain_unavailable"
 * — Keychain trancado e sem arquivo reserva —, "invalid_json" ou o código do
 * erro de arquivo, ex. "EACCES").
 */
async function readLive() {
  const cur = await readCurrentText();
  if (!cur) return null;
  const raw = parseCredentialText(cur.text);
  if (!raw) throw liveInvalidJson(cur.where, cur.service ? { service: cur.service } : { path: cur.path });
  if (!isPlainObject(raw.claudeAiOauth)) return null;
  return { claudeAiOauth: raw.claudeAiOauth, raw, source: cur.source };
}

/**
 * Cópia do claudeAiOauth pronta para gravar: sem chaves indefinidas e SEM
 * refreshToken (no modo servidor o cliente nunca grava refresh token).
 * Recusa (bad_credential) accessToken vazio e expiresAt ausente/vencido: o
 * Claude Code trata accessToken "" / expiresAt 0 como "login morto".
 */
function cleanOauth(o) {
  if (!isPlainObject(o)) throw fail("bad_credential", "Credencial recebida inválida (faltam accessToken e expiresAt).");
  if (typeof o.accessToken !== "string" || !o.accessToken.trim()) {
    throw fail("bad_credential", "Credencial recebida inválida (accessToken vazio ou ausente).");
  }
  if (typeof o.expiresAt !== "number" || !Number.isFinite(o.expiresAt)) {
    throw fail("bad_credential", "Credencial recebida inválida (expiresAt ausente).");
  }
  if (o.expiresAt <= Date.now()) throw fail("bad_credential", "Credencial recebida já vencida (expiresAt no passado).");
  const out = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || k === "refreshToken") continue;
    out[k] = v;
  }
  return out;
}

function compose(base, oauth, opts) {
  // Troca o claudeAiOauth inteiro (um refreshToken antigo não sobrevive) e preserva o resto.
  const out = { ...(base || {}) };
  if (opts && opts.dropTrustedDevice) for (const k of TRUSTED_DEVICE_KEYS) delete out[k];
  out.claudeAiOauth = oauth;
  return JSON.stringify(out);
}

function writeOptions(o) {
  if (o == null) return { canReplace: null, dropTrustedDevice: false };
  if (!isPlainObject(o)) throw fail("bad_option", "Opções de writeLive inválidas.");
  if (o.canReplace != null && typeof o.canReplace !== "function") throw fail("bad_option", "canReplace precisa ser uma função.");
  return { canReplace: o.canReplace || null, dropTrustedDevice: o.dropTrustedDevice === true };
}

/**
 * Compare-and-swap (já sob as travas): se o login atual tem refreshToken (login
 * novo feito neste computador), só grava por cima se canReplace(atual) devolver
 * true. Senão lança live_changed.
 */
async function checkReplace(opts, base, source) {
  if (!opts.canReplace) return;
  const o = base.claudeAiOauth;
  if (!isPlainObject(o) || !o.refreshToken) return; // sem refresh token não há o que perder
  const copy = JSON.parse(JSON.stringify(base)); // o callback não mexe no que vamos gravar
  const ok = await opts.canReplace({ claudeAiOauth: copy.claudeAiOauth, raw: copy, source });
  if (ok !== true) {
    throw fail("live_changed", "O login do Claude Code mudou neste computador (login novo) — não gravei por cima. Tente de novo em instantes.");
  }
}

async function writeFileLive(oauth, opts) {
  const file = credentialsPath();
  const cas = !!opts.canReplace;
  let text;
  try {
    text = await readTextFile(file);
  } catch (e) {
    if (cas) throw liveFileError(file, e);
    throw e;
  }
  const base = parseCredentialText(text);
  if (!base) throw cas ? liveInvalidJson(fileWhere(file), { path: file }) : credentialsUnreadable(fileWhere(file), { path: file });
  await checkReplace(opts, base, "file");
  await fsp.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await atomicWrite(file, compose(base, oauth, opts), 0o600);
  return { store: "file" };
}

async function writeKeychainLive(oauth, opts) {
  const service = keychainServices()[0];
  const account = keychainAccount();
  const cas = !!opts.canReplace;
  let current;
  try {
    current = await keychainGet(service, account);
  } catch (e) {
    // Sem ler o atual não dá para preservar mcpOAuth etc.: não grava às cegas.
    if (cas) throw liveUnreadable("keychain_unavailable", KEYCHAIN_UNAVAILABLE_MSG, { cause: e });
    throw keychainUnavailable(e);
  }
  const file = credentialsPath();
  let fileText = null;
  let fileError = null;
  try {
    fileText = await readTextFile(file);
  } catch (e) {
    fileError = e;
  }

  // Base = o que o Claude Code lê hoje: o item do Keychain; se ele não existe, o arquivo reserva.
  let base;
  let source;
  if (current) {
    source = "keychain";
    base = parseCredentialText(current);
    if (!base) throw cas ? liveInvalidJson(keychainWhere(service), { service }) : credentialsUnreadable(keychainWhere(service), { service });
  } else {
    source = "file";
    if (fileError) throw cas ? liveFileError(file, fileError) : fileError;
    base = parseCredentialText(fileText);
    if (!base) throw cas ? liveInvalidJson(fileWhere(file), { path: file }) : credentialsUnreadable(fileWhere(file), { path: file });
  }
  await checkReplace(opts, base, source);

  const next = compose(base, oauth, opts);
  // Antes de gravar qualquer coisa: cabe no stdin do `security -i`? (senão erro, nada gravado)
  securityAddCommand(account, service, next);
  try {
    await keychainSet(service, account, next);
  } catch (e) {
    if (e && (e.code === "keychain_payload_too_large" || e.code === "keychain_bad_value")) throw e;
    throw fail("keychain_write_failed", "Não consegui gravar o login no Keychain. Desbloqueie o Keychain e tente de novo.", { cause: e });
  }

  // Arquivo reserva já existente: regrava (o mtime muda e o Claude Code aberto
  // recarrega o login na hora), mas só com o conteúdo DELE + o claudeAiOauth novo —
  // nada do Keychain vai para o disco. Nunca cria o arquivo no Mac.
  if (fileError) {
    console.warn(`[swap-plus] Keychain gravado, mas não consegui ler ${file}: ${errCode(fileError)}`);
  } else if (fileText !== null) {
    const own = parseCredentialText(fileText);
    if (!own) {
      console.warn(`[swap-plus] Keychain gravado; ${file} não é um JSON válido e ficou como estava`);
    } else {
      try {
        await atomicWrite(file, compose(own, oauth, opts), 0o600);
      } catch (e) {
        console.warn(`[swap-plus] Keychain gravado, mas não consegui atualizar ${file}: ${errCode(e)}`);
      }
    }
  }
  return { store: "keychain" };
}

/**
 * Grava o login (claudeAiOauth) do Claude Code, sob as travas do Claude Code
 * (.oauth_refresh.lock, a legada e, em volta da gravação, .storage-write.lock).
 * Mescla só a chave claudeAiOauth, preservando as outras. Nunca grava refreshToken.
 * Opções:
 *   - dropTrustedDevice: true → tira também trustedDeviceToken e
 *     trustedDeviceEnrolledAfterRefusalAtMs (são da conta). Padrão: mantém.
 *   - canReplace(atual) → true para permitir: compare-and-swap. Dentro das
 *     travas, relê a credencial que será sobrescrita; se a leitura falhar lança
 *     live_unreadable; se o login atual tem refreshToken e canReplace não
 *     devolve true, lança live_changed. `atual` = { claudeAiOauth, raw, source }.
 * → { store: "keychain" | "file" }
 * Lança bad_credential, bad_option, lock_timeout, keychain_unavailable,
 * credentials_unreadable, live_unreadable, live_changed, keychain_payload_too_large,
 * keychain_bad_value, keychain_write_failed ou erro de arquivo (EACCES...).
 */
async function writeLive(claudeAiOauth, options) {
  const oauth = cleanOauth(claudeAiOauth);
  const opts = writeOptions(options);
  return withClaudeCredentialLocks(() =>
    withStorageWriteLock(() => (useKeychain() ? writeKeychainLive(oauth, opts) : writeFileLive(oauth, opts)))
  );
}

// ------------------------------------------------------------ avisos sobre onde o Claude Code lê

const TRUTHY = /^(1|true|yes|on)$/i;

function flagOn(v) {
  if (v === true || v === 1) return true;
  if (typeof v === "string") return TRUTHY.test(v.trim());
  if (isPlainObject(v)) return ["value", "on", "enabled", "defaultValue"].some((k) => v[k] === true || v[k] === 1 || (typeof v[k] === "string" && TRUTHY.test(v[k].trim())));
  return false;
}

/** Procura `key` num cache de recursos (objeto ou lista), tolerante ao formato. */
function findFlag(obj, key, depth) {
  if (!obj || typeof obj !== "object" || depth < 0) return undefined;
  if (Array.isArray(obj)) {
    for (const x of obj) {
      if (isPlainObject(x) && (x.name === key || x.key === key || x.id === key)) return x;
      const r = findFlag(x, key, depth - 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
  for (const v of Object.values(obj)) {
    const r = findFlag(v, key, depth - 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** O recurso tengu_windows_credman está ligado em algum cache de recursos do ~/.claude.json? */
function windowsCredmanFlagOn() {
  let data;
  try {
    let text = fs.readFileSync(globalConfigPath(), "utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    data = JSON.parse(text);
  } catch {
    return false;
  }
  if (!isPlainObject(data)) return false;
  for (const [k, v] of Object.entries(data)) {
    if (!/^cached/i.test(k) && !/(feature|gate|flag)/i.test(k)) continue;
    try {
      if (flagOn(findFlag(v, "tengu_windows_credman", 4))) return true;
    } catch {}
  }
  return false;
}

/**
 * Avisos (em português) quando o login que o Swap Plus grava pode não ser o que
 * o Claude Code usa. Só leitura; nunca lança. → string[] (vazio = tudo certo).
 * Síncrona (devolve a lista direto; `await` nela também funciona).
 */
function credentialStoreWarnings() {
  const out = [];
  try {
    const env = process.env;
    if (env.CLAUDE_CODE_OAUTH_TOKEN) {
      out.push(
        "A variável de ambiente CLAUDE_CODE_OAUTH_TOKEN está definida: o Claude Code usa o token dela no lugar do login guardado, então a conta que o Swap Plus grava não é a usada. Remova a variável para a troca de conta valer."
      );
    }
    if (env.ANTHROPIC_API_KEY) {
      out.push(
        "A variável de ambiente ANTHROPIC_API_KEY está definida: ela passa na frente do login guardado (o Claude Code usa a chave de API, não a conta que o Swap Plus grava). Remova a variável para a troca de conta valer."
      );
    }
    if (platform() === "win32") {
      let why = null;
      if (TRUTHY.test(String(env.CLAUDE_CODE_FORCE_WINDOWS_CREDMAN || "").trim())) why = "CLAUDE_CODE_FORCE_WINDOWS_CREDMAN=1";
      else if (windowsCredmanFlagOn()) why = "recurso tengu_windows_credman ligado no ~/.claude.json";
      if (why) {
        out.push(
          `O Claude Code está lendo o login primeiro do Gerenciador de Credenciais do Windows (${why}). O Swap Plus grava no arquivo ${credentialsPath()}, e essa gravação seria ignorada: a troca de conta não teria efeito.`
        );
      }
    }
  } catch {}
  return out;
}

// ------------------------------------------------------------ ~/.claude.json (oauthAccount)

/**
 * Troca só o oauthAccount do ~/.claude.json (sob a trava ~/.claude.json.lock),
 * gravando atômico e mantendo as permissões do arquivo (novo: 0600).
 * → { changed: boolean, path }
 * Lança bad_oauth_account, lock_timeout ou config_unreadable (arquivo existe mas
 * não é JSON: NÃO sobrescreve).
 */
async function writeOauthAccount(oauthAccount) {
  if (!isPlainObject(oauthAccount) || typeof oauthAccount.emailAddress !== "string" || !oauthAccount.emailAddress) {
    throw fail("bad_oauth_account", "Dados da conta inválidos (falta emailAddress).");
  }
  const file = globalConfigPath();
  return withConfigLock(async () => {
    const text = await readTextFile(file);
    let data = {};
    if (text !== null) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!isPlainObject(parsed)) {
        throw fail(
          "config_unreadable",
          `${file} existe mas não é um JSON válido — não vou sobrescrever (perderia as configurações do Claude Code). Conserte ou mova o arquivo e tente de novo.`,
          { path: file }
        );
      }
      data = parsed;
      if (JSON.stringify(data.oauthAccount) === JSON.stringify(oauthAccount)) return { changed: false, path: file };
    }
    data.oauthAccount = oauthAccount;
    let mode = 0o600;
    if (text !== null) {
      try {
        mode = (await fsp.stat(file)).mode & 0o7777;
      } catch {}
    }
    await fsp.mkdir(path.dirname(file), { recursive: true });
    const trailing = text !== null && text.endsWith("\n") ? "\n" : "";
    await atomicWrite(file, JSON.stringify(data, null, 2) + trailing, mode);
    return { changed: true, path: file };
  });
}

/** Conta logada agora (do oauthAccount do ~/.claude.json). → { email (minúsculo), orgUuid } | null */
async function liveIdentity() {
  let text;
  try {
    text = await readTextFile(globalConfigPath());
  } catch {
    return null;
  }
  const data = parseJsonObject(text);
  const o = data && data.oauthAccount;
  if (!isPlainObject(o) || !o.emailAddress) return null;
  return { email: String(o.emailAddress).toLowerCase(), orgUuid: o.organizationUuid || null };
}

module.exports = {
  readLive,
  writeLive,
  writeOauthAccount,
  liveIdentity,
  withClaudeCredentialLocks,
  credentialStoreWarnings,
  configHome,
  globalConfigPath,
  _test: {
    timings: LOCK,
    /** "file" força o .credentials.json (nunca o Keychain); null volta ao normal. */
    setStore: (kind) => (hooks.store = kind || null),
    setPlatform: (p) => (hooks.platform = p || null),
    /** { get(service, account) → string|null, set(service, account, value) } ou null. */
    setKeychain: (impl) => (hooks.keychain = impl || null),
    reset: () => Object.assign(hooks, { store: null, platform: null, keychain: null }),
    credentialsPath,
    credentialLockDirs,
    storageWriteLockDir,
    configLockDir,
    keychainServices,
    keychainAccount,
    securityAddCommand,
    securityError,
    quoteSecurity,
    cleanOauth,
    lineLimit: SECURITY_STDIN_LINE_LIMIT,
  },
};
