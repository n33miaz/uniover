import { DOCUMENT } from '@angular/common';
import { HttpClient, HttpContext, HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, InjectionToken, Injector, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { version as appVersion } from '../../../../package.json';
import type { components } from '../api/generated/schema';
import { problemOf } from '../auth/api-problem';
import { APP_CONFIG } from '../config/app-config';
import { ConnectivityService } from '../connectivity/connectivity.service';
import { QUIET_REQUEST } from '../connectivity/quiet-request';
import { ResumeGrace } from '../connectivity/resume-grace';
import { uuidV7 } from '../offline-queue/uuid-v7';
import { SessionState } from '../session/session-state';
import {
  errorName,
  normalizeApiPath,
  normalizeRoute,
  safeCode,
  safeTrace,
  safeVersion,
} from './telemetry-sanitize';

/** O que aconteceu: erro do app, falha de requisição, falha de um comando, ou comando que ficou sem resposta. */
export type TelemetryKind = 'client-error' | 'http-failure' | 'command-failure' | 'command-slow';
export type TelemetryModule = 'tv' | 'pc' | 'training' | 'app';
/** Por onde o comando foi: a nuvem (API) ou o canal direto do PC. */
export type TelemetryTransport = 'cloud' | 'direct';

/** O que quem registra informa. Só formas fixas: nada de mensagem, pilha, texto digitado ou identificador de pessoa. */
export interface TelemetryInput {
  readonly kind: TelemetryKind;
  readonly module?: TelemetryModule;
  /** Código curto: nome do erro (`TypeError`), tipo da falha (`network`), código HTTP (`http_503`). */
  readonly code?: string;
  readonly status?: number;
  /** O `X-Trace-Id` da resposta, para achar a linha da API. */
  readonly traceId?: string | null;
  readonly transport?: TelemetryTransport;
  /** Caminho da API chamada (sem query); só vem do interceptador de requisições. */
  readonly api?: string;
}

/** O registro como sai do aparelho (e como o servidor o confere de novo). */
export interface TelemetryEvent {
  readonly id: string;
  readonly at: string;
  readonly kind: TelemetryKind;
  readonly module: TelemetryModule;
  readonly code: string | null;
  readonly status: number | null;
  readonly traceId: string | null;
  readonly transport: TelemetryTransport | null;
  readonly visibility: 'visible' | 'hidden';
  readonly route: string;
  readonly api: string | null;
  readonly version: string | null;
  /** Aconteceu na carência da volta ao app. */
  readonly grace: boolean;
}

export interface TelemetryConfig {
  /** Quantos registros esperam no aparelho; passou disso, o mais antigo sai. */
  readonly queueMax: number;
  /** Quantos registros vão por envio (o servidor aceita até isto). */
  readonly batchMax: number;
  /** Quanto se espera, depois do primeiro registro novo, para juntar mais antes de enviar. */
  readonly flushDelayMs: number;
  /** Quanto se espera para tentar de novo quando o envio não pôde sair (sem rede, sem sessão, servidor fora). */
  readonly retryMs: number;
  /** O mesmo registro (mesma forma) dentro desta janela conta uma vez só. */
  readonly dedupeMs: number;
  /** Teto de registros aceitos por abertura do app (uma falha em laço não enche a fila nem o banco). */
  readonly sessionMax: number;
  /** Amostragem por tipo (0 a 1). */
  readonly sampling: Readonly<Record<TelemetryKind, number>>;
  readonly random: () => number;
}

export const TELEMETRY_CONFIG = new InjectionToken<TelemetryConfig>('TELEMETRY_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    queueMax: 20,
    batchMax: 20,
    flushDelayMs: 8_000,
    retryMs: 60_000,
    dedupeMs: 30_000,
    sessionMax: 100,
    // Falha de requisição é o tipo mais barulhento (rede ruim gera muitas): metade basta para ver o padrão.
    sampling: { 'client-error': 1, 'http-failure': 0.5, 'command-failure': 1, 'command-slow': 1 },
    random: () => Math.random(),
  }),
});

export const CLIENT_EVENTS_PATH = `${APP_CONFIG.apiBase}/v1/devices/client-events`;
/** A fila é de uma conta só: cada conta tem a sua chave (a sem conta, de antes, só se descarta). */
const STORAGE_KEY = 'uniover.telemetry.queue';

/** Um registro na fila, marcado com a conta que o criou (a marca nunca sai do aparelho). */
interface QueuedEvent {
  readonly account: string;
  readonly event: TelemetryEvent;
}

function storageKey(account: string): string {
  return `${STORAGE_KEY}.${encodeURIComponent(account)}`;
}
const TRACE_HEADER = 'X-Trace-Id';

/** O módulo de uma chamada à API, pelo caminho dela. */
export function moduleOfApiPath(path: string): TelemetryModule {
  if (path.startsWith(`${APP_CONFIG.apiBase}/v1/tv`)) return 'tv';
  if (path.startsWith(`${APP_CONFIG.apiBase}/v1/pc`)) return 'pc';
  if (path.startsWith(`${APP_CONFIG.apiBase}/v1/training`)) return 'training';
  return 'app';
}

