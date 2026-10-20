import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiProblem, isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { leaveDialog } from '../../shared/ui/dialog-motion';
import { DevicesApi } from './devices-api';
import { MAX_DEVICE_NAME, formatCodeInput, isValidDeviceName, normalizeCode } from './pairing-code';

/** O que a folha avisa à página quando termina. */
export type PairOutcome =
  { readonly kind: 'approved'; readonly name: string | null } | { readonly kind: 'denied' };

/**
 * Folha de pareamento: sobe de baixo, sem botão de fechar (a saída é "Cancelar", Esc ou "Aprovar"). O dono digita
 * o código que o agente mostrou e, se quiser, dá um nome ao aparelho. Aprovar pede a passkey (o interceptador abre
 * o diálogo); recusar o código é uma ação secundária e não pede. A folha desce antes de avisar a página, que a tira
 * do DOM.
 */
@Component({
  selector: 'app-pair-sheet',
  templateUrl: './pair-sheet.html',
  styleUrl: './pair-sheet.css',
})
export class PairSheet {
  private readonly api = inject(DevicesApi);
  private readonly connectivity = inject(ConnectivityService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly done = output<PairOutcome>();
  readonly closed = output<void>();

  protected readonly maxName = MAX_DEVICE_NAME;
  protected readonly code = signal('');
  protected readonly name = signal($localize`:@@devices.pair.name-suggestion:PC de casa`);
  protected readonly busy = signal(false);
  /** A folha já está descendo: nada mais vale (nem aprovar, nem recusar, nem cancelar de novo). */
  protected readonly leaving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly online = this.connectivity.online;
  protected readonly normalized = computed(() => normalizeCode(this.code()));
  protected readonly nameValid = computed(() => isValidDeviceName(this.name()));
  protected readonly canApprove = computed(
    () =>
      this.online() &&
      !this.busy() &&
      !this.leaving() &&
      this.normalized() !== null &&
      this.nameValid(),
  );
  protected readonly canDeny = computed(
    () => this.online() && !this.busy() && !this.leaving() && this.normalized() !== null,
  );

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      this.dialog().nativeElement.showModal();
    });
  }

  protected onCodeInput(event: Event): void {
    const input = event.target as HTMLInputElement;
    const formatted = formatCodeInput(input.value);
    input.value = formatted;
    this.code.set(formatted);
    this.error.set(null);
  }

  protected onNameInput(event: Event): void {
    this.name.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (!this.busy()) this.leave(() => this.closed.emit());
  }

  protected async approve(event: Event): Promise<void> {
    event.preventDefault();
    const code = this.normalized();
    if (!code || !this.canApprove()) return;
    this.busy.set(true);
    this.error.set(null);
    const name = this.name().trim() || null;
    try {
      await this.api.approve(code, name);
      this.leave(() => this.done.emit({ kind: 'approved', name }));
    } catch (error) {
      this.error.set(this.approveError(error));
    } finally {
      this.busy.set(false);
    }
  }

  protected async deny(): Promise<void> {
    const code = this.normalized();
    if (!code || !this.canDeny()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.deny(code);
      this.leave(() => this.done.emit({ kind: 'denied' }));
    } catch (error) {
      this.error.set(this.denyError(error));
    } finally {
      this.busy.set(false);
    }
  }

  /** Toca a descida da folha e só então avisa a página. */
  private leave(then: () => void): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    leaveDialog(this.dialog().nativeElement, then);
  }

  private approveError(error: unknown): string {
    const problem = problemOf(error);
    if (problem && isStepUpRequired(problem)) {
      return $localize`:@@devices.pair.error.unconfirmed:A aprovação não foi confirmada com a passkey. Nada foi pareado.`;
    }
    return this.commonError(
      problem,
      $localize`:@@devices.pair.error.approve-failed:Não foi possível aprovar agora. Tente de novo.`,
    );
  }

  private denyError(error: unknown): string {
    return this.commonError(
      problemOf(error),
      $localize`:@@devices.pair.error.deny-failed:Não foi possível recusar agora. Tente de novo.`,
    );
  }

  private commonError(problem: ApiProblem | null, fallback: string): string {
    if (problem?.status === 404) {
      return $localize`:@@devices.pair.error.not-found:Código inválido ou vencido. Confira o que o agente mostra e tente de novo.`;
    }
    if (problem?.status === 429) {
      const seconds = problem.retryAfterSeconds;
      return seconds
        ? $localize`:@@devices.pair.error.rate-limited-seconds:Muitas tentativas seguidas. Tente de novo em ${seconds}:seconds: s.`
        : $localize`:@@devices.pair.error.rate-limited:Muitas tentativas seguidas. Espere um pouco e tente de novo.`;
    }
    if (problem?.status === 400) {
      return $localize`:@@devices.pair.error.invalid:Confira o código e o nome do aparelho (letras, números, espaço e . _ ( ) -).`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@devices.pair.error.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return fallback;
  }
}
