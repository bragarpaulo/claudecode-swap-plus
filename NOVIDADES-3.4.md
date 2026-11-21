# Novidades do Swap Plus 3.4

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
