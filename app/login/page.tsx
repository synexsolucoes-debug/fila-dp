import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, ArrowRight, MoreHorizontal } from "lucide-react";
import { chatGPTSignOutPath, getChatGPTUser } from "../chatgpt-auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Entrar | Vinculato",
  description: "Acesse seu ambiente de gestão de demandas do Departamento Pessoal.",
};

export default async function LoginPage() {
  const user = await getChatGPTUser();

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <Link className="brand auth-brand" href="/#inicio" aria-label="Vinculato — início">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Vinculato</span>
        </Link>

        <div className="auth-message">
          <span className="auth-kicker">Acesso seguro à sua operação</span>
          <h1>Sua fila continua de onde parou.</h1>
          <p>Entre para acompanhar demandas, responsáveis, checklists e prazos do Departamento Pessoal.</p>
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
              <a className="auth-secondary-link" href={chatGPTSignOutPath("/login")}>Entrar com outra conta</a>
            </>
          ) : <LoginForm />}
        </div>

        <p className="auth-help">Precisa de acesso? Solicite um convite ao administrador do seu workspace.</p>
      </section>
    </main>
  );
}
