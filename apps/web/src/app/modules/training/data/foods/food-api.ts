import { APP_CONFIG } from '../../../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/training/foods`;
export const FOODS_PATH = BASE;
export const FOOD_SEARCH_PATH = `${BASE}/off/search`;

export function foodPath(id: string): string {
  return `${FOODS_PATH}/${encodeURIComponent(id)}`;
}
