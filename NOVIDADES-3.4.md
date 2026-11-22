# Novidades do Swap Plus 3.4

## Extensão 3.4.1 (22/11/2026): conta que não tem o Fable usa o outro modelo do painel

- **O problema:** em 21/11 às 23:05 o computador foi para a conta 4 e as conversas em Fable pararam com "Fable 5.2
  requires usage credits. Switch to another model to continue." Não era limite esgotado: a conta 4 não tem o Fable
  no plano, e os créditos de uso estão desligados na organização. O Swap não reconhecia esse caso: só passava para
  o modelo secundário quando o preferido **acabava**. E, com o painel em preferido = Opus 5.5 e secundário = Fable
  5.2, não fazia nada num computador que usa o Fable.
- **Como reconhecer uma conta assim:** no uso dela não aparece a linha "Fable". Conta com Fable sem usar aparece
  como "Fable 0%".
- **O que mudou:** enquanto o computador estiver numa conta sem o modelo que ele usa, o modelo padrão do Claude
  Code passa para **o outro modelo do painel**, e toda conversa nova já abre nele. Quando o computador vai para uma
  conta que tem o modelo, o padrão volta ao que era. A extensão percebe de dois jeitos:
  - pelo uso das contas: a conta em uso vem sem o limite do modelo, e outra conta informa esse limite;
  - pelo erro "requires usage credits" visto numa conversa.
- **Os dois modelos do painel são a alternativa um do outro.** O painel diz qual é o preferido do servidor (o que
  ele procura nas contas), mas cada computador pode usar o outro como padrão. Exemplo, com o painel em **preferido
  = Opus 5.5** e **secundário = Fable 5.2**:
  - computador com o padrão no **Fable**: em conta sem Fable (ou com o Fable esgotado), o padrão vai para o Opus
    5.5, e volta ao Fable numa conta que tem;
  - computador com o padrão no **Opus 5.5**: conta sem Fable não muda nada.
- **Na regra "Trocar de conta":** se o modelo que falta é o que o servidor procura nas contas (o preferido do
  painel), a extensão pede ao servidor uma conta que tem o modelo, e a conversa que parou retoma sozinha lá. Pede
  no máximo uma vez a cada 10 minutos, e só se alguma outra conta tem o modelo sobrando. Se o modelo que falta é o
  secundário do painel, não pede: o servidor não olha esse modelo e poderia mandar para outra conta sem ele. Fica
  na mesma conta, no outro modelo.
- **O que não muda:**
  - conversa já aberta não troca de modelo sozinha (limite do Claude Code): nela, escolha o outro modelo no seletor
    e mande "continue";
  - num VS Code com `swapPlus.autoModel.enabled` desligada, o Swap não mexe no modelo;
  - padrão num terceiro modelo (nem o preferido nem o secundário do painel): o Swap não mexe;
  - o servidor é o mesmo (2.6.0): nada para publicar lá.
- **Conferido:** pelos testes da extensão. Não foi visto ao vivo numa conta sem Fable.

## Servidor 2.6.0 e extensão 3.4.0 (21/11/2026): modelo preferido e secundário, com a lista completa e o esforço

- **O problema:** no painel, o "Modelo preferido" só mostrava "Fable". A lista era montada com os limites que
  aparecem no uso das contas, não com os modelos de verdade. E o modelo para onde as conversas vão quando o Fable
  acaba (o Opus 5.5) estava fixo no código, sem escolha de esforço.
- **O que mudou no painel** (**Contas** → **Regras de troca** → **Para qual conta ir (estratégia)**):
  - **Modelo preferido** e **Esforço do modelo preferido**;
  - **Modelo secundário** e **Esforço do modelo secundário**;
  - as duas listas trazem **todos os modelos** que as contas enxergam, pelo nome ("Claude Fable 5.2", "Claude Opus
    5.5" e os demais), o mais novo primeiro;
  - o esforço mostra só os níveis que o modelo escolhido aceita: **Baixo**, **Médio**, **Alto**, **Muito alto**, ou
    **Padrão do Claude Code** (o Swap não mexe);
  - embaixo, "N modelos · atualizados em …" e o botão **Atualizar modelos**.
- **De onde vem a lista:** o servidor pergunta à própria Anthropic, com o login de uma das contas, uma vez por dia e
  quando você clica em **Atualizar modelos**. Não gasta uso. Se a consulta falhar, a lista de antes continua valendo.
- **O que cada escolha faz:**
  - **preferido:** é o modelo que as conversas usam e o que o Swap procura nas contas. Ao trocar de conta, as que
    ainda têm esse modelo disponível vêm primeiro;
  - **secundário:** quando o preferido acaba em todas as contas, as conversas novas abrem nele. Quando o preferido
    renova, o padrão volta para ele;
  - **esforço:** em cada VS Code, a extensão grava o esforço escolhido para aquele modelo nas configurações do
    Claude Code. Se alguém mudar o esforço por dentro do Claude Code, o Swap repõe o do painel. Para liberar, escolha
    **Padrão do Claude Code**.
- **O que não muda:**
  - conversa já aberta não troca de modelo sozinha (é um limite do Claude Code: o modelo de uma conversa aberta só
    muda por dentro dela);
  - o preferido e o secundário precisam ser diferentes;
  - o nível "max" de esforço não aparece: o Claude Code só guarda de Baixo a Muito alto;
  - num VS Code com a opção `swapPlus.autoModel.enabled` desligada, o Swap não grava modelo nem esforço;
  - o Hermes tem a configuração de modelo dele, separada.
- **A extensão 3.4.0 também leva** os ajustes do gancho de retomada feitos depois da 3.3.0: espera até 30 minutos
  pela conta nova (cobre troca manual e relogin) e age nos outros erros da conta (cobrança, conta suspensa,
  organização não permitida).
- **Conferido:** pelos testes (549). A tela nova não foi aberta num navegador antes de publicar; vale conferir no
  painel.
