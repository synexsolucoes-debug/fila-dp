/**
 * Política de segurança de conteúdo (§67).
 *
 * A auditoria encontrou a CSP do produto **sem nenhuma diretiva de script**:
 * havia `base-uri`, `frame-ancestors`, `object-src` e `form-action`, e nada
 * dizia de onde script pode vir. Na prática, isso é o mesmo que não ter CSP para
 * o risco que importa: um XSS em qualquer campo do painel executaria com todos
 * os privilégios da sessão, incluindo as rotas de administração.
 *
 * ## O que esta política faz, e o que ela não faz
 *
 * Ela **contém o impacto** de um XSS; ela não substitui a sanitização. Script
 * injetado no HTML não executa (não carrega o nonce), e script buscado de um
 * host externo não carrega. O que ela não impede é o abuso de um script legítimo
 * da própria origem — por isso continua valendo tudo que o produto já faz na
 * entrada.
 *
 * ## Por que nonce e não hash
 *
 * O Next injeta scripts inline para hidratação e streaming, e o conteúdo deles
 * muda a cada build e a cada rota — hash exigiria recalcular a política a cada
 * deploy e quebraria em silêncio na primeira divergência. O nonce é gerado por
 * requisição e o Next o propaga para os próprios scripts quando ele chega no
 * cabeçalho da requisição.
 *
 * ## Por que não `strict-dynamic`
 *
 * `strict-dynamic` faz o navegador **ignorar** `'self'` e qualquer allowlist de
 * host, confiando apenas na propagação a partir do script com nonce. É mais
 * forte quando funciona e quebra a página inteira quando um único `<script>`
 * emitido pelo framework não recebe o nonce. `'self' 'nonce-…'` já impede o
 * inline injetado e o host externo, que é o que este produto precisa conter, sem
 * apostar a renderização em um detalhe de implementação do framework.
 *
 * ## O que continua permitido, e por quê
 *
 * - `style-src 'unsafe-inline'`: o Next emite `<style>` crítico inline e atributos
 *   `style`; sem isso a aplicação renderiza sem CSS. Estilo inline não executa
 *   código, então o risco aqui é de aparência, não de sessão.
 * - `img-src https:`: anexos e logotipos vêm do Blob da Vercel, cujo host varia
 *   por deployment.
 * - `connect-src https:`: o painel fala com a própria API e com o armazenamento
 *   de anexos; fixar host aqui quebraria o upload em cada ambiente novo.
 * - `'unsafe-eval'` **apenas em desenvolvimento**: o recarregamento a quente
 *   depende dele. Em produção não entra, e há teste que reprova se entrar.
 */

export type CspOptions = {
  nonce: string;
  /** `development` afrouxa o necessário para o recarregamento a quente. */
  environment?: string;
};

export function buildContentSecurityPolicy({ nonce, environment = process.env.NODE_ENV }: CspOptions) {
  const isDevelopment = environment === "development";
  const scriptSources = ["'self'", `'nonce-${nonce}'`];
  if (isDevelopment) scriptSources.push("'unsafe-eval'");

  const directives: Array<[string, string[]]> = [
    ["default-src", ["'self'"]],
    ["base-uri", ["'self'"]],
    ["object-src", ["'none'"]],
    ["frame-ancestors", ["'none'"]],
    ["frame-src", ["'none'"]],
    ["form-action", ["'self'"]],
    ["script-src", scriptSources],
    ["style-src", ["'self'", "'unsafe-inline'"]],
    ["img-src", ["'self'", "data:", "blob:", "https:"]],
    ["font-src", ["'self'", "data:"]],
    ["connect-src", isDevelopment ? ["'self'", "https:", "ws:", "wss:"] : ["'self'", "https:"]],
    ["media-src", ["'self'", "blob:", "data:"]],
    ["worker-src", ["'self'", "blob:"]],
    ["manifest-src", ["'self'"]],
  ];

  const policy = directives.map(([name, values]) => `${name} ${values.join(" ")}`);
  if (!isDevelopment) policy.push("upgrade-insecure-requests");
  return policy.join("; ");
}

/**
 * Nonce por requisição.
 *
 * `crypto.getRandomValues` e não `Math.random`: um nonce adivinhável é um nonce
 * inútil, porque o atacante o inclui no script que injeta.
 */
export function createCspNonce() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
