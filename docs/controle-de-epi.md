# Controle de EPI

Módulo operacional que acompanha a jornada completa do equipamento de proteção
individual: cadastro, entrega ao colaborador, troca por danificação, devolução,
higienização, descarte e análise de possível desconto.

O módulo combina estoque operacional compartilhado e **rastreabilidade**: quem
recebeu o quê, quando, com qual CA, de qual local saiu, em que condição
devolveu, quem concluiu a higienização, quem autorizou o descarte e quem decidiu
sobre o desconto — com evidência anexada em cada etapa.

O SKU e o saldo pertencem ao workspace. A empresa do cadastro é apenas a origem
da compra; a empresa consumidora fica em cada entrega, devolução, dano,
descarte e movimentação. Assim, empresas do mesmo grupo usam o mesmo estoque
sem duplicar o produto por CNPJ.

## A regra que governa o módulo

**Desconto de EPI nunca é lançado automaticamente.**

Extravio, não devolução, dano por uso inadequado e solicitação manual abrem uma
*análise* — nunca um débito. A análise vira uma demanda no quadro do
Departamento Pessoal, com o título fixado pela especificação:

```
Analisar possível desconto de EPI — [Nome do colaborador]
```

O valor fica registrado como "em análise" até que alguém com
`epi.discount.analyze` decida. "Descontar integral" e "descontar parcialmente"
criam uma movimentação `epi_discount` em estado `draft` na Central de
Movimentações, com a competência e o valor aprovado. Essa movimentação é um
encaminhamento explícito: `automaticDeduction` permanece falso e nenhuma folha
ou salário é alterado automaticamente.

A separação está no banco, não só no código: `fdp_epi_discount_requests` aponta
para `fdp_cards` em vez de guardar um valor a descontar como fato consumado, e
dois `CHECK` recusam a decisão contraditória — aprovado para desconto com valor
zero, ou valor decidido acima do valor do próprio equipamento.

## O destino do EPI é consequência, não escolha

Na devolução, quem classifica a condição não marca "volta ao estoque". A
condição **determina** o destino, e a tela mostra a consequência antes de
gravar:

| Condição informada | Estoque | Higienização | Descarte | Demanda no DP |
| --- | --- | --- | --- | --- |
| Devolvido higienizado | volta | — | — | — |
| Devolvido pendente de higienização | — | sim | — | — |
| Devolvido danificado | — | — | sim | — |
| Devolvido inutilizado | — | — | sim | — |
| Devolvido para descarte | — | — | sim | — |
| Não devolvido | — | — | — | **sim** |
| Extraviado | — | — | — | **sim** |

A tabela vive em `returnRouting()` (`lib/epi.ts`), função pura usada pelo
servidor **e** pela tela. Uma segunda cópia divergiria, e a pessoa confirmaria
uma coisa enquanto outra aconteceria.

O mesmo vale para a troca por danificação, em `damageRouting()`:

| Decisão | Baixa do antigo | Descarte | Novo EPI | Demanda no DP |
| --- | --- | --- | --- | --- |
| Troca sem desconto | sim | sim | sim | — |
| Enviar para análise de desconto | sim | — | sim | **sim** |
| Recusar troca | — | — | — | — |
| Encaminhar para descarte | sim | sim | — | — |
| Encaminhar para higienização | sim | — | — | — |

"Recusar troca" não abre demanda: recusar a troca decide sobre o equipamento,
não sobre o salário. Quem quiser levar o caso ao DP abre a análise
explicitamente, e o registro da recusa fica como evidência.

## Estrutura de dados

A base do módulo está em `0044_epi_control.sql`; áreas, locais e o saldo
compartilhado são introduzidos por `0045_workspace_areas_shared_stock.sql`.

| Tabela | Papel |
| --- | --- |
| `fdp_epi_products` | Catálogo compartilhado de SKUs; `stock_quantity` é projeção compatível |
| `fdp_stock_locations` | Locais físicos do estoque do workspace |
| `fdp_stock_balances` | Fonte de verdade do saldo por SKU e local |
| `fdp_epi_deliveries` | Entrega ao colaborador, termo e baixa |
| `fdp_epi_returns` | Devolução, condição e destino |
| `fdp_epi_damages` | Ocorrência de dano, análise e decisão |
| `fdp_epi_disposals` | Janela de descarte |
| `fdp_epi_discount_requests` | Análise de desconto, ligada à demanda |
| `fdp_epi_movements` | Razão append-only de todas as movimentações |
| `fdp_epi_attachments` | Termos, fotos e evidências |
| `fdp_areas` | Áreas operacionais transversais às empresas |
| `fdp_area_members` | Vínculo N:N entre usuários e áreas, com área principal opcional |
| `fdp_area_module_assignments` | Roteamento de módulos para áreas responsáveis |

