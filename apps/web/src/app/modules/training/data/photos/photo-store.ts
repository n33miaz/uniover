import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, inject, signal } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { uuidV7 } from '../../../../core/offline-queue/uuid-v7';
import { dateKey, deviceTimeZone } from '../../domain/progress/calendar';
import { ExportDelivery } from '../export/export-delivery';
import { TRAINING_DB } from '../training-db';
import type { LocalPhoto, PhotoInfo, PhotoUsage } from './photo';
import {
  PHOTO_JPEG_QUALITY,
  PHOTO_MAX_SIDE,
  type PhotoEncoder,
  createBrowserPhotoEncoder,
  realBrowserEnv,
} from './photo-encoder';

/** O codificador da foto. O padrão usa a tela de desenho do navegador; os testes trocam por um falso. */
export const PHOTO_ENCODER = new InjectionToken<PhotoEncoder>('PHOTO_ENCODER', {
  providedIn: 'root',
  factory: () => {
    const doc = inject(DOCUMENT);
    const win = doc.defaultView;
    if (win === null) throw new Error('Sem janela: a foto não pode ser codificada.');
    return createBrowserPhotoEncoder(realBrowserEnv(doc, win));
  },
});

/**
 * Resultado de guardar uma foto. `invalid-image`: o arquivo não é uma imagem que o navegador decodifica. `storage-full`:
 * o aparelho não tem espaço ("não coube no aparelho"), e nada ficou gravado.
 */
export type PhotoAddResult =
  | { readonly status: 'saved'; readonly photo: PhotoInfo }
  | { readonly status: 'invalid-image' }
  | { readonly status: 'storage-full' };

/**
 * O que aconteceu ao compartilhar a foto. `shared`: a folha de compartilhar do sistema recebeu o arquivo. `cancelled`: o
 * usuário fechou a folha de propósito. `downloaded`: sem compartilhar arquivo (ou o sistema recusou), o arquivo foi baixado.
 * `not-found`: não há foto com esse id.
 */
export type PhotoShareOutcome = 'shared' | 'cancelled' | 'downloaded' | 'not-found';

function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { name?: unknown; inner?: unknown; cause?: unknown };
  // O Dexie embrulha o erro do IndexedDB: o nome pode estar no próprio erro, no `inner` ou na `cause`.
  return (
    candidate.name === 'QuotaExceededError' ||
    (candidate.inner !== undefined && candidate.inner !== error && isQuotaError(candidate.inner)) ||
    (candidate.cause !== undefined && candidate.cause !== error && isQuotaError(candidate.cause))
  );
}

