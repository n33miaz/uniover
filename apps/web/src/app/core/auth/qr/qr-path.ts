import { encode } from 'uqr';

/** Um QR pronto para desenhar: o lado em módulos e UM caminho SVG com todos os módulos escuros. */
export interface QrDrawing {
  readonly size: number;
  readonly path: string;
}

/**
 * Codifica o texto e devolve o desenho como um único caminho (um retângulo por sequência de módulos escuros na mesma
 * linha). Um `<path>` só, sem estilo embutido nem imagem, serve à política de segurança do site (que não aceita script nem
 * estilo em linha) e fica nítido em qualquer tamanho. A margem branca (zona de silêncio) é do componente, não daqui.
 *
 * Correção de erros média (M): o QR de entrada leva um link curto, então sobra espaço e o leitor tolera um reflexo ou
 * um pixel de tela sujo.
 */
export function qrDrawing(text: string): QrDrawing {
  const { size, data } = encode(text, { ecc: 'M', border: 0 });
  const runs: string[] = [];
  for (let y = 0; y < size; y++) {
    const row = data[y];
    let x = 0;
    while (x < size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < size && row[x]) x++;
      runs.push(`M${start} ${y}h${x - start}v1h-${x - start}z`);
    }
  }
  return { size, path: runs.join('') };
}
