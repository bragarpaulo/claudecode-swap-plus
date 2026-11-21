# Swap Plus Cliente (sem VS Code)

O Swap Plus Cliente faz o trabalho da extensão do VS Code **sem o VS Code**. Ele se conecta ao servidor Swap Plus como
mais um computador, recebe o acesso da conta que o servidor escolheu para ele e mantém em dia um login do Claude Code
numa pasta só dele.

Ele existe para o **Hermes** (o Hermes Agent, da Nous Research: um assistente de IA que fica sempre ligado) e para
outros serviços e rotinas em segundo plano usarem o Claude Code com as contas que o Swap Plus cuida. "O Hermes é uma
coisa, o VS Code é outra": o cliente é um computador separado no servidor, com a própria pasta de login, e não mexe
no Claude Code do VS Code.

Versão 1.0.0. Precisa do **Node 22** ou mais novo e não tem dependências. O que há de novo:
[NOVIDADES-3.2](../NOVIDADES-3.2.md). **O uso pelo Hermes ainda não foi testado de ponta a ponta** (veja
[Usar com o Hermes](#usar-com-o-hermes)).

```text
                 +------------------------------------+
                 |         servidor Swap Plus         |   guarda e renova os logins;
                 |     (server/, com o painel web)    |   decide a conta de cada computador
                 +------------------------------------+
                      ^                           ^
                      |  só o acesso              |  só o acesso
                      v                           v
        +------------------------+    +------------------------+
        |  extensão no VS Code   |    |  cliente, sem VS Code  |
        |  (plus/)               |    |  (cliente/)            |
        +------------------------+    +------------------------+
                      |                           |
                      v                           v
               pasta ~/.claude        pasta de login do cliente
                      |                           |
                      v                           v
           Claude Code no VS Code            Claude Code  <---  Hermes e outras rotinas
```

Neste manual:

1. [Como funciona](#como-funciona)
2. [Instalar e conectar](#instalar-e-conectar)
3. [Usar com o Hermes](#usar-com-o-hermes)
4. [Usar em rotinas próprias](#usar-em-rotinas-próprias)
5. [Comandos](#comandos)
6. [Configuração](#configuração)
7. [Presença: auto ou sempre](#presença-auto-ou-sempre)
8. [Limites e troca de conta](#limites-e-troca-de-conta)
9. [Segurança](#segurança)
10. [Problemas comuns](#problemas-comuns)
11. [Desenvolvimento](#desenvolvimento)

---

## Como funciona

- **Um computador a mais.** Cada cliente aparece no painel do servidor, em **Computadores**, com o nome que você deu
  a ele. Dá para renomear, trocar de conta e desconectar, como qualquer outro computador.
- **Só o acesso.** O cliente recebe só o **acesso** da conta que o servidor atribuiu a ele (dura cerca de 8 horas; o
  servidor renova sozinho). O login completo da conta (o *refresh token*) nunca sai do servidor, e o cliente nunca
  envia logins ao servidor.
- **Uma pasta de login só dele.** O cliente grava esse acesso na pasta de login dele, com a mesma biblioteca da
  extensão (`plus/claudeAuth.js`). O padrão é a pasta `claude`, dentro da pasta de dados do cliente.
- **Quem usa aponta para a pasta.** O Hermes, ou a sua rotina, roda o Claude Code com a variável de ambiente
  `CLAUDE_CONFIG_DIR` apontando para essa pasta. Aí o Claude Code usa a conta que o servidor escolheu.
- **A cada 30 segundos** o cliente olha a pasta para saber se o Claude Code está em uso e fala com o servidor. Se a
  conta mudou, ou o servidor renovou o acesso, ele busca o acesso novo e grava na pasta. Os detalhes estão em
  [Presença](#presença-auto-ou-sempre).

O cliente pode rodar no mesmo computador da extensão: são pastas diferentes e dois computadores diferentes no
servidor.

---

## Instalar e conectar

Estes passos valem para uma máquina qualquer (Linux, Mac ou Windows). Para instalar no servidor, em Docker, siga o
[`deploy/LEIA-ME.md`](deploy/LEIA-ME.md).

### Antes de começar

Você vai precisar de:

- o **servidor Swap Plus** funcionando, com pelo menos uma conta Claude (veja o [MANUAL](../MANUAL.md));
- o **Node 22** ou mais novo (confira com `node --version`) e o `git`;
- o **Claude Code** instalado para quem vai usá-lo (o Hermes ou a sua rotina). O cliente em si não precisa dele.

### 1. Baixar o repositório

Não existe pacote para instalar: o cliente roda direto de uma cópia deste repositório.

```bash
git clone https://github.com/bragarpaulo/claudecode-swap-plus.git
cd claudecode-swap-plus
node cliente/bin/swap-plus-cliente.js ajuda
```

O último comando mostra a lista de comandos. Guarde a cópia inteira: o cliente usa também arquivos da pasta `plus/`.

> **Neste manual, `swap-plus-cliente` quer dizer `node cliente/bin/swap-plus-cliente.js`**, rodado de dentro da
> pasta do repositório. Se preferir digitar o nome curto, crie um atalho no seu terminal (opcional), trocando o
> caminho pelo da sua cópia:
> `alias swap-plus-cliente='node /caminho/para/claudecode-swap-plus/cliente/bin/swap-plus-cliente.js'`

### 2. Conectar com o seu e-mail (entrar com Google)

É o mesmo login da extensão do VS Code: você entra com a sua conta Google e o servidor passa a reconhecer o cliente.

```bash
swap-plus-cliente entrar --url https://swap.exemplo.com --nome "Hermes"
```

O comando mostra um endereço. Abra esse endereço no navegador de qualquer aparelho (pode ser o celular) e entre com
uma conta Google liberada no servidor (a do administrador, ou uma liberada em **Usuários**). O endereço vale até 10
minutos; `Ctrl + C` cancela.

- `--url` é o endereço do seu servidor Swap Plus, o mesmo que a extensão usa.
- `--nome` é o nome com que o cliente aparece no painel. Sem ele, vale o nome da máquina (num contêiner, isso costuma
  ser um código sem sentido: dê um nome). O nome vale na hora de conectar; depois, mude pelo painel (**Computadores**
  → **Renomear**).
- Deu certo: aparece `Conectado a https://swap.exemplo.com como "Hermes".` e, logo abaixo, a situação do cliente. No
  painel, em **Computadores**, o cliente aparece com o e-mail que o conectou.
- Conectar de novo um cliente que já estava conectado troca a conexão antiga pela nova.

Cada cliente é um computador separado no servidor, mesmo conectado com o mesmo e-mail da extensão: o Hermes tem a
conexão dele, o VS Code tem a dele, e cada um pode ser desconectado sozinho.

### 3. Outro jeito: o código de conexão

Para uma máquina sem navegador à mão, ou com o login do Google desligado no servidor. O código é gerado pelo
administrador, de um destes jeitos:

- **No painel:** abra **Computadores**, desça até **Conectar um computador**, clique em **Gerar código de conexão** e
  depois em **Copiar código**.
- **No servidor**, pela linha de comando: `docker exec swap-plus node /app/server/src/cli.js pair`.

O código começa com `swapplus1:`, vale 10 minutos e serve para um computador só.

```bash
swap-plus-cliente conectar --nome "Hermes"
```

O comando fica esperando. Cole o código, aperte Enter e depois `Ctrl + D` (no Windows: `Ctrl + Z` e Enter). Assim o
código não fica guardado no histórico do terminal. Também dá para passar o código direto
(`swap-plus-cliente conectar "swapplus1:…"`) ou pela saída de outro comando (`… | swap-plus-cliente conectar`). No
painel, um cliente conectado assim aparece como "conectado por código".

### 4. Deixar rodando

```bash
swap-plus-cliente rodar
```

Esse é o comando que fica ligado o tempo todo e mantém o login em dia. Ele escreve uma linha quando algo muda, por
exemplo:

```text
[2027-01-15 09:30:02] Swap Plus Cliente 1.0.0 — dados em /home/hermes/.swap-plus-cliente, login do Claude Code em /home/hermes/.swap-plus-cliente/claude, presença auto
[2027-01-15 09:30:03] em dia — conta 2 (trabalho), acesso até 15/01 16:10, ativo
```

- Para parar: `Ctrl + C`.
- Só pode haver **um** `rodar` por pasta de dados. O segundo avisa e sai.
- Para ele ligar junto com a máquina, use o gerenciador de serviços do seu sistema ou o contêiner descrito em
  [`deploy/LEIA-ME.md`](deploy/LEIA-ME.md). O cliente não se instala como serviço sozinho.

Um serviço mínimo do systemd, como ponto de partida (**exemplo, não testado**; troque o usuário e os caminhos):

```ini
# /etc/systemd/system/swap-plus-cliente.service — exemplo, não testado
[Unit]
Description=Swap Plus Cliente
After=network-online.target
Wants=network-online.target

[Service]
User=hermes
ExecStart=/usr/bin/node /opt/claudecode-swap-plus/cliente/bin/swap-plus-cliente.js rodar
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

O serviço precisa rodar com o **mesmo usuário** que conectou o cliente e que vai rodar o Claude Code (veja
[Segurança](#segurança)).

### 5. Conferir

```bash
swap-plus-cliente status
```

```text
Situação:  em dia
Servidor:  https://swap.exemplo.com  (este cliente: Hermes)
Conta:     2 (trabalho) · conta2@exemplo.com · Max
Acesso:    válido até 15/01 16:10 (faltam 398 min)
Presença:  parado (modo auto)
Login em:  /home/hermes/.swap-plus-cliente/claude
Conferido: 15/01 09:32 (há 12 s)
```

- **Situação: em dia** quer dizer que o login gravado é o da conta que o servidor escolheu e ainda vale.
- **Login em:** é a pasta de login. É esse caminho que você vai dar ao Hermes ou à sua rotina.
- No painel, em **Computadores**, aparece um quadradinho com o nome do cliente.

Se a situação for outra, veja [Problemas comuns](#problemas-comuns).

### Atualizar e remover

- **Atualizar:** o cliente não se atualiza sozinho. Na pasta do repositório, rode `git pull` e reinicie o `rodar`. A
  conexão com o servidor continua como está.
- **Remover:** rode `swap-plus-cliente desconectar`, pare o `rodar` (ou o serviço) e apague a pasta de dados. O login
  que estiver na pasta de login não é apagado pelo `desconectar`: ele deixa de ser renovado e vence sozinho em algumas
  horas.

---

## Usar com o Hermes

> **Ainda não testado de ponta a ponta com o Hermes.** O lado do cliente (manter o login em dia na pasta) tem testes
> automáticos. A instalação do plugin no Hermes e o uso pelo Hermes ainda não foram feitos por nós: os passos abaixo
> vêm da documentação do plugin. Confira cada um na sua versão do Hermes.

O Hermes usa o Claude Code pelo plugin oficial da Nous Research **Claude Subscription DirectSDK (Experimental)**. O
plugin roda o executável oficial `claude` como modelo. Os próprios autores marcam o plugin como experimental.

O que precisa:

- **Hermes Agent 0.21.4** ou mais novo;
- o **Claude Code** instalado onde o Hermes roda, numa versão que tenha o modelo que você quer:

  | Modelo | Claude Code mínimo |
  | --- | --- |
  | Opus 5.5 | 2.1.280 |
  | Sonnet 5.5 | 2.1.284 |
  | Haiku 5.5 | 2.1.293 |
  | Fable 5.2 | 2.1.321 |

  Para atualizar o Claude Code: `claude update`;
- o cliente **conectado e rodando** ([Instalar e conectar](#instalar-e-conectar)), com o mesmo usuário do Hermes.

Os passos:

1. **Instale o plugin:**

   ```bash
   hermes plugins install claude-subscription-directsdk
   ```

2. **Aponte o plugin para a pasta de login do cliente.** A pasta é a que o `status` mostra em **Login em:**. Essa
   configuração vale por perfil do Hermes:

   ```bash
   hermes config set plugins.entries.claude-subscription-directsdk-experimental.settings.claude_config_dir /home/hermes/.swap-plus-cliente/claude
   ```

3. **Escolha o modelo.** Rode `hermes model` e escolha **Claude Subscription DirectSDK (Experimental)**. Ou, no
   `config.yaml` do Hermes, defina `model.provider` como `claude-subscription-directsdk-experimental` e
   `model.default` como `sonnet`, `opus`, `fable` ou `haiku`.

4. **Confira.** Mande uma mensagem ao Hermes. Logo depois da resposta, o esperado é o `swap-plus-cliente status`
   mostrar **Presença: ativo** e o painel mostrar o cliente como **ativo agora**.

O que é diferente com o Hermes:

- O plugin não deixa as conversas gravadas na pasta. Por isso o cliente **não vê** quando a conta bate o limite nem
  qual modelo está em uso. A troca de conta pelas regras do servidor continua valendo; veja
  [Limites e troca de conta](#limites-e-troca-de-conta).
- Se o Hermes roda em contêiner, o cliente e o Hermes precisam enxergar a mesma pasta de login. Compartilhe a pasta
  **de cima** dela, e nunca a pasta de dados do cliente. O porquê está em [Segurança](#segurança); o roteiro para o
  servidor está em [`deploy/LEIA-ME.md`](deploy/LEIA-ME.md).

---

## Usar em rotinas próprias

Qualquer rotina sua pode usar o Claude Code pelo cliente. Basta rodar o `claude` com a variável `CLAUDE_CONFIG_DIR`
apontando para a pasta de login (a que o `status` mostra em **Login em:**):

```bash
CLAUDE_CONFIG_DIR="$HOME/.swap-plus-cliente/claude" claude -p "Resuma o arquivo notas.txt em cinco linhas"
```

No Windows (PowerShell):

```powershell
$env:CLAUDE_CONFIG_DIR = "$HOME\.swap-plus-cliente\claude"
claude -p "Resuma o arquivo notas.txt em cinco linhas"
```

Conferido com o `claude -p` do Claude Code 2.1.267: uma pasta que tem só o acesso entregue pelo servidor é aceita como
logada.

- A variável vale só para aquele comando (ou aquele terminal). O Claude Code do VS Code continua na pasta padrão.
- Com a variável, essa pasta passa a ser a pasta do Claude Code para aquele comando: os ajustes e as conversas dele
  ficam nela, separados dos do VS Code.
- **Não faça `/login` nessa pasta.** O cliente não envia logins ao servidor, e um login feito à mão ali faz o cliente
  parar de gravar (situação **não pode gravar o login**). Contas novas entram pelo painel (veja o
  [MANUAL](../MANUAL.md#contas-novas)).
- Não deixe as variáveis `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` definidas na rotina: com elas o Claude Code
  ignora o login da pasta.
- Para a rotina só rodar com o login em dia, use o `saude` (ele sai com 0 quando está tudo certo):

  ```bash
  swap-plus-cliente saude && CLAUDE_CONFIG_DIR="$HOME/.swap-plus-cliente/claude" claude -p "…"
  ```

Usado assim, o Claude Code grava as conversas na pasta. Com elas o cliente vê sozinho o modelo em uso e o erro de
limite, e avisa o servidor, como a extensão faz.

### Sobre o uso da assinatura

O cliente faz o Claude Code ser usado de forma programada (por um agente ou por rotinas), dentro dos limites do plano
de cada conta. As regras da Anthropic para esse tipo de uso das assinaturas mudaram ao longo de 2026. Antes de contar
com isso, confira a página de ajuda atual da Anthropic, "Use the Claude Agent SDK with your Claude plan".

---

## Comandos

| Comando | O que faz | Sai com |
| --- | --- | --- |
| `conectar [código]` | Conecta o cliente ao servidor com o código de conexão. Sem o código (ou com `-`), lê o código da entrada padrão. Depois faz um ciclo e mostra a situação. | 0 se ficou em dia (ou conectado, mas ainda sem conta); 1 se falhou |
| `entrar` | Conecta com login do Google: mostra um endereço para abrir no navegador. Precisa de `--url`. | igual ao `conectar` |
| `rodar` | Fica rodando e mantém o login em dia. É o que o serviço ou o contêiner executa. | 0 ao ser encerrado; 1 se já há outro rodando na mesma pasta de dados |
| `uma-vez` | Faz um ciclo completo (fala com o servidor, grava o login se precisar), mostra a situação e sai. | 0 se em dia; 1 se não |
| `status` | Mostra a última situação gravada pelo cliente. Não fala com o servidor. Com `--json`, mostra em JSON. | 0 se em dia; 1 se não |
| `saude` | Responde `ok` ou `problema: …`. Feito para monitor e *healthcheck*. | 0 se saudável; 1 se não |
| `trocar [n]` | Pede ao servidor a conta `n`. Sem `n`, pede a melhor conta. Grava o login novo e mostra a situação. | 0 se em dia; 1 se não |
| `limite [texto]` | Avisa o servidor que a conta bateu o limite. O servidor decide na hora se troca. O texto é opcional (padrão: `limite de uso`). | 0 se em dia; 1 se não |
| `desconectar` | Desfaz a conexão: revoga o cliente no servidor e apaga o acesso guardado. Se não conseguir avisar o servidor, ele diz, e você desconecta o cliente pelo painel. Não apaga o login da pasta de login. | 0 |
| `ajuda` | Mostra os comandos e as opções. | 0 |
| `versao` | Mostra a versão do cliente. | 0 |

Comando ou opção errados saem com 2.

O `saude` responde `ok` quando três coisas valem: o `rodar` gravou a situação há menos de 3 minutos (ou seja, está
ligado), a situação é **em dia** e o acesso gravado ainda vale por mais de 2 minutos.

---

## Configuração

Cada ajuste pode ser dado como opção na linha de comando ou como variável de ambiente. Vale a linha de comando; sem
ela, a variável; sem as duas, o padrão.

| Opção | Variável de ambiente | Padrão | Para quê |
| --- | --- | --- | --- |
| `--dir <pasta>` | `SWAP_PLUS_CLIENTE_DIR` | `~/.swap-plus-cliente` | A **pasta de dados** do cliente: a conexão com o servidor e a situação. |
| `--pasta-claude <pasta>` | `SWAP_PLUS_CLAUDE_DIR` | `<pasta de dados>/claude` | A **pasta de login** do Claude Code que este cliente mantém. |
| `--presenca auto\|sempre` | `SWAP_PLUS_PRESENCA` | `auto` | Quando o cliente conta como computador ativo no servidor. Veja [Presença](#presença-auto-ou-sempre). |
| `--modelos <ids>` | `SWAP_PLUS_MODELOS` | vazio | Os modelos que este cliente usa, separados por vírgula, com o nome completo (por exemplo, `claude-fable-5-2`). Opcional. Veja [Limites e troca de conta](#limites-e-troca-de-conta). |
| `--nome <nome>` | `SWAP_PLUS_NOME` | o nome da máquina | O nome do cliente no painel (até 60 letras). Vale na hora de conectar. |
| `--url <endereço>` | `SWAP_PLUS_URL` | nenhum | O endereço do servidor. Só para o comando `entrar`. |
| `--substituir-login` | `SWAP_PLUS_SUBSTITUIR_LOGIN=1` | desligado | Deixa o cliente gravar por cima de um login feito à mão na pasta de login. |
| `--pasta-padrao` | `SWAP_PLUS_PASTA_PADRAO=1` | desligado | Aceita `~/.claude` (a pasta da extensão) como pasta de login. Só para uma máquina sem a extensão. |
| `--log <nível>` | `SWAP_PLUS_LOG` | `info` | Quanto o cliente escreve: `info`, `debug` (mais detalhe) ou `quieto` (só avisos e erros). |
| `--json` | — | desligado | Mostra a situação em JSON, no `status` e nos outros comandos que mostram a situação. |

- Um `~/` no começo do caminho vira a sua pasta de usuário.
- As opções podem ser escritas `--dir /caminho` ou `--dir=/caminho`.
- Nas variáveis de ligar e desligar, valem `1`, `true`, `sim`, `yes` e `on`.
- **Todos os comandos precisam enxergar a mesma pasta de dados do `rodar`.** Se você usa `SWAP_PLUS_CLIENTE_DIR` no
  serviço, defina a mesma variável no terminal antes de rodar `status`, `trocar` e os outros.

### O que fica em cada pasta

Na **pasta de dados** (criada só para o dono):

| Arquivo | O que guarda |
| --- | --- |
| `conexao.json` | A conexão com o servidor, com o acesso (token) deste cliente. **É segredo.** |
| `aplicado.json` | Qual conta e qual acesso o cliente gravou por último na pasta de login. |
| `situacao.json` | O retrato do último ciclo, sem segredo. É o que o `status` e o `saude` leem. |
| `rodando.json` | A trava que garante um só `rodar` por pasta de dados. |

Na **pasta de login**:

- **Linux e Windows:** o acesso fica no arquivo `.credentials.json` (no Linux, só o dono lê) e os dados da conta em
  `.claude.json`.
- **Mac:** o Claude Code guarda o login no Keychain (Acesso às Chaves), não num arquivo. O cliente grava lá, num item
  ligado ao texto exato do caminho da pasta. Por isso, no Mac, use em `CLAUDE_CONFIG_DIR` exatamente o caminho que o
  `status` mostra em **Login em:**.
- O resto (`sessions/`, `projects/`…) é do próprio Claude Code.

---

## Presença: auto ou sempre

O servidor trata diferente um computador **ativo** e um **parado**. A presença diz quando o cliente conta como ativo.

**`auto` (o padrão).** O cliente só conta como ativo enquanto o Claude Code está sendo usado pela pasta dele, e por
10 minutos depois do último uso.

- Como ele sabe: a cada 30 segundos olha a data dos arquivos em que o Claude Code mexe na pasta de login. O que o
  próprio cliente grava não conta.
- **Ativo:** manda um batimento ao servidor a cada 30 segundos (um aviso curto de "estou aqui, em uso"), como a
  extensão faz.
- **Parado:** só consulta o servidor a cada 2 minutos, para manter o login válido. Não ocupa conta e não gasta o
  orçamento de leitura de uso do servidor.
- Parado, o servidor não decide trocas para ele. Se a conta do cliente precisar de decisão (login morto, conta
  desativada, cliente sem conta, ou uso acima da linha de troca), o cliente manda um batimento avulso, no máximo um
  a cada 5 minutos, e o servidor decide na hora.

**`sempre`.** O cliente manda o batimento a cada 30 segundos, usado ou não. Conta como ativo o tempo todo.

**Qual escolher.** Fique no `auto`, a não ser que tenha um motivo.

- Com a regra do servidor **Computadores: Separados** (o padrão), cada computador ativo fica numa conta. Um cliente
  sempre ativo deixa uma conta ocupada o tempo todo, mesmo com o Hermes parado.
- O servidor lê o uso da conta de um computador ativo a cada 3 minutos; o das outras, a cada 20. Um cliente sempre
  ativo gasta mais desse orçamento de leitura, que os outros computadores também usam.
- Use `sempre` se o cliente não perceber o uso (ele fica **parado** com o Hermes trabalhando), ou se você quer o
  servidor decidindo as trocas dele sem parar.

Bom saber:

- Ao ligar, o `rodar` manda um batimento. Por isso o cliente aparece como **ativo agora** nos primeiros minutos.
- O painel mostra um computador como **ativo agora** até 5 minutos depois do último batimento.
- Com a regra **Computadores: Juntos**, o cliente ativo entra na conta do grupo e troca junto com os outros.

---

## Limites e troca de conta

**Quem troca é o servidor**, pelas regras de sempre (as linhas de troca da sessão de 5 horas, do semanal e do
modelo). O cliente só aplica: grava o login da conta nova em até 30 segundos quando está ativo, e em até 2 minutos
quando está parado. A execução seguinte do Claude Code já usa a conta nova.

**Para o Hermes usar só algumas contas**, escolha no painel: **Contas** → **Ajustes desta conta** → **Computadores
permitidos**.

**Trocar à mão:**

- `swap-plus-cliente trocar 3` pede a conta 3; `swap-plus-cliente trocar` pede a melhor conta;
- ou, no painel: **Computadores** → **Trocar para** → **Trocar**.

**Quando o limite bate antes da troca:**

- **Em rotinas próprias** (`claude -p`), o Claude Code grava as conversas na pasta. O cliente lê o erro de limite
  ("You've hit your limit") e avisa o servidor, que decide a troca na hora. O erro passageiro "Server is temporarily
  limiting requests (not your usage limit)" não conta.
- **Com o Hermes**, o plugin não grava as conversas, então o cliente não vê o erro. Normalmente o servidor troca
  antes, pela linha de uso. Se mesmo assim a conta bater o limite, avise à mão (ou por um script seu):

  ```bash
  swap-plus-cliente limite "limite da sessão de 5h"
  ```

  O servidor responde se trocou de conta ou não, e por quê. O texto é livre e aparece no histórico do servidor
  ("a conta 2 bateu o limite da sessão de 5h").

**Modelos e o limite do Fable:**

- **O cliente não mexe no modelo.** A troca sozinha para o Opus 5.5 quando o Fable acaba é só da extensão. O modelo
  do Hermes se escolhe no Hermes; o da sua rotina, no comando dela.
- Com a regra do servidor **Seguir na mesma conta**, quando o Fable acaba o cliente continua na mesma conta. Mude o
  modelo você mesmo.
- Com a regra **Trocar de conta**, o servidor passa o cliente para uma conta que ainda tem Fable, enquanto houver
  uma. Isso vale para todos os computadores, com ou sem `SWAP_PLUS_MODELOS`.
- A linha do Fable só é olhada com o cliente **ativo**. Parado, ele só pede decisão ao servidor pelas linhas da
  sessão de 5 horas e do semanal.
- `SWAP_PLUS_MODELOS` declara ao servidor os modelos que o cliente usa (com as conversas gravadas, o cliente descobre
  sozinho). Use o nome completo, que começa com `claude-`: o que estiver fora desse formato é ignorado sem aviso.
  **Hoje essa lista é só informação:** na versão atual das regras (`plus/rules.js`), a decisão de troca não depende
  dela.

---

## Segurança

- **A pasta de dados é segredo.** O `conexao.json` guarda o acesso deste cliente ao servidor. Com ele dá para pegar
  o acesso da conta atribuída e, pela API do servidor, trocar de conta, mudar regras e desconectar computadores. Não
  ponha essa pasta em backup aberto, em repositório nem em pasta compartilhada.
- **Se a pasta de dados vazar:** no painel, **Computadores** → **Desconectar**, no quadradinho do cliente. O acesso
  dele para de valer na hora. Depois conecte de novo.
- **A pasta de login tem só o acesso** (cerca de 8 horas), nunca o login completo. Ainda assim, quem lê essa pasta
  usa a conta até o acesso vencer. Um agente com terminal, como o Hermes, consegue ler o que está nela.
- **Mesmo usuário.** No Linux e no Mac, o login é gravado só para o dono. Quem roda o Claude Code pela pasta precisa
  ser o mesmo usuário que roda o cliente.
- **Separar de verdade pede duas pastas.** A pasta de login padrão fica **dentro** da pasta de dados. Para o Hermes
  não alcançar o `conexao.json`, defina `SWAP_PLUS_CLAUDE_DIR` com uma pasta fora da pasta de dados e, em contêiner,
  entregue ao Hermes só essa. Compartilhe a pasta **de cima** da pasta de login: o Claude Code e o cliente usam uma
  trava ao lado dela (uma pasta com o mesmo nome e `.lock` no fim), e os dois precisam enxergá-la. É assim que o
  [`deploy/LEIA-ME.md`](deploy/LEIA-ME.md) faz.
- **Nunca a pasta da extensão.** O cliente recusa `~/.claude` como pasta de login, a não ser com `--pasta-padrao`.
  Dois programas gravando na mesma pasta brigariam: cada um é um computador no servidor, talvez em contas
  diferentes. Ele também recusa usar a própria pasta de dados como pasta de login.
- **Nunca por cima de um login feito à mão.** Se a pasta de login tem um login completo (feito com `/login`), o
  cliente não grava e avisa. Só grava por cima com `SWAP_PLUS_SUBSTITUIR_LOGIN=1`.
- **Nunca envia logins ao servidor**, nem grava refresh token.
- **Só fala com o servidor em que conectou.** O acesso do cliente só é enviado ao endereço em que foi emitido, e só
  por `https://`.
- **Acesso revogado: ele para.** Se o servidor responder que não reconhece mais o cliente, ele não chama mais o
  servidor até ser conectado de novo. (Vinte recusas dessas em 10 minutos fariam o servidor bloquear o endereço de
  rede da máquina.)
- **Nada de segredo no log.** O acesso do cliente e os acessos das contas não vão para o log, para o `status` nem
  para o `situacao.json`.

---

## Problemas comuns

Comece pelo `swap-plus-cliente status`. A primeira linha (**Situação**) diz o estado; depois do travessão vem a
mensagem com o motivo. Entre parênteses, abaixo, está o nome do estado no `status --json`.

| Situação | O que quer dizer | O que fazer |
| --- | --- | --- |
| **em dia** (`ok`) | O login gravado é o da conta que o servidor escolheu e ainda vale. | Nada. |
| **não conectado** (`desconectado`) | Não há conexão com o servidor nesta pasta de dados (ou o `conexao.json` está incompleto). Mensagem: *Este cliente ainda não foi conectado ao servidor.* | Rode `swap-plus-cliente entrar` (ou `conectar`, com o código). Se você já conectou, confira se o comando está olhando a mesma pasta de dados (`--dir` ou `SWAP_PLUS_CLIENTE_DIR`). |
| **acesso revogado** (`revogado`) | O servidor não reconhece mais este cliente: ele foi desconectado no servidor (pelo painel, por exemplo). O cliente parou de chamar o servidor. | Rode `swap-plus-cliente entrar` de novo (ou gere um código novo e rode `conectar`). O `rodar` que já estava ligado pega a conexão nova sozinho. |
| **sem conta** (`sem_conta`) | O servidor não tem conta para este cliente agora: nenhuma conta viva, ou nenhuma liberada para ele. | No painel: **Contas** → **Ajustes desta conta** → **Computadores permitidos**, e marque o cliente (um computador novo não entra sozinho numa conta que está em **Só estes**). Confira também se há conta sem **Login morto**. O cliente pega a conta sozinho em poucos minutos. |
| **sem contato com o servidor** (`offline`) | A rede caiu, o servidor está fora do ar, ou ele recusou o pedido. A mensagem diz qual. | Espere. O Claude Code segue com o acesso que já está gravado, até a hora da linha **Acesso**. O cliente tenta de novo sozinho; se o servidor recusou (403) ele espera 5 minutos, e se pediu para esperar (429), 10. |
| **sem contato com o servidor**, logo depois de um `trocar` | O servidor recusou a troca (por exemplo, a conta pedida não é permitida para este cliente). A mensagem diz o motivo. | Peça outra conta, ou libere a conta em **Computadores permitidos**. |
| **sem contato com o servidor**, com *O servidor respondeu algo que não é JSON* | Algo no caminho respondeu no lugar do servidor (por exemplo, uma página de desafio contra robôs). | Veja o passo 0 do [guia do servidor](../server/deploy/LEIA-ME.md). |
| **não pode gravar o login** (`bloqueado`), com *Há um login do Claude Code feito à mão…* | Alguém fez `/login` na pasta de login. O cliente não apaga nem envia esse login. | Use outra pasta de login, apague esse login, ou defina `SWAP_PLUS_SUBSTITUIR_LOGIN=1` para o cliente gravar por cima. |
| **não pode gravar o login** (`bloqueado`), com *Gerenciador de Credenciais do Windows* | O Claude Code deste Windows lê o login do Gerenciador de Credenciais, e a gravação no arquivo seria ignorada (é raro). | Se alguém definiu a variável `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN`, apague-a e reinicie o cliente. |
| **credencial ainda não gravada** (`pendente`) | O cliente tem conta, mas não conseguiu gravar desta vez: o Claude Code estava mexendo no login, o login mudou no meio, ou a pasta não deixou gravar. | Costuma se resolver sozinho no ciclo seguinte (depois de uma falha de gravação, ele espera 1 minuto). Se continuar, leia a mensagem e confira se o usuário do cliente pode gravar na pasta de login e na pasta de cima dela. |

Outras mensagens:

| O que aparece | O que fazer |
| --- | --- |
| `status`: *Conectado a …, mas o cliente ainda não rodou.* | Rode `swap-plus-cliente rodar`. |
| `saude`: *sem situação gravada: o cliente nunca rodou nesta pasta de dados* | O `rodar` nunca rodou, ou o `saude` está olhando outra pasta de dados. |
| `saude`: *a situação está velha: o cliente não está rodando* | O `rodar` parou. Ligue de novo (ou veja o log do serviço). |
| `saude`: *o acesso gravado está vencido ou vence em menos de 2 min* | O cliente está sem conseguir renovar. Veja a **Situação** no `status`. |
| `rodar`: *Já há um cliente rodando com a pasta de dados …* | Só um por pasta de dados. Se o outro morreu sem avisar, a trava se solta sozinha em 3 minutos. |
| *A pasta de login escolhida (…) é a pasta padrão do Claude Code…* | Escolha uma pasta só do cliente (`SWAP_PLUS_CLAUDE_DIR`). Use `SWAP_PLUS_PASTA_PADRAO=1` só numa máquina sem a extensão. |
| *A pasta de login do Claude Code não pode ser a própria pasta de dados do cliente* | Escolha outra pasta de login. |
| `conectar`: *Isso não é um código de conexão do Swap Plus* ou *O código de conexão está incompleto ou quebrado* | Copie o código inteiro (ele começa com `swapplus1:`). Se passou de 10 minutos ou já foi usado, gere outro. |
| `entrar`: *O login com Google está desligado neste servidor* | Use o código de conexão (`swap-plus-cliente conectar`). |
| `entrar`: *A conta Google … não está liberada neste servidor* | O administrador libera a conta no painel, em **Usuários**. Depois rode o `entrar` de novo. |
| `entrar`: *O tempo para entrar acabou* | Rode o comando de novo e abra o endereço novo. |
| O `status` diz **em dia**, mas o Claude Code pede login | O Claude Code está olhando outra pasta: confira o `CLAUDE_CONFIG_DIR` (igual ao **Login em:**). Confira também se ele roda com o mesmo usuário do cliente e se não há `ANTHROPIC_API_KEY` ou `CLAUDE_CODE_OAUTH_TOKEN` no ambiente. |
| O cliente fica **parado** com o Hermes trabalhando | O cliente não está percebendo o uso. Confira se o Hermes aponta para a pasta certa. Se aponta, use `--presenca sempre`. |

---

## Desenvolvimento

O cliente é Node puro (22 ou mais novo), sem dependências. Ele reaproveita quatro arquivos da extensão, e por isso
roda a partir do repositório inteiro.

| Caminho | O que é |
| --- | --- |
| `cliente/bin/swap-plus-cliente.js` | o ponto de entrada da linha de comando |
| `cliente/src/cli.js` | os comandos, as opções, o `status` e o `saude` |
| `cliente/src/config.js` | a configuração (opções, variáveis de ambiente e padrões) |
| `cliente/src/ciclo.js` | o ciclo: falar com o servidor, gravar o login, montar a situação. O comentário do começo explica o desenho |
| `cliente/src/conexao.js` | conectar (código ou Google) e desconectar |
| `cliente/src/atividade.js` | descobrir, pela pasta de login, se o Claude Code está em uso, com quais modelos e se bateu o limite |
| `cliente/src/estado.js` | os arquivos da pasta de dados |
| `cliente/src/arquivos.js` | leitura e gravação segura dos arquivos pequenos, e a trava do `rodar` |
| `cliente/test/` | os testes (`*.test.js`) e o servidor de mentira que eles usam (`apoio.js`) |
| `cliente/deploy/` | a instalação no servidor, em Docker ([`deploy/LEIA-ME.md`](deploy/LEIA-ME.md)) |
| `plus/serverClient.js` | falar com o servidor (o mesmo da extensão, sem nenhuma mudança) |
| `plus/claudeAuth.js` | ler e gravar o login do Claude Code, com as travas dele (o mesmo da extensão) |
| `plus/rules.js` e `plus/modelSwitch.js` | as regras de troca e a leitura do erro de limite (os mesmos da extensão) |

**Testes.** Da raiz do repositório:

```bash
node --test cliente/test/*.test.js
```

Os testes sobem um servidor de mentira em `127.0.0.1` e usam pastas temporárias: não tocam em nenhum login de
verdade. Com `TEST_LOG=1` eles mostram o log do cliente. Eles gravam o login sempre em arquivo; o caminho do Keychain
do Mac é o da biblioteca da extensão e não é exercitado por estes testes. O workflow
`.github/workflows/cliente-ci.yml` está configurado para rodar os mesmos testes no Linux, no Mac e no Windows e para
conferir a imagem Docker, a cada mudança no cliente.

**O que o cliente chama no servidor** (tudo já existe na API descrita em [`server/SPEC.md`](../server/SPEC.md)):
`POST /v1/pair`, `POST /v1/login/start` e `POST /v1/login/poll` para conectar; `POST /v1/heartbeat` e `GET /v1/state`
no ciclo; `GET /v1/credential` para buscar o acesso; `POST /v1/switch` no `trocar`; `POST /v1/events` no aviso de
limite; `DELETE /v1/devices/<id>` no `desconectar`. Ele nunca chama `POST /v1/logins`.
