# Swap Plus (extensão do VS Code)

Mostra o uso do Claude Code na barra de status e troca de conta sozinha quando uma conta chega perto do limite.
Fork pessoal de [smith89k/claude-swap-status](https://github.com/smith89k/claude-swap-status) (MIT). Usa o CLI
[`swap-plus`](https://github.com/bragarpaulo/swap-plus), fork do claude-swap.

Passo a passo completo, para quem usa: **[MANUAL](../MANUAL.md)**. O que mudou na 2.0:
**[NOVIDADES-2.0](../NOVIDADES-2.0.md)**.

## Em poucas palavras (versão 2.0)

- **Servidor Swap Plus:** `https://swap.assistentes.si` (numa VPS da Contabo). Ele é o único que guarda e renova os
  logins das contas Claude. Os computadores recebem só o **acesso** da conta que o servidor escolheu para cada um.
- **O acesso dura cerca de 8 horas.** O servidor renova sozinho, 2 horas antes de vencer.
- **O login vence de vez em cerca de um mês.** O painel avisa 3 dias antes. Aí basta entrar de novo com aquela conta:
  no painel (**Contas → + Adicionar conta**) ou no Claude Code (`/login`) em qualquer computador conectado (a extensão
  manda o login novo ao servidor).
- **Painel web** no mesmo endereço, com login pelo Google. Só o administrador (a conta Google definida no servidor)
  entra no painel. Menu: **Contas** (a fila da troca, **+ Adicionar conta** pela assinatura Claude, os ajustes e os
  **Computadores permitidos** de cada conta, as regras de troca), **Computadores** (a conta Claude logada em cada um;
  renomear, trocar de conta, desconectar) e **Usuários** (as contas Google que podem conectar computadores; não entram
  no painel). No topo: **Histórico**, **Atualizar** e **Minha conta** (kit de recuperação e sessões abertas).
- **Conectar um computador:** `Ctrl/Cmd + Shift + P` → **Swap Plus: Conectar ao servidor** → **Entrar com Google**.
  O código de conexão é a alternativa.
- **Na 1ª conexão** a extensão oferece:
  - **Enviar os logins deste computador** — manda ao servidor as contas vivas que ele ainda não tem, com o mesmo número
    quando o número está livre, e pula as que ele já tem;
  - **Usar as regras deste computador no servidor**.
- **Tela de login do Claude Code:** no modo servidor a extensão a desliga (`claudeCode.disableLoginPrompt`) e volta ao
  normal ao desconectar.
- **Windows:** se o Claude Code do Windows usar o Gerenciador de Credenciais do Windows, a extensão avisa e não grava
  (raro).
- **Recuperação:** backup diário no R2 (Cloudflare) com cofre, chaves, imagem e código. No painel, **Minha conta →
  Mostrar o kit de recuperação** mostra a chave mestra e a senha do backup (é preciso ter entrado com o Google há
  menos de 15 min; some sozinho em 5 min). Guarde as duas **fora do servidor**.
- **Não use o Swap Plus antigo (modo local)** para trocar de conta em contas que já estão no servidor.

Instalar ou atualizar (depois, reabra o VS Code):

- Mac: `curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex`

---

Daqui para baixo: detalhes técnicos, para quem mexe no código.

## O que tem

- **Modo servidor** (2.0): um servidor Swap Plus (numa VPS) guarda os logins de todas as contas, renova e decide as trocas
  para todos os computadores. Cada computador recebe só o acesso da conta escolhida para ele. Painel web do servidor para
  configurar tudo pelo navegador. Detalhes em [Modo servidor](#modo-servidor-20), abaixo. Sem conectar, a extensão continua
  no **modo local** (o padrão de `swapPlus.mode`).
- **Ligar/desligar o Swap Plus** (1.9): primeiro botão da tela de Configurações, opção **Desligar o Swap Plus** na lista
  da barra ou o comando **Swap Plus: Ligar/desligar o Swap Plus (tudo)** (`swapPlus.enabled`). Desligado, não roda
  nenhum comando do motor (não consulta uso, não renova token de nenhuma conta, não troca) e, no modo servidor, não fala
  com o servidor nem grava nada: o Claude Code fica normal.
- **Login salvo na hora** (1.9): o refresh token é de uso único. Quando o login do Claude Code muda numa conta
  cadastrada (login refeito ou token renovado — a validade dele muda), a extensão roda `swap-plus add` para a cópia
  guardada não ficar com o token velho. Conta nova (não cadastrada) continua sendo perguntada.
- **Login morto** (1.9): conta com `relogin_required`, `no_credentials` ou `foreign_credential` nunca é destino da
  troca automática (nem com o limite estourado); na lista e na tela aparece **Login morto — entrar de novo**, e a troca
  manual pede confirmação. Os comandos que gravam no motor rodam um de cada vez (o motor regrava a lista inteira).
- **Barra de status**: um único item, com uma barra fina de cada lado:
  `│  ✉  Sessão (5h): 2% usado — renova hoje 15h  ·  Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h  │`.
  O e-mail não aparece; passe o mouse para ver. O item fica amarelo a partir de 70% e vermelho na linha de troca (vale o limite mais perto do fim).
  No modo servidor aparece uma nuvem depois do envelope (`│ ✉ ☁ …`).
- **Clique na barra**: lista as contas (a em uso com ✓), com **Configurações** em primeiro. Em cima: `Conta 1 — e-mail` e, mais claro, a sessão;
  embaixo: `Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h`. As três partes juntas não cabem numa linha da lista do VS Code.
- **Modo privado**: mostra só “Conta 1”, “Conta 2”… sem e-mail, apelido ou organização. Liga sozinho ao importar um **Export Other**.
  Só muda o que o Swap Plus mostra: o painel de conta do Claude Code e o `swap-plus list` continuam mostrando o e-mail.
- **Exportar / importar** (em Configurações; só no modo local): **Export Other** (o outro computador entra em modo privado),
  **Export Me** (com e-mails) e **Importar contas…**. O arquivo `.cswap` leva as contas e também as regras de troca, os avisos, a
  exibição, a troca automática ligada/desligada e os ajustes de cada conta (rotação, linha própria, prioridade). Não leva o caminho
  do executável nem o histórico. As credenciais vão em texto puro, com permissão só para o seu usuário: transfira e apague.
- **Troca automática** (começa desligada no modo local; liga na tela de Configurações). Como ela fica sabendo:
  - pelo uso que o motor consulta na Anthropic, que pode consultar cerca de 30 vezes por hora (por isso cada conta é
    atualizada de alguns em alguns minutos); perto de uma linha de troca o motor passa a atualizar a cada minuto e a
    extensão verifica a cada 30 s. As linhas do motor são alinhadas às do Swap Plus automaticamente;
  - **na hora**, pelo erro “You've hit your limit” que o Claude Code grava na transcrição (mensagem de erro de API
    `rate_limit`): se a conta bater o limite antes da troca, ela troca em até 15 s. O Claude Code pode ficar esperando;
    uma mensagem (“continue”) faz ele seguir na conta nova.

  Padrão:
  - sessão de 5h em **90%**, semanal em **80%**, Fable em **95%**;
  - quando o Fable acaba na conta em uso, o padrão é **seguir na mesma conta com o Opus 5.5**: o Swap Plus não troca de conta;
    o Claude Code pergunta *"Switch models?"* e oferece o modelo padrão dele. O botão **Deixar pronto** grava em
    `~/.claude/settings.json` o padrão `opus` e o Opus 5.5 no mesmo esforço do Fable (`modelSettings`). Não dá para trocar
    sozinho o modelo de uma conversa aberta: o Claude Code lê modelo e esforço só ao começar a sessão e não oferece comando para isso;
  - opção: trocar de conta para continuar no Fable. Aí o limite do Fable conta enquanto o Fable está em uso (modelo lido das
    transcrições locais do Claude Code, últimos 30 min);
  - na troca, contas com Fable disponível têm preferência;
  - o modelo continua o mesmo depois da troca. A escolha de modelo fica no Claude Code, não na conta.
- **Tela de Configurações** (aba dentro do VS Code): sliders de “avisar em X%” e “trocar em Y%” para cada limite; estratégia
  (mais folga, **aproveitar ao máximo** ou por prioridade); por conta: rotação (contas que participam ficam contornadas de
  verde), linha própria da sessão, prioridade e apelido; histórico; simulação; atualizações da extensão; cartão **Servidor**.
- **Estratégia padrão: aproveitar ao máximo.** O Swap Plus usa primeiro a conta cuja cota semanal zera antes (em até
  24 h, com pelo menos 20% sobrando), mesmo antes de bater uma linha de troca; nas outras horas, troca na linha.
  Ao salvar as regras, a decisão roda na hora. Contas que não estão em uso valem como destino com dados de até 1 h
  (o semanal delas muda devagar); a conta em uso precisa de dados de até 20 min.
- **Ordem das contas** (na tela e na lista da barra): primeiro as que participam da troca automática, de quem renova o semanal
  antes para quem renova depois; no fim, as que não participam, na mesma ordem. Opcional: ordenar pelo número da conta e mudar
  a posição com as setas ↑ ↓ (`swap-plus swap`; só no modo local).

No modo local, a decisão de troca é da extensão (`decide()` em `rules.js`); quem executa a troca é o `swap-plus switch N`.
As regras ficam nas configurações do VS Code (`swapPlus.rules.*`). As configurações `autoswitch.*` do motor não são usadas.
No modo servidor, quem decide é o servidor, com a mesma regra (`rules.js`), e as regras ficam nele.

## Modo servidor (2.0)

**Por que existe.** O login de cada conta Claude é renovado a cada ~8 h, e cada renovação invalida a anterior. Com a
mesma cópia do login em dois computadores, o que renova primeiro mata a cópia do outro (*Login morto*). No modo
servidor, **só o servidor** guarda o login completo (com o refresh token) e renova — sozinho, 2 h antes de o acesso
vencer (`REFRESH_AHEAD_MIN` = 120). Os computadores recebem apenas o acesso (~8 h) da conta que o servidor escolheu para
cada um — e nunca guardam o refresh token. O login em si vence de vez em cerca de um mês (`refreshTokenExpiresAt`): o
painel e o histórico avisam 3 dias antes, e entrar de novo com a conta resolve: **+ Adicionar conta** no painel ou um
`/login` em qualquer computador conectado.

**Servidor e painel.** `https://swap.assistentes.si` (VPS Contabo, atrás de Caddy + Cloudflare). O painel web fica no
mesmo endereço, com login pelo Google; só o administrador (`ADMIN_EMAILS`, definido no servidor) entra. Menu do painel:
**Contas** (fila da troca, ajustes de cada conta, **Computadores permitidos** — `state.accountDevices`, `null` = todos —,
regras de troca gerais e troca automática; **+ Adicionar conta** faz no painel o login da assinatura Claude com código
colado, como o `/login` do Claude Code: `POST /web/api/claude-login/start` e `/finish`), **Computadores** (conta logada
em cada um, renomear, trocar só entre as contas permitidas, desconectar) e **Usuários** (as contas Google liberadas,
`state.allowedEmails`, que só conectam computadores). No topo: **Histórico**, **Atualizar** e **Minha conta** (kit de
recuperação, sessões abertas, sair). Um computador só recebe ou troca para contas cujo `accountDevices` é `null` ou tem
o id dele. Especificação do servidor em [`server/SPEC.md`](../server/SPEC.md), do painel em
[`server/WEB-SPEC.md`](../server/WEB-SPEC.md); instalação e operação na VPS em
[`server/deploy/LEIA-ME.md`](../server/deploy/LEIA-ME.md).

**Como conectar: entrar com Google** (o jeito principal).

1. Uma vez, o administrador libera a conta Google de quem vai usar: painel → **Usuários** → **Liberar**
   (ou, no terminal da VPS, `docker exec swap-plus node /app/server/src/cli.js allow voce.trabalho@gmail.com`). O administrador
   não precisa ser liberado. A mesma conta Google conecta quantos computadores quiser.
2. No VS Code: **Swap Plus: Conectar ao servidor** → **Entrar com Google** (ou o botão no cartão **Servidor** da tela)
   → dar um nome ao computador.
3. O navegador abre: entre com a conta Google. O VS Code espera (notificação com **Cancelar**, até 10 min) e conecta
   sozinho.

O endereço é o de `swapPlus.server.url` (padrão `https://swap.assistentes.si`); **Outro endereço…** entra em outro
servidor. Por baixo: `POST /v1/login/start` → abre o `authUrl` no navegador → `POST /v1/login/poll` a cada 2 s até
`ok` (acesso do computador), `denied` (conta Google não liberada) ou o prazo acabar.

**Alternativa: código de conexão** (servidor sem o Google ligado, ou com certificado próprio). No painel: **Computadores →
Gerar código de conexão** (ou, no container, `node server/src/cli.js pair`). No VS Code: **Swap Plus: Conectar ao servidor** →
**Colar código de conexão** → colar o código → dar um nome ao computador. O código vale 10 min, uma vez só, e traz o endereço
e, com certificado próprio, a impressão digital dele.

Nos dois casos o token do computador fica no cofre de segredos do VS Code; endereço (`swapPlus.server.url`) e modo
(`swapPlus.mode` = `server`) ficam nas configurações **do usuário** (`"scope": "machine"`, como `swapPlus.enabled` e
`swapPlus.executablePath`: o `settings.json` de um projeto não muda nenhum deles). O token só vai para o endereço em que foi
emitido (guardado na conexão): mudar `swapPlus.server.url` depois de conectado deixa o computador *desconectado: o endereço
mudou* até conectar de novo. A extensão não roda em pastas não confiáveis (Modo Restrito). Passo a passo no
[MANUAL](../MANUAL.md#começando-com-o-servidor-20).

**O que a extensão faz no modo servidor:**

- a cada **30 s** manda um batimento ao servidor (modelos em uso no Claude Code e qual conta/validade está logada) e recebe
  as contas, o uso, as regras, o histórico e os computadores conectados. Barra, lista e tela usam esses dados (mesmo formato
  do modo local);
- quando o servidor troca a conta deste computador, ou renova o acesso dela, grava o acesso novo no Claude Code (e os dados da
  conta no `~/.claude.json`), sob as mesmas travas que o Claude Code usa. **Sem refresh token**. A gravação é um
  compare-and-swap: nunca vai por cima de um login novo que ainda não foi para o servidor. Trocando de conta, tira também o
  "dispositivo confiável" da conta anterior;
- quando o Claude Code ganha um login novo (alguém entrou com `/login`; só aí aparece um refresh token), **envia esse login
  ao servidor** e logo depois grava por cima o acesso que o servidor devolve. Se o servidor recusar o login, ele fica como está
  (nada é gravado por cima) e a extensão avisa, com a opção **Usar a conta do servidor**. Login morto ou já gasto no servidor →
  grava a conta do servidor; falha temporária do servidor ao conferir → tenta de novo em ~1 min, sem aviso. Enviado mas sem
  como gravar a conta do servidor → tira só o refresh token do login daqui (o Claude Code não o renova e não mata a cópia do
  servidor);
- **tela de login do Claude Code**: enquanto o modo servidor está ligado, liga `claudeCode.disableLoginPrompt` (o acesso sem
  refresh token faria a extensão do Claude Code abrir a tela de login quando vencesse) e avisa uma vez: *Enquanto estiver no
  modo servidor, o login do Claude Code é feito pelo Swap Plus*. Ao sair do modo servidor, desligar ou desconectar, volta o
  valor de antes;
- **Windows com o Gerenciador de Credenciais** (o Claude Code lendo o login de lá; raro): não grava nada (seria ignorado) e
  explica na barra e no cartão Servidor. `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` definidas também geram aviso;
- **várias janelas**: só uma (a "dona", por trava em arquivo) faz o batimento e grava; as outras só leem o estado. Troca, limite
  e gravação rodam numa fila única; desligar ou voltar ao modo local espera o que estiver em andamento;
- **Enviar os logins deste computador** (oferecido na 1ª conexão, se o motor daqui tem contas, e no cartão Servidor; só no modo
  servidor): `swap-plus list` (planos) e `swap-plus export` para um arquivo temporário numa pasta só do seu usuário, que é apagado
  logo depois de lido. Vão para o servidor as contas vivas que ele ainda não tem, com o mesmo número quando o número está livre lá;
  as que ele já tem são puladas. No fim, um resumo das aceitas e recusadas, com o motivo;
- na 1ª conexão a um servidor, se as regras de troca daqui forem diferentes das de lá: **Usar as regras deste computador no
  servidor** (`PUT /v1/rules`, uma vez por servidor);
- erro de limite na transcrição (“You've hit your limit”) → avisa o servidor, que decide a troca na hora;
- troca pela lista, **Trocar para a conta com mais folga**, ajustes por conta (rotação, linha própria, prioridade, apelido),
  regras e troca automática ligada/desligada vão para o servidor e **valem para todos os computadores**. Os avisos
  (“avisar em X%”) e a exibição continuam sendo de cada computador;
- tela: cartão **Servidor** (modo local/servidor, endereço, situação, **Entrar com Google** / **Colar código** /
  desconectar, computadores conectados com a conta de cada um, a conta Google com que cada um entrou — escondida no modo
  privado — e **Revogar**, diagnóstico de renovação). Somem no modo servidor: exportar/importar, simulação, reordenar contas;
- **nunca** chama o motor local (`swap-plus`) — a única exceção é o envio dos logins (`list` + `export`) — e não roda a decisão
  local; o atualizador também não consulta nem oferece o motor;
- **servidor fora do ar**: a barra mostra *servidor fora do ar · último contato …* e o login do Claude Code não é mexido;
- **Swap Plus desligado**: sem batimento e sem gravar nada;
- acesso revogado (o servidor responde 401): para de chamar o servidor (para não estourar o limite de tentativas do endereço)
  até conectar de novo.

**Desconectar** (comando **Swap Plus: Desconectar do servidor** ou botão no cartão): revoga este computador no servidor, apaga
o token guardado, devolve a tela de login do Claude Code ao que era e pergunta se é para desligar o Swap Plus (o mais seguro
quando outros computadores continuam no servidor) ou voltar ao modo local. Pelo painel: **Computadores → Desconectar**.

**Recuperação.** O `contabo-backup` faz todo dia um backup no R2 com o cofre, as chaves, a imagem e o código. No painel,
**Minha conta → Recuperação → Mostrar o kit de recuperação** mostra a chave mestra do cofre e a senha do backup, só para quem
entrou com o Google há menos de 15 min (some sozinho em 5 min). Guarde as duas **fora do servidor**: sem elas o backup não
abre. Restauração em [`server/deploy/LEIA-ME.md`](../server/deploy/LEIA-ME.md#backup-e-restauração).

> **Não use o modo local com contas que estão no servidor.** As cópias guardadas pelo motor continuam no computador. Se o
> motor renovar uma delas (modo local, em qualquer computador), a conta morre no servidor. Por isso: com o servidor, conecte
> todos os computadores a ele e não use export/import nem o modo local com essas contas.

## Instalar

Passo a passo completo, com Mac e Windows: **[MANUAL](../MANUAL.md)**.

- Mac: `curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex`

Depois, reabra o VS Code. O mesmo comando também atualiza.

Os scripts instalam o `uv` se faltar, o motor (`swap-plus`, da última release de
[bragarpaulo/swap-plus](https://github.com/bragarpaulo/swap-plus/releases)) e a extensão (da última release
[daqui](https://github.com/bragarpaulo/swap-plus-vscode/releases)), e removem a extensão original se estiver instalada.
Para simular sem instalar: `--dry-run` no Mac; `$env:SWAP_PLUS_DRY_RUN = "1"` antes do comando no Windows.

## Atualizações

Seguem o esquema das extensões do VS Code. **Nada roda fora do VS Code**:

- **Na sua máquina**, a extensão verifica **ao abrir e ao fechar o VS Code** e a cada **2 dias**. Com **Extensions: Auto Update**
  ligado no VS Code, instala sozinha: o motor na hora; a extensão nova vale depois de recarregar a janela. Com ele desligado,
  só avisa. Ao fechar, só verifica: se houver versão nova, ela é instalada logo na próxima abertura.
  Dá para verificar à mão em **Configurações → Atualizações da extensão → Verificar agora**. No modo servidor o atualizador
  cuida só da extensão (não consulta nem oferece o motor).
- **No GitHub**, o workflow `plus-sync.yml` do [fork do motor](https://github.com/bragarpaulo/swap-plus/actions) olha o
  claude-swap original a cada 2 dias. Quando sai uma versão **estável** (betas ficam de fora), ele monta o original + o comando
  `swap-plus`, roda a bateria de testes do original e só então publica a release `plus-vX.Y.Z`. Se a extensão percebe a versão
  nova antes, e o `gh` estiver logado na máquina, ela pede ao GitHub para rodar na hora.
- O workflow `plus-upstream.yml` daqui olha a extensão original a cada 2 dias e abre uma issue quando sai versão nova.
  O Swap Plus foi reescrito em `plus/`, então nada entra sozinho: a issue é para avaliar se há algo a portar.
- O workflow `plus-install-test.yml` instala tudo num Mac e num Windows limpos do GitHub (com o VS Code) sempre que os
  instaladores mudam ou sai versão nova da extensão.

Publicar uma versão nova da extensão: subir a `version` em `plus/package.json`, commit, e
`git tag plus-vX.Y.Z && git push origin main plus-vX.Y.Z`. O workflow `plus-release.yml` testa, empacota e publica;
as instalações se atualizam sozinhas. O servidor é atualizado à parte, na VPS
([`server/deploy/LEIA-ME.md`](../server/deploy/LEIA-ME.md#atualizar-a-versão)).

## Estrutura

| Caminho | O que é |
| --- | --- |
| `plus/extension.js` | a extensão (barra de status, alertas, troca automática, export/import, modo servidor) |
| `plus/rules.js` | a regra de troca (`decide()`), usada pela extensão e pelo servidor |
| `plus/claudeAuth.js` | ler e gravar o login do Claude Code (Keychain no Mac, `.credentials.json` nos outros), com as travas dele |
| `plus/serverClient.js` | falar com o servidor (HTTPS, com a impressão digital do certificado quando ele é próprio; `User-Agent: SwapPlus-VSCode/<versão>` em tudo, por causa da Cloudflare), ler o código de conexão, parear e entrar com Google (`loginStart`/`loginPoll`) |
| `server/` | o servidor Swap Plus (Docker); especificação em `server/SPEC.md` |
| `server/web/` | o painel web do servidor; especificação em `server/WEB-SPEC.md` |
| `server/deploy/` | instalação e operação na VPS (Contabo), com o `LEIA-ME.md` |
| `plus/updater.js` | as atualizações (motor e extensão) |
| `plus/media/` | a tela de Configurações |
| `plus/test/smoke.js` | `--unit`: regra de troca, textos e atualizador com dados simulados; sem flag: também contra o `swap-plus` real (grava e desfaz) |
| `plus/scripts/install.sh` / `install.ps1` | instalação a partir das releases (Mac / Windows) |
| `plus/scripts/dev-install.sh` | empacota a partir deste código e instala (desenvolvimento) |
| `.github/workflows/plus-*.yml` | publicar a extensão, testar a instalação e avisar sobre a original |
| `../MANUAL.md` | o passo a passo para quem usa (servidor, painel, problemas e modo local) |
| `../NOVIDADES-2.0.md` | o que mudou da 1.8 para a 2.0 |
| raiz do repositório | código do claude-swap-status original, só como referência |

Branch único: `main`.
