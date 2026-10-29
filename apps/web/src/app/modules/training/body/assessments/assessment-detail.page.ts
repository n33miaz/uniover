import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import {
  AssessmentDocumentInfo,
  LocalPhysicalAssessment,
} from '../../data/physical-assessments/physical-assessment';
import { PhysicalAssessmentExport } from '../../data/physical-assessments/physical-assessment-export';
import { PhysicalAssessmentRepository } from '../../data/physical-assessments/physical-assessment-repository';
import { ExportDelivery } from '../../data/export/export-delivery';
import { BodyRepository } from '../../data/body/body-repository';
import { TRAINING_DB } from '../../data/training-db';
import { assessmentTitle, KIND_LABELS, measureLabel, measurementText } from './assessment-format';
import {
  assessmentBodyCandidates,
  assessmentBodyDraft,
  assessmentBodyEntryMatchesField,
  assessmentBodyFingerprint,
  assessmentBodyNoteTooLong,
  assessmentBodyProvenance,
  assessmentBodyTransferKey,
  assessmentBodyTransferredFields,
  type AssessmentBodyField,
  type AssessmentBodyCandidate,
} from './assessment-body-transfer';

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
            <h2 i18n="@@training.assessments.report-context">Contexto Informado no Relatório</h2>
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
          <h2 i18n="@@training.assessments.measurements-title">Medidas e Resultados</h2>
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
              Fotos do Relatório
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
        @if (transferOpen()) {
          <section class="transfer" aria-labelledby="transfer-title">
            <h2 id="transfer-title" i18n="@@training.assessments.transfer.title">
              Escolher Medidas para o Corpo
            </h2>
            <p class="muted" i18n="@@training.assessments.transfer.copy">
              Só os campos selecionados serão registrados com a data desta avaliação. Eles poderão
              sincronizar como os outros dados do Corpo. As imagens do relatório ficam neste
              aparelho e nunca são copiadas.
            </p>
            @if (transferLoading()) {
              <p role="status" i18n="@@training.assessments.transfer.checking">
                Conferindo o histórico do Corpo…
              </p>
            } @else if (transferAlready()) {
              <p
                class="transfer-status"
                role="status"
                i18n="@@training.assessments.transfer.already"
              >
                Estas medidas já foram transferidas para o Corpo. Uma nova importação do mesmo
                registro também será reconhecida neste aparelho.
              </p>
            } @else if (transferCandidates().length === 0) {
              <p class="muted" i18n="@@training.assessments.transfer.none">
                Esta avaliação não tem medidas compatíveis e completas para o Corpo.
              </p>
            } @else {
              @if ((row.measurements?.length ?? 0) > transferCandidates().length) {
                <p class="muted" i18n="@@training.assessments.transfer.filtered">
                  Só aparecem valores numéricos com unidade e campo sem ambiguidade que o Corpo
                  representa. Os demais permanecem apenas no histórico local.
                </p>
              }
              <fieldset class="transfer-fields">
                <legend i18n="@@training.assessments.transfer.choose">
                  Marque cada campo que deseja copiar
                </legend>
                @for (candidate of transferCandidates(); track candidate.key) {
                  <label class="transfer-option" [for]="transferInputId(candidate)">
                    <input
                      type="checkbox"
                      [id]="transferInputId(candidate)"
                      [disabled]="isTransferFieldDone(candidate.field)"
                      [checked]="isTransferSelected(candidate.key)"
                      (change)="toggleTransferCandidate(candidate.key, $any($event.target).checked)"
                    />
                    <span class="transfer-value">
                      <strong>{{ label(candidate.measure.type) }}</strong>
                      <span>{{ candidateValueText(candidate) }}</span>
                      <small>{{ candidateProvenance(candidate) }}</small>
                      @if (isTransferFieldDone(candidate.field)) {
                        <small i18n="@@training.assessments.transfer.field-done">
                          Este campo já foi registrado
                        </small>
                      }
                    </span>
                  </label>
                }
              </fieldset>
              @if (transferNoteTooLong()) {
                <p
                  class="transfer-error"
                  role="alert"
                  i18n="@@training.assessments.transfer.note-long"
                >
                  A origem selecionada é longa demais para a anotação do Corpo. Desmarque campos até
                  a procedência caber por inteiro.
                </p>
              }
              @if (selectedTransferCandidates().length > 0) {
                <div class="transfer-note">
                  <strong i18n="@@training.assessments.transfer.note-label">
                    Anotação que será registrada no Corpo
                  </strong>
                  <p>{{ transferNote() }}</p>
                </div>
              }
              @if (transferError()) {
                <p class="transfer-error" role="alert">{{ transferError() }}</p>
                <button
                  type="button"
                  class="secondary"
                  (click)="openBodyTransfer()"
                  i18n="@@training.assessments.transfer.retry"
                >
                  Conferir Novamente
                </button>
              }
              <div class="transfer-actions">
                <button
                  type="button"
                  class="primary"
                  [disabled]="
                    !transferCheckComplete() ||
                    transferSaving() ||
                    selectedTransferCandidates().length === 0 ||
                    transferNoteTooLong()
                  "
                  (click)="saveBodyTransfer()"
                  i18n="@@training.assessments.transfer.confirm"
                >
                  Registrar Campos Selecionados
                </button>
                <button
                  type="button"
                  class="secondary"
                  [disabled]="transferSaving()"
                  (click)="closeBodyTransfer()"
                  i18n="@@training.assessments.transfer.cancel"
                >
                  Cancelar
                </button>
              </div>
            }
          </section>
        }
        <div class="actions">
          <a class="primary" [routerLink]="['editar']" i18n="@@training.assessments.edit"
            >Editar Avaliação</a
          >
          <button
            class="secondary"
            type="button"
            (click)="openBodyTransfer()"
            i18n="@@training.assessments.transfer.open"
          >
            Levar medidas ao Corpo…
          </button>
          <button
            class="secondary"
            type="button"
            (click)="export()"
            i18n="@@training.assessments.export"
          >
            Exportar Avaliação
          </button>
          <button
            class="danger"
            type="button"
            (click)="delete()"
            i18n="@@training.assessments.delete"
          >
            Excluir Avaliação
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
        <h1 id="title" i18n="@@training.assessments.not-found">Avaliação Não Encontrada</h1>
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
    .notes,
    .transfer {
      display: grid;
      gap: 7px;
      padding: var(--space-3);
      border-radius: var(--radius);
      background: var(--a-surface-2);
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
      background: var(--a-surface-2);
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
      border-radius: var(--radius-sm);
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
      background: var(--a-surface-2);
    }
    .danger {
      color: var(--a-danger, #a11);
      background: transparent;
    }
    .status {
      padding: var(--space-2);
      background: var(--a-surface-2);
    }
    .transfer-fields {
      display: grid;
      gap: 4px;
      margin: 0;
      padding: 0;
      border: 0;
    }
    .transfer-fields legend {
      margin-bottom: 6px;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .transfer-option {
      display: flex;
      align-items: flex-start;
      gap: var(--space-2);
      min-height: var(--tap);
      padding: 8px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
      background: var(--a-surface);
    }
    .transfer-option input {
      width: 20px;
      height: 20px;
      margin: 2px 0 0;
      accent-color: var(--a-accent);
    }
    .transfer-value {
      display: grid;
      gap: 2px;
      min-width: 0;
    }
    .transfer-value small {
      overflow-wrap: anywhere;
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .transfer-status {
      margin: 0;
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--a-surface);
    }
    .transfer-note {
      display: grid;
      gap: 4px;
      padding: var(--space-2);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm);
      background: var(--a-surface);
      overflow-wrap: anywhere;
      font-size: var(--fs-small);
    }
    .transfer-note p {
      margin: 0;
      color: var(--a-ink2);
    }
    .transfer-error {
      margin: 0;
      color: var(--a-danger, #a11);
      font-size: var(--fs-small);
    }
    .transfer-actions {
      display: grid;
      gap: var(--space-2);
    }
    .transfer-actions > * {
      min-height: var(--tap);
      border: 0;
      border-radius: var(--radius-sm);
      font: inherit;
      font-weight: 650;
    }
    .transfer-actions button:disabled {
      opacity: 0.55;
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
  private readonly bodyRepository = inject(BodyRepository);
  private readonly db = inject(TRAINING_DB);
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
  protected readonly transferOpen = signal(false);
  protected readonly transferLoading = signal(false);
  protected readonly transferCheckComplete = signal(false);
  protected readonly transferAlready = signal(false);
  protected readonly transferredFields = signal<readonly AssessmentBodyField[]>([]);
  private readonly transferFingerprint = signal<string | null>(null);
  protected readonly transferSaving = signal(false);
  protected readonly transferError = signal('');
  protected readonly transferCandidates = signal<AssessmentBodyCandidate[]>([]);
  protected readonly selectedTransferKeys = signal<readonly string[]>([]);
  protected readonly selectedTransferCandidates = computed(() => {
    const keys = new Set(this.selectedTransferKeys());
    return this.transferCandidates().filter((candidate) => keys.has(candidate.key));
  });
  protected readonly transferNote = computed(() => {
    const row = this.assessment();
    return row ? assessmentBodyProvenance(row, this.selectedTransferCandidates()) : '';
  });
  protected readonly transferNoteTooLong = computed(() => {
    const row = this.assessment();
    return row !== null && assessmentBodyNoteTooLong(row, this.selectedTransferCandidates());
  });
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

  protected async openBodyTransfer(): Promise<void> {
    const row = this.assessment();
    if (!row) return;
    this.transferOpen.set(true);
    this.transferLoading.set(true);
    this.transferCheckComplete.set(false);
    this.transferAlready.set(false);
    this.transferredFields.set([]);
    this.transferFingerprint.set(null);
    this.transferError.set('');
    this.selectedTransferKeys.set([]);
    const candidates = assessmentBodyCandidates(row);
    this.transferCandidates.set(candidates);
    try {
      const fingerprint = await assessmentBodyFingerprint(row);
      this.transferFingerprint.set(fingerprint);
      const entries = await this.bodyRepository.entries();
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      const byNotes = assessmentBodyTransferredFields(row, candidates, entries);
      const byFingerprint = await Promise.all(
        candidates.map(async (candidate) => {
          const marker = await this.db.meta.get(
            assessmentBodyTransferKey(fingerprint, candidate.field),
          );
          if (typeof marker?.value !== 'string') return null;
          const entry = byId.get(marker.value);
          if (!entry || !entry.note.includes('[assessment:')) return null;
          const savedFields = entry.note.match(/\[assessment-fields:([a-zA-Z0-9_,]+)\]/)?.[1];
          if (savedFields && !savedFields.split(',').includes(candidate.field)) return null;
          return assessmentBodyEntryMatchesField(row, candidate, entry) ? candidate.field : null;
        }),
      );
      this.transferredFields.set([
        ...new Set([...byNotes, ...byFingerprint.filter((field) => field !== null)]),
      ]);
      this.transferAlready.set(
        candidates.length > 0 && this.transferredFields().length === candidates.length,
      );
      this.transferCheckComplete.set(true);
    } catch {
      this.transferError.set(
        $localize`:@@training.assessments.transfer.check-failed:Não foi possível conferir o histórico local do Corpo. Tente novamente.`,
      );
    } finally {
      this.transferLoading.set(false);
    }
  }

  protected closeBodyTransfer(): void {
    this.transferOpen.set(false);
    this.selectedTransferKeys.set([]);
  }

  protected transferInputId(candidate: AssessmentBodyCandidate): string {
    return `body-transfer-${candidate.key}`;
  }

  protected isTransferSelected(key: string): boolean {
    return this.selectedTransferKeys().includes(key);
  }

  protected isTransferFieldDone(field: AssessmentBodyField): boolean {
    return this.transferredFields().includes(field);
  }

  protected toggleTransferCandidate(key: string, checked: boolean): void {
    this.selectedTransferKeys.update((keys) =>
      checked ? [...new Set([...keys, key])] : keys.filter((item) => item !== key),
    );
    this.transferError.set('');
  }

  protected candidateProvenance(candidate: AssessmentBodyCandidate): string {
    return [
      this.kindLabel(candidate.measure.kind),
      candidate.measure.method ? `${this.methodPrefix}: ${candidate.measure.method}` : '',
      candidate.measure.source ? `${this.sourcePrefix}: ${candidate.measure.source}` : '',
    ]
      .filter(Boolean)
      .join(' · ');
  }

  protected candidateValueText(candidate: AssessmentBodyCandidate): string {
    const value = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 }).format(
      candidate.value,
    );
    return `${value} ${candidate.unit}`;
  }

  protected async saveBodyTransfer(): Promise<void> {
    const row = this.assessment();
    const selected = this.selectedTransferCandidates();
    const fingerprint = this.transferFingerprint();
    if (
      !row ||
      !this.transferCheckComplete() ||
      !fingerprint ||
      selected.length === 0 ||
      selected.some(({ field }) => this.isTransferFieldDone(field)) ||
      this.transferNoteTooLong()
    )
      return;
    this.transferSaving.set(true);
    this.transferError.set('');
    try {
      const result = await this.bodyRepository.saveEntry(assessmentBodyDraft(row, selected));
      if (result.status === 'saved') {
        this.transferredFields.update((fields) => [
          ...new Set([...fields, ...selected.map(({ field }) => field)]),
        ]);
        await this.db.transaction('rw', this.db.meta, async () => {
          await Promise.all(
            selected.map(({ field }) =>
              this.db.meta.put({
                key: assessmentBodyTransferKey(fingerprint, field),
                value: result.entry.id,
              }),
            ),
          );
        });
        this.message.set(
          $localize`:@@training.assessments.transfer.saved:Os campos selecionados foram registrados no Corpo com a data e a origem da avaliação.`,
        );
        this.closeBodyTransfer();
      } else if (result.status === 'storage-full') {
        this.transferError.set(
          $localize`:@@training.assessments.transfer.storage:Sem espaço no aparelho para guardar as medidas. Libere espaço e tente novamente.`,
        );
      } else if (result.status === 'invalid') {
        this.transferError.set(
          $localize`:@@training.assessments.transfer.invalid:As medidas ou a data não podem ser registradas no Corpo. Confira o histórico antes de tentar novamente.`,
        );
      } else {
        this.transferError.set(
          $localize`:@@training.assessments.transfer.failed:Não foi possível registrar as medidas no Corpo. Tente novamente.`,
        );
      }
    } catch {
      this.transferError.set(
        $localize`:@@training.assessments.transfer.failed:Não foi possível registrar as medidas no Corpo. Tente novamente.`,
      );
    } finally {
      this.transferSaving.set(false);
    }
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
