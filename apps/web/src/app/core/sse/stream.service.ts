import { DOCUMENT } from '@angular/common';
import { Injectable, InjectionToken, effect, inject } from '@angular/core';
import { Observable } from 'rxjs';
import { AuthApi } from '../auth/auth-api';
import { AuthService } from '../auth/auth.service';

export interface StreamEvent {
  /** Nome do evento SSE (`message` quando o servidor não nomeia). */
  readonly type: string;
  readonly data: string;
  readonly lastEventId: string;
}

export interface StreamConfig {
  /** Esperas entre tentativas depois de um erro: dobra a cada falha, de 1 s até o teto. */
  readonly backoffStartMs: number;
  readonly backoffMaxMs: number;
  /** Reabertura proativa: o servidor encerra a conexão em 10 min, então reabre antes (aos 9). */
  readonly reopenAfterMs: number;
  /** Quanto tempo com a aba oculta antes de fechar a conexão (o iOS suspende a página de qualquer jeito). */
  readonly hiddenCloseMs: number;
}

export const STREAM_CONFIG = new InjectionToken<StreamConfig>('STREAM_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    backoffStartMs: 1_000,
    backoffMaxMs: 30_000,
    reopenAfterMs: 9 * 60_000,
    hiddenCloseMs: 2 * 60_000,
  }),
});

/** Cria o `EventSource`; os testes trocam por um falso. */
export const EVENT_SOURCE_FACTORY = new InjectionToken<(url: string) => EventSource>(
  'EVENT_SOURCE_FACTORY',
  { providedIn: 'root', factory: () => (url) => new EventSource(url) },
);

interface Dependencies {
  readonly doc: Document;
  readonly win: Window | null;
  readonly config: StreamConfig;
  readonly factory: (url: string) => EventSource;
  readonly requestTicket: () => Promise<unknown>;
}

/**
 * Uma conexão SSE viva. A credencial é o cookie de bilhete que a API põe em `stream-ticket` (120 s, só vale
 * para `/api/v1/`): a URL do `EventSource` nunca leva token. O navegador reconecta sozinho, mas com o mesmo
 * bilhete já vencido; por isso cada erro fecha a conexão e recomeça por um bilhete novo, com espera crescente.
 */
class StreamConnection {
  private source: EventSource | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private reopenTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private attempt = 0;
  private generation = 0;
  private closed = false;
  private suspended = false;
  private sessionStopped = false;

  private readonly onVisibility = () => {
    if (this.deps.doc.visibilityState === 'hidden') {
      this.hiddenTimer = setTimeout(() => this.suspend(), this.deps.config.hiddenCloseMs);
      return;
    }
    clearTimeout(this.hiddenTimer);
    if (this.suspended) this.resume();
  };
  private readonly onOnline = () => {
    // Voltou a rede enquanto esperava a próxima tentativa: tenta já.
    if (!this.closed && !this.suspended && !this.sessionStopped && this.source === null) {
      this.resume();
    }
  };

  constructor(
    private readonly deps: Dependencies,
    private readonly path: string,
    private readonly eventTypes: readonly string[],
    private readonly emit: (event: StreamEvent) => void,
    startActive: boolean,
  ) {
    this.sessionStopped = !startActive;
    deps.doc.addEventListener('visibilitychange', this.onVisibility);
    deps.win?.addEventListener('online', this.onOnline);
    void this.connect();
  }

  /** Sessão encerrada ou voltou a existir. */
  onSession(authenticated: boolean): void {
    if (this.closed) return;
    if (!authenticated) {
      this.sessionStopped = true;
      this.stopConnection();
    } else if (this.sessionStopped) {
      this.sessionStopped = false;
      this.resume();
    }
  }

  close(): void {
    this.closed = true;
    this.stopConnection();
    clearTimeout(this.hiddenTimer);
    this.deps.doc.removeEventListener('visibilitychange', this.onVisibility);
    this.deps.win?.removeEventListener('online', this.onOnline);
  }

  private suspend(): void {
    this.suspended = true;
    this.stopConnection();
  }

  private resume(): void {
    this.suspended = false;
    this.attempt = 0;
    void this.connect();
  }

  private stopConnection(): void {
    this.generation++;
    clearTimeout(this.retryTimer);
    clearTimeout(this.reopenTimer);
    this.source?.close();
    this.source = null;
  }

  private async connect(): Promise<void> {
    if (this.closed || this.suspended || this.sessionStopped) return;
    this.stopConnection();
    const generation = this.generation;
    try {
      await this.deps.requestTicket();
    } catch {
      if (generation === this.generation && !this.closed) this.scheduleRetry();
      return;
    }
    if (generation !== this.generation || this.closed || this.suspended || this.sessionStopped)
      return;

    const source = this.deps.factory(this.path);
    this.source = source;
    source.addEventListener('open', () => {
      if (generation === this.generation) this.attempt = 0;
    });
    for (const type of this.eventTypes) {
      source.addEventListener(type, (event) => {
        if (generation !== this.generation) return;
        const message = event as MessageEvent<string>;
        this.emit({
          type,
          data: String(message.data ?? ''),
          lastEventId: message.lastEventId ?? '',
        });
      });
    }
    source.addEventListener('error', () => {
      if (generation !== this.generation) return;
      this.stopConnection();
      this.scheduleRetry();
    });
    this.reopenTimer = setTimeout(() => void this.connect(), this.deps.config.reopenAfterMs);
  }

  private scheduleRetry(): void {
    const { backoffStartMs, backoffMaxMs } = this.deps.config;
    const delay = Math.min(backoffStartMs * 2 ** this.attempt, backoffMaxMs);
    this.attempt++;
    this.retryTimer = setTimeout(() => void this.connect(), delay);
  }
}

/**
 * Eventos em tempo real por SSE, autenticados por cookie de mesma origem (nunca token na URL). `open(path)`
 * devolve um `Observable`: assinar abre a conexão, cancelar a fecha. Fecha também quando a sessão acaba e com
 * a aba oculta por mais de dois minutos; reabre ao voltar. O servidor SSE real chega com o módulo de
 * dispositivos; até lá os testes usam um `EventSource` falso.
 */
@Injectable({ providedIn: 'root' })
export class StreamService {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly config = inject(STREAM_CONFIG);
  private readonly factory = inject(EVENT_SOURCE_FACTORY);
  private readonly doc = inject(DOCUMENT);
  private readonly connections = new Set<StreamConnection>();

  constructor() {
    effect(() => {
      const authenticated = this.auth.status() !== 'anonymous';
      for (const connection of this.connections) connection.onSession(authenticated);
    });
  }

  open(path: string, eventTypes: readonly string[] = ['message']): Observable<StreamEvent> {
    if (!path.startsWith('/') || /[?&](access_)?token=/i.test(path)) {
      throw new Error('O caminho do stream não pode levar token; a autenticação é pelo cookie.');
    }
    return new Observable<StreamEvent>((subscriber) => {
      const connection = new StreamConnection(
        {
          doc: this.doc,
          win: this.doc.defaultView,
          config: this.config,
          factory: this.factory,
          requestTicket: () =>
            this.auth.authorized((token) => this.api.streamTicket(token), { stepUp: false }),
        },
        path,
        eventTypes,
        (event) => subscriber.next(event),
        this.auth.status() !== 'anonymous',
      );
      this.connections.add(connection);
      return () => {
        connection.close();
        this.connections.delete(connection);
      };
    });
  }
}
