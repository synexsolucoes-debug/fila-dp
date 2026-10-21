# Movimentos para o Sankhya

Lançamento dos eventos variáveis da folha (horas extras, comissões, descontos,
adicionais) por colaborador e competência, com geração da planilha que o
Importador de Movimentos do Sankhya aceita. Fica na tela **Folha**, abaixo dos
indicadores.

## O que o módulo faz, e o que não faz

- **Faz**: guarda os lançamentos, confere cada um contra o catálogo de eventos
  e o cadastro do colaborador, e gera a planilha no layout do Importador.
- **Não faz**: não calcula salário, não converte hora em dinheiro e não grava
  nada no Sankhya. A planilha é importada pelo DP no Sankhya, como já era feito
  com a planilha montada à mão. Quem calcula a folha continua sendo o Sankhya.

## Layout da planilha

Uma aba (`Planilha1`), cabeçalho na linha 1, uma linha por movimento:

| Coluna | Origem |
|---|---|
| CODEMP | Código Sankhya da empresa (cadastro da empresa) |
| CODFUNC | `external_id` do colaborador importado do Sankhya (`CODEMP:CODFUNC`), ou a matrícula numérica |
| REFERENCIA | Primeiro dia da competência (data) |
| TIPMOV | Informado na tela; padrão `A`, o valor da planilha modelo |
| CODEVENTO | Evento escolhido no lançamento |
| SEQUENCIA | 0 no primeiro lançamento do colaborador naquele evento; 1, 2… nos seguintes, na ordem do lançamento |
| INDICE | Horas, dias ou quantidade (eventos de unidade H, D, Q) |
| VLRMOV | Valor em reais (eventos de unidade V) |
| TIPEVENTO | Do catálogo: 1 provento, -1 desconto, 0 informativo |
| UNIDADE | Do catálogo: V, H, D ou Q |

## Catálogo de eventos (TFPEVE)

O lançamento só aceita evento que está no catálogo do workspace. O catálogo é
importado da query da TFPEVE exportada do Sankhya (`Resultado da Query`, com as
colunas CODEVENTO, DESCREVENTO, UNIDADE, TIPEVENTO e ATIVO), em `.xlsx`. Se o
Sankhya exportar `.xls`, basta abrir no Excel e salvar como `.xlsx`.

A importação atualiza por código. Evento que não veio no arquivo continua como
estava: uma query filtrada não apaga o resto do catálogo.

## Conferência

Bloqueia (não grava e não exporta):

- evento fora do catálogo ou inativo;
- evento de valor (V) sem valor, ou evento de índice (H, D, Q) sem índice;
- índice e valor zerados ou negativos;
- colaborador que não é da empresa, ou desligado antes da competência.

Avisa (aparece na tabela, não impede):

- evento de índice com valor preenchido, ou evento de valor com índice;
- colaborador desligado na própria competência, afastado ou marcado como desligado.

Na exportação, também bloqueiam o arquivo inteiro: empresa sem Código Sankhya,
colaborador sem CODFUNC e evento que saiu do catálogo depois do lançamento. Uma
planilha com parte das linhas é pior que nenhuma: o Importador aceita e ninguém
percebe o que ficou de fora.

## Colar do Excel

Uma linha por lançamento — CODFUNC, CODEVENTO, ÍNDICE, VALOR —, separadas por
tabulação ou ponto e vírgula. Horas aceitam `2:30`. O lote entra inteiro ou não
entra, com a lista das linhas que impediram.

Também aceita cinco colunas, com o CODEMP na frente (CODEMP, CODFUNC,
CODEVENTO, ÍNDICE, VALOR), que é como a planilha de controle do DP já vinha. O
CODEMP da linha precisa ser o da empresa selecionada: linha de outra empresa é
recusada nomeando o código, porque lançá-la na selecionada levaria o movimento
para a folha errada. A contagem de colunas é pela linha crua, então uma linha
de cinco colunas com VALOR vazio continua sendo de cinco colunas.

## Responsável pela conferência

A tela mostra quem responde pela empresa na carteira do DP (Operação DP ›
Carteira): o titular, ou o backup quando o titular está ausente hoje. É essa
pessoa que confere e exporta. Empresa sem carteira aparece com o aviso para
definir o titular.

## Exportação e auditoria

Exportar marca os lançamentos com data e autor (`exported_at`, `exported_by`) —
a tabela mostra "Exportado em … por …" em cada linha e o resumo traz a última
exportação — e
registra `payroll_movements.exported` na auditoria, com competência e número de
linhas. Nome e valor não vão para a trilha. Lançamento exportado continua
removível: a folha é do Sankhya, e a trilha guarda que ele tinha saído.

## Permissões

- Ver: `hr.read`.
- Lançar, remover, importar o catálogo e exportar: `hr.write`.
- O escopo de empresa do membro vale em todas as rotas.

## Modelo de dados

Migration `0113_payroll_movements`:

- `fdp_payroll_event_catalog` — catálogo por workspace, único por código.
- `fdp_payroll_movement_entries` — lançamentos; valor em centavos, índice em
  `numeric(14,4)`, `CHECK` de que ao menos um dos dois é positivo.

Ambas com RLS forçada por `workspace_id`.
