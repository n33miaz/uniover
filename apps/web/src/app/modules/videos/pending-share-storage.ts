import type { RawSharePayload } from './video-inbox.model';

export const PENDING_SHARE_STORAGE_KEY = 'uniover.videos.pending_share';

interface PendingShare extends RawSharePayload {
  readonly id: string;
  readonly timestamp: number;
}

let fallback: PendingShare | null = null;

export function stashPendingShare(payload: RawSharePayload): void {
  fallback = { ...payload, id: crypto.randomUUID(), timestamp: payload.timestamp ?? Date.now() };
  try {
    sessionStorage.setItem(PENDING_SHARE_STORAGE_KEY, JSON.stringify(fallback));
  } catch {
    // A navegação até o login ainda funciona em memória se o navegador recusar a gravação.
  }
}

export function peekPendingShare(): PendingShare | null {
  if (fallback) return fallback;
  try {
    const raw = sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as PendingShare) : null;
  } catch {
    return null;
  }
}

export function clearPendingShare(): void {
  fallback = null;
  try {
    sessionStorage.removeItem(PENDING_SHARE_STORAGE_KEY);
  } catch {
    // A cópia em memória já foi removida.
  }
}
