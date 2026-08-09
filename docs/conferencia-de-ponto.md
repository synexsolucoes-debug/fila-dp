# Conferência de ponto (§28) e destino dos eventos de hora (§22)

Data: 2026-08-09

Este documento descreve o módulo de Ponto do Fila DP: o que ele faz, o que
deliberadamente não faz, e como a regra do §22 é imposta em quatro camadas
independentes.

## 1. O que o módulo é

Uma **conferência operacional**: importa marcações, apura o dia, acusa o que
está inconsistente, exige decisão humana sobre cada inconsistência, aprova a
folha de ponto da competência e entrega os eventos de hora para o sistema de
folha com a rubrica que o operador configurou.

Ele responde a três perguntas e a nenhuma outra:

1. o que o cartão de ponto do colaborador diz que aconteceu no dia?
2. o que está inconsistente e precisa de decisão antes do fechamento?
3. quais eventos de hora saem para a folha, e em qual campo do destino?

## 2. O que o módulo não é

- **Não é relógio de ponto.** Ele não coleta marcação; recebe marcação já
  coletada, por importação, digitação ou conector.
- **Não calcula dinheiro.** Não existe valor de hora extra, de adicional
  noturno ou de falta em nenhuma tabela nem em nenhuma linha exportada. O
  produto confere horas; quem transforma hora em dinheiro é a folha.
- **Não aplica a hora noturna reduzida** (art. 73, §1º da CLT). Ele apura os
  minutos trabalhados dentro da janela das 22h às 5h e entrega essa quantidade.
  A conversão legal pertence ao sistema de folha, que é a fonte oficial.
  Aplicá-la aqui produziria dois números divergentes para o mesmo fato.
- **Não é fonte oficial de apuração trabalhista.** É instrumento de conferência
  e de preparação do envio.

## 3. A regra do §22, em quatro camadas

> Eventos do tipo hora devem ir para índice, referência ou quantidade, conforme
> configuração do conector/rubrica. Não enviar automaticamente para valor. Sem
> configuração: bloquear exportação. Nunca adivinhar.

| Camada | Onde | O que impede |
| --- | --- | --- |
| Vocabulário | `hourEventTargetFields` em `lib/time-tracking.ts` | `value` não existe como destino — não é opção desabilitada |
| Aplicação | `assertHourEventTarget` | Recusa `value`, `amount`, `valor`, `montante`, `money` com erro nomeado |
| Banco | `CHECK fdp_hour_event_mappings_target_check` | `target_field` só aceita `quantity`, `reference`, `index` |
| Exportação | `planTimeExport` + `assertExportable` | Evento apurado sem mapeamento ativo bloqueia o lote inteiro |

A linha exportada não tem campo de valor. Não é omissão de preenchimento: o
formato não tem para onde mandar dinheiro. O CSV gerado tem exatamente estas
colunas: `matricula;colaborador;rubrica;evento;campo_destino;unidade;quantidade`.

### Unidade é configuração, não inferência

Cada mapeamento declara a unidade em que a quantidade sai: `hours_decimal`
(1,5), `hours_minutes` (01:30) ou `minutes` (90). Sem unidade não há conversão —
enviar 90 onde o destino espera 1,5 seria adivinhar.

### O bloqueio nomeia o que falta

`GET /api/time/export` devolve a prévia antes de qualquer gravação, listando os
eventos sem rubrica. `POST` recusa com `HOUR_EVENT_MAPPING_REQUIRED` e a
mensagem cita o evento pelo nome. Desativar um mapeamento volta a bloquear: um
destino inativo conta como ausente.

## 4. Regras de apuração do dia

Todas determinísticas e cobertas por teste:

| Situação | Resultado |
| --- | --- |
| Dia útil, saldo positivo | `overtime_50` com o excedente |
| Dia útil, sem nenhuma marcação | `absence_hours` com a jornada prevista + inconsistência bloqueante |
| Dia útil, trabalho parcial | `late_hours` com a diferença |
| Descanso ou feriado com trabalho | `overtime_100` com o total trabalhado |
| Férias, licença ou falta com marcação | **nenhum evento** — inconsistência bloqueante |
| Qualquer dia com marcação na janela 22h–5h | `night_hours` com os minutos apurados |

A linha "férias com marcação" é a mais importante da tabela: o certo depende de
decisão humana (a férias foi interrompida? a marcação é de outro colaborador?),
e o produto acusa em vez de escolher.

Jornada que vira o dia é contada corretamente: uma marcação `22:00 → 06:00`
resulta em 480 minutos trabalhados e 420 minutos na janela noturna.

### Inconsistências

Bloqueantes (impedem a aprovação): `missing_punch`, `odd_punch_count`,
`duplicate_punch`, `out_of_order_punch`, `missing_schedule`, `future_date`,
`work_on_non_working_day`.

Avisos (sinalizam, não impedem): `overtime_without_justification`,
`interval_below_minimum`.

Tratar uma inconsistência exige nota de pelo menos 5 caracteres, com autor e
data — `resolved` significa "o dado foi corrigido", `waived` significa "está
certo assim e eis o porquê". Uma inconsistência que sumisse sem explicação seria
uma conferência que não aconteceu.

**Recálculo preserva decisão humana.** Ao reapurar a folha, inconsistências que
deixaram de existir somem, novas entram abertas e as que persistem mantêm a
decisão já registrada.

## 5. Ciclo de vida da folha de ponto

