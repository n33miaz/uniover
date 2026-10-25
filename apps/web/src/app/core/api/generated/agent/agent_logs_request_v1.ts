/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: pede as últimas linhas do registro do próprio agente (arquivo fixo, nunca um caminho enviado pela API). O agente responde com agent.logs.v1 (que devolve o requestId) e, depois dele, com command.result.v1. Só agentes que anunciam a capacidade agent.logs.v1 recebem este pedido.
 */
export interface AgentLogsRequestV1Message {
  v: 1;
  id: string;
  type: 'agent.logs.request.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: AgentLogsRequestV1Body;
}
export interface AgentLogsRequestV1Body {
  requestId: string;
  lines: number;
}
