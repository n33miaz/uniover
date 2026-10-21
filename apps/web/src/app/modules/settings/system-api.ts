import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';

/** A configuração da TV padrão, como a API a entrega (tipo gerado do OpenAPI). */
export type TvConfig = components['schemas']['TvConfigResponse'];

/** Um computador pareado que pode controlar a TV. */
export type TvComputer = components['schemas']['TvAgentChoice'];

/** Como está o computador escolhido (os valores que a API usa em `agentStatus`). */
export type TvComputerStatus = 'online' | 'offline' | 'revoked' | 'unknown';

/** De onde vem o computador escolhido (os valores que a API usa em `source`). */
export type TvConfigSource = 'saved' | 'environment' | 'none';

const BASE = `${APP_CONFIG.apiBase}/v1/tv`;

/**
 * Cliente da API de configuração do sistema (hoje, só a da TV). Usa o `HttpClient`, cujos interceptadores já levam o
 * Bearer, renovam a sessão e, no 403 de confirmação pendente, abrem a passkey e repetem o pedido uma única vez; por
 * isso nada aqui trata isso.
 */
@Injectable({ providedIn: 'root' })
export class SystemApi {
  private readonly http = inject(HttpClient);

  tvConfig(): Promise<TvConfig> {
    return firstValueFrom(this.http.get<TvConfig>(`${BASE}/config`));
  }

  /** Passa o controle da TV para outro computador. Exige a confirmação com a passkey. Devolve a configuração nova. */
  bindTvComputer(agentSlug: string): Promise<TvConfig> {
    const body: components['schemas']['BindAgentRequest'] = { agentSlug, name: null };
    return firstValueFrom(this.http.put<TvConfig>(`${BASE}/config/agent`, body));
  }
}
