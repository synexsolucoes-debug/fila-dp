import type { Metadata } from "next";
import { chatGPTSignOutPath, getChatGPTUser } from "../chatgpt-auth";
import { LoginForm } from "./LoginForm";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Entrar | Fila DP",
  description: "Acesse seu ambiente de gestão de demandas do Departamento Pessoal.",
};

export default async function LoginPage() {
  const user = await getChatGPTUser();

  return (
    <main className="auth-page">
      <section className="auth-brand-panel">
        <a className="brand auth-brand" href="/#inicio" aria-label="Fila DP — início">
          <span className="brand-mark" aria-hidden="true"><i /><i /><i /></span>
          <span>Fila <strong>DP</strong></span>
        </a>

        <div className="auth-message">
          <span className="auth-kicker">Acesso seguro à sua operação</span>
          <h1>Sua fila continua de onde parou.</h1>
          <p>Entre para acompanhar demandas, responsáveis, checklists e prazos do Departamento Pessoal.</p>
        </div>

        <div className="auth-preview" aria-hidden="true">
          <div className="auth-preview-top"><span>Fila geral</span><span>•••</span></div>
          <div className="auth-preview-columns">
            <div><b>Novas</b><article><span className="auth-tag blue">ADMISSÃO</span><strong>Documentos de admissão</strong><small>Vence hoje</small></article></div>
            <div><b>Em análise</b><article><span className="auth-tag green">BENEFÍCIOS</span><strong>Inclusão no plano</strong><small>4 de 6 etapas</small></article></div>
            <div><b>Aguardando</b><article><span className="auth-tag gray">DOCUMENTOS</span><strong>Pendência do solicitante</strong><small>SLA pausado</small></article></div>
          </div>
        </div>
      </section>

      <section className="auth-form-panel">
        <a className="auth-back" href="/#inicio">← Voltar para o site</a>

        <div className="auth-form-card">
          {user ? (
            <>
              <span className="auth-status"><i /> Sessão ativa</span>
              <h2>Bem-vindo de volta.</h2>
              <p>Você está conectado como <strong>{user.displayName}</strong>.</p>
              <a className="button auth-primary" href="/painel">Continuar para o painel <span aria-hidden="true">→</span></a>
              <a className="auth-secondary-link" href={chatGPTSignOutPath("/login")}>Entrar com outra conta</a>
            </>
          ) : <LoginForm />}
        </div>

        <p className="auth-help">Precisa de acesso? Solicite um convite ao administrador do seu workspace.</p>
      </section>
    </main>
  );
}
