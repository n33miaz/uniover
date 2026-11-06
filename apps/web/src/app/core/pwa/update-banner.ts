import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
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
              @if (pwa.navigationBlocked()) {
                <span i18n="@@pwa.update-blocked"
                  >Há uma versão nova: salve ou descarte para continuar</span
                >
              } @else {
                <span i18n="@@pwa.update-available">Nova versão disponível</span>
              }
              <button
                type="button"
                class="action ui-tap"
                [disabled]="pwa.applyingUpdate() || pwa.updateDeciding()"
                (click)="pwa.applyUpdate()"
              >
                @if (pwa.applyingUpdate() || pwa.updateDeciding()) {
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
    @if (pwa.confirmingUpdate(); as kind) {
      <div class="scrim">
        <div
          #dialog
          class="dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby="update-confirm-title"
          aria-describedby="update-confirm-text"
          tabindex="-1"
          (keydown)="onKeydown($event)"
        >
          <h2 id="update-confirm-title" i18n="@@pwa.update-confirm-title">Atualizar agora?</h2>
          @if (kind === 'other-tab') {
            <p id="update-confirm-text" i18n="@@pwa.update-confirm-other-tab">
              Outra aba aberta tem algo não salvo. Ao atualizar, ela vai precisar salvar e
              recarregar.
            </p>
          } @else {
            <p id="update-confirm-text" i18n="@@pwa.update-confirm-text">
              Há algo não salvo nesta tela. Atualizar recarrega a página e perde esse trabalho.
            </p>
          }
          <div class="choices">
            <button #keep type="button" class="keep ui-tap" (click)="pwa.cancelUpdate()">
              <span i18n="@@pwa.update-confirm-keep">Continuar editando</span>
            </button>
            <button type="button" class="action ui-tap" (click)="pwa.confirmUpdate()">
              <span i18n="@@pwa.update-confirm-go">Atualizar mesmo assim</span>
            </button>
          </div>
        </div>
      </div>
    }
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
  private readonly doc = inject(DOCUMENT);
  private readonly injector = inject(Injector);
  private readonly dialog = viewChild<ElementRef<HTMLElement>>('dialog');
  private readonly keep = viewChild<ElementRef<HTMLButtonElement>>('keep');
  /** Quem tinha o foco quando o diálogo abriu, para devolver o foco ao fechar. */
  private previousFocus: HTMLElement | null = null;

  constructor() {
    effect(() => {
      const open = this.pwa.confirmingUpdate() !== null;
      untracked(() => (open ? this.onOpen() : this.onClose()));
    });
  }

  /** O foco vai para "Continuar editando" (a escolha segura) assim que o diálogo aparece. */
  private onOpen(): void {
    if (this.previousFocus === null)
      this.previousFocus = this.doc.activeElement as HTMLElement | null;
    afterNextRender(() => this.keep()?.nativeElement.focus(), { injector: this.injector });
  }

  private onClose(): void {
    const back = this.previousFocus;
    this.previousFocus = null;
    if (back?.isConnected) back.focus();
  }

  /** Escape fecha; Tab e Shift+Tab ficam dentro do diálogo (`aria-modal` sozinho não prende o foco). */
  protected onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.pwa.cancelUpdate();
      return;
    }
    if (event.key !== 'Tab') return;
    const buttons = Array.from(this.dialog()?.nativeElement.querySelectorAll('button') ?? []);
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const active = this.doc.activeElement;
    if (event.shiftKey && (active === first || !buttons.includes(active as HTMLButtonElement))) {
      event.preventDefault();
      last.focus();
    } else if (
      !event.shiftKey &&
      (active === last || !buttons.includes(active as HTMLButtonElement))
    ) {
      event.preventDefault();
      first.focus();
    }
  }
}
