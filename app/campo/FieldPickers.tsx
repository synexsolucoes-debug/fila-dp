"use client";

import { useCallback, useEffect, useState } from "react";
import { HardHat, ScanLine, Search, UserRound } from "lucide-react";
import { normalizeEmployeeOption, normalizeProduct, type Row } from "@/app/painel/features/epi/epi.api";
import type { EmployeeOption, EpiProduct } from "@/app/painel/features/epi/epi.types";
import { CodeScanner } from "./CodeScanner";
import { requestJson } from "./field.api";
import styles from "./field.module.css";

/**
 * Busca de colaborador e de EPI, compartilhada pelos fluxos de campo.
 *
 * Moram num arquivo próprio porque as telas do SESMT (estoque, vencimentos)
 * usam as mesmas buscas que a entrega. Duas cópias divergiriam no primeiro
 * ajuste — e a diferença apareceria só no celular de quem está no galpão.
 */

export function EmployeePicker({ companyId, onPick, title = "Quem vai receber?" }: {
  companyId: string; onPick: (employee: EmployeeOption) => void; title?: string;
}) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<EmployeeOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");

  const search = useCallback(async (value: string) => {
    const query = value.trim();
    if (!query) { setResults([]); return; }
    setBusy(true);
    try {
      const params = new URLSearchParams({ companyId, status: "active", limit: "25", search: query });
      const payload = await requestJson<{ employees?: Row[] }>(`/api/employees?${params}`);
      const list = (payload.employees ?? []).map(normalizeEmployeeOption);
      setResults(list);
      setProblem(list.length ? "" : "Nenhum colaborador encontrado com esse nome ou matrícula.");
      // Leitura de código que acha um só: segue direto, que é o ganho do scanner.
      if (list.length === 1) onPick(list[0]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao buscar colaborador.");
    } finally { setBusy(false); }
  }, [companyId, onPick]);

  return <section className={styles.step}>
    <h2>{title}</h2>
    <div className={styles.searchRow}>
      <input value={term} onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(term); } }}
        placeholder="Nome ou matrícula" autoComplete="off" enterKeyHint="search" aria-label="Buscar colaborador" />
      {/* O ícone é a única coisa dentro do botão, e `aria-hidden` o esconde do
          leitor de tela — sem rótulo o botão não tem nome nenhum. A varredura
          WCAG apontou isto nas quatro telas de campo. */}
      <button type="button" className={styles.secondaryButton} onClick={() => void search(term)}
        disabled={busy} aria-label="Procurar com o nome digitado">
        <Search aria-hidden="true" />
      </button>
      <button type="button" className={styles.secondaryButton} onClick={() => setScanning(true)} aria-label="Ler crachá">
        <ScanLine aria-hidden="true" />
      </button>
    </div>
    {problem && <p className={styles.hint} role="alert">{problem}</p>}
    <ul className={styles.pickList}>
      {results.map((employee) => <li key={employee.id}>
        <button type="button" onClick={() => onPick(employee)}>
          <UserRound aria-hidden="true" />
          <span><strong>{employee.name}</strong><small>{employee.registrationNumber} · {employee.positionName || "Sem cargo"}</small></span>
        </button>
      </li>)}
    </ul>
    {scanning && <CodeScanner label="Ler crachá do colaborador"
      onCode={(code) => { setScanning(false); setTerm(code); void search(code); }}
      onClose={() => setScanning(false)} />}
  </section>;
}

/**
 * Saldo do EPI **no local escolhido**.
 *
 * `stockQuantity` é o disponível somado de todos os locais, e a entrega debita
 * um local só. Mostrar o total faria a tela oferecer doze unidades onde há
 * zero: a pessoa entregaria, e a recusa chegaria depois — longe do colaborador
 * que já assinou.
 */
export const availableAt = (product: EpiProduct, locationId: string) =>
  product.stockLocations.find((place) => place.id === locationId)?.quantity ?? 0;

/** Lista de EPIs ativos, com o saldo de cada local. Usada pela busca e pela consulta de estoque. */
export async function searchProducts(query: string, limit = 25) {
  const params = new URLSearchParams({ limit: String(limit) });
  if (query.trim()) params.set("search", query.trim());
  const payload = await requestJson<{ products?: Row[] }>(`/api/epi/products?${params}`);
  return (payload.products ?? []).map(normalizeProduct)
    .filter((item) => !["discarded", "lost", "inactive"].includes(item.status));
}

