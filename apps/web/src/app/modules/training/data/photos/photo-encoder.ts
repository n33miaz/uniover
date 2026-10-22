/**
 * Reduz e recodifica a foto antes de guardar: maior lado 1280 px, JPEG com qualidade 0,8. **Valores nossos** (um celular de
 * hoje entrega fotos de 3 a 8 MB; guardá-las inteiras esgotaria a cota do site em poucas dezenas). Quanto cada foto pesa de
 * verdade e quanto cabe no iPhone ainda precisam ser MEDIDOS no aparelho (`navigator.storage.estimate()`).
 *
 * Este arquivo não importa nada do Angular: roda em qualquer navegador e pode ser empacotado sozinho para medir. Recodificar
 * pela tela de desenho também descarta os metadados da foto (EXIF, inclusive a localização).
 */

/** Maior lado da foto guardada, em pixels. */
export const PHOTO_MAX_SIDE = 1280;

/** Qualidade do JPEG guardado. */
export const PHOTO_JPEG_QUALITY = 0.8;

export interface EncodeOptions {
  readonly maxSide: number;
  readonly quality: number;
}

export interface EncodedPhoto {
  readonly blob: Blob;
  readonly width: number;
  readonly height: number;
}

/**
 * Reduz, recodifica e devolve o JPEG; `null` quando o arquivo não é uma imagem que o navegador decodifica. É uma porta: os
 * testes trocam por uma falsa (o jsdom não tem tela de desenho).
 */
export interface PhotoEncoder {
  encode(file: Blob, options: EncodeOptions): Promise<EncodedPhoto | null>;
}

/** O tamanho depois de reduzir: o maior lado vira `maxSide`, a proporção fica, e nunca se amplia. */
export function scaledSize(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (!(longest > maxSide)) return { width, height };
  const factor = maxSide / longest;
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** O que o codificador do navegador precisa do ambiente (trocável no teste). */
export interface BrowserImageEnv {
  createImageBitmap(file: Blob, options?: ImageBitmapOptions): Promise<ImageBitmap>;
  createCanvas(): HTMLCanvasElement;
}

/** O ambiente do navegador de verdade. */
export function realBrowserEnv(doc: Document, win: Window): BrowserImageEnv {
  return {
    createImageBitmap: (file, options) => win.createImageBitmap(file, options),
    createCanvas: () => doc.createElement('canvas'),
  };
}

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

/**
 * O codificador do navegador: `createImageBitmap` (com a orientação da foto respeitada, para a foto de pé não sair deitada),
 * desenho reduzido numa tela e `toBlob` em JPEG. Imagem que não decodifica devolve `null`.
 */
export function createBrowserPhotoEncoder(env: BrowserImageEnv): PhotoEncoder {
  return {
    async encode(file, options) {
      let bitmap: ImageBitmap;
      try {
        bitmap = await env.createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (error) {
        if (error instanceof TypeError) {
          // Navegador que não conhece a opção de orientação: tenta sem ela (o resultado vale como está).
          try {
            bitmap = await env.createImageBitmap(file);
          } catch {
            return null;
          }
        } else {
          return null;
        }
      }

      const canvas = env.createCanvas();
      try {
        const size = scaledSize(bitmap.width, bitmap.height, options.maxSide);
        canvas.width = size.width;
        canvas.height = size.height;
        const context = canvas.getContext('2d');
        if (context === null) return null;
        // JPEG não tem transparência: sem fundo, o que é transparente sairia preto.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, size.width, size.height);
        context.drawImage(bitmap, 0, 0, size.width, size.height);
        const blob = await toBlob(canvas, options.quality);
        return blob === null ? null : { blob, width: size.width, height: size.height };
      } finally {
        bitmap.close();
        // Libera a memória da tela de desenho (o Safari segura o buffer até a tela sair de cena).
        canvas.width = 0;
        canvas.height = 0;
      }
    },
  };
}
