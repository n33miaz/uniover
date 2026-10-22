import { Injectable, inject, signal } from '@angular/core';
import { OfflineQueue } from '../../../../core/offline-queue/offline-queue';
import { QueueStorageFullError } from '../../../../core/offline-queue/outbox-store';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import {
  type BodyProfileIssue,
  type BodyProfileValues,
  validateBodyProfile,
} from '../../domain/body/body-limits';
import { dateKey, deviceTimeZone } from '../../domain/progress/calendar';
import { TRAINING_DB } from '../training-db';
import { BODY_PROFILE_PATH } from './body-api';
import {
  BODY_PROFILE_ROW_ID,
  type LocalBodyProfile,
  resolveBodyProfile,
  toBodyProfileBody,
} from './body-profile';

/**
 * Resultado de salvar o perfil. `invalid`: o perfil não passa nos limites (`issues` diz o campo). `storage-full`: o
 * aparelho não tem espaço para guardar o pedido, e nada ficou gravado.
 */
export type ProfileWriteResult =
  | { readonly status: 'saved'; readonly profile: LocalBodyProfile }
  | { readonly status: 'invalid'; readonly issues: readonly BodyProfileIssue[] }
  | { readonly status: 'storage-full' };

const QUEUE_MODULE = 'training';

/**
 * Único ponto de acesso ao perfil do corpo (altura, nascimento, sexo e fator de atividade). Há um só por pessoa. A tela lê
 * daqui, sempre do banco local e sem rede.
 *
 * Salvar = gravar no banco local **e** enfileirar **um** `PUT` (o perfil inteiro; a chave natural é o usuário da sessão, não
 * há id na rota). O perfil local vence até o servidor confirmar: a fusão do que volta no puxar escolhe o `clientUpdatedAt`
 * mais novo, e no empate o servidor. Se a fila recusar por falta de espaço, a gravação local é desfeita. **Dado de saúde
 * nunca vai para log.**
 */
@Injectable()
export class ProfileRepository {
  private readonly db = inject(TRAINING_DB);
  private readonly queue = inject(OfflineQueue);
  private readonly runtime = inject(QUEUE_RUNTIME);
  private readonly _revision = signal(0);

  /** Sobe a cada gravação neste aparelho; quem mostra a tela relê quando muda. */
  readonly revision = this._revision.asReadonly();

  /** O perfil, ou `undefined` enquanto o dono ainda não o preencheu (a tela o pede na primeira vez que abre Corpo). */
  get(): Promise<LocalBodyProfile | undefined> {
    return this.db.bodyProfile.get(BODY_PROFILE_ROW_ID);
  }

  /** Grava (ou troca) o perfil inteiro e enfileira o `PUT`. */
  async save(values: BodyProfileValues): Promise<ProfileWriteResult> {
    const today = dateKey(this.runtime.now(), deviceTimeZone());
    const issues = validateBodyProfile(values, today);
    if (issues.length > 0) return { status: 'invalid', issues };

    const previous = await this.get();
    const stamp = Math.max(this.runtime.now(), (previous?.clientUpdatedAt ?? 0) + 1);
    const written: LocalBodyProfile = {
      id: BODY_PROFILE_ROW_ID,
      heightCm: values.heightCm,
      birthDate: values.birthDate,
      sex: values.sex,
      activityFactor: values.activityFactor,
      updatedAt: stamp,
      clientUpdatedAt: stamp,
    };

    await this.db.bodyProfile.put(written);
    this.touch();
    try {
      await this.queue.enqueue({
        method: 'PUT',
        module: QUEUE_MODULE,
        url: BODY_PROFILE_PATH,
        body: toBodyProfileBody(written),
      });
      return { status: 'saved', profile: written };
    } catch (error) {
      await this.undo(written, previous);
      if (error instanceof QueueStorageFullError) return { status: 'storage-full' };
      throw error;
    }
  }

  /** Funde o perfil que veio do servidor: vale o mais novo, e no empate o servidor. */
  async applyRemote(remote: readonly LocalBodyProfile[]): Promise<void> {
    if (remote.length === 0) return;
    await this.db.transaction('rw', this.db.bodyProfile, async () => {
      for (const incoming of remote) {
        const current = await this.db.bodyProfile.get(incoming.id);
        const merged = current === undefined ? incoming : resolveBodyProfile(current, incoming);
        if (merged !== current) await this.db.bodyProfile.put(merged);
      }
    });
    this.touch();
  }

  /** Desfaz a gravação local que a fila recusou; só mexe na linha se ela ainda é a que foi gravada. */
  private async undo(
    written: LocalBodyProfile,
    previous: LocalBodyProfile | undefined,
  ): Promise<void> {
    await this.db.transaction('rw', this.db.bodyProfile, async () => {
      const current = await this.db.bodyProfile.get(written.id);
      if (current === undefined || current.clientUpdatedAt !== written.clientUpdatedAt) return;
      if (previous) await this.db.bodyProfile.put(previous);
      else await this.db.bodyProfile.delete(written.id);
    });
    this.touch();
  }

  private touch(): void {
    this._revision.update((value) => value + 1);
  }
}
