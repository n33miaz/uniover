import { DOCUMENT } from '@angular/common';
import {
  ApplicationRef,
  EnvironmentInjector,
  Injectable,
  createComponent,
  inject,
  signal,
} from '@angular/core';
import { leaveDialog } from '../../../shared/ui/dialog-motion';
import { ApiProblem } from '../api-problem';
import { AuthApi, WebAuthnChallenge } from '../auth-api';
import { AuthService } from '../auth.service';
import { StepUpDialog } from './step-up-dialog';
import { assertionToJson, isWebAuthnAvailable, toRequestOptions } from './webauthn';

/**
 * `preparing`: buscando o desafio · `ready`: pode confirmar · `confirming`: aguardando o autenticador ·
 * `unavailable`: este aparelho não tem WebAuthn · `blocked`: não há como confirmar (sem passkey cadastrada).
 */
export type StepUpPhase = 'preparing' | 'ready' | 'confirming' | 'unavailable' | 'blocked';

/** O que deu errado na última tentativa (a mensagem de cada um vem do diálogo, em pt-BR). */
export type StepUpError = 'cancelled' | 'refused' | 'network' | 'failed';

interface Pending {
  readonly action: string;
  readonly promise: Promise<boolean>;
  readonly settle: (confirmed: boolean) => void;
  readonly dialog: ReturnType<typeof createComponent<StepUpDialog>>;
  readonly opener: Element | null;
  challenge: WebAuthnChallenge | null;
}

/**
 * Confirmação de ação perigosa com a passkey. A confirmação vale minutos, não a sessão (a API é quem conta
 * o prazo). `confirm(action)` abre um diálogo acessível e devolve `true` só se a API aceitou a confirmação;
 * sem WebAuthn ou sem passkey cadastrada devolve `false` e o pedido perigoso não segue.
 *
 * O desafio é buscado quando o diálogo abre, e não ao tocar em "Confirmar": o Safari só deixa o autenticador
 * abrir se `navigator.credentials.get` roda logo depois do toque, sem rede no meio.
 */
@Injectable({ providedIn: 'root' })
export class StepUpService {
  private readonly api = inject(AuthApi);
  private readonly auth = inject(AuthService);
  private readonly doc = inject(DOCUMENT);
  private readonly appRef = inject(ApplicationRef);
  private readonly environment = inject(EnvironmentInjector);

  readonly phase = signal<StepUpPhase>('preparing');
  readonly error = signal<StepUpError | null>(null);
  readonly action = signal<string | null>(null);

  private pending: Pending | null = null;
  /** Só existe enquanto um diálogo ainda está saindo da tela; o pedido seguinte espera o fim para abrir o dele. */
  private leaving: Promise<void> | null = null;

  confirm(action: string): Promise<boolean> {
    if (this.pending) {
      // Já há um diálogo aberto: o pedido seguinte espera a vez em vez de empilhar diálogos.
      return this.pending.promise.then(() => this.confirm(action));
    }
    if (this.leaving) return this.leaving.then(() => this.confirm(action));
    return this.open(action);
  }

  /** Botão "Confirmar" do diálogo. */
  async submit(): Promise<void> {
    const pending = this.pending;
    const win = this.doc.defaultView;
    if (!pending?.challenge || !win || this.phase() !== 'ready') return;

    const challenge = pending.challenge;
    this.phase.set('confirming');
    this.error.set(null);
    try {
      const credential = (await win.navigator.credentials.get({
        publicKey: toRequestOptions(challenge.options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new DOMException('sem credencial', 'NotAllowedError');
      const body = assertionToJson(credential);
      await this.auth.authorized(
        (token) => this.api.stepUpComplete(token, challenge.challengeId, body),
        { stepUp: false },
      );
      this.finish(true);
    } catch (error) {
      if (this.pending !== pending) return;
      this.error.set(classify(error));
      if (error instanceof ApiProblem) {
        // A API gasta o desafio a cada tentativa de confirmar; para tentar de novo é preciso um novo.
        pending.challenge = null;
        await this.prepare(pending);
      } else {
        this.phase.set('ready');
      }
    }
  }

  /** "Tentar de novo" quando o desafio não pôde ser buscado por falta de rede. */
  async retry(): Promise<void> {
    const pending = this.pending;
    if (!pending || this.phase() !== 'blocked') return;
    this.error.set(null);
    await this.prepare(pending);
  }

  /** Botão "Cancelar" e tecla Esc. */
  cancel(): void {
    this.finish(false);
  }

  private open(action: string): Promise<boolean> {
    let settle!: (confirmed: boolean) => void;
    const promise = new Promise<boolean>((resolve) => (settle = resolve));
    const dialog = createComponent(StepUpDialog, { environmentInjector: this.environment });
    const pending: Pending = {
      action,
      promise,
      settle,
      dialog,
      opener: this.doc.activeElement,
      challenge: null,
    };
    this.pending = pending;
    this.action.set(action);
    this.error.set(null);
    this.appRef.attachView(dialog.hostView);
    this.doc.body.appendChild(dialog.location.nativeElement as Node);

    if (!isWebAuthnAvailable(this.doc.defaultView)) {
      this.phase.set('unavailable');
    } else {
      this.phase.set('preparing');
      void this.prepare(pending);
    }
    return promise;
  }

  private async prepare(pending: Pending): Promise<void> {
    if (this.phase() !== 'ready') this.phase.set('preparing');
    try {
      pending.challenge = await this.auth.authorized(
        (token) => this.api.stepUpOptions(token, pending.action),
        { stepUp: false },
      );
      if (this.pending === pending) this.phase.set('ready');
    } catch (error) {
      if (this.pending !== pending) return;
      if (error instanceof ApiProblem && error.kind === 'no-passkey') {
        this.phase.set('blocked');
        return;
      }
      this.error.set(classify(error));
      this.phase.set('blocked');
    }
  }

  /**
   * Encerra o pedido. A resposta sai na hora (a ação protegida segue sem esperar), mas o diálogo ainda desce
   * antes de sair do DOM; o texto dele (`action`) e o foco de quem o abriu só se mexem depois disso.
   */
  private finish(confirmed: boolean): void {
    const pending = this.pending;
    if (!pending) return;
    this.pending = null;
    pending.settle(confirmed);

    let gone = false;
    let release!: () => void;
    const left = new Promise<void>((resolve) => (release = resolve));
    const teardown = () => {
      gone = true;
      this.appRef.detachView(pending.dialog.hostView);
      pending.dialog.destroy();
      this.action.set(null);
      this.leaving = null;
      // O diálogo some do DOM; devolve o foco a quem o abriu.
      if (pending.opener instanceof HTMLElement && pending.opener.isConnected) {
        pending.opener.focus();
      }
      release();
    };
    const element = (pending.dialog.location.nativeElement as HTMLElement).querySelector('dialog');
    if (element) leaveDialog(element, teardown);
    else teardown();
    if (!gone) this.leaving = left;
  }
}

function classify(error: unknown): StepUpError {
  if (
    error instanceof DOMException &&
    (error.name === 'NotAllowedError' || error.name === 'AbortError')
  ) {
    return 'cancelled';
  }
  if (error instanceof ApiProblem) {
    if (error.isNetwork) return 'network';
    if (error.kind === 'step-up-failed') return 'refused';
  }
  return 'failed';
}