/**
 * Telemetria privada de erros do app no celular: sem ela o dono só sabe do que aconteceu reproduzindo no aparelho. Uma fila
 * curta (na memória e em `localStorage`, para sobreviver a uma queda), amostragem, sem repetição, e envio autenticado em lote
 * para a API quando há rede e sessão e o app não está na carência da volta. Registrar NUNCA lança nem atrapalha quem registra.
 *
 * Só sai o que tem forma fixa (ver `telemetry-sanitize`): versão do app, rota como modelo da lista permitida, tipo e código da
 * falha, `X-Trace-Id`, caminho (nuvem ou direto), se a página estava visível. Nenhuma mensagem de erro, pilha, texto digitado
 * nem identificador de pessoa no registro. O servidor guarda por poucos dias, ligado à conta que enviou (pela sessão, nunca por
 * algo que o aparelho diga) e só o administrador lê.
 *
 * A fila é por conta: cada registro leva a conta que o criou, e só sai com a sessão dessa mesma conta. Quem sai e quem entra
 * noutra conta no mesmo navegador não herda nem envia os registros da anterior: eles são descartados. Sem conta conhecida
 * (tela de entrada) não há a quem atribuir, e o registro não é guardado.
 */
@Injectable({ providedIn: 'root' })
export class ClientTelemetry {
  private readonly injector = inject(Injector);
  private readonly config = inject(TELEMETRY_CONFIG);
  private readonly doc = inject(DOCUMENT);
  private readonly session = inject(SessionState);
  private readonly connectivity = inject(ConnectivityService);
  private readonly grace = inject(ResumeGrace);

