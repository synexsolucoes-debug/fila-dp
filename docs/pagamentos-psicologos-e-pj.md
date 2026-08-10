# Controle de pagamento: Psicólogos e Prestadores PJ

Data: 2026-08-09
Migration: `0018_payment_control_modules`
Versões de cálculo: `psychology-payment-1.0.0`, `contractor-payment-1.0.0`

Este documento descreve os dois módulos de controle de pagamento do Vinculato. Ambos são
**administrativos e financeiros**. O Vinculato não emite nota fiscal, não substitui contador,
sistema financeiro, plataforma de benefício ou prontuário.

## 1. Fronteiras do produto

| O módulo faz | O módulo não faz |
| --- | --- |
| Apura quanto pagar a cada psicólogo pelas consultas da competência | Prontuário, agenda clínica, diagnóstico, evolução ou qualquer conteúdo terapêutico |
| Apura o líquido devido ao PJ, o valor esperado da nota e o complemento | Cálculo tributário oficial, emissão de nota, transmissão a órgão ou banco |
| Registra nota recebida, pagamento e complemento, e concilia | Integração com plataforma de benefício (não existe conector oficial implementado) |

O cadastro de psicólogo aceita apenas nome, documento, contato, dados de pagamento, valor
padrão da consulta e observações administrativas. A API rejeita conteúdo clínico
(`CLINICAL_DATA_FORBIDDEN`) em nome, observação, motivo de ajuste e nota do lançamento.

## 2. Módulo de Psicólogos

A pergunta que o módulo responde: **quantas consultas válidas cada psicólogo realizou nesta
competência e quanto devemos pagar?**

### Lançamento da consulta

`fdp_psychology_sessions` guarda colaborador, empresa, psicólogo, data, competência,
quantidade, valor unitário, total, origem, status, observação administrativa e autoria.

O **valor unitário é histórico**: ele é copiado para o lançamento no momento do registro.
Reajustar a tabela do psicólogo depois não altera consultas antigas. O banco garante
`total_amount = unit_amount * session_quantity`.

Consultas nunca são apagadas: `DELETE` na API executa cancelamento administrativo com motivo,
autor e data, e o registro permanece no histórico com `status = 'canceled'`.

### Fechamento

`fdp_psychology_closings` consolida por psicólogo e competência: quantidade de consultas,
quantidade de colaboradores, bruto, ajustes, líquido, status e versão do cálculo.

Ciclo de vida: `open → review → approval → scheduled → paid → closed`, com `reopened` a partir
de `paid`/`closed`. Reabrir exige a capability `payments.reopen` e justificativa de no mínimo
5 caracteres — a regra é imposta também por trigger no PostgreSQL.

### Ajustes

`fdp_psychology_adjustments` é **append-only** (trigger). Cada ajuste grava tipo, valor,
motivo, valor anterior, valor novo, autor e data. `cancellation` e `discount` reduzem o valor
a pagar; `inclusion`, `correction` e `complement` aumentam.

### Pagamento e nota

`fdp_psychology_payments` registra valor, forma, datas prevista e realizada, status,
comprovante, responsável e — quando aplicável — número, valor e emissão da nota. O valor
esperado é comparado com o informado e a diferença vira divergência; o cálculo nunca é
ajustado automaticamente por causa da nota.

## 3. Módulo PJ — controle de pagamento

A pergunta que o módulo responde: **quanto o PJ tem a receber, quanto deve emitir de nota e
quanto vai para o meio complementar?**

### Ordem obrigatória do cálculo

```
1. líquido devido   = valor base + créditos - descontos
2. nota fiscal      = mínimo(líquido devido, limite configurado)
3. complemento      = máximo(líquido devido - nota fiscal, 0)
4. Caju Saldo Livre = complemento, quando o meio complementar configurado for Caju
```

Os créditos e descontos entram **sempre antes** do limite. A ordem é implementada em
`lib/payments.ts:calculateContractorClosing`, coberta pelos três exemplos da especificação em
`tests/payment-modules.test.mts` e reforçada no banco por
`fdp_contractor_closings_split_check` (`nota esperada + complemento = líquido`) e
`fdp_contractor_closings_limit_cap_check` (`nota esperada <= limite`).

