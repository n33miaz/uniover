/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * Agente para API: o texto da área de transferência do PC (`text`, vazio quando não há texto) e quando foi lido (`at`). Responde a `pc.clipboard.query.v1`: `correlationId` é o do pedido. Pode ser uma senha: a API o repassa uma vez a quem pediu e o descarta, sem registrar, auditar nem guardar. O agente só o manda a uma API que listou `pc.clipboard.v1` em `features`.
 */
export interface PcClipboardV1Message {
  v: 1;
  id: string;
  type: 'pc.clipboard.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcClipboardV1Body;
}
export interface PcClipboardV1Body {
  text: string;
  at: string;
}
