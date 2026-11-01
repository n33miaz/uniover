import { DOCUMENT, NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  untracked,
  viewChild,
} from '@angular/core';
import { problemOf } from '../../core/auth/api-problem';
import { AuthApi, GuestInviteSummary, GuestSummary } from '../../core/auth/auth-api';
import { AuthService } from '../../core/auth/auth.service';
import { SessionState } from '../../core/session/session-state';
import { GuestPermissions, PeopleApi, PersonUsage } from './people-api';
import { homeModuleTitles } from './people-home';
import { ModuleRegistry } from '../../core/modules/module-registry';
import { PeoplePermissionPicker } from './people-permission-picker';
import { PeoplePermissionsSheet } from './people-permissions-sheet';
import { TV_CONTROL_ONLY, hasModule, permissionSummary } from './people-permissions';
import { SettingsGlyph } from './settings-glyph';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { SessionsSection } from './sessions-section';

/** Limite de caracteres do nome do convidado na API. */
const MAX_NAME = 100;

/** O link que o dono entrega: o segredo vai no fragmento, que o navegador nunca envia a servidor algum. */
interface CreatedLink {
  readonly name: string;
  readonly url: string;
  readonly expiresAt: string;
  readonly permissions: readonly string[];
}

/** Um aviso curto: o texto e se é um erro (o erro vira alerta para o leitor de tela). */
interface Note {
  readonly text: string;
  readonly isError: boolean;
}

type PeopleTab = 'people' | 'invites';

/**
 * Pessoas: quem já entrou, os convites ainda abertos e o convite de uma nova pessoa. O dono decide, ao convidar, o que a
 * pessoa poderá ver e fazer (e muda isso depois, em "Permissões"); o convite sai com a confirmação da passkey. O sistema
 * não envia e-mail: o dono entrega o link, e quem o recebe escolhe a própria senha, que o dono nunca vê. O segredo do
 * link só aparece aqui, uma vez.
 *
 * Só esconde o que o servidor também recusa: toda ação daqui (criar, revogar, mudar permissões) é rota de
 * administrador e a API a confere.
 */
