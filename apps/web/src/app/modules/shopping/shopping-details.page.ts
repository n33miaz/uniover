import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { problemOf } from '../../core/auth/api-problem';
import { QrCode } from '../../core/auth/qr/qr-code';
import { SessionState } from '../../core/session/session-state';
import { ShoppingEconomizeApi, type EconomizeImport } from './shopping-economize-api';
import { ShoppingPeople } from './shopping-people';
import { ShoppingPeopleApi, type CreatedGroupInvite } from './shopping-people-api';
import { ShoppingSession } from './shopping-session';

/** De quanto em quanto tempo o andamento da busca no Economize é consultado, com a tela à vista. */
export const IMPORT_POLL_MS = 2_000;

/** O maior arquivo que a API aceita (2 MB). */
const MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * Detalhes de Compras, como uma configuração do módulo: quem vê e mexe nas suas listas, no Mercado Agora e no histórico
 * (as pessoas do grupo), o convite por link ou QR para alguém entrar e, para o administrador, trazer as compras do
 * Economize. Quem entra pelo convite vê e mexe em tudo do grupo: não há papel por parte (lista, mercado, histórico).
 */
@Component({
  selector: 'app-shopping-details-page',
  imports: [QrCode, RouterLink, ShoppingPeople],
  changeDetection: ChangeDetectionStrategy.OnPush,
  styleUrls: ['./shopping-screen.css', './shopping-details.page.css'],
  templateUrl: './shopping-details.page.html',
})
export class ShoppingDetailsPage {
  private readonly people = inject(ShoppingPeopleApi);
  private readonly economize = inject(ShoppingEconomizeApi);
  private readonly session = inject(ShoppingSession);
  private readonly account = inject(SessionState);

  /** O administrador da instalação (pode criar contas novas e trazer do Economize). */
  protected readonly admin = computed(() => this.account.role() === 'owner');
  /** Quem criou o grupo (só ele convida). */
  protected readonly groupOwner = signal(false);
  protected readonly invite = signal<CreatedGroupInvite | null>(null);
  protected readonly inviteBusy = signal(false);
  protected readonly inviteNotice = signal<string | null>(null);
  protected readonly copied = signal(false);
  protected readonly link = computed(() => {
    const invite = this.invite();
    return invite ? `${location.origin}/compras/convite#${invite.token}` : '';
  });
  protected readonly canShare = typeof navigator !== 'undefined' && 'share' in navigator;

  /** A busca no Economize: escondida depois que a API disser que a integração está desligada. */
  protected readonly economizeOff = signal(false);
  protected readonly importing = signal(false);
  protected readonly importResult = signal<string | null>(null);
  protected readonly importError = signal<string | null>(null);
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private pollWaiting = false;
  private destroyed = false;

  constructor() {
    void this.loadGroup();
    const visible = (): void => {
      if (document.visibilityState === 'visible' && this.pollWaiting) {
        this.pollWaiting = false;
        void this.poll();
      }
    };
    document.addEventListener('visibilitychange', visible);
    inject(DestroyRef).onDestroy(() => {
      this.destroyed = true;
      if (this.pollTimer !== null) clearTimeout(this.pollTimer);
      document.removeEventListener('visibilitychange', visible);
    });
  }

  private async loadGroup(): Promise<void> {
    try {
      this.groupOwner.set((await this.people.group()).isOwner);
    } catch {
      this.groupOwner.set(false);
    }
  }

  protected changed(): void {
    void this.session.store()?.sync();
    void this.loadGroup();
  }

  protected async createInvite(): Promise<void> {
    if (this.inviteBusy()) return;
    this.inviteBusy.set(true);
    this.inviteNotice.set(null);
    this.copied.set(false);
    try {
      this.invite.set(await this.people.createInvite());
    } catch (error) {
      const problem = problemOf(error);
      this.inviteNotice.set(
        problem?.isNetwork
          ? $localize`:@@shopping.people.offline:Sem sinal. Tente de novo quando voltar.`
          : problem?.kind === 'shopping-too-many-invites'
            ? $localize`:@@shopping.invite.too-many:Há convites demais esperando. Cancele algum antes.`
            : $localize`:@@shopping.people.failed:Não deu certo. Tente de novo.`,
      );
    } finally {
      this.inviteBusy.set(false);
    }
  }

