import { DOCUMENT } from '@angular/common';
import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { problemOf } from '../../core/auth/api-problem';
import { AuthApi, GuestInviteSummary, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { SettingsGlyph } from './settings-glyph';

/** Limite de caracteres do nome do convidado na API. */
const MAX_NAME = 100;

/** O link que o dono entrega: o segredo vai no fragmento, que o navegador nunca envia a servidor algum. */
interface CreatedLink {
  readonly name: string;
  readonly url: string;
  readonly expiresAt: string;
}

/**
 * Convidados: o dono gera um link de convite (com a confirmação da passkey), entrega a quem quiser e acompanha quem
 * já entrou. O convidado usa o controle da TV e nada mais; ele define a própria senha, que o dono nunca vê. O sistema
 * não envia e-mail: o dono entrega o link. O segredo do link só aparece aqui, uma vez.
 */
@Component({
  selector: 'app-guests-section',
  imports: [SettingsGlyph],
  templateUrl: './guests-section.html',
  styleUrl: './guests-section.css',
})
export class GuestsSection {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);

  protected readonly maxName = MAX_NAME;
  protected readonly invites = signal<readonly GuestInviteSummary[] | null>(null);
  protected readonly guests = signal<readonly GuestSummary[] | null>(null);
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  protected readonly message = signal<string | null>(null);
  protected readonly messageIsError = signal(false);

  protected readonly newName = signal('');
  protected readonly created = signal<CreatedLink | null>(null);
  protected readonly revokingInviteId = signal<string | null>(null);
  protected readonly revokingGuestId = signal<string | null>(null);

  protected readonly pending = computed(() =>
    (this.invites() ?? []).filter((invite) => invite.status === 'pending'),
  );
  protected readonly canShare = computed(
    () => typeof this.doc.defaultView?.navigator?.share === 'function',
  );
  protected readonly dateFormat = new Intl.DateTimeFormat('pt-BR', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  constructor() {
    // Carrega quando há sessão confirmada (também quando uma sessão pendente é confirmada depois) e se sabe que a conta é
    // do administrador: convites e convidados são rota de administrador, e quem não é nunca deve gerar essa chamada.
    effect(() => {
      if (
        this.session.status() === 'authenticated' &&
        this.session.role() === 'owner' &&
        untracked(() => this.invites()) === null
      ) {
        untracked(() => void this.load());
      }
    });
  }

  protected expires(invite: GuestInviteSummary): string {
    return $localize`:@@settings.guests.invite-expires:Vale até ${this.dateFormat.format(new Date(invite.expiresAt))}:date:`;
  }

  protected linkExpires(link: CreatedLink): string {
    return $localize`:@@settings.guests.link-expires:O link vale até ${this.dateFormat.format(new Date(link.expiresAt))}:date:, serve uma vez só e aparece apenas agora.`;
  }

  protected since(guest: GuestSummary): string {
    return $localize`:@@settings.guests.since:Entrou em ${this.dateFormat.format(new Date(guest.createdAt))}:date:`;
  }

  protected revokeInviteLabel(invite: GuestInviteSummary): string {
    return $localize`:@@settings.guests.revoke-invite-label:Revogar o convite de ${invite.displayName}:name:`;
  }

  protected revokeGuestLabel(guest: GuestSummary): string {
    return $localize`:@@settings.guests.revoke-guest-label:Revogar acesso de ${guest.displayName}:name:`;
  }

  protected revokeGuestQuestion(guest: GuestSummary): string {
    return $localize`:@@settings.guests.revoke-guest-question:Revogar o acesso de ${guest.displayName}:name:? Ele sai do controle da TV em poucos minutos.`;
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.newName().trim();
    if (this.busy() || name.length === 0) return;
    this.busy.set(true);
    this.say(null);
    try {
      // Sem a confirmação recente com a passkey a API recusa (403) e o `AuthService` abre o diálogo e repete.
      const invite = await this.auth.authorized((token) => this.api.createGuestInvite(token, name));
      this.created.set({
        name: invite.displayName,
        url: `${this.origin()}/convite#${invite.token}`,
        expiresAt: invite.expiresAt,
      });
      this.newName.set('');
      await this.load();
    } catch (error) {
      this.say(this.createError(error), true);
    } finally {
      this.busy.set(false);
    }
  }

  protected async copy(): Promise<void> {
    const link = this.created();
    const clipboard = this.doc.defaultView?.navigator?.clipboard;
    if (!link) return;
    try {
      if (!clipboard) throw new Error('sem área de transferência');
      await clipboard.writeText(link.url);
      this.say($localize`:@@settings.guests.copied:Link copiado.`, false);
    } catch {
      this.say(
        $localize`:@@settings.guests.copy-failed:Não deu para copiar sozinho: toque no link, selecione e copie.`,
        true,
      );
    }
  }

  protected async share(): Promise<void> {
    const link = this.created();
    const nav = this.doc.defaultView?.navigator;
    if (!link || typeof nav?.share !== 'function') return;
    try {
      await nav.share({
        title: $localize`:@@settings.guests.share-title:Convite UniOver`,
        url: link.url,
      });
    } catch {
      // Compartilhamento cancelado: nada a fazer.
    }
  }

  protected closeLink(): void {
    this.created.set(null);
    this.say(null);
  }

  protected async revokeInvite(invite: GuestInviteSummary): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.authorized((token) => this.api.revokeGuestInvite(token, invite.id));
      this.revokingInviteId.set(null);
      await this.load();
      this.say($localize`:@@settings.guests.invite-revoked:Convite revogado.`, false);
    } catch {
      this.say($localize`:@@settings.guests.revoke-failed:Não foi possível revogar agora.`, true);
    } finally {
      this.busy.set(false);
    }
  }

  protected async revokeGuest(guest: GuestSummary): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.auth.authorized((token) => this.api.revokeGuest(token, guest.id));
      this.revokingGuestId.set(null);
      await this.load();
      this.say($localize`:@@settings.guests.guest-revoked:Acesso revogado.`, false);
    } catch {
      this.say($localize`:@@settings.guests.revoke-failed:Não foi possível revogar agora.`, true);
    } finally {
      this.busy.set(false);
    }
  }

  private origin(): string {
    return this.doc.defaultView?.location.origin ?? '';
  }

  private async load(): Promise<void> {
    try {
      const [invites, guests] = await Promise.all([
        this.auth.authorized((token) => this.api.guestInvites(token)),
        this.auth.authorized((token) => this.api.guests(token)),
      ]);
      this.invites.set(invites);
      this.guests.set(guests);
      this.loadFailed.set(false);
    } catch {
      this.loadFailed.set(true);
    }
  }

  private say(text: string | null, isError = false): void {
    this.message.set(text);
    this.messageIsError.set(isError);
  }

  private createError(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.kind === 'too-many-invites') {
      return $localize`:@@settings.guests.too-many:Há convites pendentes demais. Revogue algum antes de criar outro.`;
    }
    if (problem?.status === 403) {
      return $localize`:@@settings.guests.unconfirmed:O convite não foi criado: falta a confirmação com a passkey. Cadastre uma passkey em Segurança e tente de novo.`;
    }
    if (problem?.status === 429) {
      return $localize`:@@settings.guests.rate-limited:Muitas tentativas seguidas. Espere um pouco.`;
    }
    if (problem?.isNetwork) {
      return $localize`:@@settings.guests.network:Sem conexão com o servidor. Tente de novo.`;
    }
    return $localize`:@@settings.guests.create-failed:Não foi possível criar o convite agora.`;
  }
}