@Component({
  selector: 'app-guests-section',
  imports: [
    NgTemplateOutlet,
    PeoplePermissionPicker,
    PeoplePermissionsSheet,
    SettingsGlyph,
    LoadingSkeleton,
    SessionsSection,
  ],
  templateUrl: './guests-section.html',
  styleUrl: './guests-section.css',
})
export class GuestsSection {
  private readonly auth = inject(AuthService);
  private readonly api = inject(AuthApi);
  private readonly people = inject(PeopleApi);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);
  private readonly registry = inject(ModuleRegistry);
  private readonly injector = inject(Injector);

  private readonly nameInput = viewChild<ElementRef<HTMLInputElement>>('nameInput');
  private readonly inviteButton = viewChild<ElementRef<HTMLButtonElement>>('inviteButton');
  private readonly linkBox = viewChild<ElementRef<HTMLElement>>('linkBox');
  /** Quem abriu a folha de permissões: o foco volta para o botão quando ela fecha. */
  private sheetOpener: HTMLElement | null = null;

  protected readonly maxName = MAX_NAME;
  protected readonly invites = signal<readonly GuestInviteSummary[] | null>(null);
  protected readonly guests = signal<readonly GuestSummary[] | null>(null);
  /** O uso de cada conta, por id. Falhar em lê-lo nunca atrapalha a lista de pessoas. */
  protected readonly usage = signal<ReadonlyMap<string, PersonUsage>>(new Map());
  protected readonly loadFailed = signal(false);
  protected readonly busy = signal(false);
  /** Avisos de cada lugar, perto de onde a pessoa acabou de agir: a lista (no alto), o formulário e o link. */
  protected readonly listNote = signal<Note | null>(null);
  protected readonly formNote = signal<Note | null>(null);
  protected readonly linkNote = signal<Note | null>(null);

  protected readonly inviteOpen = signal(false);
  /** Pessoas e convites dividem a mesma tela para manter a ação perto de quem a receberá. */
  protected readonly activeTab = signal<PeopleTab>('people');
  protected readonly newName = signal('');
  /** O que o convite novo concede: começa no modelo "só controlar a TV" (o mínimo que o dono já entregava). */
  protected readonly permissions = signal<readonly string[]>([...TV_CONTROL_ONLY]);
  protected readonly permissionsOpen = signal(false);
  protected readonly created = signal<CreatedLink | null>(null);
  protected readonly editing = signal<GuestSummary | null>(null);
  protected readonly revokingInviteId = signal<string | null>(null);
  protected readonly revokingGuestId = signal<string | null>(null);
  protected readonly openedSessionGuestId = signal<string | null>(null);

  protected readonly pending = computed(() =>
    (this.invites() ?? []).filter((invite) => invite.status === 'pending'),
  );
  /** Quem tem acesso primeiro; quem foi revogado vai para o fim, sem mexer na ordem do resto. */
  protected readonly sortedGuests = computed(() =>
    [...(this.guests() ?? [])].sort(
      (a, b) => Number(a.disabledAt !== null) - Number(b.disabledAt !== null),
    ),
  );
  protected readonly permissionsValid = computed(() => hasModule(this.permissions()));
  protected readonly permissionsText = computed(() => permissionSummary(this.permissions()));
  protected readonly canCreate = computed(
    () => !this.busy() && this.newName().trim().length > 0 && this.permissionsValid(),
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

  protected summary(permissions: readonly string[]): string {
    return permissionSummary(permissions);
  }

  protected expires(invite: GuestInviteSummary): string {
    return $localize`:@@settings.guests.invite-expires:Vale até ${this.dateFormat.format(new Date(invite.expiresAt))}:date:`;
  }

  protected linkExpires(link: CreatedLink): string {
    return $localize`:@@settings.guests.link-expires:O link vale até ${this.dateFormat.format(new Date(link.expiresAt))}:date:, serve uma vez só e aparece apenas agora.`;
  }

  protected revokeInviteLabel(invite: GuestInviteSummary): string {
    return $localize`:@@settings.guests.revoke-invite-label:Revogar o convite de ${invite.displayName}:name:`;
  }

  protected revokeGuestLabel(guest: GuestSummary): string {
    return $localize`:@@settings.guests.revoke-guest-label:Revogar acesso de ${guest.displayName}:name:`;
  }

  protected permissionsLabel(guest: GuestSummary): string {
    return $localize`:@@settings.guests.permissions-label:Permissões de ${guest.displayName}:name:`;
  }

  protected revokeGuestQuestion(guest: GuestSummary): string {
    return $localize`:@@settings.guests.revoke-guest-question:Revogar o acesso de ${guest.displayName}:name:? A pessoa deixa de ter acesso em poucos minutos.`;
  }

  protected value(event: Event): string {
    return (event.target as HTMLInputElement).value;
  }

  protected openInvite(): void {
    this.activeTab.set('invites');
    this.listNote.set(null);
    this.formNote.set(null);
    this.inviteOpen.set(true);
    this.focusLater(() => this.nameInput()?.nativeElement);
  }

  protected cancelInvite(): void {
    this.resetInvite();
    this.focusLater(() => this.inviteButton()?.nativeElement);
  }

  protected async create(event: Event): Promise<void> {
    event.preventDefault();
    const name = this.newName().trim();
    if (!this.canCreate()) return;
    this.busy.set(true);
    this.formNote.set(null);
    try {
      // Sem a confirmação recente com a passkey a API recusa (403) e o interceptador abre o diálogo e repete.
      const invite = await this.people.createInvite(name, this.permissions());
      this.created.set({
        name: invite.displayName,
        url: `${this.origin()}/convite#${invite.token}`,
        expiresAt: invite.expiresAt,
        permissions: invite.permissions,
      });
      this.linkNote.set(null);
      this.resetInvite();
      this.focusLater(() => this.linkBox()?.nativeElement);
      await this.load();
    } catch (error) {
      this.formNote.set({ text: this.createError(error), isError: true });
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
      this.linkNote.set({
        text: $localize`:@@settings.guests.copied:Link copiado.`,
        isError: false,
      });
    } catch {
      this.linkNote.set({
        text: $localize`:@@settings.guests.copy-failed:Não deu para copiar sozinho: toque no link, selecione e copie.`,
        isError: true,
      });
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
    this.linkNote.set(null);
    this.focusLater(() => this.inviteButton()?.nativeElement);
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

  protected pauseGuestLabel(guest: GuestSummary): string {
    return $localize`:@@settings.guests.pause-label:Pausar o acesso de ${guest.displayName}:name:`;
  }

  protected resumeGuestLabel(guest: GuestSummary): string {
    return $localize`:@@settings.guests.resume-label:Retomar o acesso de ${guest.displayName}:name:`;
  }

  /** Pausa ou retoma: a conta e as permissões ficam como estão, só o acesso para enquanto durar. */
  protected async togglePause(guest: GuestSummary): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const pausing = !guest.pausedAt;
    try {
      await this.auth.authorized((token) =>
        pausing ? this.api.pauseGuest(token, guest.id) : this.api.resumeGuest(token, guest.id),
      );
      await this.load();
      this.say(
        pausing
          ? $localize`:@@settings.guests.paused:Acesso pausado.`
          : $localize`:@@settings.guests.resumed:Acesso retomado.`,
        false,
      );
    } catch {
      this.say($localize`:@@settings.guests.pause-failed:Não foi possível mudar agora.`, true);
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

  /** Abre a folha de permissões; ao fechar, o foco volta para o botão que a abriu. */
  protected editPermissions(guest: GuestSummary, event: Event): void {
    this.sheetOpener = event.currentTarget instanceof HTMLElement ? event.currentTarget : null;
    this.revokingGuestId.set(null);
    this.listNote.set(null);
    this.editing.set(guest);
  }

  protected closeSheet(): void {
    this.editing.set(null);
    const opener = this.sheetOpener;
    this.sheetOpener = null;
    // Só depois de a folha sair do DOM: enquanto ela está lá, a página é inerte e o foco não entra.
    afterNextRender(() => (opener?.isConnected ? opener.focus() : undefined), {
      injector: this.injector,
    });
  }

  /** Salvou: a linha já mostra o que a API devolveu, sem esperar outra leitura da lista. */
  protected onPermissionsSaved(updated: GuestPermissions): void {
    this.guests.update((list) =>
      (list ?? []).map((guest) => (guest.id === updated.id ? { ...guest, ...updated } : guest)),
    );
    this.closeSheet();
    this.say(
      $localize`:@@settings.guests.permissions-saved:Permissões de ${updated.displayName}:name: salvas. A mudança pode levar até 30 segundos para valer.`,
      false,
    );
  }

  /** A pessoa já não pode ser editada (saiu ou foi revogada em outro lugar): a lista aqui está velha. */
  protected onPermissionsOutdated(): void {
    void this.load();
  }

  private resetInvite(): void {
    this.inviteOpen.set(false);
    this.permissionsOpen.set(false);
    this.newName.set('');
    this.permissions.set([...TV_CONTROL_ONLY]);
    this.formNote.set(null);
  }

  private focusLater(target: () => HTMLElement | undefined): void {
    afterNextRender(() => target()?.focus(), { injector: this.injector });
  }

  private origin(): string {
    return this.doc.defaultView?.location.origin ?? '';
  }

  protected async load(): Promise<void> {
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
      return;
    }
    try {
      const rows = await this.people.usage();
      this.usage.set(new Map(rows.map((row) => [row.id, row])));
    } catch {
      this.usage.set(new Map());
    }
  }

  /** O próprio administrador: a primeira conta do mapa com esse papel. */
  protected readonly ownerUsage = computed(() => {
    for (const row of this.usage().values()) if (row.role === 'owner') return row;
    return null;
  });

  /**
   * A Início da pessoa em poucas palavras: os módulos que ela deixou ligados, "Padrão" se nunca personalizou e "Sem dados
   * ainda" se nunca abriu o app depois de a sincronização existir. O convidado só tem o que as permissões dele liberam.
   */
  protected homeLine(row: PersonUsage): string {
    if (row.home.state === 'unknown')
      return $localize`:@@settings.usage.home-unknown:Sem dados ainda`;
    if (row.home.state === 'default') return $localize`:@@settings.usage.home-default:Padrão`;
    const role = row.role === 'guest' ? 'guest' : 'owner';
    const permissions =
      (this.guests() ?? []).find((guest) => guest.id === row.id)?.permissions ?? null;
    const titles = homeModuleTitles(row.home, this.registry.modules, role, permissions);
    return titles.length > 0
      ? titles.join(', ')
      : $localize`:@@settings.usage.home-none:Nenhum módulo`;
  }

  protected lastAccess(row: PersonUsage): string {
    if (!row.lastAccessAt) return $localize`:@@settings.usage.never:Nunca entrou`;
    const minutes = Math.max(
      0,
      Math.floor((Date.now() - new Date(row.lastAccessAt).getTime()) / 60_000),
    );
    if (minutes < 1) return $localize`:@@settings.usage.now:Agora`;
    if (minutes < 60) return $localize`:@@settings.usage.minutes:há ${minutes}:count: min`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return $localize`:@@settings.usage.hours:há ${hours}:count: h`;
    const days = Math.floor(hours / 24);
    return $localize`:@@settings.usage.days:há ${days}:count: d`;
  }

  private say(text: string | null, isError = false): void {
    this.listNote.set(text === null ? null : { text, isError });
  }

  private createError(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.kind === 'too-many-invites') {
      return $localize`:@@settings.guests.too-many:Há convites pendentes demais. Revogue algum antes de criar outro.`;
    }
    if (problem?.status === 403) {
      return $localize`:@@settings.guests.unconfirmed:O convite não foi criado: falta a confirmação com a passkey. Cadastre uma passkey em Segurança e tente de novo.`;
    }
    if (problem?.status === 400) {
      return $localize`:@@settings.guests.invalid:O convite não foi criado: confira o nome e o que a pessoa poderá fazer.`;
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
