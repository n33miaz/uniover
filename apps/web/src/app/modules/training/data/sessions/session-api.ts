import { APP_CONFIG } from '../../../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/training`;

/** Caminho da leitura incremental de treinos (o puxador acrescenta `?after=&limit=`). */
export const SESSIONS_PATH = `${BASE}/sessions`;

/** Caminho da leitura incremental de séries (o puxador acrescenta `?after=&limit=`). */
export const SETS_PATH = `${BASE}/sets`;

/** Caminho do `PUT` de um treino (escrita; sai pela fila, nunca direto). */
export function sessionPath(id: string): string {
  return `${SESSIONS_PATH}/${encodeURIComponent(id)}`;
}

/** Caminho do `PUT` de uma série de um treino (escrita; sai pela fila, nunca direto). */
export function setPath(sessionId: string, id: string): string {
  return `${sessionPath(sessionId)}/sets/${encodeURIComponent(id)}`;
}