### O que o banco garante sozinho

Três invariantes ficam no schema porque não podem depender de disciplina de
quem escrever a próxima rota:

- **estoque nunca fica negativo** — `fdp_apply_stock_change` bloqueia o SKU com
  `FOR UPDATE` e aplica o delta em `fdp_stock_balances` somente quando o saldo do
  local continua não negativo. O evento operacional, o razão, o saldo e a
  auditoria são enviados no mesmo lote transacional;
- **`stock_quantity` não aceita escrita direta** — um gatilho restringe a
  coluna à projeção atualizada pela função de saldo;
- **devolução nunca soma mais do que foi entregue** — `CHECK` de
  `settled_quantity <= quantity`;
- **o razão é append-only** e **o descarte confirmado é imutável** — dois
  gatilhos. Depois de confirmado, o equipamento não volta ao estoque e o
  registro não aceita alteração.

Toda tabela tem RLS habilitada e forçada, com política por
`current_setting('app.workspace_id')`. As referências carregam
`workspace_id`; relações de uso preservam também a empresa consumidora. O
catálogo compartilhado não expõe entregas e movimentações de empresas fora do
escopo do usuário.

## Áreas operacionais

Áreas são independentes de CNPJ e não substituem departamentos ou lotações de
colaboradores. Um usuário pode participar de várias áreas e ter, no máximo, uma
área principal. As demandas guardam `requester_area_id` e
`responsible_area_id`, portanto origem e destino continuam consultáveis mesmo
quando pessoas mudam de equipe.

O roteamento do Controle de EPI usa duas atribuições configuráveis:
`epi.owner`, para a área solicitante (por exemplo SESMT), e
`epi.discount_analysis`, para a área responsável pela análise (por exemplo
Departamento Pessoal). Ausência de configuração gera erro explícito; o sistema
não escolhe uma área silenciosamente.

## Permissões

Doze capacidades, na área "Controle de EPI" da tela de usuários:

| Capacidade | Admin | Membro | Observador | Convidado |
| --- | --- | --- | --- | --- |
| `epi.view` | ✓ | ✓ | ✓ | — |
| `epi.create` | ✓ | ✓ | — | — |
| `epi.edit` | ✓ | ✓ | — | — |
| `epi.deliver` | ✓ | ✓ | — | — |
| `epi.return` | ✓ | ✓ | — | — |
| `epi.damage` | ✓ | ✓ | — | — |
| `epi.dispose` | ✓ | ✓ | — | — |
| `epi.discount.analyze` | ✓ | ✓ | — | — |
| `epi.export` | ✓ | ✓ | — | — |
| `epi.delete` | ✓ | — | — | — |
| `epi.audit.view` | ✓ | — | — | — |
| `epi.stock.adjust` | ✓ | ✓ | — | — |

O analista de DP opera o módulo inteiro. O que fica só com o administrador é dar
baixa em cadastro e ler a trilha de auditoria — as duas ações que serviriam para
encobrir as outras.

Negar o módulo `epi` a uma pessoa fecha as onze, não só a tela: `epi.audit.view`
entra em `moduleWriteCapabilities` justamente para que quem perdesse a tela não
continuasse lendo a trilha do EPI pela auditoria.

`epi.delete` é baixa, não exclusão: o cadastro passa a `inactive` e o histórico
fica. Um EPI com unidades em poder de colaboradores não é inativado — primeiro a
devolução, depois a baixa.

## Fluxo operacional

1. **Cadastro** — EPI, tipo, CA, tamanho, marca, modelo e valor. Uma quantidade
   inicial gera entrada no local escolhido e a primeira movimentação no razão.
2. **Entrada e transferência** — entradas somam ao local de destino;
   transferências debitam a origem e creditam o destino no mesmo lote.
3. **Entrega** — saldo, entrega, razão e auditoria são atômicos. Se o local não
   tiver quantidade suficiente, nada do evento é persistido.
4. **Devolução** — a condição decide o destino (tabela acima). A baixa é
   registrada na entrega, e é ela que faz o colaborador deixar de constar com o
   equipamento.
5. **Higienização** — itens pendentes passam por início e conclusão ou rejeição;
   somente a conclusão repõe o saldo no local registrado.
6. **Troca por dano** — a decisão da análise governa o antigo e o novo.
7. **Descarte** — a janela recolhe o que a devolução e a troca encaminharam,
   mais o que for aberto à mão a partir do estoque. Confirmar exige responsável
   e data, e é definitivo. Descarte aberto do estoque debita o saldo na
   confirmação; o que veio de devolução ou troca já saiu na entrega, e debitar
   de novo tiraria duas unidades por uma.
8. **Análise de desconto** — abre demanda roteada entre áreas; a decisão fica
   na análise, no razão e na linha do tempo. Aprovação cria um rascunho na
   Central de Movimentações, nunca um desconto automático.

