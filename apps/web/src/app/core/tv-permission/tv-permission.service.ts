import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, Injector, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { problemOf } from '../auth/api-problem';
import { APP_CONFIG } from '../config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/tv`;

/** Chave do `sessionStorage` (por aba): as TVs que a pessoa adiou com "Depois" nesta visita. */
export const TV_PERMISSION_DISMISSED_KEY = 'uniover.tv-permission.dismissed';

/** Intervalo e limite da espera pelo aceite na TV (o aviso da TV some depois de ~1 min sem resposta). */
export const GRANT_POLL_MS = 3000;
export const GRANT_TIMEOUT_MS = 70_000;

/** Uma TV da conta que ainda precisa do "Permitir" na tela dela. */
export interface PermissionPending {
  readonly tvId: string;
  readonly name: string;
}

/**
 * Como terminou o pedido do aviso:
 * - `asked`: o agente pediu e o aviso está na TV;
 * - `unreachable`: a TV (ou o computador dela) não respondeu;
 * - `unsupported`: o computador da TV é antigo demais para pedir;
 * - `busy`: o aviso já está na tela da TV;
 * - `failed`: qualquer outra falha.
 */
export type PermissionAsk = 'asked' | 'unreachable' | 'unsupported' | 'busy' | 'failed';

function readPending(value: unknown): PermissionPending[] {
  const items = (value as { items?: unknown } | null)?.items;
  if (!Array.isArray(items)) return [];
  const pending: PermissionPending[] = [];
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const dto = item as Record<string, unknown>;
    if (typeof dto['tvId'] === 'string' && dto['tvId'] !== '' && typeof dto['name'] === 'string') {
      pending.push({ tvId: dto['tvId'], name: dto['name'] });
    }
  }
  return pending;
}

function readDismissed(): readonly string[] {
  try {
    const raw = sessionStorage.getItem(TV_PERMISSION_DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: readonly string[]): void {
  try {
    sessionStorage.setItem(TV_PERMISSION_DISMISSED_KEY, JSON.stringify(ids));
  } catch {
    // Sem armazenamento da aba: o adiamento vale só até recarregar.
  }
}

/**
 * A permissão do UniOver na TV Samsung, do lado de quem a usa. O agente avisa a API quando a TV deixa de reconhecê-lo
 * (e para de tentar, sem pedir de novo em silêncio); aqui a conta descobre isso ao entrar, antes de qualquer tela, e pode
 * pedir o aviso na TV, uma vez, quando alguém está na frente dela. "Depois" adia só nesta visita: na próxima entrada a
 * folha volta enquanto a TV precisar.
 *
 * Falha de rede, servidor dormindo ou qualquer erro nunca prende ninguém: a lista fica vazia e o app segue.
 */
@Injectable({ providedIn: 'root' })
export class TvPermissionService {
  private readonly injector = inject(Injector);

  /** As TVs da conta que precisam do aceite (as que a API disse na última leitura). */
  readonly pending = signal<readonly PermissionPending[]>([]);
  private readonly dismissed = signal<readonly string[]>(readDismissed());

  /** A TV de que a folha trata agora: a primeira pendente que a pessoa não adiou. */
  readonly current = computed(
    () => this.pending().find((tv) => !this.dismissed().includes(tv.tvId)) ?? null,
  );

  private get http(): HttpClient {
    return this.injector.get(HttpClient);
  }

  /** Lê o que está pendente; erro de qualquer tipo deixa a lista como estava. */
  async refresh(): Promise<void> {
    try {
      const dto = await firstValueFrom(this.http.get<unknown>(`${BASE}/permission`));
      this.pending.set(readPending(dto));
    } catch {
      // Sem rede ou sem acesso ao módulo: sem folha, e a pessoa segue para o app.
    }
  }

  /**
   * A TV ainda aparece como pendente? Usado para esperar o aceite. Não mexe em `pending`: a folha que espera é a
   * `current`, e tirá-la da lista a faria sumir antes de mostrar "Pronto". Quem fecha a folha lê a lista de novo.
   */
  async stillPending(tvId: string): Promise<boolean> {
    try {
      const dto = await firstValueFrom(this.http.get<unknown>(`${BASE}/permission`));
      return readPending(dto).some((tv) => tv.tvId === tvId);
    } catch {
      return true;
    }
  }

  /** "Depois": esconde a folha desta TV até a próxima visita ao app. */
  dismiss(tvId: string): void {
    const next = this.dismissed().includes(tvId) ? this.dismissed() : [...this.dismissed(), tvId];
    this.dismissed.set(next);
    writeDismissed(next);
  }

  /** Dispara o aviso "Permitir" na TV pelo computador dela. */
  async ask(tvId: string): Promise<PermissionAsk> {
    try {
      await firstValueFrom(
        this.http.post<unknown>(`${BASE}/permission/request`, {}, { params: { tvId } }),
      );
      return 'asked';
    } catch (error) {
      return askFailure(error);
    }
  }

  /**
   * Espera o aceite: confere de tempos em tempos se a TV deixou de precisar. `true` quando ela passou a reconhecer o
   * UniOver; `false` se o tempo acabou (ninguém aceitou na TV). `stillNeeded` diz de onde ler o estado.
   */
  async waitForGrant(
    stillNeeded: () => Promise<boolean>,
    options: { intervalMs?: number; timeoutMs?: number } = {},
  ): Promise<boolean> {
    const interval = options.intervalMs ?? GRANT_POLL_MS;
    const deadline = Date.now() + (options.timeoutMs ?? GRANT_TIMEOUT_MS);
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, interval));
      if (!(await stillNeeded())) return true;
    }
    return false;
  }
}

function askFailure(error: unknown): PermissionAsk {
  const problem = problemOf(error);
  if (problem?.kind === 'permission-unsupported') return 'unsupported';
  if (problem?.kind === 'agent-offline' || problem?.kind === 'agent-timeout') return 'unreachable';
  const agentError =
    error instanceof HttpErrorResponse && error.error && typeof error.error === 'object'
      ? (error.error as { agentError?: unknown }).agentError
      : null;
  if (agentError === 'tv_unreachable') return 'unreachable';
  if (agentError === 'permission_in_progress') return 'busy';
  return 'failed';
}
