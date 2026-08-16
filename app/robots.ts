import type { MetadataRoute } from "next";
import { privatePaths, publicOrigin } from "@/lib/site-map";

/**
 * robots.txt (§45).
 *
 * Não existia. O painel e o console respondem 401 a quem não tem sessão, então
 * não havia vazamento — mas dizer explicitamente o que não é conteúdo evita que
 * o rastreador gaste o orçamento de rastreio em rotas que nunca renderizam
 * página, e aponta o sitemap.
 */
export default function robots(): MetadataRoute.Robots {
  const origin = publicOrigin();
  return {
    rules: [{ userAgent: "*", allow: "/", disallow: [...privatePaths] }],
    sitemap: `${origin}/sitemap.xml`,
    host: origin,
  };
}
