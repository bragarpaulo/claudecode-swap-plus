#!/usr/bin/env node
"use strict";
// Anthropic + Google FALSOS do ambiente local (só node:http, só em 127.0.0.1). Nada daqui fala com a internet.
//
// Anthropic (o servidor Swap Plus usa por ANTHROPIC_API_BASE / ANTHROPIC_TOKEN_URL):
//   GET  /api/oauth/usage     uso da conta dona do "Authorization: Bearer sk-ant-oat01-SIMULADO-<n>-<k>"
//                             (dev/simulado/dados.json, relido a cada pedido, + o que /_simular/uso mudou)
//   GET  /api/oauth/profile   perfil fictício da conta
//   GET  /v1/models           catálogo fictício (a conta com "semFable" não tem o Fable)
//   POST /v1/oauth/token      renovação: tokens novos ...-SIMULADO-<n>-<contador>; o refresh token velho passa a
//                             responder invalid_grant (uso único, como o de verdade)
//   POST /_simular/uso        { "conta": 2, "sessao": 95, "semanal": 50, "fable": 10 } muda o uso ao vivo
//   GET  /_simular/estado     o uso de cada conta agora (para conferir)
// Google (GOOGLE_AUTH_URL / GOOGLE_TOKEN_URL):
//   GET  /google/auth         página com "Entrar como admin@local.test" / "Entrar como intruso@local.test" (e as
//                             contas liberadas do dados.json); o clique volta ao redirect_uri com code e state
//   POST /google/token        id_token SEM assinatura (alg none) com iss/aud/email/email_verified/exp
//
// Uso: node dev/simulado/fora-falso.js [porta]   (padrão 3010; FORA_FALSO_PORT também vale)

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const DADOS = process.env.DADOS_SIMULADOS || path.join(__dirname, "dados.json");
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID_SIMULADO || "swap-plus-local.apps.googleusercontent.com";
const ADMIN = "admin@local.test";
const INTRUSO = "intruso@local.test";
const HORA = 3600 * 1000;

const vivo = new Map(); // conta → { sessao?, semanal?, fable? } mudado por /_simular/uso
const geracao = new Map(); // conta → contador dos tokens
const refreshGasto = new Set(); // refresh tokens já usados (uso único)
const codigos = new Map(); // code do Google → { email, ate }

function lerDados() {
  return JSON.parse(fs.readFileSync(DADOS, "utf8"));
}

function contaDe(numero) {
  return (lerDados().contas || []).find((c) => Number(c.numero) === Number(numero)) || null;
}

/** "sk-ant-oat01-SIMULADO-2-3" → { numero: 2, k: 3 } */
function tokenInfo(tok, tipo = "oat01") {
  const m = new RegExp(`^sk-ant-${tipo}-SIMULADO-(\\d+)-(\\d+)`).exec(String(tok || ""));
  return m ? { numero: Number(m[1]), k: Number(m[2]) } : null;
}

const bearer = (req) => {
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ""));
  return m ? m[1] : null;
};

const fimDaJanela = (h) => new Date(Math.ceil((Date.now() + h * HORA) / HORA) * HORA).toISOString();

function usoDe(c) {
  const v = vivo.get(Number(c.numero)) || {};
  const pct = (k) => Math.max(0, Math.min(100, Number(v[k] !== undefined ? v[k] : c[k]) || 0));
  const body = {
    five_hour: { utilization: pct("sessao"), resets_at: fimDaJanela(3) },
    seven_day: { utilization: pct("semanal"), resets_at: fimDaJanela(4 * 24) },
  };
  if (!c.semFable) body.limits = [{ scope: { model: { display_name: "Fable" } }, percent: pct("fable"), resets_at: fimDaJanela(4 * 24) }];
  return body;
}

