# Swap Plus (extensão do VS Code)

Mostra o uso do Claude Code na barra de status e troca de conta sozinha quando uma conta chega perto do limite.
Desde a **3.0** funciona só com o **servidor Swap Plus** (pasta [`server/`](../server/) deste repositório): o motor
`swap-plus` (CLI Python, fork do claude-swap) e o modo local foram aposentados. Começou como fork pessoal de
[smith89k/claude-swap-status](https://github.com/smith89k/claude-swap-status) (MIT) e foi reescrita aqui em `plus/`.

Passo a passo completo, para quem usa: **[MANUAL](../MANUAL.md)**. O que mudou na 3.0:
**[NOVIDADES-3.0](../NOVIDADES-3.0.md)**.

## Em poucas palavras (versão 3.0)

- **Começar:** rodar o comando de instalação (abaixo) → abrir o VS Code → clicar no Swap Plus na barra de baixo (ela
  mostra *não conectado — clique para entrar com Google*) → **Entrar com Google**, no aviso que aparece. O código de
  conexão (**Colar código**, no mesmo aviso) é a alternativa. Os dois botões também ficam na tela de Configurações
  (botão **Configurações** do aviso), nos cartões **Swap Plus** (em **Sua conta**) e **Servidor**.
- **Servidor Swap Plus:** `https://swap.assistentes.si`. É o único que guarda e renova os logins das contas Claude.
  Os computadores recebem só o **acesso** da conta que o servidor escolheu para cada um.
- **O acesso dura cerca de 8 horas.** O servidor renova sozinho, 2 horas antes de vencer.
- **O login vence de vez em cerca de um mês.** O painel avisa 3 dias antes. Aí basta entrar de novo com aquela conta:
  no painel (**Entrar de novo** no cartão da conta) ou com `/login` no Claude Code de um computador do administrador
  (a extensão manda o login novo ao servidor).
- **Contas novas:** no painel (**Contas → + Adicionar conta**, pela assinatura Claude, sem computador) ou com `/login`
  no Claude Code de um computador do administrador.
- **Painel web** no mesmo endereço, com login pelo Google. Só o administrador (a conta Google definida no servidor)
  entra no painel. Menu: **Contas** (a fila da troca, **+ Adicionar conta**, **Entrar de novo**, os ajustes e os
  **Computadores permitidos** de cada conta, as regras de troca), **Computadores** (a conta Claude logada em cada um;
  renomear, trocar de conta, desconectar) e **Usuários** (as contas Google que podem conectar computadores; não entram
  no painel). No topo: **Histórico**, **Atualizar** e **Minha conta** (kit de recuperação e sessões abertas).
- **Tela de login do Claude Code:** enquanto o computador está conectado, a extensão a desliga
  (`claudeCode.disableLoginPrompt`) e volta ao normal ao desconectar.
- **Windows:** se o Claude Code do Windows usar o Gerenciador de Credenciais do Windows, a extensão avisa e não grava
  (raro).
- **Recuperação:** backup diário no R2 (Cloudflare) com cofre, chaves, imagem e código. No painel, **Minha conta →
  Mostrar o kit de recuperação** mostra a chave mestra e a senha do backup (é preciso ter entrado com o Google há
  menos de 15 min; some sozinho em 5 min). Guarde as duas **fora do servidor**.

## Instalar

Passo a passo completo, com Mac e Windows: **[MANUAL](../MANUAL.md)**.

- Mac (ou Linux): `curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash`
- Windows (PowerShell): `irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex`

Depois: abrir o VS Code (ou fechar e abrir) → clicar na barra do Swap Plus → **Entrar com Google**, no aviso que
aparece. O mesmo comando também atualiza.

Os scripts instalam **só a extensão**: baixam o `.vsix` da release mais nova
[daqui](https://github.com/bragarpaulo/swap-plus-vscode/releases) (achada pelo redirecionamento de `/releases/latest`,
sem a API do GitHub, que fica só de reserva) e rodam `code --install-extension --force`. Também removem a extensão
original (`smith89k.claude-swap-status`), se estiver instalada, e o **motor antigo**, se estiver instalado pelo `uv`:
acham o pacote que traz o comando `swap-plus` (o pacote se chama `claude-swap`) e rodam `uv tool uninstall`. Sem
`uv` ou sem motor, seguem em frente. Para simular sem instalar nem remover nada: `--dry-run` no Mac/Linux
(`curl … | bash -s -- --dry-run`); `$env:SWAP_PLUS_DRY_RUN = "1"` antes do comando no Windows.

---

Daqui para baixo: detalhes técnicos, para quem mexe no código.

## O que tem

- **Barra de status**: um único item, com uma barra fina de cada lado:
  `│  ✉  Sessão (5h): 2% usado — renova hoje 15h  ·  Semanal: 30% usado — renova hoje 18h  ·  Fable: 57% usado — renova hoje 18h  │`.
  O e-mail não aparece; passe o mouse para ver. O item fica amarelo a partir de 70% e vermelho na linha de troca (vale
  o limite mais perto do fim).
- **Clique na barra**: conectado, lista as contas do servidor (a em uso com ✓), com **Configurações...** em primeiro e,
  no fim, **Adicionar conta...** (só mostra um aviso explicando como adicionar: pelo painel ou com `/login` num
  computador do administrador) e **Desligar o Swap Plus**. Escolher uma conta pede a troca ao servidor. Sem conexão
  (ou com o acesso recusado), o clique mostra um aviso com **Entrar com Google**, **Colar código** e
  **Configurações**; desligado, um aviso com **Ligar Swap Plus** e **Configurações**.
- **Tela de Configurações** (aba dentro do VS Code), de cima para baixo: cartão **Swap Plus** (a chave liga/desliga e
  **Sua conta**: a conta Google deste computador com o botão **Sair**, ou **Entrar com Google** / **Colar código**);
  cartão **Servidor** (situação, endereço, **Entrar com Google** / **Colar código** / **Desconectar**, **Outro
  endereço…** e os **Computadores conectados**, com a conta de cada um e o botão **Revogar**); **Troca automática**
  (a chave e **Consultar o servidor agora**); **Regras** (sliders de "avisar em X%" e "trocar em Y%" para cada
  limite, estratégia, **Computadores: Separados/Juntos**, **Avançado**, **Desfazer** / **Salvar regras**);
  **Contas** (ajustes por conta, **Usar esta conta**, **+ Adicionar conta**, que só mostra o mesmo aviso da lista);
  **Exibição**; **Atualizações da extensão** (**Verificar agora**); **Histórico**.
- **Comandos da paleta** (`Cmd/Ctrl + Shift + P`, todos começam com **Swap Plus:**): **Trocar conta**, **Configurar
  trocas automáticas** (abre a tela de Configurações), **Ligar/desligar o Swap Plus (tudo)**, **Ligar/desligar troca
  automática**, **Atualizar uso**, **Trocar para a melhor conta (o servidor escolhe)**, **Verificar atualizações**,
  **Conectar ao servidor** e **Desconectar do servidor**. Saíram na 3.0: **Adicionar conta**, **Export Me**, **Export
  Other** e **Importar contas**.
- **Ligar/desligar o Swap Plus**: opção **Desligar o Swap Plus** na lista da barra, a chave do cartão **Swap Plus** ou
  o comando da paleta (`swapPlus.enabled`). Desligado, não fala com o servidor nem grava nada: o Claude Code fica
  normal.
- **Modo privado** (`swapPlus.privacy.hideEmails`): mostra só "Conta 1", "Conta 2"… sem e-mail, apelido ou
  organização. Só muda o que o Swap Plus mostra: o painel de conta do Claude Code continua mostrando o e-mail.
- **Troca automática**: quem decide é o servidor, com a regra de `rules.js` (`decide()`), a mesma que a extensão usa
  para mostrar a fila. Regras padrão (`RULE_DEFAULTS`): sessão de 5h em **90%**, semanal em **80%**, Fable em
  **95%**, estratégia **aproveitar ao máximo** e, quando o Fable acaba, **seguir na mesma conta com o Opus**
  (`onModelLimit: "sameAccount"`). O botão **Deixar pronto** grava em `~/.claude/settings.json` o padrão `opus` e o
  Opus no mesmo esforço do Fable (`modelSettings`): o Claude Code lê modelo e esforço só ao começar a sessão.
- **Limite batido antes da troca**: a extensão lê as transcrições do Claude Code (`~/.claude/projects/*/*.jsonl`)
  procurando o erro de limite ("You've hit your limit", `rate_limit`) e avisa o servidor, que decide a troca na hora.
  O Claude Code pode ficar esperando; uma mensagem ("continue") faz ele seguir na conta nova.

## Como a extensão fala com o servidor

**Por que existe o servidor.** O login de cada conta Claude é renovado a cada ~8 h, e cada renovação invalida a
anterior. Com a mesma cópia do login em dois computadores, o que renova primeiro mata a cópia do outro (*Login
morto*). Por isso **só o servidor** guarda o login completo (com o refresh token) e renova (sozinho, 2 h antes de o
acesso vencer). Os computadores recebem apenas o acesso (~8 h) da conta que o servidor escolheu para cada um e nunca
guardam o refresh token. O login em si vence de vez em cerca de um mês (`refreshTokenExpiresAt`): o painel e o
histórico avisam 3 dias antes.

**Conectar.** Do jeito principal, **Entrar com Google**: `POST /v1/login/start` → abre o `authUrl` no navegador →
`POST /v1/login/poll` a cada 2 s até `ok` (acesso do computador), `denied` (conta Google não liberada) ou o prazo
acabar (até 10 min, com **Cancelar**). O administrador libera as contas Google em **Usuários** no painel (o próprio
administrador não precisa ser liberado). Alternativa: **código de conexão** (painel → **Computadores → Gerar código de
conexão**; vale 10 min, uma vez só, e traz o endereço e, com certificado próprio, a impressão digital dele).

O token do computador fica no cofre de segredos do VS Code. O endereço (`swapPlus.server.url`, padrão
`https://swap.assistentes.si`) fica nas configurações **do usuário** (`"scope": "machine"`: o `settings.json` de um
projeto não muda). O token só vai para o endereço em que foi emitido: mudar `swapPlus.server.url` depois de conectado
deixa o computador *desconectado: o endereço mudou* até conectar de novo. A extensão não roda em pastas não confiáveis
(Modo Restrito).

**O que a extensão faz, conectada:**

- a cada **30 s** manda um batimento ao servidor (modelos em uso no Claude Code e qual conta/validade está logada) e
  recebe as contas, o uso, as regras, o histórico e os computadores conectados. Barra, lista e tela usam esses dados;
- quando o servidor troca a conta deste computador, ou renova o acesso dela, grava o acesso novo no Claude Code (e os
  dados da conta no `~/.claude.json`), sob as mesmas travas que o Claude Code usa. **Sem refresh token**. A gravação é
  um compare-and-swap: nunca vai por cima de um login novo que ainda não foi para o servidor. Trocando de conta, tira
  também o "dispositivo confiável" da conta anterior;
- quando o Claude Code ganha um login novo (alguém entrou com `/login`; só aí aparece um refresh token), **envia esse
  login ao servidor** e logo depois grava por cima o acesso que o servidor devolve. Se o servidor recusar o login, ele
  fica como está (nada é gravado por cima) e a extensão avisa, com a opção **Usar a conta do servidor**;
- **só os computadores do administrador enviam logins**: o servidor diz no estado (`device.canUploadLogins`; vale para
  os computadores conectados com a conta Google do administrador ou por código). Com `false`, ou depois de um
  `POST /v1/logins` recusado com `403 not_admin`, nenhum login vai ao servidor: a extensão grava por cima a conta do
  servidor e avisa uma vez;
- **tela de login do Claude Code**: liga `claudeCode.disableLoginPrompt` (o acesso sem refresh token faria a extensão
  do Claude Code abrir a tela de login quando vencesse) e, ao desligar ou desconectar, volta o valor de antes;
- **Windows com o Gerenciador de Credenciais** (o Claude Code lendo o login de lá; raro): não grava nada (seria
  ignorado) e explica na barra e no cartão Servidor. `CLAUDE_CODE_OAUTH_TOKEN`/`ANTHROPIC_API_KEY` definidas também
  geram aviso;
- **várias janelas**: só uma (a "dona", por trava em arquivo) faz o batimento e grava; as outras só leem o estado.
  Troca, limite e gravação rodam numa fila única;
- troca pela lista, ajustes por conta, regras e troca automática ligada/desligada vão para o servidor e **valem para
  todos os computadores**. Os avisos ("avisar em X%") e a exibição continuam sendo de cada computador;
- **servidor fora do ar**: a barra mostra *servidor fora do ar · último contato …* e o login do Claude Code não é
  mexido;
- acesso revogado (o servidor responde 401): para de chamar o servidor (para não estourar o limite de tentativas do
  endereço) até conectar de novo;
- **motor antigo**: na primeira abertura da 3.0 (uns 15 s depois de a janela abrir), a extensão remove o motor das
  versões 1.x/2.x, se ele estiver instalado: acha o pacote do `uv` que traz o comando `swap-plus` (`uv tool list`) e
  roda `uv tool uninstall`. Deu certo: uma notificação (*Swap Plus 3.0: o motor antigo (swap-plus) não é mais usado e
  foi removido deste computador*). Falhou (sem `uv`, ou o comando foi instalado de outro jeito): só anota no
  histórico e tenta de novo no dia seguinte. A pasta `~/.claude-swap-backup` (cópias antigas de logins) **não é
  apagada**: se ela existir, a notificação diz que pode ser apagada (à mão; veja o
  [MANUAL](../MANUAL.md#veio-da-versão-2x)). A extensão não chama nenhum programa de fora para trocar de conta.

**Desconectar** (botão **Desconectar** no cartão **Servidor**, ou **Sair** em **Sua conta**): pergunta entre
**Desconectar** e **Desconectar e desligar o Swap Plus**; revoga este computador no servidor, apaga o token guardado e
devolve a tela de login do Claude Code ao que era. Pelo painel: **Computadores → Desconectar**.

**Servidor e painel.** Especificação do servidor em [`server/SPEC.md`](../server/SPEC.md), do painel em
[`server/WEB-SPEC.md`](../server/WEB-SPEC.md); instalação, operação, backup e restauração na VPS em
[`server/deploy/LEIA-ME.md`](../server/deploy/LEIA-ME.md).

## Atualizações e publicação

- **Na sua máquina**, a extensão verifica **ao abrir e ao fechar o VS Code** e a cada **2 dias**. Com
  **Extensions: Auto Update** ligado no VS Code, instala sozinha; a versão nova vale depois de recarregar a janela. Com
  ele desligado, só avisa. Ao fechar, só verifica: se houver versão nova, ela é instalada logo na próxima abertura.
  **Nada roda fora do VS Code.**
- **Publicar uma versão nova da extensão:** subir a `version` em `plus/package.json`, commit, e
  `git tag plus-vX.Y.Z && git push origin main plus-vX.Y.Z`. O workflow `plus-release.yml` testa no Linux e no Windows
  (os testes de `plus/test` e de `server/test`), empacota, confere o `.vsix` e publica a release; as instalações se
  atualizam sozinhas.
- O workflow `plus-install-test.yml` instala a extensão num Mac e num Windows limpos do GitHub (com o VS Code) sempre
  que os instaladores mudam ou sai versão nova, e confere que a versão instalada é a que acabou de sair.
- O workflow `server-ci.yml` testa o servidor e a imagem Docker a cada mudança em `server/`. O servidor é atualizado à
  parte, na VPS ([`server/deploy/LEIA-ME.md`](../server/deploy/LEIA-ME.md#atualizar-a-versão)).

## Estrutura

| Caminho | O que é |
| --- | --- |
| `plus/extension.js` | a extensão (barra de status, avisos, conexão com o servidor, gravação do login) |
| `plus/rules.js` | a regra de troca (`decide()`), usada pela extensão e pelo servidor |
| `plus/claudeAuth.js` | ler e gravar o login do Claude Code (Keychain no Mac, `.credentials.json` nos outros), com as travas dele |
| `plus/serverClient.js` | falar com o servidor (HTTPS, com a impressão digital do certificado quando ele é próprio; `User-Agent: SwapPlus-VSCode/<versão>` em tudo, por causa da Cloudflare), ler o código de conexão, parear e entrar com Google (`loginStart`/`loginPoll`) |
| `plus/updater.js` | as atualizações da extensão |
| `plus/media/` | a tela de Configurações |
| `plus/test/` | testes da extensão com dados simulados (rodam no `plus-release.yml`, no Linux e no Windows) |
| `plus/scripts/install.sh` / `install.ps1` | instalação a partir das releases (Mac/Linux / Windows) |
| `plus/scripts/dev-install.sh` | empacota a partir deste código e instala (desenvolvimento) |
| `server/` | o servidor Swap Plus (Docker); especificação em `server/SPEC.md` |
| `server/web/` | o painel web do servidor; especificação em `server/WEB-SPEC.md` |
| `server/deploy/` | instalação e operação na VPS, com o `LEIA-ME.md` |
| `.github/workflows/` | `plus-release.yml` (publicar), `plus-install-test.yml` (testar a instalação), `server-ci.yml` (servidor) |
| `../MANUAL.md` | o passo a passo para quem usa (instalar, conectar, contas, painel, problemas) |
| `../NOVIDADES-3.0.md` | o que mudou da 2.x para a 3.0 |
| raiz do repositório | código do claude-swap-status original, só como referência |

Branch único: `main`.
