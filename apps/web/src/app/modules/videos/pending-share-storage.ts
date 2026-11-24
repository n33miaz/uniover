import type { RawSharePayload } from './video-inbox.model';

export const PENDING_SHARE_STORAGE_KEY = 'uniover.videos.pending_share';

interface PendingShare extends RawSharePayload {
  readonly id: string;
  readonly timestamp: number;
}

let fallback: PendingShare | null = null;

export function stashPendingShare(payload: RawSharePayload): void {
  fallback = { ...payload, id: crypto.randomUUID(), timestamp: payload.timestamp ?? Date.now() };
  const json = JSON.stringify(fallback);
  try {
    sessionStorage.setItem(PENDING_SHARE_STORAGE_KEY, json);
  } catch {
    // sessionStorage indisponível (modo privado restrito ou cota): tenta localStorage para sobreviver a reloads.
    try {
      localStorage.setItem(PENDING_SHARE_STORAGE_KEY, json);
    } catch {
      // Ambos bloqueados: a cópia em memória ainda serve enquanto a aba não fechar.
    }
  }
}

export function peekPendingShare(): PendingShare | null {
  if (fallback) return fallback;
  try {
    const raw = sessionStorage.getItem(PENDING_SHARE_STORAGE_KEY);
    if (raw) return JSON.parse(raw) as PendingShare;
  } catch {
    // sessionStorage falhou: tenta localStorage abaixo.
  }
  try {
    const raw = localStorage.getItem(PENDING_SHARE_STORAGE_KEY);
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
    // sessionStorage indisponível.
  }
  try {
    localStorage.removeItem(PENDING_SHARE_STORAGE_KEY);
  } catch {
    // localStorage indisponível.
  }
}
