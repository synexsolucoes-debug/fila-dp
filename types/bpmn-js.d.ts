declare module "bpmn-js/lib/Modeler" {
  const Modeler: new (options: Record<string, unknown>) => unknown;
  export default Modeler;
}
declare module "bpmn-js/lib/NavigatedViewer" {
  const NavigatedViewer: new (options: Record<string, unknown>) => unknown;
  export default NavigatedViewer;
}
/**
 * O analisador que o bpmn-js usa por dentro. Ele entra aqui porque
 * `tests/process-templates.test.mts` valida as modelagens iniciais com o mesmo
 * analisador que o modelador usará — uma conferência textual provaria que a
 * string contém `<bpmn:startEvent`, não que o diagrama abre.
 *
 * A tipagem é deliberadamente mínima: `fromXML` devolve a árvore do moddle, que
 * não tem forma fixa, e o teste declara a forma que espera antes de ler.
 */
declare module "bpmn-moddle" {
  export class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    fromXML(xml: string, typeName?: string): Promise<{
      rootElement: unknown;
      elementsById: Record<string, unknown>;
      references: unknown[];
      warnings: unknown[];
    }>;
  }
}
