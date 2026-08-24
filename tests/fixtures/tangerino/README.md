# Fixtures do agente Tangerino

Estas páginas reproduzem somente a **estrutura mínima confirmada** na Admissão
Digital do Tangerino em uma sessão real e autorizada em 24/08/2026: busca por
nome, contêiner de cartões, nome do colaborador, Status da admissão e Status da
etapa. Não contêm dados copiados da conta usada no mapeamento.

Elas provam que o cliente lê a estrutura mapeada e — o mais importante — que
**retirar um elemento esperado produz `UI_CHANGED`, e nunca um status
inferido** (§65). Campos que o cartão real não expõe, como protocolo e data
efetiva da admissão, continuam opcionais e nunca são substituídos pela posição
do cartão ou pela data-limite exibida na interface.

Rodar: `npm run tangerino:fixtures`
