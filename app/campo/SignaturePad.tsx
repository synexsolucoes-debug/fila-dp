"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Eraser } from "lucide-react";
import styles from "./field.module.css";

/**
 * Assinatura do colaborador, colhida no vidro do celular.
 *
 * Três decisões que parecem detalhe e não são:
 *
 *  - **Eventos de ponteiro**, não de toque: o mesmo código serve dedo, caneta e
 *    mouse, e `touch-action: none` no CSS impede a página de rolar enquanto a
 *    pessoa assina — sem isso, assinar arrasta a tela e sai um risco torto.
 *  - **Resolução do dispositivo** (`devicePixelRatio`): um canvas dimensionado
 *    em CSS sem ajustar o buffer gera traço borrado no celular, e o termo é
 *    documento.
 *  - **PNG com fundo branco**, não transparente: o anexo é lido depois em
 *    visualizadores que mostram transparência como preto, e a assinatura
 *    desapareceria.
 *
 * O branco do papel e o grafite do traço são escritos à mão de propósito, e são
 * as duas únicas cores assim em toda a tela de campo: eles não pertencem à
 * paleta da interface, pertencem ao documento. Se seguissem o tema, o termo
 * assinado mudaria de cor com a preferência de quem colheu a assinatura, e o
 * arquivo guardado deixaria de ser o que a pessoa viu ao assinar.
 *
 * O componente não envia nada. Ele entrega o Blob a quem chamou, porque a
 * assinatura só faz sentido junto da entrega que ela confirma.
 */
export function SignaturePad({ onChange, disabled }: {
  onChange: (blob: Blob | null) => void;
  disabled?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const touched = useRef(false);
  const [hasInk, setHasInk] = useState(false);

  const prepare = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const bounds = canvas.getBoundingClientRect();
    canvas.width = Math.round(bounds.width * ratio);
    canvas.height = Math.round(bounds.height * ratio);
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(ratio, ratio);
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, bounds.width, bounds.height);
    context.lineWidth = 2.2;
    context.lineCap = "round";
    context.lineJoin = "round";
    context.strokeStyle = "#111827";
  }, []);

  useEffect(() => {
    prepare();
    // Girar o aparelho redimensiona o canvas e apaga o traço; refazer a base
    // evita um canvas de tamanho novo com conteúdo do tamanho antigo.
    const onResize = () => { prepare(); touched.current = false; setHasInk(false); onChange(null); };
    window.addEventListener("orientationchange", onResize);
    return () => window.removeEventListener("orientationchange", onResize);
  }, [onChange, prepare]);

  function positionOf(event: React.PointerEvent<HTMLCanvasElement>) {
    const bounds = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - bounds.left, y: event.clientY - bounds.top };
  }

  function start(event: React.PointerEvent<HTMLCanvasElement>) {
    if (disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const { x, y } = positionOf(event);
    context.beginPath();
    context.moveTo(x, y);
  }

  function move(event: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawing.current || disabled) return;
    const context = canvasRef.current?.getContext("2d");
    if (!context) return;
    const { x, y } = positionOf(event);
    context.lineTo(x, y);
    context.stroke();
    if (!touched.current) { touched.current = true; setHasInk(true); }
  }

  function end() {
    if (!drawing.current) return;
    drawing.current = false;
    const canvas = canvasRef.current;
    if (!canvas || !touched.current) return;
    canvas.toBlob((blob) => onChange(blob), "image/png");
  }

  function clear() {
    prepare();
    touched.current = false;
    setHasInk(false);
    onChange(null);
  }

  return <div className={styles.signatureBlock}>
    <canvas
      ref={canvasRef}
      className={styles.signatureCanvas}
      aria-label="Área de assinatura do colaborador"
      role="img"
      onPointerDown={start}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onPointerLeave={end}
    />
    <div className={styles.signatureFooter}>
      <span>{hasInk ? "Assinatura capturada" : "O colaborador assina com o dedo acima"}</span>
      <button type="button" className={styles.ghostButton} onClick={clear} disabled={disabled || !hasInk}>
        <Eraser aria-hidden="true" /> Limpar
      </button>
    </div>
  </div>;
}
