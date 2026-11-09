import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { PcStore } from '../data/pc-store';
import { tick } from '../input/haptics';

/**
 * "Abrir no PC": os favoritos que o próprio PC deixa abrir, em grade (a lista vem do PC; o caminho do programa nunca chega
 * aqui, só o nome). Sem nenhum favorito a seção nem aparece. Cada um mostra a inicial do nome num selo e o nome inteiro (até
 * duas linhas); um que falha diz por que, em uma linha, logo abaixo.
 */
@Component({
  selector: 'app-pc-favorites',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.apps().length > 0) {
      <h2 class="section" i18n="@@pc.apps.title">Abrir no PC</h2>
      <ul class="apps">
        @for (app of store.apps(); track app.id) {
          <li>
            <button
              type="button"
              class="app"
              [attr.data-app]="app.id"
              [disabled]="!store.canSend() || launching() === app.id"
              (click)="launch(app.id)"
            >
              <span class="badge" aria-hidden="true">{{ initial(app.label) }}</span>
              <span class="name">{{ app.label }}</span>
            </button>
          </li>
        }
      </ul>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
    }
  `,
  styleUrl: './favorites.css',
})
export class PcFavorites {
  protected readonly store = inject(PcStore);
  protected readonly launching = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  /** A primeira letra do nome, maiúscula (o selo; um nome sem letra mostra um ponto). */
  protected initial(label: string): string {
    const first = [...label.trim()][0];
    return first ? first.toLocaleUpperCase() : '•';
  }

  protected async launch(id: string): Promise<void> {
    if (this.launching()) return;
    this.launching.set(id);
    this.error.set(null);
    tick();
    const failure = await this.store.launch(id);
    this.launching.set(null);
    if (failure) this.error.set(failure.message);
  }
}
