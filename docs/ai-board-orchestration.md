# IA para atualização assistida dos quadros

## Validação

É viável atualizar etapas do quadro com IA, mas a IA não deve mover cartões diretamente nem decidir regras trabalhistas. Ela deve produzir uma **proposta estruturada**; um motor determinístico valida processo, evidências, permissões, SLA e idempotência antes de executar qualquer mudança.

Fluxo recomendado:

1. Um evento entra por comentário, checklist, anexo, e-mail, Teams, WhatsApp ou ERP.
2. A IA classifica a demanda e propõe `etapaDestino`, `motivo`, `evidencias` e `confianca`.
3. O motor de políticas confirma que a transição existe no processo da demanda e que os documentos obrigatórios estão presentes.
4. Transições de baixo risco e alta confiança podem ser aplicadas com a flag `aiBoardOrchestration`.
5. Remuneração, desligamento, aprovação financeira, escrita no ERP e qualquer mudança sensível sempre exigem confirmação humana.
6. Toda proposta e decisão gera auditoria append-only, chave de idempotência e possibilidade de desfazer.

## Contrato sugerido

```json
{
  "cardId": "uuid",
  "processVersion": 3,
  "currentStageId": "documentos",
  "proposedStageId": "conferencia",
  "reason": "Checklist obrigatório concluído",
  "evidenceIds": ["attachment:uuid", "checklist:uuid"],
  "confidence": 0.94,
  "requiresHumanApproval": false,
  "idempotencyKey": "event:uuid:process:3"
}
```

## Condição para implementação

Este módulo permanece desligado na Release 0.1. Ele só deve entrar depois de tenant isolation, auditoria append-only, processos versionados, permissões por empresa e testes de transição estarem aprovados. A primeira entrega deve operar em modo “sugerir”, medindo acerto e recusas antes de permitir automação de baixo risco.
