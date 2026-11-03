import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';

type Schemas = components['schemas'];

/** Uma chave dos Atalhos como a lista a devolve: nunca traz o segredo. */
export type SiriKey = Readonly<Schemas['SiriTokenSummary']>;

/** A chave recém-criada: `token` é a única vez em que o segredo existe. */
export type CreatedSiriKey = Readonly<Schemas['CreatedSiriToken']>;

/** Um app instalado na TV, com o nome que o controle mostra para ele. */
export interface SiriApp {
  readonly id: string;
  readonly name: string;
}

const BASE = `${APP_CONFIG.apiBase}/v1/tv`;

/**
 * O que a tela dos Atalhos da Siri pede à API: as chaves do administrador (listar, criar, revogar) e os apps da TV
 * escolhida, para oferecer "abrir app". Usa o `HttpClient` do app: os interceptadores levam o Bearer e, no 403 de
 * confirmação pendente da criação, abrem a passkey e repetem o pedido uma única vez; nada aqui trata isso.
 */
@Injectable({ providedIn: 'root' })
export class SiriApi {
  private readonly http = inject(HttpClient);

  async keys(): Promise<readonly SiriKey[]> {
    const dto = await firstValueFrom(
      this.http.get<Schemas['SiriTokenListResponse']>(`${BASE}/siri/tokens`),
    );
    return Array.isArray(dto?.items) ? dto.items : [];
  }

  /** Criar entrega poder de comando a quem tiver a chave: a API pede a passkey. */
  create(
    name: string,
    tvId: string,
    actions: readonly string[],
    expiresInDays: number | null,
  ): Promise<CreatedSiriKey> {
    const body: Schemas['CreateSiriTokenRequest'] = {
      name,
      tvId,
      actions: [...actions],
      expiresInDays,
    };
    return firstValueFrom(this.http.post<CreatedSiriKey>(`${BASE}/siri/tokens`, body));
  }

  async revoke(id: string): Promise<void> {
    await firstValueFrom(this.http.delete<void>(`${BASE}/siri/tokens/${encodeURIComponent(id)}`));
  }

  /**
   * Os apps instalados na TV (os que se pode abrir), pelo nome que o controle mostra: o próprio do dono, depois o da TV e
   * só então "Atalho n". O tipo é local: um módulo de tela não importa de outro.
   */
  async apps(tvId: string): Promise<readonly SiriApp[]> {
    const dto = await firstValueFrom(
      this.http.get<readonly Schemas['TvShortcut'][]>(`${BASE}/shortcuts`, { params: { tvId } }),
    );
    if (!Array.isArray(dto)) return [];
    return dto
      .filter((item) => typeof item?.id === 'string' && item.installed !== false)
      .map((item) => ({
        id: item.id,
        name:
          item.customLabel?.trim() ||
          item.tvLabel?.trim() ||
          $localize`:@@settings.siri.app.default-name:Atalho ${item.position}:position:`,
      }));
  }
}
