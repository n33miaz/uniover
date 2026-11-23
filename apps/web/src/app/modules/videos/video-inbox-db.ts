import { InjectionToken } from '@angular/core';
import Dexie, { type DexieOptions, type EntityTable } from 'dexie';
import { accountDatabaseName } from '../../core/session/account-id';
import type { VideoInboxItem } from './video-inbox.model';

export const VIDEO_INBOX_DB_NAME = 'uniover-videos';

/** Nome do banco de vídeos de uma conta: `uniover-videos-<id>`. */
export function videoInboxDbName(accountId: string): string {
  return accountDatabaseName(VIDEO_INBOX_DB_NAME, accountId);
}

/**
 * Banco local de Caixa de Vídeos de UMA conta (IndexedDB, via Dexie).
 * Isolado por conta: contas diferentes nunca misturam seus links salvos.
 */
export class VideoInboxDb extends Dexie {
  declare items: EntityTable<VideoInboxItem, 'id'>;

  constructor(name: string, options?: DexieOptions) {
    super(name, options);
    this.version(1).stores({
      items: 'id, canonical_url, platform, captured_at, status',
    });
  }
}

/** Abre o banco de uma conta. O teste troca por uma fábrica em memória. */
export const VIDEO_INBOX_DB_FACTORY = new InjectionToken<(accountId: string) => VideoInboxDb>(
  'VIDEO_INBOX_DB_FACTORY',
  {
    providedIn: 'root',
    factory: () => (accountId: string) => new VideoInboxDb(videoInboxDbName(accountId)),
  },
);
