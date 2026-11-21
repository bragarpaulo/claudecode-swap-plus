"use strict";
// Swap Plus Cliente — o que o cliente guarda na pasta de dados (tudo 0600, gravação atômica):
//
//   conexao.json    { versao, url, fp, deviceId, token, nome, via, conectadoEm, revogadoEm? }
//                   O token é o acesso deste cliente ao servidor: nunca vai para log nem para a tela.
//   aplicado.json   { number, gen, expiresAt, at, noIdentity }  — a última credencial gravada na pasta de login
//   situacao.json   retrato do último ciclo (sem segredo), para "status", "saude" e para quem monitora
//   rodando.json    trava: um só cliente rodando por pasta de dados

const path = require("path");
const { lerJson, gravarJson, apagar, erro } = require("./arquivos");

class Estado {
  constructor(dir) {
    this.dir = dir;
    this.arqConexao = path.join(dir, "conexao.json");
    this.arqAplicado = path.join(dir, "aplicado.json");
    this.arqSituacao = path.join(dir, "situacao.json");
    this.arqTrava = path.join(dir, "rodando.json");
  }

  /** A conexão com o servidor, ou null se este cliente ainda não foi conectado. Arquivo quebrado → lança. */
  conexao() {
    const c = lerJson(this.arqConexao);
    if (!c) return null;
    if (typeof c.url !== "string" || !c.url || typeof c.deviceId !== "string" || !c.deviceId || typeof c.token !== "string" || !c.token) {
      throw erro("conexao_invalida", `O arquivo ${this.arqConexao} está incompleto. Conecte de novo (swap-plus-cliente conectar).`);
    }
    return c;
  }

  async gravarConexao(c) {
    await gravarJson(this.arqConexao, { versao: 1, ...c });
  }

  apagarConexao() {
    return apagar(this.arqConexao);
  }

  /** Arquivo quebrado conta como "nada aplicado": o pior caso é buscar e gravar a credencial de novo. */
  aplicado() {
    try {
      const a = lerJson(this.arqAplicado);
      return a && typeof a.number === "number" && typeof a.gen === "number" ? a : null;
    } catch {
      return null;
    }
  }

  async gravarAplicado(a) {
    await gravarJson(this.arqAplicado, a);
  }

  apagarAplicado() {
    return apagar(this.arqAplicado);
  }

  situacao() {
    try {
      return lerJson(this.arqSituacao);
    } catch {
      return null;
    }
  }

  async gravarSituacao(s) {
    await gravarJson(this.arqSituacao, s);
  }

  apagarSituacao() {
    return apagar(this.arqSituacao);
  }
}

module.exports = { Estado };
