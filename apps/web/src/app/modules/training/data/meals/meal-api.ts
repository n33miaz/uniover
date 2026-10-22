import { APP_CONFIG } from '../../../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/training/meals`;
export const MEALS_PATH = BASE;

export function mealPath(id: string): string {
  return `${MEALS_PATH}/${encodeURIComponent(id)}`;
}