## Telas

- **Painel do módulo** (`Controle de EPI`, seção "Pessoas e cadastros"): sete
  cartões — estoque, entregues, pendentes de assinatura, pendentes de
  higienização, aguardando descarte, descontos em análise, CA vencido ou
  vencendo. Cada cartão é atalho para a aba com o filtro já aplicado.
- **Abas**: Estoque, Entregas, Trocas e danos, Devoluções, Descarte, Descontos,
  Relatórios.
- **Aba "EPIs" no cadastro do colaborador**: EPIs ativos, entregas, devoluções,
  trocas, descartes, análises de desconto, anexos e a linha do tempo completa.
  A aba é de consulta — registrar acontece no módulo, onde estão as validações
  de estoque e a evidência.

## Relatórios

Treze relatórios, com filtro por empresa e período, visualização em tela e
exportação em CSV: estoque, entregas, EPIs por colaborador, por empresa/CNPJ,
devoluções, danificações, descartes, pendentes de higienização, descontos em
análise, entregas sem termo assinado, por CA, movimentações por competência e
histórico por colaborador.

A exportação exige `epi.export` e fica registrada na auditoria com o relatório e
o recorte pedidos — quem levou dado de colaborador para fora do produto é
informação que precisa sobreviver ao download. O CSV sai com BOM (para o Excel
em português abrir em UTF-8) e neutraliza campo que comece com `=`, que numa
planilha viraria fórmula executável.

## API

| Rota | Método | Permissão |
| --- | --- | --- |
| `/api/epi/overview` | GET | `epi.view` |
| `/api/epi/products` | GET, POST | `epi.view`, `epi.create` |
| `/api/epi/products/[id]` | GET, PATCH, DELETE | `epi.view`, `epi.edit`, `epi.delete` |
| `/api/epi/stock/locations` | GET, POST, PATCH | `epi.view`, `epi.stock.adjust` |
| `/api/epi/stock/entries` | POST | `epi.stock.adjust` |
| `/api/epi/stock/transfers` | POST | `epi.stock.adjust` |
| `/api/epi/deliveries` | GET, POST | `epi.view`, `epi.deliver` |
| `/api/epi/deliveries/[id]` | GET, PATCH | `epi.view`, `epi.deliver` |
| `/api/epi/returns` | GET, POST | `epi.view`, `epi.return` |
| `/api/epi/returns/[id]/sanitization` | POST | `epi.return` |
| `/api/epi/damages` | GET, POST | `epi.view`, `epi.damage` |
| `/api/epi/disposals` | GET, POST | `epi.view`, `epi.dispose` |
| `/api/epi/disposals/[id]` | POST | `epi.dispose` |
| `/api/epi/discounts` | GET, POST | `epi.view`, `epi.discount.analyze` |
| `/api/epi/discounts/[id]` | GET, POST | `epi.view`, `epi.discount.analyze` |
| `/api/epi/employees/[id]` | GET | `epi.view` |
| `/api/epi/reports` | GET | `epi.view`, `epi.export` para CSV |
| `/api/epi/attachments` | GET, POST | `epi.view`, `epi.edit` |
| `/api/epi/attachments/[id]` | GET, DELETE | `epi.view`, `epi.edit` |
| `/api/areas` | GET, POST | `departments.view`, `departments.create` |
| `/api/areas/[id]` | GET, PATCH, DELETE | permissões de área correspondentes |
| `/api/areas/[id]/members` | PUT | `departments.manage_members` |

Eventos com empresa consumidora aplicam o recorte de empresas do usuário: sem
escopo, a resposta é vazia — nunca "tudo". Catálogo, locais e saldos são do
workspace; no detalhe do SKU, as movimentações continuam filtradas por empresa.

## Anexos

Termo de entrega, foto do dano, comprovante de descarte. Mesmos limites dos
anexos de demanda: 20 MB por arquivo, PDF/imagem/TXT/CSV/DOCX/XLSX, e a **mesma
cota de armazenamento do plano** — a conferência soma `fdp_card_attachments` e
`fdp_epi_attachments` na instrução que grava, dentro de um lock, para que dois
envios simultâneos não passem juntos pela última fatia.

O anexo de um descarte já confirmado não pode ser removido: ele é a evidência do
ato que o banco tornou imutável.

## Aplicar em produção

```bash
npm run db:migrate
```

As migrations preservam o histórico. A `0045` cria um local padrão por workspace,
migra o saldo legado para esse local, troca as referências operacionais de
produto para a identidade `(workspace_id, product_id)` e mantém
`stock_quantity` como projeção. Faça backup e ensaie a migração conforme o
procedimento de produção antes da aplicação definitiva.

Ver `docs/aplicar-migracoes-em-producao.md` para o procedimento completo.