const modelo = (id, nome, linha, criado, esforco) => ({
  type: "model",
  id,
  display_name: nome,
  line: linha,
  created_at: criado,
  capabilities: { effort: esforco ? Object.fromEntries(["low", "medium", "high", "xhigh", "max"].map((k) => [k, { supported: esforco.includes(k) }])) : { supported: false } },
});
const CATALOGO = [
  modelo("claude-fable-5-2", "Claude Fable 5.2", "fable", "2026-11-09T18:30:00Z", ["low", "medium", "high", "xhigh", "max"]),
  modelo("claude-opus-5-5", "Claude Opus 5.5", "opus", "2026-10-01T12:00:00Z", ["low", "medium", "high", "xhigh", "max"]),
  modelo("claude-sonnet-5-5", "Claude Sonnet 5.5", "sonnet", "2026-09-01T12:00:00Z", ["low", "medium", "high"]),
  modelo("claude-haiku-5-5", "Claude Haiku 5.5", "haiku", "2026-08-01T12:00:00Z", null),
];

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    const partes = [];
    let n = 0;
    req.on("data", (d) => {
      n += d.length;
      if (n > 64 * 1024) {
        reject(new Error("corpo grande demais"));
        req.destroy();
      } else partes.push(d);
    });
    req.on("end", () => resolve(Buffer.concat(partes).toString("utf8")));
    req.on("error", reject);
  });
}

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);

/** Só volta para o próprio computador (o servidor local): nada de redirecionar para fora. */
function redirectLocal(u) {
  try {
    const x = new URL(u);
    return x.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(x.hostname) ? x : null;
  } catch {
    return null;
  }
}

