# Engenharia reversa funcional — SAP HCM aplicado ao Departamento Pessoal

Análise do SAP Human Capital Management (ECC 6.0 / H4S4 no S/4HANA) feita a
partir de documentação pública (help.sap.com, nomes de transações e tabelas
de domínio público). Nada foi decompilado: o que se faz aqui é olhar como o
ERP de RH mais usado no mundo **modela** o trabalho do DP, separar o que vale
copiar do que o Vinculato não deve copiar, e registrar a decisão. O primeiro
resultado em código é o **Histórico funcional** (§4.27 de
`docs/arquitetura-operacional.md`).

## 1. Como o SAP HCM se divide

| Componente | Sigla | O que faz | Transações típicas |
| --- | --- | --- | --- |
| Personnel Administration | PA | Cadastro mestre do colaborador, em infotipos com validade | PA20 (exibir), PA30 (manter), PA40 (medidas) |
| Organizational Management | OM | Estrutura: unidades, posições, cargos, centros de custo e as relações entre eles | PPOME, PO13 |
| Time Management | PT | Ausências, presenças, cotas (férias) e avaliação de ponto | PA61, PT60 |
| Payroll | PY | Cálculo da folha, com retroatividade automática | PC00_M37_CALC (Brasil), PA03 |
| Benefits | BN | Planos de benefício e elegibilidade | HRBEN0001 |
| Self-services | ESS/MSS | Portal do colaborador e do gestor | — |

A localização Brasil (país 37) acrescenta infotipos próprios (documentos
brasileiros, por exemplo o IT0465), o cálculo de INSS/IRRF/FGTS e a geração do
eSocial.

## 2. O núcleo: infotipos com validade

O conceito que sustenta todo o resto do SAP HCM é o **infotipo**: um grupo de
campos de mesmo assunto, armazenado numa tabela própria (`PA0000`, `PA0001`…)
cuja chave é sempre:

```
PERNR (matrícula) + SUBTY (subtipo) + ENDDA (fim) + BEGDA (início) + SEQNR
```

Ou seja: **nenhum dado do colaborador existe sem data de validade**. A
pergunta "qual o cargo dele?" não tem resposta; "qual o cargo dele em
15/03/2025?" tem.

Infotipos relevantes para o DP:

| Infotipo | Conteúdo | Equivalente no Vinculato |
| --- | --- | --- |
| 0000 Medidas | Situação do vínculo (ativo, afastado, desligado) e a medida que a causou | `fdp_employees.employment_status` → **`situation`** no histórico |
| 0001 Atribuição organizacional | Empresa, área de RH, unidade, posição, cargo, centro de custo | departamento/cargo/CC/unidade → **`assignment`** |
| 0002 Dados pessoais | Nome, nascimento, estado civil | `fdp_employees` (sem histórico — correção, não mudança) |
| 0003 Status da folha | Data mais antiga de recálculo retroativo, travas | `fdp_payroll_cycles` (competência), parcialmente |
| 0006 Endereços | Endereços por subtipo | endereço do colaborador (§4.12) |
| 0007 Horário de trabalho teórico | Regra de jornada | `work_schedule_id` → **`schedule`** |
| 0008 Remuneração básica | Salário e rubricas fixas | **não replicado** (fronteira: não calcular folha) |
| 0009 Dados bancários | Conta de pagamento | — |
| 0014 / 0015 | Rubricas recorrentes / pagamentos adicionais | Adiantamentos e Descontos (`payroll_ledger`), como input conferido |
| 0041 Datas | Datas especiais (admissão para férias, etc.) | — |
| 2001 / 2002 / 2006 | Ausências, presenças, cotas | movimentações `leave`/`vacation`, conferência de ponto |

### 2.1 Restrição temporal (time constraint)

Cada infotipo declara uma restrição temporal (tabela `T582A`):

- **1** — o registro precisa existir em todo o período do vínculo, sem buraco e
  sem sobreposição (0000, 0001, 0007, 0008);
- **2** — pode ter buraco, não pode sobrepor;
- **3** — pode ter vários registros ao mesmo tempo (endereços de tipos
  diferentes, por exemplo).

A consequência de 1 é a operação central do PA30: **copiar e delimitar**.
Criar um registro com início em X encerra o registro vigente em X-1. O
anterior não é apagado — é ele que responde ao passado.

