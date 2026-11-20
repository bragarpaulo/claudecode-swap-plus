# Swap Plus Servidor no Contabo — instalação e operação

Escrito em 14/11/2026. O Swap Plus Servidor guarda o login (refresh token) de cada conta Claude e é o **único** que
renova. Os computadores (extensão Swap Plus no VS Code, modo servidor) recebem só o acesso da conta que o servidor
escolheu para cada um. Funcionamento em [`../SPEC.md`](../SPEC.md).

Segue o padrão dos outros grupos do servidor: stack própria criada pela API do Portainer (nunca pela linha de comando),
container `swap-plus` com teto de CPU, memória e processos, rede própria, Caddy na frente atrás da Cloudflare e backup
próprio no `contabo-backup`.

## O que fica onde

| o quê | onde |
|---|---|
| código (cópia deste repositório) | `/opt/swap-plus/app` |
| compose da stack | `/opt/swap-plus/app/server/deploy/compose.yaml` (o Portainer guarda a cópia que está valendo) |
| cofre (logins, computadores, regras) | `/opt/swap-plus/data/store.enc` e a cópia anterior `store.enc.1` — pasta 1000:1000, 700 |
| avisos ao dono (caixa de saída dos e-mails) | `/opt/swap-plus/data/avisos/` — um `aviso-*.json` por aviso (pasta 700, arquivos 600, 1000:1000); o host lê e entrega ao Painel do Servidor ([Avisos por e-mail](#avisos-por-e-mail-ao-dono)) |
| segredos | `/etc/swap-plus/secrets/` — `swap_plus_master_key`, `google_client_id`, `google_client_secret` (1000:1000, 400); `/etc/swap-plus` é só do root (700) |
| imagem | `swap-plus:<versão>`, construída no host; a versão está na variável `SWAP_PLUS_VERSAO` da stack |
| rede | `swap-plus`, 172.26.0.0/24 — só o Swap Plus e o `contabo-caddy` |
| endereço público | `https://swap.assistentes.si` (Cloudflare → Caddy → `swap-plus:8443`, HTTP puro na rede própria) |
| porta de diagnóstico | `127.0.0.1:14950` (só no host) |
| backup | `contabo-backup run swap-plus` → restic `swap-plus` no R2, todo dia às 03:55 |
| logs | `docker logs swap-plus` (json-file, 3 × 5 MB) |

O usuário 1000 é o `node` da imagem. A saída para a internet é direta, pelo NAT do host: a Anthropic vê o IP do
servidor. Não há `HTTP(S)_PROXY` no container e ele fica fora das redes do proxy residencial e do saida-gateway.

## Arquivos desta pasta

| arquivo | para quê |
|---|---|
| `compose.yaml` | a stack `swap-plus` |
| `instalar.sh` | prepara o host (rede, pastas, chave, imagem, conferência do compose) e diz o que falta fazer à mão |
| `portainer_stack_create_swap_plus.py` | cria a stack pela API do Portainer (instalação e recuperação) |
| `Caddyfile.bloco` | o bloco `swap.assistentes.si`, para colar no fim do Caddyfile do servidor |
| `proxy-compose.patch` | põe a rede `swap-plus` no compose do Caddy (stack `contabo-proxy`) |
| `contabo-backup.patch` | o alvo `swap-plus` no `contabo-backup` |

Os dois scripts são só simulação sem `--apply` e nunca mostram segredo na tela.

## Instalação (primeira vez)

Tudo como root, no servidor, nesta ordem. O `instalar.sh` pode ser rodado de novo a qualquer momento: ele marca cada
passo à mão como `[feito]` ou `[falta]`.

**0. Antes de começar**

- Na Cloudflare: o registro `swap.assistentes.si` apontando para o IP do servidor, **proxied** (nuvem laranja). O
  cliente é o Node do VS Code, não um navegador: esse nome não pode ter desafio de robô (Bot Fight Mode, "Under
  Attack", desafio gerenciado), senão os computadores recebem uma página em vez de JSON.
- No Google Cloud: o cliente OAuth do login com Google (ver [Cliente Google](#cliente-google)).

**1. Código no servidor** (só `.dockerignore`, `plus/rules.js` e `server/` entram na imagem):

```sh
git clone https://github.com/bragarpaulo/claudecode-swap-plus.git /opt/swap-plus/app
```

Sem acesso do servidor ao GitHub, mande do Mac:

```sh
cd ~/Documents/ClaudeCode/claudecode-swap-plus
COPYFILE_DISABLE=1 tar -czf - .dockerignore plus/rules.js server \
  | ssh root@<servidor> 'mkdir -p /opt/swap-plus/app && tar -C /opt/swap-plus/app --no-same-owner -xzf -'
```

**2. Preparar o host** (rede, pastas e donos, chave mestra, imagem, conferência do compose):

```sh
sh /opt/swap-plus/app/server/deploy/instalar.sh            # simulação: mostra o que faria
sh /opt/swap-plus/app/server/deploy/instalar.sh --apply
```

**3. Guardar a chave mestra fora do servidor.** Na primeira vez o `instalar.sh` gera
`/etc/swap-plus/secrets/swap_plus_master_key`. Copie para o cofre do Painel do Servidor ou para o gerenciador de
senhas:

```sh
cat /etc/swap-plus/secrets/swap_plus_master_key
```

Sem ela o cofre não abre. Ela também vai no backup, mas o backup não pode ser a única cópia.

**4. Cliente Google:** grave os dois arquivos (ver [Cliente Google](#cliente-google)). Pode ficar para depois: o
servidor sobe sem eles, só o login com Google não funciona.

**5. Criar a stack pelo Portainer:**

```sh
python3 /opt/swap-plus/app/server/deploy/portainer_stack_create_swap_plus.py --versao 2.0.0           # simulação
python3 /opt/swap-plus/app/server/deploy/portainer_stack_create_swap_plus.py --versao 2.0.0 --apply
```

A versão é a que o `instalar.sh` mostrou na etapa 0 (a do `server/src/server.js`). O script confere o host antes
(imagem, rede, pastas, chave, porta), recusa se a stack já existir e, depois de criar, espera o `/v1/health`
responder.

**6. Caddy: colar o bloco e validar.** `>>` acrescenta no mesmo arquivo, e o container do Caddy já enxerga o arquivo
novo para validar:

```sh
cat /opt/swap-plus/app/server/deploy/Caddyfile.bloco >> /opt/server-contabo/stacks/proxy/Caddyfile
docker exec contabo-caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

**7. Proxy: a rede `swap-plus` no Caddy e recriar o Caddy.** O reload não basta: o Caddy precisa entrar na rede nova
(e um Caddyfile trocado por um editor só aparece num container novo). Atualize a stack `contabo-proxy` pelo
Portainer. Isso recria o `contabo-caddy`, e todos os sites ficam fora do ar por alguns segundos:

```sh
P=/opt/server-contabo/stacks/proxy/compose.yaml
patch -N --dry-run $P < /opt/swap-plus/app/server/deploy/proxy-compose.patch
patch -N $P < /opt/swap-plus/app/server/deploy/proxy-compose.patch
python3 /opt/server-contabo/scripts/hermes/portainer_stack_update.py --stack contabo-proxy --compose $P \
  --backup-dir /var/backups/portainer-stacks            # simulação: mostra o diff contra o que está no Portainer
python3 /opt/server-contabo/scripts/hermes/portainer_stack_update.py --stack contabo-proxy --compose $P \
  --backup-dir /var/backups/portainer-stacks --apply
docker logs --tail 50 contabo-caddy                     # certificado de swap.assistentes.si; nenhum erro
```

Se o diff da simulação mostrar mais do que as linhas da rede `swap_plus`, o Portainer e o arquivo estão diferentes:
pare e acerte antes. Depois confira os outros sites (Portainer, Hermes, Painel, Stafy…).

**8. Backup: alvo novo, repositório e cron.** Aplique o patch no `contabo-backup` instalado e na cópia dele no
repositório do servidor, se houver uma:

```sh
patch -N --dry-run /usr/local/sbin/contabo-backup < /opt/swap-plus/app/server/deploy/contabo-backup.patch
patch -N /usr/local/sbin/contabo-backup < /opt/swap-plus/app/server/deploy/contabo-backup.patch
sh -n /usr/local/sbin/contabo-backup
contabo-backup init                 # cria restic/swap-plus (senha nova em restic-swap-plus.pass) e refaz o cron
contabo-backup run swap-plus
contabo-backup status
```

Guarde também a senha nova (`/etc/server-contabo/secrets/restic-swap-plus.pass`) fora do servidor, como as outras.

**9. Testes:**

```sh
curl -s http://127.0.0.1:14950/v1/health                 # {"ok":true,"version":"..."}
curl -s https://swap.assistentes.si/v1/health            # o mesmo, pela Cloudflare
curl -s -o /dev/null -w '%{http_code}\n' --resolve swap.assistentes.si:443:127.0.0.1 https://swap.assistentes.si/v1/health
                                                          # 000: o Caddy derruba quem não vem da Cloudflare
docker exec swap-plus node -e "fetch('https://www.cloudflare.com/cdn-cgi/trace').then(r=>r.text()).then(t=>console.log(t.match(/^ip=.*$/m)[0]))"
                                                          # o IP do próprio servidor, não o do proxy residencial
docker exec swap-plus node /app/server/src/cli.js status
sh /opt/swap-plus/app/server/deploy/instalar.sh           # tudo [feito]
```

Depois: libere as contas Google, gere o código de conexão e ligue os computadores (seções abaixo).

## Atualizar a versão

Uma etiqueta é uma imagem, nunca reconstruída por cima: assim dá para voltar à anterior.

```sh
cd /opt/swap-plus/app && git pull --ff-only                # ou mande o código de novo (Instalação, passo 1)
sh server/deploy/instalar.sh                               # mostra a versão nova e o build que faria
sh server/deploy/instalar.sh --apply                       # constrói swap-plus:<nova>
U=/opt/server-contabo/scripts/hermes/portainer_stack_update.py
python3 $U --stack swap-plus --set SWAP_PLUS_VERSAO=<nova> --backup-dir /var/backups/portainer-stacks           # simulação
python3 $U --stack swap-plus --set SWAP_PLUS_VERSAO=<nova> --backup-dir /var/backups/portainer-stacks --apply
docker logs --tail 20 swap-plus                            # "[início] Swap Plus Servidor <nova>"
```

- Se o `compose.yaml` também mudou, acrescente `--compose /opt/swap-plus/app/server/deploy/compose.yaml` (a
  simulação mostra o diff).
- Código novo sem versão nova no `server.js`: use outra etiqueta, `instalar.sh --apply --versao 2.0.0-2`, e ponha essa
  etiqueta no `SWAP_PLUS_VERSAO`.
- O container fica fora do ar por alguns segundos. Os computadores tentam de novo no próximo contato (30 s). Ao parar,
  o servidor termina de gravar o cofre (a stack dá 30 s para isso).
- **Voltar:** o mesmo comando com a versão anterior. O cofre é o mesmo, então só dá para voltar enquanto o formato
  dele não mudar.
- **Limpar:** `docker image ls swap-plus`. Guarde as duas últimas e apague o resto com `docker image rm swap-plus:<velha>`.

## Cliente Google

O login com Google usa um cliente OAuth do Google Cloud (APIs e serviços → Credenciais → Criar ID do cliente OAuth →
Aplicativo da Web). O endereço de retorno autorizado começa com `https://swap.assistentes.si/`. O caminho exato é o que
o login Google do servidor usar: confira no código antes de cadastrar.

Para gravar os dois valores sem deixá-los no histórico do shell, rode no bash do root:

```bash
( umask 077; printf 'Client ID: '; IFS= read -r v; printf '%s' "$v" > /etc/swap-plus/secrets/google_client_id )
( umask 077; printf 'Client secret: '; stty -echo; IFS= read -r v; stty echo; echo; printf '%s' "$v" > /etc/swap-plus/secrets/google_client_secret )
chown 1000:1000 /etc/swap-plus/secrets/google_client_*
chmod 400 /etc/swap-plus/secrets/google_client_*
docker restart swap-plus
```

## Liberar contas Google

Só o administrador entra no painel (variável `SWAP_PLUS_ADMIN_EMAILS` da stack, definida no Portainer). As contas Google liberadas só conectam computadores:

```sh
docker exec swap-plus node /app/server/src/cli.js allow fulano@gmail.com
docker exec swap-plus node /app/server/src/cli.js help        # os outros comandos (listar, tirar…)
```

## Ligar um computador (código de conexão)

```sh
docker exec swap-plus node /app/server/src/cli.js pair
```

O comando mostra um código `swapplus1:…`. No VS Code do computador: Ctrl/Cmd+Shift+P → **Swap Plus: Conectar ao
servidor** → cole o código. O código vale 10 minutos, serve para **um** computador só, e gerar outro invalida o
anterior. Sem certificado próprio (`TLS_MODE=off`), o computador confere o certificado normal do endereço (o da
Cloudflare).

Ao conectar pela primeira vez, a extensão oferece enviar os logins daquele computador para o servidor.

## Revogar um computador

```sh
docker exec swap-plus node /app/server/src/cli.js devices          # lista com os ids
docker exec swap-plus node /app/server/src/cli.js revoke <id>      # basta o começo do id, se não houver outro igual
```

O token do computador para de valer na hora. Para ligar de novo, gere outro `pair`.

## Estado e logs

```sh
docker exec swap-plus node /app/server/src/cli.js status   # contas, uso, computadores, últimos eventos
docker logs --tail 200 swap-plus                            # ou -f para acompanhar, --since 1h
docker inspect -f '{{.State.Health.Status}}' swap-plus      # healthy
curl -s http://127.0.0.1:14950/v1/health
```

O servidor nunca põe token em log. Os logs giram em 3 arquivos de 5 MB.

## Avisos por e-mail ao dono

Desde a 2.4.0 o servidor avisa o dono por e-mail quando:

- o login de uma conta **vence em menos de 3 dias** (um aviso por conta por dia, junto com o alerta do histórico);
- o login de uma conta **parou de valer** (na hora; diz o motivo);
- o **cofre não está gravando** (um por incidente: "NÃO reinicie o servidor; há login renovado só na memória; veja o disco").

Cada aviso diz a conta (número, apelido, e-mail) e como renovar: no painel, **Contas → conta N → Entrar de novo**, entrar com o
e-mail da conta na página da Claude, copiar o código e colar no painel (ou `/login` no Claude Code de um computador do administrador).

Como chega ao e-mail: o Swap Plus **só grava um arquivo** por aviso em `/opt/swap-plus/data/avisos/` (no container,
`/data/avisos/`), no mesmo formato do `servidor-aviso` do servidor (`aviso-AAAAMMDD-HHMMSS-<8 hex>.json` com
`{"id","assunto","texto","criado_em"}`, gravado de forma atômica). Um processo do host, fora do container, lê essa pasta a cada
minuto e entrega ao Painel do Servidor, que manda o e-mail. O container não usa rede nem senha para isso. Avisos com mais de 48 h
saem da pasta sozinhos (e nunca passam de 500 arquivos).

```sh
ls -la /opt/swap-plus/data/avisos/                                   # avisos ainda não levados pelo host
docker exec swap-plus node -e "fetch('http://127.0.0.1:8444/admin/status').then(r=>r.json()).then(s=>console.log(s.notices))"
                                                                     # { enabled: true, dir: '/data/avisos' } (admin local)
# aviso de teste (vai para o e-mail do dono como qualquer outro):
docker exec swap-plus node -e "console.log(require('/app/server/src/notify').writeNotice('/data', { subject: 'Swap Plus: teste de aviso', text: 'Teste do aviso por e-mail.' }))"
```

Para **desligar**: `NOTICES_ENABLED: "0"` no `environment` do compose e atualizar a stack (nada mais é gravado na pasta). O padrão
(sem a variável) é ligado. O log da subida diz `[avisos] avisos por e-mail ao dono ligados` ou `desligados`; uma falha ao gravar
um aviso aparece como `[avisos] não consegui gravar o aviso ao dono…` (o servidor segue normal).

## Backup e restauração

O `contabo-backup run swap-plus` (cron das 03:55) envia ao restic `swap-plus` no R2:

- `store.enc` e `store.enc.1`, copiados com o container rodando. O servidor grava o `store.enc` por rename atômico,
  e o script copia de novo se algo mudou durante a cópia;
- `secrets.tar`, com a pasta `/etc/swap-plus/secrets` inteira (chave mestra e cliente Google);
- `imagem.tar` (a imagem em uso, `docker save` — ela é montada no servidor e não está em registry nenhum) e
  `imagem.txt` (a versão);
- `app.tar`, o código de onde a imagem foi montada (`/opt/swap-plus/app`);
- `compose.yaml` (o da stack).

Ou seja, o backup traz **tudo** de volta, mesmo num servidor novo: código, imagem, chaves e cofre. Restauração de
teste feita em 14/11/2026 (snapshot `a6c06fe7`): código, imagem válida, chaves e o cofre abriu com 5 contas.

`contabo-backup status` mostra o último resultado e `/var/log/contabo-backup.log` tem os detalhes. O `prune` e o
`check` de sempre já incluem o alvo novo.

**Restaurar** (como root):

```sh
# 1. o ambiente do restic do alvo swap-plus (o mesmo que o contabo-backup monta; nada de segredo na tela)
eval "$(python3 - <<'PY'
import json, shlex
c = json.load(open("/etc/server-contabo/secrets/r2-backup.json"))
print("export AWS_ACCESS_KEY_ID=" + shlex.quote(c["access_key_id"]))
print("export AWS_SECRET_ACCESS_KEY=" + shlex.quote(c["secret_access_key"]))
print("export RESTIC_REPOSITORY=" + shlex.quote("s3:" + c["endpoint_url"].rstrip("/") + "/" + c["bucket"] + "/restic/swap-plus"))
PY
)"
export RESTIC_PASSWORD_FILE=/etc/server-contabo/secrets/restic-swap-plus.pass RESTIC_CACHE_DIR=/var/cache/restic

# 2. baixar o snapshot
restic snapshots --tag swap-plus
restic restore latest --tag swap-plus --target /root/swap-plus-restauro
R=/root/swap-plus-restauro/var/backups/contabo-staging/swap-plus
cat $R/imagem.txt
docker load < $R/imagem.tar                                 # a imagem volta com a mesma etiqueta (swap-plus:<versão>)
# (servidor novo, sem o código) tar -C /opt/swap-plus -xf $R/app.tar

# 3. pôr no lugar (guardando o que está lá)
docker stop swap-plus
cp -a /opt/swap-plus/data /opt/swap-plus/data.antes-$(date +%Y%m%d-%H%M)
tar -C /etc/swap-plus --numeric-owner -xf $R/secrets.tar   # SÓ se a chave sumiu ou não é a do cofre restaurado
install -o 1000 -g 1000 -m 600 $R/store.enc /opt/swap-plus/data/store.enc
[ ! -f $R/store.enc.1 ] || install -o 1000 -g 1000 -m 600 $R/store.enc.1 /opt/swap-plus/data/store.enc.1
docker start swap-plus
docker logs --tail 20 swap-plus                             # "[cofre] N conta(s), M computador(es)"
docker exec swap-plus node /app/server/src/cli.js status
rm -rf /root/swap-plus-restauro
```

**Atenção:** o refresh token é de uso único. Um cofre de horas atrás traz como **"precisa de login novo"** as contas
que o servidor renovou depois do backup. Computadores, contas, regras e histórico voltam inteiros. Para cada conta
marcada, use **Entrar de novo** no painel (Contas → conta N) ou faça login com ela de novo num computador do administrador
(a extensão envia o login novo ao servidor). O servidor também manda um e-mail por conta que parou de valer.

**Servidor novo** (recuperação completa): o código e a imagem vêm do próprio backup (`app.tar` e `imagem.tar`, acima); ou copie o código (passo 1). Antes do `instalar.sh --apply`, crie as pastas
(`install -d -m 700 /etc/swap-plus` e `install -d -o 1000 -g 1000 -m 700 /opt/swap-plus/data`) e restaure os
segredos e o cofre como acima. Assim o `instalar.sh` encontra a chave e o cofre e não gera nada. Depois siga a
instalação a partir do passo 2, com `--versao` igual ou mais nova que a do `imagem.txt`.

## Se a chave mestra se perder

**Sintoma:** o container não sobe e o log diz `[cofre] não consegui ler a chave mestra` ou `o cofre existe mas não
abre com esta chave (chave errada?) — nada foi alterado`. O servidor não mexe no cofre nesses casos, e o
`instalar.sh` se recusa a gerar uma chave nova enquanto houver cofre.

1. **Ache a chave:** a cópia fora do servidor (cofre do Painel do Servidor ou gerenciador de senhas) ou o
   `secrets.tar` de um backup (restaure só ele, como acima). Grave em `/etc/swap-plus/secrets/swap_plus_master_key`
   (1000:1000, 400) e rode `docker start swap-plus`.
2. **Se ela não existir em lugar nenhum,** os logins do cofre ficaram ilegíveis para sempre (AES-256-GCM, não há
   como quebrar). É preciso começar do zero:
   ```sh
   docker stop swap-plus
   mkdir -p /root/swap-plus-cofre-sem-chave
   mv /opt/swap-plus/data/store.enc* /root/swap-plus-cofre-sem-chave/    # não apague: a chave pode aparecer
   # uma chave que está lá mas não abre o cofre também sai (senão o instalar.sh a mantém e não gera outra)
   [ ! -e /etc/swap-plus/secrets/swap_plus_master_key ] || mv /etc/swap-plus/secrets/swap_plus_master_key /root/swap-plus-cofre-sem-chave/
   sh /opt/swap-plus/app/server/deploy/instalar.sh --apply              # gera uma chave nova
   docker start swap-plus                                               # sobe com o cofre vazio
   ```
   Guarde a chave nova fora do servidor. Depois **entre de novo em cada conta Claude** (login num computador
   conectado; a extensão envia ao servidor), gere um código de conexão (`pair`) para cada computador e reconecte,
   libere de novo as contas Google (`allow`) e refaça as regras e os ajustes por conta.

Não existe troca de chave: uma chave nova sempre significa um cofre novo.


## Avisos por e-mail (desde 15/11/2026)

O servidor grava avisos para o dono em `/opt/swap-plus/data/avisos/` (login que vence em menos de 3 dias, login
que parou de valer, cofre sem gravar). No host, `/usr/local/sbin/swap-plus-avisos` (fonte:
`server/deploy/swap-plus-avisos`; cópia em `/opt/server-contabo/scripts/swap-plus/`) roda a cada minuto pelo
`/etc/cron.d/swap-plus-avisos`, confere cada arquivo e entrega ao `servidor-aviso`; o Painel do Servidor manda o
e-mail ao dono. Nenhuma chave de e-mail fica com o Swap Plus. Desligar: `NOTICES_ENABLED=0` na stack, ou apagar o
arquivo do cron. Teste feito em 15/11/2026: o aviso "Swap Plus: avisos por e-mail ligados" saiu na 1ª tentativa.
