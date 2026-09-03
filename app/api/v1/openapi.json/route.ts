import { API_VERSION, apiScopes } from "@/lib/api-v1";

export const dynamic = "force-dynamic";

/**
 * Documento OpenAPI da API pública.
 *
 * Descreve exclusivamente endpoints implementados: um contrato que promete algo
 * inexistente é pior do que a ausência de contrato.
 */
const document = {
  openapi: "3.1.0",
  info: {
    title: "Vinculato — API pública",
    version: API_VERSION,
    description: [
      "API do Vinculato para leitura da operação de Departamento Pessoal e envio de créditos e descontos de prestadores PJ.",
      "",
      "Autenticação: `Authorization: Bearer fdp_...`. Cada chave pertence a um workspace e carrega escopos próprios.",
      "Limite: por chave, por minuto; o excedente responde 429 com `Retry-After`.",
      "Idempotência: envie `Idempotency-Key` nas escritas. A mesma chave com o mesmo corpo devolve a resposta original;",
      "com corpo diferente responde 409.",
      "",
      "Somente os endpoints listados aqui existem. O documento acompanha a implementação.",
    ].join("\n"),
  },
  servers: [{ url: "/api/v1" }],
  components: {
    securitySchemes: {
      apiKey: { type: "http", scheme: "bearer", bearerFormat: "fdp_<prefixo>_<segredo>" },
    },
    parameters: {
      limit: { name: "limit", in: "query", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } },
      cursor: { name: "cursor", in: "query", schema: { type: "string" }, description: "Cursor devolvido em nextCursor." },
    },
    schemas: {
      Error: {
        type: "object",
        required: ["error", "code"],
        properties: { error: { type: "string" }, code: { type: "string" }, requestId: { type: "string" } },
      },
      Company: {
        type: "object",
        properties: {
          id: { type: "string" }, legalName: { type: "string" }, tradeName: { type: "string" },
          taxId: { type: "string" }, status: { type: "string" }, createdAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      Employee: {
        type: "object",
        description: "Colaborador já admitido. A admissão digital ocorre na Sólides; o CPF nunca é exposto.",
        properties: {
          id: { type: "string" }, companyId: { type: "string" }, registrationNumber: { type: "string" },
          fullName: { type: "string" }, socialName: { type: "string" }, cpfLast4: { type: "string" },
          admissionDate: { type: "string", format: "date", nullable: true },
          terminationDate: { type: "string", format: "date", nullable: true },
          employmentStatus: { type: "string", enum: ["active", "on_leave", "terminated"] },
          employmentType: { type: "string" },
          source: { type: "object", properties: { system: { type: "string" }, externalId: { type: "string" } } },
        },
      },
      Competence: {
        type: "object",
        properties: {
          id: { type: "string" }, companyId: { type: "string" }, competence: { type: "string", example: "2026-08" },
          status: { type: "string", enum: ["open", "pre_closing", "processing", "post_closing", "closed"] },
          paymentDate: { type: "string", format: "date", nullable: true },
          closedAt: { type: "string", format: "date-time", nullable: true },
        },
      },
      ContractorClosing: {
        type: "object",
        description: "Apuração PJ: líquido devido, nota esperada e complemento configurado.",
        properties: {
          id: { type: "string" }, companyId: { type: "string" },
          contractor: { type: "object", properties: { id: { type: "string" }, name: { type: "string" } } },
          competence: { type: "string" }, status: { type: "string" },
          amounts: {
            type: "object",
            properties: {
              base: { type: "number" }, credits: { type: "number" }, debits: { type: "number" },
              net: { type: "number", description: "base + créditos - descontos" },
              invoiceExpected: { type: "number", description: "mínimo(líquido, limite configurado)" },
              complement: { type: "number", description: "líquido - nota esperada" },
              complementOnBenefitCard: { type: "number" },
            },
          },
          invoiceLimit: {
            type: "object",
            properties: {
              amount: { type: "number", nullable: true },
              source: { type: "string", enum: ["none", "workspace", "company", "contract", "provider"] },
            },
          },
          invoice: { type: "object", properties: { number: { type: "string" }, receivedAmount: { type: "number" }, status: { type: "string" } } },
          complement: { type: "object", properties: { method: { type: "string" }, status: { type: "string" } } },
          reconciliation: { type: "object", properties: { status: { type: "string" }, difference: { type: "number" } } },
          calcVersion: { type: "string" },
        },
      },
      ContractorComponentInput: {
        type: "object",
        required: ["contractorId", "competence", "componentType", "amount"],
        properties: {
          contractorId: { type: "string" },
          competence: { type: "string", pattern: "^\\d{4}-(0[1-9]|1[0-2])$" },
          componentType: {
            type: "string",
            enum: [
              "base", "commission", "bonus", "award", "reimbursement", "additional", "positive_adjustment", "other_credit",
              "health_plan", "dental_plan", "benefit", "coparticipation", "equipment", "advance", "absence", "loan",
              "negative_adjustment", "other_debit",
            ],
          },
          amount: { type: "number", minimum: 0.01 },
          description: { type: "string", maxLength: 240 },
          settlementTarget: {
            type: "string",
            enum: ["auto", "invoice", "complement"],
            default: "auto",
            description: [
              "Onde o desconto é abatido quando o pagamento se divide entre nota fiscal e complemento:",
              "`auto` reduz o líquido e a nota acompanha o limite, `invoice` abate dentro da nota,",
              "`complement` abate do complemento. Ignorado em proventos.",
            ].join(" "),
          },
          quantity: { type: "number", minimum: 0 },
          documentReference: { type: "string", maxLength: 160 },
          externalId: { type: "string", maxLength: 160, description: "Identificador no sistema de origem; reenvio devolve o lançamento existente." },
        },
      },
    },
  },
  security: [{ apiKey: [] }],
  paths: {
    "/companies": {
      get: {
        summary: "Lista empresas do workspace",
        "x-required-scope": "companies.read",
        parameters: [{ $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/cursor" }],
        responses: {
          200: {
            description: "Página de empresas",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Company" } },
                    nextCursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
          401: { description: "Chave ausente, inválida, revogada ou expirada", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          403: { description: "Escopo insuficiente", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          429: { description: "Limite por minuto excedido", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
    "/employees": {
      get: {
        summary: "Lista colaboradores admitidos",
        "x-required-scope": "employees.read",
        parameters: [
          { name: "companyId", in: "query", schema: { type: "string" } },
          { name: "status", in: "query", schema: { type: "string", enum: ["active", "on_leave", "terminated"] } },
          { $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/cursor" },
        ],
        responses: {
          200: {
            description: "Página de colaboradores",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Employee" } },
                    nextCursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/competences": {
      get: {
        summary: "Lista competências e seu estado de fechamento",
        "x-required-scope": "competences.read",
        parameters: [
          { name: "companyId", in: "query", schema: { type: "string" } },
          { name: "competence", in: "query", schema: { type: "string", example: "2026-08" } },
          { $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/cursor" },
        ],
        responses: {
          200: {
            description: "Página de competências",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/Competence" } },
                    nextCursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/contractor-closings": {
      get: {
        summary: "Lista a apuração PJ da competência",
        "x-required-scope": "payments.read",
        parameters: [
          { name: "companyId", in: "query", schema: { type: "string" } },
          { name: "competence", in: "query", schema: { type: "string", example: "2026-08" } },
          { name: "status", in: "query", schema: { type: "string" } },
          { $ref: "#/components/parameters/limit" }, { $ref: "#/components/parameters/cursor" },
        ],
        responses: {
          200: {
            description: "Página de fechamentos PJ",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    data: { type: "array", items: { $ref: "#/components/schemas/ContractorClosing" } },
                    nextCursor: { type: "string", nullable: true },
                  },
                },
              },
            },
          },
        },
      },
    },
    "/contractor-components": {
      post: {
        summary: "Lança crédito ou desconto de um prestador PJ na competência",
        description: [
          "Aplica as mesmas regras da interface: competência fechada e fechamento concluído recusam o lançamento.",
          "Envie `Idempotency-Key` para poder repetir a chamada com segurança; `externalId` também impede duplicidade.",
        ].join(" "),
        "x-required-scope": "payments.write",
        parameters: [{ name: "Idempotency-Key", in: "header", schema: { type: "string", minLength: 8 } }],
        requestBody: {
          required: true,
          content: { "application/json": { schema: { $ref: "#/components/schemas/ContractorComponentInput" } } },
        },
        responses: {
          201: { description: "Componente criado" },
          200: { description: "Lançamento já existente para o externalId informado" },
          400: { description: "Competência inválida ou payload incorreto", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
          409: { description: "Idempotency-Key reutilizada com outro conteúdo", content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } },
        },
      },
    },
  },
  "x-scopes": apiScopes,
  "x-webhooks": {
    description: [
      "Eventos são entregues por POST com assinatura HMAC-SHA256 em `X-Fila-DP-Signature: t=<unix>,v1=<hex>`,",
      "calculada sobre `<timestamp>.<corpo>`. Rejeite entregas cuja diferença de tempo passe de 300 segundos e",
      "trate `X-Fila-DP-Event-Id` como chave de deduplicação. Falhas são reenviadas com backoff exponencial até a dead-letter.",
    ].join(" "),
  },
} as const;

export async function GET() {
  return Response.json(document, {
    headers: { "Cache-Control": "no-store", "Content-Type": "application/json; charset=utf-8" },
  });
}