  protected async revokeInvite(): Promise<void> {
    const invite = this.invite();
    if (!invite) return;
    try {
      await this.people.revokeInvite(invite.id);
      this.invite.set(null);
    } catch {
      this.inviteNotice.set($localize`:@@shopping.people.failed:Não deu certo. Tente de novo.`);
    }
  }

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.link());
      this.copied.set(true);
    } catch {
      this.copied.set(false);
    }
  }

  protected async share(): Promise<void> {
    try {
      await navigator.share({
        title: $localize`:@@shopping.invite.share-title:Compras no UniOver`,
        url: this.link(),
      });
    } catch {
      // A pessoa fechou a folha de compartilhar: nada a fazer.
    }
  }

  // ---- Economize ----

  protected async startImport(): Promise<void> {
    if (this.importing()) return;
    this.importError.set(null);
    this.importResult.set(null);
    this.importing.set(true);
    try {
      await this.economize.startImport();
      await this.poll();
    } catch (error) {
      this.importing.set(false);
      this.importError.set(this.importFailure(error));
    }
  }

  private async poll(): Promise<void> {
    if (this.destroyed) return;
    try {
      const state = await this.economize.importState();
      if (state.finished || !state.running) {
        this.finishImport(state);
        return;
      }
    } catch (error) {
      this.importing.set(false);
      this.importError.set(this.importFailure(error));
      return;
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      if (document.visibilityState === 'visible') void this.poll();
      else this.pollWaiting = true;
    }, IMPORT_POLL_MS);
  }

  protected async chooseFile(input: HTMLInputElement): Promise<void> {
    const file = input.files?.[0];
    input.value = '';
    if (!file) return;
    this.importError.set(null);
    this.importResult.set(null);
    if (file.size > MAX_FILE_BYTES) {
      this.importError.set($localize`:@@shopping.import.too-big:O arquivo passa de 2 MB.`);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(await file.text());
    } catch {
      this.importError.set(
        $localize`:@@shopping.import.bad-file:Esse arquivo não é a exportação de compras do Economize.`,
      );
      return;
    }
    this.importing.set(true);
    try {
      this.finishImport(await this.economize.importFile(body));
    } catch (error) {
      this.importing.set(false);
      this.importError.set(this.importFailure(error));
    }
  }

  private finishImport(state: EconomizeImport): void {
    this.importing.set(false);
    if (state.error === 'disabled') {
      this.economizeOff.set(true);
      return;
    }
    if (state.error) {
      this.importError.set(this.stateFailure(state.error));
      return;
    }
    this.importResult.set(
      $localize`:@@shopping.import.done:${state.imported}:imported: compras trazidas, ${state.existing}:existing: já existiam.`,
    );
    void this.session.store()?.sync();
  }

  private stateFailure(error: NonNullable<EconomizeImport['error']>): string {
    switch (error) {
      case 'membership_changed':
        return $localize`:@@shopping.import.membership:Você não está mais neste grupo. Abra Compras de novo.`;
      case 'unauthorized':
        return $localize`:@@shopping.import.unauthorized:O Economize recusou o acesso. Confira a chave no servidor.`;
      default:
        return $localize`:@@shopping.import.unavailable:O Economize não respondeu. Tente mais tarde.`;
    }
  }

  private importFailure(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.isNetwork)
      return $localize`:@@shopping.people.offline:Sem sinal. Tente de novo quando voltar.`;
    switch (problem?.status) {
      case 400:
        return $localize`:@@shopping.import.bad-format:O arquivo está fora do formato ou tem mais de 500 compras.`;
      case 413:
        return $localize`:@@shopping.import.too-big:O arquivo passa de 2 MB.`;
      case 409:
        return $localize`:@@shopping.import.membership:Você não está mais neste grupo. Abra Compras de novo.`;
      default:
        return $localize`:@@shopping.people.failed:Não deu certo. Tente de novo.`;
    }
  }
}
