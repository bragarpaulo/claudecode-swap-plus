# Novidades do Swap Plus 3.5

## Servidor 2.7.0 e extensão 3.5.0 (22/11/2026): a conta segue o modelo que cada serviço usa

- **O problema:** às 11:17 de 22/11 o servidor levou o Mac e o NoteWin juntos para a conta 4 (o semanal dela zerava
  antes). A conta 4 não tem o Fable no plano (as contas 12 e 14 também não). Os dois VS Code estavam no Fable: às
  11:18 as conversas pararam com "Fable 5.2 requires usage credits" e o Claude Code abriu o aviso dele ("Switch to
  the default model and continue" / "Buy usage credits"). O servidor não olhava o Fable porque no painel o modelo
  preferido estava em Opus 5.5. E a extensão 3.4.1 viu o erro, mas não fez nada: o Fable era o secundário do painel.
- **O que mudou no servidor (2.7.0):** cada serviço já mandava, a cada batimento, os modelos das conversas dos
  últimos 30 minutos. Agora o servidor usa isso: **a conta de cada serviço segue o modelo que ele usa de verdade**,
  e não só o preferido do painel. O painel continua sendo o padrão; o que você escolher no VS Code manda.
  - Serviço no Fable só vai para conta que tem o Fable (com folga e com o mínimo de Fable sobrando).
  - Serviço numa conta sem o Fable que passa a usar o Fable: o servidor troca **na hora** para uma conta que tem.
  - Modo "juntos": se algum serviço do grupo usa o Fable, o grupo vai para uma conta com Fable (ela serve o Opus
    também).
  - O servidor lembra o modelo por até 12 h (o computador parado não perde o Fable). Se o serviço passa a usar
    outro modelo por mais de 30 min, o Fable deixa de ser exigido. O modelo padrão do Claude Code do computador
    (o `model` do settings.json) também conta.
  - A troca por causa do modelo (limite do Fable ou conta sem ele) só vai para conta que tem o modelo. Antes, ir
    para uma conta sem o Fable podia acontecer e não adiantava nada.
  - O serviço viu "requires usage credits" numa conta: o servidor anota que ela não tem o modelo (por 24 h) e
    troca na hora.
  - A troca para renovar o login também respeita o modelo.
- **O que mudou na extensão (3.5.0):**
  - Erro "requires usage credits" na conversa → vai direto ao servidor (`model_missing`), que troca de conta; a
    conversa que parou retoma sozinha na conta nova (gancho de retomada da 3.3.0).
  - O modelo padrão do Claude Code **não muda mais sozinho** quando falta o Fable (com o servidor 2.7.0 e a regra
    "trocar de conta"). Só quando **nenhuma conta tem o Fable disponível** aparece a pergunta: "Não há mais nenhuma
    conta com Fable disponível. Você quer mudar para o Opus 5.5?" — "Mudar" passa o modelo padrão (conversas novas)
    e diz como passar a conversa aberta; "Continuar esperando" deixa como está, e o Swap troca sozinho quando uma
    conta com Fable ficar disponível. Uma pergunta por vez sem conta com o modelo.
  - O batimento manda também o modelo padrão do Claude Code (`defaultModel`).
- **O aviso laranja do Claude Code** ("Fable 5.2 requires usage credits"): é do próprio Claude Code, e outra
  extensão não consegue tirá-lo nem respondê-lo (conferido no 2.1.330: é um "portão" antes de mandar a mensagem,
  sem configuração para desligar). Com o servidor 2.7.0 ele não deve mais aparecer, porque o serviço que usa o Fable
  não vai mais para conta sem Fable. Se aparecer (o primeiro uso do Fable numa conta sem ele, antes do servidor
  saber), o Swap já troca de conta em segundos; aí feche o aviso (X) e, se a conversa tiver passado para o Opus,
  escolha o Fable de novo no seletor de modelo e mande "continue".
- **Compatível:** extensão antiga com servidor 2.7.0 funciona (o servidor já protege pelo modelo); extensão 3.5.0
  com servidor antigo faz o que a 3.4.1 fazia.
- **Conferido:** testes do servidor (283) e da extensão (34 do modo servidor, mais os outros), com o caso de 11:17
  reproduzido. Não foi visto ao vivo ainda.
