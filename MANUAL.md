# Manual do Swap Plus

O Swap Plus cuida das suas contas do Claude Code dentro do VS Code. Ele mostra quanto cada conta já usou e troca de
conta sozinho quando uma chega perto do limite.

Desde a versão 3.0 o Swap Plus tem duas partes (e, desde a 3.2, uma terceira só para quem usa o Claude Code fora do
VS Code: veja [Hermes e outros serviços](#hermes-e-outros-serviços-sem-vs-code)):

- a **extensão do VS Code**, instalada em cada computador;
- o **servidor Swap Plus**, no endereço **https://swap.assistentes.si**. Ele guarda e renova os logins de todas as
  contas, decide as trocas e atende todos os serviços conectados. Tem um painel no navegador.

**Serviço** é o nome de tudo o que está conectado ao Swap: o VS Code de um computador, um agente como o Hermes, um
robô. No painel, todos ficam na aba **Serviços**.

Não existe mais o motor (`swap-plus`) nem o modo local. O que mudou na 3.0: [NOVIDADES-3.0.md](NOVIDADES-3.0.md).
O que mudou por último (modelo preferido e secundário no painel, com a lista completa e o esforço):
[NOVIDADES-3.4.md](NOVIDADES-3.4.md). Antes disso (a conversa que retoma sozinha depois da troca de conta):
[NOVIDADES-3.3.md](NOVIDADES-3.3.md).
Antes disso (o painel com "serviços" e a tela enxuta no VS Code): [NOVIDADES-3.2.md](NOVIDADES-3.2.md).

Neste manual:

1. [Começando](#começando): instalar, abrir o VS Code e entrar com Google
2. [Contas novas](#contas-novas)
3. [No dia a dia](#no-dia-a-dia)
4. [O painel do servidor](#o-painel-do-servidor)
5. [Hermes e outros serviços (sem VS Code)](#hermes-e-outros-serviços-sem-vs-code)
6. [Se algo der errado](#se-algo-der-errado)
7. [Remover](#remover)

---

<a name="começando-com-o-servidor-20"></a>

## Começando

### Antes de começar

Você vai precisar de:

- internet;
- o **VS Code** instalado ([code.visualstudio.com](https://code.visualstudio.com));
- a extensão **Claude Code** no VS Code (aba Extensões → procure "Claude Code" → Instalar);
- uma **conta Google liberada** no servidor:
  - o administrador (a conta Google definida no servidor) já está liberado;
  - para usar outra conta Google sua (por exemplo, uma em cada computador), libere essa conta no painel, em
    **Usuários** (veja [Usuários](#usuários)).

Não precisa ser administrador do computador.

**A "barra do Swap Plus"** é o item do Swap Plus na linha de baixo da janela do VS Code (o rodapé), no canto esquerdo.
Ele começa com um envelope: `│ ✉ …`. O que acontece ao clicar nele:

- **computador conectado:** abre, lá em cima, a lista de contas. A primeira opção é **Configurações...**, que abre a
  tela do Swap Plus;
- **computador ainda não conectado:** aparece um aviso no canto de baixo, à direita, com os botões **Entrar com
  Google**, **Colar código** e **Configurações**.

### 1. Instalar

**No Mac**

1. Abra o **Terminal**: aperte `Cmd + Espaço`, digite `Terminal` e aperte Enter.
2. Cole este comando e aperte Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/bragarpaulo/claudecode-swap-plus/main/plus/scripts/install.sh | bash
   ```

3. Espere aparecer **`==> Pronto.`**

**No Windows**

1. Abra o **PowerShell**: menu Iniciar, digite `PowerShell` e abra o **Windows PowerShell**
   (não precisa ser "como administrador").
2. Cole este comando e aperte Enter:

   ```powershell
   irm https://raw.githubusercontent.com/bragarpaulo/claudecode-swap-plus/main/plus/scripts/install.ps1 | iex
   ```

3. Espere aparecer **`==> Pronto.`**

> Deu erro de "execução de scripts" no Windows, ou **VS Code não encontrado**? Veja
> [Se algo der errado](#se-algo-der-errado).

O comando instala só a extensão, a versão mais nova. Se o computador tinha o Swap Plus antigo (1.x ou 2.x), ele
também remove o motor antigo e avisa na tela (parte **Motor antigo**).

### 2. Abrir o VS Code

Abra o VS Code. Se ele já estava aberto, feche e abra de novo. A barra do Swap Plus aparece embaixo, à esquerda, com
o texto **não conectado — clique para entrar com Google**.

### 3. Entrar com Google

1. Clique no Swap Plus, na barra de baixo.
2. No aviso que aparece no canto de baixo, à direita, clique em **Entrar com Google**.
3. Lá em cima abre uma caixa com o nome do computador. Confirme o nome e aperte Enter. É com esse nome que ele
   aparece no painel.
4. O navegador abre. Entre com a sua conta Google liberada.
5. Volte ao VS Code. Em poucos segundos aparece o aviso **conectado ao servidor**, e a barra passa a mostrar o uso da
   conta.

Pronto. O servidor escolhe uma conta para este computador e o Claude Code passa a usá-la. Se o servidor ainda não tem
nenhuma conta, adicione uma (veja [Contas novas](#contas-novas)).

O botão **Entrar com Google** também fica na tela do Swap Plus: clique em **Configurações** no aviso e procure o
cartão **Conexão**.

### Como saber se deu certo

- A barra do Swap Plus mostra o uso da conta: `│ ✉ … Sessão (5h): …% usado — renova … │`.
- Clique na barra e escolha **Configurações...**: o cartão **Conexão** mostra **Conectado**.
- No painel, em **Serviços**, aparece uma linha com o nome deste computador, como **ativo agora**.

### Veio da versão 2.x?

- **Rode o comando de instalação** do seu sistema (passo 1). Ele instala a 3.0 e remove o motor antigo. Se a extensão
  se atualizar sozinha antes, ela mesma remove o motor — depois que o computador estiver conectado ao servidor — e
  mostra o aviso **Swap Plus 3.0: o motor antigo (swap-plus) não é mais usado e foi removido deste computador**.
- **A pasta `~/.claude-swap-backup` não é apagada.** Ela fica na sua pasta de usuário e guarda cópias antigas dos
  logins do modo local. Confira no painel se todas as suas contas estão no servidor; estando, pode apagar à mão:
  - Mac (Terminal): `rm -rf ~/.claude-swap-backup`
  - Windows (PowerShell): `Remove-Item -Recurse -Force "$HOME\.claude-swap-backup"`
- **Confira a conexão:** olhe a barra do Swap Plus. Se ela mostra o uso da conta (`Sessão (5h): …`), não precisa
  fazer mais nada. Se mostra **não conectado**, faça o passo 3 ([Entrar com Google](#3-entrar-com-google)).
- **Contas que só estavam no modo local** deste computador não vão sozinhas para o servidor. Entre de novo com cada uma
  (veja [Contas novas](#contas-novas)).
- **Atualize todos os computadores.** Um computador que ainda use o Swap Plus antigo no modo local pode renovar por
  conta própria um login que está no servidor, e aí a conta morre no servidor.

---

## Contas novas

Há dois jeitos. Nos dois, a conta aparece no painel, em **Contas**, e o servidor passa a guardar e renovar o login dela.

### Pelo painel (não precisa de computador)

1. No painel, em **Contas**, clique em **+ Adicionar conta**.
2. O login da Claude abre numa aba nova. Se não abrir, clique em **Abrir o login da Claude**.
3. Entre com a conta Claude que você quer adicionar e autorize.
4. No fim, a página mostra um código. Copie o código inteiro.
5. Volte ao painel, cole o código em **Código da Claude** e clique em **Adicionar**.
6. Pronto. A conta aparece na lista. O login dela fica guardado só no servidor.

O link vale 10 minutos e serve uma vez só. Se vencer, clique em **+ Adicionar conta** de novo.

Se a conta já está no servidor, ela continua com o mesmo número e só ganha o login novo.

### Pelo Claude Code, num computador do administrador

Só os computadores conectados com a conta Google do administrador (ou com um código de conexão) mandam logins ao
servidor.

1. No Claude Code, digite `/login` e entre com a conta nova. **Não saia (logout) da conta anterior.**
2. Em até 30 segundos o Swap Plus manda o login novo ao servidor.
3. A conta aparece no painel, em **Contas**.

O servidor pode deixar este computador em outra conta. O aviso que aparece tem um botão para usar a conta em que você
acabou de entrar.

Nos outros computadores, o login feito no Claude Code não vai para o servidor: o Swap Plus avisa e volta para a conta
do servidor. Use o painel.

No VS Code, a opção **Adicionar conta...** (no fim da lista da barra) não adiciona a conta: só mostra um aviso
dizendo como adicionar.

### Quando o login de uma conta vence

O login de cada conta vence de vez em cerca de um mês. O servidor avisa antes, de dois jeitos.

**No painel**, quando faltam menos de 3 dias:

- no topo aparece um aviso, com o botão **Ver conta N**, que leva até a conta e abre o cartão dela;
- em **Contas**, a linha da conta ganha um sinal de alerta e pisca **Fazer login até …**, com o dia e a hora;
- se o login já venceu, a linha mostra, em vermelho, **Login venceu em …**.

**Por e-mail**, para o dono do servidor:

- toda segunda-feira, às 8h (horário de Brasília), chega um resumo com as contas cujo login vence nos 7 dias
  seguintes e as que já pararam de valer. O resumo chega mesmo quando nenhuma conta vence: assim você sabe que os
  avisos estão funcionando;
- um dia antes de o login de uma conta vencer, chega um e-mail só dessa conta.

Cada e-mail diz qual é a conta e como renovar.

Para renovar, entre de novo com aquela conta, de um dos dois jeitos:

- **Pelo painel:** em **Contas**, clique na linha da conta para abrir o cartão dela e clique em **Entrar de novo**. O
  botão fica no aviso do cartão e também dentro de **Ajustes desta conta** (faltando mais de 3 dias, só ali). O login
  da Claude abre já pedindo o e-mail daquela conta. Entre, copie o código, cole no painel e clique em **Concluir**. A
  conta continua com o mesmo número.
- **Pelo Claude Code:** num computador do administrador, digite `/login` e entre com aquela conta.

Pronto. O servidor fica com o login novo, e o aviso some.

O mesmo vale para uma conta que aparece como **Login morto**: o servidor também avisa por e-mail, na hora em que o
login para de valer. Enquanto isso, a troca automática nunca vai para essa conta.

---

## No dia a dia

### Como funciona, em poucas palavras

- **O servidor é o único que guarda e renova os logins.** Os serviços conectados recebem só o **acesso** da conta que
  o servidor escolheu para cada um.
- **O acesso dura cerca de 8 horas.** O servidor renova sozinho, 2 horas antes de vencer. Você não faz nada.
  A conta que está em uso ele não renova na hora: renovar cancela o acesso antigo, e uma conversa em andamento
  pararia. Ele espera os serviços saírem dela e, se faltar menos de 1 hora, troca os serviços para outra conta antes
  de renovar. Por isso o histórico às vezes mostra uma troca com o motivo "o login da conta N vai ser renovado".
- **O login vence de vez em cerca de um mês.** O painel avisa quando faltam menos de 3 dias, e o servidor manda
  e-mail ao dono. Veja [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence).
- **As regras de troca ficam no servidor** e valem para todos os serviços. Para mudar as regras, use o painel do
  servidor. Os avisos ("avisar em X%") e a exibição continuam sendo de cada computador: ficam na tela de
  Configurações do VS Code.
- **A tela de login do Claude Code fica desligada** enquanto o computador está conectado (opção
  `claudeCode.disableLoginPrompt`). É de propósito: quem cuida do login é o Swap Plus. Ao desconectar, volta ao normal.
- **Windows (raro):** se o Claude Code do Windows usar o **Gerenciador de Credenciais do Windows**, o Swap Plus avisa
  e não grava o login.

### A tela de Configurações, no VS Code

Para abrir: clique na barra do Swap Plus e escolha **Configurações...** (a primeira opção da lista). Se o computador
ainda não está conectado, clique na barra e, no aviso, em **Configurações**. Outro jeito, que sempre funciona:
`Cmd/Ctrl + Shift + P` → **Swap Plus: Configurações**.

A tela abre numa aba do VS Code. Ela mostra só o que é **deste VS Code**, que no painel aparece como um serviço. De
cima para baixo:

- **Swap Plus neste VS Code**: a chave que liga e desliga o Swap Plus aqui. Desligado, este VS Code para de falar com
  o servidor e de trocar de conta. Os outros serviços não mudam;
- **Conexão**: a situação (**Conectado**, **Não conectado**, **Servidor fora do ar** ou **Acesso recusado**) e o
  endereço do servidor. Conectado, mostra o nome deste serviço, a conta Google com que ele entrou, o último contato e
  o botão **Sair**. Sem conexão, mostra os botões **Entrar com Google**, **Colar código** e **Outro endereço…** (este
  último serve para entrar em outro servidor Swap Plus). Os avisos sobre o login do Claude Code deste computador
  também aparecem aqui;
- **Conta em uso aqui**: a conta que este VS Code está usando, com o plano, as barras de uso (sessão de 5 horas,
  semanal e por modelo) e quando cada limite renova. Uma linha diz se a troca automática está **ligada** ou
  **desligada** (para mudar, use o painel). Embaixo, em **Trocar de conta**, ficam as outras contas, cada uma com um
  resumo do uso e o botão **Usar esta conta**. Uma conta que não dá para usar continua na lista, com o botão travado e
  o motivo escrito (por exemplo, **Login morto**). Se os serviços andam juntos (regra **Serviços: Juntos**), a tela
  avisa que trocar aqui troca também nos outros que estão em uso;
- **Mais opções deste VS Code** (vem fechado: clique para abrir). O que você muda aqui vale na hora, só para este VS
  Code:
  - **Avisar quando chegar em**: os avisos de uso da sessão de 5 horas, do limite semanal e do limite por modelo, cada
    um com a sua porcentagem. O aviso só avisa: quem troca de conta é o servidor, pelas regras do painel;
  - **Depois da troca de conta**: **Retomar sozinho a conversa que parou no limite** (vem ligado). Quando uma
    conversa do Claude Code para com "You've hit your limit" e o Swap Plus troca de conta, ele manda nela a mensagem
    "Troquei de conta, pode continuar." e ela segue sozinha. Vale para todas as janelas do VS Code do computador.
    Para isso o Swap Plus põe um gancho no `settings.json` do Claude Code (detalhes em
    [NOVIDADES-3.3.md](NOVIDADES-3.3.md));
  - **Exibição**: o modo privado e o que aparece na barra;
  - **Atualizações da extensão**: a versão instalada e o botão **Verificar agora**;
- no pé da tela, o botão **Abrir o painel**, que abre o painel do servidor no navegador. Ele só funciona com este VS
  Code conectado.

Contas, regras de troca, usuários e os outros serviços não ficam nesta tela: ficam no painel (veja
[O painel do servidor](#o-painel-do-servidor)). Só o administrador entra no painel.

### Trocar de conta à mão

Clique na barra do Swap Plus e escolha a conta. O ✓ marca a que está em uso. A troca vale em até 30 segundos. Há mais
dois jeitos:

- na tela de Configurações: em **Trocar de conta**, clique em **Usar esta conta**;
- pelo painel: **Serviços** → clique na linha do serviço → **Trocar para** → **Trocar**.

Se a conta bater o limite antes da troca, a conversa do Claude Code para. Com a opção **Retomar sozinho a conversa
que parou no limite** ligada (o padrão), ela retoma sozinha alguns segundos depois da troca: o Swap Plus manda nela
"Troquei de conta, pode continuar.". Com a opção desligada, mande você uma mensagem (por exemplo, "continue") e ela
segue na conta nova.

### Desligar o Swap Plus por um tempo

Desligado, o Swap Plus não fala com o servidor, não troca de conta e não mexe no login. O Claude Code funciona
normalmente.

1. Clique na barra do Swap Plus.
2. Escolha **Desligar o Swap Plus** (a última opção da lista).
3. Para ligar de novo, clique na barra (ela mostra *Swap Plus desligado*) e, no aviso que aparece, em **Ligar Swap
   Plus**.

Também dá para desligar e ligar pela chave que fica no alto da tela de Configurações, em **Swap Plus neste VS Code**.
Desligar aqui não muda nada nos outros serviços.

### Desconectar um computador

1. Clique na barra do Swap Plus → **Configurações...**.
2. No cartão **Conexão**, clique em **Sair**.
3. Na pergunta que aparece, escolha:
   - **Desconectar**: o Swap Plus continua ligado, mostrando *não conectado*; ou
   - **Desconectar e desligar o Swap Plus**: o Claude Code fica normal, sem o Swap Plus.
4. O Claude Code fica com o acesso atual até ele vencer (algumas horas). Para voltar, faça de novo o
   [Entrar com Google](#3-entrar-com-google).

Para tirar **outro** serviço (por exemplo, um computador que você não usa mais): painel → **Serviços** → clique na
linha dele → **Desconectar**.

### Atualizar o Swap Plus

A extensão se atualiza sozinha, dentro do VS Code: ao abrir, ao fechar e a cada 2 dias. Para conferir na hora: tela de
Configurações → **Mais opções deste VS Code** → **Atualizações da extensão** → **Verificar agora**.

Para forçar a versão mais nova:

1. Rode de novo o comando de instalação do seu sistema (veja [Instalar](#1-instalar)).
2. Feche e abra o VS Code.

A conexão com o servidor continua como está.

### Sem Google: código de conexão

Use só se o **Entrar com Google** não funcionar.

1. No painel, abra **Serviços** e desça até **Conectar um serviço**.
2. Clique em **Gerar código de conexão**.
3. Clique em **Copiar código**. O código vale 10 minutos e serve uma vez só.
4. No VS Code, clique na barra do Swap Plus e, no aviso que aparece, em **Colar código**. (O mesmo botão fica na tela
   de Configurações, no cartão **Conexão**.)
5. Cole o código e aperte Enter.
6. Confirme o nome do computador e aperte Enter. Daí em diante é igual à conexão com Google.

### Esconder os e-mails (modo privado)

Clique na barra → **Configurações...**, abra **Mais opções deste VS Code** e, em **Exibição**, marque **Modo privado**.
Ele mostra só "Conta 1", "Conta 2"… sem e-mail. Ele muda só o que o Swap Plus mostra neste computador. Não é uma
trava: o painel de conta do próprio Claude Code e o comando `/status` continuam mostrando o e-mail da conta em uso.

---

## O painel do servidor

O painel é a tela do servidor no navegador. Nele você vê todas as contas e configura tudo: contas, serviços,
usuários e regras de troca. A tela de Configurações do VS Code mostra só o que é daquele VS Code
(veja [A tela de Configurações, no VS Code](#a-tela-de-configurações-no-vs-code)). As regras de troca, os ajustes das
contas, os outros serviços, os usuários, o histórico e o kit de recuperação ficam no painel.

### Entrar no painel

1. No navegador, abra **https://swap.assistentes.si**.
2. Clique em **Entrar com Google**.
3. Entre com a conta do administrador (a conta Google definida no servidor).

Do VS Code também dá para chegar ao painel: na tela de Configurações, clique em **Abrir o painel**.

**Só o administrador entra no painel.** Os usuários liberados (veja [Usuários](#usuários)) servem só para conectar
serviços.

### O que tem no painel

O menu tem três itens:

- **[Contas](#contas)**: as contas Claude, o uso de cada uma e as regras de troca;
- **[Serviços](#serviços)**: tudo o que está conectado ao Swap e a conta Claude de cada um;
- **[Usuários](#usuários)**: as contas Google que podem conectar serviços.

No topo ficam:

- **Histórico**: os últimos acontecimentos, com data e serviço (trocas de conta, logins recebidos, avisos e
  mudanças de regra);
- **Atualizar**: busca os dados na hora;
- **Minha conta**: seu e-mail, **Sair**, o kit de recuperação e as sessões abertas (veja [Minha conta](#minha-conta));
- os **avisos**: por exemplo, um login que vence em menos de 3 dias ou uma conta com login morto.

Cada uma das três abas tem um **campo de busca**, acima da lista. Digite, e a lista mostra só o que combina. A busca
olha tudo o que cada item mostra, inclusive o que só aparece com o cartão aberto: por exemplo, `login morto`,
`fora da troca`, `sem contato` ou o nome de um serviço. Ela não liga para maiúsculas nem acentos. Com mais de uma
palavra, todas precisam aparecer. Ao lado do campo aparece quantos ficaram (por exemplo, **3 de 23**). Para limpar,
clique no **×** do campo ou aperte `Esc`.

O painel se atualiza sozinho a cada 30 segundos. Funciona também no celular.

### Contas

Uma linha para cada conta Claude. No alto ficam o botão **+ Adicionar conta** (veja
[Pelo painel](#pelo-painel-não-precisa-de-computador)) e o campo de busca.

**Clique numa linha para abrir o cartão da conta**, com todos os limites, os dados e os ajustes. Clique de novo para
fechar. O painel abre com todas as contas fechadas.

A linha é o resumo da conta:

- número, apelido e e-mail;
- as etiquetas **Em 1 serviço** ou **Em N serviços** (a conta está em uso agora), **1º na fila**, **2º na fila**… e
  **Login morto**;
- uma barra de uso só: a do limite mais perto de parar a conta (sessão de 5 horas, semanal ou modelo), com a
  porcentagem e quando esse limite renova;
- **Participa da troca** ou **Fora da troca**;
- o alerta de login, quando há: **Fazer login até …** ou **Login venceu em …** (veja
  [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence)).

**A ordem da lista.** Primeiro vêm as contas em uso (com serviço nelas agora). Depois, as outras que participam da
troca, na ordem em que o servidor vai usá-las: vem antes a conta cujo limite semanal renova antes (em empate, a menos
usada). As etiquetas **1º na fila**, **2º na fila**… mostram essa ordem. No fim ficam as contas que não participam,
com o indicador **Fora da troca**. O painel traz um resumo disto em **Como ler a lista**, acima da busca.

No cartão aberto:

- plano e organização;
- **Situação**: ok, **Login morto** ou fora da troca;
- barras de uso: sessão de 5 horas, semanal e por modelo (por exemplo, Fable). Verde: longe da linha de troca;
  amarelo: chegando perto; vermelho: na linha (o servidor passa o serviço para outra conta);
- **Serviços nela** (os que estão na conta agora) e **Serviços permitidos**;
- **Acesso atual**: até quando vale. O servidor renova sozinho;
- **Login vale até**: quando o login vence. Faltando menos de 3 dias (ou com o login vencido ou morto), aparece um
  aviso com o botão **Entrar de novo**.

O que dá para fazer em cada conta, com o cartão aberto:

- **Participa da troca**: ligado, a troca automática usa a conta. Desligado, a conta fica **Fora da troca** e vai para
  o fim da lista (se houver serviço nela, continua no alto enquanto isso). Vale na hora.
- **Ajustes desta conta**:
  - **Quando trocar desta conta**: **Usar regra padrão** (as regras de troca gerais) ou linhas próprias para a sessão
    de 5 horas, o semanal e o modelo. Cada mudança aqui vale na hora;
  - **Apelido**, **Prioridade** (só vale na estratégia **Por prioridade**; número maior é usado primeiro) e
    **Serviços permitidos**: **Todos** (inclusive os que conectarem depois) ou **Só estes** (marque um ou mais).
    Um serviço só recebe as contas que o permitem, na troca automática e na troca manual. Depois de mudar, clique
    em **Salvar ajustes**;
  - **Entrar de novo**: renova o login da conta (veja
    [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence)).
- **Remover conta**: o painel pede confirmação. O servidor apaga o login guardado da conta.

#### Regras de troca

Ficam em **Contas**, abaixo da lista. Valem para **todos** os serviços conectados. A troca automática liga e
desliga na hora; as outras regras só mudam quando você clicar em **Salvar regras**.

- **Troca automática:** ligada ou desligada. Vale na hora. Desligada, nenhum serviço troca de conta sozinho. A
  troca manual continua funcionando.
- **Serviços:** **Separados** (o padrão: cada serviço numa conta, cada um com a sua sessão de 5 horas) ou
  **Juntos** (todos na mesma conta, a do topo da fila, e trocam juntos). Vale para os serviços ativos agora. Um
  serviço só usa as contas permitidas para ele.
- **Quando trocar de conta:** porcentagem da sessão de 5 horas, do limite semanal e do limite de um modelo
  (por exemplo, Fable).
- **Quando o limite de um modelo acaba:** **Seguir na mesma conta** (com outro modelo, como o Opus) ou **Trocar de
  conta**. Nos dois casos, quando o Fable acaba o Swap Plus muda sozinho o modelo padrão do Claude Code de cada
  serviço para o **Opus 5.5** (as conversas novas já abrem nele) e volta para o Fable quando ele renova. Uma
  conversa que já estava aberta não muda sozinha: nela, escolha **Opus 5.5** no seletor de modelo e mande
  "continue". Com **Trocar de conta**, enquanto alguma conta tiver Fable a conversa aberta nem para.
  **Conta que não tem o Fable** (extensão 3.4.1): algumas contas não têm o modelo no plano. No uso delas não
  aparece a linha "Fable" (conta com Fable sem usar aparece como "Fable 0%"), e o Claude Code responde "Fable 5.2
  requires usage credits". Enquanto o computador estiver numa conta assim, o modelo padrão passa para **o outro
  modelo do painel** e volta ao Fable quando o computador for para uma conta que tem. Isso vale também com o painel
  em preferido = Opus 5.5 e secundário = Fable 5.2: num computador que usa o Fable como padrão, a conta sem Fable
  leva o padrão para o Opus 5.5.
- **Para qual conta ir (estratégia):** **Aproveitar ao máximo** (o padrão), **Mais folga** ou **Por prioridade**.
  No mesmo cartão ficam os modelos:
  - **Modelo preferido** e o **esforço** dele: o modelo que as conversas usam e que o Swap procura nas contas (ao
    trocar, as contas que ainda têm esse modelo vêm primeiro);
  - **Modelo secundário** e o **esforço** dele: onde as conversas novas abrem quando o preferido acaba em todas as
    contas. Quando o preferido renova, o padrão volta para ele;
  - as listas trazem todos os modelos que as contas enxergam, e o esforço mostra só os níveis que o modelo aceita
    (**Baixo**, **Médio**, **Alto**, **Muito alto**, ou **Padrão do Claude Code**, para o Swap não mexer). A lista é
    lida na Anthropic uma vez por dia e quando você clica em **Atualizar modelos**;
  - o preferido e o secundário precisam ser diferentes. Uma conversa já aberta não troca de modelo sozinha.
- **Ajustes finos:** **Horas para "cota prestes a zerar"**, **Intervalo mínimo entre trocas**, **Margem da conta de
  destino** e **Mínimo de Fable sobrando no destino**. Este último vale para as trocas que o servidor faz por conta
  própria (aproveitar uma cota que vai zerar, renovar um login): a conta de destino precisa ter pelo menos esse
  percentual do Fable sobrando. De 0 a 50%; o padrão é 10%. Troca obrigatória (conta na linha ou limite batido) não
  olha esse número.
- Botões: **Voltar ao padrão** (só preenche o formulário; ainda precisa salvar), **Desfazer** e **Salvar regras**.

### Serviços

**Serviço** é tudo o que está conectado ao Swap: o VS Code de um computador, um agente como o Hermes, um robô. Aqui
há uma linha para cada serviço. No alto fica o campo de busca.

A linha mostra:

- uma bolinha com a cor da situação e o nome do serviço;
- o sistema e quem conectou (a conta Google, ou **por código de conexão**);
- a conta Claude em que ele está agora (**Conta N**, com uma barra de uso), ou **Sem conta Claude agora**;
- a situação do serviço, por escrito.

As situações de um serviço:

- **ativo agora** (bolinha verde): em uso nos últimos 5 minutos. Por exemplo, um VS Code aberto ou um agente
  trabalhando. A troca automática cuida só dos serviços ativos;
- **conectado · sem uso agora** (bolinha azul): ligado e falando com o servidor, mas sem uso no momento. É assim que
  um agente como o Hermes fica entre uma tarefa e outra. Está tudo certo com ele;
- **aguardando contato · o servidor reiniciou há pouco** (bolinha cinza, só o contorno): o servidor reiniciou há
  pouco e o serviço ainda não falou com ele. Em até 5 minutos passa para uma das outras situações;
- **sem contato · visto …** (bolinha cinza): não fala com o servidor há mais de 5 minutos (fechado, desligado ou sem
  internet). Ao lado aparece a última vez em que foi visto. Se ele nunca falou com o servidor, aparece
  **sem contato · ainda não apareceu**.

O painel traz esta mesma explicação em **O que quer dizer cada situação**, acima da busca.

A lista vem nesta ordem: os ativos, os conectados, os que estão aguardando contato e os sem contato. Dentro de cada
grupo, por nome. No alto da aba **Contas**, o resumo conta os serviços por situação. Por exemplo:
`5 serviços (3 ativos agora, 1 conectado, 1 sem contato)`.

**Clique numa linha para abrir o cartão do serviço.** Clique de novo para fechar. O painel abre com todos fechados.
No cartão aparecem o sistema, o usuário (a conta Google com que ele entrou), o contato e a **Conta Claude agora**,
com número, e-mail e barras pequenas de uso. O que dá para fazer ali:

- **Renomear**: clique em **Renomear**, digite o nome novo e clique em **Salvar**.
- **Trocar de conta**: em **Trocar para**, escolha uma conta (ou **Melhor conta**, e o servidor escolhe) e clique em
  **Trocar**. Vale em até 30 segundos. Só aparecem as contas permitidas para esse serviço.
- **Desconectar**: o painel pede confirmação. O serviço para de receber o acesso das contas na hora.

Embaixo da lista fica o bloco **Conectar um serviço**: o passo a passo do VS Code e o botão **Gerar código de
conexão** (veja [Sem Google: código de conexão](#sem-google-código-de-conexão)).

### Usuários

Os usuários são as contas Google que podem conectar serviços pelo VS Code (**Entrar com Google**). São as suas
contas Google: por exemplo, uma para cada computador. **Eles não entram no painel**: o painel é só do administrador.

A tabela tem uma linha por usuário, com estas colunas:

- **Usuário**: o e-mail. O seu aparece com a marca **você**;
- **Situação**: **Administrador** (a conta definida no servidor, que não sai da lista), **Liberado** ou **Não
  liberado** (foi tirado da lista, mas ainda tem serviço conectado);
- **Serviços**: quantos ele conectou e quais;
- **Desde**: o dia em que ele conectou o primeiro serviço (o painel ainda não mostra o dia em que ele foi liberado).
  No administrador aparece **definido no servidor**.

Clique nos títulos **Usuário**, **Situação** ou **Serviços** para ordenar a tabela. Clique de novo para inverter. No
celular, cada linha vira um cartão e não dá para ordenar. Acima da tabela fica o campo de busca.

**Liberar um usuário:**

1. Em **Liberar um usuário (conta Google)**, digite a conta (por exemplo, `voce@example.com`).
2. Clique em **Liberar**.
3. No computador que vai usar essa conta, siga [Começando](#começando).

A mesma conta Google conecta quantos serviços quiser. Quais contas Claude cada serviço pode usar se escolhe em
**Contas**: abra a conta e, em **Ajustes desta conta**, mude **Serviços permitidos**.

Os serviços conectados com um usuário (e não com o administrador) usam as contas do servidor, mas não mandam
logins para ele.

**Tirar um usuário:** clique em **Tirar** na linha dele e confirme em **Tirar usuário**. Ele não conecta mais
serviços novos. Os serviços que ele já conectou continuam funcionando: para cortar, desconecte-os em **Serviços**.
Enquanto ele tiver serviço conectado, continua na tabela como **Não liberado**, com o botão **Liberar de novo**.

### Minha conta

Clique em **Minha conta**, no topo. Ali ficam:

- o e-mail com que você entrou e o botão **Sair**;
- a **Recuperação**, com o kit de recuperação (veja logo abaixo);
- as **sessões abertas neste painel**: os navegadores em que o painel está aberto. **Encerrar** obriga aquele
  navegador a entrar de novo com Google.

### Recuperação: guarde duas chaves fora do servidor

Todo dia o servidor faz uma cópia de segurança (backup) na nuvem (Cloudflare R2). Ela leva o cofre com os logins, as
chaves, a imagem e o código do servidor.

Para abrir essa cópia, se o servidor for perdido, são precisas duas chaves: a **chave mestra** e a **senha do
backup**. Juntas, elas são o **kit de recuperação**. Guarde as duas **FORA do servidor**. Faça isto uma vez:

1. No painel, clique em **Minha conta**, no topo.
2. Em **Recuperação**, clique em **Mostrar o kit de recuperação**.
3. Se aparecer **Entrar de novo com Google**, clique e entre. O kit só aparece se você entrou com o Google há menos
   de 15 minutos.
4. Clique em **Copiar chave mestra** e guarde num lugar seguro fora do servidor (gerenciador de senhas, por exemplo).
5. Clique em **Copiar senha do backup** e guarde do mesmo jeito.
6. Clique em **Esconder o kit**. Ele também some sozinho em 5 minutos.

Sem essas duas chaves, o backup não abre. A restauração em si é feita por quem cuida do servidor, seguindo o
[guia do servidor](server/deploy/LEIA-ME.md). Depois de restaurar, algumas contas podem aparecer como **Login
morto**: entre de novo com cada uma (veja [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence)).

---

## Hermes e outros serviços (sem VS Code)

O **Swap Plus Cliente** faz o trabalho da extensão sem o VS Code. Ele serve para o Hermes (o assistente de IA que
fica sempre ligado) e para outros serviços e rotinas em segundo plano usarem o Claude Code com as contas do servidor.

- No painel, o cliente aparece em **Serviços**, como mais um serviço, com o nome que você deu a ele. Dá para
  renomear, trocar de conta e desconectar, como os outros.
- Enquanto o Hermes usa o Claude Code, e por alguns minutos depois, o cliente aparece como **ativo agora**. Entre uma
  tarefa e outra, aparece como **conectado · sem uso agora**: é o normal, está tudo certo com ele. Só **sem contato**
  quer dizer que ele não fala com o servidor há mais de 5 minutos.
- Ele tem a própria pasta de login do Claude Code. Não mexe no Claude Code do VS Code.
- Para o Hermes usar só algumas contas, escolha em **Contas** → **Ajustes desta conta** → **Serviços permitidos**.
- O Hermes do servidor usa o Claude Code por este cliente desde 20/11/2026
  ([como ficou instalado](cliente/deploy/LEIA-ME.md)).

Como instalar, conectar e usar: [manual do cliente](cliente/README.md).

---

## Se algo der errado

| Problema | O que fazer |
| --- | --- |
| Windows: o comando de instalação dá erro de "execução de scripts" | No PowerShell, rode `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Depois rode o comando de instalação de novo. |
| O comando de instalação diz **VS Code não encontrado** | Instale o VS Code ([code.visualstudio.com](https://code.visualstudio.com)) e rode o comando de novo. No Mac, o VS Code precisa estar na pasta **Aplicativos** (se ele ficou em Downloads, arraste para Aplicativos). |
| O comando de instalação diz **o comando swap-plus existe (…), mas … não mexi nele** | É o motor antigo, instalado de outro jeito (sem o `uv`), ou o `uv` não foi encontrado. O Swap Plus 3.0 não usa esse comando: pode ignorar ou apagar o arquivo indicado. |
| O motor antigo (o comando `swap-plus`) continua no computador, mesmo depois de conectar | A extensão tenta remover sozinha depois que o computador conecta ao servidor. Se a remoção falha, ela tenta de novo no dia seguinte, sem mostrar aviso. Se o motor foi instalado de outro jeito (sem o `uv`), ela não mexe nele. Para resolver já, rode o comando de instalação de novo, ou remova à mão (veja [Remover](#remover)). O Swap Plus 3.0 funciona mesmo com o motor antigo instalado. |
| A barra do Swap Plus não aparece depois de instalar | Feche e abra o VS Code. Ou: `Cmd/Ctrl + Shift + P` → **Developer: Reload Window**. |
| O Swap Plus não aparece numa pasta | O VS Code abriu a pasta no **Modo Restrito** (pasta não confiável). Clique no aviso do topo para confiar na pasta, ou abra outra. |
| A barra mostra **não conectado — clique para entrar com Google** | Este computador ainda não entrou no servidor. Faça o [Entrar com Google](#3-entrar-com-google). |
| Aparece **a conta Google … não está liberada neste servidor** | O administrador precisa liberar essa conta no painel (**Usuários** → **Liberar**). Depois, entre de novo. Entrou com a conta errada? Clique em **Entrar com outra conta** no aviso. |
| Aparece **não consegui abrir o navegador** | Clique em **Copiar link** no aviso, cole o link no navegador e entre com a sua conta Google. |
| Aparece **o tempo para entrar com o Google acabou** | O link vale 10 minutos. Clique em **Entrar com Google** de novo. |
| Aparece **o servidor … não está com o login do Google ligado** | Gere um código de conexão no painel, clique em **Colar código de conexão** no aviso e cole o código (veja [Sem Google: código de conexão](#sem-google-código-de-conexão)). |
| Aparece **o código não foi aceito** | O código vale 10 minutos e uma vez só. Gere outro no painel e cole de novo. |
| O painel diz que **o painel é só do administrador** | É normal: só o administrador entra no painel. Os usuários liberados servem só para conectar serviços. Clique em **Entrar com outra conta** e use a do administrador. |
| O painel pede para **entrar de novo com Google** ao mostrar o kit de recuperação | Por segurança, o kit só aparece até 15 minutos depois de entrar. Clique em **Entrar de novo com Google**. |
| O painel (ou um e-mail do servidor) avisa que **o login de uma conta vence**, ou uma conta aparece como **Login morto** | No painel, em **Contas**, clique na linha da conta para abrir o cartão dela e clique em **Entrar de novo**. Ou faça `/login` com ela no Claude Code de um computador do administrador. Veja [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence). A troca automática nunca vai para uma conta com login morto. |
| Ao adicionar uma conta pelo painel, aparece **código incompleto**, **esse código não é deste login** ou **este login venceu** | Clique em **+ Adicionar conta** (ou **Entrar de novo**) outra vez, entre com a conta e copie o código **inteiro** (ele tem um `#` no meio). O link vale 10 minutos e serve uma vez só. |
| Ao **Entrar de novo**, o painel diz que você entrou com **outro e-mail** | A página da Claude estava em outra conta. A conta pedida não mudou. Saia da outra conta na página da Claude (ou use uma janela anônima) e clique em **Entrar de novo** outra vez. |
| Fiz `/login` no Claude Code e o computador voltou para outra conta | Este computador não é do administrador: só os computadores do administrador mandam logins ao servidor. Adicione a conta pelo painel (**Contas** → **+ Adicionar conta**). |
| O Claude Code não abre mais a tela de login | É de propósito: conectado ao servidor, quem cuida do login é o Swap Plus. Para adicionar uma conta, use o painel (ou `/login` num computador do administrador). Ao desconectar, volta ao normal. |
| A barra mostra **nenhuma conta no servidor ainda** | Adicione uma conta: no painel (**Contas** → **+ Adicionar conta**) ou com `/login` num computador do administrador. |
| A barra mostra **sem conta atribuída — clique para escolher** | O servidor ainda não escolheu uma conta para este computador. Clique na barra e escolha uma. Se a conta que você quer não vale para este computador, veja a linha de baixo. |
| Em **Serviços** → **Trocar para**, uma conta não aparece para um serviço (ou nenhuma aparece) | Essa conta não permite esse serviço. Em **Contas**, clique na linha da conta e abra **Ajustes desta conta**. Em **Serviços permitidos**, escolha **Todos** ou marque o serviço. Clique em **Salvar ajustes**. |
| No painel, um serviço aparece como **conectado · sem uso agora** ou **aguardando contato** | É normal. **conectado · sem uso agora**: o serviço está ligado e falando com o servidor, só não está sendo usado no momento (é assim que o Hermes fica entre uma tarefa e outra). **aguardando contato**: o servidor reiniciou há pouco; em até 5 minutos a situação se acerta sozinha. |
| No painel, um serviço aparece como **sem contato** | Ele não fala com o servidor há mais de 5 minutos. Num computador, é o normal com o VS Code fechado ou o computador desligado. Se o serviço deveria estar ligado, confira se ele está aberto, com internet e com o Swap Plus ligado. Para o Hermes, veja o [manual do cliente](cliente/README.md). |
| Não acho as regras de troca (ou os ajustes das contas) na tela de Configurações do VS Code | Elas ficam no painel do servidor: em **Contas**, as **Regras de troca** ficam abaixo da lista e os **Ajustes desta conta** ficam no cartão de cada conta. Para chegar lá, clique em **Abrir o painel**, no pé da tela de Configurações. Só o administrador entra no painel. |
| A barra mostra **servidor fora do ar** | Espere. Enquanto isso o Swap Plus não mexe no login, e o Claude Code segue com o acesso que tem (algumas horas). O Swap Plus tenta de novo a cada 30 segundos. Se demorar, avise quem cuida do servidor. |
| A barra mostra **servidor recusou este computador** | Este computador foi desconectado (pelo painel). Conecte de novo: clique na barra e, no aviso, em **Entrar com Google**. |
| A barra mostra **login do Claude Code recusado pelo servidor** | O servidor não aceitou o login que está no Claude Code (o aviso diz o motivo). Para seguir com a conta do servidor: clique na barra, depois em **Usar a conta do servidor**, e confirme. |
| A barra mostra **servidor: o endereço mudou** | O endereço do servidor nas configurações foi trocado. Conecte de novo: clique na barra e, no aviso, em **Entrar com Google**. |
| Aparece **o certificado do servidor não é o esperado** | O certificado do servidor mudou (por exemplo, ele foi reinstalado). Conecte de novo com um código de conexão novo (veja [Sem Google: código de conexão](#sem-google-código-de-conexão)). |
| Windows: a barra mostra **o Swap Plus não consegue trocar o login aqui** | O Claude Code deste Windows guarda o login no **Gerenciador de Credenciais do Windows** (é raro). O Swap Plus avisa e não grava nada. Se alguém definiu a variável `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN`, apague-a e reabra o VS Code. |
| Aviso sobre `CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY` | O Claude Code está usando essa variável no lugar do login, e a troca de conta não vale. Apague a variável e reabra o VS Code. |
| A extensão não se atualiza sozinha | Rode o comando de instalação de novo e reabra o VS Code. A conexão continua como está. |
| Quero parar tudo por um tempo | Desligue o Swap Plus (veja [Desligar o Swap Plus por um tempo](#desligar-o-swap-plus-por-um-tempo)). |

---

## Remover

1. **Desconecte o computador** antes (veja [Desconectar um computador](#desconectar-um-computador)).
2. **Extensão:** VS Code → Extensões → Swap Plus → Desinstalar.

O motor antigo (versões 1.x e 2.x) já é removido pelo comando de instalação e pela própria extensão. Se ainda sobrou
num computador, remova à mão no Terminal ou no PowerShell: `uv tool uninstall claude-swap`.

A pasta `~/.claude-swap-backup` (cópias antigas de logins, do motor antigo) não é apagada por ninguém. Se ela existir,
pode apagar à mão (veja [Veio da versão 2.x?](#veio-da-versão-2x)).

---

Mais detalhes: [novidades da 3.4](NOVIDADES-3.4.md) · [novidades da 3.3](NOVIDADES-3.3.md) ·
[novidades da 3.2](NOVIDADES-3.2.md) ·
[novidades da 3.0](NOVIDADES-3.0.md) ·
[novidades da 2.0](NOVIDADES-2.0.md) (histórico) ·
[extensão](plus/README.md) · [servidor](server/deploy/LEIA-ME.md).
