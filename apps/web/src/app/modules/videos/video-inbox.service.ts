import { Injectable, inject } from '@angular/core';
import { SessionState } from '../../core/session/session-state';
import { VIDEO_INBOX_DB_FACTORY, VideoInboxDb } from './video-inbox-db';
import type { RawSharePayload, VideoInboxItem } from './video-inbox.model';
import { extractVideoUrl } from './video-url-extractor';
import { isHttpUrl, normalizeVideoUrl } from './video-url-normalizer';
import { clearPendingShare, peekPendingShare } from './pending-share-storage';

@Injectable({ providedIn: 'root' })
export class VideoInboxService {
  private readonly session = inject(SessionState);
  private readonly dbFactory = inject(VIDEO_INBOX_DB_FACTORY);

  private database: VideoInboxDb | undefined;
  private account: string | undefined;

  private db(): VideoInboxDb {
    const accountId = this.session.accountId();
    if (!accountId) throw new Error('É preciso entrar para acessar a caixa de vídeos.');
    if (!this.database || this.account !== accountId) {
      this.database?.close();
      this.database = this.dbFactory(accountId);
      this.account = accountId;
    }
    return this.database;
  }

  /**
   * Lista todos os links salvos na caixa, em ordem cronológica inversa (mais recentes primeiro).
   */
  async list(): Promise<VideoInboxItem[]> {
    const db = this.db();
    return db.items.orderBy('captured_at').reverse().toArray();
  }

  /**
   * Salva diretamente um item capturado no banco local.
   */
  async add(item: VideoInboxItem): Promise<void> {
    const db = this.db();
    await db.items.put(item);
  }

  /**
   * Remove um item da caixa pelo seu identificador.
   */
  async delete(id: string): Promise<void> {
    const db = this.db();
    await db.items.delete(id);
  }

  /**
   * Extrai a URL do payload compartilhado, normaliza, identifica plataforma e salva o item.
   */
  async captureShare(
    payload: RawSharePayload,
    via: VideoInboxItem['captured_via'] = 'share_target',
    id: string = crypto.randomUUID(),
  ): Promise<VideoInboxItem | null> {
    const extractedUrl = extractVideoUrl(payload);
    if (!extractedUrl) return null;

    const normalized = normalizeVideoUrl(extractedUrl);
    // Só persiste links http/https; javascript:, data:, blob:, file: e afins são descartados.
    if (!isHttpUrl(normalized.canonical_url)) return null;

    const originalText = payload.text?.trim() || payload.url?.trim() || payload.title?.trim() || '';

    const item: VideoInboxItem = {
      id,
      canonical_url: normalized.canonical_url,
      platform: normalized.platform,
      captured_at: new Date(payload.timestamp ?? Date.now()).toISOString(),
      raw_text: originalText,
      captured_via: via,
      status: 'link_only',
      title: payload.title?.trim() || null,
    };

    await this.add(item);
    return item;
  }

  /**
   * Processa o compartilhamento pendente (caso exista) e salva na caixa do usuário atual.
   */
  async processPendingShare(): Promise<VideoInboxItem | null> {
    const pending = peekPendingShare();
    if (!pending) return null;
    const item = await this.captureShare(pending, 'share_target', pending.id);
    clearPendingShare(pending.id);
    return item;
  }
}
