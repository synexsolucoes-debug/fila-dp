import type { MetadataRoute } from "next";
import { publicOrigin, publicPages } from "@/lib/site-map";

/**
 * Sitemap (§45).
 *
 * Não existia. Sem ele o buscador precisa descobrir as páginas seguindo links,
 * e páginas comerciais que só aparecem no rodapé demoram a entrar no índice —
 * quando entram.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = publicOrigin();
  const lastModified = new Date();
  return publicPages.map((page) => ({
    url: `${origin}${page.path === "/" ? "" : page.path}`,
    lastModified,
    changeFrequency: page.changeFrequency,
    priority: page.priority,
  }));
}
