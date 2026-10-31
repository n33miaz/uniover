import { DOCUMENT } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { ApiProblem, problemOf } from '../../core/auth/api-problem';
import { AuthApi, PasskeySummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import {
  attestationToJson,
  isWebAuthnAvailable,
  toCreationOptions,
} from '../../core/auth/step-up/webauthn';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph } from './settings-glyph';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';

/** Limite de caracteres do nome da passkey na API. */
const MAX_NAME = 60;

/**
 * Passkeys da conta: listar, cadastrar (pede a senha de novo), renomear e remover (a remoção pede a
 * confirmação com a passkey). A passkey só confirma ações perigosas; ela não entra no app.
 */
@Component({
  selector: 'app-security-section',
  imports: [SettingsGlyph, LoadingSkeleton],
  templateUrl: './security-section.html',
  styleUrl: './security-section.css',
})
export class SecuritySection {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);

  protected readonly maxName = MAX_NAME;
  protected readonly passkeys = signal<readonly PasskeySummary[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly messageIsError = signal(false);
  protected readonly busy = signal(false);

  protected readonly adding = signal(false);
  protected readonly newPassword = signal('');
  protected readonly newName = signal('');

  protected readonly renamingId = signal<string | null>(null);
  protected readonly renameValue = signal('');
  protected readonly removingId = signal<string | null>(null);

  protected readonly canAdd = computed(() => isWebAuthnAvailable(this.doc.defaultView));
  protected readonly needsMore = computed(() => (this.passkeys()?.length ?? 0) < 2);
  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'medium' });

  constructor() {
    // Carrega quando há sessão confirmada (também quando uma sessão pendente é confirmada depois) e se sabe que a conta é
    // do administrador: as passkeys são rota de administrador, e quem não é nunca deve gerar essa chamada (nem um 403).
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.passkeys()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected created(passkey: PasskeySummary): string {
    return $localize`:@@settings.passkeys.created:Criada em ${this.dateFormat.format(new Date(passkey.createdAt))}:date:`;
  }

  protected lastUsed(passkey: PasskeySummary): string {
    return passkey.lastUsedAt
      ? $localize`:@@settings.passkeys.last-used:Último uso em ${this.dateFormat.format(new Date(passkey.lastUsedAt))}:date:`
      : $localize`:@@settings.passkeys.never-used:Ainda não usada`;
  }

  protected renameLabel(passkey: PasskeySummary): string {
    return $localize`:@@settings.passkeys.rename-label:Renomear ${passkey.name}:name:`;
  }

  protected removeLabel(passkey: PasskeySummary): string {
    return $localize`:@@settings.passkeys.remove-label:Remover ${passkey.name}:name:`;
  }

  protected removeQuestion(passkey: PasskeySummary): string {
    return $localize`:@@settings.passkeys.remove-question:Remover a passkey ${passkey.name}:name:?`;
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected openAdd(): void {
    this.adding.set(true);
    this.newPassword.set('');
    this.newName.set('');
    this.say(null);
  }

  protected closeAdd(): void {
    this.adding.set(false);
    this.newPassword.set('');
  }

  protected async add(event: Event): Promise<void> {
    event.preventDefault();
    const win = this.doc.defaultView;
    if (this.busy() || !win || !isWebAuthnAvailable(win)) return;
    this.busy.set(true);
    this.say(null);
    try {
      const password = this.newPassword();
      const challenge = await this.auth.authorized(
        (token) => this.api.registrationOptions(token, password),
        { stepUp: false },
      );
      this.newPassword.set('');
      const credential = (await win.navigator.credentials.create({
        publicKey: toCreationOptions(challenge.options),
      })) as PublicKeyCredential | null;
      if (!credential) throw new DOMException('sem credencial', 'NotAllowedError');
      const body = attestationToJson(credential);
      const name = this.newName().trim() || null;
      await this.auth.authorized(
        (token) => this.api.registrationComplete(token, challenge.challengeId, name, body),
        { stepUp: false },
      );
      this.closeAdd();
      await this.load();
      this.say($localize`:@@settings.passkeys.added:Passkey cadastrada.`, false);
    } catch (error) {
      this.say(this.addError(error), true);
    } finally {
      this.busy.set(false);
    }
  }

  protected startRename(passkey: PasskeySummary): void {
    this.removingId.set(null);
    this.renamingId.set(passkey.id);
    this.renameValue.set(passkey.name);
    this.say(null);
  }

  protected async saveRename(event: Event, passkey: PasskeySummary): Promise<void> {
    event.preventDefault();
    const name = this.renameValue().trim();
    if (this.busy() || name.length === 0) return;
    this.busy.set(true);
    try {
      const updated = await this.auth.authorized((token) =>
        this.api.renamePasskey(token, passkey.id, name),
      );
      this.passkeys.update(
        (list) => list?.map((item) => (item.id === updated.id ? updated : item)) ?? null,
      );
      this.renamingId.set(null);
      this.say($localize`:@@settings.passkeys.renamed:Nome atualizado.`, false);
    } catch {
      this.say(
        $localize`:@@settings.passkeys.rename-failed:Não foi possível renomear agora.`,
        true,
      );
    } finally {
      this.busy.set(false);
    }
  }

  protected askRemove(passkey: PasskeySummary): void {
    this.renamingId.set(null);
    this.removingId.set(passkey.id);
    this.say(null);
  }

  protected async confirmRemove(passkey: PasskeySummary): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      // Sem a confirmação recente com a passkey a API recusa (403) e o `AuthService` abre o diálogo e repete.
      await this.auth.authorized((token) => this.api.removePasskey(token, passkey.id));
      this.removingId.set(null);
      await this.load();
      this.say($localize`:@@settings.passkeys.removed:Passkey removida.`, false);
    } catch (error) {
      this.removingId.set(null);
      this.say(this.removeError(error), true);
    } finally {
      this.busy.set(false);
    }
  }

  protected async load(): Promise<void> {
    try {
      this.passkeys.set(await this.auth.authorized((token) => this.api.passkeys(token)));
      this.loadFailed.set(false);
    } catch {
      this.loadFailed.set(true);
    }
  }

  private say(text: string | null, isError = false): void {
    this.message.set(text);
    this.messageIsError.set(isError);
  }

  private addError(error: unknown): string {
    if (error instanceof DOMException) {
      return $localize`:@@settings.passkeys.add-cancelled:O cadastro foi cancelado ou demorou demais. Tente de novo.`;
    }
    const problem = problemOf(error);
    if (problem?.kind === 'invalid-password') {
      return $localize`:@@settings.passkeys.invalid-password:Senha incorreta.`;
    }
    if (problem?.kind === 'login-locked') {
      return $localize`:@@settings.passkeys.locked:Conta bloqueada por um tempo, por causa de tentativas erradas.`;
    }
    if (problem?.status === 429) {
      return $localize`:@@settings.passkeys.rate-limited:Muitas tentativas seguidas. Espere um pouco.`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@settings.passkeys.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return $localize`:@@settings.passkeys.add-failed:Não foi possível cadastrar a passkey.`;
  }

  private removeError(error: unknown): string {
    const problem: ApiProblem | null = problemOf(error);
    if (problem?.kind === 'last-passkey') {
      return $localize`:@@settings.passkeys.last:Esta é a última passkey: cadastre outra antes de remover.`;
    }
    if (problem?.status === 403) {
      return $localize`:@@settings.passkeys.remove-unconfirmed:A remoção não foi confirmada com a passkey.`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@settings.passkeys.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return $localize`:@@settings.passkeys.remove-failed:Não foi possível remover a passkey.`;
  }
}
