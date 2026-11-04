import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, Injector, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../../../core/config/app-config';
import { TvSelection } from '../../data/tv-selection';
import { LivreConfig, TvLivreView, parseLivreView } from './livre-types';

const BASE = `${APP_CONFIG.apiBase}/v1/tv/livre`;

/**
 * Cliente das rotas do TV Livre (`/v1/tv/livre`). Segue o `TvApi`: o `HttpClient` é buscado só na hora da chamada, a
 * TV escolhida vai em `?tvId=` quando há mais de uma (lida no instante da chamada) e nada passa pela fila offline, porque
 * instalar, aplicar e voltar ao original são ações sobre uma TV real, em tempo real: um pedido velho executado depois
 * seria pior do que nenhum. Quase tudo devolve o estado inteiro (`TvLivreView`), que a tela adota como está.
 */
@Injectable({ providedIn: 'root' })
export class TvLivreApi {
  private readonly injector = inject(Injector);
  private readonly selection = inject(TvSelection);

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  private target(): { params?: { tvId: string } } {
    const tvId = this.selection.tvId();
    return tvId ? { params: { tvId } } : {};
  }

  private view(dto: unknown): TvLivreView {
    const view = parseLivreView(dto);
    if (!view) throw new Error('Estado do TV Livre em formato inesperado.');
    return view;
  }

  async get(): Promise<TvLivreView> {
    return this.view(await firstValueFrom(this.http.get<unknown>(BASE, this.target())));
  }

  /** Pede ao agente o estado de agora (o `status` do contrato) e devolve o que ele relatou. */
  async refresh(): Promise<TvLivreView> {
    return this.view(
      await firstValueFrom(this.http.post<unknown>(`${BASE}/refresh`, null, this.target())),
    );
  }

  /** Guarda a configuração no servidor sem aplicá-la na TV; a API a valida com rigor. */
  async saveConfig(config: LivreConfig): Promise<TvLivreView> {
    return this.view(
      await firstValueFrom(this.http.put<unknown>(`${BASE}/config`, config, this.target())),
    );
  }

  /** Manda a foto (se o fundo é a foto) e a configuração guardada à TV, com uma revisão nova. */
  async apply(): Promise<TvLivreView> {
    return this.view(
      await firstValueFrom(this.http.post<unknown>(`${BASE}/apply`, null, this.target())),
    );
  }

  async install(): Promise<TvLivreView> {
    return this.view(
      await firstValueFrom(this.http.post<unknown>(`${BASE}/install`, null, this.target())),
    );
  }

  async setHome(disableFactory: boolean): Promise<TvLivreView> {
    return this.view(
      await firstValueFrom(
        this.http.post<unknown>(`${BASE}/set-home`, { disableFactory }, this.target()),
      ),
    );
  }

  /** "Voltar ao Original": devolve a tela inicial de fábrica e, por padrão, desinstala o TV Livre. */
  async restore(uninstall = true): Promise<TvLivreView> {
    return this.view(
      await firstValueFrom(
        this.http.post<unknown>(`${BASE}/restore`, { uninstall }, this.target()),
      ),
    );
  }

  async sleep(): Promise<void> {
    await firstValueFrom(this.http.post(`${BASE}/sleep`, null, this.target()));
  }

  /** Envia o JPEG já reduzido (a API recusa mais de 400 KiB e o que não começa como JPEG). */
  async putPhoto(jpeg: Blob): Promise<void> {
    await firstValueFrom(
      this.http.put(`${BASE}/photo`, jpeg, {
        ...this.target(),
        headers: { 'Content-Type': 'image/jpeg' },
      }),
    );
  }

  /** A foto guardada, ou `null` quando não há (404). */
  async photo(): Promise<Blob | null> {
    try {
      return await firstValueFrom(
        this.http.get(`${BASE}/photo`, { ...this.target(), responseType: 'blob' }),
      );
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 404) return null;
      throw error;
    }
  }

  async deletePhoto(): Promise<void> {
    await firstValueFrom(this.http.delete(`${BASE}/photo`, this.target()));
  }
}
