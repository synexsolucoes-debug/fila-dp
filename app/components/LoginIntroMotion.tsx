"use client";

import { useEffect, useRef } from "react";

type LoginIntroMotionProps = {
  destination: string;
};

const INTRO_VIDEO = "/brand/vinculato-intro-dark.mp4";

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

    video.src = INTRO_VIDEO;
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
        background: "#09131f",
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
        Abrindo o Vinculato?
      </span>
    </div>
  );
}