| Exemplo | Base | Créditos | Descontos | Líquido | Limite | Nota | Complemento |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | 6.500,00 | 500,00 | 500,00 | 6.500,00 | 6.000,00 | 6.000,00 | 500,00 |
| 2 | 5.000,00 | 500,00 | 300,00 | 5.200,00 | 6.000,00 | 5.200,00 | 0,00 |
| 3 | 8.000,00 | 1.000,00 | 800,00 | 8.200,00 | 6.000,00 | 6.000,00 | 2.200,00 |

Toda a aritmética acontece em centavos inteiros; valores são `numeric(18,2)` no banco.

### Limite da nota

O limite **não é constante de código**. `fdp_invoice_limit_policies` versiona políticas por
`workspace`, `company`, `contract` e `provider`, com vigência (`effective_from` /
`effective_to`). A resolução segue a prioridade obrigatória:

```
prestador → contrato → empresa → workspace
```

Dentro do mesmo escopo vence a política mais recente. O limite gravado no próprio contrato do
prestador (`fdp_contractor_profiles.invoice_limit_override`) é o mais específico e prevalece
dentro do escopo `provider`. Sem nenhuma política, o fechamento registra
`invoice_limit_source = 'none'`: não há teto e a nota acompanha o líquido devido.

Publicar uma política encerra a vigência da anterior do mesmo alvo — nada é apagado, e
competências já apuradas mantêm o limite que usaram (registrado em
`invoice_limit_amount`, `invoice_limit_source` e `invoice_limit_policy_id`).

### Componentes

`fdp_contractor_components` guarda cada crédito e desconto da competência com tipo, descrição,
quantidade, valor, origem, documento, observação e status. O banco valida que o tipo pertence
à direção declarada. Componentes são cancelados com motivo, nunca apagados.

### Fluxo mensal

`open → review → approval → approved → invoice_pending → ready_to_pay → paid → closed`

Gates aplicados no servidor:

- **Complemento sem meio configurado** bloqueia `ready_to_pay`/`paid` (`COMPLEMENT_METHOD_REQUIRED`).
- **Nota esperada não conferida** bloqueia o pagamento (`INVOICE_VALIDATION_REQUIRED`).
- **Conciliação divergente** bloqueia o fechamento (`RECONCILIATION_DIVERGENT`).
- **Reabertura** exige `payments.reopen` e justificativa.

### Nota fiscal e complemento

A nota recebida é registrada com número, valor, emissão e referência do arquivo. O valor
esperado é comparado com o recebido: igual vira `validated`, diferente vira `divergent`.

O complemento (hoje operado como Caju Saldo Livre) é **controle assistido**: lote,
identificador externo, status e erro são informados pela operação e exportados em CSV.
**Não existe integração oficial implementada** com a plataforma; a resposta da API declara
`integration.connected = false`. Quando houver documentação e credenciais oficiais, o
caminho é implementar um Connector no framework de integrações da Fase 6 — com autenticação,
teste de conexão, mapeamento, sync run, tratamento de erro, retentativa, logs e testes —
antes de qualquer afirmação de integração pronta.

### Conciliação

```
nota recebida + complemento pago = líquido devido
```

A diferença é sempre exposta (`reconciliation_difference`) e nunca corrigida automaticamente.

### Snapshot e versionamento

Ao concluir, o fechamento grava `snapshot_json` com entradas, parâmetros, totais e versão do
cálculo. A partir daí, valores apurados, competência, prestador e empresa são congelados por
trigger; lançamentos vinculados a um fechamento pago ou fechado também ficam imutáveis.
Mudanças futuras de regra não recalculam competências fechadas.

## 4. Permissões

| Capability | admin | member | observer | guest |
| --- | --- | --- | --- | --- |
| `psychology.payments.read` / `.manage` / `.close` | sim | sim | não | não |
| `contractors.payments.read` | sim | sim | sim | não |
| `contractors.payments.manage` / `.close` | sim | sim | não | não |
| `contractors.limits.manage` | sim | não | não | não |
| `payments.reopen` | sim | não | não | não |

