import Image from "next/image";

/**
 * Marca do Vinculato — arquivos oficiais.
 *
 * O símbolo é o "V" de check com o ponto de conexão: haste azul, haste
 * azul-marinho e o ponto turquesa. Os dois arquivos do símbolo (colorido e
 * claro) são os entregues pela marca, recortados sem margem em
 * `public/brand/`. Não há redesenho: o que aparece na tela é o arquivo
 * original. O logotipo horizontal é esse símbolo ao lado da palavra
 * "Vinculato", com o pé do texto alinhado ao pé das hastes.
 *
 * - `VinculatoMark`: só o símbolo, para favicon, sidebar recolhida e áreas compactas;
 * - `VinculatoLogo`: símbolo + logotipo, para login, cadastro, sidebar expandida,
 *   site público e áreas institucionais.
 *
 * As três cores do símbolo são exatamente os tokens `--vin-navy-deep`,
 * `--vin-blue` e `--vin-teal` de `app/globals.css` — medidas nos pixels do
 * arquivo, não estimadas.
 */
export const VINCULATO_BRAND = {
  navy: "#18223A",
  blue: "#365CF5",
  teal: "#16A394",
  markSource: "/brand/vinculato-mark.png",
  /** Sobre fundo escuro a haste azul-marinho some: a versão clara a pinta de branco. */
  markLightSource: "/brand/vinculato-mark-light.png",
  logoSource: "/brand/vinculato-logo.png",
  /** Sobre fundo escuro o logotipo azul-marinho fica ilegível. */
  logoLightSource: "/brand/vinculato-logo-light.png",
  /** Proporções reais dos arquivos recortados. */
  markRatio: 540 / 505,
  logoRatio: 960 / 183,
} as const;

/**
 * A marca é servida sem a perda padrão do otimizador.
 *
 * `next/image` reencoda para WebP/AVIF com qualidade 75. Numa fotografia isso é
 * invisível; num logotipo de traço chapado sobre fundo escuro é o pior caso da
 * compressão com perdas, e o resultado é o halo claro contornando o símbolo. O
 * valor precisa constar de `images.qualities` em `next.config.ts`.
 */
const BRAND_IMAGE_QUALITY = 100;

type MarkProps = {
  size?: number; title?: string; className?: string; priority?: boolean;
  /** `light` usa a haste branca, para superfícies escuras. */
  tone?: "color" | "light";
};

export function VinculatoMark({ size = 32, title = "Vinculato", className, priority, tone = "color" }: MarkProps) {
  return (
    <Image
      className={className}
      src={tone === "light" ? VINCULATO_BRAND.markLightSource : VINCULATO_BRAND.markSource}
      alt={title}
      width={Math.round(size * VINCULATO_BRAND.markRatio)}
      height={size}
      priority={priority}
      quality={BRAND_IMAGE_QUALITY}
      style={{ width: "auto", height: size }}
    />
  );
}

type LogoProps = MarkProps & {
  compact?: boolean;
};

/** Versão horizontal. `compact` devolve só o símbolo, para sidebar recolhida. */
export function VinculatoLogo({ size = 34, compact = false, className, title = "Vinculato", priority, tone = "color" }: LogoProps) {
  if (compact) return <VinculatoMark size={size} title={title} className={className} priority={priority} tone={tone} />;
  return (
    <Image
      className={className}
      src={tone === "light" ? VINCULATO_BRAND.logoLightSource : VINCULATO_BRAND.logoSource}
      alt={title}
      width={Math.round(size * VINCULATO_BRAND.logoRatio)}
      height={size}
      priority={priority}
      quality={BRAND_IMAGE_QUALITY}
      style={{ width: "auto", height: size }}
    />
  );
}

/** Assinatura institucional: usada no site, no login e nos documentos. */
export const VINCULATO_TAGLINE = "Sua operação, conectada.";
