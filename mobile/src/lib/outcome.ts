import type { SubmitResult } from "./queue";

/**
 * O que dizer depois do envio.
 *
 * `partial` é o caso em que o registro foi aceito e só a evidência ficou para
 * trás. Chamar isso de "sem rede" mandaria colher a assinatura de novo sem
 * necessidade; chamar de "registrado" esconderia que o termo ainda não subiu.
 */
export const outcome = (result: SubmitResult, messages: { sent: string; queued: string; partial: string }) =>
  messages[result.status];
