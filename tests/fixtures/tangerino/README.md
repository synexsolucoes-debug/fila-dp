# Fixtures do agente Tangerino

Estas páginas **imitam** a Admissão Digital do Tangerino. Elas não foram
copiadas da tela real — não houve acesso autorizado para isso — e por isso não
provam que os seletores de `lib/tangerino/selectors.ts` funcionam contra o
Tangerino de verdade.

O que elas provam é o que dá para provar sem esse acesso: que o cliente de
navegador percorre o caminho fechado que declara, que ele lê os campos onde eles
estiverem, e — o mais importante — que **retirar um elemento esperado produz
`UI_CHANGED`, e nunca um status inferido** (§65).

Quando o mapeamento real acontecer (§72), estas fixtures são reescritas com a
estrutura observada, e aí passam a valer como regressão de verdade.

Rodar: `npm run tangerino:fixtures`
