import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../../../core/api/generated/schema';
import { APP_CONFIG } from '../../../../core/config/app-config';

/** Fontes e autores do catálogo, para a tela de créditos (tipo gerado do OpenAPI). */
export type CatalogCredits = components['schemas']['CatalogCreditsResponse'];

const BASE = `${APP_CONFIG.apiBase}/v1/training`;

/** Caminho da leitura incremental de exercícios (o puxador acrescenta `?after=&limit=`). */
export const EXERCISES_PATH = `${BASE}/exercises`;

/** Caminho da escolha de salto de carga de um exercício (escrita; sai pela fila). */
export function exerciseStepPath(id: string): string {
  return `${EXERCISES_PATH}/${encodeURIComponent(id)}/step`;
}

/** Caminho do `PUT` de um exercício próprio (escrita; sai pela fila). */
export function exercisePath(id: string): string {
  return `${EXERCISES_PATH}/${encodeURIComponent(id)}`;
}

/**
 * Leituras do catálogo que não passam pelo puxador. As escritas não estão aqui: saem pela fila de escrita offline,
 * nunca direto pelo `HttpClient`.
 */
@Injectable({ providedIn: 'root' })
export class CatalogApi {
  private readonly http = inject(HttpClient);

  credits(): Promise<CatalogCredits> {
    return firstValueFrom(this.http.get<CatalogCredits>(`${BASE}/catalog/credits`));
  }
}