O backend valida em toda rota; esconder um botão nunca é o controle. Todo acesso passa
adicionalmente pelo escopo de empresa do membro.

## 5. Proteção dos dados de pagamento

Pix e conta bancária de psicólogos e prestadores são selados com AES-256-GCM usando o cofre
por versão de chave já existente (`FDP_INTEGRATION_VAULT_KEY` / `FDP_INTEGRATION_VAULT_KEYS`),
com AAD própria (`fila-dp:payout:v<versão>`). O material criptográfico nunca é projetado em
resposta HTTP: as rotas devolvem apenas um resumo mascarado. A auditoria registra quais campos
foram informados, nunca os valores.

## 6. Auditoria

Cada operação grava evento em `fdp_audit_events` com antes/depois, autor, request ID e
metadados: criação e alteração de cadastro, lançamento e cancelamento de consulta,
componente, apuração, ajuste, nota, complemento, transição de status, reabertura e exportação
de relatório.

## 7. Relatórios

`GET /api/payments/reports?report=<chave>&competence=AAAA-MM[&companyId=...][&format=csv]`

- `psychology-by-psychologist` — pagamentos por psicólogo na competência.
- `psychology-by-employee` — consultas administrativas por colaborador.
- `contractor-closing` — fechamento PJ completo com limite, nota, complemento e conciliação.
- `contractor-divergences` — apenas fechamentos com divergência.

Exportações em CSV são auditadas e respeitam o escopo de empresa.

## 8. Validação executada

- `npm run lint`, `npm run db:check` (21 migrations), `npm test` (93 testes) e `npm run build`: aprovados.
- `npm run db:rehearse-payments` contra PostgreSQL 16 real: as 21 migrations aplicam em banco
  limpo e o ensaio verifica, com SQL, as constraints do cálculo, a imutabilidade dos
  fechamentos concluídos, os ajustes append-only e o isolamento multi-tenant sob RLS com um
  papel sem superusuário (leitura, escrita, atualização e exclusão cruzadas negadas, e nada
  visível sem contexto de tenant).

Para repetir o ensaio:

```bash
FDP_PAYMENTS_TEST_DATABASE_URL="postgres://user@host:5432/scratch" \
FDP_ALLOW_EPHEMERAL_SCHEMA_TEST=true npm run db:rehearse-payments
```

O banco informado deve ser descartável. RLS só é exercida por papéis sem `SUPERUSER` e sem
`BYPASSRLS` — um teste conduzido como superusuário passa sem provar isolamento algum.

## 9. Rollback da migration 0018

A migration é aditiva: nenhuma tabela existente é alterada ou removida, então a aplicação
anterior continua funcionando com o schema novo. Para reverter:

1. Retirar tráfego da versão nova e confirmar que nenhum fechamento novo está em curso.
2. Exportar `fdp_psychology_*`, `fdp_contractor_*`, `fdp_invoice_limit_policies` e
   `fdp_psychologist_profiles` e registrar as contagens.
3. Publicar a versão anterior da aplicação. As tabelas novas ficam ociosas e podem
   permanecer — nenhum código antigo as referencia.
4. Remover as tabelas apenas por runbook aprovado, sobre backup restaurável e depois de
   confirmar que nenhuma competência apurada depende delas.

Como o passo 4 inclui `DROP TABLE`, ele não é automatizado no caminho normal de migrations.

## 10. Pendências conhecidas

- Não há integração oficial com plataforma de benefício; o complemento é controle assistido
  com exportação. O conector permanece não configurado até existir documentação e credencial.
- Importação em massa de consultas e componentes (CSV/XLSX) usará o pipeline de staging do
  módulo de importações; hoje o lançamento é individual pela API/interface, com `origin`
  e `external_id` já preparados para idempotência de importação.
- O anexo da nota fiscal é referenciado por texto; a vinculação ao Blob privado usará a
  central de documentos.
