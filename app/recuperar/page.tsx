import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ResetPasswordForm } from "./ResetPasswordForm";
import { VinculatoLogo } from "@/app/components/VinculatoLogo";

export const dynamic = "force-dynamic";

export default async function RecoveryPage({ searchParams }: { searchParams: Promise<{ token?: string; email?: string }> }) {
  const params = await searchParams;
  return <main className="auth-page"><section className="auth-brand-panel"><Link className="brand auth-brand" href="/#inicio" aria-label="Vinculato — início"><VinculatoLogo size={30} tone="light" /></Link><div className="auth-message"><span className="auth-kicker">Recuperação de acesso</span><h1>Volte à operação com segurança.</h1><p>Links únicos, de curta duração e com uso controlado pelo administrador do workspace.</p></div></section><section className="auth-form-panel"><Link className="auth-back" href="/login"><ArrowLeft aria-hidden="true" /> Voltar para o login</Link><div className="auth-form-card"><ResetPasswordForm token={typeof params.token === "string" ? params.token : ""} email={typeof params.email === "string" ? params.email : ""} /></div><p className="auth-help">Não recebeu um link? Solicite um novo ao administrador do workspace.</p></section></main>;
}
