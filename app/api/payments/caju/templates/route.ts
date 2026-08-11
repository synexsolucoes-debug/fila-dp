import { apiError, getApiUser } from "@/lib/fila-dp-api";
import { getWorkspaceContext, prepareAuditEvent } from "@/lib/fila-dp-db";
import { requireCapability } from "@/lib/authorization";
import { ApiError } from "@/lib/api-errors";
import { cajuFileExtension, parseCajuTemplate, templateCategory } from "@/lib/caju-template";

/**
 * Catálogo dos modelos oficiais de pedido da Caju.
 *
 * O produto não traz layout embutido: ele guarda o arquivo que o administrador
 * baixou do portal da Caju e gera a exportação a partir dele. Isso existe porque
 * a Caju publica um modelo por categoria de benefício e muda os rótulos sem
 * aviso — qualquer cabeçalho escrito no código viraria arquivo recusado.
 *
 * Um modelo ativo por vez, por workspace. As versões anteriores ficam retiradas,
 * não apagadas: saber com qual layout um pedido antigo foi gerado é parte da
 * conferência.
 */

const MAX_TEMPLATE_SIZE = 512 * 1024;
const ALLOWED_EXTENSIONS = new Set(["csv", "tsv", "txt"]);

type TemplateRow = {
  id: string;
  version: number;
  file_name: string;
  status: string;
  format: string;
  delimiter: string;
  category_key: string;
  amount_label: string;
  column_map_json: string;
  byte_size: number;
  note: string;
  uploaded_by: string;
  created_at: string;
  activated_at: string | null;
};

const categoryLabels: Record<string, string> = {
  saldo_livre: "Saldo Livre",
  alimentacao: "Auxílio Alimentação",
  refeicao: "Auxílio Refeição",
  mobilidade: "Mobilidade",
  desconhecida: "Categoria não identificada",
};

function present(row: TemplateRow) {
  let columns: string[] = [];
  try {
    const parsed = JSON.parse(row.column_map_json) as { headers?: unknown };
    if (Array.isArray(parsed.headers)) columns = parsed.headers.map(String);
  } catch {
    columns = [];
  }
  return {
    id: row.id,
    version: row.version,
    fileName: row.file_name,
    status: row.status,
    format: row.format,
    delimiter: row.delimiter,
    categoryKey: row.category_key,
    categoryLabel: categoryLabels[row.category_key] ?? row.amount_label,
    amountLabel: row.amount_label,
    columns,
    byteSize: row.byte_size,
    note: row.note,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
    activatedAt: row.activated_at,
  };
}

export async function GET() {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.payments.read");

    const rows = await d1.prepare(`SELECT id, version, file_name, status, format, delimiter, category_key, amount_label,
        column_map_json, byte_size, note, uploaded_by, created_at, activated_at
      FROM fdp_caju_templates WHERE workspace_id = ? ORDER BY version DESC`).bind(workspace.id).all<TemplateRow>();

    const templates = rows.results.map(present);
    return Response.json({
      templates,
      active: templates.find((template) => template.status === "active") ?? null,
    });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  const auth = await getApiUser();
  if (!auth.user) return auth.response;
  try {
    const { d1, workspace, user } = await getWorkspaceContext(auth.user);
    requireCapability(workspace, "contractors.export_caju");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      throw ApiError.badRequest("Selecione o arquivo de pedidos baixado do portal da Caju.", "CAJU_TEMPLATE_MISSING_FILE");
    }
    if (file.size > MAX_TEMPLATE_SIZE) {
      throw ApiError.badRequest("O modelo de pedidos da Caju é um arquivo de texto pequeno. Confira se enviou a planilha certa.", "CAJU_TEMPLATE_TOO_LARGE");
    }
    const extension = file.name.split(".").pop()?.toLowerCase() ?? "";
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      throw ApiError.badRequest("O modelo de pedidos é um arquivo separado por ponto e vírgula (.csv). Não envie XLSX.", "CAJU_TEMPLATE_FORMAT");
    }

    // Interpretar antes de gravar qualquer coisa: modelo ilegível não entra no
    // catálogo nem como rascunho.
    const content = await file.text();
    const shape = parseCajuTemplate(content);
    const category = templateCategory(shape);

    const nextVersion = await d1.prepare("SELECT COALESCE(MAX(version), 0) + 1 AS next FROM fdp_caju_templates WHERE workspace_id = ?")
      .bind(workspace.id).first<{ next: number }>();
    const version = Number(nextVersion?.next ?? 1);

    const templateId = crypto.randomUUID();
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(content)))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");

    const columnMap = JSON.stringify({
      headers: shape.headers,
      taxIdIndex: shape.taxIdIndex,
      amountIndex: shape.amountIndex,
      emptyIndexes: shape.emptyIndexes,
    });

    // Ativar é substituir: as duas escritas precisam acontecer juntas, senão o
    // índice parcial de "um ativo por workspace" recusa a segunda e o catálogo
    // fica sem modelo ativo nenhum.
    await d1.batch([
      d1.prepare("UPDATE fdp_caju_templates SET status = 'retired' WHERE workspace_id = ? AND status = 'active'").bind(workspace.id),
      d1.prepare(`INSERT INTO fdp_caju_templates
          (id, workspace_id, version, file_name, source_text, byte_size, checksum, column_map_json,
           status, format, delimiter, category_key, amount_label, uploaded_by, activated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, now())`)
        .bind(templateId, workspace.id, version, file.name.slice(0, 220), content, file.size, checksum, columnMap,
          cajuFileExtension(shape), shape.delimiter, category.key, shape.amountLabel, user.id),
    ]);

    await prepareAuditEvent({
      workspaceId: workspace.id, actorUserId: user.id, actorEmail: auth.user.email,
      action: "caju_template.activated", entityType: "caju_template", entityId: templateId,
      before: null,
      after: { version, categoryKey: category.key, amountLabel: shape.amountLabel, checksum },
      metadata: { fileName: file.name, columns: shape.headers, delimiter: shape.delimiter },
      requestId: request.headers.get("x-fila-dp-request-id"),
    }).run();

    const row = await d1.prepare(`SELECT id, version, file_name, status, format, delimiter, category_key, amount_label,
        column_map_json, byte_size, note, uploaded_by, created_at, activated_at
      FROM fdp_caju_templates WHERE workspace_id = ? AND id = ?`).bind(workspace.id, templateId).first<TemplateRow>();

    return Response.json({ template: row ? present(row) : null }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
