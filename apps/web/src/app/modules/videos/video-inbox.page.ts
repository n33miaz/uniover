import {
  Component,
  LOCALE_ID,
  OnInit,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { SessionState } from '../../core/session/session-state';
import { clearPendingShare, interruptedShareId } from './pending-share-storage';
import { VideoInboxService } from './video-inbox.service';
import { isHttpUrl } from './video-url-normalizer';
import {
  type VideoInboxItem,
  type VideoPlatform,
  canAccessVideoInbox,
  platformLabel,
  statusLabel,
  viaLabel,
} from './video-inbox.model';

@Component({
  selector: 'app-video-inbox-page',
  templateUrl: './video-inbox.page.html',
  styleUrl: './video-inbox.page.css',
})
export class VideoInboxPage implements OnInit {
  private readonly inboxService = inject(VideoInboxService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly session = inject(SessionState);
  private readonly locale = inject(LOCALE_ID, { optional: true }) ?? 'pt-BR';
  protected readonly activeAccountId = computed(() =>
    canAccessVideoInbox(this.session.role(), this.session.knownPermissions())
      ? this.session.accountId()
      : null,
  );

  protected readonly items = signal<VideoInboxItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly feedback = signal<string | null>(null);
  protected readonly inputUrl = signal('');
  protected readonly adding = signal(false);
  protected readonly copiedId = signal<string | null>(null);

  constructor() {
    let previousAccount = this.activeAccountId();
    effect(() => {
      const accountId = this.activeAccountId();
      if (accountId === previousAccount) return;
      previousAccount = accountId;
      this.items.set([]);
      this.feedback.set(null);
      this.copiedId.set(null);
      this.inputUrl.set('');
      this.adding.set(false);
      if (accountId) untracked(() => void this.loadItems());
      else this.loading.set(false);
    });
  }

  async ngOnInit(): Promise<void> {
    const accountId = this.activeAccountId();
    if (!accountId) {
      this.loading.set(false);
      return;
    }
    try {
      await this.processIncomingOrPending(accountId);
    } catch {
      if (this.activeAccountId() !== accountId) return;
      this.showFeedback(
        $localize`:@@videos.inbox.save-error:Não foi possível salvar o link. Tente novamente.`,
      );
    }
    if (this.activeAccountId() === accountId) await this.loadItems();
  }

  private async processIncomingOrPending(accountId: string): Promise<void> {
    const query = this.route.snapshot.queryParamMap;
    const share = query.get('share');
    const url = query.get('url');
    const text = query.get('text');
    const title = query.get('title');

    // Sem `share` na URL, retoma o compartilhamento que o guard desviou nesta aba.
    const interrupted = share ? null : interruptedShareId(accountId);
    if (interrupted) {
      const resumed = await this.inboxService.processPendingShare(interrupted);
      if (this.activeAccountId() !== accountId) return;
      if (resumed) {
        this.showFeedback($localize`:@@videos.inbox.feedback.saved:Link salvo com sucesso!`);
      } else {
        // O registro já não existe: descarta também a marca que apontava para ele.
        clearPendingShare(interrupted);
      }
    }

    if (
      share ||
      (url && url.trim().length > 0) ||
      (text && text.trim().length > 0) ||
      (title && title.trim().length > 0)
    ) {
      const captured = share
        ? await this.inboxService.processPendingShare(share)
        : await this.inboxService.captureShare({ url, text, title });
      if (this.activeAccountId() !== accountId) return;
      if (captured) {
        this.showFeedback($localize`:@@videos.inbox.feedback.saved:Link salvo com sucesso!`);
      }
      // Limpa a query string para não duplicar se recarregar
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: {},
        replaceUrl: true,
      });
    }
  }

  protected async loadItems(): Promise<void> {
    const accountId = this.activeAccountId();
    if (!accountId) return;
    this.loading.set(true);
    try {
      const list = await this.inboxService.list();
      if (this.activeAccountId() === accountId) this.items.set(list);
    } catch {
      if (this.activeAccountId() !== accountId) return;
      this.showFeedback(
        $localize`:@@videos.inbox.load-error:Não foi possível carregar os links salvos.`,
      );
    } finally {
      if (this.activeAccountId() === accountId) this.loading.set(false);
    }
  }

  protected async addManual(): Promise<void> {
    const accountId = this.activeAccountId();
    const raw = this.inputUrl().trim();
    if (!accountId || !raw) return;

    this.adding.set(true);
    try {
      const item = await this.inboxService.captureShare({ text: raw }, 'manual');
      if (this.activeAccountId() !== accountId) return;
      if (item) {
        this.inputUrl.set('');
        this.showFeedback($localize`:@@videos.inbox.feedback.saved:Link salvo com sucesso!`);
        await this.loadItems();
      } else {
        this.showFeedback(
          $localize`:@@videos.inbox.feedback.invalid:Nenhum link válido encontrado no texto informado.`,
        );
      }
    } catch {
      if (this.activeAccountId() !== accountId) return;
      this.showFeedback(
        $localize`:@@videos.inbox.save-error:Não foi possível salvar o link. Tente novamente.`,
      );
    } finally {
      if (this.activeAccountId() === accountId) this.adding.set(false);
    }
  }

  protected onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.inputUrl.set(target.value);
  }

  protected async deleteItem(id: string): Promise<void> {
    const accountId = this.activeAccountId();
    if (!accountId) return;
    try {
      await this.inboxService.delete(id);
    } catch {
      if (this.activeAccountId() !== accountId) return;
      this.showFeedback($localize`:@@videos.inbox.delete-error:Não foi possível excluir o link.`);
      return;
    }
    if (this.activeAccountId() !== accountId) return;
    this.items.update((prev) => prev.filter((item) => item.id !== id));
    this.showFeedback($localize`:@@videos.inbox.feedback.deleted:Link removido da caixa.`);
  }

  protected async copyLink(item: VideoInboxItem): Promise<void> {
    const accountId = this.activeAccountId();
    if (!accountId || !isHttpUrl(item.canonical_url)) return;
    try {
      await navigator.clipboard.writeText(item.canonical_url);
      if (this.activeAccountId() !== accountId) return;
      this.copiedId.set(item.id);
      setTimeout(() => {
        if (this.activeAccountId() === accountId && this.copiedId() === item.id) {
          this.copiedId.set(null);
        }
      }, 2000);
    } catch {
      if (this.activeAccountId() !== accountId) return;
      this.showFeedback(
        $localize`:@@videos.inbox.feedback.copy-error:Não foi possível copiar o link.`,
      );
    }
  }

  /**
   * Retorna a URL se o protocolo for estritamente http: ou https:, ou null caso contrário.
   * Impede que URLs com esquemas como javascript:, data:, blob: ou file: sejam colocadas em href.
   */
  protected safeHref(url: string): string | null {
    return isHttpUrl(url) ? url : null;
  }

  protected getPlatformLabel(platform: VideoPlatform): string {
    return platformLabel(platform);
  }

  protected getStatusLabel(status: VideoInboxItem['status']): string {
    return statusLabel(status);
  }

  protected getViaLabel(via: VideoInboxItem['captured_via']): string {
    return viaLabel(via);
  }

  protected getItemsCountLabel(count: number): string {
    return $localize`:@@videos.inbox.items-count:${count} itens na caixa`;
  }

  protected getCopyAriaLabel(url: string): string {
    return $localize`:@@videos.inbox.action.copy-aria:Copiar link de ${url}`;
  }

  protected getDeleteAriaLabel(url: string): string {
    return $localize`:@@videos.inbox.action.delete-aria:Excluir link de ${url}`;
  }

  protected formatCapturedDate(iso: string): string {
    try {
      const d = new Date(iso);
      return (
        d.toLocaleDateString(this.locale, {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }) +
        ' ' +
        d.toLocaleTimeString(this.locale, {
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    } catch {
      return iso;
    }
  }

  private showFeedback(message: string): void {
    const accountId = this.activeAccountId();
    this.feedback.set(message);
    setTimeout(() => {
      if (this.activeAccountId() === accountId && this.feedback() === message) {
        this.feedback.set(null);
      }
    }, 3500);
  }
}
