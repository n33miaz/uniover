import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import type {
  LocalPhysicalAssessment,
  PhysicalAssessmentMeasure,
} from '../../data/physical-assessments/physical-assessment';
import {
  ASSESSMENT_DOCUMENT_MAX_BYTES,
  ASSESSMENT_DOCUMENTS_MAX_BYTES,
  PhysicalAssessmentRepository,
} from '../../data/physical-assessments/physical-assessment-repository';
import { assessmentTitle, KIND_LABELS } from './assessment-format';

interface ImportCandidate {
  readonly key: string;
  readonly label: string;
  value: string;
  selected: boolean;
  measure?: MeasureDraft;
}

interface MeasureDraft {
  type: string;
  reportedValue: string;
  unit: string;
  kind: PhysicalAssessmentMeasure['kind'];
  side: 'left' | 'right' | '';
  method: string;
  source: string;
}

interface ImportedDocument {
  readonly name: string;
  readonly mediaType: string;
  readonly dataBase64: string;
  selected: boolean;
}

interface PreparedDocument {
  readonly name: string;
  readonly mediaType: string;
  readonly blob: Blob;
}

interface ImportAssessment {
  assessedOn?: string;
  origin?: string | null;
  professional?: string | null;
  reportedAgeYears?: number | null;
  statedGoal?: string | null;
  activityStatus?: string | null;
  plannedFrequencyPerWeek?: number | null;
  notes?: string | null;
  measurements?: PhysicalAssessmentMeasure[];
  documents?: ImportedDocument[];
}

const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

