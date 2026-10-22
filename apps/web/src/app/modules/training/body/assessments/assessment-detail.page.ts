import { DOCUMENT } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AssessmentDocumentInfo,
  LocalPhysicalAssessment,
} from '../../data/physical-assessments/physical-assessment';
import { PhysicalAssessmentExport } from '../../data/physical-assessments/physical-assessment-export';
import { PhysicalAssessmentRepository } from '../../data/physical-assessments/physical-assessment-repository';
import { ExportDelivery } from '../../data/export/export-delivery';
import { assessmentTitle, KIND_LABELS, measureLabel, measurementText } from './assessment-format';

@Component({
  selector: 'app-physical-assessment-detail-page',
  imports: [RouterLink],
  template: `
    <div class="page" aria-labelledby="title">
      <a class="back" routerLink="/treino/corpo/avaliacoes" i18n="@@training.assessments.back-list"
        >‹ Avaliações</a
      >
      @if (loading()) {
        <p role="status" i18n="@@training.assessments.loading">Carregando avaliação…</p>
      } @else if (assessment(); as row) {
        <header>
          <p class="eyebrow" i18n="@@training.assessments.historical">Registro histórico</p>
          <h1 id="title">{{ title(row) }}</h1>
          <p class="origin">
            {{ row.origin || missingOrigin }}
            @if (row.professional) {
              · {{ row.professional }}
            }
          </p>
        </header>
        @if (row.reportedAgeYears !== null && row.reportedAgeYears !== undefined) {
          <p class="context">{{ ageLabel }} · {{ row.reportedAgeYears }}</p>
        }
        @if (row.statedGoal || row.activityStatus || row.plannedFrequencyPerWeek !== null) {
          <section class="context-card" aria-label="{{ contextLabel }}">
            <h2 i18n="@@training.assessments.report-context">Contexto informado no relatório</h2>
            @if (row.statedGoal) {
              <p>{{ goalLabel }} · {{ row.statedGoal }}</p>
            }
            @if (row.activityStatus) {
              <p>{{ activityLabel }} · {{ row.activityStatus }}</p>
            }
            @if (
              row.plannedFrequencyPerWeek !== null && row.plannedFrequencyPerWeek !== undefined
            ) {
              <p>{{ frequencyLabel }} · {{ row.plannedFrequencyPerWeek }}</p>
            }
          </section>
        }
        <section class="measurements" aria-label="{{ measurementLabel }}">
          <h2 i18n="@@training.assessments.measurements-title">Medidas e resultados</h2>
          @if ((row.measurements?.length ?? 0) === 0) {
            <p class="muted" i18n="@@training.assessments.no-measures">
              Nenhuma medida registrada.
            </p>
          }
          @for (measure of row.measurements ?? []; track $index) {
            <article class="measure">
              <div class="measure-head">
                <strong>{{ label(measure.type) }}</strong
                ><span
                  class="kind"
                  [class.calculated]="measure.kind === 'calculated'"
                  [class.reference]="measure.kind === 'reference'"
                  >{{ kindLabel(measure.kind) }}</span
                >
              </div>
              <p class="value">{{ valueText(measure) }}</p>
              <div class="metadata">
                @if (measure.side) {
                  <span>{{ sideLabel(measure.side) }}</span>
                }
                @if (measure.method) {
                  <span>{{ methodPrefix }} · {{ measure.method }}</span>
                }
                @if (measure.source) {
                  <span>{{ sourcePrefix }} · {{ measure.source }}</span>
                }
              </div>
            </article>
          }
        </section>
        @if (row.notes) {
          <section class="notes">
            <h2 i18n="@@training.assessments.notes-title">Observações</h2>
            <p>{{ row.notes }}</p>
          </section>
        }
        <section class="documents" aria-labelledby="documents-title">
          <div class="section-head">
            <h2 id="documents-title" i18n="@@training.assessments.documents-title">
              Fotos do relatório
            </h2>
            <span>{{ docs().length }}</span>
          </div>
          <p class="muted" i18n="@@training.assessments.documents-local">
            Arquivos salvos apenas neste aparelho.
          </p>
          @if (docs().length === 0) {
            <p class="muted" i18n="@@training.assessments.no-documents">Nenhum arquivo anexado.</p>
          }
          @for (doc of docs(); track doc.id) {
            <div class="document-row">
              <button type="button" class="document-name" (click)="openDocument(doc)">
                {{ doc.name }}
              </button>
              <button
                type="button"
                class="quiet"
                (click)="removeDocument(doc)"
                [attr.aria-label]="removeLabel(doc.name)"
                i18n="@@training.assessments.remove-document"
              >
                Remover
              </button>
            </div>
          }
        </section>
        <div class="actions">
          <a class="primary" [routerLink]="['editar']" i18n="@@training.assessments.edit"
            >Editar avaliação</a
          >
          <button
            class="secondary"
            type="button"
            (click)="export()"
            i18n="@@training.assessments.export"
          >
            Exportar avaliação
          </button>
          <button
            class="danger"
            type="button"
            (click)="delete()"
            i18n="@@training.assessments.delete"
          >
            Excluir avaliação
          </button>
        </div>
        @if (message()) {
          <p class="status" role="status">{{ message() }}</p>
        }
        @if (previewUrl(); as url) {
          <dialog open class="preview" aria-labelledby="preview-title">
            <div class="preview-bar">
              <h2 id="preview-title">{{ previewName() }}</h2>
              <button
                type="button"
                (click)="closePreview()"
                i18n="@@training.assessments.close-preview"
              >
                Fechar
              </button>
            </div>
            <img [src]="url" alt="{{ previewAlt }}" />
          </dialog>
        }
      } @else {
        <h1 id="title" i18n="@@training.assessments.not-found">Avaliação não encontrada</h1>
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
      padding: 0 var(--space-4) calc(var(--space-5) + env(safe-area-inset-bottom));
    }
    h1,
    h2,
    p {
      margin: 0;
    }
    h1 {
      font-size: var(--fs-title, 1.5rem);
    }
    h2 {
      font-size: 1rem;
    }
    .back {
      min-height: 40px;
      display: inline-flex;
      align-items: center;
      color: var(--a-ink2);
      text-decoration: none;
    }
    header {
      display: grid;
      gap: 4px;
    }
    .eyebrow,
    .origin,
    .muted,
    .context,
    .metadata {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .context-card,
    .notes {
      display: grid;
      gap: 7px;
      padding: var(--space-3);
      border-radius: var(--radius-md);
      background: var(--a-surface2);
    }
    .measurements {
      display: grid;
      gap: var(--space-2);
    }
    .measure {
      padding: var(--space-2) 0;
      border-bottom: 1px solid var(--a-line);
    }
    .measure-head,
    .section-head,
    .document-row {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: var(--space-2);
    }
    .kind {
      padding: 3px 8px;
      border-radius: var(--radius-pill, 999px);
      background: var(--a-surface2);
      color: var(--a-ink2);
      font-size: 0.75rem;
    }
    .kind.calculated {
      color: var(--a-accent-ink, var(--a-accent));
    }
    .kind.reference {
      border: 1px dashed var(--a-line);
    }
    .value {
      margin-top: 4px;
      font-size: 1.25rem;
      font-weight: 700;
    }
    .metadata {
      display: flex;
      flex-wrap: wrap;
      gap: 4px var(--space-3);
      margin-top: 4px;
    }
    .documents {
      display: grid;
      gap: 8px;
    }
    .document-row {
      min-height: 48px;
      border-bottom: 1px solid var(--a-line);
    }
    .document-name,
    .quiet {
      border: 0;
      color: var(--a-ink);
      background: transparent;
      font: inherit;
    }
    .document-name {
      overflow-wrap: anywhere;
      text-align: left;
      text-decoration: underline;
    }
    .quiet {
      color: var(--a-ink2);
    }
    .actions {
      display: grid;
      gap: var(--space-2);
    }
    .actions > * {
      min-height: var(--tap);
      display: grid;
      place-items: center;
      border: 0;
      border-radius: var(--radius-md);
      font: inherit;
      font-weight: 650;
      text-decoration: none;
    }
    .primary {
      color: var(--a-on-accent, white);
      background: var(--a-accent);
    }
    .secondary {
      color: var(--a-ink);
      background: var(--a-surface2);
    }
    .danger {
      color: var(--a-danger, #a11);
      background: transparent;
    }
    .status {
      padding: var(--space-2);
      background: var(--a-surface2);
    }
    .preview {
      position: fixed;
      inset: 0;
      width: 100vw;
      height: 100dvh;
      max-width: none;
      max-height: none;
      padding: var(--space-3);
      border: 0;
      background: var(--a-surface);
      color: var(--a-ink);
      z-index: 20;
    }
    .preview-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      min-height: 48px;
    }
    .preview img {
      display: block;
      max-width: 100%;
      max-height: calc(100dvh - 80px);
      margin: 0 auto;
      object-fit: contain;
    }
    button:focus-visible,
    a:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 3px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhysicalAssessmentDetailPage {
  private readonly repository = inject(PhysicalAssessmentRepository);
  private readonly exports = inject(PhysicalAssessmentExport);
  private readonly delivery = inject(ExportDelivery);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly doc = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly assessment = signal<LocalPhysicalAssessment | null>(null);
  protected readonly docs = signal<AssessmentDocumentInfo[]>([]);
  protected readonly loading = signal(true);
  protected readonly message = signal('');
  protected readonly previewUrl = signal<string | null>(null);
  protected readonly previewName = signal('');
  protected readonly title = assessmentTitle;
  protected readonly label = measureLabel;
  protected readonly valueText = measurementText;
  protected readonly kindLabel = (kind: keyof typeof KIND_LABELS) => KIND_LABELS[kind];
  protected readonly missingOrigin = $localize`:@@training.assessments.unknown-origin:Origem não informada`;
  protected readonly ageLabel = $localize`:@@training.assessments.reported-age:Idade informada`;
  protected readonly goalLabel = $localize`:@@training.assessments.goal:Objetivo informado`;
  protected readonly activityLabel = $localize`:@@training.assessments.activity:Atividade informada`;
  protected readonly frequencyLabel = $localize`:@@training.assessments.frequency:Frequência planejada informada`;
  protected readonly methodPrefix = $localize`:@@training.assessments.method:Método`;
  protected readonly sourcePrefix = $localize`:@@training.assessments.source:Procedência`;
  protected readonly contextLabel = $localize`:@@training.assessments.context-label:Contexto da avaliação`;
  protected readonly measurementLabel = $localize`:@@training.assessments.measurements-label:Resultados da avaliação`;
  protected readonly previewAlt = $localize`:@@training.assessments.preview-alt:Imagem do relatório anexado`;
  protected readonly sideLabel = (side: 'left' | 'right') =>
    side === 'left'
      ? $localize`:@@training.assessments.left:Esquerdo`
      : $localize`:@@training.assessments.right:Direito`;

  constructor() {
    this.destroyRef.onDestroy(() => this.revokePreview());
    void this.load();
  }

  protected async openDocument(document: AssessmentDocumentInfo): Promise<void> {
    this.revokePreview();
    const data = await this.repository.documentData(document.id);
    if (!data) return;
    const url = await new Promise<string | null>((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(new Blob([data], { type: document.mediaType }));
    });
    if (url) {
      this.previewName.set(document.name);
      this.previewUrl.set(url);
    }
  }

  protected closePreview(): void {
    this.revokePreview();
  }

  protected async removeDocument(document: AssessmentDocumentInfo): Promise<void> {
    if (
      !this.doc.defaultView?.confirm(
        $localize`:@@training.assessments.confirm-remove-document:Remover este arquivo deste aparelho?`,
      )
    )
      return;
    await this.repository.removeDocument(document.id);
    this.docs.update((rows) => rows.filter((row) => row.id !== document.id));
    this.revokePreview();
    this.message.set(
      $localize`:@@training.assessments.document-removed:Arquivo removido deste aparelho.`,
    );
  }

  protected removeLabel(name: string): string {
    return $localize`:@@training.assessments.remove-document-label:Remover ${name}:name:`;
  }

  protected async export(): Promise<void> {
    const row = this.assessment();
    if (!row) return;
    const payload = await this.exports.build(row.id);
    if (!payload) return;
    this.delivery.download(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
      `avaliacao-fisica-${row.assessedOn}.json`,
    );
    this.message.set(
      $localize`:@@training.assessments.exported:A avaliação e seus arquivos foram exportados para uma cópia local.`,
    );
  }

  protected async delete(): Promise<void> {
    const row = this.assessment();
    if (
      !row ||
      !this.doc.defaultView?.confirm(
        $localize`:@@training.assessments.confirm-delete:Excluir esta avaliação e todos os arquivos anexados? Esta ação não pode ser desfeita.`,
      )
    )
      return;
    await this.repository.delete(row.id);
    await this.router.navigateByUrl('/treino/corpo/avaliacoes');
  }

  private async load(): Promise<void> {
    const id = this.route.snapshot.paramMap.get('id');
    if (!id) {
      this.loading.set(false);
      return;
    }
    const [row, documents] = await Promise.all([
      this.repository.get(id),
      this.repository.documents(id),
    ]);
    this.assessment.set(row ?? null);
    this.docs.set(documents);
    this.loading.set(false);
  }

  private revokePreview(): void {
    this.previewUrl.set(null);
  }
}
