/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type AgentHelloV1BodyCapabilitiesItem =
  'tv.remote' | 'tv.adb' | 'tv.kind.android' | 'tv.kind.samsung';

/**
 * Agente para API ao conectar: versão do agente e capacidades.
 */
export interface AgentHelloV1Message {
  v: 1;
  id: string;
  type: 'agent.hello.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: AgentHelloV1Body;
}
export interface AgentHelloV1Body {
  agentVersion: string;
  capabilities: AgentHelloV1BodyCapabilitiesItem[];
}
