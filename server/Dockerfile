# Swap Plus Servidor — imagem Docker.
# Contexto de build = raiz do repositório (precisa de plus/rules.js):
#   docker build -f server/Dockerfile -t swap-plus-server .
FROM node:22-alpine

RUN apk add --no-cache openssl tini tzdata

ENV NODE_ENV=production \
    DATA_DIR=/data \
    MASTER_KEY_FILE=/run/secrets/swap_plus_master_key \
    PORT=8443 \
    ADMIN_PORT=8444 \
    TLS_MODE=self \
    TZ=America/Sao_Paulo

WORKDIR /app
COPY plus/rules.js /app/plus/rules.js
COPY server/src /app/server/src
# Painel web (index.html, app.js, app.css) — servido por server/src/web.js.
COPY server/web /app/server/web
COPY server/entrypoint.sh /app/server/entrypoint.sh
# O código é de root e só de leitura (o usuário node não consegue alterá-lo, mesmo que o
# contexto de build venha com permissões frouxas). Só /data é do node.
RUN chown -R root:root /app \
 && chmod -R a+rX,a-w /app \
 && chmod 0555 /app/server/entrypoint.sh \
 && mkdir -p /data \
 && chown node:node /data \
 && chmod 0700 /data

# Nunca rodar como root.
USER node
VOLUME /data
EXPOSE 8443

# Consulta o /v1/health do admin local (127.0.0.1, dentro do container).
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "const r=require('http').get({host:'127.0.0.1',port:process.env.ADMIN_PORT||8444,path:'/v1/health',timeout:4000},(s)=>process.exit(s.statusCode===200?0:1));r.on('error',()=>process.exit(1));r.on('timeout',()=>r.destroy())"

ENTRYPOINT ["/sbin/tini", "--", "/app/server/entrypoint.sh"]
