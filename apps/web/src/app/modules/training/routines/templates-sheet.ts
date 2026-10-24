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
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';

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
 * Folha "Usar modelo": modelos vêm do servidor e só carregam com rede. Modelos com notas extensas abrem os detalhes
 * antes de disponibilizar a ação de criar; o que o catálogo do aparelho não tem fica de fora, e a lista avisa quantos.
 */
@Component({
  selector: 'app-templates-sheet',
  imports: [TrainingSheet, TrainingGlyph],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      @if (loading()) {
        <p class="loading" role="status">
          <span class="ui-spinner" aria-hidden="true"></span>
          <span i18n="@@training.templates.loading">Carregando os modelos…</span>
        </p>
      }
      @if (templates().length > 0) {
        <ul class="ui-group ui-plain">
          @for (template of templates(); track template.id) {
            <li>
              <button
                type="button"
                class="ui-row"
                [disabled]="creating()"
                [attr.aria-expanded]="
                  hasDetails(template) ? expandedTemplate() === template.id : null
                "
                [attr.aria-controls]="
                  hasDetails(template) ? 'template-details-' + template.id : null
                "
                (click)="hasDetails(template) ? toggleDetails(template) : use(template)"
              >
                <span class="ui-tile"><app-training-glyph name="list" /></span>
                <span class="ui-row-text">
                  <span class="ui-row-title">{{ template.name }}</span>
                  <span class="ui-row-sub">{{ summary(template) }}</span>
                </span>
                <span class="ui-chip">{{ daysText(template) }}</span>
              </button>
              @if (expandedTemplate() === template.id && hasDetails(template)) {
                <div class="template-details" [id]="'template-details-' + template.id">
                  <p>{{ details(template) }}</p>
                  <button
                    type="button"
                    class="create-draft"
                    [disabled]="creating()"
                    (click)="use(template)"
                  >
                    @if (isHistorical(template)) {
                      <span i18n="@@training.templates.use">Criar este rascunho parcial</span>
                    } @else {
                      <span i18n="@@training.templates.choose">Escolher este programa</span>
                    }
                  </button>
                </div>
              }
            </li>
          }
        </ul>
        <p class="note" i18n="@@training.templates.note">
          Escolha um programa: Hoje abre no treino do dia da semana.
        </p>
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
    .loading {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      margin: 0;
      color: var(--a-ink2);
    }
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
    .create-draft {
      justify-self: start;
      min-height: 2.75rem;
      padding: 0.5rem 0.875rem;
      border: 1px solid var(--a-line);
      border-radius: 0.75rem;
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      font-weight: 600;
    }
    .create-draft:disabled {
      opacity: 0.6;
      cursor: default;
    }
    button.ui-row:disabled {
      opacity: 0.6;
      cursor: default;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TemplatesSheet {
  private readonly routines = inject(RoutineRepository);
  private readonly sheet = viewChild.required(TrainingSheet);

  readonly created = output<TemplateCreated>();
  readonly closed = output<void>();

  protected readonly heading = $localize`:@@training.templates.title:Usar um modelo`;
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

  protected isHistorical(template: RoutineTemplate): boolean {
    return template.id === HISTORICAL_REJECTED_TEMPLATE_ID;
  }

  protected hasDetails(template: RoutineTemplate): boolean {
    return template.description.includes('\n\n');
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
