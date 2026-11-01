import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import {
  leaveDialog,
  onDialogBackdropClick,
  restoreDialogFocus,
} from '../../shared/ui/dialog-motion';
import { PermissionAsk, TvPermissionService } from './tv-permission.service';

/** Em que ponto a folha está: explicando, esperando o aceite na TV, concluída ou com um problema a contar. */
export type PermissionPhase =
  'intro' | 'asking' | 'waiting' | 'granted' | 'unreachable' | 'unsupported' | 'timeout' | 'failed';

/** O ícone da TV (grade de 24), no mesmo estilo dos outros ícones do app: só caminhos. */
const TV_ICON = [
  'M4.5 6.5h15a1.5 1.5 0 0 1 1.5 1.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 16V8a1.5 1.5 0 0 1 1.5-1.5z',
  'M9 20.5h6',
] as const;

/**
 * Folha curta "Permissão da TV": a TV Samsung esqueceu o UniOver e vai mostrar o aviso "Permitir" na tela dela. Explica em
 * uma frase e oferece "Pedir Agora" (o agente faz a TV mostrar o aviso uma vez) ou "Depois". Depois do pedido espera o
 * aceite na TV, conferindo a API de tempos em tempos. É reaproveitável: a mesma folha abre das Configurações da TV.
 *
 * `later` avisa que a pessoa adiou (o hospedeiro esconde a TV até a próxima visita); `closed` avisa que a folha saiu
 * (`true` quando a TV passou a reconhecer o UniOver). `stillNeeded` diz de onde ler se a TV ainda precisa do aceite
 * (padrão: a lista da própria conta).
 */
@Component({
  selector: 'app-tv-permission-sheet',
  templateUrl: './tv-permission-sheet.html',
  styleUrl: './tv-permission-sheet.css',
})
export class TvPermissionSheet {
  private readonly permission = inject(TvPermissionService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private opener: Element | null = null;

  readonly tvId = input.required<string>();
  readonly tvName = input.required<string>();
  /** Mais de uma TV na fila: o nome ajuda a saber de qual é o aviso. */
  readonly showName = input(false);
  readonly stillNeeded = input<(() => Promise<boolean>) | null>(null);
  readonly later = output<void>();
  readonly closed = output<boolean>();

  protected readonly phase = signal<PermissionPhase>('intro');
  protected readonly leaving = signal(false);
  protected readonly tvIcon = TV_ICON;
  protected readonly busy = computed(() => this.phase() === 'asking' || this.phase() === 'waiting');
  protected readonly canRetry = computed(() =>
    ['unreachable', 'timeout', 'failed'].includes(this.phase()),
  );

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      // showModal prende o foco na folha e deixa o resto da tela inerte: nada é usado antes desta resposta.
      this.opener = document.activeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.postpone());
      dialog.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    });
  }

  /** "Pedir Agora" e "Tentar de Novo": o agente faz a TV mostrar o aviso uma vez. */
  protected async ask(): Promise<void> {
    if (this.busy() || this.leaving()) return;
    this.phase.set('asking');
    const outcome = await this.permission.ask(this.tvId());
    if (this.leaving()) return;
    const failure = this.failureOf(outcome);
    if (failure) {
      this.phase.set(failure);
      return;
    }
    this.phase.set('waiting');
    const check = this.stillNeeded() ?? (() => this.permission.stillPending(this.tvId()));
    const granted = await this.permission.waitForGrant(check);
    if (this.leaving()) return;
    this.phase.set(granted ? 'granted' : 'timeout');
  }

  /** "Depois" e Esc: adia só nesta visita (o hospedeiro lembra). */
  protected postpone(event?: Event): void {
    event?.preventDefault();
    if (this.leaving()) return;
    if (this.phase() !== 'granted') this.later.emit();
    this.leave(this.phase() === 'granted');
  }

  private failureOf(outcome: PermissionAsk): PermissionPhase | null {
    switch (outcome) {
      case 'asked':
      case 'busy':
        // Com o aviso já na tela da TV, esperar o aceite é o certo.
        return null;
      case 'unreachable':
        return 'unreachable';
      case 'unsupported':
        return 'unsupported';
      default:
        return 'failed';
    }
  }

  /** Toca a descida da folha e só então fecha o diálogo e avisa o hospedeiro, que a tira do DOM. */
  private leave(granted: boolean): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    const dialog = this.dialog().nativeElement;
    leaveDialog(dialog, () => {
      dialog.close();
      restoreDialogFocus(this.opener);
      this.closed.emit(granted);
    });
  }
}
