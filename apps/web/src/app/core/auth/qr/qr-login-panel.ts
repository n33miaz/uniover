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
 * toque. O QR que vence é trocado por outro sem passar por um estado próprio.
 */
export type QrPanelPhase =
  'idle' | 'ready' | 'starting' | 'waiting' | 'approved' | 'denied' | 'error';

export interface QrPanelConfig {
  /** Intervalo entre duas consultas (24 por minuto cabem folgados no limite da API). */
  readonly pollMs: number;
  /** Espera depois de a API pedir calma (429) antes de consultar de novo. */
  readonly backoffMs: number;
  /** O QR é trocado um pouco ANTES de vencer, para ninguém escanear um código nos últimos segundos. */
  readonly renewLeadMs: number;
}

export const QR_PANEL_CONFIG = new InjectionToken<QrPanelConfig>('QR_PANEL_CONFIG', {
  providedIn: 'root',
  factory: () => ({ pollMs: 2_500, backoffMs: 10_000, renewLeadMs: 5_000 }),
});

/**
 * Entrada pelo celular, como o WhatsApp Web: o computador mostra um QR, o celular onde a pessoa já entrou o escaneia e
 * confirma, e este navegador recebe a sessão sozinho. O bloco só aparece em computador (ponteiro preciso com `hover`):
 * num celular não há como escanear a própria tela, e cada QR custa uma linha no servidor. Some também para quem já tem
 * sessão.
 *
 * O QR só é gerado quando a pessoa toca em "Entrar com o celular": antes disso o servidor não é chamado e nenhum QR de
 * entrada fica exposto num computador que outros usam. Fechar o bloco, esconder a aba ou sair da tela encerra o QR e
 * as consultas; para voltar, outro toque. Enquanto está aberto, o QR se renova sozinho antes de vencer. O segredo de consulta fica só na memória deste componente (nunca no QR, na
 * URL nem no armazenamento do navegador); quem o tem e consulta recebe a sessão UMA vez.
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
  protected readonly link = signal('');
  /** Lido pela página: com o bloco à vista, o cartão largo o põe ao lado do formulário (ver `AuthLayout.aside`). */
  readonly visible = computed(() => this.phase() !== 'idle');
  /** Há QR em preparo ou na tela (com consultas ao servidor): é o que fechar, esconder a aba ou sair encerra. */
  private readonly active = computed(
    () => this.phase() === 'starting' || this.phase() === 'waiting',
  );
  private readonly closeButton = viewChild<ElementRef<HTMLButtonElement>>('close');
  private readonly injector = inject(Injector);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** Cada ciclo (um QR) tem um número; o que ficou para trás (renovação, destruição) se reconhece por ele e para. */
  private cycle = 0;
  private destroyed = false;
  /** A espera entre duas consultas em andamento: o temporizador e a promessa que ele resolve (ver `wait`). */
  private waiting: { timer: ReturnType<typeof setTimeout>; release: () => void } | null = null;

  constructor() {
    // Aba escondida: ninguém está olhando o QR. Encerra (não só pausa): ao voltar, a pessoa toca de novo.
    const onVisibility = () => {
      if (this.doc.visibilityState === 'hidden' && this.active()) this.stop();
    };
    this.doc.addEventListener('visibilitychange', onVisibility);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cycle++;
      this.cancelWait();
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
    void this.run();
    if (!focusedHere) return;
    afterNextRender(() => this.closeButton()?.nativeElement.focus(), { injector: this.injector });
  }

  /** "Gerar outro QR" / "Tentar de novo". */
  protected retry(): void {
    void this.run();
  }

  /** "Fechar" (ou a aba escondida): para as consultas, esquece o QR e volta ao botão. */
  protected stop(): void {
    this.cycle++;
    this.cancelWait();
    this.link.set('');
    this.phase.set('ready');
  }

  private async run(): Promise<void> {
    const mine = ++this.cycle;
    // O ciclo anterior (renovação, "tentar de novo") não deixa uma espera para trás: o laço dele acorda e vê que acabou.
    this.cancelWait();
    this.phase.set('starting');
    let started: QrLoginStarted;
    try {
      started = await this.api.qrStart();
    } catch {
      if (mine === this.cycle) this.phase.set('error');
      return;
    }
    if (mine !== this.cycle) return;

    const origin = this.doc.defaultView?.location.origin ?? '';
    this.link.set(`${origin}/entrar/qr?codigo=${encodeURIComponent(started.code)}`);
    this.phase.set('waiting');
    await this.watch(mine, started);
  }

  /** Consulta até o celular decidir ou o QR chegar perto de vencer (aí troca por outro). */
  private async watch(mine: number, started: QrLoginStarted): Promise<void> {
    const renewAt = Date.now() + started.expiresIn * 1_000 - this.config.renewLeadMs;
    let wait = this.config.pollMs;
    for (;;) {
      await this.wait(wait);
      if (mine !== this.cycle) return;
      wait = this.config.pollMs;

      try {
        const result = await this.api.qrPoll(started.pollSecret);
        if (mine !== this.cycle) return;
        if (result.status === 'approved') {
          this.cycle++;
          this.phase.set('approved');
          await this.auth.signInWithTokens({
            accessToken: result.accessToken ?? '',
            expiresIn: Number(result.expiresIn ?? 0),
          });
          if (!this.destroyed) this.signedIn.emit();
          return;
        }
        if (result.status === 'denied') {
          this.cycle++;
          this.phase.set('denied');
          return;
        }
        if (result.status === 'expired') return void this.run();
      } catch (error) {
        if (mine !== this.cycle) return;
        // Sem rede ou servidor oscilando: segue tentando até o QR vencer. A API pedindo calma (429): espera mais.
        if (error instanceof ApiProblem && error.status === 429) wait = this.config.backoffMs;
      }

      if (Date.now() >= renewAt) return void this.run();
    }
  }

  /**
   * Espera `ms` entre duas consultas. O temporizador fica guardado para poder ser desfeito: sem isso, sair da tela no meio
   * da espera deixava um temporizador de até 10 s vivo (e o laço preso nele). Cancelar RESOLVE a espera em vez de recusá-la,
   * então o laço acorda, vê que o ciclo mudou e termina sem erro solto.
   */
  private wait(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const release = () => {
        clearTimeout(timer);
        if (this.waiting?.timer === timer) this.waiting = null;
        resolve();
      };
      const timer = setTimeout(release, ms);
      this.waiting = { timer, release };
    });
  }

  private cancelWait(): void {
    this.waiting?.release();
  }
}