  /** A conta de quem é a fila de agora (`null` = nenhuma). */
  private owner: string | null = null;
  private queue: QueuedEvent[] = [];
  private readonly recent = new Map<string, number>();
  private accepted = 0;
  private sending = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    this.removeLegacyQueue();
    this.syncOwner();
    if (this.queue.length > 0) this.schedule(this.config.flushDelayMs);
  }

  /** Quantos registros esperam envio (para teste e para quem quiser mostrar). */
  get pending(): number {
    this.syncOwner();
    return this.queue.length;
  }

  /** Registra uma ocorrência. Nunca lança. */
  record(input: TelemetryInput): void {
    try {
      this.add(input);
    } catch {
      // Telemetria é secundária: qualquer falha aqui some em silêncio.
    }
  }

  /** Um erro lançado dentro do app (o `ErrorHandler`): só o NOME da classe do erro, nunca a mensagem nem a pilha. */
  recordError(error: unknown): void {
    this.record({ kind: 'client-error', module: 'app', code: errorName(error) });
  }

  /** Uma requisição que falhou; só falha que importa vira registro (ver `worthRecording`). */
  recordHttp(method: string, url: string, error: HttpErrorResponse): void {
    if (!this.worthRecording(method, error.status)) return;
    const api = normalizeApiPath(url);
    this.record({
      kind: 'http-failure',
      module: moduleOfApiPath(api),
      code: error.status === 0 ? 'network' : `http_${error.status}`,
      status: error.status,
      traceId: error.headers?.get(TRACE_HEADER) ?? null,
      api,
    });
  }

  /** Falha de rede, de servidor, limite de uso e recusa de comando. Leitura que dá 404 ou 401 é rotina, não vira registro. */
  private worthRecording(method: string, status: number): boolean {
    if (status === 0 || status >= 500 || status === 408 || status === 429) return true;
    const read = method === 'GET' || method === 'HEAD';
    return !read && status !== 401;
  }

  private add(input: TelemetryInput): void {
    this.syncOwner();
    // Sem conta conhecida não há a quem atribuir o registro: nada é guardado.
    if (this.owner === null) return;
    if (this.accepted >= this.config.sessionMax) return;
    if (this.config.random() >= this.config.sampling[input.kind]) return;
    const event = this.build(input);
    const key = [event.kind, event.module, event.code, event.status, event.route, event.api].join(
      '|',
    );
    const now = Date.now();
    const last = this.recent.get(key);
    if (last !== undefined && now - last < this.config.dedupeMs) return;
    if (this.recent.size >= 100) this.recent.clear();
    this.recent.set(key, now);
    this.accepted++;
    this.queue.push({ account: this.owner, event });
    while (this.queue.length > this.config.queueMax) this.queue.shift();
    this.save();
    this.schedule(this.config.flushDelayMs);
  }

  private build(input: TelemetryInput): TelemetryEvent {
    const status =
      typeof input.status === 'number' && Number.isInteger(input.status) ? input.status : null;
    return {
      id: uuidV7(),
      at: new Date().toISOString(),
      kind: input.kind,
      module: input.module ?? 'app',
      code: safeCode(input.code),
      status: status !== null && status >= 0 && status <= 599 ? status : null,
      traceId: safeTrace(input.traceId),
      transport: input.transport ?? null,
      visibility: this.doc.visibilityState === 'hidden' ? 'hidden' : 'visible',
      route: normalizeRoute(this.doc.defaultView?.location.pathname),
      api: input.api ? normalizeApiPath(input.api) : null,
      version: safeVersion(appVersion),
      grace: this.grace.active(),
    };
  }

  private schedule(delayMs: number): void {
    if (this.timer !== undefined) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // O envio nunca derruba nada: qualquer falha inesperada some aqui, e o que esperava continua na fila.
      this.flush().catch(() => undefined);
    }, delayMs);
  }

  /** Envia um lote se há como (rede, sessão, fora da carência); senão tenta de novo depois. */
  private async flush(): Promise<void> {
    if (this.sending) return;
    this.syncOwner();
    if (this.queue.length === 0) return;
    const owner = this.owner;
    if (
      owner === null ||
      !this.connectivity.online() ||
      this.connectivity.quiet() ||
      this.session.status() !== 'authenticated' ||
      // A sessão em uso tem de ser a da conta dona da fila: com o token de outra conta o registro iria para o nome errado.
      !this.session.isSessionOf(owner)
    ) {
      this.schedule(this.config.retryMs);
      return;
    }
    const batch = this.queue
      .filter((item) => item.account === owner)
      .slice(0, this.config.batchMax);
    if (batch.length === 0) return;
    this.sending = true;
    try {
      const http = this.injector.get(HttpClient);
      // Tipado pelo contrato gerado da API: se o servidor mudar a forma, aqui o compilador avisa.
      const body: components['schemas']['ClientEventsBody'] = {
        events: batch.map((item) => item.event),
      };
      await firstValueFrom(
        http.post(CLIENT_EVENTS_PATH, body, {
          context: new HttpContext().set(QUIET_REQUEST, true),
        }),
      );
      this.discard(batch);
      if (this.queue.length > 0) this.schedule(this.config.flushDelayMs);
    } catch (error) {
      const status = problemOf(error)?.status ?? 0;
      // Recusa definitiva (corpo inválido, sem permissão): reenviar o mesmo lote não adianta. O resto (rede, sessão a renovar,
      // servidor ocupado ou fora) mantém o lote para a próxima tentativa.
      if (status >= 400 && status < 500 && status !== 401 && status !== 408 && status !== 429) {
        this.discard(batch);
      }
      if (this.queue.length > 0) this.schedule(this.config.retryMs);
    } finally {
      this.sending = false;
    }
  }

  private discard(batch: readonly QueuedEvent[]): void {
    const gone = new Set(batch.map((item) => item.event.id));
    this.queue = this.queue.filter((item) => !gone.has(item.event.id));
    this.save();
  }

  /**
   * A fila acompanha a conta em uso. Se ela mudou (saiu e entrou outra, ou saiu), o que era da anterior é descartado, da memória
   * e do aparelho: nunca é enviado com a sessão de outra conta.
   */
  private syncOwner(): void {
    const current = this.session.accountId();
    if (current === this.owner) return;
    const previous = this.owner;
    this.owner = current;
    this.queue = [];
    if (previous !== null) this.forget(previous);
    if (current !== null) this.queue = this.load(current);
  }

  private forget(account: string): void {
    try {
      this.doc.defaultView?.localStorage.removeItem(storageKey(account));
    } catch {
      // Armazenamento bloqueado: não há o que apagar.
    }
  }

  /** A chave sem conta, de antes, não diz de quem são os registros: ninguém a lê, e ela se apaga. */
  private removeLegacyQueue(): void {
    try {
      this.doc.defaultView?.localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Armazenamento bloqueado: não há o que apagar.
    }
  }

  private load(account: string): QueuedEvent[] {
    try {
      const raw = this.doc.defaultView?.localStorage.getItem(storageKey(account));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      if (!Array.isArray(parsed)) return [];
      // Só o que é desta conta e tem a forma de um registro: o armazenamento pode ter sido mexido.
      return parsed
        .filter((item): item is QueuedEvent => this.looksValid(item) && item.account === account)
        .slice(-this.config.queueMax);
    } catch {
      return [];
    }
  }

  /** O que veio do armazenamento pode ter sido mexido: só segue adiante o que tem a forma de um registro. */
  private looksValid(item: unknown): item is QueuedEvent {
    if (!item || typeof item !== 'object') return false;
    const queued = item as Partial<QueuedEvent>;
    const event = queued.event as Partial<TelemetryEvent> | undefined;
    return (
      typeof queued.account === 'string' &&
      !!event &&
      typeof event.id === 'string' &&
      typeof event.at === 'string' &&
      typeof event.kind === 'string'
    );
  }

  private save(): void {
    if (this.owner === null) return;
    try {
      this.doc.defaultView?.localStorage.setItem(
        storageKey(this.owner),
        JSON.stringify(this.queue),
      );
    } catch {
      // Armazenamento bloqueado ou cheio: a fila fica só na memória.
    }
  }
}