/** Os bytes de um `Blob`. Sem `Blob.arrayBuffer` (navegador antigo) lê pelo `FileReader`. */
function readBytes(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Bytes para texto base64, em pedaços (um `String.fromCharCode(...tudo)` estoura a pilha numa foto de centenas de KB). */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/**
 * Único ponto de acesso às fotos de progresso. **Só no aparelho**: este serviço não conhece a fila de escrita, o puxador do
 * servidor nem a exportação, e é isso que garante que foto nunca sobe. A tela mostra a foto por **`data:` URL**
 * (`dataUrl`): a política de segurança do app só aceita `img-src 'self' data:`, então `blob:` em `<img>` NÃO é permitido e
 * não se usa `URL.createObjectURL` para mostrar.
 *
 * Risco real, a medir no aparelho: o iOS pode apagar os dados de um site sem uso por 7 dias (e a proteção por
 * `storage.persist()` não é garantida): por isso `shareFile` (foto a foto, para Fotos ou Arquivos) é a proteção do dono.
 * **Dado de saúde nunca vai para log** (as fotos de corpo também não).
 */
@Injectable()
export class PhotoStore {
  private readonly db = inject(TRAINING_DB);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly encoder = inject(PHOTO_ENCODER);
  private readonly delivery = inject(ExportDelivery);
  private readonly doc = inject(DOCUMENT);
  private readonly _revision = signal(0);

  /** Sobe a cada mudança neste aparelho; quem mostra a tela relê quando muda. */
  readonly revision = this._revision.asReadonly();

  /**
   * Reduz a imagem (maior lado 1280 px, JPEG 0,8) e guarda **só no aparelho**. `takenOn` é o dia local da foto (padrão:
   * hoje). Sem espaço, nada fica gravado e o resultado é `storage-full`.
   */
  async add(file: Blob, takenOn?: string): Promise<PhotoAddResult> {
    const encoded = await this.encoder
      .encode(file, { maxSide: PHOTO_MAX_SIDE, quality: PHOTO_JPEG_QUALITY })
      .catch(() => null);
    if (encoded === null) return { status: 'invalid-image' };

    const data = await readBytes(encoded.blob);
    const now = this.runtime.now();
    const row: LocalPhoto = {
      id: uuidV7(),
      takenOn: takenOn ?? dateKey(now, deviceTimeZone()),
      data,
      type: encoded.blob.type || 'image/jpeg',
      width: encoded.width,
      height: encoded.height,
      bytes: data.byteLength,
      addedAt: now,
    };
    try {
      await this.db.photos.add(row);
    } catch (error) {
      if (isQuotaError(error)) return { status: 'storage-full' };
      throw error;
    }
    this.touch();
    return { status: 'saved', photo: this.info(row) };
  }

  /**
   * As fotos, da mais nova para a mais antiga (no mesmo dia, a que entrou por último primeiro). O IndexedDB não projeta
   * colunas, então a leitura traz as linhas inteiras (algumas dezenas de fotos de uns 200 KB), mas só os metadados saem daqui.
   */
  async list(): Promise<PhotoInfo[]> {
    const rows = await this.db.photos.toArray();
    return rows
      .map((row) => this.info(row))
      .sort((a, b) => b.takenOn.localeCompare(a.takenOn) || b.addedAt - a.addedAt);
  }

  /** A foto como `data:` URL (é a que a tela põe no `<img>`), ou `null` se não há foto com esse id. */
  async dataUrl(id: string): Promise<string | null> {
    const row = await this.db.photos.get(id);
    if (row === undefined) return null;
    return `data:${row.type};base64,${toBase64(new Uint8Array(row.data))}`;
  }

  /** Apaga a foto do aparelho. Devolve `false` se não havia foto com esse id. */
  async remove(id: string): Promise<boolean> {
    const existed = (await this.db.photos.get(id)) !== undefined;
    if (!existed) return false;
    await this.db.photos.delete(id);
    this.touch();
    return true;
  }

  /**
   * Leva a foto para fora do aparelho (Fotos ou Arquivos): a folha de compartilhar do sistema quando ela aceita arquivo
   * (`navigator.share({ files })` depois de `canShare`) e, senão, o download do arquivo. Foi o jeito escolhido para proteger as
   * fotos, que não vão para a nuvem nem para o JSON da exportação. **INCERTO**: que o arquivo chegue em Fotos ou Arquivos no
   * iPhone 12 ainda precisa ser conferido no aparelho.
   */
  async shareFile(id: string): Promise<PhotoShareOutcome> {
    const row = await this.db.photos.get(id);
    if (row === undefined) return 'not-found';

    const filename = `progresso-${row.takenOn}.jpg`;
    const file = new File([row.data], filename, { type: row.type });

    const outcome = await this.delivery.share({ file });
    if (outcome === 'shared') return 'shared';
    if (outcome === 'cancelled') return 'cancelled';
    this.delivery.download(file, filename);
    return 'downloaded';
  }

  /**
   * Quanto as fotos ocupam e quanto o navegador diz que o site usa e pode usar (`navigator.storage.estimate()`). Sem a API,
   * ou se ela falhar, os campos da cota vêm `null` (não é erro).
   */
  async usage(): Promise<PhotoUsage> {
    const rows = await this.db.photos.toArray();
    const photoBytes = rows.reduce((sum, row) => sum + row.bytes, 0);

    let usageBytes: number | null = null;
    let quotaBytes: number | null = null;
    try {
      const storage = this.doc.defaultView?.navigator.storage;
      if (storage !== undefined && typeof storage.estimate === 'function') {
        const estimate = await storage.estimate();
        usageBytes = estimate.usage ?? null;
        quotaBytes = estimate.quota ?? null;
      }
    } catch {
      // O navegador não soube estimar: segue sem a cota.
    }

    const percent = (part: number | null): number | null =>
      part === null || quotaBytes === null || quotaBytes <= 0 ? null : (part / quotaBytes) * 100;
    return {
      photoCount: rows.length,
      photoBytes,
      usageBytes,
      quotaBytes,
      usedPercent: percent(usageBytes),
      photosPercent: percent(photoBytes),
    };
  }

  private info(row: LocalPhoto): PhotoInfo {
    return {
      id: row.id,
      takenOn: row.takenOn,
      type: row.type,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      addedAt: row.addedAt,
    };
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
