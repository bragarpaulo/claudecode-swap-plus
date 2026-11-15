# Manual do Swap Plus

O Swap Plus cuida das suas contas do Claude Code dentro do VS Code. Ele mostra quanto cada conta já usou e troca de
conta sozinho quando uma chega perto do limite.

A partir da versão 2.0 existe o **servidor Swap Plus**, no endereço **https://swap.assistentes.si**. Ele guarda os
logins de todas as contas e atende todos os computadores. É o jeito recomendado.

O que mudou na 2.0: [NOVIDADES-2.0.md](NOVIDADES-2.0.md).

Neste manual:

1. [Começando com o servidor (2.0)](#começando-com-o-servidor-20)
2. [O painel do servidor](#o-painel-do-servidor)
3. [Se algo der errado](#se-algo-der-errado)
4. [Modo local (sem servidor)](#modo-local-sem-servidor) — o jeito antigo, com arquivo de contas

---

## Começando com o servidor (2.0)

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

**A "barra do Swap Plus"** é a linha de baixo da janela do VS Code (o rodapé), no canto esquerdo. Ela começa com um
envelope: `│ ✉ Sessão (5h): …`. Clicar nela abre a lista de contas e as **Configurações**.

**A "paleta de comandos"** abre com `Cmd + Shift + P` (Mac) ou `Ctrl + Shift + P` (Windows). Nela você digita o nome
de um comando e aperta Enter.

### No Mac

1. Abra o **Terminal**: aperte `Cmd + Espaço`, digite `Terminal` e aperte Enter.
2. Cole este comando e aperte Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
   ```

3. Espere aparecer **`==> Pronto`**.
4. Feche e abra o VS Code de novo.
5. No VS Code, aperte `Cmd + Shift + P`, digite **Swap Plus: Conectar ao servidor** e aperte Enter.
6. Escolha **Entrar com Google**.
7. Confirme o nome do computador e aperte Enter. É com esse nome que ele aparece no painel.
8. O navegador abre. Entre com a sua conta Google liberada.
9. Volte ao VS Code. Em poucos segundos aparece **conectado ao servidor**.
10. No computador do administrador, responda à pergunta da primeira conexão (logo abaixo).

### No Windows

1. Abra o **PowerShell**: menu Iniciar, digite `PowerShell` e abra o **Windows PowerShell**
   (não precisa ser "como administrador").
2. Cole este comando e aperte Enter:

   ```powershell
   irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex
   ```

3. Espere aparecer **`==> Pronto`**.
4. Feche e abra o VS Code de novo.
5. No VS Code, aperte `Ctrl + Shift + P`, digite **Swap Plus: Conectar ao servidor** e aperte Enter.
6. Escolha **Entrar com Google**.
7. Confirme o nome do computador e aperte Enter. É com esse nome que ele aparece no painel.
8. O navegador abre. Entre com a sua conta Google liberada.
9. Volte ao VS Code. Em poucos segundos aparece **conectado ao servidor**.
10. No computador do administrador, responda à pergunta da primeira conexão (logo abaixo).

> O passo 2 deu erro de "execução de scripts"? Veja [Se algo der errado](#se-algo-der-errado).

### Na primeira conexão: enviar os logins (só no computador do administrador)

**Enviar os logins deste computador para o servidor?**

Esta pergunta só aparece **nos computadores do administrador**, uma vez só para cada servidor, e só se o computador já
tem contas guardadas no Swap Plus. Escolha **Sim** (é o primeiro botão).

- O servidor recebe as contas vivas que ele ainda não tem.
- Cada conta fica com o mesmo número de antes, quando esse número está livre no servidor.
- As contas que o servidor já tem são puladas.
- No fim aparece um resumo: quantas entraram e quais não entraram, com o motivo.
- Dá para fazer de novo depois: barra do Swap Plus → **Configurações…** → **Servidor** →
  **Enviar os logins deste computador**.

Nos outros computadores a pergunta não aparece, nem o botão **Enviar os logins deste computador**: eles usam as
contas do servidor e não enviam logins.

As regras de troca não entram na conexão: no modo servidor valem as regras do servidor, para **todos** os
computadores, e elas só mudam pelo painel ou pela tela de configurações.

### Como saber se deu certo

- A barra do Swap Plus mostra uma nuvem depois do envelope: `│ ✉ ☁ Sessão (5h): … │`.
- Em **Configurações → Servidor** aparece **Conectado**.
- No painel, em **Computadores**, aparece um quadradinho com o nome deste computador.

### Como funciona, em poucas palavras

- **O servidor é o único que guarda e renova os logins.** Os computadores recebem só o **acesso** da conta que o
  servidor escolheu para cada um.
- **O acesso dura cerca de 8 horas.** O servidor renova sozinho, 2 horas antes de vencer. Você não faz nada.
- **O login vence de vez em cerca de um mês.** O painel avisa 3 dias antes. Veja
  [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence).
- **As regras de troca ficam no servidor** e valem para todos os computadores. Os avisos ("avisar em X%") e a
  exibição continuam sendo de cada computador.
- **A tela de login do Claude Code fica desligada** enquanto o computador está conectado ao servidor (opção
  `claudeCode.disableLoginPrompt`). É de propósito: quem cuida do login é o Swap Plus. Ao desconectar, volta ao
  normal. Para entrar com uma conta, use o comando `/login` do Claude Code.
- **Windows (raro):** se o Claude Code do Windows usar o **Gerenciador de Credenciais do Windows**, o Swap Plus avisa
  e não grava o login.

### Adicionar uma conta nova

Há dois jeitos. Nos dois, a conta aparece no painel, em **Contas**.

**Pelo painel** (não precisa de computador): **Contas** → **+ Adicionar conta**. Passo a passo em
[Adicionar uma conta pelo painel](#adicionar-uma-conta-pelo-painel).

**Pelo Claude Code, num computador conectado:**

1. No Claude Code, digite `/login` e entre com a conta nova. **Não saia (logout) da conta anterior.**
2. Em até 30 segundos o Swap Plus manda o login novo ao servidor.
3. A conta aparece no painel, em **Contas**.

O servidor pode deixar este computador em outra conta. O aviso que aparece tem um botão para usar a conta em que você
acabou de entrar.

### Quando o login de uma conta vence

O login de cada conta vence de vez em cerca de um mês. O painel avisa 3 dias antes, no topo e no cartão da conta.
Entre de novo com aquela conta, de um dos dois jeitos:

- **Pelo painel:** **Contas** → **+ Adicionar conta** → entre com aquela conta (veja
  [Adicionar uma conta pelo painel](#adicionar-uma-conta-pelo-painel)). A conta continua com o mesmo número.
- **Pelo Claude Code:** em **qualquer** computador conectado ao servidor, digite `/login` e entre com aquela conta.

Pronto. O servidor fica com o login novo, e o aviso some.

O mesmo vale para uma conta que aparece como **Login morto**. Enquanto isso, a troca automática nunca vai para essa
conta.

### Importante: não misture com o modo antigo

**Não use o Swap Plus antigo (modo local) para trocar de conta em contas que já estão no servidor.** Também não leve
essas contas por arquivo (exportar e importar). O modo local renovaria o login por conta própria, e a conta morreria
no servidor. Conecte todos os computadores ao servidor.

### Desligar o Swap Plus por um tempo

Desligado, o Swap Plus não fala com o servidor, não troca de conta e não mexe no login. O Claude Code funciona
normalmente.

1. Clique na barra do Swap Plus.
2. Escolha **Desligar o Swap Plus**.
3. Para ligar de novo, clique na barra (ela mostra *Swap Plus desligado*).

Também funciona pela paleta de comandos: **Swap Plus: Ligar/desligar o Swap Plus (tudo)**.

### Desconectar um computador

1. Na paleta de comandos, digite **Swap Plus: Desconectar do servidor** e aperte Enter.
2. Escolha uma opção:
   - **Desconectar e desligar o Swap Plus** — a mais segura;
   - **Desconectar e usar o modo local** — só para contas que **não** estão no servidor.
3. O Claude Code fica com o acesso atual até ele vencer (algumas horas). Depois, entre de novo com uma conta.

Para tirar **outro** computador (por exemplo, um que você não usa mais): painel → **Computadores** → **Desconectar**,
no quadradinho dele.

### Atualizar o Swap Plus

A extensão se atualiza sozinha, dentro do VS Code. Para forçar a atualização:

1. Rode de novo o comando de instalação do seu sistema (passo 2 do [Mac](#no-mac) ou do [Windows](#no-windows)).
2. Feche e abra o VS Code.

Suas contas e sua conexão com o servidor continuam como estão.

### Sem Google: código de conexão

Use só se o **Entrar com Google** não funcionar.

1. No painel, abra **Computadores** e desça até **Conectar um computador**.
2. Clique em **Gerar código de conexão**.
3. Clique em **Copiar código**. O código vale 10 minutos e serve para um computador só.
4. No VS Code, paleta de comandos → **Swap Plus: Conectar ao servidor** → **Colar código de conexão**.
5. Cole o código e aperte Enter.
6. Confirme o nome do computador e aperte Enter. Daí em diante é igual à conexão com Google.

---

## O painel do servidor

O painel é a tela do servidor no navegador. Nele você vê todas as contas e configura tudo. O VS Code de cada
computador só obedece.

### Entrar no painel

1. No navegador, abra **https://swap.assistentes.si**.
2. Clique em **Entrar com Google**.
3. Entre com a conta do administrador (a conta Google definida no servidor).

**Só o administrador entra no painel.** Os usuários liberados (veja [Usuários](#usuários)) servem só para conectar
computadores.

### O que tem no painel

O menu tem três itens:

- **[Contas](#contas)** — as contas Claude, o uso de cada uma e as regras de troca;
- **[Computadores](#computadores)** — os computadores conectados e a conta Claude de cada um;
- **[Usuários](#usuários)** — as contas Google que podem conectar computadores.

No topo ficam:

- **Histórico** — os últimos 100 acontecimentos, com data e computador: trocas de conta, logins recebidos, avisos e
  mudanças de regra;
- **Atualizar** — busca os dados na hora;
- **Minha conta** — seu e-mail, **Sair**, o kit de recuperação e as sessões abertas (veja
  [Minha conta](#minha-conta));
- os **avisos** — por exemplo, um login que vence em menos de 3 dias ou uma conta com login morto.

O painel se atualiza sozinho a cada 30 segundos. Funciona também no celular.

### Contas

Um cartão para cada conta Claude. No alto fica o botão **+ Adicionar conta** (veja
[Adicionar uma conta pelo painel](#adicionar-uma-conta-pelo-painel)).

**A ordem é a fila da troca.** Primeiro vêm as contas que participam da troca, na ordem em que o servidor vai usá-las:
**1º na fila**, **2º na fila**… Vem antes a conta cujo limite semanal renova antes (em empate, a menos usada). As
contas que não participam ficam embaixo, no grupo **Fora da troca (N)**. Clique nele para abrir.

Em cada cartão:

- número, apelido, e-mail e plano;
- **Situação**: ok, **Login morto** ou fora da troca;
- barras de uso: sessão de 5 horas, semanal e por modelo (por exemplo, Fable);
  - verde: longe da linha de troca;
  - amarelo: chegando perto;
  - vermelho: na linha (o servidor passa o computador para outra conta);
- os computadores que estão na conta agora e os **Computadores permitidos**;
- **Acesso atual**: até quando vale. O servidor renova sozinho;
- **Login vale até**: quando o login vence. Aparece um aviso quando faltam menos de 3 dias.

O que dá para fazer em cada conta:

- **Participa da troca** — ligado, a troca automática usa a conta. Desligado, a conta desce para **Fora da troca**.
  Vale na hora.
- **Ajustes desta conta** — depois de mudar, clique em **Salvar ajustes**:
  - **Apelido**;
  - **Linha própria para a sessão de 5 horas** (no lugar da linha das regras);
  - **Prioridade** (só vale na estratégia **Por prioridade**; número maior é usado primeiro);
  - **Computadores permitidos**: **Todos** (inclusive os que conectarem depois) ou **Só estes** (marque um ou mais).
    Um computador só recebe as contas que o permitem, na troca automática e na troca manual.
- **Remover conta** — o painel pede confirmação. O servidor apaga o login guardado da conta.

#### Adicionar uma conta pelo painel

Use a conta Claude da assinatura. Não precisa de computador.

1. Em **Contas**, clique em **+ Adicionar conta**.
2. Clique em **Abrir o login da Claude**. O login da Claude abre numa aba nova.
3. Entre com a conta Claude que você quer adicionar e autorize.
4. No fim, a página mostra um código. Copie o código inteiro.
5. Volte ao painel, cole o código em **Código da Claude** e clique em **Adicionar**.
6. Pronto. A conta aparece na lista. O login dela fica guardado só no servidor: a conta passa a ser do servidor.

O link vale 10 minutos e serve uma vez só. Se vencer, clique em **+ Adicionar conta** de novo.

Se a conta já está no servidor, ela continua com o mesmo número e só ganha o login novo. Use isso também para uma
conta com **Login morto** ou com o login perto de vencer.

#### Regras de troca

Ficam em **Contas**, abaixo da lista. As regras valem para **todos** os computadores conectados. Nada muda até você
clicar em **Salvar regras**.

- **Troca automática:** ligada ou desligada. Desligada, nenhum computador troca de conta sozinho. A troca manual (em
  **Computadores**) continua funcionando.
- **Quando trocar de conta:** porcentagem da sessão de 5 horas, do limite semanal e do limite de um modelo
  (por exemplo, Fable).
- **Quando o limite de um modelo acaba:** seguir na mesma conta (com outro modelo, como o Opus) ou trocar de conta.
- **Para qual conta ir:** **Aproveitar ao máximo** (o padrão), **Mais folga** ou **Por prioridade**, e o modelo
  preferido.
- **Ajustes finos:** horas para "cota prestes a zerar", intervalo mínimo entre trocas e margem da conta de destino.
- Botões: **Voltar ao padrão**, **Desfazer** e **Salvar regras**.

### Computadores

Um quadradinho para cada computador conectado. Em cada um:

- nome, sistema, usuário (a conta Google com que ele entrou) e último contato (**ativo agora** ou parado);
- a **conta Claude logada nele agora**: número, e-mail e barras pequenas de uso.

O que dá para fazer em cada computador:

- **Renomear** — digite o nome novo e clique em **Salvar**.
- **Trocar de conta** — em **Trocar para**, escolha uma conta (ou **Melhor conta**, e o servidor escolhe) e clique em
  **Trocar**. Vale em até 30 segundos. Só aparecem as contas permitidas para esse computador (veja
  **Computadores permitidos**, em [Contas](#contas)).
- **Desconectar** — o painel pede confirmação. O computador para de receber o login na hora.

Embaixo fica o bloco **Conectar um computador**: o passo a passo do VS Code e o botão **Gerar código de conexão**
(veja [Sem Google: código de conexão](#sem-google-código-de-conexão)).

### Usuários

Os usuários são as contas Google que podem conectar computadores pelo VS Code (**Entrar com Google**). São as suas
contas Google: por exemplo, uma para cada computador. **Eles não entram no painel**: o painel é só do administrador.

A tabela mostra, para cada um:

- **E-mail**;
- **Papel**: **Administrador** (a conta definida no servidor; não sai da lista e não muda pelo painel) ou **Usuário**;
- **Computadores**: quantos ele conectou e quais;
- **Desde**: quando foi liberado.

**Liberar um usuário:**

1. Em **Liberar um usuário (conta Google)**, digite a conta (por exemplo, `voce.trabalho@gmail.com`).
2. Clique em **Liberar**.
3. No computador que vai usar essa conta, siga [Começando com o servidor](#começando-com-o-servidor-20).

A mesma conta Google conecta quantos computadores quiser. Quais contas Claude cada computador pode usar se escolhe
em **Contas** → **Ajustes desta conta** → **Computadores permitidos**.

**Tirar um usuário:** clique em **Tirar** na linha dele e confirme. Ele não conecta mais computadores novos. Os
computadores que ele já conectou continuam funcionando: para cortar, desconecte-os em **Computadores**.

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
4. Clique em **Copiar chave mestra** e guarde num lugar seguro fora do servidor (gerenciador de senhas ou um arquivo
   no seu computador).
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
| A barra do Swap Plus não aparece depois de instalar | Feche e abra o VS Code. Ou: paleta de comandos → **Developer: Reload Window**. |
| O Swap Plus não aparece numa pasta | O VS Code abriu a pasta no **Modo Restrito** (pasta não confiável). Clique no aviso do topo para confiar na pasta, ou abra outra. |
| Aparece **a conta Google … não está liberada neste servidor** | O administrador precisa liberar essa conta no painel (**Usuários** → **Liberar**). Depois, conecte de novo. Entrou com a conta errada? Clique em **Entrar com outra conta** no aviso. |
| Aparece **não consegui abrir o navegador** | Clique em **Copiar link** no aviso, cole o link no navegador e entre com a sua conta Google. |
| Aparece **o tempo para entrar com o Google acabou** | O link vale 10 minutos. Conecte de novo. |
| Aparece **o servidor não está com o login do Google ligado** | Use o código de conexão (veja [Sem Google: código de conexão](#sem-google-código-de-conexão)). |
| Aparece **o código não foi aceito** | O código vale 10 minutos e uma vez só. Gere outro no painel e cole de novo. |
| O painel diz que **o painel é só do administrador** | É normal: só o administrador entra no painel. Os usuários liberados servem só para conectar computadores. Clique em **Entrar com outra conta** e use a do administrador. |
| O painel pede para **entrar de novo com Google** ao mostrar o kit de recuperação (em **Minha conta**) | Por segurança, o kit só aparece até 15 minutos depois de entrar. Clique em **Entrar de novo com Google**. |
| O painel avisa que **o login de uma conta vence** | Entre de novo com essa conta: no painel (**Contas** → **+ Adicionar conta**) ou no Claude Code (`/login`) em qualquer computador conectado. Veja [Quando o login de uma conta vence](#quando-o-login-de-uma-conta-vence). |
| Uma conta aparece como **Login morto** | Mesma coisa: entre de novo com ela (**Contas** → **+ Adicionar conta**, ou `/login` no Claude Code de um computador conectado). A troca automática nunca vai para uma conta com login morto. |
| Ao adicionar uma conta pelo painel, aparece **código incompleto**, **esse código não é deste login** ou **este login venceu** | Clique em **+ Adicionar conta** de novo, entre com a conta e copie o código **inteiro** (ele tem um `#` no meio). O link vale 10 minutos e serve uma vez só. Veja [Adicionar uma conta pelo painel](#adicionar-uma-conta-pelo-painel). |
| O Claude Code não abre mais a tela de login | É de propósito: conectado ao servidor, quem cuida do login é o Swap Plus. Para entrar com uma conta, digite `/login` no Claude Code. Ao desconectar, volta ao normal. |
| O servidor ainda não tem conta para este computador | Adicione uma conta: no painel (**Contas** → **+ Adicionar conta**) ou no Claude Code (`/login`), que manda o login ao servidor. Ou use **Enviar os logins deste computador** (Configurações → Servidor). Se o servidor já tem contas, veja a linha de baixo. |
| Em **Computadores** → **Trocar para**, uma conta não aparece para um computador (ou nenhuma aparece) | Essa conta não permite esse computador. Em **Contas**, abra **Ajustes desta conta** da conta. Em **Computadores permitidos**, escolha **Todos** ou marque o computador. Clique em **Salvar ajustes**. |
| A barra mostra **servidor fora do ar** | Espere. Enquanto isso o Swap Plus não mexe no login, e o Claude Code segue com o acesso que tem (algumas horas). O Swap Plus tenta de novo a cada 30 segundos. Se demorar, avise quem cuida do servidor. Se o acesso vencer antes, entre com uma conta pelo `/login`. |
| A barra mostra **servidor recusou este computador** | Este computador foi desconectado (pelo painel). Conecte de novo: **Swap Plus: Conectar ao servidor** → **Entrar com Google**. |
| Aparece **login do Claude Code recusado pelo servidor** | O servidor não aceitou o login que está no Claude Code (o aviso diz o motivo). Para seguir com a conta do servidor: clique na barra → **Usar a conta do servidor**. |
| A barra mostra **servidor: o endereço mudou** | O endereço do servidor nas configurações foi trocado. Conecte de novo (**Entrar com Google**). |
| Aparece **o certificado do servidor não é o esperado** | O servidor foi reinstalado. Conecte de novo. |
| Windows: a barra mostra **o Swap Plus não consegue trocar o login aqui** | O Claude Code deste Windows guarda o login no **Gerenciador de Credenciais do Windows** (é raro). O Swap Plus avisa e não grava nada. Se alguém definiu a variável `CLAUDE_CODE_FORCE_WINDOWS_CREDMAN`, apague-a e reabra o VS Code. |
| Aviso sobre `CLAUDE_CODE_OAUTH_TOKEN` ou `ANTHROPIC_API_KEY` | O Claude Code está usando essa variável no lugar do login, e a troca de conta não vale. Apague a variável e reabra o VS Code. |
| A extensão não se atualiza sozinha | Rode o comando de instalação de novo e reabra o VS Code. As contas e a conexão continuam como estão. |
| Quero parar tudo por um tempo | Desligue o Swap Plus (veja [Desligar o Swap Plus por um tempo](#desligar-o-swap-plus-por-um-tempo)). |

---

## Modo local (sem servidor)

O modo local é o jeito de antes da versão 2.0. Cada computador guarda as próprias contas, e para levá-las a outro
computador você usa um arquivo.

> **Atenção:** não use o modo local para trocar de conta em contas que já estão no servidor. Veja
> [Importante: não misture com o modo antigo](#importante-não-misture-com-o-modo-antigo).

Como levar suas contas do Claude Code para outro computador (Mac ou Windows) sem precisar logar de novo em cada uma,
com as mesmas regras de troca, avisos e ajustes. São três etapas:

1. **No computador principal:** exportar as contas.
2. **No outro computador:** instalar o Swap Plus.
3. **No outro computador:** importar as contas e conferir.

Leva uns 10 minutos.

### Antes de começar (modo local)

**No computador principal**, o Swap Plus já precisa estar funcionando, com as contas cadastradas.

**No outro computador** você vai precisar de:

- internet;
- o **VS Code** instalado ([code.visualstudio.com](https://code.visualstudio.com));
- a extensão **Claude Code** instalada no VS Code (aba Extensões → procure "Claude Code" → Instalar).
  Não precisa logar nela; as contas vêm no arquivo.

Não precisa ser administrador da máquina.

### Etapa 1 — No computador principal: exportar as contas

1. Clique na barra do Swap Plus, embaixo à esquerda do VS Code.
2. Na lista que abre lá em cima, escolha **Configurações…** (a primeira opção).
3. Desça até **Exportar e importar contas**.
4. Escolha um dos botões:

   | Botão | Quando usar | Como o outro computador mostra as contas |
   | --- | --- | --- |
   | **Export Other** | o outro computador fica à vista de outras pessoas | só "Conta 1", "Conta 2"… sem e-mail (modo privado) |
   | **Export Me** | o computador é só seu | com os e-mails, igual a este |

5. Escolha onde salvar. O padrão é a Mesa (Desktop), com o nome `swap-plus-other.cswap` ou `swap-plus-me.cswap`.
6. Leve o arquivo para o outro computador por **pen drive, AirDrop ou cabo**.

> **Cuidado com o arquivo.** Ele tem as credenciais de todas as contas, em texto puro. Não mande por e-mail,
> WhatsApp ou nuvem. Na Etapa 3 você vai apagá-lo.

**O que vai no arquivo:** as contas e todas as configurações do Swap Plus — regras de troca (sessão, semanal,
Fable), avisos, estratégia, troca automática ligada ou desligada, exibição e os ajustes de cada conta (se
participa da rotação, linha própria e prioridade).

**O que não vai:** o histórico e o caminho do executável, que são de cada máquina.

### Etapa 2 — No outro computador: instalar o Swap Plus

Um comando instala tudo: o `uv` (se faltar), o motor (`swap-plus`) e a extensão Swap Plus do VS Code.
Siga a parte do seu sistema.

**Mac**

1. Abra o **Terminal**: `Cmd + Espaço`, digite `Terminal` e aperte Enter.
2. Cole este comando e aperte Enter:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.sh | bash
   ```

3. Espere até aparecer **`==> Pronto`**. No caminho ele mostra:
   - `uv … já instalado` ou a instalação do uv;
   - `Motor (swap-plus)` e, no fim dessa parte, `swap-plus 1.x.x`;
   - `Extensão Swap Plus (VS Code)` e `Extension 'swap-plus.vsix' was successfully installed.`
4. No VS Code: se ele estava aberto, aperte `Cmd + Shift + P`, digite **Developer: Reload Window** e aperte Enter.
   Se estava fechado, é só abrir.

**Windows**

1. Abra o **PowerShell**: menu Iniciar, digite `PowerShell` e abra o **Windows PowerShell**
   (não precisa ser "como administrador").
2. Cole este comando e aperte Enter:

   ```powershell
   irm https://raw.githubusercontent.com/bragarpaulo/swap-plus-vscode/main/plus/scripts/install.ps1 | iex
   ```

3. Espere até aparecer **`==> Pronto`**. No caminho ele mostra as mesmas três partes do Mac (uv, motor e extensão).
4. **Feche e abra o VS Code** (ou `Ctrl + Shift + P` → **Developer: Reload Window**).

**Como saber se deu certo:** embaixo, à esquerda do VS Code, aparece a barra do Swap Plus: `│ ✉ sem conta ativa │`.
Ainda sem contas, porque elas entram na próxima etapa.

### Etapa 3 — No outro computador: importar as contas e conferir

> **Dica: a paleta de comandos.** Todos os comandos do Swap Plus também abrem pelo teclado, sem precisar
> achar a barra: aperte `Ctrl + Shift + P` (no Mac, `Cmd + Shift + P`), digite o nome do comando e aperte
> Enter. Os principais: **Swap Plus: Importar contas**, **Swap Plus: Trocar conta** e
> **Swap Plus: Configurar trocas automáticas**.

1. Coloque o arquivo da Etapa 1 numa pasta fácil (por exemplo, a Mesa). Pasta de rede também funciona.
2. Abra a importação: `Ctrl/Cmd + Shift + P` → **Swap Plus: Importar contas**.
   Ou: clique na barra do Swap Plus → **Configurações…** → **Exportar e importar contas** → **Importar contas…**
3. Escolha o arquivo `swap-plus-other.cswap` (ou `swap-plus-me.cswap`).
   > Se aparecer também um arquivo com o mesmo nome e `._` na frente (por exemplo `._swap-plus-other.cswap`),
   > ignore: é um arquivo auxiliar que o Mac cria ao copiar para pen drive. Escolha o que **não** começa com `._`.
4. Espere a mensagem **"N contas importadas, com as regras de troca, os avisos e os ajustes de cada conta"**.
   Se o arquivo era um **Export Other**, ela também diz *"Modo privado ligado: aqui aparece só “Conta N”"*.
5. Na mesma mensagem, clique em **Apagar o arquivo**. Se você copiou o arquivo para outro lugar, apague lá
   também e esvazie a Lixeira.
6. **Escolha a conta:** `Ctrl/Cmd + Shift + P` → **Swap Plus: Trocar conta** (ou clique na barra do Swap Plus)
   e escolha uma conta. O ✓ marca a que está em uso, e o Claude Code passa a usar essa conta em até 30 segundos.
7. **Confira:**
   - a barra mostra `│ ✉ Sessão (5h): X% usado — renova … · Semanal: … · Fable: … │`;
   - em **Configurações → Contas** estão todas as contas, com os mesmos ajustes do computador principal;
   - em **Configurações → Atualizações da extensão** aparecem as versões instaladas.

Pronto. Se a troca automática estava ligada no computador principal, ela já vem ligada aqui.

### Depois disso (modo local)

- **Atualizações:** automáticas. A extensão verifica ao abrir e ao fechar o VS Code e a cada 2 dias, e
  instala sozinha, do mesmo jeito que as outras extensões. Tudo acontece dentro do VS Code. Para ver ou
  forçar: **Configurações → Atualizações da extensão → Verificar agora**.
- **Ordem das contas = fila de uso:** em **Configurações → Contas** e na lista da barra, primeiro vêm as contas que
  participam da troca automática (contornadas de verde), de quem renova o semanal antes para quem renova depois; no
  fim, as que não participam. Com a estratégia **Aproveitar ao máximo** (o padrão), o Swap Plus usa essa fila: vai para
  a conta cuja cota semanal zera antes e ainda tem pelo menos 20% sobrando, para não desperdiçar cota. Para ordenar à
  mão, marque **Ordenar pelo número da conta** e use as setas ↑ ↓.
- **Se a conta bater o limite antes da troca** (por exemplo, com vários agentes rodando ao mesmo tempo): o Swap Plus
  percebe na hora, pelo aviso que o próprio Claude Code grava, e troca de conta. O Claude Code pode ficar parado
  esperando: **mande uma mensagem (por exemplo, "continue")** e ele segue na conta nova.
- **Quando o Fable acaba:** o padrão é **seguir na mesma conta com o Opus 5.5**. O Claude Code pergunta
  *"You've reached your Fable limit for this week. Switch models?"*: escolha **Switch to Opus 5.5** e a conversa
  continua na mesma conta, no mesmo esforço. O Swap Plus avisa antes (linha de aviso do Fable) e não troca de
  conta por causa do Fable. Em **Configurações → Regras → Limite semanal do Fable** dá para escolher o contrário
  (trocar de conta para continuar no Fable) e, se aparecer **Deixar pronto**, clicar nele uma vez para o Claude
  Code oferecer o Opus 5.5 no mesmo esforço do Fable.
- **Ligar ou desligar o modo privado:** **Configurações → Exibição**.
- **Adicionar uma conta nova:**
  1. No Claude Code, entre com a conta nova. **Não faça logout da conta anterior** antes: o logout pode invalidar o
     acesso que o Swap Plus guardou dela. Basta entrar com a outra conta.
  2. O Swap Plus percebe que a conta logada não está cadastrada (a barra mostra *conta logada não cadastrada*) e
     pergunta **Cadastrar agora?**. Ou: clique na barra → **Cadastrar a conta logada no Claude Code** (ou
     **Adicionar conta…**).
  3. A conta entra na fila e já participa da troca automática. Se outra conta renovar antes, o Swap Plus pode trocar
     para ela em seguida — é a fila funcionando.
- **Levar mudanças para o outro computador de novo:** repita as Etapas 1 e 3; a Etapa 2 não precisa.
  As configurações e os ajustes de cada conta são atualizados e as contas novas entram. As contas que já
  existiam lá continuam como estão (o login delas não é trocado).
- **Desligar o Swap Plus por um tempo:** **Configurações → Swap Plus** (o primeiro botão), ou clique na barra →
  **Desligar o Swap Plus**, ou `Ctrl/Cmd + Shift + P` → **Swap Plus: Ligar/desligar o Swap Plus (tudo)**. Desligado,
  ele não consulta as contas, não troca e não mexe no login: o Claude Code funciona normalmente. A barra mostra
  *Swap Plus desligado*; clique nela para ligar de novo.
- **O login é salvo na hora:** sempre que o Claude Code entra numa conta cadastrada ou renova o acesso dela, o Swap
  Plus guarda essa versão nova na hora. Se uma conta aparecer como **Login morto — entrar de novo**, basta entrar
  com ela no Claude Code: o Swap Plus salva o login novo sozinho. A troca automática nunca vai para uma conta com
  login morto.

> **A mesma conta nos dois computadores.** O acesso de cada conta é renovado a cada ~8 horas e cada renovação
> invalida a anterior. Quando os dois computadores têm a **mesma cópia** do login (a que vai no arquivo de
> exportação), o primeiro que renova fica com a conta e, no outro, ela morre (*Login morto*). Para usar a mesma
> conta nos dois, entre com ela **no Claude Code de cada computador** (cada login é independente) em vez de levar
> o login pelo arquivo. Ou, melhor: use o [servidor](#começando-com-o-servidor-20), que resolve isso de vez.

### Passar do modo local para o servidor

1. Siga [Começando com o servidor](#começando-com-o-servidor-20) neste computador.
2. Na primeira conexão, responda **Sim** a **Enviar os logins deste computador para o servidor?** (a pergunta só
   aparece nos computadores do administrador). As regras de troca daqui não vão junto: se quiser, ajuste as do
   servidor pelo painel ou pela tela de configurações.
3. Faça o mesmo em cada computador que usava o modo local.
4. Daí em diante, não use mais o modo local nem exportar/importar com essas contas.

### Problemas comuns no modo local

| O que aparece | O que fazer |
| --- | --- |
| Depois de uma troca, o Claude Code pede login (*How do you want to log in?*) ou a conta aparece como **Login morto** | O login guardado dessa conta não vale mais — quase sempre porque o outro computador renovou a mesma cópia (veja *A mesma conta nos dois computadores*, acima). Entre com a conta no Claude Code: o Swap Plus salva o login novo na hora. Para parar as trocas enquanto isso: desligue o Swap Plus. |
| A barra mostra **Swap Plus: erro** | O motor não foi encontrado. Rode o comando da Etapa 2 de novo e recarregue o VS Code. |
| A barra mostra **sem conta ativa** ou **conta logada não cadastrada** | O Claude Code está logado numa conta que não está no Swap Plus. Clique na barra → **Cadastrar a conta logada no Claude Code**. Enquanto isso, o Swap Plus não acompanha o uso nem troca de conta. |
| Mac: `command not found: swap-plus` no Terminal | Feche e abra o Terminal. |
| Windows: `swap-plus não é reconhecido` | Feche e abra o PowerShell. |
| Windows: o comando da Etapa 2 dá erro de "execução de scripts" | Rode antes: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` e tente de novo. |
| **Importar contas** dá erro | A mensagem diz o motivo. Os mais comuns: escolher o arquivo `._…` do pen drive (escolha o sem `._`), arquivo vazio porque ainda está só na nuvem (baixe ou copie para outra pasta) ou arquivo que chegou como `.zip` (descompacte). Se nada disso, gere o arquivo de novo (Etapa 1). |
| Windows: erro com **pasta de rede** ou `ERR_UNC_HOST_NOT_ALLOWED` | O arquivo está numa pasta de rede (caminho começando com `\\`, como a pasta do Mac compartilhada). A partir da versão 1.4.2 a extensão copia o arquivo sozinha; se ainda der erro, copie o arquivo para a Área de Trabalho do Windows e importe de lá. |
| A extensão não se atualiza sozinha (a tela continua igual depois de uma versão nova) | Rode o comando da Etapa 2 de novo: ele instala a versão mais nova por cima, sem mexer nas contas. Depois recarregue o VS Code. |
| A barra não aparece depois de instalar | Recarregue o VS Code (`Cmd/Ctrl + Shift + P` → **Developer: Reload Window**). |

---

## Sobre o modo privado

Ele muda só o que o **Swap Plus** mostra (barra, lista de contas, tela de configurações e avisos). Não é uma
trava:

- o painel de conta do próprio Claude Code (na lateral) e o comando `/status` continuam mostrando o e-mail
  da conta em uso;
- o comando `swap-plus list` também mostra;
- quem usa o computador usa as contas.

Liga e desliga em **Configurações → Exibição**.

## Remover

- **Extensão:** VS Code → Extensões → Swap Plus → Desinstalar.
- **Motor:** no Terminal/PowerShell, `uv tool uninstall claude-swap`.
- **Contas guardadas pelo Swap Plus neste computador:** `swap-plus purge` (antes de remover o motor).
  Apaga a pasta `~/.claude-swap-backup` e as credenciais guardadas por ele.
- **Conectado ao servidor?** Desconecte antes (veja [Desconectar um computador](#desconectar-um-computador)).

---

Mais detalhes: [novidades da 2.0](NOVIDADES-2.0.md) · [extensão](plus/README.md) · [servidor](server/deploy/LEIA-ME.md) ·
[motor](https://github.com/bragarpaulo/swap-plus).
