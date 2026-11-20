import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  ElementRef,
  InjectionToken,
  Injector,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiProblem } from '../api-problem';
import { LoadingSkeleton } from '../../../shared/ui/skeleton/loading-skeleton';
import { AuthApi, QrLoginStarted } from '../auth-api';
import { AuthGlyph } from '../auth-glyph';
import { AuthService } from '../auth.service';
import { QrCode } from './qr-code';

/**
 * Em que ponto está a entrada pelo QR: `idle` é fora de jogo (celular, sessão aberta), `ready` é o botão à espera do
 * toque. Com o bloco aberto o QR é trocado sozinho antes de vencer, sem passar por um estado próprio; `error` só aparece
 * quando a API falha várias vezes seguidas (e mesmo assim as tentativas continuam, mais espaçadas).
 */
export type QrPanelPhase = 'idle' | 'ready' | 'starting' | 'waiting' | 'approved' | 'error';

export interface QrPanelConfig {
  /** Intervalo entre duas consultas (24 por minuto cabem folgados no limite da API). */
  readonly pollMs: number;
  /** Espera depois de a API pedir calma (429) antes de consultar ou pedir um QR de novo. */
  readonly backoffMs: number;
  /** O QR é trocado um pouco ANTES de vencer, para ninguém escanear um código nos últimos segundos. */
  readonly renewLeadMs: number;
  /** Validade usada se a resposta não trouxer uma validade que se possa ler (o servidor usa 120 s por padrão). */
  readonly fallbackLifetimeMs: number;
  /** Primeira espera para pedir outro QR depois de uma falha; dobra a cada falha seguida, até `retryMaxMs`. */
  readonly retryBaseMs: number;
  readonly retryMaxMs: number;
  /** Falhas seguidas toleradas em silêncio (o QR anterior ou o "gerando" continuam na tela) antes do aviso de erro. */
  readonly quietFailures: number;
  /** De quanto em quanto tempo a barra do tempo restante anda. */
  readonly tickMs: number;
}

export const QR_PANEL_CONFIG = new InjectionToken<QrPanelConfig>('QR_PANEL_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    pollMs: 2_500,
    backoffMs: 10_000,
    renewLeadMs: 5_000,
    fallbackLifetimeMs: 60_000,
    retryBaseMs: 2_000,
    retryMaxMs: 30_000,
    quietFailures: 3,
    tickMs: 1_000,
  }),
});

/** Um QR na tela: o link que ele leva, o segredo de consulta e os instantes (relógio deste navegador) que o regem. */
interface ShownQr {
  readonly link: string;
  readonly secret: string;
  readonly shownAt: number;
  readonly renewAt: number;
  readonly expiresAt: number;
}

/**
 * Entrada pelo celular, como o WhatsApp Web: o computador mostra um QR, o celular onde a pessoa já entrou o escaneia e
 * confirma, e este navegador recebe a sessão sozinho. O bloco só aparece em computador (ponteiro preciso com `hover`):
 * num celular não há como escanear a própria tela, e cada QR custa uma linha no servidor. Some também para quem já tem
 * sessão.
 *
 * O primeiro QR só é gerado quando a pessoa toca em "Entrar com o celular": antes disso o servidor não é chamado e nenhum
 * QR de entrada fica exposto num computador que outros usam. Aberto, o QR se renova sozinho alguns segundos antes de
 * vencer (pela validade que a API devolve), sem fim, e a barra embaixo dele mostra quanto falta para a troca. Com a aba
 * escondida tudo pausa; ao voltar, se o QR já estiver perto de vencer, outro é pedido na hora. "Fechar" encerra tudo e
 * devolve o botão. O segredo de consulta fica só na memória deste componente (nunca no QR, na URL nem no armazenamento do
 * navegador); quem o tem e consulta recebe a sessão UMA vez.
 */
