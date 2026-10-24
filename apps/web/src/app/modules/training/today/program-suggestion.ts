import { ChangeDetectionStrategy, Component, inject, input, output, signal } from '@angular/core';
import type { RoutineTemplate } from '../data/routines/routine';
import { RoutineRepository } from '../data/routines/routine-repository';
import { isProgramTemplate, programSummary } from '../routines/program-summary';
import { TrainingGlyph } from '../shell/training-glyph';

/**
 * A sugestão do programa da semana: enquanto a conta não tem programa ativo, Hoje oferece os programas disponíveis
 * (nome e um resumo dos dias). Um toque escolhe: as fichas nascem no aparelho e a escolha entra na fila de escrita
 * (funciona sem rede, com a cópia guardada dos modelos). Escolhido, Hoje já abre no treino do dia e esta sugestão some.
 */
@Component({
  selector: 'app-program-suggestion',
  imports: [TrainingGlyph],
  template: `
    @if (loading() || programs().length > 0 || error()) {
      <section class="suggest ui-card" aria-labelledby="program-title">
        <h3 id="program-title" class="title" i18n="@@training.program.title">
          Escolha seu programa
        </h3>
        @if (loading()) {
          <p class="status" role="status">
            <span class="ui-spinner" aria-hidden="true"></span>
            <span i18n="@@training.program.loading">Carregando os programas…</span>
          </p>
        }
        @if (programs().length > 0) {
          <ul class="ui-group ui-plain">
            @for (program of programs(); track program.id) {
              <li>
                <button
                  type="button"
                  class="ui-row"
                  [disabled]="choosing() !== null"
                  [attr.data-program]="program.id"
                  (click)="choose(program)"
                >
                  <span class="ui-tile"><app-training-glyph name="list" /></span>
                  <span class="ui-row-text">
                    <span class="ui-row-title">{{ program.name }}</span>
                    <span class="ui-row-sub">{{ summary(program) }}</span>
                  </span>
                  @if (choosing() === program.id) {
                    <span class="ui-spinner" aria-hidden="true"></span>
                  }
                </button>
              </li>
            }
          </ul>
        }
        @if (error(); as message) {
          <p class="ui-notice bad" role="alert">
            <app-training-glyph name="alert" />
            <span>{{ message }}</span>
          </p>
        }
        @if (dismissible()) {
          <button type="button" class="secondary ui-btn" (click)="dismissed.emit()">
            <span i18n="@@training.program.dismiss">Agora não</span>
          </button>
        }
      </section>
    }
  `,
  styles: `
    .suggest {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      padding: var(--space-4);
    }
    .title {
      margin: 0;
      font-size: var(--fs-title);
      font-weight: 750;
      letter-spacing: -0.01em;
      line-height: 1.2;
    }
    .status {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin: 0;
      color: var(--a-ink2);
    }
    .ui-group {
      margin: 0;
    }
    .ui-row-sub {
      display: -webkit-box;
      -webkit-line-clamp: 3;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    button.ui-row:disabled {
      opacity: 0.6;
      cursor: default;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProgramSuggestion {
  private readonly routines = inject(RoutineRepository);

  /** Quem já tem fichas livres pode dispensar a sugestão; a conta sem nenhuma ficha não. */
  readonly dismissible = input(false);
  readonly dismissed = output<void>();

  protected readonly programs = signal<readonly RoutineTemplate[]>([]);
  protected readonly loading = signal(true);
  protected readonly choosing = signal<string | null>(null);
  protected readonly error = signal('');

  private readonly unavailable = $localize`:@@training.program.unavailable:Não deu para carregar os programas agora. Tente de novo com rede.`;

  constructor() {
    void this.load();
  }

  protected summary(template: RoutineTemplate): string {
    return programSummary(template.routines);
  }

  protected async choose(template: RoutineTemplate): Promise<void> {
    if (this.choosing() !== null) return;
    this.error.set('');
    this.choosing.set(template.id);
    try {
      const result = await this.routines.selectProgram(template.id);
      switch (result.status) {
        case 'saved':
          return;
        case 'no-exercises':
          this.error.set(
            $localize`:@@training.program.no-exercises:Os exercícios ainda não chegaram a este aparelho. Abra a lista de exercícios com rede e tente de novo.`,
          );
          return;
        case 'storage-full':
          this.error.set(
            $localize`:@@training.program.storage:Sem espaço no aparelho para guardar o programa. Libere espaço e tente de novo.`,
          );
          return;
        default:
          this.error.set(this.unavailable);
      }
    } finally {
      this.choosing.set(null);
    }
  }

  private async load(): Promise<void> {
    try {
      this.programs.set((await this.routines.templates()).filter(isProgramTemplate));
    } catch {
      this.error.set(this.unavailable);
    } finally {
      this.loading.set(false);
    }
  }
}
