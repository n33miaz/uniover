import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { RoutineTemplate } from '../data/routines/routine';
import {
  HISTORICAL_REJECTED_TEMPLATE_ID,
  RoutineRepository,
} from '../data/routines/routine-repository';
import { daysText, programSummary } from './program-summary';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';
import { TrainingRowsSkeleton } from '../shell/training-rows-skeleton';

/** O que a folha avisa à lista quando cria as rotinas de um modelo. */
export interface TemplateCreated {
  readonly name: string;
  readonly count: number;
  /** Quantos exercícios do modelo não existem no catálogo deste aparelho e ficaram de fora. */
  readonly missing: number;
  /** Os modelos parciais conhecidos são criados inativos, fora da sequência, até revisão manual. */
  readonly draft: boolean;
  /** Este modelo fica inativo e identificado como histórico, sem convite para ativá-lo. */
  readonly historical: boolean;
  /** Virou o programa da semana: as fichas estão ativas e a tela Hoje segue o dia da semana. */
  readonly program: boolean;
}

/**
 * Folha para comparar modelos: a pessoa vê as rotinas e os dias antes de escolher. O modelo é o ponto de partida; ao
 * escolher, ele vira o programa semanal, que organiza essas rotinas pelos dias. O que o catálogo não tem fica de fora.
 */
