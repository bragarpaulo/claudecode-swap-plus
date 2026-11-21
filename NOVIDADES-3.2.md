# Novidades do Swap Plus 3.2

## Servidor 2.5.5 (21/11/2026): a conta em uso não é mais renovada com serviço nela

- **O problema:** a cada 6 horas o servidor renova o login de cada conta. Quando ele renova, a Anthropic cancela o
  acesso antigo no mesmo instante, e o serviço que estava com ele só busca o novo no contato seguinte com o servidor
  (até 30 segundos no VS Code, até 2 minutos no Hermes parado). Uma conversa que chamasse o Claude nesse intervalo
  parava com "OAuth token revoked". Aconteceu em 21/11 às 09:53: a conta 6 foi renovada em uso, o VS Code buscou o
  acesso novo 19 segundos depois, e nesse meio tempo três conversas pararam. Já tinha acontecido em 16/11 às 09:51.
- **O que mudou:** o servidor passou a saber qual serviço está com o acesso de cada conta, e não renova uma conta
  enquanto algum serviço ligado estiver com ele:
  - quando chega a hora de renovar (faltando 2 horas para o acesso vencer), ele **espera**. Numa troca comum os
    serviços saem da conta sozinhos, e ela renova logo em seguida;
  - se faltar menos de 1 hora e eles ainda estiverem nela, o servidor **troca os serviços para outra conta** e só
    renova a antiga depois que todos gravarem a nova. No histórico aparece "o login da conta N vai ser renovado".
    Troca de conta não derruba conversa: o acesso da conta antiga continua valendo até o serviço gravar a nova;
  - se não houver outra conta com folga para onde ir, ou se a troca automática estiver desligada, a conta é renovada
    quando faltam 30 minutos, com o risco de antes. O registro do servidor avisa quando isso acontece.
- **O que você vai notar:** de vez em quando uma troca de conta a mais, com esse motivo. Com o VS Code aberto e sem
  uso, é mais ou menos uma a cada 6 horas.
- **O que não mudou:** as regras de troca, as contas, a extensão e o cliente do Hermes. Contas que ninguém está
  usando continuam renovando 2 horas antes de vencer.

## Extensão 3.2.1 (21/11/2026): dois acertos na tela de Configurações

- Em janela estreita, o nome da conta em uso não quebra mais no meio ("Conta 3" fica junto e o e-mail vai inteiro para a
  linha de baixo).
- Com o Swap Plus desligado, o servidor fora do ar ou o acesso recusado, o cartão "Conexão" passa a mostrar o endereço
  do servidor (antes ele só aparecia quando estava conectado).

## Servidor 2.5.4 (21/11/2026): a conta em uso passa a ser lida a tempo

- **O problema:** com 23 contas, o servidor só conseguia ler o uso da conta em uso a cada 42 minutos (e não a cada 3,
  como estava escrito). Na maioria das vezes a troca só acontecia depois de a conta bater 100%. Aconteceu de verdade em
  21/11 às 02:27.
- **O que mudou:** a conta em uso passa na frente das outras: é lida a cada 10 minutos, e a cada 2,5 a 5 minutos quando
  está chegando perto da linha de troca. As outras contas continuam sendo lidas, com o que sobra do mesmo limite de 24
  leituras por hora. Depois de um reinício o servidor também faz menos leituras de uma vez (29 na primeira hora, em vez de 47).
- **O que não mudou:** as regras de troca, as contas e o limite de leituras por hora.
- **Painel:** quem conectou sem conta Google aparece como "por código de conexão" (era "conectado por código", que se
  confundia com o estado "conectado").


## Servidor 2.5.3 e extensão 3.2.0: "serviços" no painel e a tela enxuta no VS Code (21/11/2026)

**O que mudou no painel (servidor 2.5.3)**