@Component({
  selector: 'app-qr-login',
  imports: [QrCode, AuthGlyph, LoadingSkeleton],
  templateUrl: './qr-login-panel.html',
  styleUrl: './qr-login-panel.css',
})
export class QrLoginPanel {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthService);
  private readonly doc = inject(DOCUMENT);
  private readonly config = inject(QR_PANEL_CONFIG);

  /** A sessão foi aberta (para a tela decidir o destino: a de entrada segue para o `next`). */
  readonly signedIn = output<void>();

  protected readonly phase = signal<QrPanelPhase>('idle');
  private readonly qr = signal<ShownQr | null>(null);
  /** O relógio da barra: anda a cada `tickMs` enquanto há QR na tela e a aba está à vista. */
  private readonly now = signal(Date.now());
  /** O celular recusou o QR anterior: o aviso fica sobre o QR novo até a próxima troca. */
  protected readonly refused = signal(false);

  protected readonly link = computed(() => this.qr()?.link ?? '');
  /** Quanto falta para a troca do QR, de 100 (acabou de chegar) a 0 (vai ser trocado). */
  protected readonly remaining = computed(() => {
    const qr = this.qr();
    if (!qr) return 0;
    const span = qr.renewAt - qr.shownAt;
    if (span <= 0) return 0;
    return Math.round(Math.min(1, Math.max(0, (qr.renewAt - this.now()) / span)) * 100);
  });
  protected readonly remainingText = computed(() => {
    const qr = this.qr();
    const seconds = qr ? Math.max(0, Math.ceil((qr.renewAt - this.now()) / 1_000)) : 0;
    return $localize`:@@auth.qr.timer-text:Novo QR em ${seconds}:seconds: s`;
  });

  /** Lido pela página: com o bloco à vista, o cartão largo o põe ao lado do formulário (ver `AuthLayout.aside`). */
  readonly visible = computed(() => this.phase() !== 'idle');
  /** O bloco está aberto e trabalhando (pedindo QR, mostrando, ou tentando de novo depois de falhas). */
  private readonly active = computed(
    () => this.phase() === 'starting' || this.phase() === 'waiting' || this.phase() === 'error',
  );
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('close');
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /**
   * Cada pedido de QR tem um número; a resposta que chega depois de outro pedido, de "Fechar" ou da destruição se
   * reconhece por ele e é ignorada.
   */
  private generation = 0;
  private destroyed = false;
  /** Aba escondida: nada novo é agendado (o que já estava a caminho termina, para não perder uma aprovação). */
  private paused = false;
  /** Falhas seguidas ao pedir QR (zera no primeiro que chega). */
  private failures = 0;
  /** O próximo passo (consultar, trocar o QR ou tentar de novo): um só temporizador por vez. */
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const onVisibility = () => {
      if (this.doc.visibilityState === 'hidden') this.pause();
      else this.resume();
    };
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.generation++;
      this.clearTimers();
      this.doc.removeEventListener('visibilitychange', onVisibility);
    });
    const win = this.doc.defaultView;
    // Só em computador; sem `matchMedia` (ambiente sem tela) o bloco nem tenta.
    if (!win?.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    void this.auth.init().then(() => {
      if (this.destroyed || this.auth.status() === 'authenticated') return;
      this.phase.set('ready');
    });
  }

  /**
   * "Entrar com o celular": só aqui o primeiro QR é pedido. Se o foco estava no botão (teclado), passa ao "Fechar",
   * que fica no lugar dele; com o mouse o foco fica onde estava, sem tirar a pessoa do campo nem acender o aviso dele.
   */
  protected start(): void {
    const focusedHere = this.host.nativeElement.contains(this.doc.activeElement);
    this.failures = 0;
    this.paused = this.doc.visibilityState === 'hidden';
    void this.renew();
    if (!focusedHere) return;
    afterNextRender(() => this.closeButton()?.nativeElement.focus(), { injector: this.injector });
  }

  /** "Tentar de novo" (depois de várias falhas seguidas): pede outro QR na hora, sem esperar o recuo. */
  protected retry(): void {
    void this.renew();
  }

  /** "Fechar": para as consultas e as trocas, esquece o QR e volta ao botão. */
  protected stop(): void {
    this.generation++;
    this.clearTimers();
    this.qr.set(null);
    this.refused.set(false);
    this.failures = 0;
    this.phase.set('ready');
  }

  /** Pede um QR novo; o que estava na tela continua nela até o novo chegar (ou até vencer de verdade). */
  private async renew(refused = false): Promise<void> {
    const mine = ++this.generation;
    this.clearTimer();
    if (!this.validQr()) {
      this.qr.set(null);
      this.stopTicker();
      if (this.phase() !== 'error') this.phase.set('starting');
    }
    let started: QrLoginStarted;
    try {
      started = await this.api.qrStart();
    } catch (error) {
      if (mine !== this.generation) return;
      this.failed(error);
      return;
    }
    if (mine !== this.generation) return;

    this.failures = 0;
    this.refused.set(refused);
    const origin = this.doc.defaultView?.location.origin ?? '';
    const now = Date.now();
    const expiresAt = now + this.lifetimeMs(started);
    // A margem nunca come mais que um quarto da validade: um QR curto ainda fica um tempo útil na tela.
    const lead = Math.min(this.config.renewLeadMs, (expiresAt - now) / 4);
    this.qr.set({
      link: `${origin}/entrar/qr?codigo=${encodeURIComponent(started.code)}`,
      secret: started.pollSecret,
      shownAt: now,
      renewAt: expiresAt - lead,
      expiresAt,
    });
    this.now.set(now);
    this.phase.set('waiting');
    this.startTicker();
    this.schedule(this.config.pollMs);
  }

  /**
   * O pedido de QR falhou. As primeiras falhas passam em silêncio (o QR anterior, se ainda vale, ou o "gerando" ficam
   * na tela); depois aparece o aviso com "Tentar de novo". Em qualquer caso outra tentativa é agendada, com recuo.
   */
  private failed(error: unknown): void {
    this.failures++;
    if (!this.validQr()) {
      this.qr.set(null);
      this.stopTicker();
      this.phase.set(this.failures > this.config.quietFailures ? 'error' : 'starting');
    }
    const backoff = Math.min(
      this.config.retryBaseMs * 2 ** (this.failures - 1),
      this.config.retryMaxMs,
    );
    const calm = error instanceof ApiProblem && error.status === 429 ? this.config.backoffMs : 0;
    this.later(() => void this.renew(), Math.max(backoff, calm));
  }

  /** Validade do QR em ms: a duração que a API manda; senão o horário de vencimento; senão o valor de reserva. */
  private lifetimeMs(started: QrLoginStarted): number {
    const seconds = Number(started.expiresIn);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1_000;
    const until = Date.parse(started.expiresAt) - Date.now();
    if (Number.isFinite(until) && until > 0) return until;
    return this.config.fallbackLifetimeMs;
  }

  /** O QR na tela ainda pode ser escaneado (não venceu de verdade, mesmo que já passe da hora da troca). */
  private validQr(): boolean {
    const qr = this.qr();
    return !!qr && Date.now() < qr.expiresAt;
  }

  /** Próxima consulta em `ms`, ou a troca do QR, o que vier antes. */
  private schedule(ms: number): void {
    const qr = this.qr();
    if (!qr) return;
    const at = Math.min(Date.now() + ms, qr.renewAt);
    this.later(() => this.step(), at - Date.now());
  }

  private step(): void {
    const qr = this.qr();
    if (!qr || Date.now() >= qr.renewAt) {
      void this.renew();
      return;
    }
    void this.poll(qr);
  }

  private async poll(qr: ShownQr): Promise<void> {
    const mine = this.generation;
    try {
      const result = await this.api.qrPoll(qr.secret);
      if (mine !== this.generation) return;
      if (result.status === 'approved') {
        this.generation++;
        this.clearTimers();
        this.phase.set('approved');
        await this.auth.signInWithTokens({
          accessToken: result.accessToken ?? '',
          expiresIn: Number(result.expiresIn ?? 0),
        });
        if (!this.destroyed) this.signedIn.emit();
        return;
      }
      // Recusado no celular: o aviso aparece sobre um QR novo, sem beco sem saída.
      if (result.status === 'denied') return void this.renew(true);
      if (result.status === 'expired') return void this.renew(this.refused());
      this.schedule(this.config.pollMs);
    } catch (error) {
      if (mine !== this.generation) return;
      // Sem rede ou servidor oscilando: segue consultando, em silêncio, até a hora da troca. A API pedindo calma: espera mais.
      const calm = error instanceof ApiProblem && error.status === 429;
      this.schedule(calm ? this.config.backoffMs : this.config.pollMs);
    }
  }

  /** Aba escondida: ninguém está olhando o QR. Para os temporizadores, mas guarda o QR para quando ela voltar. */
  private pause(): void {
    if (this.paused) return;
    this.paused = true;
    this.clearTimers();
  }

  /** Aba de volta: QR perto de vencer (ou nenhum) pede outro na hora; senão a barra e as consultas seguem de onde estavam. */
  private resume(): void {
    if (!this.paused) return;
    this.paused = false;
    if (!this.active()) return;
    const qr = this.qr();
    if (!qr || Date.now() >= qr.renewAt) {
      this.failures = 0;
      void this.renew(this.refused());
      return;
    }
    this.now.set(Date.now());
    this.startTicker();
    this.schedule(0);
  }

  private later(run: () => void, ms: number): void {
    this.clearTimer();
    if (this.paused || this.destroyed) return;
    this.timer = setTimeout(
      () => {
        this.timer = null;
        run();
      },
      Math.max(0, ms),
    );
  }

  private startTicker(): void {
    this.stopTicker();
    if (this.paused || this.destroyed) return;
    this.ticker = setInterval(() => this.now.set(Date.now()), this.config.tickMs);
  }

  private stopTicker(): void {
    if (this.ticker !== null) clearInterval(this.ticker);
    this.ticker = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private clearTimers(): void {
    this.clearTimer();
    this.stopTicker();
  }
}
