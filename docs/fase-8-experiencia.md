# Fase 8 — Experiência: central de ação, busca global e acessibilidade

Data: 2026-08-09

Esta fase ataca o item central do §77 da especificação: o painel precisa responder
**"o que precisa ser feito agora?"**. Nada aqui é indicador decorativo — cada número tem
consulta real por trás, respeita permissão e escopo de empresa, e leva a uma tela existente.

## 1. Central de ação

`GET /api/dashboard/action-center` monta os indicadores a partir de um registro declarativo
(`lib/action-center.ts`). Cada entrada define rótulo, descrição, capability exigida, tom,
módulo de destino e a consulta agregada.

Indicadores atuais:

| Indicador | Origem | Tom | Abre |
| --- | --- | --- | --- |
| Demandas com prazo estourado | `fdp_cards` com SLA vencido | crítico | Demandas |
| Aprovações aguardando você | `fdp_movement_approval_steps` atribuídas ao usuário | crítico | Operação DP |
| Pendências bloqueantes | `fdp_operational_pending_items` com `blocking` | crítico | Operação DP |
| Pendências operacionais abertas | `fdp_operational_pending_items` | atenção | Operação DP |
| Movimentações pendentes | `fdp_employee_movements` em rascunho/aprovação | atenção | Operação DP |
| Itens de fechamento em aberto | `fdp_payroll_cycle_items` pré e pós | atenção | Operação DP |
| Obrigações no radar | `fdp_compliance_obligations` vencidas ou em 15 dias | crítico | Operação DP |
| Entregas auxiliares pendentes | `fdp_auxiliary_executions` | atenção | Módulos auxiliares |
| Pagamentos de psicólogos pendentes | `fdp_psychology_closings` não pagos | atenção | Pagamento de Psicólogos |
| Fechamentos PJ pendentes | `fdp_contractor_closings` não pagos | atenção | Pagamentos PJ |
| Notas PJ divergentes | divergência de nota ou conciliação | crítico | Pagamentos PJ |
| Complemento a carregar | `caju_amount` aguardando envio | atenção | Pagamentos PJ |
| Integrações com erro | execuções falhas em 30 dias | crítico | Integrações |
| Conciliações de integração abertas | itens sem correspondência ou em conflito | atenção | Integrações |

Garantias:

- **Uma única ida ao banco.** Os blocos permitidos são unidos por `UNION ALL` — não há uma
  consulta por card.
- **Permissão antes de tudo.** Um indicador só é montado quando o papel possui a capability
  declarada. Convidado enxerga apenas demandas; observador não vê movimentações nem pagamento
  de psicólogos.
- **Escopo de empresa.** Membros restritos só somam as empresas autorizadas; sem nenhuma
  empresa liberada, a resposta vem vazia em vez de contar o workspace inteiro.
- **Indicadores zerados não aparecem.** A tela mostra o que exige ação, não um mural de zeros.
- **Nada é simulado.** O módulo de Ponto (§28) ainda não existe no produto, então não há
  indicador de "ponto aberto". A resposta declara isso em `notCovered`.

Fechamento já pago não conta como pagamento pendente: os indicadores financeiros usam
`status NOT IN ('paid', 'closed')`, e o que falta nesse caso é a conclusão, não o pagamento.

## 2. Busca global

`GET /api/search?q=…` continua devolvendo demandas em `results` e passa a devolver
`records` com os demais domínios do §78:

| Domínio | Campos pesquisados | Capability |
| --- | --- | --- |
| Empresas | razão social, fantasia, CNPJ | `companies.read` |
| Colaboradores | nome, nome social, matrícula, CPF | `employees.read` |
| Psicólogos | nome, código | `psychology.payments.read` |
| Prestadores PJ | nome, código, referência do contrato | `contractors.payments.read` |
| Competências | competência (AAAA-MM) | `competences.read` |
| Integrações | nome de exibição, canal | `integrations.status.read` |

**CPF nunca trafega nem retorna em claro.** Onze dígitos são convertidos em HMAC com o
segredo de PII e comparados com `cpf_hash`; quatro dígitos batem em `cpf_last4`. O resultado
exibe apenas a máscara (`•••.•••.•XX-XXXX`), e o hash jamais é projetado na resposta.

Cada registro carrega o módulo de destino, e clicar leva direto para lá.

## 3. Acessibilidade

Alvo: WCAG 2.2 AA nas superfícies desta fase.

- A paleta de busca anunciava `ESC` no cabeçalho, mas a tecla não fazia nada — afordância
  falsa. Agora ela é um diálogo modal de verdade: `Esc` fecha, `Tab` fica preso dentro do
  painel, e o foco volta para o elemento que abriu a busca.
- Resultados agrupados com rótulos de seção e `role="listbox"`.
- Central de ação com `aria-labelledby`, região viva (`aria-live="polite"`) para o resumo,
  `role="alert"` para erro, e estados explícitos de carregamento, vazio e erro.
- Foco visível com contorno próprio em todos os controles novos.
- `prefers-reduced-motion` desliga animação e deslocamento nos elementos novos.
- Layout responsivo: a grade de indicadores colapsa para uma coluna em telas estreitas.

## 4. Validação executada

- `npm run lint`, `npm run db:check` (21 migrations), `npm test` (102 testes, 9 novos) e
  `npm run build`: aprovados.
- As consultas da central de ação e da busca foram executadas contra **PostgreSQL 16 real**,
  com dados semeados, conferindo agregação, escopo de empresa e resultados por domínio.

## 5. Pendências desta fase

- **Ponto (§28)** não existe como módulo; sem ele não há indicador de marcações/fechamento de
  ponto. Implementar o módulo é pré-requisito, não o indicador.
- **Notificações (§8 da lista de menu / Fase 8)**: as notificações internas existem, mas
  e-mail, Teams e resumos periódicos continuam fora do produto e não são anunciados.
- O redesign visual completo do painel (§75) permanece incremental: esta fase entrega a
  camada que responde à pergunta operacional, não a troca do design system.
- A busca ainda não cobre documentos e protocolos porque a central de documentos (§68) não
  foi construída.
