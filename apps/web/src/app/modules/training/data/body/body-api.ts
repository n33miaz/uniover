import { APP_CONFIG } from '../../../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/training/body`;

/** Caminho da leitura incremental das medições (o puxador acrescenta `?after=&limit=`). */
export const BODY_ENTRIES_PATH = `${BASE}/entries`;

/** Caminho da leitura incremental do perfil, no mesmo envelope de cursor, com no máximo um item. */
export const BODY_PROFILE_PATH = `${BASE}/profile`;

/** Caminho do `PUT` de uma medição (escrita; sai pela fila, nunca direto). */
export function bodyEntryPath(id: string): string {
  return `${BODY_ENTRIES_PATH}/${encodeURIComponent(id)}`;
}
