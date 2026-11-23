import { Component, OnInit, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { VideoInboxService } from './video-inbox.service';
import {
  type VideoInboxItem,
  type VideoPlatform,
  platformLabel,
  statusLabel,
  viaLabel,
} from './video-inbox.model';

@Component({
  selector: 'app-video-inbox-page',
  template: `
    <div class="inbox-container" [attr.data-screen-ready]="'videos'">
      @if (feedback(); as message) {
        <div class="notice" role="status">
          {{ message }}
        </div>
      }

      <section class="add-section" aria-labelledby="add-heading">
        <h2 id="add-heading" class="section-title" i18n="@@videos.inbox.add.title">
          Adicionar link
        </h2>
        <form class="add-form" (submit)="$event.preventDefault(); addManual()">
          <input
            type="text"
            class="add-input"
            [value]="inputUrl()"
            (input)="onInput($event)"
            placeholder="Cole um link ou texto com vídeo…"
            i18n-placeholder="@@videos.inbox.add.placeholder"
            [disabled]="adding()"
            aria-label="Link do vídeo"
            i18n-aria-label="@@videos.inbox.add.aria-label"
          />
          <button
            type="submit"
            class="add-btn"
            [disabled]="adding() || !inputUrl().trim()"
            i18n="@@videos.inbox.add.button"
          >
            Salvar
          </button>
        </form>
      </section>

      <section class="list-section" aria-labelledby="list-heading">
        <div class="list-header">
          <h2 id="list-heading" class="section-title" i18n="@@videos.inbox.list.title">
            Links capturados
          </h2>
          <span class="count-badge" [attr.aria-label]="getItemsCountLabel(items().length)">
            {{ items().length }}
          </span>
        </div>

        @if (loading()) {
          <div class="loading-state" role="status" i18n="@@videos.inbox.loading">
            Carregando links salvos…
          </div>
        } @else if (items().length === 0) {
          <div class="empty-state">
            <p class="empty-title" i18n="@@videos.inbox.empty.title">Nenhum link na caixa ainda</p>
            <p class="empty-desc" i18n="@@videos.inbox.empty.description">
              Compartilhe links do Instagram, YouTube, TikTok ou X pelo menu de compartilhamento do
              Android para salvá-los aqui.
            </p>
          </div>
        } @else {
          <ul class="items-list" role="list">
            @for (item of items(); track item.id) {
              <li class="item-card" role="listitem">
                <div class="item-top">
                  <span class="platform-chip" [attr.data-platform]="item.platform">
                    {{ getPlatformLabel(item.platform) }}
                  </span>
                  <time class="item-date" [attr.datetime]="item.captured_at">
                    {{ formatCapturedDate(item.captured_at) }}
                  </time>
                </div>

                @if (item.title) {
                  <h3 class="item-title">{{ item.title }}</h3>
                }

                <div class="item-url-row">
                  <a
                    [href]="item.canonical_url"
                    target="_blank"
                    [attr.rel]="'noopener noreferrer'"
                    class="item-url"
                    [title]="item.canonical_url"
                  >
                    {{ item.canonical_url }}
                  </a>
                </div>

                @if (item.raw_text && item.raw_text !== item.canonical_url) {
                  <blockquote class="item-raw-text">
                    {{ item.raw_text }}
                  </blockquote>
                }

                <div class="item-meta">
                  <span class="meta-tag status-tag">
                    {{ getStatusLabel(item.status) }}
                  </span>
                  <span class="meta-tag via-tag">
                    {{ getViaLabel(item.captured_via) }}
                  </span>
                </div>

                <div class="item-actions">
                  <a
                    [href]="item.canonical_url"
                    target="_blank"
                    [attr.rel]="'noopener noreferrer'"
                    class="btn-action btn-open"
                    i18n="@@videos.inbox.action.open"
                  >
                    Abrir
                  </a>
                  <button
                    type="button"
                    class="btn-action btn-copy"
                    (click)="copyLink(item)"
                    [attr.aria-label]="getCopyAriaLabel(item.canonical_url)"
                  >
                    @if (copiedId() === item.id) {
                      <span i18n="@@videos.inbox.action.copied">Copiado!</span>
                    } @else {
                      <span i18n="@@videos.inbox.action.copy">Copiar link</span>
                    }
                  </button>
                  <button
                    type="button"
                    class="btn-action btn-delete"
                    (click)="deleteItem(item.id)"
                    [attr.aria-label]="getDeleteAriaLabel(item.canonical_url)"
                    i18n="@@videos.inbox.action.delete"
                  >
                    Excluir
                  </button>
                </div>
              </li>
            }
          </ul>
        }
      </section>
    </div>
  `,
  styles: `
    .inbox-container {
      display: flex;
      flex-direction: column;
      gap: var(--space-5);
      max-width: var(--col-read);
      margin: 0 auto;
      padding: var(--space-4);
    }

    .notice {
      padding: var(--space-3) var(--space-4);
      background: var(--a-accent-soft);
      color: var(--a-accent);
      border-radius: var(--radius-sm);
      font-size: var(--fs-small);
      font-weight: 500;
    }

    .section-title {
      font-size: var(--fs-title);
      font-weight: 600;
      color: var(--a-ink);
      margin: 0 0 var(--space-3);
    }

    .add-section,
    .item-card {
      background: var(--a-surface);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
      padding: var(--space-4);
    }

    .add-form,
    .list-header,
    .item-top,
    .item-meta,
    .item-actions {
      display: flex;
      gap: var(--space-2);
    }

    .list-header {
      align-items: center;
      justify-content: space-between;
      margin-bottom: var(--space-3);
    }

    .add-input {
      flex: 1 1 auto;
      min-width: 0;
      min-height: var(--tap);
      padding: 0 var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-xs);
      background: var(--a-bg);
      color: var(--a-ink);
      font: inherit;
      font-size: var(--fs-body);
    }

    .add-input:focus-visible {
      outline: 2px solid var(--a-accent);
      outline-offset: 1px;
    }

    .add-btn {
      flex: none;
      min-height: var(--tap);
      padding: 0 var(--space-4);
      background: var(--a-accent);
      color: var(--a-on-accent);
      border: 0;
      border-radius: var(--radius-xs);
      font: inherit;
      font-weight: 600;
      font-size: var(--fs-small);
      cursor: pointer;
    }

    .add-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .count-badge,
    .meta-tag,
    .platform-chip {
      display: inline-flex;
      align-items: center;
      font-size: var(--fs-label);
      border-radius: var(--radius-pill);
    }

    .count-badge {
      justify-content: center;
      min-width: 24px;
      height: 24px;
      padding: 0 var(--space-2);
      background: var(--a-elev);
      color: var(--a-ink2);
      font-weight: 600;
    }

    .loading-state,
    .empty-state {
      text-align: center;
    }

    .loading-state {
      padding: var(--space-6);
      color: var(--a-ink3);
      font-size: var(--fs-small);
    }

    .empty-state {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
      padding: var(--space-8) var(--space-4);
      background: var(--a-surface);
      border: 1px dashed var(--a-line);
      border-radius: var(--radius-sm);
    }

    .empty-title,
    .item-title {
      font-size: var(--fs-body);
      font-weight: 600;
      color: var(--a-ink);
      margin: 0;
    }

    .empty-desc {
      font-size: var(--fs-small);
      color: var(--a-ink2);
      max-width: 24rem;
      margin: 0;
    }

    .items-list {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      list-style: none;
      padding: 0;
      margin: 0;
    }

    .item-card {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }

    .item-top {
      align-items: center;
      justify-content: space-between;
    }

    .platform-chip {
      padding: 2px var(--space-2);
      border-radius: var(--radius-xs);
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      background: var(--a-elev);
      color: var(--a-ink);
    }

    .platform-chip[data-platform='instagram'] {
      background: #fce8ee;
      color: #c13584;
    }
    .platform-chip[data-platform='youtube'] {
      background: #feebe8;
      color: #c00;
    }
    .platform-chip[data-platform='tiktok'] {
      background: #e5f7f9;
      color: #007a87;
    }
    .platform-chip[data-platform='twitter'] {
      background: #e6f3fa;
      color: #1a6d9e;
    }

    .item-date {
      font-size: var(--fs-label);
      color: var(--a-ink3);
    }

    .item-url-row {
      word-break: break-all;
    }

    .item-url {
      font-size: var(--fs-small);
      font-weight: 500;
      color: var(--a-accent);
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .item-raw-text {
      margin: var(--space-1) 0;
      padding: var(--space-2) var(--space-3);
      background: var(--a-bg);
      border-left: 3px solid var(--a-line);
      border-radius: 0 var(--radius-xs) var(--radius-xs) 0;
      font-size: var(--fs-small);
      color: var(--a-ink2);
      white-space: pre-wrap;
      word-break: break-word;
    }

    .item-meta {
      flex-wrap: wrap;
    }

    .meta-tag {
      padding: 2px var(--space-2);
      background: var(--a-elev);
      color: var(--a-ink2);
    }

    .item-actions {
      margin-top: var(--space-2);
      padding-top: var(--space-2);
      border-top: 1px solid var(--a-line);
    }

    .btn-action {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 36px;
      padding: 0 var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-xs);
      background: var(--a-bg);
      color: var(--a-ink);
      font: inherit;
      font-size: var(--fs-small);
      font-weight: 500;
      text-decoration: none;
      cursor: pointer;
    }

    .btn-action:hover {
      background: var(--a-elev);
    }

    .btn-delete {
      color: var(--a-bad);
      border-color: var(--a-bad);
    }

    .btn-delete:hover {
      background: var(--a-bad-soft);
    }
  `,
})
export class VideoInboxPage implements OnInit {
  private readonly inboxService = inject(VideoInboxService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  protected readonly items = signal<VideoInboxItem[]>([]);
  protected readonly loading = signal(true);
  protected readonly feedback = signal<string | null>(null);
  protected readonly inputUrl = signal('');
  protected readonly adding = signal(false);
  protected readonly copiedId = signal<string | null>(null);

  async ngOnInit(): Promise<void> {
    try {
      await this.processIncomingOrPending();
    } catch {
      this.showFeedback(
        $localize`:@@videos.inbox.save-error:Não foi possível salvar o link. Tente novamente.`,
      );
    }
    await this.loadItems();
  }

  private async processIncomingOrPending(): Promise<void> {
    // 1. Processa compartilhamento pendente (ex: vindo antes do login)
    const pendingItem = await this.inboxService.processPendingShare();
    if (pendingItem) {
      this.showFeedback($localize`:@@videos.inbox.feedback.saved:Link salvo com sucesso!`);
    }

    // 2. Se a rota atual tiver parâmetros de compartilhamento diretos
    const query = this.route.snapshot.queryParamMap;
    const url = query.get('url');
    const text = query.get('text');
    const title = query.get('title');

    if (
      (url && url.trim().length > 0) ||
      (text && text.trim().length > 0) ||
      (title && title.trim().length > 0)
    ) {
      const captured = await this.inboxService.captureShare({ url, text, title });
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
    this.loading.set(true);
    try {
      const list = await this.inboxService.list();
      this.items.set(list);
    } catch {
      this.showFeedback(
        $localize`:@@videos.inbox.load-error:Não foi possível carregar os links salvos.`,
      );
    } finally {
      this.loading.set(false);
    }
  }

  protected async addManual(): Promise<void> {
    const raw = this.inputUrl().trim();
    if (!raw) return;

    this.adding.set(true);
    try {
      const item = await this.inboxService.captureShare({ text: raw }, 'manual');
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
      this.showFeedback(
        $localize`:@@videos.inbox.save-error:Não foi possível salvar o link. Tente novamente.`,
      );
    } finally {
      this.adding.set(false);
    }
  }

  protected onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    this.inputUrl.set(target.value);
  }

  protected async deleteItem(id: string): Promise<void> {
    try {
      await this.inboxService.delete(id);
    } catch {
      this.showFeedback($localize`:@@videos.inbox.delete-error:Não foi possível excluir o link.`);
      return;
    }
    this.items.update((prev) => prev.filter((item) => item.id !== id));
    this.showFeedback($localize`:@@videos.inbox.feedback.deleted:Link removido da caixa.`);
  }

  protected async copyLink(item: VideoInboxItem): Promise<void> {
    try {
      await navigator.clipboard.writeText(item.canonical_url);
      this.copiedId.set(item.id);
      setTimeout(() => {
        if (this.copiedId() === item.id) {
          this.copiedId.set(null);
        }
      }, 2000);
    } catch {
      this.showFeedback(
        $localize`:@@videos.inbox.feedback.copy-error:Não foi possível copiar o link.`,
      );
    }
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
        d.toLocaleDateString('pt-BR', {
          day: '2-digit',
          month: '2-digit',
          year: 'numeric',
        }) +
        ' ' +
        d.toLocaleTimeString('pt-BR', {
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    } catch {
      return iso;
    }
  }

  private showFeedback(message: string): void {
    this.feedback.set(message);
    setTimeout(() => {
      if (this.feedback() === message) {
        this.feedback.set(null);
      }
    }, 3500);
  }
}
