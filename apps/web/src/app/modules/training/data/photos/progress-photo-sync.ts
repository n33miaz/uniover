import { DOCUMENT } from '@angular/common';
import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, effect, inject, signal, untracked } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { AccountScope } from '../../../../core/session/account-scope';
import { TRAINING_DB } from '../training-db';
import type { LocalPhoto, LocalPhotoSync } from './photo';
import { PROGRESS_PHOTO_API, type ProgressPhotoDto } from './progress-photo-api';
import { PhotoStore } from './photo-store';

const CONSENT_KEY = 'progress-photos-cloud-consent';

export type PhotoCloudAvailability =
  'waiting' | 'checking' | 'available' | 'disabled' | 'unavailable';

/**
 * Fila persistida das fotos em JPEG. Ela não reutiliza a fila JSON: além de conservar os bytes, o próprio id da foto é a
 * chave de idempotência enviada à API. Só existe depois da aceitação explícita neste aparelho.
 */
@Injectable()
export class ProgressPhotoSync {
  private readonly db = inject(TRAINING_DB);
  private readonly photos = inject(PhotoStore);
  private readonly api = inject(PROGRESS_PHOTO_API);
  private readonly account = inject(AccountScope);
  private readonly queue = inject(OfflineQueue);
  private readonly win = inject(DOCUMENT).defaultView;
  private readonly _accepted = signal(false);
  private readonly _availability = signal<PhotoCloudAvailability>('waiting');
  private readonly _states = signal<ReadonlyMap<string, LocalPhotoSync>>(new Map());
  private readonly _revision = signal(0);

  readonly accepted = this._accepted.asReadonly();
  readonly availability = this._availability.asReadonly();
  readonly revision = this._revision.asReadonly();

  private started = false;
  private running: Promise<void> | null = null;
  private again = false;
  private startPromise: Promise<void> | null = null;

  constructor() {
    const online = () => void this.run();
    this.win?.addEventListener('online', online);
    inject(DestroyRef).onDestroy(() => this.win?.removeEventListener('online', online));
    effect(() => {
      this.account.sessionAccount();
      if (this.started) untracked(() => void this.run());
    });
  }

  /** Inicia a leitura local e retoma a fila quando a tela do Treino é montada. */
  start(): Promise<void> {
    if (this.started) return this.startPromise ?? Promise.resolve();
    this.started = true;
    this.startPromise = this.load();
    return this.startPromise;
  }

  stateOf(id: string): LocalPhotoSync | undefined {
    return this._states().get(id);
  }

  /** Há alguma dessas fotos sem estado de envio (nem na fila, nem na nuvem)? */
  hasUnsent(ids: readonly string[]): boolean {
    const states = this._states();
    return ids.some((id) => !states.has(id));
  }

  /** A pessoa aceitou a nuvem privada neste aparelho. Fotos antigas continuam locais até o comando explícito. */
  async accept(): Promise<void> {
    await this.db.meta.put({ key: CONSENT_KEY, value: true });
    this._accepted.set(true);
    await this.run();
  }

  /** Enfileira somente fotos já presentes neste aparelho, após a pessoa pedir isso. */
  async sendDevicePhotos(): Promise<number> {
    if (!this._accepted()) return 0;
    const [photos, states] = await Promise.all([
      this.db.photos.toArray(),
      this.db.photoSync.toArray(),
    ]);
    const known = new Set(states.map((entry) => entry.id));
    const pending = photos.filter((photo) => photo.hidden !== true && !known.has(photo.id));
    await this.db.photoSync.bulkPut(
      pending.map((photo) => ({ id: photo.id, state: 'pending', error: false })),
    );
    await this.refreshStates();
    await this.run();
    return pending.length;
  }

  /** Foto nova só entra na fila depois da aceitação; nunca migra o histórico por efeito colateral. */
  async queueNew(id: string): Promise<void> {
    if (!this._accepted()) return;
    await this.db.photoSync.put({ id, state: 'pending', error: false });
    await this.refreshStates();
    await this.run();
  }

  /** Remove localmente ou pede a remoção autenticada da cópia que já chegou à nuvem. */
  async remove(id: string): Promise<void> {
    const entry = await this.db.photoSync.get(id);
    // Só o que nunca saiu do aparelho some direto. Em "erro" a resposta pode ter se perdido com a foto já no servidor.
    if (entry === undefined || entry.state === 'pending') {
      await this.db.transaction('rw', this.db.photos, this.db.photoSync, async () => {
        await this.db.photos.delete(id);
        await this.db.photoSync.delete(id);
      });
      await this.refreshStates();
      return;
    }
    await this.db.photoSync.put({ id, state: 'deleting', error: false });
    await this.photos.hide(id);
    await this.refreshStates();
    await this.run();
  }

  async retry(): Promise<void> {
    await this.run();
  }

  private async load(): Promise<void> {
    const consent = await this.db.meta.get(CONSENT_KEY);
    this._accepted.set(consent?.value === true);
    // Um envio interrompido (aba fechada no meio) não fica preso em "enviando": o mesmo id é reenviado sem duplicar.
    const interrupted = (await this.db.photoSync.toArray()).filter(
      (entry) => entry.state === 'uploading',
    );
    if (interrupted.length > 0) {
      await this.db.photoSync.bulkPut(
        interrupted.map((entry) => ({ id: entry.id, state: 'pending', error: false })),
      );
    }
    await this.refreshStates();
    if (this._accepted()) await this.run();
  }

