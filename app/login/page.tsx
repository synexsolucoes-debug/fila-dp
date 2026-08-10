import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, MoreHorizontal } from "lucide-react";
import { getChatGPTUser } from "../chatgpt-auth";
import { LoginForm } from "./LoginForm";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Entrar | Vinculato",
  description: "Acesse seu ambiente de gestão de demandas do Departamento Pessoal.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  // "Entrar em outra conta" chega aqui com a sessão já encerrada. Mesmo assim a
  // tela nunca deve oferecer "continuar": a intenção era trocar de identidade.
  const switching = query.trocar === "1";
  const user = switching ? null : await getChatGPTUser();

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Link className="brand auth-brand" href="/#inicio" aria-label="Vinculato — início">
          <VinculatoLogo size={32} tone="light" priority />
        </Link>

        <div className="auth-message">
          <span className="auth-kicker">Acesso seguro à sua operação</span>
          <h1>Sua operação continua de onde parou.</h1>
          <p>Entre para acompanhar processos, demandas, documentos e prazos do Departamento Pessoal.</p>
        </div>

        <div className="auth-preview" aria-hidden="true">
          <div className="auth-preview-top"><span>Fila geral</span><MoreHorizontal /></div>
          <div className="auth-preview-columns">
            <div><b>Novas</b><article><span className="auth-tag blue">CONCILIAÇÃO</span><strong>Vincular Sólides ao ERP</strong><small>Vence hoje</small></article></div>
            <div><b>Em análise</b><article><span className="auth-tag green">BENEFÍCIOS</span><strong>Inclusão no plano</strong><small>4 de 6 etapas</small></article></div>
            <div><b>Em execução</b><article><span className="auth-tag gray">CADASTRO</span><strong>Cadastro em andamento</strong><small>Dados em validação</small></article></div>
          </div>
        </div>
      </section>

      <section className="auth-form-panel">
        <Link className="auth-back" href="/#inicio"><ArrowLeft aria-hidden="true" /> Voltar para o site</Link>

        <div className="auth-form-card">
          {user ? (
            <>
              <span className="auth-status"><i /> Sessão ativa</span>
              <h2>Bem-vindo de volta.</h2>
              <p>Você está conectado como <strong>{user.displayName}</strong>.</p>
              <a className="button auth-primary" href="/painel">Continuar para o painel <ArrowRight aria-hidden="true" /></a>
              <form method="post" action="/api/auth/logout">
                <input type="hidden" name="trocar" value="1" />
                <button type="submit" className="auth-secondary-link">Entrar em outra conta</button>
              </form>
            </>
          ) : <LoginForm />}
        </div>

        <p className="auth-help">Precisa de acesso? Solicite um convite ao administrador do seu workspace.</p>
      </section>
    </main>
  );
}
