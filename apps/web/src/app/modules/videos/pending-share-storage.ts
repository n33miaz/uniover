import type { RawSharePayload } from './video-inbox.model';
import { clampShareParam } from './share-input-limits';
import { extractVideoUrl } from './video-url-extractor';

export const PENDING_SHARE_STORAGE_KEY = 'uniover.videos.pending_share';
const PENDING_SHARE_MAX_AGE_MS = 60 * 60 * 1000;

export interface PendingShare extends RawSharePayload {
  readonly id: string;
  readonly timestamp: number;
}

export const INTERRUPTED_SHARE_STORAGE_KEY = 'uniover.videos.interrupted_share';

type StorageName = 'sessionStorage' | 'localStorage';

interface InterruptedShare {
  readonly id: string;
  /** `null` quando a conta ainda não era conhecida no momento do desvio. */
  readonly accountId: string | null;
}

let fallback: PendingShare | null = null;
let interrupted: InterruptedShare | null = null;

function isExpired(timestamp: number): boolean {
  return Date.now() - timestamp > PENDING_SHARE_MAX_AGE_MS;
}

/**
 * Valida um registro vindo do compartilhamento ou de um storage (inclusive gravado por versões
 * antigas). Exige id, data válida com até uma hora de idade e link de vídeo http/https sem credenciais.
 */
function toPendingShare(value: unknown): PendingShare | null {
  if (typeof value !== 'object' || value === null) return null;
  const record = value as Record<string, unknown>;
  const { id, timestamp } = record;
  if (typeof id !== 'string' || id.length === 0) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(new Date(timestamp).getTime())) return null;
  if (isExpired(timestamp)) return null;
  const fields: (string | null)[] = [];
  for (const key of ['url', 'text', 'title']) {
    const field = record[key];
    if (field != null && typeof field !== 'string') return null;
    fields.push(clampShareParam(field));
  }
  const [url, text, title] = fields;
  const share: PendingShare = { id, timestamp, url, text, title };
  return extractVideoUrl(share) ? share : null;
}

/**
 * Guarda o compartilhamento até o login terminar e devolve o id que identifica esta intenção.
 * Devolve null (sem gravar nada) quando o conteúdo não tem um link de vídeo aceitável.
 */
export function stashPendingShare(payload: RawSharePayload): string | null {
  const share = toPendingShare({
    ...payload,
    id: crypto.randomUUID(),
    timestamp: payload.timestamp ?? Date.now(),
  });
  if (!share) return null;
  fallback = share;
  const json = JSON.stringify(share);
  try {
    sessionStorage.setItem(PENDING_SHARE_STORAGE_KEY, json);
  } catch {
    removeStoredShare('sessionStorage');
    // sessionStorage indisponível (modo privado restrito ou cota): tenta localStorage para sobreviver a reloads.
    try {
      localStorage.setItem(PENDING_SHARE_STORAGE_KEY, json);
    } catch {
      // Ambos bloqueados: a cópia em memória ainda serve enquanto a aba não fechar.
    }
  }
  return share.id;
}

function readStoredShare(name: StorageName): PendingShare | null {
  let raw: string | null;
  try {
    raw = globalThis[name].getItem(PENDING_SHARE_STORAGE_KEY);
  } catch {
    return null;
  }
  if (!raw) return null;
  let share: PendingShare | null = null;
  try {
    share = toPendingShare(JSON.parse(raw));
  } catch {
    // JSON ilegível: tratado como registro inválido abaixo.
  }
  // Registros antigos ou adulterados nunca são processados: saem do storage na primeira leitura.
  if (!share) removeStoredShare(name);
  return share;
}

/**
 * Lê o compartilhamento pendente sem consumi-lo. Com `id`, só devolve o registro dessa intenção;
 * um compartilhamento de outra aba ou de outro fluxo nunca é devolvido no lugar dele.
 */
export function peekPendingShare(id?: string): PendingShare | null {
  if (fallback && isExpired(fallback.timestamp)) fallback = null;
  const candidates = [
    () => fallback,
    () => readStoredShare('sessionStorage'),
    () => readStoredShare('localStorage'),
  ];
  for (const read of candidates) {
    const share = read();
    if (share && (id === undefined || share.id === id)) return share;
  }
  return null;
}

function removeStoredShare(name: StorageName, id?: string): void {
  try {
    const storage = globalThis[name];
    if (id !== undefined) {
      const raw = storage.getItem(PENDING_SHARE_STORAGE_KEY);
      if (!raw || (JSON.parse(raw) as PendingShare | null)?.id !== id) return;
    }
    storage.removeItem(PENDING_SHARE_STORAGE_KEY);
  } catch {
    // Uma entrada ilegível ou um storage bloqueado não impede o uso do outro.
  }
}

/**
 * Anota que a caixa desviou este compartilhamento antes de saber a permissão, para retomá-lo depois.
 * Vale só para esta aba (memória e sessionStorage); um id sem registro válido é ignorado.
 */
export function markInterruptedShare(id: string, accountId: string | null): void {
  if (!peekPendingShare(id)) return;
  interrupted = { id, accountId };
  try {
    sessionStorage.setItem(INTERRUPTED_SHARE_STORAGE_KEY, JSON.stringify(interrupted));
  } catch {
    // sessionStorage indisponível: a cópia em memória ainda serve enquanto a aba não recarregar.
  }
}

function readInterruptedShare(): InterruptedShare | null {
  if (interrupted) return interrupted;
  try {
    const raw = sessionStorage.getItem(INTERRUPTED_SHARE_STORAGE_KEY);
    if (!raw) return null;
    const record: unknown = JSON.parse(raw);
    if (typeof record !== 'object' || record === null) return null;
    const { id, accountId } = record as Record<string, unknown>;
    if (typeof id !== 'string' || (typeof accountId !== 'string' && accountId !== null))
      return null;
    return { id, accountId };
  } catch {
    return null;
  }
}

/** Id do compartilhamento interrompido nesta aba que esta conta pode retomar, ou `null`. */
export function interruptedShareId(accountId: string): string | null {
  const share = readInterruptedShare();
  if (!share) return null;
  return share.accountId === null || share.accountId === accountId ? share.id : null;
}

function clearInterruptedShare(id?: string): void {
  if (id !== undefined && readInterruptedShare()?.id !== id) return;
  interrupted = null;
  try {
    sessionStorage.removeItem(INTERRUPTED_SHARE_STORAGE_KEY);
  } catch {
    // Storage bloqueado: não há como apagar a marca, e sem o registro ela não faz nada.
  }
}

export function clearPendingShare(id?: string): void {
  clearInterruptedShare(id);
  if (id === undefined || fallback?.id === id) fallback = null;
  removeStoredShare('sessionStorage', id);
  removeStoredShare('localStorage', id);
}