function paginaGoogle(q) {
  const volta = redirectLocal(q.get("redirect_uri"));
  if (!volta || q.get("client_id") !== CLIENT_ID) return null;
  const emails = [ADMIN, ...((lerDados().googleLiberadas || []).filter((e) => e !== ADMIN)), INTRUSO];
  const botoes = emails
    .map((email) => {
      const code = crypto.randomBytes(16).toString("base64url");
      codigos.set(code, { email, ate: Date.now() + 10 * 60 * 1000 });
      const u = new URL(volta.toString());
      u.searchParams.set("code", code);
      u.searchParams.set("state", q.get("state") || "");
      return `<p><a class="b" href="${esc(u.toString())}">Entrar como ${esc(email)}</a></p>`;
    })
    .join("\n");
  const cancelar = new URL(volta.toString());
  cancelar.searchParams.set("error", "access_denied");
  cancelar.searchParams.set("state", q.get("state") || "");
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Google (simulado)</title>
<style>body{font:15px system-ui,sans-serif;max-width:480px;margin:48px auto;padding:0 16px;color:#1f2328}h1{font-size:22px}.b{display:inline-block;padding:12px 16px;border:1px solid #747775;border-radius:6px;color:#1f1f1f;text-decoration:none}.b:hover{background:#f2f2f2}small{color:#59636e}</style></head>
<body><h1>Google (simulado)</h1><p>Ambiente local do Swap Plus: nenhuma conta de verdade. Escolha com que conta entrar.</p>
${botoes}
<p><a href="${esc(cancelar.toString())}">Cancelar</a></p><small>Nada desta página sai do seu computador.</small></body></html>`;
}

function idToken(email) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const agora = Math.floor(Date.now() / 1000);
  return `${b({ alg: "none", typ: "JWT" })}.${b({ iss: "https://accounts.google.com", aud: CLIENT_ID, azp: CLIENT_ID, sub: `sub-${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`, email, email_verified: true, iat: agora, exp: agora + 3600 })}.`;
}

function criar() {
  return http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://127.0.0.1");
    const json = (status, obj) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(obj));
    };
    try {
      const rota = `${req.method} ${u.pathname}`;
      if (rota === "GET /api/oauth/usage" || rota === "GET /api/oauth/profile" || rota === "GET /v1/models") {
        const t = tokenInfo(bearer(req));
        const c = t && contaDe(t.numero);
        // Token de uma geração anterior à última renovação: vencido. (Mais novo que o que este processo conhece vale:
        // o falso pode ter reiniciado depois de renovar.)
        if (!c || c.morta || t.k < (geracao.get(c.numero) || 0)) return json(401, { type: "error", error: { type: "authentication_error", message: "token inválido (simulado)" } });
        if (rota === "GET /api/oauth/usage") return json(200, usoDe(c));
        if (rota === "GET /api/oauth/profile") {
          return json(200, {
            account: { uuid: `uuid-simulado-${c.numero}`, email_address: c.email, display_name: `Conta ${c.numero} (simulada)` },
            organization: { uuid: `org-simulado-${c.numero}`, name: c.organizacao || "Org Simulada" },
          });
        }
        return json(200, { data: CATALOGO.filter((m) => !(c.semFable && m.line === "fable")), has_more: false });
      }
      if (rota === "POST /v1/oauth/token") {
        let b = {};
        try {
          b = JSON.parse((await lerCorpo(req)) || "{}");
        } catch {}
        const t = tokenInfo(b.refresh_token, "ort01");
        const c = t && contaDe(t.numero);
        if (!c || c.morta || refreshGasto.has(b.refresh_token) || t.k < (geracao.get(c.numero) || 0)) return json(400, { error: "invalid_grant", error_description: "refresh token inválido ou já usado (simulado)" });
        refreshGasto.add(b.refresh_token);
        const k = t.k + 1;
        geracao.set(c.numero, k);
        return json(200, {
          token_type: "Bearer",
          access_token: `sk-ant-oat01-SIMULADO-${c.numero}-${k}`,
          refresh_token: `sk-ant-ort01-SIMULADO-${c.numero}-${k}`,
          expires_in: 8 * 3600,
          scope: "user:inference user:profile",
          account: { uuid: `uuid-simulado-${c.numero}`, email_address: c.email },
          organization: { uuid: `org-simulado-${c.numero}` },
        });
      }
      if (rota === "POST /_simular/uso") {
        let b;
        try {
          b = JSON.parse((await lerCorpo(req)) || "{}");
        } catch {
          return json(400, { error: "json inválido" });
        }
        const c = contaDe(b.conta);
        if (!c) return json(404, { error: `conta ${b.conta} não existe em dados.json` });
        const atual = vivo.get(c.numero) || {};
        for (const k of ["sessao", "semanal", "fable"]) {
          if (b[k] === undefined) continue;
          const n = Number(b[k]);
          if (!Number.isFinite(n) || n < 0 || n > 100) return json(400, { error: `${k} precisa ser um número de 0 a 100` });
          atual[k] = n;
        }
        vivo.set(c.numero, atual);
        return json(200, { ok: true, conta: c.numero, uso: usoDe(c) });
      }
      if (rota === "GET /_simular/estado") {
        return json(200, { contas: (lerDados().contas || []).map((c) => ({ conta: c.numero, email: c.email, morta: !!c.morta, geracao: geracao.get(c.numero) || 0, uso: usoDe(c) })) });
      }
      if (rota === "GET /google/auth") {
        const html = paginaGoogle(u.searchParams);
        if (!html) return json(400, { error: "invalid_request", error_description: "client_id ou redirect_uri inválido (simulado)" });
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'" });
        return res.end(html);
      }
      if (rota === "POST /google/token") {
        const form = new URLSearchParams(await lerCorpo(req));
        const c = codigos.get(form.get("code") || "");
        codigos.delete(form.get("code") || "");
        if (!c || c.ate < Date.now() || form.get("client_id") !== CLIENT_ID) return json(400, { error: "invalid_grant" });
        return json(200, { id_token: idToken(c.email), token_type: "Bearer", expires_in: 3600 });
      }
      if (rota === "GET /") return json(200, { ok: true, simulado: true, rotas: ["/api/oauth/usage", "/api/oauth/profile", "/v1/models", "/v1/oauth/token", "/google/auth", "/google/token", "/_simular/uso", "/_simular/estado"] });
      return json(404, { error: "not_found" });
    } catch (e) {
      json(500, { error: "erro no simulado", message: String((e && e.message) || e) });
    }
  });
}

if (require.main === module) {
  const porta = Number(process.argv[2] || process.env.FORA_FALSO_PORT || 3010);
  const srv = criar();
  srv.on("error", (e) => {
    console.error(`[fora-falso] não consegui ouvir em 127.0.0.1:${porta}: ${e.code || e.message}`);
    process.exit(1);
  });
  srv.listen(porta, "127.0.0.1", () => console.log(`Anthropic/Google simulados em http://127.0.0.1:${porta}`));
  const sair = () => srv.close(() => process.exit(0));
  process.on("SIGINT", sair);
  process.on("SIGTERM", sair);
}

module.exports = { criar, CLIENT_ID, tokenInfo };