- **O painel fala em "serviços".** Onde estava "computador" ou "computadores" agora está "serviço" e "serviços".
  Serviço é tudo o que está ligado ao Swap: cada VS Code, o Hermes, um robô. Exemplos: **Serviços permitidos**
  (era "Computadores permitidos"), a regra **Serviços: Separados / Juntos**, **Conectar um serviço** e, na linha da
  conta, "Em 1 serviço" / "Em 3 serviços". O histórico, os avisos e os e-mails novos também dizem "serviço". O que
  já estava gravado no histórico fica com o texto antigo. "Computador" continua só onde é a máquina mesmo ("no seu
  computador").
- **Cada serviço mostra uma de três situações**, cada uma com a sua cor de bolinha:
  - **ativo agora** (verde): em uso nos últimos 5 minutos. Um VS Code aberto, um agente trabalhando.
  - **conectado · sem uso agora** (azul): ligado e falando com o servidor, só que sem uso no momento. É assim que o
    Hermes fica entre uma tarefa e outra. Está tudo certo com ele.
  - **sem contato** (cinza): não fala com o servidor há mais de 5 minutos (fechado, desligado ou sem internet). Ao
    lado aparece a última vez em que foi visto.

  Antes só havia "ativo agora" e "parado", e o Hermes aparecia como "parado" mesmo ligado e conectado. Por isso
  parecia que ele ora estava ativo, ora desativado. A palavra "parado" saiu do painel.
- **Logo depois de o servidor reiniciar** pode aparecer, por até 5 minutos, "aguardando contato · o servidor
  reiniciou há pouco". É passageiro: o serviço volta sozinho para uma das três situações.
- **A contagem no alto mostra as situações:** "5 serviços (3 ativos agora, 1 conectado, 1 sem contato)". Na aba
  **Serviços**, os ativos vêm primeiro, depois os conectados e por fim os sem contato. A busca também acha pela
  situação.

**O que mudou na extensão (3.2.0)**

- **A tela de Configurações mostra só este VS Code.** De cima para baixo:
  - o interruptor **Swap Plus neste VS Code** (liga e desliga o Swap só aqui);
  - o cartão **Conexão** (com que servidor este VS Code fala; "Entrar com Google", "Colar código", "Sair");
  - o cartão **Conta em uso aqui**, com os limites dela, e **Trocar de conta** → **Usar esta conta**;
  - **Mais opções deste VS Code**, que abre com um clique: os avisos de limite, a exibição e as atualizações da
    extensão.
- **O que saiu da tela** está no painel do Swap: as regras de troca, os ajustes de cada conta, adicionar conta, os
  outros serviços e o histórico. O botão **Abrir o painel**, no pé da tela, leva até lá (só o administrador entra).
- **O comando mudou de nome:** era "Swap Plus: Configurar trocas automáticas", agora é **Swap Plus:
  Configurações**. O cartão "Servidor" virou **Conexão**.

**O que não mudou**

- **O login de cada VS Code.** Quem já está logado e funcionando continua igual. A extensão nova não mexe no login,
  na conexão com o servidor nem na gravação do acesso. Ninguém precisa entrar de novo.
- **As contas e as regras de troca.** As mesmas contas, as mesmas regras, as mesmas contas liberadas para cada
  serviço. O servidor decide as trocas do mesmo jeito: as situações novas servem só para mostrar.
- **O Swap Plus Cliente** (o do Hermes) continua na versão 1.0.0. Algumas mensagens dele ainda dizem "Computadores".

**Como chega**

- O painel novo aparece quando o servidor 2.5.3 for colocado no ar.
- A extensão 3.2.0 chega aos outros computadores quando for publicada. A partir daí cada VS Code se atualiza
  sozinho, como nas outras versões, ou na hora em **Mais opções deste VS Code** → **Atualizações da extensão** →
  **Verificar agora**.

## Swap Plus Cliente: o Swap Plus sem VS Code

O Swap Plus ganha uma terceira parte, ao lado da extensão e do servidor: o **Swap Plus Cliente** (pasta
[`cliente/`](cliente/), versão 1.0.0). Ele faz o trabalho da extensão **sem o VS Code**: conecta-se ao servidor como
mais um serviço e mantém em dia um login do Claude Code numa pasta só dele.

Serve para o **Hermes** (o assistente de IA que fica sempre ligado) e para outros serviços e rotinas em segundo
plano usarem o Claude Code com as contas que o Swap Plus cuida. "O Hermes é uma coisa, o VS Code é outra."

- **Um serviço a mais no painel.** O cliente aparece em **Serviços**, com o nome que você deu a ele. Dá para
  renomear, trocar de conta e desconectar, como os outros.
- **Pasta de login própria.** O cliente não mexe no Claude Code do VS Code. Quem usa o Claude Code por ele aponta
  para a pasta do cliente (variável `CLAUDE_CONFIG_DIR`; no Hermes, a configuração `claude_config_dir` do plugin
  `claude-subscription-directsdk`).
- **Só o acesso.** Como a extensão, o cliente recebe só o acesso da conta que o servidor escolheu. O login completo
  nunca sai do servidor, e o cliente nunca envia logins.
- **Só conta como ativo quando está em uso.** No modo padrão (`auto`), o cliente só ocupa uma conta no servidor
  enquanto o Claude Code está sendo usado pela pasta dele, e por 10 minutos depois. Parado, só consulta o servidor a
  cada 2 minutos para manter o login válido. Há também o modo `sempre`.
- **A troca de conta continua sendo do servidor**, pelas mesmas regras. O cliente grava o login da conta nova em até
  30 segundos quando está ativo (até 2 minutos quando está parado).
- **Comandos para o dia a dia:** `conectar`, `entrar`, `rodar`, `status`, `saude`, `trocar`, `limite` e
  `desconectar`.

O manual completo está em [`cliente/README.md`](cliente/README.md).

## Servidor 2.5.0: e-mails do vencimento das contas

O login de cada conta Claude vence depois de alguns dias e precisa ser refeito. O servidor passa a avisar o dono
(o administrador) por e-mail de dois jeitos:

- **Resumo semanal.** Toda segunda às 8h: as contas que vencem nos 7 dias seguintes, com a data de cada uma, as
  que já pararam de valer e as que não têm data conhecida. Se nenhuma vence, o e-mail diz isso.
- **Um dia antes.** Quando falta menos de 1 dia para o login de uma conta vencer, um e-mail só dela, com o passo
  a passo para entrar de novo. É um por login. (Antes eram até três: um por dia nos últimos 3 dias.)
- O alerta no painel e no histórico continua desde 3 dias antes, e o e-mail de "o login parou de valer" não mudou.
- Para ver o resumo na hora, sem esperar a segunda: `docker exec swap-plus node /app/server/src/cli.js resumo`.
- Dia, hora e antecedência são ajustáveis ([guia do servidor](server/deploy/LEIA-ME.md#avisos-por-e-mail-ao-dono)).

Outra mudança pequena: a página que aparece depois de entrar com o Google dizia "Pode voltar ao VS Code". Como o
cliente do Hermes também entra por ela, agora diz só "Pronto! Conectado.".

**Servidor 2.5.1: painel mais enxuto.** Na aba **Contas**, cada conta virou uma linha que abre e fecha com um
clique, e a tela abre com todas fechadas. A linha mostra o nome e o e-mail, a barra do limite mais perto de parar a
conta, quando ele renova e se a conta participa da troca. As contas em uso vêm primeiro. Quando faltam menos de 3
dias para o login de uma conta vencer (ou ele já venceu), a linha dela pisca "Fazer login até…" com a data e a hora.
E a aba **Computadores** agora se chama **Serviços** (na 2.5.1 só o nome da aba mudou; os outros textos mudaram na
2.5.3, no alto desta página).

**Servidor 2.5.2: busca e listas iguais nas três abas.** Cada aba ganhou um campo de **busca**, que filtra enquanto
você digita e procura em tudo o que o item mostra, sem ligar para maiúsculas nem acentos. Em **Contas**, o grupo
"Fora da troca" saiu: essas contas ficam no fim da lista, como linhas iguais às outras. Em **Serviços**, cada
serviço virou uma linha que abre e fecha, como as contas. Em **Usuários**, a tabela ordena pelos cabeçalhos, os
erros aparecem ao lado do campo e "Tirar" pede a confirmação na própria linha.

## Quem precisa

Só quem quer usar o Claude Code **fora do VS Code** com as contas do Swap Plus: pelo Hermes, por um serviço ou por
uma rotina sua. Quem usa só o VS Code não precisa instalar nada.

## O que não muda

- **Extensão:** o cliente não muda nada nela. (A tela de Configurações mudou depois, na 3.2.0: veja o alto desta
  página.)
- **Servidor:** o cliente funciona com o servidor que já está no ar (usa as mesmas chamadas da extensão). A versão
  2.5.0 só é necessária para os e-mails novos e para o texto novo da página de login.
- **Regras de troca e painel:** os mesmos. O cliente entra nas regras como qualquer serviço. Para o Hermes usar
  só algumas contas, escolha em **Contas** → **Ajustes desta conta** → **Serviços permitidos**.

## O que ainda falta e o que continua manual

- **O Hermes do servidor já usa o Claude Code por este cliente, desde 20/11/2026.** A instalação e o que foi
  conferido nesse dia estão em [`cliente/deploy/LEIA-ME.md`](cliente/deploy/LEIA-ME.md). Em outra instalação do
  Hermes, confira os passos na sua versão: o plugin é marcado como experimental pelos próprios autores.
- **Com o Hermes, o cliente não vê o limite batido nem o modelo em uso** (o plugin não deixa as conversas
  gravadas). A troca pelas linhas de uso do servidor continua valendo. Se a conta bater o limite antes, o comando
  `swap-plus-cliente limite` avisa o servidor, à mão ou por um script seu.
- **O cliente não troca o modelo sozinho.** A troca para o Opus 5.5 quando o Fable acaba (novidade da 3.1) é só da
  extensão.
- **Não há instalador nem atualização automática.** O cliente roda a partir de uma cópia deste repositório, ou da
  imagem Docker descrita em [`cliente/deploy/LEIA-ME.md`](cliente/deploy/LEIA-ME.md).

## Como começar

Nada a fazer para quem usa só o VS Code. Para usar o cliente:

- numa máquina qualquer: [`cliente/README.md`](cliente/README.md#instalar-e-conectar);
- no servidor, em Docker: [`cliente/deploy/LEIA-ME.md`](cliente/deploy/LEIA-ME.md).
