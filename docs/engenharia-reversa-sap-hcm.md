# Engenharia reversa funcional do SAP HCM, aplicada ao Departamento Pessoal

> **O que é este documento.** Uma análise completa de como o SAP Human Capital
> Management modela o trabalho de DP — estrutura, dados, regras, processos e
> integrações — e de como cada peça se compara ao Vinculato. Serve para três
> coisas: decidir o que copiar, registrar o que **não** copiar, e dar ao time um
> vocabulário comum com clientes que vêm do SAP.
>
> **Método e limites.** Engenharia reversa *funcional*: tudo aqui vem de
> documentação pública da SAP (help.sap.com), de nomes de transações, tabelas e
> objetos de customização que são de domínio público, e da prática de
> implantação. Nenhum código da SAP foi lido, copiado ou decompilado. Onde um
> detalhe depende da versão ou da implantação do cliente, o texto diz.
>
> **Versões consideradas.** SAP ERP 6.0 (ECC, EHP8) e o *SAP HCM for SAP
> S/4HANA* (H4S4), que preserva o mesmo modelo. O sucessor em nuvem é o SAP
> SuccessFactors (Employee Central + Employee Central Payroll), que reaproveita
> o motor de folha do HCM on-premise.
>
> **Primeiro resultado em código:** o Histórico funcional (§4.27 de
> `docs/arquitetura-operacional.md`).

## Sumário

