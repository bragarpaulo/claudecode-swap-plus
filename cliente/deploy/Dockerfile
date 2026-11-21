# Swap Plus Cliente — imagem Docker (o cliente sem VS Code: mantém um login do Claude Code em dia).
# Contexto de build = raiz do repositório (usa as bibliotecas da extensão, em plus/):
#   docker build -f cliente/deploy/Dockerfile -t swap-plus-cliente:<versão> .
FROM node:22-alpine

RUN apk add --no-cache tini tzdata

# /dados       pasta de dados do cliente (o acesso dele ao servidor: só dele, nunca compartilhada)
# /login       pasta COMPARTILHADA com quem roda o Claude Code; o login fica em /login/claude. Monta-se a pasta-mãe
#              porque o Claude Code e o cliente usam também a trava /login/claude.lock, ao lado da pasta de login.
# HOME         dito aqui porque o contêiner roda com um uid do host (sem entrada no passwd da imagem).
ENV NODE_ENV=production \
    HOME=/dados \
    SWAP_PLUS_CLIENTE_DIR=/dados \
    SWAP_PLUS_CLAUDE_DIR=/login/claude \
    TZ=America/Sao_Paulo

WORKDIR /app
COPY plus/serverClient.js plus/claudeAuth.js plus/rules.js plus/modelSwitch.js /app/plus/
COPY cliente/package.json /app/cliente/package.json
COPY cliente/bin /app/cliente/bin
COPY cliente/src /app/cliente/src
# O código é de root e só de leitura. Só /dados e /login são graváveis (no servidor, os dois vêm do host).
RUN chown -R root:root /app \
 && chmod -R a+rX,a-w /app \
 && chmod 0555 /app/cliente/bin/swap-plus-cliente.js \
 && ln -s /app/cliente/bin/swap-plus-cliente.js /usr/local/bin/swap-plus-cliente \
 && mkdir -p /dados /login \
 && chown node:node /dados /login \
 && chmod 0700 /dados /login

# Nunca rodar como root. No servidor o compose troca pelo uid de quem usa o login (o do Hermes).
USER node
VOLUME ["/dados", "/login"]

# Em dia = o cliente rodou há pouco, a conta está atribuída e o acesso gravado tem folga.
HEALTHCHECK --interval=60s --timeout=10s --start-period=60s --retries=3 \
  CMD ["node", "/app/cliente/bin/swap-plus-cliente.js", "saude"]

ENTRYPOINT ["/sbin/tini", "--", "node", "/app/cliente/bin/swap-plus-cliente.js"]
CMD ["rodar"]