### 2.2 Medidas (actions)

Uma medida (`PA40`, tipos em `T529A`) é um roteiro que abre vários
infotipos na sequência certa e com a mesma data: "admissão" grava 0000,
0001, 0002, 0006, 0007, 0008…; "transferência" grava 0000 e 0001;
"desligamento" grava 0000 com status "desligado" a partir do dia seguinte ao
último dia trabalhado. O tipo e o motivo da medida (`MASSN`/`MASSG`) ficam no
próprio 0000, então a linha do tempo diz não só *o que* mudou, mas *por quê*.

### 2.3 Estrutura organizacional (OM)

OM modela objetos (`O` unidade, `S` posição, `C` cargo, `K` centro de
custo, `P` pessoa) em `HRP1000` e as relações entre eles em `HRP1001`, todos
também com validade. A pessoa ocupa uma **posição**, e a posição pertence a
uma unidade e descreve um cargo — por isso o 0001 é derivado do OM quando a
integração PA–OM está ligada.

## 3. Folha: o que observar e não copiar

O Payroll trabalha com **rubricas** (wage types, `T512W`) e com **esquemas e
regras de cálculo** (PCRs) que o cliente parametriza. Dois mecanismos são
instrutivos mesmo sem copiar o cálculo:

- **Registro de controle da folha (PA03)**: por área de folha, a competência
  passa por "liberada para folha" → "liberada para correção" → "encerrada".
  Enquanto está liberada para folha, o PA30 recusa mudanças retroativas para
  dentro do período. É o mesmo papel do fechamento de competência do Vinculato
  (§22), que já tem gates e reabertura com justificativa.
- **Retroatividade automática**: uma mudança com data no passado em infotipo
  relevante para a folha marca a data mais antiga de recálculo no 0003, e a
  próxima folha recalcula os meses afetados. O Vinculato não recalcula — mas
  pode **avisar** que uma movimentação retroativa atinge uma competência já
  fechada (ver §5).

O cálculo em si (INSS, IRRF, FGTS, médias, eSocial) é o que o §28 do
benchmark (`docs/evolucao-produto-2026-09/05-benchmark-lacunas-e-ideias.md`)
proíbe: custo regulatório infinito e concorrência com o sistema que o cliente
não vai trocar.

## 4. Comparativo e decisão

| Conceito SAP | Situação no Vinculato antes | Decisão |
| --- | --- | --- |
| Infotipos com validade (0000/0001/0007) | Só o estado atual em `fdp_employees`; transferência sobrescrevia | **Trazido**: `fdp_employee_history_records` (§4.27) |
| Copiar e delimitar | Inexistente | **Trazido**: `planHistoryChange` |
| Medida com motivo | Movimentação com tipo e aprovação (`fdp_employee_movements`) | Reaproveitado: o histórico guarda `reason` e `movement_id` |
| Leitura em data-base (dia-chave) | Inexistente | **Trazido**: `GET /api/employees/[id]/functional-history?at=` |
| Registro de controle da folha | Fechamento de competência com gates | Já existe; próximo passo é o alerta de retroatividade |
| OM com posição | Departamento e cargo como catálogos | Não trazido: posição como objeto só faz sentido com quadro de vagas |
| Rubricas e cálculo | Fora do produto por decisão | **Não trazido** |
| Salário (0008) | Fora do produto | **Não trazido** |

## 5. Próximos passos sugeridos, em ordem

1. **Alerta de retroatividade** — ao aplicar uma movimentação cuja
   `effective_date` cai numa competência já fechada, abrir pendência para o DP
   lançar a diferença no sistema de folha. É o 0003 do SAP sem o recálculo.
2. **Quadro em data-base** — relatório da empresa inteira numa data:
   quem estava ativo, onde e em qual jornada. Base para turnover correto
   (hoje o headcount usa o estado atual) e para defesa trabalhista.
3. **Importadores pelo histórico** — o espelho Sankhya passa a gravar pelo
   `prepareHistoryChange`, com a data de alteração que o ERP informar.
4. **Retorno de afastamento como movimentação** — hoje só existe pela edição
   do cadastro; com tipo próprio, ganha data retroativa e aprovação.
