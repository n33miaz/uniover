import { DOCUMENT } from '@angular/common';
import { InjectionToken, inject } from '@angular/core';

/**
 * Redução da foto de fundo no navegador, antes de enviar. O launcher mostra a foto numa TV de 1920x1080 e a API recusa
 * mais de 400 KiB: então a foto cabe DENTRO de 1920x1080 (não só o maior lado: uma foto de pé de 3000x4000 vira 810x1080)
 * e a qualidade do JPEG desce até o arquivo caber. Se nem na menor qualidade couber, a imagem encolhe mais e tenta de novo.
 *
 * A parte que decide (tamanho e qualidade) é pura e recebe o codificador de fora, para ser testada sem tela de desenho; a
 * parte do navegador (`createImageBitmap` e `canvas`) é uma porta fina logo abaixo.
 */

export const PHOTO_MAX_WIDTH = 1920;
export const PHOTO_MAX_HEIGHT = 1080;
/** 400 000 bytes: cabe tanto na leitura de "400 KB" quanto na de "400 KiB" (409 600). */
export const PHOTO_MAX_BYTES = 400_000;
/** Qualidades tentadas, da melhor para a pior; a primeira que cabe vence. */
export const PHOTO_QUALITIES: readonly number[] = [0.85, 0.78, 0.7, 0.62, 0.54, 0.46, 0.38, 0.3];
/** Quanto a imagem encolhe a cada volta, quando nenhuma qualidade coube. */
export const PHOTO_SHRINK_STEPS: readonly number[] = [1, 0.8, 0.64, 0.5];

export interface PhotoSize {
  readonly width: number;
  readonly height: number;
}

/** O maior tamanho de mesma proporção que cabe em `maxWidth` por `maxHeight`; nunca amplia. */
export function fitWithin(
  width: number,
  height: number,
  maxWidth = PHOTO_MAX_WIDTH,
  maxHeight = PHOTO_MAX_HEIGHT,
): PhotoSize {
  const factor = Math.min(1, maxWidth / width, maxHeight / height);
  if (!(factor < 1)) return { width, height };
  return {
    width: Math.max(1, Math.round(width * factor)),
    height: Math.max(1, Math.round(height * factor)),
  };
}

/** O resultado de reduzir: a foto pronta, ou o motivo de não ter dado. */
export type PhotoFit<T> =
  | { readonly status: 'ok'; readonly blob: T; readonly size: PhotoSize; readonly quality: number }
  | { readonly status: 'invalid' }
  | { readonly status: 'too-big' };

/**
 * Procura o maior tamanho e a melhor qualidade que cabem no limite. `encode` desenha a foto no tamanho dado e devolve o
 * JPEG, ou `null` se o navegador não conseguiu (então a foto é inválida: não adianta tentar outra qualidade).
 */
export async function fitPhoto<T extends { readonly size: number }>(
  source: PhotoSize,
  encode: (size: PhotoSize, quality: number) => Promise<T | null>,
  maxBytes = PHOTO_MAX_BYTES,
): Promise<PhotoFit<T>> {
  if (!(source.width > 0) || !(source.height > 0)) return { status: 'invalid' };
  const base = fitWithin(source.width, source.height);
  for (const step of PHOTO_SHRINK_STEPS) {
    const size = {
      width: Math.max(1, Math.round(base.width * step)),
      height: Math.max(1, Math.round(base.height * step)),
    };
    for (const quality of PHOTO_QUALITIES) {
      const blob = await encode(size, quality);
      if (blob === null) return { status: 'invalid' };
      if (blob.size <= maxBytes) return { status: 'ok', blob, size, quality };
    }
  }
  return { status: 'too-big' };
}

/** Uma imagem já lida pelo navegador: o tamanho original, o desenho em JPEG num tamanho e qualidade, e a liberação da memória. */
export interface DecodedPhoto extends PhotoSize {
  draw(size: PhotoSize, quality: number): Promise<Blob | null>;
  release(): void;
}

/** O que o navegador dá para ler e desenhar uma imagem (os testes trocam por um falso: o jsdom não tem tela de desenho). */
export interface PhotoCanvasEnv {
  decode(file: Blob): Promise<DecodedPhoto | null>;
}

/** Leitor da foto escolhida: devolve o JPEG que cabe no limite. É uma porta para o teste da tela trocar por um falso. */
export type LivrePhotoReducer = (file: Blob) => Promise<PhotoFit<Blob>>;

/** Reduz a foto com o ambiente dado: lê, procura o tamanho e a qualidade que cabem e solta a memória. */
export function createPhotoReducer(env: PhotoCanvasEnv): LivrePhotoReducer {
  return async (file) => {
    const image = await env.decode(file);
    if (image === null) return { status: 'invalid' };
    try {
      return await fitPhoto(image, (size, quality) => image.draw(size, quality));
    } finally {
      image.release();
    }
  };
}

/**
 * O ambiente do navegador: `createImageBitmap` (com a orientação da foto respeitada, para a foto de pé não sair deitada) e uma
 * tela de desenho para reduzir e recodificar em JPEG. Recodificar também descarta os metadados da foto (EXIF, com o local).
 */
export function browserPhotoEnv(doc: Document, win: Window): PhotoCanvasEnv {
  return {
    async decode(file) {
      let bitmap: ImageBitmap;
      try {
        bitmap = await win.createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch {
        // Navegador que não conhece a opção de orientação (ou a recusa): tenta sem ela, e a foto vale como está. Se também
        // falhar, o arquivo não é uma imagem que este navegador leia.
        try {
          bitmap = await win.createImageBitmap(file);
        } catch {
          return null;
        }
      }
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw: (size, quality) => {
          const canvas = doc.createElement('canvas');
          canvas.width = size.width;
          canvas.height = size.height;
          const context = canvas.getContext('2d');
          if (context === null) return Promise.resolve(null);
          // JPEG não tem transparência: sem um fundo, o que é transparente sairia preto.
          context.fillStyle = '#000000';
          context.fillRect(0, 0, size.width, size.height);
          context.drawImage(bitmap, 0, 0, size.width, size.height);
          return new Promise<Blob | null>((resolve) =>
            canvas.toBlob(
              (blob) => {
                // Libera o buffer da tela de desenho (o Safari o segura até a tela sair de cena).
                canvas.width = 0;
                canvas.height = 0;
                // Um navegador sem codificador de JPEG devolve outro formato: a API o recusaria, então vale "não deu".
                resolve(blob?.type === 'image/jpeg' ? blob : null);
              },
              'image/jpeg',
              quality,
            ),
          );
        },
        release: () => bitmap.close(),
      };
    },
  };
}

export const LIVRE_PHOTO_REDUCER = new InjectionToken<LivrePhotoReducer>('LIVRE_PHOTO_REDUCER', {
  providedIn: 'root',
  factory: () => {
    const doc = inject(DOCUMENT);
    const win = doc.defaultView;
    // Sem janela (renderização fora do navegador) nenhuma foto é lida: o resultado é "inválida", nunca uma exceção.
    return win
      ? createPhotoReducer(browserPhotoEnv(doc, win))
      : async () => ({ status: 'invalid' });
  },
});