@Component({
  selector: 'app-templates-sheet',
  imports: [TrainingSheet, TrainingGlyph, TrainingRowsSkeleton],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      @if (loading()) {
        <app-training-rows-skeleton [label]="loadingLabel" [rows]="3" />
      }
      @if (templates().length > 0) {
        <ul class="ui-group ui-plain">
          @for (template of templates(); track template.id) {
            <li>
              <button
                type="button"
                class="ui-row"
                [disabled]="creating()"
                [attr.aria-expanded]="expandedTemplate() === template.id"
                [attr.aria-controls]="'template-details-' + template.id"
                (click)="toggleDetails(template)"
              >
                <span class="ui-tile"><app-training-glyph name="list" /></span>
                <span class="ui-row-text">
                  <span class="ui-row-title">{{ template.name }}</span>
                  <span class="ui-row-sub">{{ summary(template) }}</span>
                </span>
                <span class="ui-chip">{{ daysText(template) }}</span>
                <app-training-glyph
                  class="template-chevron"
                  [class.expanded]="expandedTemplate() === template.id"
                  name="next"
                />
              </button>
              @if (expandedTemplate() === template.id) {
                <div class="template-details" [id]="'template-details-' + template.id">
                  <p class="weekly-plan">{{ weeklyPlan(template) }}</p>
                  <ul class="routine-preview ui-plain">
                    @for (routine of template.routines; track routine.name) {
                      <li>
                        <span>{{ routine.name }}</span>
                        <span>{{ routineDays(routine.weekdays) }}</span>
                      </li>
                    }
                  </ul>
                  @if (details(template); as note) {
                    <p>{{ note }}</p>
                  }
                  <button
                    type="button"
                    class="primary ui-btn block create-draft"
                    [disabled]="creating()"
                    (click)="use(template)"
                  >
                    @if (isHistorical(template)) {
                      <span i18n="@@training.templates.use">Criar Este Rascunho Parcial</span>
                    } @else {
                      <span i18n="@@training.templates.choose">Usar Este Modelo</span>
                    }
                  </button>
                </div>
              }
            </li>
          }
        </ul>
        <p class="note" i18n="@@training.templates.note">O modelo é só o ponto de partida.</p>
      }
      @if (error(); as message) {
        <p class="ui-notice bad" role="alert">
          <app-training-glyph name="alert" />
          <span>{{ message }}</span>
        </p>
      }
    </app-training-sheet>
  `,
  styles: `
    .note {
      margin: 0;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .template-details {
      display: grid;
      gap: var(--space-3);
      padding: var(--space-3) var(--space-4);
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .template-details p {
      margin: 0;
      white-space: pre-line;
    }
    .weekly-plan {
      color: var(--a-ink);
    }
    .routine-preview {
      display: grid;
      gap: var(--space-2);
      margin: 0;
    }
    .routine-preview li {
      display: flex;
      justify-content: space-between;
      gap: var(--space-3);
      padding-top: var(--space-2);
      border-top: 1px solid var(--a-line);
    }
    .routine-preview li span:last-child {
      flex: none;
      color: var(--a-ink2);
    }
    .template-chevron {
      flex: none;
      color: var(--a-ink3);
      transition: rotate var(--dur-fast) var(--ease-out);
    }
    .template-chevron.expanded {
      rotate: 90deg;
    }
    .create-draft {
      width: 100%;
    }
    .create-draft:disabled {
      opacity: 0.6;
      cursor: default;
    }
    button.ui-row:disabled {
      opacity: 0.6;
      cursor: default;
    }
    @media (prefers-reduced-motion: reduce) {
      .template-chevron {
        transition: none;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesSheet {
  protected readonly loadingLabel = $localize`:@@training.templates.loading:Carregando os modelos…`;
  private readonly routines = inject(RoutineRepository);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly created = output<TemplateCreated>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.templates.title:Comparar Modelos`;
  protected readonly cancelLabel = $localize`:@@training.templates.cancel:Cancelar`;
  protected readonly templates = signal<readonly RoutineTemplate[]>([]);
  protected readonly loading = signal(true);
  protected readonly creating = signal(false);
  protected readonly error = signal('');
  protected readonly expandedTemplate = signal<string | null>(null);

  constructor() {
    void this.load();
  }

  protected daysText(template: RoutineTemplate): string {
    const count = template.routines.length;
    return count === 1
      ? $localize`:@@training.templates.days-one:1 treino`
      : $localize`:@@training.templates.days-many:${count}:count: treinos`;
  }

  protected summary(template: RoutineTemplate): string {
    return template.description.split('\n\n', 1)[0];
  }

  protected details(template: RoutineTemplate): string {
    return template.description.split('\n\n').slice(1).join('\n\n');
  }

  protected weeklyPlan(template: RoutineTemplate): string {
    const summary = programSummary(template.routines);
    return $localize`:@@training.templates.weekly-plan:Este modelo organiza a semana assim: ${summary}:summary:.`;
  }

  protected routineDays(days: readonly number[]): string {
    return days.length > 0
      ? daysText(days)
      : $localize`:@@training.templates.no-days:Sem dia definido`;
  }

  protected isHistorical(template: RoutineTemplate): boolean {
    return template.id === HISTORICAL_REJECTED_TEMPLATE_ID;
  }

  protected toggleDetails(template: RoutineTemplate): void {
    this.expandedTemplate.update((current) => (current === template.id ? null : template.id));
  }

  protected async use(template: RoutineTemplate): Promise<void> {
    this.error.set('');
    this.creating.set(true);
    try {
      const historical = this.isHistorical(template);
      // O histórico rejeitado segue como rascunho inativo; os demais viram o programa da semana.
      const result = historical
        ? await this.routines.createFromTemplate(template.id)
        : await this.routines.selectProgram(template.id);
      switch (result.status) {
        case 'saved':
          this.created.emit({
            name: template.name,
            count: result.routines.length,
            missing: result.missing.length,
            draft: historical,
            historical,
            program: !historical,
          });
          this.sheet().close();
          return;
        case 'no-exercises':
          this.error.set(
            $localize`:@@training.templates.no-exercises:Nenhum exercício deste modelo está no seu catálogo ainda. Abra a lista de exercícios com rede para baixá-lo.`,
          );
          return;
        case 'storage-full':
          this.error.set(
            $localize`:@@training.templates.storage:Sem espaço no aparelho para guardar as rotinas. Libere espaço e tente de novo.`,
          );
          return;
        default:
          this.error.set(this.unavailable);
      }
    } finally {
      this.creating.set(false);
    }
  }

  private readonly unavailable = $localize`:@@training.templates.unavailable:Não deu para carregar os modelos agora. Tente de novo com rede.`;

  private async load(): Promise<void> {
    try {
      this.templates.set(await this.routines.templates());
    } catch {
      this.error.set(this.unavailable);
    } finally {
      this.loading.set(false);
    }
  }
}
