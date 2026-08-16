/**
 * Páginas públicas do site (§45, §46).
 *
 * Uma lista só, consumida pelo sitemap, pelo robots e pelo teste que confere se
 * cada página declara a si mesma como canônica. Mantê-las separadas garantiria
 * o desencontro: alguém acrescenta uma página, esquece do sitemap, e ela nasce
 * invisível para busca.
 *
 * O painel, o console e as telas de autenticação ficam de fora de propósito —
 * são área logada, não conteúdo.
 */
export const publicPages = [
  { path: "/", changeFrequency: "weekly" as const, priority: 1 },
  { path: "/solucao", changeFrequency: "monthly" as const, priority: 0.9 },
  { path: "/funcionalidades", changeFrequency: "monthly" as const, priority: 0.9 },
  { path: "/integracoes", changeFrequency: "monthly" as const, priority: 0.8 },
  { path: "/planos", changeFrequency: "weekly" as const, priority: 0.9 },
  { path: "/faq", changeFrequency: "monthly" as const, priority: 0.6 },
  { path: "/contato", changeFrequency: "yearly" as const, priority: 0.6 },
  { path: "/demonstracao", changeFrequency: "monthly" as const, priority: 0.7 },
  { path: "/privacidade", changeFrequency: "yearly" as const, priority: 0.4 },
  { path: "/termos", changeFrequency: "yearly" as const, priority: 0.4 },
  { path: "/subprocessadores", changeFrequency: "yearly" as const, priority: 0.3 },
] as const;

/** Caminhos que não devem ser rastreados: área logada e fluxo de autenticação. */
export const privatePaths = ["/painel", "/plataforma", "/login", "/recuperar", "/api"] as const;

/**
 * Origem pública do site.
 *
 * `metadataBase` do layout já resolve o host da requisição; sitemap e robots
 * rodam fora dela e precisam de uma origem própria. `FDP_PUBLIC_ORIGIN` é o
 * lugar de dizer o domínio real quando ele existir — sem ela, a reserva é o
 * mesmo endereço que o layout usa hoje.
 */
export function publicOrigin() {
  const configured = (process.env.FDP_PUBLIC_ORIGIN ?? "").trim().replace(/\/$/u, "");
  if (/^https?:\/\/[^\s/]+$/u.test(configured)) return configured;
  return "https://fila-dp.synexsolucoes.chatgpt.site";
}
