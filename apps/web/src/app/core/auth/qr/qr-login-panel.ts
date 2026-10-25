import { DOCUMENT } from '@angular/common';
import {
  Component,
  DestroyRef,
  InjectionToken,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { ApiProblem } from '../api-problem';
import { AuthApi, QrLoginStarted } from '../auth-api';
import { AuthGlyph } from '../auth-glyph';
import { AuthService } from '../auth.service';
import { QrCode } from './qr-code';

/** Em que ponto está a entrada pelo QR (o QR que vence é trocado por outro sem passar por um estado próprio). */
export type QrPanelPhase = 'idle' | 'starting' | 'waiting' | 'approved' | 'denied' | 'error';

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
 * O QR se renova sozinho antes de vencer. O segredo de consulta fica só na memória deste componente (nunca no QR, na
 * URL nem no armazenamento do navegador); quem o tem e consulta recebe a sessão UMA vez.
 */
@Component({
  selector: 'app-qr-login',
  imports: [QrCode, AuthGlyph],
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
  protected readonly visible = computed(() => this.phase() !== 'idle');
  protected readonly spinning = computed(() => this.phase() === 'starting');

  /** Cada ciclo (um QR) tem um número; o que ficou para trás (renovação, destruição) se reconhece por ele e para. */
  private cycle = 0;
  private destroyed = false;

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      this.cycle++;
    });
    const win = this.doc.defaultView;
    // Só em computador; sem `matchMedia` (ambiente sem tela) o bloco nem tenta.
    if (!win?.matchMedia?.('(hover: hover) and (pointer: fine)').matches) return;
    void this.auth.init().then(() => {
      if (this.destroyed || this.auth.status() === 'authenticated') return;
      void this.run();
    });
  }

  /** "Gerar outro QR" / "Tentar de novo". */
  protected retry(): void {
    void this.run();
  }

  private async run(): Promise<void> {
    const mine = ++this.cycle;
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
      await sleep(wait);
      if (mine !== this.cycle) return;
      wait = this.config.pollMs;

      // Aba escondida não consulta: o QR não está sendo olhado. Ao voltar, o tempo decide se renova.
      if (this.doc.visibilityState === 'hidden') {
        if (Date.now() >= renewAt) return void this.run();
        continue;
      }

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
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
