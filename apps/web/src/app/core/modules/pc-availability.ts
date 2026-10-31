import { HttpClient } from '@angular/common/http';
import { Injectable, Injector, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../config/app-config';
import { SessionState } from '../session/session-state';

/** Um favorito do PC: só o identificador e o nome (o caminho do programa nunca sai do computador). */
export interface PcFavorite {
  readonly id: string;
  readonly label: string;
}

/** O que a API sabe do controle do PC desta conta. */
export interface PcStatus {
  /** Existe um computador com o controle do PC ligado (mesmo que esteja desconectado agora). */
  readonly available: boolean;
  /** Esse computador está conectado agora. */
  readonly online: boolean;
  readonly apps: readonly PcFavorite[];
}

export const PC_STATUS_PATH = `${APP_CONFIG.apiBase}/v1/pc/status`;

/** Lê o corpo de `/pc/status`; qualquer coisa fora do formato vale como "sem dados" (nunca inventa um computador). */
export function parsePcStatus(dto: unknown): PcStatus | null {
  if (!dto || typeof dto !== 'object') return null;
  const body = dto as Record<string, unknown>;
  if (typeof body['available'] !== 'boolean' || typeof body['online'] !== 'boolean') return null;
  const apps = Array.isArray(body['apps']) ? body['apps'] : [];
  return {
    available: body['available'],
    online: body['online'],
    apps: apps.flatMap((item): PcFavorite[] => {
      const app = item as Record<string, unknown> | null;
      return app && typeof app['id'] === 'string' && typeof app['label'] === 'string'
        ? [{ id: app['id'], label: app['label'] }]
        : [];
    }),
  };
}

/**
 * Se a casa tem um computador com o controle do PC ligado. A Início usa para decidir se o cartão ainda é "Em Breve"; a tela
 * do módulo usa o mesmo estado para saber se o computador está conectado e quais favoritos oferecer. Fica em `core/` porque
 * os dois lados (Início e módulo) precisam dele e um módulo nunca importa de outro.
 *
 * A leitura é sempre da API (nada guardado neste aparelho): sem resposta, o estado fica como estava. Antes da primeira
 * leitura nada é afirmado: o cartão segue como planejado.
 */
@Injectable({ providedIn: 'root' })
export class PcAvailability {
  private readonly injector = inject(Injector);
  private readonly session = inject(SessionState);
  private readonly current = signal<PcStatus | null>(null);

  /** Existe um computador com o controle ligado? Só `true` depois de a API dizer que sim. */
  readonly available = computed(() => this.current()?.available === true);
  readonly online = computed(() => this.current()?.online === true);
  readonly apps = computed(() => this.current()?.apps ?? []);
  /** `null` até a primeira leitura bem-sucedida. */
  readonly status = this.current.asReadonly();

  constructor() {
    // O computador é o desta conta: outra conta na mesma aba nunca herda o estado da anterior.
    let previous: string | null | undefined;
    effect(() => {
      const accountId = this.session.accountId();
      untracked(() => {
        if (previous !== undefined && previous !== accountId) this.current.set(null);
        previous = accountId;
      });
    });
  }

  /** Relê o estado. Devolve `false` quando a API não respondeu (rede, sessão, sem permissão): o estado anterior fica. */
  async refresh(): Promise<boolean> {
    try {
      const http = this.injector.get(HttpClient);
      const parsed = parsePcStatus(await firstValueFrom(http.get<unknown>(PC_STATUS_PATH)));
      if (!parsed) return false;
      this.current.set(parsed);
      return true;
    } catch {
      return false;
    }
  }
}
