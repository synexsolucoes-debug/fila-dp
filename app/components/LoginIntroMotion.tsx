"use client";

import { useEffect, useRef } from "react";

type LoginIntroMotionProps = {
  destination: string;
};

const LIGHT_VIDEO = "/brand/vinculato-intro-light.mp4";
const DARK_VIDEO = "/brand/vinculato-intro-dark.mp4";

function resolveIntroVideo() {
  if (typeof window === "undefined") {
    return LIGHT_VIDEO;
  }

  try {
    const storedTheme =
      window.localStorage.getItem("vinculato-theme") ??
      window.localStorage.getItem("theme");

    if (storedTheme === "dark") return DARK_VIDEO;
    if (storedTheme === "light") return LIGHT_VIDEO;
  } catch {
    // localStorage pode estar indisponivel.
  }

  const html = document.documentElement;
  const body = document.body;

  const explicitTheme = html.dataset.theme ?? body.dataset.theme;

  if (explicitTheme === "dark") return DARK_VIDEO;
  if (explicitTheme === "light") return LIGHT_VIDEO;

  if (
    html.classList.contains("dark") ||
    body.classList.contains("dark")
  ) {
    return DARK_VIDEO;
  }

  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? DARK_VIDEO
    : LIGHT_VIDEO;
}

export function LoginIntroMotion({
  destination,
}: LoginIntroMotionProps) {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;

    if (!video) {
      window.location.assign(destination);
      return;
    }

    const selectedSource = resolveIntroVideo();

    // O video e um sistema externo ao React. Sincronizamos o src diretamente
    // no elemento, evitando setState dentro do effect e uma renderizacao extra.
    video.src = selectedSource;
    video.load();

    void video.play().catch(() => {
      window.location.assign(destination);
    });

    const fallback = window.setTimeout(() => {
      window.location.assign(destination);
    }, 4500);

    return () => {
      window.clearTimeout(fallback);
    };
  }, [destination]);

  function finish() {
    window.location.assign(destination);
  }

  return (
    <div
      role="status"
      aria-label="Abrindo o Vinculato"
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 99999,
        width: "100vw",
        height: "100dvh",
        overflow: "hidden",
        background: "var(--ui-bg, #f7f9fd)",
      }}
    >
      <video
        ref={videoRef}
        muted
        playsInline
        preload="auto"
        onEnded={finish}
        onError={finish}
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          display: "block",
        }}
      />

      <span
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          padding: 0,
          margin: -1,
          overflow: "hidden",
          clip: "rect(0, 0, 0, 0)",
          whiteSpace: "nowrap",
          border: 0,
        }}
      >
        Abrindo o Vinculato…
      </span>
    </div>
  );
}
