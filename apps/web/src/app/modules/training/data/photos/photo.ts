/**
 * Foto de progresso. Fica **só neste aparelho**: nunca entra na fila de escrita, nunca é puxada do servidor e nunca vai no
 * JSON da exportação (tamanho). Se o navegador apagar os dados do site, elas somem: a proteção é compartilhar foto a foto.
 */

/**
 * Linha do banco local. `data` é o JPEG já reduzido, guardado como bytes (`ArrayBuffer`) e não como `Blob` DE PROPÓSITO: no
 * WebKit (Safari e o motor do iPhone) o IndexedDB recusa `Blob` em sessão efêmera (`UnknownError: Error preparing Blob/File
 * data to be stored in object store`, medido no WebKit 27.2 do Playwright) e aceita `ArrayBuffer`; `bytes` é o tamanho dos
 * bytes (não se lê a foto para somar).
 */
export interface LocalPhoto {
  readonly id: string;
  /** Dia local `AAAA-MM-DD` em que a foto foi tirada. */
  readonly takenOn: string;
  readonly data: ArrayBuffer;
  /** Tipo do arquivo guardado (`image/jpeg`). */
  readonly type: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  /** Instante (ms) em que entrou neste aparelho; desempata fotos do mesmo dia. */
  readonly addedAt: number;
}

/** A foto sem os bytes: é o que a tela recebe na lista (os bytes só saem pelo `dataUrl` e pelo `shareFile`). */
export type PhotoInfo = Omit<LocalPhoto, 'data'>;

/** Quanto as fotos ocupam e quanto o navegador diz que ainda cabe. Os campos da cota vêm `null` quando o navegador não sabe. */
export interface PhotoUsage {
  readonly photoCount: number;
  /** Soma dos tamanhos das fotos guardadas. */
  readonly photoBytes: number;
  /** O que o site inteiro usa neste aparelho (`navigator.storage.estimate().usage`). */
  readonly usageBytes: number | null;
  /** A cota do site neste aparelho (`navigator.storage.estimate().quota`). */
  readonly quotaBytes: number | null;
  /** Percentual da cota que o site inteiro já usa. */
  readonly usedPercent: number | null;
  /** Percentual da cota que só as fotos ocupam. */
  readonly photosPercent: number | null;
}
