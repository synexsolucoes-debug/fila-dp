/**
 * Marca do Vinculato.
 *
 * O símbolo é o traço em "V" (azul-marinho) encontrando o arco (azul vivo) — a
 * ideia de vínculo entre duas partes. Existem duas composições, como na marca:
 *
 * - `mark`: só o símbolo, para favicon, sidebar recolhida e espaços compactos;
 * - `full`: símbolo + logotipo, para login, cadastro, sidebar expandida e site.
 *
 * As cores vêm dos tokens da identidade; não há HEX repetido nos componentes que
 * consomem este arquivo.
 *
 * IMPORTANTE: este é um desenho vetorial da marca feito a partir da referência.
 * Quando os arquivos oficiais (SVG/PNG exportados pelo estúdio) estiverem
 * disponíveis, substitua o conteúdo de `VinculatoMark` por eles — a API do
 * componente foi mantida estável justamente para essa troca ser indolor.
 */
type MarkProps = { size?: number; title?: string; className?: string };

export function VinculatoMark({ size = 32, title = "Vinculato", className }: MarkProps) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      role="img"
      aria-label={title}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      {/* Traço descendente do V, em azul-marinho profundo. */}
      <path
        d="M14 20c3.6-6.4 12-6 14.6.6L41 51c-4.6 3.6-11.4 2-13.8-3.6L14 20Z"
        fill="var(--vin-navy-deep, #030A30)"
      />
      {/* Arco de retorno, em azul vivo: a outra ponta do vínculo. */}
      <path
        d="M34 16c9.8 0 17.6 8 17.6 17.8 0 7.6-4.6 14.2-11.4 16.8l-5-11.4c2.8-1.2 4.8-4 4.8-7.2 0-4.2-3.4-7.6-7.6-7.6h-2.6L34 16Z"
        fill="var(--vin-blue-vivid, #0B86FE)"
      />
    </svg>
  );
}

type LogoProps = MarkProps & { compact?: boolean };

export function VinculatoLogo({ size = 34, compact = false, className }: LogoProps) {
  if (compact) return <VinculatoMark size={size} className={className} />;
  return (
    <span
      className={className}
      style={{ display: "inline-flex", alignItems: "center", gap: 10, lineHeight: 1 }}
    >
      <VinculatoMark size={size} title="" />
      <span
        style={{
          fontSize: size * 0.72,
          fontWeight: 700,
          letterSpacing: "-0.02em",
          color: "var(--vin-navy-deep, #030A30)",
        }}
      >
        Vinculato
      </span>
    </span>
  );
}

/** Assinatura institucional: usada no site, no login e nos documentos. */
export const VINCULATO_TAGLINE = "Sua operação, conectada.";
