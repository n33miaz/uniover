import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../../../core/config/app-config';
import type { RoutineTemplatesDto } from './routine';

const BASE = `${APP_CONFIG.apiBase}/v1/training`;

/** Caminho da leitura incremental de rotinas (o puxador acrescenta `?after=&limit=`). */
export const ROUTINES_PATH = `${BASE}/routines`;

/** Caminho do `PUT` de uma rotina inteira (escrita; sai pela fila). */
export function routinePath(id: string): string {
  return `${ROUTINES_PATH}/${encodeURIComponent(id)}`;
}

/**
 * Leituras das rotinas que não passam pelo puxador (os modelos prontos). As escritas não estão aqui: saem pela fila
 * de escrita offline, nunca direto pelo `HttpClient`.
 */
@Injectable({ providedIn: 'root' })
export class RoutineApi {
  private readonly http = inject(HttpClient);

  templates(): Promise<RoutineTemplatesDto> {
    return firstValueFrom(this.http.get<RoutineTemplatesDto>(`${BASE}/routine-templates`));
  }
}
