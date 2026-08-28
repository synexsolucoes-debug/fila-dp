"use client";

import { useEffect } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";

export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[fila-dp][painel] renderização interrompida", error);
    void fetch("/api/client-errors", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: error.message, digest: error.digest ?? "" }),
    }).catch(() => undefined);
  }, [error]);

  return (
    <main className="panel-error-boundary">
      <div>
        <span>VINCULATO</span>
        <h1>Não foi possível abrir o painel.</h1>
        <p>A operação continua protegida. Tente carregar novamente; se persistir, o erro já ficará disponível para diagnóstico.</p>
        <button type="button" onClick={reset}><RefreshCw aria-hidden="true" /> Tentar novamente</button>
        <Link href="/">Voltar ao início</Link>
      </div>
    </main>
  );
}
