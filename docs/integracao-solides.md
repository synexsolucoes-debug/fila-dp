# Integração Sólides — conector de admissões concluídas

Este documento descreve o conector oficial da Sólides no Vinculato: o que ele faz, o que a API
oficial permite, o que ela não permite e como ativar em um cliente.

## 1. O que o conector faz

Quando alguém é admitido na Sólides, o Vinculato abre uma **tarefa de conciliação cadastral** com a
ficha recebida, a lotação, os dados contratuais e o checklist dos documentos que faltam.

A fronteira de produto continua valendo: **a admissão digital é executada integralmente na Sólides**.
O Vinculato recebe quem já foi admitido e concilia com o ERP. Nenhum fluxo concorrente de admissão é
criado — `assertNoAdmissionWorkflow` segue bloqueando processos, templates e SLAs de admissão.

## 2. Recurso oficial consumido

Documentação: <https://gestaoapidocs.solides.com.br/>

| Item | Valor |
| --- | --- |
| Base | `https://app.solides.com/{locale}/api/v1/` (`locale`: `pt-BR`, `es` ou `en`) |
| Recurso | `GET /colaboradores` |
| Autenticação | `Authorization: Token token=<token>` — **não** é `Bearer` |
| Filtro de admissão | `data_admissao` no formato `DD/MM/AAAA` |
| Paginação | `page` e `page_size` (máximo de 150) |
| Escopo | `status=todos` inclui inativos; por padrão o conector não envia o parâmetro |

O token é gerado pelo próprio cliente em <https://app.solides.com>, na seção **Ativar API de
Integração**. Ele é guardado no cofre AES-256-GCM por workspace, como qualquer outra credencial.

`validateSolidesEndpoint` (`lib/solides.ts`) aceita **somente** host oficial, HTTPS e o caminho
`/{locale}/api/v1/colaboradores`. Host de terceiro, caminho inventado, HTTP puro ou credencial na URL
continuam sendo recusados com `SOLIDES_OFFICIAL_RESOURCE_REQUIRED`.

## 3. Limite conhecido: arquivos de documento

A API de Gestão devolve os **dados documentais** do colaborador no bloco `documents` (CPF, RG, órgão
emissor, CTPS, PIS, título de eleitor, reservista, dados bancários). Ela **não expõe endpoint de
download dos arquivos**.

Consequência prática, declarada na tarefa e na tela em vez de disfarçada:

- o conector concilia a ficha e registra quais campos documentais vieram e quais faltam;
- os arquivos (PDF, imagem) continuam sendo obtidos na Sólides, e o checklist da tarefa inclui o
  passo de baixá-los e anexar;
- nenhum valor de documento entra na descrição da tarefa, nos metadados do item de sincronização ou
  na auditoria — apenas os nomes dos campos, mesma regra já aplicada ao CPF por `protectCpf`.

## 4. Configuração no painel

Em **Integrações → Sólides → Configurar**:

| Campo | Efeito |
| --- | --- |
| Recurso oficial da Sólides | Endpoint validado contra a lista oficial |
| Referência da conta | Identificação administrativa, sem efeito na requisição |
| Admitidos a partir de | Vira `data_admissao`; define o corte histórico da carga |
| Colaboradores por página | `page_size`, limitado a 150 |
| Quadro de destino | Onde as tarefas nascem; vazio usa o primeiro quadro com coluna de entrada |
| Empresa | Empresa do cartão; vazio usa a unidade informada pela Sólides |

Depois é preciso guardar a credencial (`token`), publicar um mapeamento com recurso
**Admissões concluídas** (`admissions`, direção de entrada) e executar **Verificar**. Salvar
configuração nunca conecta o conector: só a verificação com autenticação real muda o estado para
`connected`.

## 5. Execução e idempotência

O executor autenticado (`lib/integration-engine.ts`) faz o I/O fora da requisição do navegador,
limitando resposta, redirecionamento e tempo. Por colaborador recebido:

1. o identificador externo sai do campo `id` da Sólides;
2. o hash do item usa o **registro original**, e não apenas os campos mapeados, para que mudanças na
   ficha sejam percebidas mesmo com mapeamento enxuto;
3. um registro sem `id`, nome ou data de admissão vira conciliação pendente em vez de tarefa;
4. se já existe tarefa para aquele identificador externo, a execução marca o item como `skipped` e
   reaproveita o cartão — reprocessar a mesma carga não duplica trabalho.

O prazo do cartão usa a política de SLA de `CONCILIAÇÃO CADASTRAL` (2 dias úteis por padrão) com o
calendário e os feriados do workspace, resolvidos uma vez por execução.

## 6. Gate operacional antes de liberar para o cliente

1. Aplicar a migration `0026_solides_admission_connector` em PostgreSQL de homologação.
2. Confirmar que o workspace tem quadro com coluna de entrada e a política de SLA de
   `CONCILIAÇÃO CADASTRAL` ativa.
3. Guardar o token do cliente e executar **Verificar** contra a conta real — sem isso o conector
   permanece em `needs_credentials`.
4. Rodar uma sincronização com corte curto (poucos dias) e conferir tarefa, checklist e ausência de
   valor de documento na auditoria.
5. Só então ampliar o corte histórico em **Admitidos a partir de**.

## 7. Fora de escopo nesta entrega

- **Sólides DP / Tangerino** (`https://employer.tangerino.com.br`, autenticação `Basic`): é outra API,
  com endpoints próprios de ponto e espelho. O módulo de tempo do Vinculato não consome essa API.
- **Webhooks da Sólides** (`novo_colaborador`, `edicao_colaborador`, `demissao_colaborador`): a
  documentação pública lista os nomes dos eventos, mas não o payload nem o registro do endpoint.
  Enquanto isso não estiver documentado, a carga é por consulta agendada, não por evento.
- **Escrita de volta na Sólides**: o executor processa apenas mapeamentos de entrada ou bidirecionais.
