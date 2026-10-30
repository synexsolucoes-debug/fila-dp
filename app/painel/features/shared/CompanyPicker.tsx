"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Building2, Check, ChevronDown, Search } from "lucide-react";
import type { Company } from "@/lib/fila-dp-types";

type CompanyPickerProps = {
  companies: readonly Company[];
  /** `"all"` ou o id da empresa. */
  value: string;
  allLabel: string;
  onChange: (value: string) => void;
};

function formatCnpj(value: string) {
  const digits = value.replace(/\D/gu, "");
  return digits.length === 14
    ? digits.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/u, "$1.$2.$3/$4-$5")
    : value;
}

function normalize(value: string) {
  return value.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
}

/** Nome curto: o fantasia quando existe; razão social é a segunda linha. */
const shortName = (company: Company) => company.tradeName || company.legalName;

/**
 * Seletor de empresa da faixa superior.
 *
 * Substitui o `<select>` nativo, que listava razões sociais inteiras com "★" e
 * "↳" desenhados no texto: num grupo com nove CNPJs a lista virava um bloco de
 * caixa alta ilegível. Aqui o nome curto vem primeiro, a razão social e o CNPJ
 * embaixo, a matriz é marcada por rótulo e não por símbolo, e com mais de seis
 * empresas aparece a busca.
 */
export function CompanyPicker({ companies, value, allLabel, onChange }: CompanyPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const active = useMemo(() => companies
    .filter((company) => company.status === "active")
    .sort((a, b) => Number(b.isPrincipal) - Number(a.isPrincipal) || shortName(a).localeCompare(shortName(b), "pt-BR")),
  [companies]);
  const current = active.find((company) => company.id === value) ?? null;

  const filtered = useMemo(() => {
    const term = normalize(query.trim());
    if (!term) return active;
    const digits = term.replace(/\D/gu, "");
    return active.filter((company) => normalize(`${company.tradeName} ${company.legalName}`).includes(term)
      || (digits.length >= 3 && company.taxId.replace(/\D/gu, "").includes(digits)));
  }, [active, query]);

  useEffect(() => {
    if (!open) return;
    if (active.length > 6) searchRef.current?.focus();
    function onPointer(event: PointerEvent) {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, active.length]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
    setQuery("");
  };

  return (
    <div className="company-picker" ref={rootRef}>
      <button type="button" className="company-picker-trigger" aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? listId : undefined} onClick={() => setOpen((state) => !state)}
        title={current ? current.legalName : allLabel}>
        <Building2 aria-hidden="true" />
        <span>{current ? shortName(current) : allLabel}</span>
        <ChevronDown aria-hidden="true" />
      </button>
      {open && <div className="company-picker-panel">
        {active.length > 6 && <label className="company-picker-search">
          <Search aria-hidden="true" />
          <span className="sr-only">Buscar empresa</span>
          <input ref={searchRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Nome ou CNPJ" />
        </label>}
        <ul id={listId} role="listbox" aria-label="Empresa">
          {!query && <li role="option" aria-selected={value === "all"}>
            <button type="button" onClick={() => choose("all")}>
              <span><strong>{allLabel}</strong><small>{active.length} empresas</small></span>
              {value === "all" && <Check aria-hidden="true" />}
            </button>
          </li>}
          {filtered.map((company) => <li key={company.id} role="option" aria-selected={value === company.id}>
            <button type="button" onClick={() => choose(company.id)}>
              <span>
                <strong>{shortName(company)}{company.isPrincipal && <em>Matriz</em>}</strong>
                <small>{company.tradeName && company.legalName !== company.tradeName ? `${company.legalName} · ` : ""}{formatCnpj(company.taxId)}</small>
              </span>
              {value === company.id && <Check aria-hidden="true" />}
            </button>
          </li>)}
          {filtered.length === 0 && <li className="company-picker-empty">Nenhuma empresa com “{query.trim()}”.</li>}
        </ul>
      </div>}
    </div>
  );
}
