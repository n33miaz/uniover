/* eslint-disable */
/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Envelope único das mensagens entre API e agente; igual em qualquer transporte.
 */
export interface Envelope {
  v: 1;
  id: string;
  type: string;
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: {
    [k: string]: unknown | undefined;
  };
}
