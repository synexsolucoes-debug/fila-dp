/**
 * Casamento de condição para regras `domain_event` (Motor de Jornadas).
 *
 * Separado de `lib/domain-event-automations.ts` de propósito: aquele módulo
 * toca banco (carrega a versão publicada, resolve quadro, grava a demanda) e
 * por isso importa `lib/fila-dp-db.ts`, que por sua vez importa `../db` por
 * valor — algo que só o bundler da aplicação resolve, não o executor de testes
 * puro em Node (o mesmo motivo por trás de `lib/process-conditions.ts` viver
 * separado de `lib/process-instances.ts`). Esta função não tem nenhuma razão
 * para carregar banco nenhum, e separá-la é o que permite testá-la direto.
 */
import type { DomainEventName } from "./domain-events.ts";

export type MatchableDomainEvent = {
  name: DomainEventName;
  entityId: string;
  payload: Record<string, unknown>;
};

/**
 * A condição de uma regra `domain_event` sempre nomeia o evento
 * (`condition.domainEvent`); as demais chaves comparam contra o `payload` ou,
 * para `entityId`, contra o identificador da entidade do evento. A rota que
 * salva a regra (`app/api/catalog/route.ts`) já recusa gravar sem
 * `domainEvent` — esta checagem é a segunda linha, para um dado que chegou por
 * outro caminho (importação, migração) não acionar tudo o que existe.
 */
export function matchesDomainEventRule(condition: Record<string, unknown>, event: MatchableDomainEvent) {
  if (condition.domainEvent !== event.name) return false;
  return Object.entries(condition).every(([key, expected]) => {
    if (key === "domainEvent" || expected === undefined) return true;
    if (key === "entityId") return event.entityId === expected;
    return event.payload[key] === expected;
  });
}
