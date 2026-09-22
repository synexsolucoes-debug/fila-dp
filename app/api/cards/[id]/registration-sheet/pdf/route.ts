import { GET as getRegistrationSheet } from "../route";
import { buildVinculatoAdmissionSheetPdf } from "@/lib/vinculato-admission-sheet-pdf";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Emite a ficha própria do Vinculato a partir dos mesmos dados cifrados e das
 * mesmas permissões da tela. O PDF original da Sólides continua anexado como
 * evidência; este arquivo é a versão legível para conferência e ERP.
 */
export async function GET(request: Request, context: RouteContext) {
  const response = await getRegistrationSheet(request, context);
  if (!response.ok) return response;

  const payload = await response.json() as {
    state?: string;
    sheet?: Parameters<typeof buildVinculatoAdmissionSheetPdf>[0]["sheet"] | null;
  };
  if (payload.state !== "ready" || !payload.sheet) {
    return Response.json({
      error: "A ficha do Vinculato só pode ser emitida depois que a leitura estiver pronta.",
      code: "ADMISSION_SHEET_NOT_READY",
    }, { status: 409 });
  }

  const sheet = payload.sheet as typeof payload.sheet & {
    provenance?: Parameters<typeof buildVinculatoAdmissionSheetPdf>[0]["provenance"];
    sourceFilename?: string;
  };
  const pdf = await buildVinculatoAdmissionSheetPdf({
    sheet,
    provenance: sheet.provenance,
    sourceFilename: sheet.sourceFilename,
  });
  return new Response(new Uint8Array(pdf), {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'attachment; filename="ficha-admissao-vinculato.pdf"',
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
