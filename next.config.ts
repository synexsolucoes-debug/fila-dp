import type { NextConfig } from "next";

const securityHeaders = [
  { key: "Content-Security-Policy", value: "base-uri 'self'; frame-ancestors 'none'; object-src 'none'; form-action 'self'" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
  ...(process.env.NODE_ENV === "production"
    ? [{ key: "Strict-Transport-Security", value: "max-age=31536000; includeSubDomains" }]
    : []),
];

const nextConfig: NextConfig = {
  // Há outros lockfiles acima deste repositório na estação de desenvolvimento.
  // Sem uma raiz explícita o Next pode tentar resolver dependências a partir
  // da pasta pessoal, além de tornar o build dependente da máquina.
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  images: {
    // O otimizador entrega WebP/AVIF com qualidade 75 por padrão, e 75 num
    // logotipo — borda dura de cor chapada sobre fundo escuro — é exatamente o
    // caso em que a compressão com perdas devolve halo em volta do traço. A
    // marca passa a pedir 100; o resto das imagens continua em 75. Sem esta
    // lista o Next recusa qualquer valor fora do padrão.
    qualities: [75, 100],
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
