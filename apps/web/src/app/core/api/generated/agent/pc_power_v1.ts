/* GERADO por `npm --prefix contracts run generate` — não editar. */

export type PcPowerV1BodyAction = 'LOCK' | 'SLEEP' | 'SHUTDOWN' | 'CANCEL_SHUTDOWN';

/**
 * API para agente: energia do PC. `LOCK` bloqueia a sessão; `SLEEP` suspende; `SHUTDOWN` agenda o desligamento com a contagem do Windows (aviso na tela do PC) e `CANCEL_SHUTDOWN` cancela essa contagem. Quem confirma com a pessoa é o app e a API; o agente não repete nem adia nada.
 */
export interface PcPowerV1Message {
  v: 1;
  id: string;
  type: 'pc.power.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcPowerV1Body;
}
export interface PcPowerV1Body {
  action: PcPowerV1BodyAction;
}
