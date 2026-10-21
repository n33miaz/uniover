import {
  ChangeDetectionStrategy,
  Component,
  inject,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { RoutineTemplate } from '../data/routines/routine';
import { RoutineRepository } from '../data/routines/routine-repository';
import { TrainingGlyph } from '../shell/training-glyph';
import { TrainingSheet } from '../shell/training-sheet';

/** O que a folha avisa à lista quando cria as rotinas de um modelo. */
export interface TemplateCreated {
  readonly name: string;
  readonly count: number;
  /** Quantos exercícios do modelo não existem no catálogo deste aparelho e ficaram de fora. */
  readonly missing: number;
}

/**
 * Folha "Usar modelo": os programas prontos (ABC, ABCD, full body). Os modelos vêm do servidor, então a folha só abre
 * com rede; um toque cria as rotinas do modelo no fim da sequência (a pessoa edita à vontade depois). O que o modelo
 * pede e o catálogo do aparelho não tem fica de fora, e a lista avisa quantos.
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
              <button type="button" class="ui-row" [disabled]="creating()" (click)="use(template)">
                <span class="ui-tile"><app-training-glyph name="list" /></span>
                <span class="ui-row-text">
                  <span class="ui-row-title">{{ template.name }}</span>
                  <span class="ui-row-sub">{{ template.description }}</span>
                </span>
                <span class="ui-chip">{{ daysText(template) }}</span>
              </button>
            </li>
          }
        </ul>
        <p class="note" i18n="@@training.templates.note">
          São sugestões nossas, sem promessa de resultado. Você edita tudo depois.
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

  constructor() {
    void this.load();
  }

  protected daysText(template: RoutineTemplate): string {
    const count = template.routines.length;
    return count === 1
      ? $localize`:@@training.templates.days-one:1 treino`
      : $localize`:@@training.templates.days-many:${count}:count: treinos`;
  }

  protected async use(template: RoutineTemplate): Promise<void> {
    this.error.set('');
    this.creating.set(true);
    try {
      const result = await this.routines.createFromTemplate(template.id);
      switch (result.status) {
        case 'saved':
          this.created.emit({
            name: template.name,
            count: result.routines.length,
            missing: result.missing.length,
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
