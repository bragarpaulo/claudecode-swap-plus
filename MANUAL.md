# Manual do Swap Plus

O Swap Plus cuida das suas contas do Claude Code dentro do VS Code. Ele mostra quanto cada conta já usou e troca de
conta sozinho quando uma chega perto do limite.

Desde a versão 3.0 o Swap Plus tem só duas partes:

- a **extensão do VS Code**, instalada em cada computador;
- o **servidor Swap Plus**, no endereço **https://swap.assistentes.si**. Ele guarda e renova os logins de todas as
  contas, decide as trocas e atende todos os computadores. Tem um painel no navegador.

Não existe mais o motor (`swap-plus`) nem o modo local. O que mudou na 3.0: [NOVIDADES-3.0.md](NOVIDADES-3.0.md).

Neste manual:

1. [Começando](#começando): instalar, abrir o VS Code e entrar com Google
2. [Contas novas](#contas-novas)
3. [No dia a dia](#no-dia-a-dia)
4. [O painel do servidor](#o-painel-do-servidor)
5. [Se algo der errado](#se-algo-der-errado)
6. [Remover](#remover)

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
cartão **Servidor** (ou **Sua conta**, no primeiro cartão).

### Como saber se deu certo

- A barra do Swap Plus mostra o uso da conta: `│ ✉ … Sessão (5h): …% usado — renova … │`.
- Clique na barra e escolha **Configurações...**: o cartão **Servidor** mostra **Conectado**.
- No painel, em **Computadores**, aparece um quadradinho com o nome deste computador.

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

No VS Code, a opção **Adicionar conta...** (no fim da lista da barra) e o botão **+ Adicionar conta** (na tela de
Configurações, cartão **Contas**) não adicionam a conta: só mostram um aviso explicando estes dois jeitos.

### Quando o login de uma conta vence

O login de cada conta vence de vez em cerca de um mês. O painel avisa 3 dias antes, no topo e no cartão da conta. Entre
de novo com aquela conta, de um dos dois jeitos:

- **Pelo painel:** no cartão da conta, clique em **Entrar de novo** (também fica em **Ajustes desta conta**). O login
  da Claude abre já pedindo o e-mail daquela conta. Entre, copie o código, cole no painel e clique em **Concluir**. A
  conta continua com o mesmo número.
- **Pelo Claude Code:** num computador do administrador, digite `/login` e entre com aquela conta.

Pronto. O servidor fica com o login novo, e o aviso some.

O mesmo vale para uma conta que aparece como **Login morto**. Enquanto isso, a troca automática nunca vai para essa
conta.

---

## No dia a dia

### Como funciona, em poucas palavras

- **O servidor é o único que guarda e renova os logins.** Os computadores recebem só o **acesso** da conta que o
  servidor escolheu para cada um.
- **O acesso dura cerca de 8 horas.** O servidor renova sozinho, 2 horas antes de vencer. Você não faz nada.
- **O login vence de vez em cerca de um mês.** O painel avisa 3 dias antes. Veja
  [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence).
- **As regras de troca ficam no servidor** e valem para todos os computadores. Os avisos ("avisar em X%") e a
  exibição continuam sendo de cada computador.
- **A tela de login do Claude Code fica desligada** enquanto o computador está conectado (opção
  `claudeCode.disableLoginPrompt`). É de propósito: quem cuida do login é o Swap Plus. Ao desconectar, volta ao normal.
- **Windows (raro):** se o Claude Code do Windows usar o **Gerenciador de Credenciais do Windows**, o Swap Plus avisa
  e não grava o login.

### A tela de Configurações, no VS Code

Para abrir: clique na barra do Swap Plus e escolha **Configurações...** (a primeira opção da lista). Se o computador
ainda não está conectado, clique na barra e, no aviso, em **Configurações**. Outro jeito, que sempre funciona:
`Cmd/Ctrl + Shift + P` → **Swap Plus: Configurar trocas automáticas**.

A tela abre numa aba do VS Code, com estes cartões, de cima para baixo:

- **Swap Plus**: a chave que liga e desliga o Swap Plus e, em **Sua conta**, a conta Google com que este computador
  entrou (com o botão **Sair**) ou os botões **Entrar com Google** e **Colar código**;
- **Servidor**: a situação da conexão (**Conectado**, **Não conectado**, **Servidor fora do ar**, **Acesso
  recusado**), o endereço, o botão **Desconectar** e os **Computadores conectados**;
- **Troca automática**: a chave da troca automática (vale para todos os computadores) e o botão **Consultar o servidor
  agora**;
- **Regras**: para cada limite, a linha de aviso (só deste computador) e a linha de troca (do servidor, para todos).
  Só valem depois de **Salvar regras**;
- **Contas**: as contas do servidor, com o uso de cada uma, **Participa da troca automática**, **Usar regra padrão**,
  a prioridade, o apelido e o botão **Usar esta conta**. Mudanças aqui valem na hora;
- **Exibição**: o modo privado e o que aparece na barra;
- **Atualizações da extensão**: a versão instalada e o botão **Verificar agora**;
- **Histórico**: os últimos acontecimentos.

As regras de troca e os ajustes das contas são os mesmos do painel do servidor: mudar num lugar muda no outro.

### Trocar de conta à mão

Clique na barra do Swap Plus e escolha a conta. O ✓ marca a que está em uso. A troca vale em até 30 segundos. Pelo
painel também dá: **Computadores** → **Trocar para** → **Trocar**.

Se a conta bater o limite antes da troca, o Claude Code pode ficar parado esperando: mande uma mensagem (por exemplo,
"continue") e ele segue na conta nova.

### Desligar o Swap Plus por um tempo

Desligado, o Swap Plus não fala com o servidor, não troca de conta e não mexe no login. O Claude Code funciona
normalmente.

1. Clique na barra do Swap Plus.
2. Escolha **Desligar o Swap Plus** (a última opção da lista).
3. Para ligar de novo, clique na barra (ela mostra *Swap Plus desligado*) e, no aviso que aparece, em **Ligar Swap
   Plus**.

Também dá para desligar e ligar pela chave do cartão **Swap Plus**, o primeiro da tela de Configurações.

### Desconectar um computador

1. Clique na barra do Swap Plus → **Configurações...**.
2. No cartão **Servidor**, clique em **Desconectar**. (O botão **Sair**, em **Sua conta**, no primeiro cartão, faz o
   mesmo.)
3. Na pergunta que aparece, escolha:
   - **Desconectar**: o Swap Plus continua ligado, mostrando *não conectado*; ou
   - **Desconectar e desligar o Swap Plus**: o Claude Code fica normal, sem o Swap Plus.
4. O Claude Code fica com o acesso atual até ele vencer (algumas horas). Para voltar, faça de novo o
   [Entrar com Google](#3-entrar-com-google).

Para tirar **outro** computador (por exemplo, um que você não usa mais): painel → **Computadores** → **Desconectar**,
no quadradinho dele.

### Atualizar o Swap Plus

A extensão se atualiza sozinha, dentro do VS Code: ao abrir, ao fechar e a cada 2 dias. Para conferir na hora: tela de
Configurações → cartão **Atualizações da extensão** → **Verificar agora**.

Para forçar a versão mais nova:

1. Rode de novo o comando de instalação do seu sistema (veja [Instalar](#1-instalar)).
2. Feche e abra o VS Code.

A conexão com o servidor continua como está.

### Sem Google: código de conexão

Use só se o **Entrar com Google** não funcionar.

1. No painel, abra **Computadores** e desça até **Conectar um computador**.
2. Clique em **Gerar código de conexão**.
3. Clique em **Copiar código**. O código vale 10 minutos e serve para um computador só.
4. No VS Code, clique na barra do Swap Plus e, no aviso que aparece, em **Colar código**. (O mesmo botão fica na tela
   de Configurações, no cartão **Servidor**.)
5. Cole o código e aperte Enter.
6. Confirme o nome do computador e aperte Enter. Daí em diante é igual à conexão com Google.

### Esconder os e-mails (modo privado)

Clique na barra → **Configurações...** e, no cartão **Exibição**, marque **Modo privado**. Ele mostra só "Conta 1",
"Conta 2"… sem e-mail. Ele muda só o que o Swap Plus mostra neste computador. Não é uma trava: o painel de conta do
próprio Claude Code e o comando `/status` continuam mostrando o e-mail da conta em uso.

---

## O painel do servidor

O painel é a tela do servidor no navegador. Nele você vê todas as contas e configura tudo: contas, computadores,
usuários e regras de troca. As regras e os ajustes das contas também aparecem na tela de Configurações do VS Code
(veja [A tela de Configurações, no VS Code](#a-tela-de-configurações-no-vs-code)); adicionar contas, liberar usuários
e o kit de recuperação ficam só no painel.

### Entrar no painel

1. No navegador, abra **https://swap.assistentes.si**.
2. Clique em **Entrar com Google**.
3. Entre com a conta do administrador (a conta Google definida no servidor).

**Só o administrador entra no painel.** Os usuários liberados (veja [Usuários](#usuários)) servem só para conectar
computadores.

### O que tem no painel

O menu tem três itens:

- **[Contas](#contas)**: as contas Claude, o uso de cada uma e as regras de troca;
- **[Computadores](#computadores)**: os computadores conectados e a conta Claude de cada um;
- **[Usuários](#usuários)**: as contas Google que podem conectar computadores.

No topo ficam:

- **Histórico**: os últimos acontecimentos, com data e computador (trocas de conta, logins recebidos, avisos e
  mudanças de regra);
- **Atualizar**: busca os dados na hora;
- **Minha conta**: seu e-mail, **Sair**, o kit de recuperação e as sessões abertas (veja [Minha conta](#minha-conta));
- os **avisos**: por exemplo, um login que vence em menos de 3 dias ou uma conta com login morto.

O painel se atualiza sozinho a cada 30 segundos. Funciona também no celular.

### Contas

Um cartão para cada conta Claude. No alto fica o botão **+ Adicionar conta** (veja
[Pelo painel](#pelo-painel-não-precisa-de-computador)).

**A ordem é a fila da troca.** Primeiro vêm as contas que participam da troca, na ordem em que o servidor vai usá-las:
**1º na fila**, **2º na fila**… Vem antes a conta cujo limite semanal renova antes (em empate, a menos usada). As
contas que não participam ficam embaixo, no grupo **Fora da troca (N)**. Clique nele para abrir.

Em cada cartão:

- número, apelido, e-mail e plano;
- **Situação**: ok, **Login morto** ou fora da troca;
- barras de uso: sessão de 5 horas, semanal e por modelo (por exemplo, Fable). Verde: longe da linha de troca;
  amarelo: chegando perto; vermelho: na linha (o servidor passa o computador para outra conta);
- **Computadores nela** (os que estão na conta agora) e **Computadores permitidos**;
- **Acesso atual**: até quando vale. O servidor renova sozinho;
- **Login vale até**: quando o login vence. Faltando menos de 3 dias (ou com login morto), aparece um aviso com o botão
  **Entrar de novo**.

O que dá para fazer em cada conta:

- **Participa da troca**: ligado, a troca automática usa a conta. Desligado, a conta desce para **Fora da troca**.
  Vale na hora.
- **Ajustes desta conta**:
  - **Quando trocar desta conta**: **Usar regra padrão** (as regras de troca gerais) ou linhas próprias para a sessão
    de 5 horas, o semanal e o modelo. Cada mudança aqui vale na hora;
  - **Apelido**, **Prioridade** (só vale na estratégia **Por prioridade**; número maior é usado primeiro) e
    **Computadores permitidos**: **Todos** (inclusive os que conectarem depois) ou **Só estes** (marque um ou mais).
    Um computador só recebe as contas que o permitem, na troca automática e na troca manual. Depois de mudar, clique
    em **Salvar ajustes**;
  - **Entrar de novo**: renova o login da conta (veja
    [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence)).
- **Remover conta**: o painel pede confirmação. O servidor apaga o login guardado da conta.

#### Regras de troca

Ficam em **Contas**, abaixo da lista. Valem para **todos** os computadores conectados. A troca automática liga e
desliga na hora; as outras regras só mudam quando você clicar em **Salvar regras**.

- **Troca automática:** ligada ou desligada. Vale na hora. Desligada, nenhum computador troca de conta sozinho. A
  troca manual continua funcionando.
- **Computadores:** **Separados** (o padrão: cada computador numa conta, cada um com a sua sessão de 5 horas) ou
  **Juntos** (todos na mesma conta, a do topo da fila, e trocam juntos). Um computador só usa as contas permitidas
  para ele.
- **Quando trocar de conta:** porcentagem da sessão de 5 horas, do limite semanal e do limite de um modelo
  (por exemplo, Fable).
- **Quando o limite de um modelo acaba:** **Seguir na mesma conta** (com outro modelo, como o Opus) ou **Trocar de
  conta**. Nos dois casos, quando o Fable acaba o Swap Plus muda sozinho o modelo padrão do Claude Code de cada
  computador para o **Opus 5.5** (as conversas novas já abrem nele) e volta para o Fable quando ele renova. Uma
  conversa que já estava aberta não muda sozinha: nela, escolha **Opus 5.5** no seletor de modelo e mande
  "continue". Com **Trocar de conta**, enquanto alguma conta tiver Fable a conversa aberta nem para.
- **Para qual conta ir (estratégia):** **Aproveitar ao máximo** (o padrão), **Mais folga** ou **Por prioridade**, e o
  **Modelo preferido**.
- **Ajustes finos:** **Horas para "cota prestes a zerar"**, **Intervalo mínimo entre trocas** e **Margem da conta de
  destino**.
- Botões: **Voltar ao padrão** (só preenche o formulário; ainda precisa salvar), **Desfazer** e **Salvar regras**.

### Computadores

Um quadradinho para cada computador conectado. Em cada um:

- nome, sistema, usuário (a conta Google com que ele entrou) e último contato (**ativo agora** ou parado);
- **Conta Claude agora**: a conta logada nele, com número, e-mail e barras pequenas de uso.

O que dá para fazer em cada computador:

- **Renomear**: clique em **Renomear**, digite o nome novo e clique em **Salvar**.
- **Trocar de conta**: em **Trocar para**, escolha uma conta (ou **Melhor conta**, e o servidor escolhe) e clique em
  **Trocar**. Vale em até 30 segundos. Só aparecem as contas permitidas para esse computador.
- **Desconectar**: o painel pede confirmação. O computador para de receber o login na hora.

Embaixo fica o bloco **Conectar um computador**: o passo a passo do VS Code e o botão **Gerar código de conexão**
(veja [Sem Google: código de conexão](#sem-google-código-de-conexão)).

### Usuários

Os usuários são as contas Google que podem conectar computadores pelo VS Code (**Entrar com Google**). São as suas
contas Google: por exemplo, uma para cada computador. **Eles não entram no painel**: o painel é só do administrador.

A tabela mostra, para cada um: **E-mail**; **Papel** (**Administrador**, a conta definida no servidor, que não sai da
lista; ou **Usuário**); **Computadores** (quantos ele conectou e quais); **Desde** (quando foi liberado).

**Liberar um usuário:**

1. Em **Liberar um usuário (conta Google)**, digite a conta (por exemplo, `voce@example.com`).
2. Clique em **Liberar**.
3. No computador que vai usar essa conta, siga [Começando](#começando).

A mesma conta Google conecta quantos computadores quiser. Quais contas Claude cada computador pode usar se escolhe
em **Contas** → **Ajustes desta conta** → **Computadores permitidos**.

Os computadores conectados com um usuário (e não com o administrador) usam as contas do servidor, mas não mandam
logins para ele.

**Tirar um usuário:** clique em **Tirar** na linha dele e confirme em **Tirar usuário**. Ele não conecta mais
computadores novos. Os computadores que ele já conectou continuam funcionando: para cortar, desconecte-os em
**Computadores**.

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

## Se algo der errado

| Problema | O que fazer |
| --- | --- |
| Windows: o comando de instalação dá erro de "execução de scripts" | No PowerShell, rode `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`. Depois rode o comando de instalação de novo. |
| O comando de instalação diz **VS Code não encontrado** | Instale o VS Code ([code.visualstudio.com](https://code.visualstudio.com)) e rode o comando de novo. No Mac, o VS Code precisa estar na pasta **Aplicativos** (se ele ficou em Downloads, arraste para Aplicativos). |
| O comando de instalação diz **o comando swap-plus existe (…), mas … não mexi nele** | É o motor antigo, instalado de outro jeito (sem o `uv`), ou o `uv` não foi encontrado. O Swap Plus 3.0 não usa esse comando: pode ignorar ou apagar o arquivo indicado. |
| O **Histórico** da tela de Configurações mostra **Não consegui remover o motor antigo (swap-plus)** | A extensão tenta de novo no dia seguinte. Para resolver já, rode o comando de instalação de novo, ou remova à mão (veja [Remover](#remover)). O Swap Plus 3.0 funciona mesmo com o motor antigo instalado. |
| A barra do Swap Plus não aparece depois de instalar | Feche e abra o VS Code. Ou: `Cmd/Ctrl + Shift + P` → **Developer: Reload Window**. |
| O Swap Plus não aparece numa pasta | O VS Code abriu a pasta no **Modo Restrito** (pasta não confiável). Clique no aviso do topo para confiar na pasta, ou abra outra. |
| A barra mostra **não conectado — clique para entrar com Google** | Este computador ainda não entrou no servidor. Faça o [Entrar com Google](#3-entrar-com-google). |
| Aparece **a conta Google … não está liberada neste servidor** | O administrador precisa liberar essa conta no painel (**Usuários** → **Liberar**). Depois, entre de novo. Entrou com a conta errada? Clique em **Entrar com outra conta** no aviso. |
| Aparece **não consegui abrir o navegador** | Clique em **Copiar link** no aviso, cole o link no navegador e entre com a sua conta Google. |
| Aparece **o tempo para entrar com o Google acabou** | O link vale 10 minutos. Clique em **Entrar com Google** de novo. |
| Aparece **o servidor … não está com o login do Google ligado** | Gere um código de conexão no painel, clique em **Colar código de conexão** no aviso e cole o código (veja [Sem Google: código de conexão](#sem-google-código-de-conexão)). |
| Aparece **o código não foi aceito** | O código vale 10 minutos e uma vez só. Gere outro no painel e cole de novo. |
| O painel diz que **o painel é só do administrador** | É normal: só o administrador entra no painel. Os usuários liberados servem só para conectar computadores. Clique em **Entrar com outra conta** e use a do administrador. |
| O painel pede para **entrar de novo com Google** ao mostrar o kit de recuperação | Por segurança, o kit só aparece até 15 minutos depois de entrar. Clique em **Entrar de novo com Google**. |
| O painel avisa que **o login de uma conta vence**, ou uma conta aparece como **Login morto** | Clique em **Entrar de novo** no cartão da conta, ou faça `/login` com ela no Claude Code de um computador do administrador. Veja [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence). A troca automática nunca vai para uma conta com login morto. |
| Ao adicionar uma conta pelo painel, aparece **código incompleto**, **esse código não é deste login** ou **este login venceu** | Clique em **+ Adicionar conta** (ou **Entrar de novo**) outra vez, entre com a conta e copie o código **inteiro** (ele tem um `#` no meio). O link vale 10 minutos e serve uma vez só. |
| Ao **Entrar de novo**, o painel diz que você entrou com **outro e-mail** | A página da Claude estava em outra conta. A conta pedida não mudou. Saia da outra conta na página da Claude (ou use uma janela anônima) e clique em **Entrar de novo** outra vez. |
| Fiz `/login` no Claude Code e o computador voltou para outra conta | Este computador não é do administrador: só os computadores do administrador mandam logins ao servidor. Adicione a conta pelo painel (**Contas** → **+ Adicionar conta**). |
| O Claude Code não abre mais a tela de login | É de propósito: conectado ao servidor, quem cuida do login é o Swap Plus. Para adicionar uma conta, use o painel (ou `/login` num computador do administrador). Ao desconectar, volta ao normal. |
| A barra mostra **nenhuma conta no servidor ainda** | Adicione uma conta: no painel (**Contas** → **+ Adicionar conta**) ou com `/login` num computador do administrador. |
| A barra mostra **sem conta atribuída — clique para escolher** | O servidor ainda não escolheu uma conta para este computador. Clique na barra e escolha uma. Se a conta que você quer não vale para este computador, veja a linha de baixo. |
| Em **Computadores** → **Trocar para**, uma conta não aparece para um computador (ou nenhuma aparece) | Essa conta não permite esse computador. Em **Contas**, abra **Ajustes desta conta** da conta. Em **Computadores permitidos**, escolha **Todos** ou marque o computador. Clique em **Salvar ajustes**. |
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

Mais detalhes: [novidades da 3.0](NOVIDADES-3.0.md) · [novidades da 2.0](NOVIDADES-2.0.md) (histórico) ·
[extensão](plus/README.md) · [servidor](server/deploy/LEIA-ME.md).