```
draft → review → approved → exported → closed
          ↓ ↑                  ↓  ↑        ↓
       rejected              review (reabertura justificada)
```

- Não existe caminho de `review` direto para `exported`: a exportação só é
  alcançável depois da aprovação.
- A rota de transição **recusa** `exported` explicitamente
  (`TIME_EXPORT_ROUTE_REQUIRED`): quem exporta é a rota de exportação, que é a
  única que valida os mapeamentos.
- Aprovar reapura a folha antes de decidir e recusa se houver inconsistência
  bloqueante aberta — aprovar sobre número velho seria aprovar no escuro.
- Folha exportada congela totais, marcações e eventos. Voltar exige
  justificativa registrada, garantida também por trigger no PostgreSQL.
- O lote de exportação é append-only: só o estado de entrega muda; carga,
  checksum e contagem de linhas não.

## 6. Eventos manuais

`on_call_hours`, `time_bank_credit`, `time_bank_debit` e `interval_not_taken`
são lançados manualmente e exigem justificativa. Eventos que o motor apura
(`overtime_50`, `overtime_100`, `night_hours`, `late_hours`, `absence_hours`)
**não aceitam lançamento manual** — sobrescrever a apuração destruiria a
rastreabilidade entre marcação e resultado. Para mudar hora extra ou falta,
corrige-se a marcação do dia.

## 7. Privacidade das marcações

`punches_json` guarda apenas pares `{ in, out }`. Qualquer outro campo enviado
pelo relógio ou pelo arquivo importado (CPF, identificador de dispositivo,
geolocalização) é descartado antes de tocar o banco, e o CHECK limita o array a
12 pares.

## 8. Permissões

| Capability | admin | member | observer | guest |
| --- | --- | --- | --- | --- |
| `time.read` | ✓ | ✓ | ✓ | — |
| `time.manage` | ✓ | ✓ | — | — |
| `time.approve` | ✓ | ✓ | — | — |
| `time.export` | ✓ | ✓ | — | — |
| `time.mappings.manage` | ✓ | — | — | — |

Configurar a rubrica de destino é ato de configuração do produto, não de
operação da competência: fica restrito ao administrador.

## 9. Superfície de API

| Rota | O que faz |
| --- | --- |
| `GET /api/time/overview` | Painel da competência, incluindo os eventos sem rubrica |
| `GET/POST /api/time/sheets` | Lista folhas; abre a folha de um colaborador |
| `GET/POST /api/time/sheets/{id}/entries` | Lê e grava marcações; toda escrita reapura |
| `POST /api/time/sheets/{id}/transition` | Move a folha pelo ciclo; recusa `exported` |
| `POST/PUT /api/time/sheets/{id}/inconsistencies` | Trata inconsistência; reapura a folha |
| `POST /api/time/sheets/{id}/events` | Evento manual com justificativa |
| `GET/POST/PATCH /api/time/mappings` | Mapeamentos de rubrica (§22) |
| `POST /api/time/import` | Importa marcações de vários colaboradores |
| `GET/POST /api/time/export` | Prévia e execução da exportação |

A importação não cria colaborador: quem não é encontrado volta na resposta como
recusado, com o motivo, e a resposta usa `207` quando houve recusa. Importar
"quase tudo" em silêncio esconderia exatamente o erro que o DP precisa ver.

## 10. Central de ação

O painel passa a cobrir o ponto com três indicadores de consulta real:

- **Ponto com inconsistência bloqueante** — impede a aprovação;
- **Ponto em conferência** — folhas ainda não aprovadas;
- **Ponto aprovado sem rubrica configurada** — eventos apurados sem destino,
  isto é, o bloqueio do §22 visível antes de alguém tentar exportar.

Com isso, a declaração `notCovered: ["ponto"]` da API da central de ação foi
removida: ela existia porque o módulo não existia.

## 11. Validação executada

- `npm run lint`, `npm run db:check` (24 migrations), `npm test` (172 testes, 33
  novos) e `npm run build`: aprovados.
- `npm run db:rehearse` contra PostgreSQL 16.13 real: 26 verificações do ponto
  aprovadas, incluindo a recusa de `value` e `valor` como destino, o
  congelamento da folha exportada, a imutabilidade do lote e o isolamento
  multi-tenant sob RLS com papel `NOSUPERUSER NOBYPASSRLS`.

**A verificação de isolamento não é vazia.** Repetimos o ensaio concedendo
`BYPASSRLS` ao papel de aplicação e a checagem acusou corretamente:
`vazamento: folha de ponto de outro workspace visível`.

Durante o ensaio, o trigger de congelamento foi corrigido: a primeira versão
bloqueava a escrita do snapshot na transição `exported → closed`, o que teria
impedido o fechamento de toda folha exportada. O erro só apareceu contra
PostgreSQL real.

## 12. O que ainda falta

- **Conector de relógio de ponto**: a importação existe e é testada, mas
  nenhum fornecedor de REP tem integração oficial implementada. Marcações
  entram por API, importação ou digitação.
- **Escala e feriário automáticos**: a jornada prevista do dia é informada na
  marcação. Derivá-la da escala cadastrada (`fdp_work_schedules`) e de um
  calendário de feriados é o próximo passo natural, e até lá o campo em branco
  é acusado como inconsistência bloqueante em vez de assumir 8 horas.
- **Banco de horas com compensação automática**: crédito e débito são lançados
  manualmente com justificativa; não há regra de compensação automática entre
  competências.
