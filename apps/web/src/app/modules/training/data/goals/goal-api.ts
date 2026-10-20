import { APP_CONFIG } from '../../../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/training`;

/** Caminho da leitura incremental de metas (o puxador acrescenta `?after=&limit=`). */
export const GOALS_PATH = `${BASE}/goals`;

/** Caminho do `PUT` da meta de um tipo (escrita; sai pela fila, nunca direto). O exercício vai no corpo. */
export function goalPath(kind: string): string {
  return `${GOALS_PATH}/${encodeURIComponent(kind)}`;
}
