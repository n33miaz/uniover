import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';

/** Um módulo da Início guardado na conta: qual é e se aparece (a ordem é a da lista). */
export interface HomeEntry {
  readonly id: string;
  readonly enabled: boolean;
}

/** As preferências da conta como a API as entrega; `home` nulo é a Início padrão e `version` zero é "nunca gravou". */
export interface AccountPreferences {
  readonly version: number;
  readonly updatedAt: string | null;
  readonly home: readonly HomeEntry[] | null;
}

/** Gravou (`saved`) ou outro aparelho gravou antes e a conta como está agora veio no lugar. */
export interface SaveOutcome {
  readonly saved: boolean;
  readonly current: AccountPreferences;
}

const PREFERENCES_URL = `${APP_CONFIG.apiBase}/v1/identity/me/preferences`;

function isPreferences(value: unknown): value is AccountPreferences {
  const body = value as Partial<AccountPreferences> | null;
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof body.version === 'number' &&
    (body.home === null || Array.isArray(body.home))
  );
}

/**
 * As preferências da própria conta, para a personalização valer em qualquer aparelho. Usa o `HttpClient` (o interceptador
 * leva o Bearer e renova a sessão). Sem `HttpClient` (teste de tela que não o configura) toda chamada falha como se
 * estivesse sem rede, e o app segue com o que há no aparelho.
 */
@Injectable({ providedIn: 'root' })
export class PreferencesApi {
  private readonly http = inject(HttpClient, { optional: true });

  async get(): Promise<AccountPreferences> {
    const body = await this.request(() => this.http!.get<unknown>(PREFERENCES_URL));
    if (!isPreferences(body)) throw new Error('Resposta de preferências inesperada.');
    return body;
  }

  /**
   * Grava a Início completa sobre a versão que o aparelho leu. Se outro aparelho gravou antes (409), devolve a conta como
   * está, para quem chamou adotá-la em vez de apagar a mudança mais nova; qualquer outra falha é lançada.
   */
  async save(baseVersion: number, home: readonly HomeEntry[] | null): Promise<SaveOutcome> {
    try {
      const body = await this.request(() =>
        this.http!.put<unknown>(PREFERENCES_URL, {
          baseVersion,
          home: home?.map(({ id, enabled }) => ({ id, enabled })) ?? null,
        }),
      );
      if (!isPreferences(body)) throw new Error('Resposta de preferências inesperada.');
      return { saved: true, current: body };
    } catch (error) {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 409 &&
        isPreferences(error.error)
      ) {
        return { saved: false, current: error.error };
      }
      throw error;
    }
  }

  private request<T>(call: () => Observable<T>): Promise<T> {
    if (!this.http) return Promise.reject(new Error('Sem cliente HTTP.'));
    return firstValueFrom(call());
  }
}
