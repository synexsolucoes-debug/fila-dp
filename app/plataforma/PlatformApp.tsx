"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Activity, Blocks, Building2, CreditCard, Gauge, HeartPulse, ScrollText, ShieldCheck, Users } from "lucide-react";
import { VinculatoMark } from "@/app/components/VinculatoLogo";
import styles from "./platform.module.css";
import { AuditFeature } from "./features/AuditFeature";
import { BillingFeature } from "./features/BillingFeature";
import { ClientsFeature } from "./features/ClientsFeature";
import { HealthFeature } from "./features/HealthFeature";
import { IntegrationsFeature } from "./features/IntegrationsFeature";
import { OperationsFeature } from "./features/OperationsFeature";
import { OverviewFeature } from "./features/OverviewFeature";
import { SecurityFeature } from "./features/SecurityFeature";
import { UsersFeature } from "./features/UsersFeature";

export const platformAreas = [
  ["overview", "Visão geral", Gauge], ["clients", "Clientes", Building2], ["users", "Usuários", Users],
  ["integrations", "Integrações", Blocks], ["operations", "Configuração operacional", Activity], ["billing", "Financeiro", CreditCard],
  ["security", "Segurança", ShieldCheck], ["audit", "Auditoria", ScrollText], ["health", "Saúde", HeartPulse],
] as const;
export type PlatformArea = typeof platformAreas[number][0];
const validAreas = new Set<PlatformArea>(platformAreas.map(([key]) => key));

export function PlatformApp() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const candidate = params.get("area") as PlatformArea | null;
  const area: PlatformArea = candidate && validAreas.has(candidate) ? candidate : "overview";
  const updateQuery = (updates: Record<string, string | null>) => {
    const next = new URLSearchParams(params.toString());
    for (const [key, value] of Object.entries(updates)) {
      if (value) next.set(key, value); else next.delete(key);
    }
    router.push(`${pathname}?${next.toString()}`, { scroll: false });
  };
  const go = (nextArea: PlatformArea) => updateQuery({
    area: nextArea === "overview" ? null : nextArea,
    workspace: null, company: null, user: null, integration: null, cursor: null, q: null, status: null, connector: null, errors: null, expiring: null, stalled: null,
    actor: null, entity: null, action: null, requestId: null, from: null, to: null, leadStatus: null, leadCursor: null,
  });
  const shared = { params, updateQuery };
  const feature = area === "clients" ? <ClientsFeature {...shared} />
    : area === "users" ? <UsersFeature {...shared} />
      : area === "integrations" ? <IntegrationsFeature {...shared} />
        : area === "operations" ? <OperationsFeature {...shared} />
          : area === "billing" ? <BillingFeature {...shared} />
            : area === "security" ? <SecurityFeature />
              : area === "audit" ? <AuditFeature {...shared} />
                : area === "health" ? <HealthFeature />
                  : <OverviewFeature onNavigate={go} />;

  return <main className={styles.console}>
    <header className={styles.topbar}>
      <Link href="/painel" aria-label="Voltar ao painel operacional"><VinculatoMark size={26} title="" /><strong>Vinculato</strong><small>CONTROLE GLOBAL</small></Link>
      <div><ShieldCheck aria-hidden="true" /><span><strong>Contexto de plataforma</strong><small>Autorização global validada no servidor</small></span></div>
    </header>
    <div className={styles.consoleLayout}>
      <aside className={styles.sideNav} aria-label="Áreas da administração global">
        <p>Administração</p>
        <nav>{platformAreas.map(([key, label, Icon]) => <button key={key} type="button" aria-current={area === key ? "page" : undefined} onClick={() => go(key)}><Icon aria-hidden="true" /><span>{label}</span></button>)}</nav>
        <footer><ShieldCheck aria-hidden="true" /><span>Escopo global</span></footer>
      </aside>
      {/* `key={area}` remonta o palco a cada troca de área: é o que faz a
          animação de entrada rodar de novo em vez de só na primeira carga. */}
      <section className={styles.featureStage} key={area}>{feature}</section>
    </div>
  </main>;
}