export function ProductPicker({ locationId, onPick, title = "Qual EPI?", allowEmpty = false, initialTerm = "", preferId = "" }: {
  locationId: string;
  onPick: (product: EpiProduct) => void;
  title?: string;
  /**
   * Entrada de estoque escolhe justamente o EPI que está zerado. A entrega e a
   * transferência não podem: sairia unidade de onde não há.
   */
  allowEmpty?: boolean;
  /** Busca já preenchida — a entrega aberta da lista de vencimentos chega sabendo qual EPI é. */
  initialTerm?: string;
  /** Com a busca inicial, escolhe sozinho o EPI com este id se ele tiver saldo aqui. */
  preferId?: string;
}) {
  const [term, setTerm] = useState(initialTerm);
  const [results, setResults] = useState<EpiProduct[]>([]);
  const [busy, setBusy] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [problem, setProblem] = useState("");

  const usable = useCallback((product: EpiProduct) => allowEmpty || availableAt(product, locationId) > 0, [allowEmpty, locationId]);

  const search = useCallback(async (value: string, auto: boolean) => {
    const query = value.trim();
    setBusy(true);
    try {
      const list = await searchProducts(query);
      setResults(list);
      setProblem(list.length ? "" : "Nenhum EPI encontrado por nome, código interno ou CA.");
      const preferred = auto && preferId ? list.find((item) => item.id === preferId) : undefined;
      if (preferred && usable(preferred)) onPick(preferred);
      else if (query && list.length === 1 && usable(list[0])) onPick(list[0]);
    } catch (cause) {
      setProblem(cause instanceof Error ? cause.message : "Erro ao buscar EPI.");
    } finally { setBusy(false); }
  }, [onPick, preferId, usable]);

  // A busca inicial roda uma vez, na montagem. `initialTerm` é valor de
  // abertura, não estado controlado: refazer a busca a cada tecla sobrescreveria
  // o que a pessoa está digitando.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => void search(initialTerm, true));
    return () => window.cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <section className={styles.step}>
    <h2>{title}</h2>
    <div className={styles.searchRow}>
      <input value={term} onChange={(event) => setTerm(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); void search(term, false); } }}
        placeholder="Nome, código interno ou CA" autoComplete="off" enterKeyHint="search" aria-label="Buscar EPI" />
      <button type="button" className={styles.secondaryButton} onClick={() => void search(term, false)}
        disabled={busy} aria-label="Procurar com o código digitado">
        <Search aria-hidden="true" />
      </button>
      <button type="button" className={styles.secondaryButton} onClick={() => setScanning(true)} aria-label="Ler código do EPI">
        <ScanLine aria-hidden="true" />
      </button>
    </div>
    {problem && <p className={styles.hint} role="alert">{problem}</p>}
    <ul className={styles.pickList}>
      {results.map((product) => {
        const here = availableAt(product, locationId);
        return <li key={product.id}>
          <button type="button" onClick={() => onPick(product)} disabled={!usable(product)}>
            <HardHat aria-hidden="true" />
            <span>
              <strong>{product.name}</strong>
              <small>CA {product.caNumber || "—"} · {product.size || "—"} · {here > 0
                ? `${here} neste local`
                : `sem saldo aqui${product.stockQuantity > 0 ? ` (${product.stockQuantity} em outros locais)` : ""}`}</small>
            </span>
          </button>
        </li>;
      })}
    </ul>
    {scanning && <CodeScanner label="Ler código do EPI"
      onCode={(code) => { setScanning(false); setTerm(code); void search(code, false); }}
      onClose={() => setScanning(false)} />}
  </section>;
}

export function Chosen({ label, value, onClear }: { label: string; value: string; onClear: () => void }) {
  return <div className={styles.chosen}>
    <span><small>{label}</small><strong>{value}</strong></span>
    <button type="button" className={styles.ghostButton} onClick={onClear}>Trocar</button>
  </div>;
}

/** Quantidade com alvo de luva. `max` é o teto real — saldo do local ou o que está em poder. */
export function Stepper({ value, onChange, max }: { value: number; onChange: (next: number) => void; max: number }) {
  const ceiling = Math.max(max, 1);
  return <div className={styles.stepper}>
    <button type="button" onClick={() => onChange(Math.max(1, value - 1))} aria-label="Diminuir">−</button>
    <output aria-live="polite">{value}</output>
    <button type="button" onClick={() => onChange(Math.min(ceiling, value + 1))} aria-label="Aumentar">+</button>
  </div>;
}
