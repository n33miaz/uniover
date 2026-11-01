/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type AgentDiagnosticsV1BodyEventsItemSeverity = 'info' | 'warn' | 'error';

/**
 * Agente para API: erros e ocorrências do próprio agente (queda, tarefa de fundo que falhou, reparo, atualização recusada), para o administrador ver em Sistema. Sem dados pessoais: o agente já tira caminhos, endereços, nomes e segredos do texto antes de enviar. Em lote, na ordem em que aconteceram; ocorrência repetida vem uma vez só, com `count`.
 */
export interface AgentDiagnosticsV1Message {
  v: 1;
  id: string;
  type: 'agent.diagnostics.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: null;
  body: AgentDiagnosticsV1Body;
}
export interface AgentDiagnosticsV1Body {
  /**
   * @minItems 1
   * @maxItems 20
   */
  events:
    | [AgentDiagnosticsV1BodyEventsItem]
    | [AgentDiagnosticsV1BodyEventsItem, AgentDiagnosticsV1BodyEventsItem]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ]
    | [
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
        AgentDiagnosticsV1BodyEventsItem,
      ];
}
export interface AgentDiagnosticsV1BodyEventsItem {
  id: string;
  at: string;
  kind: string;
  severity: AgentDiagnosticsV1BodyEventsItemSeverity;
  component?: string;
  detail: string;
  count?: number;
}
