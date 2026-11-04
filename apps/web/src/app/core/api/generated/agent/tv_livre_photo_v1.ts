/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: um pedaço da foto do fundo (JPEG já reduzido, até 400 KB). O transporte recusa mensagens acima de 64 KB, então a foto vai em até 16 pedaços; o agente junta, confere o sha256 e guarda até o `apply` que cita o `photoId`.
 */
export interface TvLivrePhotoV1Message {
  v: 1;
  id: string;
  type: 'tv.livre.photo.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: TvLivrePhotoV1Body;
}
export interface TvLivrePhotoV1Body {
  photoId: string;
  index: number;
  total: number;
  /**
   * sha256 da foto inteira (o mesmo em todos os pedaços).
   */
  sha256: string;
  /**
   * base64 do pedaço (até 30 KB de bytes).
   */
  data: string;
}
