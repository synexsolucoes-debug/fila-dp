"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Camera, Keyboard, X } from "lucide-react";
import styles from "./field.module.css";

/**
 * Leitura de código de barras ou QR.
 *
 * Usa `BarcodeDetector`, que é API do navegador — nenhuma biblioteca de
 * terceiros. A escolha tem consequência honesta: hoje ela existe no Chrome do
 * Android e **não** existe no Safari do iPhone. Em vez de fingir que funciona
 * em todo lugar, o componente detecta o suporte e, onde não há, oferece o campo
 * de digitação como caminho principal — que é o que a pessoa faria de qualquer
 * forma, e não como um erro.
 *
 * A alternativa seria empacotar um decodificador em WebAssembly. Não vale:
 * somaria peso ao carregamento num aparelho de campo e uma dependência externa
 * ao CSP, para resolver o caso de quem já pode digitar o código.
 *
 * A câmera é desligada ao sair da tela. Deixar o fluxo aberto acende a luz do
 * aparelho e consome bateria de alguém que vai passar o turno com ele.
 */
type DetectedBarcode = { rawValue: string };
type BarcodeDetectorLike = { detect: (source: CanvasImageSource) => Promise<DetectedBarcode[]> };
type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

const detectorAvailable = () =>
  typeof window !== "undefined" && "BarcodeDetector" in window;

export function CodeScanner({ label, onCode, onClose }: {
  label: string;
  onCode: (code: string) => void;
  onClose: () => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [typed, setTyped] = useState("");
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");
  const supported = detectorAvailable();

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    setScanning(false);
  }, []);

  useEffect(() => stop, [stop]);

  const start = useCallback(async () => {
    setProblem("");
    if (!supported) {
      setProblem("Este navegador não lê código pela câmera. Digite o código abaixo.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setScanning(true);

      const Detector = (window as unknown as { BarcodeDetector: BarcodeDetectorConstructor }).BarcodeDetector;
      const detector = new Detector({ formats: ["qr_code", "code_128", "code_39", "ean_13"] });
      let active = true;
      const tick = async () => {
        if (!active || !videoRef.current) return;
        try {
          const found = await detector.detect(videoRef.current);
          const code = found[0]?.rawValue?.trim();
          if (code) {
            active = false;
            stop();
            onCode(code);
            return;
          }
        } catch {
          // Quadro ilegível é normal: segue tentando no próximo.
        }
        window.setTimeout(() => void tick(), 250);
      };
      void tick();
      return () => { active = false; };
    } catch {
      setProblem("Não foi possível abrir a câmera. Verifique a permissão ou digite o código.");
      stop();
    }
  }, [onCode, stop, supported]);

  function submitTyped() {
    const code = typed.trim();
    if (code) { stop(); onCode(code); }
  }

  return <div className={styles.scannerOverlay} role="dialog" aria-modal="true" aria-label={label}>
    <header className={styles.scannerHeader}>
      <strong>{label}</strong>
      <button type="button" className={styles.closeButton} onClick={() => { stop(); onClose(); }} aria-label="Fechar leitura">
        <X aria-hidden="true" />
      </button>
    </header>

    <div className={styles.scannerStage}>
      {/* `playsInline` é obrigatório: sem ele o iPhone abre o vídeo em tela
          cheia e tira a pessoa do fluxo. */}
      <video ref={videoRef} className={styles.scannerVideo} playsInline muted aria-hidden={!scanning} />
      {!scanning && <div className={styles.scannerIdle}>
        <Camera aria-hidden="true" />
        <p>{supported
          ? "Aponte a câmera para o código do EPI ou do crachá."
          : "Este navegador não lê código pela câmera — digite abaixo."}</p>
        {supported && <button type="button" className={styles.primaryButton} onClick={() => void start()}>
          <Camera aria-hidden="true" /> Abrir câmera
        </button>}
      </div>}
      {scanning && <div className={styles.scannerFrame} aria-hidden="true" />}
    </div>

    {problem && <p className={styles.scannerProblem} role="alert">{problem}</p>}

    <div className={styles.scannerManual}>
      <label>
        <span><Keyboard aria-hidden="true" /> CÓDIGO, MATRÍCULA OU CA</span>
        <input
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); submitTyped(); } }}
          placeholder="Digite e confirme"
          autoComplete="off"
          enterKeyHint="search"
        />
      </label>
      <button type="button" className={styles.primaryButton} onClick={submitTyped} disabled={!typed.trim()}>
        Usar este código
      </button>
    </div>
  </div>;
}
