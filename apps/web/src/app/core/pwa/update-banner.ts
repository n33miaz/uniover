import { Component, inject } from '@angular/core';
import { PwaUpdateService } from './pwa-update.service';

/**
 * Aviso de versão nova: o usuário escolhe quando atualizar, para não perder o que está fazendo. A faixa abre e fecha
 * empurrando a tela (ver `ui-collapse` em styles.css), sem salto.
 */
@Component({
  selector: 'app-update-banner',
  template: `
    <div role="status">
      @if (pwa.updateReady()) {
        <div class="ui-collapse" [animate.leave]="'leaving'">
          <div class="ui-collapse-inner">
            <div class="banner">
              <span i18n="@@pwa.update-available">Nova versão disponível</span>
              <button
                type="button"
                class="action ui-tap"
                [disabled]="pwa.applyingUpdate()"
                (click)="pwa.applyUpdate()"
              >
                @if (pwa.applyingUpdate()) {
                  <span i18n="@@pwa.updating">Atualizando…</span>
                } @else {
                  <span i18n="@@pwa.update">Atualizar</span>
                }
              </button>
            </div>
            @if (pwa.updateError()) {
              <p class="error" role="alert" i18n="@@pwa.update-error">
                Não foi possível ativar a nova versão. Tente novamente.
              </p>
            }
          </div>
        </div>
      }
      @if (pwa.confirmingUpdate()) {
        <div class="scrim">
          <div
            class="dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="update-confirm-title"
            aria-describedby="update-confirm-text"
            tabindex="-1"
            (keydown.escape)="pwa.cancelUpdate()"
          >
            <h2 id="update-confirm-title" i18n="@@pwa.update-confirm-title">Atualizar agora?</h2>
            <p id="update-confirm-text" i18n="@@pwa.update-confirm-text">
              Há algo não salvo nesta tela. Atualizar recarrega a página e perde esse trabalho.
            </p>
            <div class="choices">
              <button type="button" class="keep ui-tap" (click)="pwa.cancelUpdate()">
                <span i18n="@@pwa.update-confirm-keep">Continuar editando</span>
              </button>
              <button type="button" class="action ui-tap" (click)="pwa.confirmUpdate()">
                <span i18n="@@pwa.update-confirm-go">Atualizar mesmo assim</span>
              </button>
            </div>
          </div>
        </div>
      }
    </div>
  `,
  styles: `
    .banner {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 8px var(--gutter);
      background: var(--a-accent-soft);
      color: var(--a-ink);
      border-bottom: 1px solid var(--a-line);
    }
    .action {
      min-height: 44px;
      min-width: 44px;
      padding: 0 16px;
      border: 0;
      border-radius: var(--radius);
      background: var(--a-accent);
      color: var(--a-on-accent);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .scrim {
      position: fixed;
      inset: 0;
      z-index: 1000;
      display: grid;
      place-items: center;
      padding: var(--gutter);
      background: color-mix(in srgb, var(--a-ink) 45%, transparent);
    }
    .dialog {
      max-width: 22rem;
      padding: 20px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
    }
    .dialog h2 {
      margin: 0 0 8px;
      font-size: var(--fs-title);
    }
    .dialog p {
      margin: 0 0 16px;
      font-size: var(--fs-small);
    }
    .choices {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 8px;
    }
    .keep {
      min-height: 44px;
      padding: 0 16px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      font-weight: 600;
      cursor: pointer;
    }
    .error {
      margin: 0;
      padding: 4px var(--gutter) 8px;
      background: var(--a-accent-soft);
      color: var(--a-ink);
      font-size: var(--fs-small);
    }
  `,
})
export class UpdateBanner {
  protected readonly pwa = inject(PwaUpdateService);
}
