import Link from "next/link";
import type { ReactNode } from "react";
import { legalNavigation, siteNavigation } from "@/lib/marketing";
import styles from "./site.module.css";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";

/**
 * Moldura das páginas comerciais: cabeçalho, navegação, rodapé e área de
 * conteúdo. Mantém uma única fonte de navegação para o site inteiro.
 */
export function SiteShell({ children, active }: { children: ReactNode; active?: string }) {
  return (
    <div className={styles.site}>
      <a className={styles.skipLink} href="#conteudo">Ir para o conteúdo</a>

      <header className={styles.header}>
        <div className={styles.headerInner}>
          <Link className={styles.brand} href="/" aria-label="Vinculato — início">
            <VinculatoLogo size={28} priority />
          </Link>
          <nav className={styles.nav} aria-label="Navegação do site">
            {siteNavigation.map((item) => (
              <Link key={item.href} href={item.href} aria-current={active === item.href ? "page" : undefined}>
                {item.label}
              </Link>
            ))}
          </nav>
          <div className={styles.headerActions}>
            <Link className={styles.ghostButton} href="/login">Entrar</Link>
            <Link className={styles.primaryButton} href="/contato?assunto=demonstracao">Falar com a equipe</Link>
          </div>
        </div>
      </header>

      <main id="conteudo" className={styles.main}>{children}</main>

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <div>
            <strong>Vinculato</strong>
            <p>Gestão, integração e conferência operacional para Departamento Pessoal.</p>
          </div>
          <nav aria-label="Páginas do produto">
            <span>Produto</span>
            {siteNavigation.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
          </nav>
          <nav aria-label="Documentos legais">
            <span>Legal</span>
            {legalNavigation.map((item) => <Link key={item.href} href={item.href}>{item.label}</Link>)}
          </nav>
          <nav aria-label="Acesso">
            <span>Acesso</span>
            <Link href="/login">Entrar</Link>
            <Link href="/recuperar">Recuperar acesso</Link>
            <Link href="/contato">Contato</Link>
          </nav>
        </div>
        <p className={styles.footerNote}>
          A admissão digital é executada na Sólides. A folha oficial permanece no ERP do cliente. O módulo de Psicólogos
          controla apenas pagamento de consultas e o módulo PJ não substitui contador nem emite nota fiscal.
        </p>
      </footer>
    </div>
  );
}

export function SiteHero({ eyebrow, title, description, children }: {
  eyebrow: string; title: string; description: string; children?: ReactNode;
}) {
  return (
    <section className={styles.hero}>
      <span className={styles.eyebrow}>{eyebrow}</span>
      <h1>{title}</h1>
      <p>{description}</p>
      {children}
    </section>
  );
}

export { styles as siteStyles };
