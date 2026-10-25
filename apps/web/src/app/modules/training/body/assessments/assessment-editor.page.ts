import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import type { PhysicalAssessmentMeasure } from '../../data/physical-assessments/physical-assessment';
import {
  ASSESSMENT_DOCUMENT_MAX_BYTES,
  ASSESSMENT_DOCUMENTS_MAX_BYTES,
  PhysicalAssessmentRepository,
} from '../../data/physical-assessments/physical-assessment-repository';
import { measureLabel } from './assessment-format';

interface AssessmentFormDraft {
  assessedOn: string;
  origin: string;
  professional: string;
  reportedAgeYears: string;
  statedGoal: string;
  activityStatus: string;
  plannedFrequencyPerWeek: string;
  notes: string;
}

function todayKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

@Component({
  selector: 'app-physical-assessment-editor-page',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page" aria-labelledby="title">
      <a
        class="back"
        routerLink="/treino/corpo/avaliacoes"
        i18n="@@training.assessments.cancel-back"
        >‹ Avaliações</a
      >
      <header>
        <p class="eyebrow" i18n="@@training.assessments.editor-eyebrow">
          Dados guardados neste aparelho
        </p>
        <h1 id="title">{{ editing() ? editTitle : newTitle }}</h1>
      </header>
      <form (ngSubmit)="save()">
        <fieldset>
          <legend i18n="@@training.assessments.identification">Identificação do registro</legend>
          <label for="assessedOn" i18n="@@training.assessments.date">Data da avaliação</label>
          <input
            id="assessedOn"
            name="assessedOn"
            type="date"
            required
            [(ngModel)]="draft.assessedOn"
          />
          <label for="origin" i18n="@@training.assessments.origin"
            >Origem / clínica / sistema</label
          >
          <input id="origin" name="origin" autocomplete="organization" [(ngModel)]="draft.origin" />
          <label for="professional" i18n="@@training.assessments.professional"
            >Profissional informado</label
          >
          <input id="professional" name="professional" [(ngModel)]="draft.professional" />
        </fieldset>
        <fieldset>
          <legend i18n="@@training.assessments.report-context">
            Contexto informado no relatório
          </legend>
          <label for="age" i18n="@@training.assessments.reported-age"
            >Idade na data (se constar)</label
          >
          <input
            id="age"
            name="age"
            type="number"
            min="0"
            max="130"
            [(ngModel)]="draft.reportedAgeYears"
          />
          <label for="goal" i18n="@@training.assessments.goal">Objetivo informado</label>
          <input id="goal" name="goal" [(ngModel)]="draft.statedGoal" />
          <label for="activity" i18n="@@training.assessments.activity">Atividade informada</label>
          <input id="activity" name="activity" [(ngModel)]="draft.activityStatus" />
          <label for="frequency" i18n="@@training.assessments.frequency"
            >Frequência planejada informada</label
          >
          <input
            id="frequency"
            name="frequency"
            type="number"
            min="0"
            max="14"
            [(ngModel)]="draft.plannedFrequencyPerWeek"
          />
        </fieldset>
        <fieldset>
          <legend i18n="@@training.assessments.measurements-title">Medidas e resultados</legend>
          <p class="hint" i18n="@@training.assessments.measure-help">
            Mantenha o valor como aparece no documento. Campos vazios não serão registrados.
          </p>
          @for (measure of measures(); track $index) {
            <article class="measure-row">
              <label [for]="'type-' + $index" i18n="@@training.assessments.measure-type"
                >Medida</label
              >
              <input
                [id]="'type-' + $index"
                [name]="'type-' + $index"
                [ngModel]="measure.type"
                (ngModelChange)="updateMeasure($index, 'type', $event)"
                list="measure-types"
              />
              <label [for]="'value-' + $index" i18n="@@training.assessments.measure-value"
                >Valor</label
              >
              <div class="value-line">
                <input
                  [id]="'value-' + $index"
                  [name]="'value-' + $index"
                  [ngModel]="measure.reportedValue"
                  (ngModelChange)="updateMeasure($index, 'reportedValue', $event)"
                />
                <input
                  [attr.aria-label]="unitLabel"
                  [name]="'unit-' + $index"
                  [ngModel]="measure.unit"
                  (ngModelChange)="updateMeasure($index, 'unit', $event)"
                />
              </div>
              <label [for]="'kind-' + $index" i18n="@@training.assessments.result-kind"
                >Tipo do resultado</label
              >
              <select
                [id]="'kind-' + $index"
                [name]="'kind-' + $index"
                [ngModel]="measure.kind"
                (ngModelChange)="updateMeasure($index, 'kind', $event)"
              >
                <option value="measured" i18n="@@training.assessments.kind.measured">Medido</option>
                <option value="calculated" i18n="@@training.assessments.kind.calculated">
                  Calculado pela origem
                </option>
                <option value="reference" i18n="@@training.assessments.kind.reference">
                  Referência sugerida
                </option>
              </select>
              <label [for]="'side-' + $index" i18n="@@training.assessments.side">Lado</label>
              <select
                [id]="'side-' + $index"
                [name]="'side-' + $index"
                [ngModel]="measure.side ?? ''"
                (ngModelChange)="updateMeasure($index, 'side', $event)"
              >
                <option value="" i18n="@@training.assessments.side.none">Não se aplica</option>
                <option value="left" i18n="@@training.assessments.left">Esquerdo</option>
                <option value="right" i18n="@@training.assessments.right">Direito</option>
              </select>
              <label [for]="'method-' + $index" i18n="@@training.assessments.method">Método</label>
              <input
                [id]="'method-' + $index"
                [name]="'method-' + $index"
                [ngModel]="measure.method ?? ''"
                (ngModelChange)="updateMeasure($index, 'method', $event)"
              />
              <label [for]="'source-' + $index" i18n="@@training.assessments.provenance"
                >Procedência deste campo</label
              >
              <input
                [id]="'source-' + $index"
                [name]="'source-' + $index"
                [ngModel]="measure.source ?? ''"
                (ngModelChange)="updateMeasure($index, 'source', $event)"
              />
              <button
                type="button"
                class="remove"
                (click)="removeMeasure($index)"
                [attr.aria-label]="removeMeasureLabel($index)"
                i18n="@@training.assessments.remove-measure"
              >
                Remover medida
              </button>
            </article>
          }
          <datalist id="measure-types">
            @for (type of knownTypes; track type) {
              <option [value]="type">{{ label(type) }}</option>
            }
          </datalist>
          <button
            type="button"
            class="secondary"
            (click)="addMeasure()"
            i18n="@@training.assessments.add-measure"
          >
            Adicionar medida
          </button>
        </fieldset>
        <fieldset>
          <legend i18n="@@training.assessments.attach-title">Fotos do relatório</legend>
          <p class="hint" i18n="@@training.assessments.attach-local">
            Os arquivos selecionados ficam somente neste aparelho e não são enviados.
          </p>
          <label for="documents" i18n="@@training.assessments.choose-images"
            >Escolher imagens JPEG, PNG ou WebP</label
          >
          <input
            id="documents"
            type="file"
            accept="image/jpeg,image/png,image/webp,image/heic,image/heif"
            i18n-accept="@@training.assessments.accept-images"
            multiple
            (change)="attach($event)"
          />
          @if (documents() + pendingDocuments().length) {
            <p class="hint">
              {{ documents() + pendingDocuments().length }} {{ documentCountLabel }}
            </p>
          }
          @if (pendingDocuments().length) {
            <p class="hint" i18n="@@training.assessments.pending-files">
              As novas imagens serão guardadas somente ao salvar a avaliação.
            </p>
          }
        </fieldset>
        <fieldset>
          <legend i18n="@@training.assessments.notes-title">Observações</legend>
          <label for="notes" i18n="@@training.assessments.notes-label"
            >Observações do registro</label
          >
          <textarea id="notes" name="notes" rows="4" [(ngModel)]="draft.notes"></textarea>
        </fieldset>
        @if (status()) {
          <p class="status" role="status">{{ status() }}</p>
        }
        <button
          class="primary"
          type="button"
          [disabled]="saving()"
          (click)="save()"
          i18n="@@training.assessments.save"
        >
          Salvar avaliação
        </button>
      </form>
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
    header {
      display: grid;
      gap: 4px;
    }
    h1,
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
    .eyebrow,
    .hint {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    form {
      display: grid;
      gap: var(--space-3);
    }
    fieldset {
      display: grid;
      gap: 8px;
      min-width: 0;
      margin: 0;
      padding: var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
    }
    legend {
      padding: 0 5px;
      font-weight: 700;
    }
    label {
      margin-top: 3px;
      font-size: var(--fs-small);
      font-weight: 600;
    }
    input,
    select,
    textarea {
      width: 100%;
      min-height: 44px;
      box-sizing: border-box;
      padding: 8px 10px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm, 8px);
      color: var(--a-ink);
      background: var(--a-surface);
      font: inherit;
    }
    input[type='file'] {
      height: auto;
    }
    textarea {
      resize: vertical;
    }
    .measure-row {
      display: grid;
      gap: 5px;
      padding: var(--space-2) 0;
      border-top: 1px solid var(--a-line);
    }
    .value-line {
      display: grid;
      grid-template-columns: 1fr 78px;
      gap: 6px;
    }
    .primary,
    .secondary,
    .remove {
      min-height: var(--tap);
      padding: 8px 12px;
      border: 0;
      border-radius: var(--radius-sm);
      font: inherit;
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
    .remove {
      justify-self: start;
      color: var(--a-danger, #a11);
      background: transparent;
    }
    .status {
      padding: var(--space-2);
      border-radius: var(--radius-sm);
      background: var(--a-surface-2);
    }
    :focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhysicalAssessmentEditorPage {
  private readonly repository = inject(PhysicalAssessmentRepository);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private persistedId: string | undefined;
  protected readonly editing = signal(false);
  protected readonly measures = signal<PhysicalAssessmentMeasure[]>([]);
  protected readonly documents = signal(0);
  protected readonly pendingDocuments = signal<File[]>([]);
  protected readonly saving = signal(false);
  protected readonly status = signal('');
  protected readonly draft: AssessmentFormDraft = {
    assessedOn: todayKey(),
    origin: '',
    professional: '',
    reportedAgeYears: '',
    statedGoal: '',
    activityStatus: '',
    plannedFrequencyPerWeek: '',
    notes: '',
  };
  protected readonly editTitle = $localize`:@@training.assessments.edit-title:Editar avaliação`;
  protected readonly newTitle = $localize`:@@training.assessments.new-title:Nova avaliação`;
  protected readonly unitLabel = $localize`:@@training.assessments.unit:Unidade`;
  protected readonly documentCountLabel = $localize`:@@training.assessments.files-selected:arquivo(s) selecionado(s)`;
  protected readonly knownTypes = [
    'weight',
    'height',
    'body-fat',
    'lean-mass',
    'fat-mass',
    'chest',
    'abdomen',
    'waist',
    'neck',
    'hip',
    'arm-relaxed',
    'arm-contracted',
    'forearm',
    'thigh',
    'calf',
    'skinfold-chest',
    'skinfold-abdominal',
    'skinfold-thigh',
    'skinfold-triceps',
    'skinfold-suprailiac',
    'body-density',
    'pollock-3-body-fat',
  ];
  protected readonly label = measureLabel;

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) {
      this.persistedId = id;
      this.editing.set(true);
      void this.load(id);
    }
  }

  protected addMeasure(): void {
    this.measures.update((rows) => [
      ...rows,
      { type: '', reportedValue: '', unit: '', kind: 'measured', side: null },
    ]);
  }

  protected removeMeasure(index: number): void {
    this.measures.update((rows) => rows.filter((_, i) => i !== index));
  }

  protected updateMeasure(index: number, key: string, value: string): void {
    this.measures.update((rows) =>
      rows.map((row, i) => {
        if (i !== index) return row;
        if (key === 'kind') return { ...row, kind: value as PhysicalAssessmentMeasure['kind'] };
        if (key === 'side')
          return { ...row, side: (value || null) as PhysicalAssessmentMeasure['side'] };
        if (key === 'reportedValue') return { ...row, reportedValue: value };
        if (key === 'type') return { ...row, type: value };
        if (key === 'unit') return { ...row, unit: value };
        if (key === 'method') return { ...row, method: value || null };
        if (key === 'source') return { ...row, source: value || null };
        return row;
      }),
    );
  }

  protected removeMeasureLabel(index: number): string {
    return $localize`:@@training.assessments.remove-measure-label:Remover medida ${index + 1}:index:`;
  }

  protected attach(event: Event): void {
    const input = event.target as HTMLInputElement;
    const files = [...(input.files ?? [])];
    if (!files.length) return;
    const next = [...this.pendingDocuments(), ...files];
    let total = 0;
    for (const file of next) {
      if (
        !['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'].includes(
          file.type.toLowerCase(),
        )
      ) {
        this.status.set(this.documentError('invalid-type'));
        input.value = '';
        return;
      }
      if (file.size > ASSESSMENT_DOCUMENT_MAX_BYTES) {
        this.status.set(this.documentError('too-large'));
        input.value = '';
        return;
      }
      total += file.size;
    }
    if (total > ASSESSMENT_DOCUMENTS_MAX_BYTES) {
      this.status.set(this.documentError('too-large'));
      input.value = '';
      return;
    }
    this.pendingDocuments.set(next);
    this.status.set(
      $localize`:@@training.assessments.documents-staged:Imagens selecionadas. Toque em Salvar avaliação para guardá-las neste aparelho.`,
    );
    input.value = '';
  }

  protected async save(): Promise<void> {
    if (this.saving()) return;
    this.saving.set(true);
    this.status.set($localize`:@@training.assessments.saving:Salvando a avaliação neste aparelho…`);
    try {
      const id = await this.saveDraft();
      if (id) {
        while (this.pendingDocuments().length) {
          const file = this.pendingDocuments()[0];
          const result = await this.repository.addDocument(id, file, file.name);
          if (result.status !== 'saved') {
            this.status.set(this.documentError(result.status));
            return;
          }
          this.pendingDocuments.update((rows) => rows.slice(1));
          this.documents.update((count) => count + 1);
        }
        this.status.set(
          $localize`:@@training.assessments.saved:Registro salvo somente neste aparelho.`,
        );
        const navigated = await this.router.navigateByUrl(`/treino/corpo/avaliacoes/${id}`);
        if (!navigated)
          this.status.set(
            $localize`:@@training.assessments.navigation-failed:Registro salvo. Abra-o pela lista de avaliações.`,
          );
      }
    } catch {
      this.status.set(
        $localize`:@@training.assessments.save-failed:Não foi possível salvar a avaliação neste aparelho. Tente novamente.`,
      );
    } finally {
      this.saving.set(false);
    }
  }

  private async saveDraft(): Promise<string | null> {
    if (!this.draft.assessedOn) {
      this.status.set(
        $localize`:@@training.assessments.date-required:Informe a data da avaliação.`,
      );
      return null;
    }
    const measurements = this.measures()
      .filter((row) => row.type.trim() && String(row.reportedValue).trim())
      .map((row) => ({ ...row, type: row.type.trim(), unit: row.unit.trim() }));
    const row = await this.repository.save(
      {
        assessedOn: this.draft.assessedOn,
        origin: this.draft.origin.trim() || null,
        professional: this.draft.professional.trim() || null,
        reportedAgeYears: this.draft.reportedAgeYears ? Number(this.draft.reportedAgeYears) : null,
        statedGoal: this.draft.statedGoal.trim() || null,
        activityStatus: this.draft.activityStatus.trim() || null,
        plannedFrequencyPerWeek: this.draft.plannedFrequencyPerWeek
          ? Number(this.draft.plannedFrequencyPerWeek)
          : null,
        notes: this.draft.notes.trim() || null,
        measurements,
      },
      this.persistedId,
    );
    this.persistedId = row.id;
    return row.id;
  }

  private async load(id: string): Promise<void> {
    const row = await this.repository.get(id);
    if (!row) {
      this.status.set($localize`:@@training.assessments.not-found:Avaliação não encontrada.`);
      return;
    }
    Object.assign(this.draft, {
      assessedOn: row.assessedOn,
      origin: row.origin ?? '',
      professional: row.professional ?? '',
      reportedAgeYears: row.reportedAgeYears == null ? '' : String(row.reportedAgeYears),
      statedGoal: row.statedGoal ?? '',
      activityStatus: row.activityStatus ?? '',
      plannedFrequencyPerWeek:
        row.plannedFrequencyPerWeek == null ? '' : String(row.plannedFrequencyPerWeek),
      notes: row.notes ?? '',
    });
    this.measures.set([...(row.measurements ?? [])]);
    this.documents.set((await this.repository.documents(id)).length);
  }

  private documentError(status: string): string {
    if (status === 'invalid-type')
      return $localize`:@@training.assessments.document-type-error:Esse formato de imagem não é aceito.`;
    if (status === 'too-large')
      return $localize`:@@training.assessments.document-size-error:O arquivo ou o total de arquivos passa do limite de armazenamento.`;
    if (status === 'storage-full')
      return $localize`:@@training.assessments.storage-full:O navegador não tem espaço suficiente para salvar este arquivo.`;
    return $localize`:@@training.assessments.document-error:Não foi possível salvar este arquivo.`;
  }
}
