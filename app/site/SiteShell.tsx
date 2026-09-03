import Link from "next/link";
import type { ReactNode } from "react";
import { legalNavigation, siteNavigation } from "@/lib/marketing";
import styles from "./site.module.css";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";
import { SiteMenu } from "@/app/components/SiteMenu";

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
            {/* Variante clara: o cabeçalho público virou superfície escura com a
                Central de comando, e o logotipo azul-marinho não se lê nela —
                é o que o próprio componente avisa. */}
            <VinculatoLogo size={28} tone="light" priority />
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
            {/* O mesmo destino do botão da home: a demonstração tem página e
                formulário próprios, e mandar para /contato pedia ao visitante
                que escolhesse o assunto de novo. */}
            <Link className={styles.primaryButton} href="/demonstracao">Agendar demonstração</Link>
            {/* O mesmo menu da home. Sem ele, o cabeçalho das páginas internas
                empilhava seis links e dois botões em três fileiras no celular —
                funcionava, mas era outro produto a cada página. */}
            <SiteMenu actions={<>
              <Link className={styles.ghostButton} href="/login">Entrar</Link>
              <Link className={styles.primaryButton} href="/demonstracao">Agendar demonstração</Link>
            </>} />
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
          <nav aria-label="Acesso e suporte">
            <span>Acesso e suporte</span>
            <Link href="/login">Entrar</Link>
            <Link href="/recuperar">Recuperar acesso</Link>
            <Link href="/contato?assunto=suporte">Suporte</Link>
            <Link href="/planos#condicoes">Cancelamento</Link>
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
