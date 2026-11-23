import { Component, OnInit, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { stashPendingShare } from './pending-share-storage';

/**
 * Ponto de entrada do Web Share Target do PWA (`/videos/compartilhar`).
 *
 * Recebe os parâmetros de compartilhamento do Android Chrome (`url`, `text`, `title`).
 * Guarda a intenção nesta aba. A rota da caixa cuida do login e da permissão antes de gravar.
 */
@Component({
  selector: 'app-share-target-page',
  template: `
    <div class="share-landing" role="status" [attr.data-screen-ready]="'videos'">
      <div class="spinner" aria-hidden="true"></div>
      <p i18n="@@videos.share.saving">Salvando link compartilhado…</p>
    </div>
  `,
  styles: `
    :host {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100dvh;
      background-color: var(--a-bg);
      color: var(--a-ink);
    }
    .share-landing {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-4);
      padding: var(--space-6);
      text-align: center;
    }
    .spinner {
      width: 32px;
      height: 32px;
      border: 3px solid var(--a-line);
      border-top-color: var(--a-accent);
      border-radius: var(--radius-pill);
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    p {
      font-size: var(--fs-body);
      color: var(--a-ink2);
      margin: 0;
    }
  `,
})
export class ShareTargetPage implements OnInit {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);

  async ngOnInit(): Promise<void> {
    const query = this.route.snapshot.queryParamMap;
    const url = query.get('url');
    const text = query.get('text');
    const title = query.get('title');
    if (url?.trim() || text?.trim() || title?.trim()) stashPendingShare({ url, text, title });
    await this.router.navigateByUrl('/videos', { replaceUrl: true });
  }
}
