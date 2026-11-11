/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: a API promoveu esta conexão (a candidata da passagem de uma versão para outra) a dona do canal do agente e vai fechar a anterior. Só vai a quem pediu a passagem no hello (handover true e instanceId); o agente só deixa de ser candidato depois dela, e enquanto não a recebe toda reconexão sua se apresenta de novo como candidata.
 */
export interface AgentHandoverAcceptedV1Message {
  v: 1;
  id: string;
  type: 'agent.handover.accepted.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string;
  body: AgentHandoverAcceptedV1Body;
}
export interface AgentHandoverAcceptedV1Body {
  instanceId: string;
}
