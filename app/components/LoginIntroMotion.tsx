"use client";

import Image from "next/image";
import { useCallback, useEffect, useRef, useState } from "react";
import { VINCULATO_BRAND } from "@/app/components/VinculatoLogo";

/**
 * Abertura do sistema depois do login.
 *
 * A primeira versão era um MP4 de 1920x1080 a 30 quadros ocupando 321 KB — algo
 * perto de 850 kbps. Bitrate assim, num plano quase todo preto com uma marca
 * clara de borda dura, é o caso pior do H.264: o codec gasta os bits no
 * gradiente do fundo e devolve halo e serrilhado em volta do símbolo. Era essa
 * a "qualidade ruim" que aparecia na entrada, e ela não tinha conserto por
 * reencode: o arquivo entregue já era o resultado comprimido.
 *
 * Agora a abertura é desenhada pelo próprio navegador a partir do arquivo
 * oficial da marca, em PNG sem perdas. Não há quadro comprimido em lugar
 * nenhum, a nitidez acompanha a densidade da tela, o enquadramento deixa de
 * depender de `object-fit: cover` (que no celular em pé cortava o logotipo) e a
 * entrada deixa de baixar 321 KB de vídeo.
 *
 * A composição reproduz os mesmos dois momentos do vídeo antigo: o símbolo
 * sozinho e, em seguida, o logotipo completo. Ela sai de um recorte do mesmo
 * arquivo, então continua valendo a regra da marca — o que aparece na tela é o
 * arquivo original, sem redesenho.
 */
type LoginIntroMotionProps = {
  destination: string;
};

/** A animação dura 2400ms; a margem cobre o quadro final antes de navegar. */
const INTRO_DURATION_MS = 2600;

/**
 * Teto para a espera do arquivo da marca. Nenhuma falha de imagem pode segurar
 * quem já autenticou: passado esse tempo a abertura começa mesmo sem o PNG
 * decodificado, e o encadeamento normal leva ao destino.
 */
const ASSET_TIMEOUT_MS = 900;

export function LoginIntroMotion({
  destination,
}: LoginIntroMotionProps) {
  const [started, setStarted] = useState(false);
  const navigated = useRef(false);

  const finish = useCallback(() => {
    if (navigated.current) return;
    navigated.current = true;
    window.location.assign(destination);
  }, [destination]);

  useEffect(() => {
    const timer = window.setTimeout(() => setStarted(true), ASSET_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!started) return;
    // Rede de segurança do encerramento: `animationend` não chega quando o
    // sistema operacional desliga animações, e nesse caso a tela ficaria parada
    // no símbolo para sempre.
    const timer = window.setTimeout(finish, INTRO_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [started, finish]);

  return (
    <div className="vin-intro" role="status" aria-label="Abrindo o Vinculato">
      <div className="vin-intro-glow" aria-hidden="true" />

      <div
        className={started ? "vin-intro-lockup is-playing" : "vin-intro-lockup"}
        onAnimationEnd={finish}
        aria-hidden="true"
      >
        <Image
          className="vin-intro-art"
          src={VINCULATO_BRAND.logoLightSource}
          alt=""
          width={960}
          height={178}
          priority
          // Sem otimizador: o PNG original chega byte a byte. Reencodar a marca
          // para WebP com perdas devolveria, em pequeno, o mesmo halo que o
          // vídeo produzia em grande.
          unoptimized
          onLoad={() => setStarted(true)}
          onError={() => setStarted(true)}
        />
      </div>

      <span className="vin-intro-caption">Abrindo o Vinculato…</span>
    </div>
  );
}