1. [Mapa do SAP HCM](#1-mapa-do-sap-hcm)
2. [Estrutura da empresa e estrutura de pessoal](#2-estrutura-da-empresa-e-estrutura-de-pessoal)
3. [Personnel Administration: infotipos](#3-personnel-administration-infotipos)
4. [Medidas e ações dinâmicas](#4-medidas-e-ações-dinâmicas)
5. [Organizational Management](#5-organizational-management)
6. [Time Management](#6-time-management)
7. [Payroll](#7-payroll)
8. [Localização Brasil e eSocial](#8-localização-brasil-e-esocial)
9. [Benefícios](#9-benefícios)
10. [Autorizações](#10-autorizações)
11. [Self-service, workflow e relatórios](#11-self-service-workflow-e-relatórios)
12. [Integrações](#12-integrações)
13. [Os processos de DP de ponta a ponta](#13-os-processos-de-dp-de-ponta-a-ponta)
14. [Comparativo item a item com o Vinculato](#14-comparativo-item-a-item-com-o-vinculato)
15. [O que copiar, o que não copiar](#15-o-que-copiar-o-que-não-copiar)
16. [Roadmap priorizado](#16-roadmap-priorizado)
17. [Glossário SAP ↔ DP brasileiro](#17-glossário-sap--dp-brasileiro)

---

## 1. Mapa do SAP HCM

| Componente | Sigla | Responsabilidade | Transações típicas |
| --- | --- | --- | --- |
| Personnel Administration | PA | Cadastro mestre do colaborador em infotipos com validade; medidas | PA20 (exibir), PA30 (manter), PA40 (medidas), PA42 (medidas rápidas), PA70 (entrada rápida) |
| Organizational Management | OM | Unidades, posições, cargos, centros de custo e relações, também com validade | PPOME, PPOCE, PO10/PO13/PO03, PP01 |
| Time Management | PT | Jornadas, feriados, ausências, presenças, cotas e avaliação de ponto | PA61/PA51, PT60, PT_QTA00, CAT2 (CATS) |
| Payroll | PY | Cálculo de folha, retroatividade, contabilização | PA03, PU03, PC00_M37_* (Brasil) |
| Benefits | BN | Planos, elegibilidade e inscrição | HRBEN0001 |
| Recruitment / Talent | PB / TM | Candidatos, vagas, desempenho | (fora do escopo de DP) |
| Self-services | ESS / MSS | Portal do colaborador e do gestor | Fiori / Portal |
| Reporting | — | Base lógica PNP/PNPCE, Ad Hoc Query, relatórios por data-chave | S_PH9_46000223 (Ad Hoc Query), SQ01 |

Tudo roda sobre o mesmo princípio, que é a ideia mais importante deste
documento: **nenhum dado de RH existe sem período de validade**. Isso vale para
o colaborador (infotipos), para a estrutura (objetos de OM), para a jornada
(regras de horário) e para a folha (períodos e retroatividade).

Faixas de numeração dos infotipos, que ajudam a ler qualquer tela do SAP:

| Faixa | Uso |
| --- | --- |
| 0000–0999 | Administração de pessoal (cadastro, contrato, remuneração) |
| 1000–1999 | Gestão organizacional (objetos e relações) |
| 2000–2999 | Gestão de tempos (ausências, presenças, cotas, eventos) |
| 4000–4999 | Recrutamento |
| 9000–9999 | Reservada ao cliente |

---

## 2. Estrutura da empresa e estrutura de pessoal

Antes de cadastrar qualquer pessoa, o SAP exige duas estruturas configuradas.
Elas determinam quase todas as regras que vêm depois.

### 2.1 Estrutura da empresa

| Nível | Campo | Significado | No Brasil | No Vinculato |
| --- | --- | --- | --- | --- |
| Mandante | MANDT | Instância de dados | — | Workspace |
| Empresa | BUKRS | Entidade legal (contabilidade) | Raiz do CNPJ | `fdp_companies` |
| Área de RH | WERKS | Agrupamento de pessoal com regras próprias | Normalmente uma por empresa ou por região | — |
| Subárea de RH | BTRTL | Subdivisão que determina feriados, jornadas e regras de folha | Liga-se ao estabelecimento (filial/CNPJ completo) | `fdp_establishments` (unidade) |

A subárea é o ponto de amarração das regras locais: calendário de feriados,
agrupamento de jornadas, agrupamento de rubricas e, na localização Brasil, o
estabelecimento usado no eSocial (S-1005).

### 2.2 Estrutura de pessoal

| Campo | Significado | Exemplos no Brasil | No Vinculato |
| --- | --- | --- | --- |
| Grupo de empregados (PERSG) | Relação com a empresa | Ativo, aposentado, estagiário, terceiro | `employment_type` (clt, intern, apprentice, temporary) |
| Subgrupo de empregados (PERSK) | Refinamento que controla folha e tempo | Mensalista, horista, diretor, aprendiz | — |
| Área de processamento de folha (ABKRS) | Quem roda junto, com o mesmo calendário | Mensal, quinzenal, pró-labore | Competência por empresa (`fdp_payroll_cycles`) |
| Chave organizacional (VDSK1) | Campo livre usado em autorização | Diretoria, regional | — |

**Lição para o Vinculato:** o SAP separa *o que a pessoa é* (grupo/subgrupo)
de *onde ela está* (área/subárea/unidade) e de *com quem a folha roda* (área de
processamento). O Vinculato mistura as duas primeiras em `employment_type` e
ainda não tem a terceira — a competência é por empresa, não por grupo de folha.

---

## 3. Personnel Administration: infotipos

### 3.1 Estrutura física

Cada infotipo é uma tabela `PAnnnn` (por exemplo `PA0001`). Toda tabela de
infotipo começa com a mesma chave (estrutura `PAKEY`):

| Campo | Significado |
| --- | --- |
| PERNR | Número pessoal (matrícula). Único no mandante, não por empresa |
| SUBTY | Subtipo (ex.: tipo de endereço, tipo de dependente) |
| OBJPS | Identificação do objeto (ex.: qual filho) |
| SPRPS | Indicador de bloqueio (registro criado e ainda não liberado) |
| ENDDA | Fim da validade |
| BEGDA | Início da validade |
| SEQNR | Sequencial para registros com a mesma chave |

Depois vêm os campos administrativos (estrutura `PSHD1`: quem alterou, quando,
motivo) e os campos de negócio. A "data alta" `31.12.9999` significa "até
segunda ordem".

### 3.2 Restrição temporal

Configurada por infotipo e subtipo (tabela `T582A` e `T591A`):

| Restrição | Regra | Exemplos |
| --- | --- | --- |
| **1** | Precisa existir sem buraco durante todo o vínculo; nunca sobrepõe | 0000, 0001, 0002, 0007, 0008 |
| **2** | Pode ter buraco; nunca sobrepõe | 0006 (por subtipo), 0009 |
| **3** | Pode haver vários registros vigentes ao mesmo tempo | 0014, 0015, 0021 |
| A / B / T | Variações: registro único para sempre, opcional único, ou definida pelo subtipo | 0003 (A) |

A operação que nasce da restrição 1 é **copiar e delimitar**: criar um registro
com início em X encerra o vigente em X−1. Alterar (sem copiar) corrige o
registro existente sem gerar histórico — é a diferença entre *mudança* e
*correção*, que o SAP deixa explícita na tela (botões "Copiar" e "Modificar").

### 3.3 Catálogo dos infotipos que importam para o DP

| Infotipo | Nome | Conteúdo principal | Restrição | Vinculato hoje |
| --- | --- | --- | --- | --- |
| 0000 | Medidas | Tipo e motivo da medida; status do vínculo (`STAT2`) | 1 | `employment_status` + **histórico `situation`** |
| 0001 | Atribuição organizacional | Empresa, área/subárea, grupo/subgrupo, posição, cargo, unidade organizacional, centro de custo, área de folha | 1 | Departamento, cargo, CC, unidade + **histórico `assignment`** |
| 0002 | Dados pessoais | Nome, nome social, nascimento, sexo, estado civil, nacionalidade | 1 | `fdp_employees` (sem histórico) |
| 0003 | Status da folha | Data mais antiga de retroatividade, folha executada até, bloqueios | A | — (ver §7.4) |
| 0006 | Endereços | Por subtipo (residencial, correspondência, emergência) | 2/3 | Endereço do colaborador (§4.12) |
| 0007 | Horário de trabalho teórico | Regra de horário, percentual de jornada, horas semanais | 1 | `work_schedule_id` + **histórico `schedule`** |
| 0008 | Remuneração básica | Salário e rubricas fixas, nível/faixa salarial | 1 | **Não replicado** (fronteira) |
| 0009 | Dados bancários | Conta principal e secundárias | 2 | — |
| 0014 | Pagamentos/descontos recorrentes | Rubrica, valor, período | 3 | Adiantamentos e Descontos (parcelas) |
| 0015 | Pagamentos adicionais | Rubrica, valor, data | 3 | Adiantamentos e Descontos (avulsos) |
| 0016 | Elementos contratuais | Tipo de contrato, experiência, aviso prévio | 1 | Aba **Contrato** (`fdp_employee_contract_terms`) |
| 0019 | Tarefas monitoradas | Prazos: fim de experiência, exame, renovação | 3 | Motor de Prazos (ASO, treinamento, CAT) |
| 0021 | Família / dependentes | Dependentes para IR, salário-família, plano de saúde | 3 | — |
| 0041 | Datas especiais | Data de admissão para férias, antiguidade, etc. | 1 | — |
| 0105 | Comunicação | E-mail, telefone, usuário do sistema | 2/3 | E-mail e telefone em `fdp_employees` |
| 0185 | Documentos de identificação | RG, CTPS, PIS, CNH (por subtipo) | 3 | CPF protegido por HMAC; demais na ficha de admissão |
| 0465 | Documentos (países) | Documentos com estrutura por país, usado pela localização Brasil | 3 | Ficha cadastral (Sólides) |
| 2001 | Ausências | Férias, licenças, afastamentos, faltas | 3* | Movimentações `vacation`, `leave` |
| 2002 | Presenças | Treinamento, viagem, horas extras aprovadas | 3* | Conferência de ponto |
| 2006 | Cotas de ausência | Saldo de férias por período aquisitivo | 3 | — |
| 2010 | Informação de remuneração | Lançamentos de tempo que viram valor (adicional, sobreaviso) | 3 | — |
| 2011 | Eventos de tempo | Marcações de ponto | 3 | Espelho de ponto (Tangerino) |

\* Ausências e presenças permitem sobreposição controlada por tabela de
colisão (`T554Y`): o SAP decide por tipo se uma férias pode coexistir com um
afastamento.

### 3.4 Status do vínculo (`STAT2` no 0000)

| Valor | Significado | Equivalente |
| --- | --- | --- |
| 3 | Ativo | `active` |
| 1 | Inativo (vínculo suspenso, ex.: afastamento longo) | `on_leave` |
| 2 | Aposentado | — |
| 0 | Desligado | `terminated` |

O status vem **da medida**, não é editado à mão — por isso o SAP sempre sabe
por que a pessoa está desligada e desde quando.

### 3.5 Bloqueio e liberação

`SPRPS` permite criar um registro "bloqueado" que só passa a valer depois que
outra pessoa libera. É o mecanismo de dupla checagem do SAP — equivalente à
aprovação atribuída das movimentações do Vinculato, só que no nível do dado,
não do processo.

---

## 4. Medidas e ações dinâmicas

### 4.1 Medidas (PA40)

Uma medida é um **roteiro**: abre, na ordem certa e com a mesma data, a
sequência de infotipos que um evento de RH exige.

| Objeto de customização | Função |
| --- | --- |
| `T529A` — tipos de medida | Admissão, transferência, mudança salarial, desligamento, reintegração… e qual `STAT2` cada uma grava |
| `T530` — motivos | Por tipo: "pedido de demissão", "dispensa sem justa causa", "promoção por mérito"… |
| `T588D` — grupos de infotipos | A sequência de telas de cada medida (admissão: 0000 → 0001 → 0002 → 0006 → 0007 → 0008 → 0009 → 0021…) |
| `T588C` / `T588B` | Menus e variantes de tela |

Tipo e motivo ficam gravados no 0000 (`MASSN`/`MASSG`). A linha do tempo diz
não só *o que* mudou, mas *por quê* — e é daí que o eSocial do SAP deriva, por
exemplo, o motivo de desligamento do S-2299.

**No Vinculato:** `fdp_employee_movements` já é a medida — tem tipo, aprovação
atribuída e, desde o Motor de Jornadas (§4.16–4.17), aplicação. O que faltava
era o efeito ter data de validade, e é isso que o Histórico funcional trouxe
(`reason` + `movement_id` em cada registro).

### 4.2 Ações dinâmicas (`T588Z`)

Regras do tipo "quando o infotipo X mudar no campo Y, faça Z": abrir outro
infotipo com valores sugeridos, criar uma tarefa monitorada (0019), mandar
e-mail, iniciar workflow. Exemplos clássicos:

- mudou o 0001 de área de folha → abrir o 0003 para conferir retroatividade;
- admissão → criar tarefas monitoradas de fim de experiência em 45 e 90 dias;
- desligamento → delimitar recorrentes (0014) e benefícios.

**No Vinculato:** é exatamente o papel das regras de automação por evento de
domínio (`lib/domain-event-automations.ts`). A diferença: lá a regra é
customização técnica em tabela, aqui é configuração do cliente com condições.
Copiar o *conceito* (gatilho por mudança de dado com data) e não a *forma*.

### 4.3 Medidas rápidas e entrada em massa

PA42 (medida rápida em tela única) e PA70 (um infotipo para muitas pessoas) são
o que o DP usa no dia a dia: reajuste coletivo, lançamento de horas em lote.
**No Vinculato:** importação de planilha (adiantamentos, catálogo Sankhya,
ponto) cumpre o mesmo papel.

---

## 5. Organizational Management

### 5.1 Objetos e relações

| Objeto | Letra | Exemplo | Vinculato |
| --- | --- | --- | --- |
| Unidade organizacional | O | Diretoria Financeira, Gerência de DP | Departamento / Área |
| Posição | S | "Analista de DP Pleno — vaga 3" | — |
| Cargo | C | Analista de DP (descrição genérica, CBO) | `fdp_positions` (catálogo) |
| Pessoa | P | O colaborador | `fdp_employees` |
| Centro de custo | K | Vem do CO | `fdp_cost_centers` |

Tabelas: `HRP1000` (objetos), `HRP1001` (relações), `HRP1002` (descrições),
`HRP1007` (vaga), `HRP1008` (atribuição contábil), `HRP1013` (grupo/subgrupo
padrão da posição). Todas com `BEGDA`/`ENDDA` e versão de plano (`PLVAR`,
normalmente `01` para o plano vigente).

Relações mais usadas (A = de baixo para cima, B = de cima para baixo):

| Relação | Significado |
| --- | --- |
| A/B 002 | Subordinação (unidade → unidade; posição → posição) |
| A/B 003 | Pertence a (posição → unidade) |
| A/B 007 | Descreve (cargo → posição) |
| A/B 008 | Titular (pessoa → posição) |
| A/B 011 | Atribuição de centro de custo |
| A/B 012 | Chefia (posição → unidade que ela gerencia) |

### 5.2 Integração PA–OM

Com a integração ligada (`T77S0`, grupo PLOGI), o 0001 deixa de ser digitado:
o usuário escolhe a **posição**, e o SAP deriva cargo, unidade, centro de
custo e chefe a partir das relações. A pessoa "herda" a estrutura.

### 5.3 Caminhos de avaliação

`T778A` define percursos pela estrutura (ex.: `O-S-P` = todas as pessoas de
uma unidade; `MSSDIREC` = subordinados diretos de um gestor). São usados em
relatório, autorização estrutural e MSS. **No Vinculato:** o Portal do Gestor
(§4.20) usa `manager_employee_id` — uma relação pessoa→pessoa, e não posição→
unidade. Mais simples, e suficiente enquanto não houver quadro de vagas.

---

## 6. Time Management

### 6.1 Jornada

| Peça | Tabela | Função |
| --- | --- | --- |
| Horário diário | `T550A` | Entrada, saída, intervalos, tolerâncias de um dia |
| Horário periódico | `T551A` | Sequência de horários diários (ex.: 6×1, 12×36) |
| Regra de horário | `T508A` | Horário periódico + calendário de feriados + data de referência |
| Calendário de feriados | SCAL | Feriados nacionais, estaduais e municipais por subárea |

O 0007 aponta para a regra de horário. Com isso o SAP sabe, para qualquer dia,
quantas horas a pessoa *deveria* trabalhar — o "horário teórico" contra o qual
o ponto é avaliado.

**No Vinculato:** `fdp_work_schedules` é catálogo de jornada; não modela o dia
a dia nem feriados locais (lacuna 14 do benchmark: unidade com feriados).

### 6.2 Ausências e presenças

Tipos em `T554S`, regras de contagem em `T556C` (dias corridos × úteis ×
horas), colisões em `T554Y`. Ausências que reduzem cota (férias) apontam para
o 2006.

### 6.3 Cotas (férias)

O 2006 guarda o saldo por período. A geração automática (relatório
`RPTQTA00` ou pela avaliação de tempos) usa regras por subgrupo. Na localização
Brasil, o período aquisitivo de 12 meses, as faltas que reduzem dias de férias
(art. 130 da CLT) e o abono pecuniário são tratados por configuração e regras
de cálculo específicas do país.

### 6.4 Avaliação de tempos

Programa `RPTIME00`, guiado por um esquema (ex.: `TM00` para registro
positivo, `TM04` para registro negativo/por exceção). Compara marcações (2011)
com o horário teórico, gera saldos (banco de horas), horas extras e
adicionais, e grava no cluster B2. O resultado alimenta a folha por rubricas
de tempo.

**No Vinculato:** a conferência de ponto (`docs/conferencia-de-ponto.md`) é o
lado de *conferência*; o cálculo é do sistema de ponto homologado. É a
fronteira certa: avaliação de tempos é Portaria 671 e REP.

---

## 7. Payroll

### 7.1 Peças do motor

| Peça | Onde | Função |
| --- | --- | --- |
| Driver de folha | `PC00_M37_CALC` (Brasil) | Executa a folha de uma área de processamento |
| Esquema | PE01 | Programa de alto nível: sequência de funções |
| Regra de cálculo (PCR) | PE02 | Lógica condicional sobre rubricas |
| Funções e operações | PE04 | Blocos ABAP que esquemas e regras chamam |
| Rubricas | `T512W` | Cada verba: classes de processamento, acumulação, avaliação |
| Períodos | `T549A`, `T549Q` | Calendário de cada área de processamento |

### 7.2 Rubricas (wage types)

Rubricas de diálogo (digitadas: 0008, 0014, 0015, 2010), técnicas (`/xxx`,
geradas pelo cálculo, ex.: bases e totais) e de país. Cada rubrica carrega:

- **classes de processamento** — como ela se comporta no esquema (fracionar
  por dias, ir para média, compor base);
- **classes de acumulação** — em quais bases entra (INSS, FGTS, IRRF, médias);
- **classes de avaliação** — onde aparece (contracheque, relatórios).

É a mesma ideia da "tabela de incidências" de qualquer folha brasileira, e o
mesmo dado que o eSocial pede no S-1010.

### 7.3 Registro de controle (PA03)

Por área de processamento, um estado que trava o cadastro:

| Estado | Efeito no cadastro |
| --- | --- |
| Liberado para folha | Proíbe alterar, para o período em processamento, infotipos relevantes para a folha |
| Liberado para correção | Permite corrigir; a pessoa corrigida entra na lista de recálculo |
| Verificar resultados | Período sendo conferido |
| Encerrar folha | Período fechado; o próximo período abre |

**No Vinculato:** o fechamento de competência com gates (§22) e reabertura com
justificativa já é este mecanismo, do lado do processo.

### 7.4 Retroatividade

Qualquer mudança com data no passado em infotipo relevante para a folha
marca, no 0003, a data mais antiga a recalcular. A próxima execução recalcula
os períodos afetados, compara com o que foi pago e lança só a diferença. Um
limite (data mais antiga permitida) impede reabrir o passado distante.

**No Vinculato:** não recalcula — e não deve. Mas o *sinal* é valioso e
barato: uma movimentação aplicada com data dentro de uma competência fechada
deveria abrir pendência para o DP lançar a diferença no sistema de folha.
Primeiro item do roadmap.

### 7.5 Resultados e contabilização

Resultados ficam em cluster (`PCL2`), com tabelas internas como `RT`
(resultado), `CRT` (acumulados), `WPBP` (dados de trabalho por período) e `BT`
(transferências bancárias). A contabilização gera documentos no FI/CO
(`PC00_M99_CIPE`). Folhas fora de ciclo (off-cycle) cobrem rescisão,
adiantamento e correção avulsa.

### 7.6 Por que o Vinculato não copia esta parte

O §28 do benchmark (`docs/evolucao-produto-2026-09/05-benchmark-lacunas-e-ideias.md`)
proíbe folha própria: tabelas de INSS/IRRF, CCTs, médias, retificações e
eSocial são custo regulatório infinito, e o cliente não troca o sistema de
folha. O valor do Vinculato é **antes** (preparar e conferir input) e
**depois** (conferir resultado, acompanhar pagamento) da folha.

---

## 8. Localização Brasil e eSocial

### 8.1 O que a localização acrescenta

- Infotipos e campos de documentos brasileiros (CTPS, PIS/NIS, título de
  eleitor, certificado de reservista), dependentes para IR e salário-família.
- Cálculo de INSS, IRRF, FGTS, 13º salário, férias com 1/3, médias de
  variáveis, rescisão (TRCT) e provisões.
- Relatórios e arquivos legais. As obrigações legadas (SEFIP/GFIP, CAGED,
  RAIS, DIRF) foram substituídas por eSocial, DCTFWeb, FGTS Digital e
  EFD-Reinf; implantações antigas ainda carregam os geradores antigos.

### 8.2 eSocial no SAP

A solução de eSocial da SAP lê os infotipos e os resultados de folha, gera os
eventos em tabelas de preparação, valida, e transmite por middleware (SAP PI/PO
ou Cloud Integration), recebendo recibos e erros de volta. O mapa evento ×
origem é o melhor resumo de "qual dado de DP precisa existir, e quando":

| Evento | Assunto | Origem no SAP | Onde o Vinculato toca |
| --- | --- | --- | --- |
| S-1000 | Empregador | Empresa | `fdp_companies` |
| S-1005 | Estabelecimentos e obras | Subárea / filial | `fdp_establishments` |
| S-1010 | Rubricas | `T512W` + incidências | — (folha) |
| S-1020 | Lotações tributárias | Lotação/CC | Centro de custo (parcial) |
| S-1200 | Remuneração | Resultado da folha | — (folha) |
| S-1210 | Pagamentos | Resultado da folha | Pagamentos PJ/psicólogos são outro regime |
| S-2190 | Admissão preliminar | Medida de admissão | Sólides (fronteira) |
| S-2200 | Admissão | 0000/0001/0002/0007/0008… | Sólides; Vinculato recebe já admitido |
| S-2205 | Alteração cadastral | 0002/0006/0185/0021 | Edição do cadastro |
| S-2206 | Alteração contratual | 0001/0007/0008/0016 | **Histórico funcional** (lotação e jornada) |
| S-2210 | CAT | Saúde e segurança | Acidentes de trabalho, CAT pendente (§4.13) |
| S-2220 | ASO | Saúde e segurança | Exames ocupacionais (§4.8) |
| S-2230 | Afastamento temporário | 2001 | Movimentação `leave` → histórico `situation` |
| S-2240 | Condições ambientais | Saúde e segurança | Cargo com grau de risco (§4.6), EPI |
| S-2299 | Desligamento | Medida de desligamento + rescisão | Movimentação `termination` → histórico `situation` |
| S-2300 | TSVE — início | Estagiário, diretor sem vínculo | `employment_type = intern` (parcial) |
| S-3000 | Exclusão de evento | Correção | — |

**Leitura para o Vinculato:** o eSocial é organizado exatamente em "o que
mudou, desde quando". Um S-2206 retificador pergunta a lotação e a jornada
*numa data* — a pergunta que o Histórico funcional passou a responder. O
Vinculato não deve transmitir eSocial (§28), mas pode **conferir** o que o
sistema de folha transmitiu contra o histórico que ele mantém.

---

## 9. Benefícios

O componente BN modela planos (saúde, odontológico, previdência, seguro de
vida), regras de elegibilidade por grupo/subgrupo e área, períodos de
inscrição e custos empregado/empregador, gerando rubricas para a folha. No
Brasil, vale-transporte, vale-refeição e vale-alimentação costumam ser
tratados como rubricas e infotipos da localização, e não pelo BN.

**No Vinculato:** o módulo de Benefícios auxiliar controla entrega e
aprovação por competência, e o complemento Caju cuida do saldo livre de PJ.
Nada disso deve virar motor de elegibilidade — é cadastro de plano do
fornecedor.

---

## 10. Autorizações

O SAP HCM tem o modelo de autorização mais granular do mercado de RH:

| Objeto | Campos | Controla |
| --- | --- | --- |
| P_ORGIN | Infotipo, subtipo, nível (ler/gravar/bloquear), área, subárea, grupo, subgrupo, chave organizacional | Acesso a infotipos por estrutura da empresa e de pessoal |
| P_ORGINCON | Mesmo que P_ORGIN + perfil estrutural | Acesso combinado com a árvore de OM |
| P_PERNR | Infotipo, subtipo, nível, "pessoa própria" | O que a pessoa vê de si mesma; impede alterar o próprio salário |
| PLOG | Tipo de objeto, infotipo, plano | Manutenção da estrutura OM |
| P_PCLX | Cluster | Acesso a resultados de folha e tempo |
| Perfis estruturais | Caminho de avaliação a partir da posição do usuário | "Vejo só minha diretoria" |

**No Vinculato:** capacidades por papel (`lib/authorization.ts`), acesso por
empresa (`requireCompanyAccess`), negação por módulo (`lib/modules.ts`) e
segregação contra autoaprovação. Duas ideias do SAP que valem estudo:

1. **Autorização por campo sensível**, não só por tela — o equivalente a
   P_ORGIN por infotipo. O Vinculato já faz isso pontualmente (CPF em HMAC,
   psicologia sem dado clínico), mas não como regra geral.
2. **"Pessoa própria" (P_PERNR)** — impedir que alguém altere ou aprove algo
   sobre si mesmo. Já existe na segregação de aprovação; vale aplicar ao
   cadastro quando o Portal do Colaborador existir.

---

## 11. Self-service, workflow e relatórios

### 11.1 ESS / MSS

O colaborador atualiza endereço, banco e dependentes, pede férias e consulta
contracheque; o gestor aprova, vê a equipe e inicia medidas (promoção,
transferência). Tudo o que o colaborador grava passa por workflow antes de
virar infotipo.

**No Vinculato:** Portal do Gestor (§4.20) e links assinados (ciência de EPI,
nota fiscal PJ). O Portal do Colaborador é lacuna 5 do benchmark.

### 11.2 Workflow

SAP Business Workflow (SWDD) com agentes resolvidos pela estrutura OM ("chefe
da unidade do solicitante"). **No Vinculato:** o motor de processos com
etapas, aprovação atribuída e BPMN para administradores cumpre esse papel, com
agente resolvido por pessoa/área.

### 11.3 Relatórios por data-chave

A base lógica PNP/PNPCE dá a todo relatório de RH dois parâmetros fixos:

- **período de seleção de pessoas** — quem entra no relatório;
- **período/data de seleção de dados** — qual registro de cada infotipo ler.

Relatório de quadro de pessoal "em 31/12/2025" é trivial no SAP porque todo
dado tem validade. **No Vinculato:** os indicadores de DP (turnover, headcount
médio) leem o estado atual; com o Histórico funcional, o quadro em data-base
passa a ser possível (item 2 do roadmap).

---

## 12. Integrações

| Mecanismo | Uso típico |
| --- | --- |
| `HR_INFOTYPE_OPERATION` (módulo de função) | Gravar infotipo respeitando as mesmas validações da tela |
| BAPIs de colaborador (`BAPI_EMPLOYEE_ENQUEUE`/`DEQUEUE` e afins) | Bloquear o número pessoal antes de gravar |
| ALE / IDoc `HRMD_A` | Replicar dados mestres de RH entre sistemas |
| Interface Toolbox (PU12) | Exportar dados para folha terceirizada ou sistemas externos |
| SAP PI/PO, Cloud Integration | eSocial, bancos, operadoras de benefício |
| SuccessFactors Employee Central | Cadastro na nuvem, replicando para o Payroll on-premise ou ECP |

**Lição para o Vinculato:** toda escrita externa no SAP passa pela mesma
validação da tela (`HR_INFOTYPE_OPERATION`). O Vinculato tem o problema
oposto: os importadores (Sankhya) escrevem em `fdp_employees` por fora das
rotas que validam e registram histórico. Item 3 do roadmap.

---

## 13. Os processos de DP de ponta a ponta

Cada fluxo abaixo mostra o que o SAP faz, o evento legal e onde o Vinculato
atua hoje.

### 13.1 Admissão

| Passo | SAP | eSocial | Vinculato |
| --- | --- | --- | --- |
| Preparar | Candidato aprovado (Recruitment) ou planilha | — | Sólides (fronteira declarada) |
| Registrar | PA40 "Admissão": 0000, 0001, 0002, 0006, 0007, 0008, 0009, 0021, 0185 | S-2190 / S-2200 | Pessoa entra já admitida (Sólides/manual); ficha cadastral, OCR |
| Exame | Tarefa monitorada (0019) | S-2220 | Exame admissional (§4.8) |
| Prazos | Ações dinâmicas: fim de experiência | — | Motor de Prazos |

### 13.2 Transferência / promoção

| Passo | SAP | eSocial | Vinculato |
| --- | --- | --- | --- |
| Solicitar | MSS ou DP | — | Movimentação `transfer` com aprovação atribuída |
| Aplicar | PA40 "Transferência": copia 0000 e 0001 (e 0008 se promoção) com a data | S-2206 | Aplicação (§4.17) → **histórico `assignment`** |
| Retroativa | 0003 marca recálculo | S-2206 retificador | Histórico aceita data retroativa; **falta o alerta de competência fechada** |

### 13.3 Afastamento

| Passo | SAP | eSocial | Vinculato |
| --- | --- | --- | --- |
| Registrar | 2001 com tipo de afastamento; medida muda `STAT2` se longo | S-2230 | Movimentação `leave` → histórico `situation` |
| Retorno | Fim do 2001; exame de retorno | S-2230 (término), S-2220 | Edição do cadastro; trava por ASO inapto (§4.9). **Falta movimentação de retorno** |

### 13.4 Férias

| Passo | SAP | eSocial | Vinculato |
| --- | --- | --- | --- |
| Saldo | 2006 gerado por regra | — | — |
| Programar | ESS → workflow → 2001 | — | Movimentação `vacation` |
| Pagar | Folha (off-cycle ou regular) com médias | S-1200 | — (folha) |

### 13.5 Folha mensal

| Passo | SAP | Vinculato |
| --- | --- | --- |
| Abrir período | PA03 liberado para folha | Abrir competência (`fdp_payroll_cycles`) |
| Input | 0014/0015/2010, ponto (RPTIME00) | Movimentações, adiantamentos e descontos, conferência de ponto, benefícios, PJ |
| Simular e conferir | Simulação, relatórios de conferência | Conferência de pré-fechamento, pendências bloqueantes |
| Calcular | PC00_M37_CALC | — (sistema de folha) |
| Conferir resultado | Wage type reporter | Conferência de pós-fechamento, importação de PDF de folha |
| Fechar | PA03 encerrar | Fechar competência com gates |
| Contabilizar / pagar | PC00_M99_CIPE, DME bancário | — / acompanhamento de pagamento |

### 13.6 Desligamento

| Passo | SAP | eSocial | Vinculato |
| --- | --- | --- | --- |
| Solicitar | MSS / DP | — | Movimentação `termination` |
| Aplicar | PA40 "Desligamento": 0000 com `STAT2 = 0` a partir do dia seguinte ao último dia; delimitação de 0014, benefícios | S-2299 | Aplicação → **histórico `situation` a partir do dia seguinte** |
| Rescisão | Folha off-cycle, TRCT | S-2299 com verbas | — (folha) |
| Exame | Demissional | S-2220 | Exame ocupacional |
| Devoluções | — | — | Devolução de EPI, desconto por dano |

---

## 14. Comparativo item a item com o Vinculato

Legenda: ✅ existe · 🟡 parcial · 🆕 trazido nesta análise · ⛔ fora por decisão · ⬜ lacuna

| Área | Conceito SAP | Vinculato | Status |
| --- | --- | --- | --- |
| Estrutura | Empresa (BUKRS) | `fdp_companies` | ✅ |
| Estrutura | Subárea / estabelecimento | `fdp_establishments` | ✅ |
| Estrutura | Grupo e subgrupo de empregados | `employment_type` | 🟡 |
| Estrutura | Área de processamento de folha | Competência por empresa | 🟡 |
| Cadastro | Infotipos com validade (0000/0001/0007) | `fdp_employee_history_records` | 🆕 |
| Cadastro | Copiar × modificar | Movimentação (com data) × edição (hoje) | 🆕 |
| Cadastro | Dados pessoais (0002) | `fdp_employees` | ✅ |
| Cadastro | Endereços (0006) | Endereço do colaborador | ✅ |
| Cadastro | Dados bancários (0009) | — | ⬜ |
| Cadastro | Dependentes (0021) | — | ⬜ |
| Cadastro | Documentos (0185/0465) | Ficha cadastral, CPF em HMAC | 🟡 |
| Cadastro | Elementos contratuais (0016): experiência, aviso | Aba Contrato, prazos na Central | 🆕 |
| Cadastro | Bloqueio e liberação (SPRPS) | Aprovação atribuída da movimentação | ✅ |
| Medidas | Tipos e motivos de medida | Tipos de movimentação; motivo em texto | 🟡 |
| Medidas | Grupos de infotipos por medida | Detalhes por tipo de movimentação | 🟡 |
| Medidas | Ações dinâmicas | Automações por evento de domínio | ✅ |
| Medidas | Tarefas monitoradas (0019) | Motor de Prazos | ✅ |
| OM | Unidade organizacional | Departamento / área | ✅ |
| OM | Posição e quadro de vagas | — | ⬜ |
| OM | Cargo com descrição e requisitos | Cargo com grau de risco e atividades | 🟡 |
| OM | Chefia por estrutura | `manager_employee_id` | 🟡 |
| OM | Histórico da estrutura | — | ⬜ |
| Tempo | Horário teórico e feriados | Catálogo de jornadas | 🟡 |
| Tempo | Ausências (2001) | Movimentações `vacation`/`leave` | 🟡 |
| Tempo | Cotas de férias (2006) | — | ⬜ |
| Tempo | Avaliação de tempos | Conferência de ponto (sem cálculo) | ⛔ cálculo / ✅ conferência |
| Folha | Rubricas e esquemas | — | ⛔ |
| Folha | Registro de controle | Fechamento de competência com gates | ✅ |
| Folha | Retroatividade | Pendência de retroativo em competência processada | 🆕 |
| Folha | Lançamentos 0014/0015 | Adiantamentos e Descontos | ✅ |
| Folha | Conferência de resultado | Conferência de pós-fechamento, PDF de folha | ✅ |
| Legal | eSocial: geração e transmissão | — | ⛔ |
| Legal | eSocial: SST (S-2210/2220/2240) | CAT, ASO, cargo de risco, EPI | 🟡 controle, sem transmissão |
| Legal | Conferência eSocial × cadastro | eSocial esperado com recibo ou motivo | 🆕 |
| Benefícios | Planos e elegibilidade | Benefícios auxiliares por competência | 🟡 |
| Acesso | P_ORGIN por infotipo | Capacidades por papel + empresa | 🟡 |
| Acesso | Perfil estrutural | Escopo por empresa e departamento | 🟡 |
| Acesso | Pessoa própria (P_PERNR) | Segregação contra autoaprovação | 🟡 |
| Relatórios | Data-chave em todo relatório | Vida funcional e Quadro em data-base | 🆕 |
| Integração | Escrita externa pela mesma validação | Importadores do Sankhya pelo histórico | 🆕 |
| Self-service | ESS | Links assinados pontuais | 🟡 |
| Self-service | MSS | Portal do Gestor | ✅ |

---

## 15. O que copiar, o que não copiar

### Copiar (o conceito, não a forma)

1. **Validade em todo dado que muda com o tempo.** Já trazido para situação,
   lotação e jornada. Próximos candidatos: tipo de vínculo, cargo com faixa,
   estrutura de departamentos.
2. **Mudança × correção.** Mudança gera período novo; correção conserta o
   registro. O Vinculato hoje trata toda edição de cadastro como mudança a
   partir de hoje — a tela deveria perguntar.
3. **A medida como unidade de mudança**, com tipo, motivo e data, gravando
   todos os efeitos de uma vez. Já é o desenho das movimentações.
4. **Sinal de retroatividade** sem recalcular: avisar que o passado mudou.
5. **Data-chave como parâmetro padrão de relatório.**
6. **Uma porta de escrita só**, usada por tela, importação e integração.
7. **Status derivado da medida**, nunca editado à mão.

### Não copiar

1. **Motor de folha** (esquemas, PCRs, rubricas): proibido pelo §28.
2. **Customização como produto.** O SAP é configurado em centenas de tabelas
   `T5xx` por consultores; o Vinculato ganha justamente por ser pronto. Regras
   devem nascer como template, não como tabela de customização.
3. **Posição como objeto obrigatório.** Só faz sentido com controle de quadro
   de vagas; para a maioria dos clientes do Vinculato, departamento + cargo +
   gestor é suficiente.
4. **Transmissão de eSocial.** Conferir sim, transmitir não.
5. **A interface.** Telas por infotipo, códigos de transação e grupos de
   telas são a razão pela qual o DP precisa de consultor para usar o SAP.

---

## 16. Roadmap priorizado

Estado: os itens 1 a 7 estão no produto, no **modo ERP DP** (§4.28 e §4.29 de
`docs/arquitetura-operacional.md`). Falta o 8.

| # | Item | Conceito SAP | Valor para o DP | Esforço | Depende de |
| --- | --- | --- | --- | --- | --- |
| 1 | ✅ Alerta de retroatividade | 0003 / retro | Movimentação com data dentro de competência fechada abre pendência "lançar diferença na folha" | Pequeno | Histórico funcional ✅ |
| 2 | ✅ Quadro em data-base | PNP / data-chave | Headcount e turnover corretos; relatório "quem estava onde em DD/MM" para auditoria e defesa | Médio | 1 opcional |
| 3 | ✅ Importadores pelo histórico | `HR_INFOTYPE_OPERATION` | Fim da divergência entre cadastro e histórico quando o Sankhya sincroniza | Médio | — |
| 4 | ✅ Retorno de afastamento como movimentação | Medida + fim do 2001 | Data retroativa, aprovação e trava de ASO num fluxo só | Pequeno | — |
| 5 | ✅ Mudança × correção na edição do cadastro | Copiar × modificar | Corrigir erro de digitação sem criar período falso | Pequeno | — |
| 6 | ✅ Elementos contratuais | 0016 / 0019 | Fim de experiência e aviso prévio como prazos | Médio | Motor de Prazos ✅ |
| 7 | ✅ Conferência eSocial × histórico | Mapa da §8.2 | Comparar S-2206/S-2230/S-2299 transmitidos com o histórico | Grande | 2, 3, integração com o sistema de folha |
| 8 | ⬜ Saldo de férias (conferência) | 2006 | Mostrar período aquisitivo vencendo, sem calcular valor | Médio | 4 |

O próximo é o 8 (saldo de férias como conferência, sem cálculo de valor).

---

## 17. Glossário SAP ↔ DP brasileiro

| Termo SAP | Sigla / campo | No DP brasileiro | No Vinculato |
| --- | --- | --- | --- |
| Número pessoal | PERNR | Matrícula | `registration_number` |
| Medida | MASSN | Movimentação de pessoal | Movimentação |
| Motivo da medida | MASSG | Motivo (ex.: tipo de rescisão) | Detalhe da movimentação |
| Início / fim de validade | BEGDA / ENDDA | Data de vigência | `valid_from` / `valid_to` |
| Delimitar | — | Encerrar a vigência | Delimitação no histórico |
| Empresa | BUKRS | Empregador (CNPJ raiz) | Empresa |
| Subárea de RH | BTRTL | Estabelecimento / filial | Unidade |
| Grupo / subgrupo de empregados | PERSG / PERSK | Categoria do trabalhador / mensalista, horista | Tipo de vínculo |
| Área de processamento de folha | ABKRS | Folha mensal, quinzenal | Competência |
| Registro de controle | PA03 | Calendário de fechamento | Fechamento de competência |
| Rubrica | LGART | Verba / evento de folha | — |
| Classe de acumulação | — | Incidência (INSS, FGTS, IRRF) | — |
| Horário de trabalho teórico | 0007 | Jornada contratual | Jornada |
| Regra de horário | SCHKZ | Escala (6×1, 12×36) | Jornada (catálogo) |
| Ausência | 2001 | Afastamento, férias, falta | Movimentação |
| Cota de ausência | 2006 | Saldo de férias | — |
| Tarefa monitorada | 0019 | Controle de prazos | Motor de Prazos |
| Unidade organizacional | O | Departamento / setor | Departamento |
| Posição | S | Vaga do quadro | — |
| Cargo | C | Cargo (CBO) | Cargo |
| Ação dinâmica | T588Z | Rotina automática | Automação por evento |
| Data-chave | — | Data-base | Data-base da aba Vida funcional |
