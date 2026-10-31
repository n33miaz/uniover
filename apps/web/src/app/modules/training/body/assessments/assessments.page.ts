import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PhysicalAssessmentRepository } from '../../data/physical-assessments/physical-assessment-repository';
import type { LocalPhysicalAssessment } from '../../data/physical-assessments/physical-assessment';
import { assessmentTitle } from './assessment-format';
import { AssessmentsListSkeleton } from './assessment-skeletons';

@Component({
  selector: 'app-physical-assessments-page',
  imports: [RouterLink, AssessmentsListSkeleton],
  template: `
    <div class="page" aria-labelledby="title">
      <header>
        <p class="eyebrow" i18n="@@training.assessments.eyebrow">Histórico Pessoal</p>
        <h1 id="title" i18n="@@training.assessments.title">Avaliações Físicas</h1>
      </header>
      <aside class="privacy" role="note">
        <strong i18n="@@training.assessments.private-title">Somente Neste Aparelho</strong>
        <p i18n="@@training.assessments.private-copy">
          Nada aqui é enviado ou sincronizado. Exporte uma cópia para não perder os registros.
        </p>
      </aside>
      <div class="actions">
        <a class="primary" routerLink="nova" i18n="@@training.assessments.new">Nova Avaliação</a>
        <a class="secondary" routerLink="importar" i18n="@@training.assessments.import"
          >Importar Arquivo</a
        >
      </div>
      @if (loading()) {
        <app-assessments-list-skeleton />
      } @else if (rows().length === 0) {
        <section class="empty">
          <h2 i18n="@@training.assessments.empty-title">Seu Histórico Começa Aqui</h2>
          <p i18n="@@training.assessments.empty-copy">
            Registre uma avaliação ou importe um arquivo.
          </p>
        </section>
      } @else {
        <section aria-label="{{ historyLabel }}" class="history">
          @for (row of rows(); track row.id) {
            <a class="record" [routerLink]="[row.id]">
              <span class="record-date">{{ title(row) }}</span>
              <span class="record-source">{{
                row.origin || row.professional || sourceFallback
              }}</span>
              <span class="record-count"
                >{{ row.measurements?.length ?? 0 }} {{ measureWord }}</span
              >
              <span class="chevron" aria-hidden="true">›</span>
            </a>
          }
        </section>
      }
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .page {
      display: grid;
      gap: var(--space-3);
      padding: 0 var(--space-4) var(--space-5);
    }
    header {
      display: grid;
      gap: 4px;
    }
    h1,
    h2,
    p {
      margin: 0;
    }
    h1 {
      font-size: var(--fs-title, 1.5rem);
    }
    .back {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      color: var(--a-ink2);
      text-decoration: none;
    }
    .eyebrow {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .privacy,
    .empty {
      padding: var(--space-3);
      border-radius: var(--radius);
      background: var(--a-surface-2);
    }
    .privacy {
      display: grid;
      gap: 5px;
      font-size: var(--fs-small);
    }
    .privacy strong {
      color: var(--a-ink);
    }
    /* O título do vazio cabe numa linha em qualquer largura. */
    .empty h2 {
      font-size: clamp(1.0625rem, 5vw, 1.375rem);
      white-space: nowrap;
    }
    .privacy p,
    .muted,
    .empty p {
      color: var(--a-ink2);
    }
    .actions {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: var(--space-2);
    }
    .actions a {
      min-height: var(--tap);
      display: grid;
      place-items: center;
      border-radius: var(--radius-sm);
      text-align: center;
      text-decoration: none;
      font-weight: 650;
    }
    .primary {
      color: var(--a-on-accent, white);
      background: var(--a-accent);
    }
    .secondary {
      color: var(--a-ink);
      background: var(--a-surface-2);
    }
    .history {
      display: grid;
      border-top: 1px solid var(--a-line);
    }
    .record {
      position: relative;
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 3px var(--space-2);
      align-items: center;
      min-height: 74px;
      padding: var(--space-2) var(--space-4) var(--space-2) 0;
      border-bottom: 1px solid var(--a-line);
      color: inherit;
      text-decoration: none;
    }
    .record-date {
      font-weight: 700;
    }
    .record-source,
    .record-count {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .record-count {
      grid-column: 1;
    }
    .chevron {
      position: absolute;
      right: 0;
      top: 50%;
      color: var(--a-ink2);
      font-size: 1.5rem;
      transform: translateY(-50%);
    }
    .empty {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-4);
    }
    a:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 3px;
    }
    @media (max-width: 360px) {
      .actions {
        grid-template-columns: 1fr;
      }
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhysicalAssessmentsPage {
  private readonly repository = inject(PhysicalAssessmentRepository);
  protected readonly rows = signal<LocalPhysicalAssessment[]>([]);
  protected readonly loading = signal(true);
  protected readonly historyLabel = $localize`:@@training.assessments.history:Histórico de avaliações`;
  protected readonly sourceFallback = $localize`:@@training.assessments.unknown-origin:Origem não informada`;
  protected readonly measureWord = $localize`:@@training.assessments.measurements-word:medidas`;
  protected readonly title = assessmentTitle;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.rows.set((await this.repository.list()).reverse());
    } finally {
      // Banco que não abre não prende a tela no brilho: a lista fica vazia e a moldura de espera já cuida do prazo.
      this.loading.set(false);
    }
  }
}
