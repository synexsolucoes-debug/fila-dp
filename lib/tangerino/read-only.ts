/**
 * A garantia de somente-leitura, imposta em dois níveis.
 *
 * O primeiro nível é o desenho: `TangerinoBrowserSession` não tem método de
 * escrita. Não existe `click(seletor)`, não existe `submit()`, não existe
 * `salvar()`. Um agente que não tem como apertar "Salvar" não aperta "Salvar"
 * por engano, nem porque um texto na página mandou (§23). Essa é a garantia
 * forte, e é estrutural.
 *
 * Este arquivo é o segundo nível: a rede. Ele existe porque o primeiro nível
 * protege contra o que o agente decide fazer, e não contra o que a página faz
 * sozinha — um script da própria aplicação pode disparar uma requisição de
 * alteração em resposta a algo tão inocente quanto abrir um registro (marcar
 * como visto, gravar telemetria de acesso, renovar rascunho).
 *
 * SOBRE O CUIDADO QUE A §67 PEDE
 *
 * `POST` não é sinônimo de escrita. Login é POST. Busca com filtro é POST.
 * GraphQL é POST para tudo, inclusive para ler. Bloquear todo POST quebraria a
 * consulta antes de ela começar, e o agente devolveria erro técnico em vez de
 * status — trocando um risco teórico por uma falha certa.
 *
 * Então a decisão é em três faixas, e não em duas:
 *
 *   `block`   — o método nunca lê (`PUT`, `PATCH`, `DELETE`), ou o POST tem
 *               forma de alteração no caminho. Interrompe a consulta.
 *   `observe` — POST que não dá para classificar. Passa, porque barrar
 *               quebraria a página, mas fica registrado: é assim que se
 *               descobre o que a aplicação faz de verdade e se aperta a regra
 *               depois, com evidência.
 *   `allow`   — leitura declarada.
 *
 * A faixa do meio é uma concessão consciente, e está escrita aqui para que
 * ninguém a leia como cobertura total. A garantia forte continua sendo a
 * ausência de comandos de escrita no agente.
 */

export type ReadOnlyDecision = "allow" | "observe" | "block";

/** Métodos que não têm leitura possível. */
const alwaysBlockedMethods = new Set(["PUT", "PATCH", "DELETE"]);

/** Métodos de leitura por definição. */
const readMethods = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Vocabulário de alteração em caminho de API.
 *
 * São verbos, e não substantivos: `/admissao/123` é leitura, `/admissao/123/aprovar`
 * não é. Por isso os padrões exigem o verbo como segmento — `/salvar`, `/aprovar` —
 * e não a palavra solta em qualquer lugar da URL, que pegaria `/documentos-salvos`.
 */
const mutationPathPatterns: readonly RegExp[] = Object.freeze([
  /\/(?:salvar|save|store|create|criar|update|atualizar|editar|edit)(?:\/|$|\?)/iu,
  /\/(?:excluir|delete|remover|remove|apagar)(?:\/|$|\?)/iu,
  /\/(?:aprovar|approve|rejeitar|reject|reprovar)(?:\/|$|\?)/iu,
  /\/(?:admitir|admit|efetivar|finalizar|finish|concluir|complete)(?:\/|$|\?)/iu,
  /\/(?:cancelar|cancel|desistir)(?:\/|$|\?)/iu,
  /\/(?:assinar|sign|signature)(?:\/|$|\?)/iu,
  /\/(?:upload|anexar|attach|enviar-documento)(?:\/|$|\?)/iu,
]);

/**
 * POSTs de leitura reconhecidos.
 *
 * Login entra aqui porque autenticar é pré-requisito da consulta e não altera
 * dado de admissão nenhum. GraphQL entra porque é o transporte, não a operação —
 * uma mutation em GraphQL não aparece no caminho, e por isso ela é barrada pela
 * inspeção de corpo abaixo, não por esta lista.
 */
const readPostPatterns: readonly RegExp[] = Object.freeze([
  /\/(?:login|signin|sign-in|auth|autenticar|token|session)(?:\/|$|\?)/iu,
  /\/(?:search|buscar|pesquisar|busca|consultar|consulta|filtrar|filter|list|listar)(?:\/|$|\?)/iu,
  /\/graphql(?:\/|$|\?)/iu,
  /\/documentos\/admissao\/download-zip(?:\/|$|\?)/iu,
  /\/ficha-cadastral\/report\/(?:[^/?]+)(?:\/|$|\?)/iu,
]);

/** `mutation` no corpo de um POST GraphQL é escrita, mesmo com caminho de leitura. */
const graphqlMutationPattern = /(?:^|[\s"'{,])mutation[\s({]/u;

export function readOnlyDecision(input: { method: string; url: string; body?: string }): ReadOnlyDecision {
  const method = input.method.toUpperCase();
  if (readMethods.has(method)) return "allow";
  if (alwaysBlockedMethods.has(method)) return "block";
  if (method !== "POST") return "block";

  let pathAndQuery = input.url;
  try {
    const parsed = new URL(input.url);
    pathAndQuery = `${parsed.pathname}${parsed.search}`;
  } catch {
    // URL relativa ou malformada: a inspeção segue sobre o texto cru, que é o
    // que a interceptação do navegador entrega quando a página usa caminho.
  }

  if (mutationPathPatterns.some((pattern) => pattern.test(pathAndQuery))) return "block";
  if (input.body && graphqlMutationPattern.test(input.body.slice(0, 2000))) return "block";
  if (readPostPatterns.some((pattern) => pattern.test(pathAndQuery))) return "allow";
  return "observe";
}

/**
 * O que registrar sobre uma requisição barrada.
 *
 * Só método e caminho. Sem querystring, sem corpo, sem cabeçalho: é justamente
 * uma requisição de alteração, e é onde estariam token de sessão, identificador
 * de pessoa e conteúdo de formulário. O que se precisa saber para investigar é
 * "o que a página tentou fazer", e método mais caminho respondem isso (§52).
 */
export function readOnlyViolationDetail(input: { method: string; url: string }) {
  let path = input.url;
  try {
    path = new URL(input.url).pathname;
  } catch {
    path = input.url.split("?")[0];
  }
  return { method: input.method.toUpperCase().slice(0, 10), path: path.slice(0, 200) };
}
