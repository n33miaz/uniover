/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * API para agente: pedido de quadro da tela do PC no canal de dados WebRTC ('screen'). Manda um pedido por vez ('s.get'); o próximo só sai depois que o anterior foi respondido. 'monitor' é o id anunciado em 's.mon' (0 a 2147483647; omitido é o monitor principal). 'width' é a largura desejada do recorte em pixels físicos (128 a 1920, padrão 1280). 'fps' é o limite de quadros por segundo (1 a 10, padrão 5). 'marker' é a marca de medição embutida nos pixels (16 bits, 0 a 65535, padrão 0). 'reset' (padrão false) força envio do quadro sem comparar CRC e zera contadores.
 */
export interface PcScreenGetV1Message {
  v: 1;
  id: string;
  type: 'pc.screen.get.v1';
  source: string;
  target: string;
  ts: string;
  correlationId: string | null;
  body: PcScreenGetV1Body;
}
export interface PcScreenGetV1Body {
  k: 's.get';
  monitor?: number;
  width?: number;
  fps?: number;
  marker?: number;
  reset?: boolean;
}
