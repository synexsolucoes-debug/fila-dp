import { clearAuthSession, safeRelativeReturnPath } from "@/app/chatgpt-auth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function redirectTarget(request: Request) {
  const value = new URL(request.url).searchParams.get("return_to") ?? "/";
  return safeRelativeReturnPath(value);
}

/**
 * Encerrar sessão — sempre por POST.
 *
 * Logout por GET seria disparado por qualquer `<img>`, prefetch ou link
 * visitado por um scanner: o usuário cairia da sessão sem ter pedido. Por isso
 * a rota recusa GET, e "Entrar em outra conta" é um formulário POST, não um
 * link. Era justamente esse o defeito relatado: a tela de login oferecia a troca
 * como link, o GET batia numa rota só-POST, voltava **405** e a sessão anterior
 * continuava viva.
 *
 * Duas formas de resposta, conforme quem chama:
 * - `fetch` do painel recebe JSON com o destino;
 * - envio de formulário (navegação) recebe 303 e o navegador segue sozinho.
 */
export async function POST(request: Request) {
  await clearAuthSession();

  const url = new URL(request.url);
  let switching = url.searchParams.get("trocar") === "1";
  let wantsRedirect = false;

  const contentType = request.headers.get("content-type") ?? "";
  if (contentType.includes("form")) {
    const form = await request.formData().catch(() => null);
    if (form?.get("trocar") === "1") switching = true;
    // Envio de formulário é navegação: responder JSON deixaria a página em branco.
    wantsRedirect = true;
  }

  // Trocar de conta tem destino fixo e interno. Não passa pelo `return_to` do
  // usuário — `safeRelativeReturnPath` recusa `/login` de propósito (para o
  // login não redirecionar para si mesmo depois de entrar), e um destino
  // constante não pode ser usado para redirecionamento aberto.
  const target = switching ? "/login?trocar=1" : redirectTarget(request);

  if (wantsRedirect) {
    return new Response(null, {
      // 303 faz o navegador seguir com GET em vez de repetir o POST.
      status: 303,
      headers: {
        Location: target,
        // Sem isso o histórico reabre a tela autenticada anterior.
        "Cache-Control": "no-store, no-cache, must-revalidate",
      },
    });
  }

  return Response.json({ ok: true, redirectTo: target }, { headers: { "Cache-Control": "no-store" } });
}
