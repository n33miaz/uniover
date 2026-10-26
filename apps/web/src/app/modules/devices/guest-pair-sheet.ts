import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  linkedSignal,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { ApiProblem, isStepUpRequired, problemOf } from '../../core/auth/api-problem';
import { AuthApi } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { SessionState } from '../../core/session/session-state';
import { leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import { DevicesApi } from './devices-api';
import { MAX_DEVICE_NAME, formatCodeInput, isValidDeviceName, normalizeCode } from './pairing-code';

/** A ação que a API aceita confirmar com a senha: aprovar o pareamento do próprio PC. */
export const PAIR_SELF_ACTION = 'devices.pair-self';

/**
 * Folha do CONVIDADO que tem a TV: aprova o PC dele como a própria TV. Pede o código que o PC mostrou (já vem
 * preenchido quando a pessoa chegou pelo botão "Aprovar neste computador"), o nome da TV e a senha de novo (o passo forte
 * de quem não tem passkey, que vale poucos minutos). A TV nasce só para esta conta, nunca como a padrão, e o administrador
 * a vê e revoga em Ajustes. Sem escolha de pessoas: isso é do administrador.
 */
@Component({
  selector: 'app-guest-pair-sheet',
  templateUrl: './guest-pair-sheet.html',
  styleUrl: './pair-sheet.css',
})
export class GuestPairSheet {
  private readonly api = inject(DevicesApi);
  private readonly auth = inject(AuthService);
  private readonly authApi = inject(AuthApi);
  private readonly connectivity = inject(ConnectivityService);
  private readonly session = inject(SessionState);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');

  readonly initialCode = input('');
  readonly done = output<void>();
  readonly closed = output<void>();

  protected readonly maxName = MAX_DEVICE_NAME;
  protected readonly code = linkedSignal(() => formatCodeInput(this.initialCode()));
  protected readonly tvName = signal(this.suggestion());
  protected readonly password = signal('');
  protected readonly busy = signal(false);
  protected readonly leaving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly online = this.connectivity.online;
  protected readonly normalized = computed(() => normalizeCode(this.code()));
  protected readonly nameValid = computed(() => isValidDeviceName(this.tvName()));
  protected readonly canApprove = computed(
    () =>
      this.online() &&
      !this.busy() &&
      !this.leaving() &&
      this.normalized() !== null &&
      this.nameValid() &&
      this.password().length > 0,
  );

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.cancel());
    });
  }

  private suggestion(): string {
    const name = this.session.user()?.displayName?.trim();
    return name
      ? $localize`:@@devices.guest-pair.tv-name:TV de ${name}:name:`.slice(0, MAX_DEVICE_NAME)
      : '';
  }

  protected onCodeInput(event: Event): void {
    const field = event.target as HTMLInputElement;
    const formatted = formatCodeInput(field.value);
    field.value = formatted;
    this.code.set(formatted);
    this.error.set(null);
  }

  protected onNameInput(event: Event): void {
    this.tvName.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected onPasswordInput(event: Event): void {
    this.password.set((event.target as HTMLInputElement).value);
    this.error.set(null);
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (!this.busy()) this.leave();
  }

  protected async approve(event: Event): Promise<void> {
    event.preventDefault();
    const code = this.normalized();
    if (!code || !this.canApprove()) return;
    this.busy.set(true);
    this.error.set(null);
    try {
      // Primeiro a senha (vale poucos minutos, só nesta sessão); depois a aprovação, que a API só aceita com ela.
      await this.auth.authorized(
        (token) => this.authApi.stepUpWithPassword(token, PAIR_SELF_ACTION, this.password()),
        { stepUp: false },
      );
      await this.api.approveOwn(code, this.tvName().trim() || null);
      this.password.set('');
      this.leaving.set(true);
      leaveDialog(this.dialog().nativeElement, () => this.done.emit());
    } catch (error) {
      this.error.set(this.errorText(problemOf(error)));
    } finally {
      this.busy.set(false);
    }
  }

  private leave(): void {
    if (this.leaving()) return;
    this.leaving.set(true);
    leaveDialog(this.dialog().nativeElement, () => this.closed.emit());
  }

  private errorText(problem: ApiProblem | null): string {
    if (problem?.kind === 'invalid-password') {
      return $localize`:@@devices.guest-pair.error.password:Senha incorreta. Confira e tente de novo.`;
    }
    if (problem?.kind === 'guest-agent-limit') {
      return $localize`:@@devices.guest-pair.error.limit:Você já tem o máximo de computadores conectados. Peça ao administrador para revogar um.`;
    }
    if (problem && isStepUpRequired(problem)) {
      return $localize`:@@devices.guest-pair.error.unconfirmed:A senha não foi confirmada. Nada foi pareado.`;
    }
    if (problem?.status === 404) {
      return $localize`:@@devices.guest-pair.error.not-found:Código inválido ou vencido. Confira o que o PC mostra e tente de novo.`;
    }
    if (problem?.status === 429) {
      const seconds = problem.retryAfterSeconds;
      return seconds
        ? $localize`:@@devices.guest-pair.error.rate-limited-seconds:Muitas tentativas seguidas. Tente de novo em ${seconds}:seconds: s.`
        : $localize`:@@devices.guest-pair.error.rate-limited:Muitas tentativas seguidas. Espere um pouco e tente de novo.`;
    }
    if (problem?.status === 400) {
      return $localize`:@@devices.guest-pair.error.invalid:Confira o código e o nome da TV (letras, números, espaço e . _ ( ) -).`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@devices.guest-pair.error.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return $localize`:@@devices.guest-pair.error.failed:Não foi possível aprovar agora. Tente de novo.`;
  }
}
