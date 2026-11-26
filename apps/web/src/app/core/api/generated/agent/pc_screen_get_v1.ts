/* GERADO por `npm --prefix contracts run generate` — não editar. */

/**
 * App para PC: pedido de quadro ('s.get') no canal de dados WebRTC 'screen'. O objeto vai nu, sem envelope. Um pedido por vez: o próximo só sai depois que o anterior foi respondido. 'monitor' é o id anunciado em 's.mon' (0 a 2147483647; omitido é o monitor principal). 'width' é a largura máxima da imagem em pixels físicos (128 a 1920, padrão 1280). 'fps' é o limite de quadros por segundo (1 a 10, padrão 5). 'marker' é a marca de medição embutida nos pixels (0 a 65535, padrão 0). 'reset' (padrão false) força o envio do quadro sem comparar o CRC e zera as medições.
 */
export interface PcScreenGetV1Message {
  k: 's.get';
  monitor?: number;
  width?: number;
  fps?: number;
  marker?: number;
  reset?: boolean;
}
