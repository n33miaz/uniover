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
