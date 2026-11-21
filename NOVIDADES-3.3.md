# Novidades do Swap Plus 3.3

## Extensão 3.3.0 (21/11/2026): a conversa que parou retoma sozinha depois da troca

- **O problema:** quando uma conta bate o limite no meio de uma conversa, o Claude Code mostra "You've hit your
  limit" e para. O Swap Plus trocava de conta em poucos segundos, mas a conversa continuava parada até alguém
  escrever "continue". Em 21/11 às 14:15 duas conversas ficaram assim, com a conta nova já gravada 5 segundos depois
  do erro.
- **O que mudou:** depois de trocar de conta, o Swap Plus manda na própria conversa a mensagem **"Troquei de conta,
  pode continuar."** e ela segue sozinha, como se você tivesse digitado. Vale para todas as conversas e todas as
  janelas do VS Code do computador.
- **Onde liga e desliga:** na tela de Configurações do VS Code, em **Mais opções deste VS Code** → **Depois da troca
  de conta** → **Retomar sozinho a conversa que parou no limite**. Vem ligado. O texto da mensagem muda em
  `swapPlus.resume.text`, nas configurações do VS Code.
- **Como funciona:** o Claude Code não tem um comando para outra extensão mandar mensagem numa conversa. O que ele
  tem é um **gancho** (`StopFailure`) que roda quando a conversa para por erro, e uma caixa de entrada por conversa.
  O Swap Plus põe esse gancho no `settings.json` do Claude Code (`~/.claude/settings.json`). Quando a conversa para
  por limite, o gancho espera o Swap gravar a conta nova e posta a mensagem na caixa de entrada daquela conversa.
  - Só a entrada do Swap Plus é acrescentada; o resto do arquivo fica como estava. Antes da primeira mudança ele
    guarda uma cópia em `settings.json.antes-swap-plus`.
  - Conversas que já estavam abertas passam a usar o gancho sem precisar reabrir.
  - O que o gancho fez fica em `~/.swap-plus/retomar.log` (hora, conversa e o que aconteceu).
- **Travas:**
  - só age em limite de uso e em acesso cancelado; outros erros (servidor da Anthropic fora, por exemplo) ficam
    como antes;
  - só manda a mensagem se o Swap gravou uma conta nova. Sem troca em 5 minutos (nenhuma outra conta com folga),
    não manda nada;
  - uma retomada por troca: se a conta nova também falhar, espera a próxima troca. No máximo 6 por hora em cada
    conversa.
- **O que não cobre:**
  - limite do Fable com a regra **Seguir na mesma conta**: a conta não muda, então a conversa não é retomada (nela
    ainda é preciso escolher outro modelo e escrever "continue");
  - o Hermes e os outros serviços sem VS Code;
  - em cada computador, a novidade vale depois que a extensão atualizar e o VS Code for reaberto (a atualização é
    automática). No macOS ela depende da versão nova, porque lá o login fica no Chaveiro.
- **Conferido:** num ambiente isolado, com login falso, a cadeia inteira (erro → gancho → conta nova → mensagem →
  a conversa retoma), a entrada do gancho numa conversa já aberta e a trava contra laço. Ainda não visto: um limite
  de verdade batendo com o gancho no ar.

## Servidor 2.5.6 (21/11/2026): mínimo de Fable na conta de destino e leitura mais cedo

- **O problema:** em 21/11 às 14:03 o servidor levou os serviços para a conta 22, pela regra "aproveitar ao
  máximo" (a cota semanal dela zerava às 22:00). Só que o Fable dessa conta estava em 89%. Com três conversas
  pesadas, os 11 pontos que faltavam acabaram em 12 minutos, antes de o servidor ler o uso de novo.
- **Regra nova no painel: "Mínimo de Fable sobrando no destino"** (em **Contas** → **Regras de troca**, nos ajustes
  finos; de 0 a 50%, padrão 10%). Numa troca que o servidor faz por conta própria — para aproveitar uma cota que vai
  zerar ou para renovar um login — a conta de destino precisa ter pelo menos isso do Fable sobrando. Troca
  obrigatória (conta na linha ou limite batido) não olha esse número.
  - **Com 10%, a troca das 14:03 ainda teria acontecido** (a conta tinha 11% sobrando). Para barrar aquele caso o
    número precisa ser 12% ou mais. Quanto maior, menos contas servem de destino para as trocas voluntárias.
- **A conta em uso é lida mais cedo quando o Fable está acabando.** Com a regra **Trocar de conta**, a leitura passa
  a ser a cada 2,5 a 5 minutos quando o Fable está a até 15 pontos da linha (antes, a até 5). É isso que faz a troca
  sair antes dos 100% mesmo com o mínimo em 10%.
- **Limite conhecido:** com consumo acima de cerca de 1 ponto por minuto, o Fable ainda pode ir da linha de 95% aos
  100% entre duas leituras. Nesse caso a conversa para, o Swap troca na hora e, com a extensão 3.3.0, ela retoma
  sozinha.
- **O que não mudou:** as outras regras, as contas e a renovação da 2.5.5.
