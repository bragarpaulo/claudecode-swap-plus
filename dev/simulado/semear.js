"use strict";
// Semeadura do cofre do ambiente local com os dados SIMULADOS de dev/simulado/dados.json, usando a classe Store
// do próprio servidor (mesmo formato e mesma criptografia do cofre de verdade).
//
// Idempotente: só grava com o cofre vazio (sem contas e sem serviços). Rodar `subir` de novo não cria conta nem
// serviço repetido. Para semear de novo: node dev/ambiente-local.js limpar.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Store } = require("../../server/src/store");

const DIA = 24 * 3600 * 1000;

/** Registro de conta no formato do motor (engine.addLogin). Tokens fictícios: sk-ant-oat01-SIMULADO-<n>-0. */
function registroConta(c, t) {
  const n = Number(c.numero);
  const oauthAccount = {
    accountUuid: `uuid-simulado-${n}`,
    emailAddress: c.email,
    organizationUuid: `org-simulado-${n}`,
    organizationName: c.organizacao || "Org Simulada",
  };
  return {
    number: n,
    email: c.email,
    orgUuid: oauthAccount.organizationUuid,
    orgName: oauthAccount.organizationName,
    plan: { label: c.plano || "Max" },
    alias: null,
    oauthAccount,
    cred: {
      accessToken: `sk-ant-oat01-SIMULADO-${n}-0`,
      refreshToken: `sk-ant-ort01-SIMULADO-${n}-0`,
      expiresAt: t + 8 * 3600 * 1000,
      refreshTokenExpiresAt: t + 30 * DIA,
      scopes: ["user:inference", "user:profile"],
      subscriptionType: c.assinatura || "max",
      rateLimitTier: "default_claude_max_20x",
    },
    gen: 1,
    dead: c.morta ? { reason: "relogin_required", at: t } : null,
    disabled: false,
    threshold: null,
    priority: 0,
    usage: null,
    usageFetchedAt: null,
    usageError: null,
    lastGoodUsage: null,
    lastGoodAt: null,
    nextPollAt: 0,
    pollBackoffUntil: 0,
    pollFailures: 0,
    refreshBackoffUntil: 0,
    refreshFailures: 0,
    spentRefresh: [],
    addedAt: t,
    lastRefreshAt: t,
    loginWarnedOn: null,
  };
}

/**
 * Semeia o cofre em `dir` (chave em `keyFile`) se ele estiver vazio.
 * → { semeou, contas, servicos } (contas/servicos: quantos há no cofre depois)
 */
async function semear({ dir, keyFile, dados = path.join(__dirname, "dados.json"), agora = Date.now() } = {}) {
  const d = JSON.parse(fs.readFileSync(dados, "utf8"));
  const store = new Store({ dir, keyFile });
  store.load();
  try {
    const st = store.state;
    const contas = Object.keys(st.accounts || {}).length;
    const servicos = Object.keys(st.devices || {}).length;
    if (contas || servicos) return { semeou: false, contas, servicos };
    st.accounts = {};
    for (const c of d.contas || []) st.accounts[String(c.numero)] = registroConta(c, agora);
    st.nextNumber = Math.max(1, ...Object.keys(st.accounts).map(Number)) + 1;
    st.allowedEmails = [...new Set((d.googleLiberadas || []).map((e) => String(e).trim().toLowerCase()))].sort();
    st.devices = {};
    for (const s of d.servicos || []) {
      const id = crypto.randomBytes(6).toString("hex");
      st.devices[id] = {
        id,
        name: s.nome,
        platform: s.plataforma || "linux",
        googleEmail: null,
        tokenHash: crypto.createHash("sha256").update(crypto.randomBytes(32).toString("base64url")).digest("hex"), // ninguém tem o token
        createdAt: agora,
        lastSeen: agora,
        assigned: null,
        lastSwitchAt: 0,
        models: [],
      };
    }
    await store.save();
    return { semeou: true, contas: Object.keys(st.accounts).length, servicos: Object.keys(st.devices).length };
  } finally {
    store.close();
  }
}

module.exports = { semear, registroConta };