@Component({
  selector: 'app-physical-assessment-import-page',
  imports: [FormsModule, RouterLink],
  template: `
    <div class="page" aria-labelledby="title">
      <a class="back" routerLink="/treino/corpo/avaliacoes" i18n="@@training.assessments.back-list"
        >‹ Avaliações</a
      >
      <header>
        <p class="eyebrow" i18n="@@training.assessments.import-eyebrow">Prévia antes de gravar</p>
        <h1 id="title" i18n="@@training.assessments.import-title">Importar avaliação</h1>
      </header>
      <p class="explanation" i18n="@@training.assessments.import-help">
        Escolha um JSON exportado por uma avaliação do UniOver. Confira a procedência e marque cada
        campo que deseja guardar. Nada é importado sem sua confirmação.
      </p>
      <label class="file-label" for="assessment-file" i18n="@@training.assessments.choose-json"
        >Escolher arquivo JSON</label
      >
      <input
        id="assessment-file"
        type="file"
        accept="application/json,.json"
        i18n-accept="@@training.assessments.accept-json"
        (change)="readFile($event)"
      />
      @if (status()) {
        <p class="status" role="status">{{ status() }}</p>
      }
      @if (assessment(); as row) {
        <section class="preview-card" aria-label="{{ previewLabel }}">
          <h2>{{ title(row) }}</h2>
          <p class="origin">
            {{ row.origin || missingOrigin }}
            @if (row.professional) {
              · {{ row.professional }}
            }
          </p>
          <p class="privacy" i18n="@@training.assessments.import-local-warning">
            A avaliação e os arquivos selecionados serão guardados apenas neste aparelho.
          </p>
        </section>
        <fieldset>
          <legend i18n="@@training.assessments.confirm-fields">
            Confirme cada campo a importar
          </legend>
          @for (candidate of candidates(); track candidate.key) {
            <article class="candidate">
              <label class="confirm-field">
                <input
                  type="checkbox"
                  [ngModel]="candidate.selected"
                  [name]="'confirm-' + candidate.key"
                  (ngModelChange)="setCandidate(candidate.key, $event)"
                />
                <span
                  ><strong>{{ candidate.label }}</strong
                  ><small>{{ candidate.value }}</small></span
                >
              </label>
              @if (candidate.measure; as measure) {
                <div class="measure-edit">
                  <label [for]="'type-' + candidate.key" i18n="@@training.assessments.measure-type"
                    >Medida</label
                  >
                  <input
                    [id]="'type-' + candidate.key"
                    [name]="'type-' + candidate.key"
                    [(ngModel)]="measure.type"
                  />
                  <label
                    [for]="'value-' + candidate.key"
                    i18n="@@training.assessments.measure-value"
                    >Valor</label
                  >
                  <div class="value-line">
                    <input
                      [id]="'value-' + candidate.key"
                      [name]="'value-' + candidate.key"
                      [(ngModel)]="measure.reportedValue"
                    />
                    <input
                      [attr.aria-label]="unitLabel"
                      [name]="'unit-' + candidate.key"
                      [(ngModel)]="measure.unit"
                    />
                  </div>
                  <label [for]="'kind-' + candidate.key" i18n="@@training.assessments.result-kind"
                    >Tipo do resultado</label
                  >
                  <select
                    [id]="'kind-' + candidate.key"
                    [name]="'kind-' + candidate.key"
                    [(ngModel)]="measure.kind"
                  >
                    <option value="measured" i18n="@@training.assessments.kind.measured">
                      Medido
                    </option>
                    <option value="calculated" i18n="@@training.assessments.kind.calculated">
                      Calculado pela origem
                    </option>
                    <option value="reference" i18n="@@training.assessments.kind.reference">
                      Referência sugerida
                    </option>
                  </select>
                  <label [for]="'side-' + candidate.key" i18n="@@training.assessments.side"
                    >Lado</label
                  >
                  <select
                    [id]="'side-' + candidate.key"
                    [name]="'side-' + candidate.key"
                    [(ngModel)]="measure.side"
                  >
                    <option value="" i18n="@@training.assessments.side.none">Não se aplica</option>
                    <option value="left" i18n="@@training.assessments.left">Esquerdo</option>
                    <option value="right" i18n="@@training.assessments.right">Direito</option>
                  </select>
                  <label [for]="'method-' + candidate.key" i18n="@@training.assessments.method"
                    >Método</label
                  >
                  <input
                    [id]="'method-' + candidate.key"
                    [name]="'method-' + candidate.key"
                    [(ngModel)]="measure.method"
                  />
                  <label [for]="'source-' + candidate.key" i18n="@@training.assessments.provenance"
                    >Procedência deste campo</label
                  >
                  <input
                    [id]="'source-' + candidate.key"
                    [name]="'source-' + candidate.key"
                    [(ngModel)]="measure.source"
                  />
                </div>
              } @else {
                <label
                  class="candidate-value"
                  [for]="'field-' + candidate.key"
                  i18n="@@training.assessments.imported-value"
                  >Valor importado / edição</label
                >
                <input
                  [id]="'field-' + candidate.key"
                  [name]="'field-' + candidate.key"
                  [(ngModel)]="candidate.value"
                />
              }
            </article>
          }
        </fieldset>
        @if (importedDocuments().length) {
          <fieldset>
            <legend i18n="@@training.assessments.confirm-files">
              Confirme as imagens a guardar neste aparelho
            </legend>
            <p class="privacy" i18n="@@training.assessments.files-never-uploaded">
              As imagens não serão enviadas nem sincronizadas.
            </p>
            @for (doc of importedDocuments(); track $index) {
              <label class="candidate">
                <input
                  type="checkbox"
                  [checked]="doc.selected"
                  [name]="'document-' + $index"
                  [id]="'document-' + $index"
                  (change)="setDocument($index, $any($event.target).checked)"
                />
                <span
                  ><strong>{{ doc.name }}</strong
                  ><small>{{ doc.mediaType }}</small></span
                >
              </label>
            }
          </fieldset>
        }
        <button
          class="primary"
          type="button"
          [disabled]="saving()"
          (click)="confirmImport()"
          i18n="@@training.assessments.confirm-import"
        >
          Confirmar campos selecionados
        </button>
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
    .explanation,
    .privacy {
      color: var(--a-ink2);
      font-size: var(--fs-small);
    }
    .file-label {
      min-height: 44px;
      display: flex;
      align-items: center;
      font-weight: 650;
    }
    input[type='file'] {
      width: 100%;
      min-height: 44px;
    }
    .preview-card,
    fieldset {
      display: grid;
      gap: var(--space-2);
      padding: var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius-md);
    }
    fieldset {
      min-width: 0;
      margin: 0;
    }
    legend {
      padding: 0 5px;
      font-weight: 700;
    }
    .candidate {
      display: grid;
      gap: 6px;
      padding: var(--space-2) 0;
      border-bottom: 1px solid var(--a-line);
    }
    .confirm-field {
      display: grid;
      grid-template-columns: 24px 1fr;
      gap: var(--space-2);
      align-items: start;
      min-height: 40px;
      padding: 6px 0;
    }
    .confirm-field input {
      width: 20px;
      height: 20px;
      margin: 2px;
      accent-color: var(--a-accent);
    }
    .confirm-field span {
      display: grid;
      gap: 2px;
    }
    .confirm-field small {
      color: var(--a-ink2);
      overflow-wrap: anywhere;
    }
    .candidate-value,
    .measure-edit {
      display: grid;
      gap: 5px;
    }
    .candidate > input,
    .measure-edit input,
    .measure-edit select {
      width: 100%;
      min-height: 40px;
      box-sizing: border-box;
      padding: 7px 9px;
      border: 1px solid var(--a-line);
      border-radius: var(--radius-sm, 8px);
      color: var(--a-ink);
      background: var(--a-surface);
      font: inherit;
    }
    .measure-edit label,
    .candidate-value {
      font-size: var(--fs-small);
      font-weight: 600;
    }
    .value-line {
      display: grid;
      grid-template-columns: 1fr 78px;
      gap: 6px;
    }
    .privacy {
      padding: var(--space-2);
      border-radius: var(--radius-sm, 8px);
      background: var(--a-surface2);
    }
    .status {
      padding: var(--space-2);
      border-radius: var(--radius-md);
      background: var(--a-surface2);
    }
    .primary {
      min-height: var(--tap);
      border: 0;
      border-radius: var(--radius-md);
      color: var(--a-on-accent, white);
      background: var(--a-accent);
      font: inherit;
      font-weight: 700;
    }
    :focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 3px;
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PhysicalAssessmentImportPage {
  private readonly repository = inject(PhysicalAssessmentRepository);
  private readonly router = inject(Router);
  protected readonly assessment = signal<ImportAssessment | null>(null);
  protected readonly candidates = signal<ImportCandidate[]>([]);
  protected readonly importedDocuments = signal<ImportedDocument[]>([]);
  protected readonly status = signal('');
  protected readonly saving = signal(false);
  protected readonly unitLabel = $localize`:@@training.assessments.unit:Unidade`;
  protected readonly title = (row: ImportAssessment) =>
    row.assessedOn
      ? assessmentTitle({ ...row, id: '', createdAt: 0, updatedAt: 0 } as LocalPhysicalAssessment)
      : '';
  protected readonly previewLabel = $localize`:@@training.assessments.import-preview:Prévia do registro`;
  protected readonly missingOrigin = $localize`:@@training.assessments.unknown-origin:Origem não informada`;

  protected async readFile(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    this.assessment.set(null);
    this.candidates.set([]);
    this.importedDocuments.set([]);
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      this.status.set(
        $localize`:@@training.assessments.import-too-large:O arquivo ultrapassa o limite de 64 MB.`,
      );
      input.value = '';
      return;
    }
    try {
      const value: unknown = JSON.parse(await file.text());
      const row = this.validate(value);
      this.assessment.set(row);
      this.candidates.set(this.buildCandidates(row));
      this.importedDocuments.set(
        (row.documents ?? []).map((document) => ({ ...document, selected: false })),
      );
      this.status.set(
        $localize`:@@training.assessments.preview-ready:Prévia carregada. Revise e confirme cada campo.`,
      );
    } catch {
      this.status.set(
        $localize`:@@training.assessments.import-invalid:Não foi possível ler este arquivo. Escolha um JSON exportado pelo UniOver com uma avaliação física.`,
      );
    }
    input.value = '';
  }

  protected setCandidate(key: string, selected: boolean): void {
    this.candidates.update((rows) =>
      rows.map((row) => (row.key === key ? { ...row, selected } : row)),
    );
  }

  protected setDocument(index: number, selected: boolean): void {
    this.importedDocuments.update((rows) =>
      rows.map((row, current) => (current === index ? { ...row, selected } : row)),
    );
  }

  protected async confirmImport(): Promise<void> {
    const source = this.assessment();
    if (!source) return;
    const chosen = this.candidates().filter((candidate) => candidate.selected);
    const date = chosen.find((candidate) => candidate.key === 'assessedOn')?.value;
    if (!date || !isDateKey(date)) {
      this.status.set(
        $localize`:@@training.assessments.import-date-required:Confirme uma data válida para a avaliação antes de continuar.`,
      );
      return;
    }
    const invalidMeasure = chosen.some(
      (candidate) =>
        candidate.measure &&
        (!candidate.measure.type.trim() || !candidate.measure.reportedValue.trim()),
    );
    const invalidNumber = chosen.some(
      (candidate) =>
        (candidate.key === 'reportedAgeYears' || candidate.key === 'plannedFrequencyPerWeek') &&
        candidate.value.trim() !== '' &&
        parseOptionalNumber(candidate.value.trim()) === null,
    );
    if (invalidMeasure || invalidNumber) {
      this.status.set(
        $localize`:@@training.assessments.import-invalid-field:Corrija ou desmarque os campos inválidos antes de salvar. Nada foi importado.`,
      );
      return;
    }
    const picked = new Map(chosen.map((candidate) => [candidate.key, candidate.value]));
    const measurements: PhysicalAssessmentMeasure[] = this.candidates().flatMap((candidate) => {
      const measure = candidate.selected ? candidate.measure : undefined;
      if (!measure || !measure.type.trim() || !measure.reportedValue.trim()) return [];
      return [
        {
          type: measure.type.trim(),
          reportedValue: measure.reportedValue,
          unit: measure.unit.trim(),
          kind: measure.kind,
          side: measure.side || null,
          method: measure.method.trim() || null,
          source: measure.source.trim() || null,
        },
      ];
    });
    let prepared: PreparedDocument[];
    try {
      prepared = this.prepareDocuments(
        this.importedDocuments().filter((document) => document.selected),
      );
    } catch {
      this.status.set(
        $localize`:@@training.assessments.invalid-files:Não foi possível validar as imagens escolhidas. Nenhum dado foi salvo.`,
      );
      return;
    }
    this.saving.set(true);
    let savedId: string | null = null;
    try {
      const row = await this.repository.save({
        assessedOn: date,
        origin: picked.get('origin')?.trim() || null,
        professional: picked.get('professional')?.trim() || null,
        reportedAgeYears: parseOptionalNumber(picked.get('reportedAgeYears')),
        statedGoal: picked.get('statedGoal')?.trim() || null,
        activityStatus: picked.get('activityStatus')?.trim() || null,
        plannedFrequencyPerWeek: parseOptionalNumber(picked.get('plannedFrequencyPerWeek')),
        notes: picked.get('notes')?.trim() || null,
        measurements,
      });
      savedId = row.id;
      for (const document of prepared) {
        const result = await this.repository.addDocument(row.id, document.blob, document.name);
        if (result.status !== 'saved') throw new Error('Documento não salvo');
      }
    } catch {
      if (savedId) {
        try {
          await this.repository.delete(savedId);
        } catch {
          this.status.set(
            $localize`:@@training.assessments.import-partial-failure:O navegador não conseguiu concluir nem reverter a importação. Confira a lista antes de tentar novamente.`,
          );
          return;
        }
      }
      this.status.set(
        $localize`:@@training.assessments.import-failed:Não foi possível salvar a avaliação. Nenhuma parte dela foi mantida.`,
      );
      return;
    } finally {
      this.saving.set(false);
    }
    this.status.set(
      prepared.length
        ? $localize`:@@training.assessments.import-done-with-files:Campos confirmados; ${prepared.length}:count: arquivo(s) também foi(ram) salvo(s) neste aparelho.`
        : $localize`:@@training.assessments.import-done:Campos confirmados e salvos neste aparelho.`,
    );
    await this.router.navigate(['/treino/corpo/avaliacoes', savedId]);
  }

  private validate(value: unknown): ImportAssessment {
    if (
      !isRecord(value) ||
      value['exportType'] !== 'physical-assessment' ||
      !isRecord(value['assessment'])
    )
      throw new Error('Formato não reconhecido');
    const raw = value['assessment'];
    if (typeof raw['assessedOn'] !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw['assessedOn']))
      throw new Error('Data não reconhecida');
    const rawMeasurements = raw['measurements'] ?? [];
    const rawDocuments = raw['documents'] ?? [];
    if (!Array.isArray(rawMeasurements) || !rawMeasurements.every(isMeasure))
      throw new Error('Medição inválida');
    if (!Array.isArray(rawDocuments) || !rawDocuments.every(isDocument))
      throw new Error('Anexo inválido');
    const measurements = rawMeasurements;
    const documents: ImportedDocument[] = rawDocuments.map((document) => ({
      name: document['name'],
      mediaType: document['mediaType'],
      dataBase64: document['dataBase64'],
      selected: false,
    }));
    return {
      assessedOn: raw['assessedOn'],
      origin: stringOrNull(raw['origin']),
      professional: stringOrNull(raw['professional']),
      reportedAgeYears: numberOrNull(raw['reportedAgeYears']),
      statedGoal: stringOrNull(raw['statedGoal']),
      activityStatus: stringOrNull(raw['activityStatus']),
      plannedFrequencyPerWeek: numberOrNull(raw['plannedFrequencyPerWeek']),
      notes: stringOrNull(raw['notes']),
      measurements,
      documents,
    };
  }

  private buildCandidates(row: ImportAssessment): ImportCandidate[] {
    const candidates: ImportCandidate[] = [];
    const add = (key: string, label: string, value: unknown, selected = false) => {
      if (value === null || value === undefined || value === '') return;
      candidates.push({ key, label, value: String(value), selected });
    };
    add(
      'assessedOn',
      $localize`:@@training.assessments.date:Data da avaliação`,
      row.assessedOn,
      true,
    );
    add('origin', $localize`:@@training.assessments.origin:Origem / clínica / sistema`, row.origin);
    add(
      'professional',
      $localize`:@@training.assessments.professional:Profissional informado`,
      row.professional,
    );
    add(
      'reportedAgeYears',
      $localize`:@@training.assessments.reported-age:Idade na data`,
      row.reportedAgeYears,
    );
    add('statedGoal', $localize`:@@training.assessments.goal:Objetivo informado`, row.statedGoal);
    add(
      'activityStatus',
      $localize`:@@training.assessments.activity:Atividade informada`,
      row.activityStatus,
    );
    add(
      'plannedFrequencyPerWeek',
      $localize`:@@training.assessments.frequency:Frequência planejada`,
      row.plannedFrequencyPerWeek,
    );
    add('notes', $localize`:@@training.assessments.notes-title:Observações`, row.notes);
    for (const [index, measure] of (row.measurements ?? []).entries()) {
      const provenance = [measure.source, measure.method, KIND_LABELS[measure.kind]]
        .filter(Boolean)
        .join(' · ');
      candidates.push({
        key: `measurement-${index}`,
        label: $localize`:@@training.assessments.measure-field:Resultado ${index + 1}:index:`,
        value:
          `${measure.reportedValue} ${measure.unit}${provenance ? ` · ${provenance}` : ''}`.trim(),
        selected: false,
        measure: {
          type: measure.type,
          reportedValue: String(measure.reportedValue),
          unit: measure.unit,
          kind: measure.kind,
          side: measure.side ?? '',
          method: measure.method ?? '',
          source: measure.source ?? '',
        },
      });
    }
    return candidates;
  }

  private prepareDocuments(documents: readonly ImportedDocument[]): PreparedDocument[] {
    let totalBytes = 0;
    return documents.map((document) => {
      const bytes = base64ToBytes(document.dataBase64);
      if (bytes.byteLength > ASSESSMENT_DOCUMENT_MAX_BYTES)
        throw new Error('Imagem acima do limite');
      totalBytes += bytes.byteLength;
      if (totalBytes > ASSESSMENT_DOCUMENTS_MAX_BYTES)
        throw new Error('Total de imagens acima do limite');
      return {
        name: document.name,
        mediaType: document.mediaType,
        blob: new Blob([bytes], { type: document.mediaType }),
      };
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}
function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
function isMeasure(value: unknown): value is PhysicalAssessmentMeasure {
  if (!(
    isRecord(value) &&
    typeof value['type'] === 'string' &&
    (typeof value['reportedValue'] === 'string' || typeof value['reportedValue'] === 'number') &&
    typeof value['unit'] === 'string' &&
    ['measured', 'calculated', 'reference'].includes(String(value['kind']))
  ))
    return false;
  const side = value['side'];
  return (
    (side === undefined || side === null || side === 'left' || side === 'right') &&
    (value['method'] === undefined ||
      value['method'] === null ||
      typeof value['method'] === 'string') &&
    (value['source'] === undefined ||
      value['source'] === null ||
      typeof value['source'] === 'string')
  );
}
function isDocument(value: unknown): value is Record<string, string> {
  if (!(
    isRecord(value) &&
    typeof value['name'] === 'string' &&
    typeof value['mediaType'] === 'string' &&
    typeof value['dataBase64'] === 'string'
  ))
    return false;
  return (
    value['name'].length > 0 &&
    value['name'].length <= 255 &&
    ALLOWED_IMAGE_TYPES.has(value['mediaType'].toLowerCase()) &&
    base64ByteLength(value['dataBase64']) !== null &&
    hasExpectedImageSignature(value['dataBase64'], value['mediaType'].toLowerCase())
  );
}

function hasExpectedImageSignature(dataBase64: string, mediaType: string): boolean {
  const prefix = atob(dataBase64.slice(0, 32));
  const bytes = Array.from(prefix, (character) => character.charCodeAt(0));
  if (mediaType === 'image/jpeg')
    return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mediaType === 'image/png')
    return (
      bytes[0] === 0x89 &&
      bytes[1] === 0x50 &&
      bytes[2] === 0x4e &&
      bytes[3] === 0x47 &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    );
  if (mediaType === 'image/webp')
    return (
      bytes[0] === 0x52 &&
      bytes[1] === 0x49 &&
      bytes[2] === 0x46 &&
      bytes[3] === 0x46 &&
      bytes[8] === 0x57 &&
      bytes[9] === 0x45 &&
      bytes[10] === 0x42 &&
      bytes[11] === 0x50
    );
  if (mediaType === 'image/heic' || mediaType === 'image/heif') {
    const brand = prefix.slice(8, 12);
    return (
      prefix.slice(4, 8) === 'ftyp' &&
      ['heic', 'heix', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand)
    );
  }
  return false;
}
function parseOptionalNumber(value: string | undefined): number | null {
  return value !== undefined && /^\d+(\.\d+)?$/.test(value) ? Number(value) : null;
}
function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (base64ByteLength(value) === null) throw new Error('Base64 inválido');
  const binary = atob(value);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function base64ByteLength(value: string): number | null {
  if (
    !value ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  )
    return null;
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  const bytes = (value.length * 3) / 4 - padding;
  return bytes <= ASSESSMENT_DOCUMENT_MAX_BYTES ? bytes : null;
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}
