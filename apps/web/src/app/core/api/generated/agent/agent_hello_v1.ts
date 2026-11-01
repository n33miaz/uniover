/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type AgentHelloV1BodyCapabilitiesItem =
  | 'transport.keepalive.v1'
  | 'agent.logs.v1'
  | 'agent.maintenance.v1'
  | 'agent.diagnostics.v1'
  | 'tv.cleanup.automatic.v1'
  | 'tv.light-settings.v1'
  | 'tv.focus-closes-background.v1'
  | 'tv.remote'
  | 'tv.adb'
  | 'tv.kind.android'
  | 'tv.kind.samsung'
  | 'tv.key.v3'
  | 'tv.power.off.v1'
  | 'tv.permission.v1'
  | 'tv.discovery.v1'
  | 'tv.key.INPUT'
  | 'tv.key.INFO'
  | 'tv.key.GUIDE'
  | 'tv.key.TOOLS'
  | 'tv.key.CHANNEL_LIST'
  | 'tv.key.PREVIOUS_CHANNEL'
  | 'tv.key.EXIT'
  | 'tv.key.PLAY'
  | 'tv.key.PAUSE'
  | 'tv.key.STOP'
  | 'tv.key.REWIND'
  | 'tv.key.FAST_FORWARD'
  | 'tv.key.RED'
  | 'tv.key.GREEN'
  | 'tv.key.YELLOW'
  | 'tv.key.BLUE'
  | 'tv.key.SUBTITLE'
  | 'tv.key.ASPECT'
  | 'tv.key.SLEEP'
  | 'tv.key.E_MANUAL'
  | 'pc.control.v1';
export type AgentHelloV1BodyTvKind = 'android' | 'samsung';
export type AgentHelloV1BodyUpdateOutcome =
  'not_checked' | 'updating' | 'updated' | 'up_to_date' | 'failed' | 'blocked' | 'rolled_back';

/**
 * Agente para API ao conectar: versão do agente, capacidades e, opcionalmente, o que a manutenção remota mostra (sistema do PC, a TV que ele controla e o estado da auto-atualização).
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
  os?: string;
  tv?: AgentHelloV1BodyTv;
  update?: AgentHelloV1BodyUpdate;
}
export interface AgentHelloV1BodyTv {
  kind: AgentHelloV1BodyTvKind;
  host: string;
}
export interface AgentHelloV1BodyUpdate {
  outcome: AgentHelloV1BodyUpdateOutcome;
  installedSha?: string;
  installedAt?: string;
  latestSha?: string;
  checkedAt?: string;
  nextCheckAt?: string;
  reason?: string;
  blockedSha?: string;
  previousSha?: string;
  rolledBack?: boolean;
}
