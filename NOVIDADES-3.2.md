# Novidades do Swap Plus 3.2

## Swap Plus Cliente: o Swap Plus sem VS Code

O Swap Plus ganha uma terceira parte, ao lado da extensão e do servidor: o **Swap Plus Cliente** (pasta
[`cliente/`](cliente/), versão 1.0.0). Ele faz o trabalho da extensão **sem o VS Code**: conecta-se ao servidor como
mais um computador e mantém em dia um login do Claude Code numa pasta só dele.

Serve para o **Hermes** (o assistente de IA que fica sempre ligado) e para outros serviços e rotinas em segundo
plano usarem o Claude Code com as contas que o Swap Plus cuida. "O Hermes é uma coisa, o VS Code é outra."

- **Um computador a mais no painel.** O cliente aparece em **Computadores**, com o nome que você deu a ele. Dá para
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
E a aba **Computadores** agora se chama **Serviços** (só o nome mudou).

## Quem precisa

Só quem quer usar o Claude Code **fora do VS Code** com as contas do Swap Plus: pelo Hermes, por um serviço ou por
uma rotina sua. Quem usa só o VS Code não precisa instalar nada.

## O que não muda

- **Extensão:** nada muda. Ela continua igual, em cada computador.
- **Servidor:** o cliente funciona com o servidor que já está no ar (usa as mesmas chamadas da extensão). A versão
  2.5.0 só é necessária para os e-mails novos e para o texto novo da página de login.
- **Regras de troca e painel:** os mesmos. O cliente entra nas regras como qualquer computador. Para o Hermes usar
  só algumas contas, escolha em **Contas** → **Ajustes desta conta** → **Computadores permitidos**.

## O que ainda falta e o que continua manual

- **O uso pelo Hermes ainda não foi testado de ponta a ponta.** O lado do cliente tem testes automáticos. A
  instalação do plugin no Hermes e o uso pelo Hermes ainda não foram feitos.
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
