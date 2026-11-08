import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable, firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';

/** Um módulo da Início guardado na conta: qual é e se aparece (a ordem é a da lista). */
export interface HomeEntry {
  readonly id: string;
  readonly enabled: boolean;
}

/** O que a pessoa respondeu à dica "adicionar à tela de início" para um app: "Agora não" (instante em ms), "nunca" e "já instalei". */
export interface InstallHintAnswer {
  readonly dismissedAt?: number;
  readonly never?: boolean;
  readonly installed?: boolean;
}

/** A resposta da dica por app (`root`, `tv`, `treino`); vale em qualquer aparelho e sobrevive à limpeza de dados do Safari. */
export type InstallHintAnswers = Readonly<Record<string, InstallHintAnswer>>;

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
const INSTALL_HINT_URL = `${APP_CONFIG.apiBase}/v1/identity/me/install-hint`;

function isPreferences(value: unknown): value is AccountPreferences {
  const body = value as Partial<AccountPreferences> | null;
  return (
    typeof body === 'object' &&
    body !== null &&
    typeof body.version === 'number' &&
    (body.home === null || Array.isArray(body.home))
  );
}

/** Só o que a dica entende: um objeto de apps, cada um com os três campos no tipo certo; o resto é descartado. */
export function readInstallHint(value: unknown): InstallHintAnswers | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const result: Record<string, InstallHintAnswer> = {};
  for (const [scope, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const { dismissedAt, never, installed } = raw as Record<string, unknown>;
    result[scope] = {
      dismissedAt:
        typeof dismissedAt === 'number' && Number.isFinite(dismissedAt) ? dismissedAt : undefined,
      never: never === true ? true : undefined,
      installed: installed === true ? true : undefined,
    };
  }
  return result;
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

  /** A resposta da conta à dica de instalação (vazia se nunca respondeu). Rota e tabela próprias: não toca na Início. */
  async getInstallHint(): Promise<InstallHintAnswers> {
    const body = await this.request(() => this.http!.get<unknown>(INSTALL_HINT_URL));
    const answers = readInstallHint(body);
    if (answers === null) throw new Error('Resposta da dica de instalação inesperada.');
    return answers;
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

  /**
   * Grava a resposta da dica de instalação. A API funde com a que a conta já tem (nada que valia se desfaz), então não há
   * versão nem conflito. Devolve a resposta da conta como ela ficou.
   */
  async saveInstallHint(scopes: InstallHintAnswers): Promise<InstallHintAnswers> {
    const body = await this.request(() => this.http!.put<unknown>(INSTALL_HINT_URL, { scopes }));
    return readInstallHint(body) ?? {};
  }

  private request<T>(call: () => Observable<T>): Promise<T> {
    if (!this.http) return Promise.reject(new Error('Sem cliente HTTP.'));
    return firstValueFrom(call());
  }
}
