import Image from "next/image";

/**
 * Marca do Vinculato — arquivos oficiais.
 *
 * As duas composições vêm dos arquivos entregues pela marca, recortados sem
 * margem branca em `public/brand/`. Não há redesenho: o que aparece na tela é o
 * arquivo original.
 *
 * - `VinculatoMark`: só o símbolo, para favicon, sidebar recolhida e áreas compactas;
 * - `VinculatoLogo`: símbolo + logotipo, para login, cadastro, sidebar expandida,
 *   site público e áreas institucionais.
 *
 * As cores da identidade vivem em tokens (`--vin-*`) e foram extraídas dos
 * próprios pixels do símbolo, não estimadas.
 */
export const VINCULATO_BRAND = {
  navy: "#062B60",
  blue: "#168CFD",
  markSource: "/brand/vinculato-mark.png",
  logoSource: "/brand/vinculato-logo.png",
  /** Sobre fundo escuro o logotipo azul-marinho fica ilegível. */
  logoLightSource: "/brand/vinculato-logo-light.png",
  /** Proporções reais dos arquivos recortados. */
  markRatio: 512 / 459,
  logoRatio: 960 / 178,
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

type MarkProps ={ size?: number; title?: string; className?: string; priority?: boolean };

export function VinculatoMark({ size = 32, title = "Vinculato", className, priority }: MarkProps) {
  return (
    <Image
      className={className}
      src={VINCULATO_BRAND.markSource}
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
  /** `light` usa o logotipo em branco, para superfícies escuras. */
  tone?: "color" | "light";
};

/** Versão horizontal. `compact` devolve só o símbolo, para sidebar recolhida. */
export function VinculatoLogo({ size = 34, compact = false, className, title = "Vinculato", priority, tone = "color" }: LogoProps) {
  if (compact) return <VinculatoMark size={size} title={title} className={className} priority={priority} />;
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
