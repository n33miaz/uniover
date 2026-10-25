/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: o fim do registro do agente, já sem segredos (tokens, Authorization, códigos de pareamento, senhas). Sai antes do command.result.v1 do mesmo comando (correlationId = id do comando) e repete o requestId de agent.logs.request.v1. O texto cabe no limite de 64 KB do transporte: o agente tira as linhas mais antigas até caber e marca truncated.
 */
export interface AgentLogsV1Message {
  v: 1;
  id: string;
  type: 'agent.logs.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string;
  body: AgentLogsV1Body;
}
export interface AgentLogsV1Body {
  requestId: string;
  text: string;
  lines: number;
  truncated: boolean;
  at: string;
}