  private async run(): Promise<void> {
    if (!this.started || !this._accepted() || !this.maySend()) return;
    // Quem pede durante uma rodada em curso marca uma nova passada: o que entrou na fila depois da leitura não espera outro gatilho.
    if (this.running !== null) {
      this.again = true;
      return this.running;
    }
    this.running = (async () => {
      try {
        do {
          this.again = false;
          await this.drain();
        } while (this.again && this.maySend());
      } finally {
        this.running = null;
      }
    })();
    return this.running;
  }

  private maySend(): boolean {
    const accountId = this.queue.accountId;
    return accountId !== null && this.account.isSessionOf(accountId);
  }

  private async drain(): Promise<void> {
    const accountId = this.queue.accountId;
    if (accountId === null || !this.account.isSessionOf(accountId)) return;
    this._availability.set('checking');
    let remote: readonly ProgressPhotoDto[];
    try {
      remote = await this.api.list(accountId);
    } catch (error) {
      this._availability.set(isStorageDisabled(error) ? 'disabled' : 'unavailable');
      return;
    }
    if (!this.account.isSessionOf(accountId)) return;
    this._availability.set('available');
    await this.mergeRemote(accountId, remote);
    await this.deleteQueued(accountId);
    await this.uploadQueued(accountId);
  }

  private async mergeRemote(accountId: string, remote: readonly ProgressPhotoDto[]): Promise<void> {
    const ids = new Set(remote.map((photo) => photo.id));
    const states = await this.db.photoSync.toArray();
    for (const entry of states) {
      if (entry.state === 'cloud' && !ids.has(entry.id)) {
        await this.db.transaction('rw', this.db.photos, this.db.photoSync, async () => {
          await this.db.photos.delete(entry.id);
          await this.db.photoSync.delete(entry.id);
        });
      }
    }
    for (const remotePhoto of remote) {
      if (!this.account.isSessionOf(accountId)) return;
      if ((await this.photos.read(remotePhoto.id)) === undefined) {
        try {
          const data = await this.api.read(accountId, remotePhoto.id);
          await this.photos.cache(toLocalPhoto(remotePhoto, data));
        } catch {
          continue;
        }
      }
      // A lápide e o envio em curso são intenções locais: a lista da nuvem não as sobrescreve.
      const current = await this.db.photoSync.get(remotePhoto.id);
      if (current === undefined || current.state === 'pending' || current.state === 'error') {
        await this.db.photoSync.put({ id: remotePhoto.id, state: 'cloud', error: false });
      }
    }
    await this.refreshStates();
  }

  private async deleteQueued(accountId: string): Promise<void> {
    const deleting = (await this.db.photoSync.toArray()).filter(
      (entry) => entry.state === 'deleting',
    );
    for (const entry of deleting) {
      if (!this.account.isSessionOf(accountId)) return;
      try {
        try {
          await this.api.delete(accountId, entry.id);
        } catch (error) {
          // Já não existe na nuvem (apagada em outro aparelho): o objetivo da exclusão está cumprido.
          if (!(error instanceof HttpErrorResponse && error.status === 404)) throw error;
        }
        await this.db.transaction('rw', this.db.photos, this.db.photoSync, async () => {
          await this.db.photos.delete(entry.id);
          await this.db.photoSync.delete(entry.id);
        });
      } catch {
        await this.db.photoSync.put({ ...entry, error: true });
      }
    }
    await this.refreshStates();
  }

  private async uploadQueued(accountId: string): Promise<void> {
    const queued = (await this.db.photoSync.toArray()).filter(
      (entry) => entry.state === 'pending' || entry.state === 'error',
    );
    for (const entry of queued) {
      if (!this.account.isSessionOf(accountId)) return;
      const photo = await this.photos.read(entry.id);
      if (photo === undefined || photo.hidden === true) {
        await this.db.photoSync.delete(entry.id);
        continue;
      }
      await this.db.photoSync.put({ id: entry.id, state: 'uploading', error: false });
      await this.refreshStates();
      try {
        await this.api.put(accountId, photo.id, photo.takenOn, photo.data);
        const current = await this.db.photoSync.get(photo.id);
        if (current?.state === 'uploading') {
          await this.db.photoSync.put({ id: photo.id, state: 'cloud', error: false });
        }
      } catch (error) {
        if (isStorageDisabled(error)) this._availability.set('disabled');
        await this.db.photoSync.put({ id: photo.id, state: 'error', error: true });
      }
      await this.refreshStates();
    }
  }

  private async refreshStates(): Promise<void> {
    this._states.set(
      new Map((await this.db.photoSync.toArray()).map((entry) => [entry.id, entry])),
    );
    this._revision.update((value) => value + 1);
  }
}

function isStorageDisabled(error: unknown): boolean {
  return error instanceof HttpErrorResponse && error.status === 503;
}

function toLocalPhoto(remote: ProgressPhotoDto, data: ArrayBuffer): LocalPhoto {
  const addedAt = Date.parse(remote.createdAt);
  return {
    id: remote.id,
    takenOn: remote.takenOn,
    data,
    type: 'image/jpeg',
    width: Number(remote.width),
    height: Number(remote.height),
    bytes: data.byteLength,
    addedAt: Number.isFinite(addedAt) ? addedAt : Date.now(),
    hidden: false,
  };
}
