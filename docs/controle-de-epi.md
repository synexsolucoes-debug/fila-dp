# Controle de EPI

Módulo operacional que acompanha a jornada completa do equipamento de proteção
individual: cadastro, entrega ao colaborador, troca por danificação, devolução,
higienização, descarte e análise de possível desconto.

O módulo não é um controle de almoxarifado nem um lançador de folha. Ele existe
para produzir **rastreabilidade**: quem recebeu o quê, quando, com qual CA, em
que condição devolveu, quem autorizou o descarte e quem decidiu sobre o
desconto — com evidência anexada em cada etapa.

## A regra que governa o módulo

**Desconto de EPI nunca é lançado automaticamente.**

Extravio, não devolução, dano por uso inadequado e solicitação manual abrem uma
*análise* — nunca um débito. A análise vira uma demanda no quadro do
Departamento Pessoal, com o título fixado pela especificação:

```
Analisar possível desconto de EPI — [Nome do colaborador]
```

O valor fica registrado como "em análise" até que alguém com
`epi.discount.analyze` decida. Mesmo "descontar integral" grava apenas o parecer
e o valor aprovado; a execução é da folha, com o registro em mãos.

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

Oito tabelas, todas com `workspace_id`, `company_id`, `created_at`,
`updated_at`, `created_by` e `updated_by`. Migration `0044_epi_control.sql`.

| Tabela | Papel |
| --- | --- |
| `fdp_epi_products` | Cadastro do EPI e saldo em estoque |
| `fdp_epi_deliveries` | Entrega ao colaborador, termo e baixa |
| `fdp_epi_returns` | Devolução, condição e destino |
| `fdp_epi_damages` | Ocorrência de dano, análise e decisão |
| `fdp_epi_disposals` | Janela de descarte |
| `fdp_epi_discount_requests` | Análise de desconto, ligada à demanda |
| `fdp_epi_movements` | Razão append-only de todas as movimentações |
| `fdp_epi_attachments` | Termos, fotos e evidências |

### O que o banco garante sozinho

Três invariantes ficam no schema porque não podem depender de disciplina de
quem escrever a próxima rota:

- **estoque nunca fica negativo** — `CHECK` em `stock_quantity`, e o débito é
  condicional na própria instrução (`WHERE … AND stock_quantity + ? >= 0`), de
  modo que duas entregas simultâneas disputando a última unidade terminam com
  uma delas recusada em vez de com saldo negativo;
- **devolução nunca soma mais do que foi entregue** — `CHECK` de
  `settled_quantity <= quantity`;
- **o razão é append-only** e **o descarte confirmado é imutável** — dois
  gatilhos. Depois de confirmado, o equipamento não volta ao estoque e o
  registro não aceita alteração.

Toda tabela tem RLS habilitada e forçada, com política por
`current_setting('app.workspace_id')`. As referências entre tabelas são
compostas (`workspace_id, company_id, id`), então apontar para a linha de outro
cliente não é representável.

## Permissões

Onze capacidades, na área "Controle de EPI" da tela de usuários:

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

1. **Cadastro** — EPI, tipo, CA, tamanho, marca, modelo, valor e quantidade. A
   entrada em estoque já é a primeira movimentação no razão.
2. **Entrega** — o estoque é debitado *antes* de a entrega ser gravada, porque é
   o débito que pode falhar. Falhou, nada mais acontece. Gravou e a entrega
   falhou depois, o saldo volta.
3. **Devolução** — a condição decide o destino (tabela acima). A baixa é
   registrada na entrega, e é ela que faz o colaborador deixar de constar com o
   equipamento.
4. **Troca por dano** — a decisão da análise governa o antigo e o novo.
5. **Descarte** — a janela recolhe o que a devolução e a troca encaminharam,
   mais o que for aberto à mão a partir do estoque. Confirmar exige responsável
   e data, e é definitivo. Descarte aberto do estoque debita o saldo na
   confirmação; o que veio de devolução ou troca já saiu na entrega, e debitar
   de novo tiraria duas unidades por uma.
6. **Análise de desconto** — abre demanda no quadro do DP; a decisão fica
   registrada na análise, no razão e na linha do tempo da própria demanda.

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
| `/api/epi/deliveries` | GET, POST | `epi.view`, `epi.deliver` |
| `/api/epi/deliveries/[id]` | GET, PATCH | `epi.view`, `epi.deliver` |
| `/api/epi/returns` | GET, POST | `epi.view`, `epi.return` |
| `/api/epi/damages` | GET, POST | `epi.view`, `epi.damage` |
| `/api/epi/disposals` | GET, POST | `epi.view`, `epi.dispose` |
| `/api/epi/disposals/[id]` | POST | `epi.dispose` |
| `/api/epi/discounts` | GET, POST | `epi.view`, `epi.discount.analyze` |
| `/api/epi/discounts/[id]` | GET, POST | `epi.view`, `epi.discount.analyze` |
| `/api/epi/employees/[id]` | GET | `epi.view` |
| `/api/epi/reports` | GET | `epi.view`, `epi.export` para CSV |
| `/api/epi/attachments` | GET, POST | `epi.view`, `epi.edit` |
| `/api/epi/attachments/[id]` | GET, DELETE | `epi.view`, `epi.edit` |

Todas aplicam o recorte por empresa do usuário: sem escopo, a resposta é vazia —
nunca "tudo".

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

A migration é aditiva — nenhuma tabela existente é removida ou reescrita — e
semeia o módulo em `fdp_modules` e em todos os planos. Entrega de EPI com termo
assinado é obrigação de segurança do trabalho de qualquer empresa com
colaborador, não recurso de porte; a decisão segue o precedente de "Usuários e
permissões", que também entra em todos os planos.

Ver `docs/aplicar-migracoes-em-producao.md` para o procedimento completo.
