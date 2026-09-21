# A primeira admissão pelo fluxo atualizado

Caminho completo, do zero até o cadastro confirmado no Sankhya. Quem segue isto
é o analista de DP; os passos 1 e 2 acontecem uma vez só, por computador.

## 1. Preparar o computador do DP (uma vez)

```powershell
copy .env.tangerino-worker.example .env.tangerino-worker.local
notepad .env.tangerino-worker.local
powershell -ExecutionPolicy Bypass -File scripts\windows\install-tangerino-worker.ps1
```

O script confere requisitos, ambiente, permissões do perfil, dependências,
Chromium e **a conexão com o banco** antes de registrar a tarefa de logon. Ele
para no primeiro problema: se terminar, está pronto.

Depois disso o worker sobe sozinho a cada logon. Para subir agora sem reiniciar:

```powershell
Start-ScheduledTask -TaskName "Vinculato - Agente Tangerino"
```

**Deixe a janela aberta.** Quando a Sólides pedir CAPTCHA ou verificação em duas
etapas, é nela que você conclui o acesso.

## 2. Conferir no painel (uma vez, e sempre que algo parecer parado)

Em **Agentes**, o cartão *Worker no computador do DP* mostra disponibilidade,
última comunicação, última consulta concluída e fila pendente. Ele distingue
quatro situações que pedem ações diferentes:

| O que você lê | O que fazer |
| --- | --- |
| Ativo, sem tarefas | Nada. Está funcionando. |
| Ativo, N tarefas na fila | Nada. O worker vai consumi-las. |
| Aguardando autenticação | Abrir a janela do navegador no computador e concluir o acesso. |
| Sem comunicação / Nunca se comunicou | O computador está desligado, suspenso ou sem rede. |

Logo abaixo, a linha **Agendamento do servidor** responde outra pergunta: se a
varredura do backend está enfileirando. Worker perfeito com agendamento parado
não recebe tarefa — e são pessoas diferentes que resolvem cada caso.

## 3. A admissão chega

Quando alguém é admitido na Sólides, a varredura abre a demanda
**Admissão ERP — Nome do colaborador** no quadro. Você não precisa fazer nada
para isso acontecer.

Para antecipar a varredura: **Agentes → Agente Tangerino → Executar agora**. A
resposta diz o que aconteceu de verdade — quantas admissões entraram na fila,
quantas já estavam lá, ou que não há nenhuma pendente.

## 4. Autorizar os documentos

Abra a demanda → aba **Anexos** → **Autorizar anexos da Sólides**.

A autorização vale para aquela demanda e aquela pessoa. O worker entra na
Sólides, baixa os documentos e anexa. Isso pode levar alguns minutos.

## 5. A ficha se prepara sozinha

Assim que o PDF chega, o Vinculato o lê e monta a ficha. **Não é preciso clicar
em nada.** A aba **Ficha** mostra em que pé está:

*Aguardando documentos* → *Preparando ficha* → *Aguardando conferência* →
*Pronta para cadastro* → *Cadastro confirmado*

Se a leitura falhar, a aba diz o motivo e o documento continua anexado para
conferência manual. **Reler a ficha** reprocessa o arquivo já guardado — não
baixa nada de novo e não precisa do navegador.

## 6. Conferir e completar

Cada campo mostra **de onde veio**: do documento, do cadastro do Vinculato ou
preenchido à mão. Campo que não passou na conferência de dígito verificador
aparece como *não foi possível ler*, nunca com um valor errado.

Os documentos da pessoa ficam na própria aba, para abrir ao lado.

- **Copiar** — leva o valor para a área de transferência.
- **Conferir** — sua marca pessoal de que comparou com o documento.
- **Corrigir / Preencher** — para o que estiver errado ou faltando.

Os **dados bancários vêm vazios** no Registro de Empregado. Use *Preencher*.

Pelo teclado, com o foco em um campo: **C** copia, **V** marca conferido.

### Se aparecer aviso de identidade

Um bloco vermelho no topo significa que o documento pode não ser desta pessoa —
CPF com final diferente do cadastro, ou nome sem nenhum sobrenome em comum. O
preenchimento pelo cadastro é suspenso. **Confira o arquivo antes de usar
qualquer campo.**

## 7. Cadastrar no Sankhya e confirmar

Copie campo a campo (ou bloco a bloco) para o Sankhya. Terminado, volte e clique
em **Já cadastrei no Sankhya**, informando a matrícula que o ERP gerou.

É essa confirmação que conclui a demanda. Copiar não conclui: a área de
transferência não sabe se o ERP salvou.

A ficha fica disponível por 30 dias para conferência e depois é apagada. O
documento anexado segue a retenção de anexos da demanda.

## Quando algo falha

| Sintoma | Causa provável |
| --- | --- |
| "Executar agora" diz que não há admissão pendente | Não há: só entram colaboradores com vínculo na Sólides cuja última leitura não terminou em desfecho |
| A demanda não aparece | Worker parado, ou agendamento do servidor atrasado — o cartão em Agentes diz qual |
| Anexos não chegam | Worker aguardando autenticação, ou a autorização não foi dada |
| Ficha em *Preparando* há muito tempo | A varredura do servidor tenta de novo; após 3 tentativas vira falha com motivo |
| Ficha em *Não foi possível ler* | O arquivo não é um PDF com texto, ou segue outro modelo. Confira à mão |
| Campo como *não foi possível ler* | O dígito verificador não fechou. Confira no documento e use *Corrigir* |
