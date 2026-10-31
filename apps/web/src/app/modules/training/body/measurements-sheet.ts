import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import type { LocalBodyProfile } from '../data/body/body-profile';
import { BodyRepository } from '../data/body/body-repository';
import { NAVY_BODY_FAT_ENABLED } from '../domain/body/body-features';
import { type BodyEntryIssue, type FatMethod } from '../domain/body/body-limits';
import { navyBodyFat } from '../domain/body/navy-body-fat';
import { round1 } from '../domain/body/rounding';
import { TrainingSheet } from '../shell/training-sheet';
import { parseDecimal, toFieldText } from './body-text';

let nextMeasuresId = 0;

/** As medidas numéricas da folha, com o nome do campo da medição; o percentual de gordura tem trato próprio. */
type MeasureKey =
  | 'waistCm'
  | 'abdomenCm'
  | 'chestCm'
  | 'neckCm'
  | 'hipCm'
  | 'armRightCm'
  | 'armLeftCm'
  | 'forearmRightCm'
  | 'forearmLeftCm'
  | 'thighRightCm'
  | 'thighLeftCm'
  | 'calfRightCm'
  | 'calfLeftCm'
  | 'chestSkinfoldMm'
  | 'abdomenSkinfoldMm'
  | 'thighSkinfoldMm';
type DraftKey = MeasureKey | 'fat';

const MEASURE_KEYS: readonly MeasureKey[] = [
  'waistCm',
  'abdomenCm',
  'chestCm',
  'neckCm',
  'hipCm',
  'armRightCm',
  'armLeftCm',
  'forearmRightCm',
  'forearmLeftCm',
  'thighRightCm',
  'thighLeftCm',
  'calfRightCm',
  'calfLeftCm',
  'chestSkinfoldMm',
  'abdomenSkinfoldMm',
  'thighSkinfoldMm',
];

interface MeasureGroup {
  readonly key: string;
  readonly title: string;
  readonly fields: readonly { readonly key: MeasureKey; readonly label: string }[];
}

@Component({
  selector: 'app-body-measurements-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <div class="ui-field">
        <label [for]="dateId" i18n="@@training.body.measure.date">Dia</label>
        <input
          class="ui-input"
          [id]="dateId"
          type="date"
          min="1900-01-01"
          [max]="today()"
          [value]="dateDraft() ?? today()"
          (input)="dateDraft.set($any($event.target).value)"
        />
      </div>
      <p class="hint" i18n="@@training.body.measure.optional">
        Preencha só o que quiser registrar.
      </p>
      @for (group of groups(); track group.key) {
        <fieldset class="measure-group">
          <legend>{{ group.title }}</legend>
          <div class="measure-fields">
            @for (item of group.fields; track item.key) {
              <div class="ui-field">
                <label [for]="fieldId(item.key)">{{ item.label }}</label>
                <input
                  class="ui-input"
                  [id]="fieldId(item.key)"
                  [attr.inputmode]="'decimal'"
                  autocomplete="off"
                  [value]="draft(item.key)"
                  (input)="set(item.key, $any($event.target).value)"
                />
              </div>
            }
          </div>
        </fieldset>
      }
      <div class="ui-field">
        <label [for]="fatId" i18n="@@training.body.fat.percent">Gordura corporal (%)</label
        ><input
          class="ui-input"
          [id]="fatId"
          [attr.inputmode]="'decimal'"
          [value]="draft('fat')"
          (input)="set('fat', $any($event.target).value)"
        />
      </div>
      <fieldset class="choice-group">
        <legend i18n="@@training.body.fat.method">Método</legend>
        <div class="choices">
          <label class="choice" [for]="manualId">
            <input
              type="radio"
              [id]="manualId"
              [name]="methodName"
              value="manual"
              [checked]="fatMethod() === 'manual'"
              (change)="fatMethod.set('manual')"
            />
            <span i18n="@@training.body.fat.manual">Informado por você</span>
          </label>
          <label class="choice" [for]="bioimpedanceId">
            <input
              type="radio"
              [id]="bioimpedanceId"
              [name]="methodName"
              value="bioimpedance"
              [checked]="fatMethod() === 'bioimpedance'"
              (change)="fatMethod.set('bioimpedance')"
            />
            <span i18n="@@training.body.fat.bioimpedance">Bioimpedância</span>
          </label>
        </div>
      </fieldset>
      @if (canCalculateNavy()) {
        <p class="hint" i18n="@@training.body.fat.measure-guidance">
          Para esta estimativa, informe abdômen (homens) ou cintura (mulheres), pescoço e, para
          mulheres, quadril.
        </p>
        <button
          type="button"
          class="secondary ui-btn"
          (click)="calculateNavy()"
          i18n="@@training.body.fat.calculate"
        >
          Calcular pela Marinha
        </button>
      }
      @if (navyResult() !== null) {
        <p class="navy-result" role="status">
          {{ navyResultText() }}
          <span i18n="@@training.body.fat.warning"
            >Estimativa com margem de erro de poucos pontos.</span
          >
        </p>
      }
      @if (error(); as message) {
        <p class="error" role="alert" [id]="errorId">{{ message }}</p>
      }
      <button sheetAction type="button" class="primary ui-btn" (click)="save()">
        <span i18n="@@training.body.measure.save">Salvar Medidas</span>
      </button>
    </app-training-sheet>
  `,
  styleUrl: './measurements-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyMeasurementsSheet {
  private readonly body = inject(BodyRepository);
  private readonly sheet = viewChild.required(TrainingSheet);
  readonly profile = input<LocalBodyProfile | null>(null);
  readonly age = input<number | null>(null);
  readonly today = input.required<string>();
  readonly closed = output<void>();
  protected readonly heading = $localize`:@@training.body.measure.sheet:Registrar Medidas e Gordura`;
  protected readonly cancelLabel = $localize`:@@training.body.measure.cancel:Cancelar`;
  private readonly uid = nextMeasuresId++;
  protected readonly dateId = `measure-date-${this.uid}`;
  protected readonly fatId = `measure-fat-${this.uid}`;
  protected readonly methodName = `measure-method-${this.uid}`;
  protected readonly manualId = `measure-method-manual-${this.uid}`;
  protected readonly bioimpedanceId = `measure-method-bioimpedance-${this.uid}`;
  protected readonly errorId = `measure-error-${this.uid}`;
  protected readonly dateDraft = signal<string | null>(null);
  protected readonly drafts = signal<Record<DraftKey, string>>({
    fat: '',
    waistCm: '',
    abdomenCm: '',
    chestCm: '',
    neckCm: '',
    hipCm: '',
    armRightCm: '',
    armLeftCm: '',
    forearmRightCm: '',
    forearmLeftCm: '',
    thighRightCm: '',
    thighLeftCm: '',
    calfRightCm: '',
    calfLeftCm: '',
    chestSkinfoldMm: '',
    abdomenSkinfoldMm: '',
    thighSkinfoldMm: '',
  });
  protected readonly fatMethod = signal<FatMethod>('manual');
  protected readonly navyResult = signal<number | null>(null);
  protected readonly error = signal('');

  /**
   * Os grupos da folha. A unidade vai no título do grupo (centímetros, ou milímetros nas dobras) para o rótulo do campo
   * ficar curto e caber um ao lado do outro: direito e esquerdo na mesma linha, sem rolagem lateral. O quadril só aparece
   * para quem precisa dele (a estimativa da Marinha para mulheres).
   */
  protected readonly groups = computed<readonly MeasureGroup[]>(() => [
    {
      key: 'trunk',
      title: $localize`:@@training.body.measure.trunk:Tronco (cm)`,
      fields: [
        { key: 'waistCm', label: $localize`:@@training.body.measure.waist:Cintura` },
        { key: 'abdomenCm', label: $localize`:@@training.body.measure.abdomen:Abdômen` },
        { key: 'chestCm', label: $localize`:@@training.body.measure.chest:Tórax` },
        { key: 'neckCm', label: $localize`:@@training.body.measure.neck:Pescoço` },
        ...(this.profile()?.sex === 'female'
          ? [{ key: 'hipCm' as const, label: $localize`:@@training.body.measure.hip:Quadril` }]
          : []),
      ],
    },
    {
      key: 'arms',
      title: $localize`:@@training.body.measure.arms:Braços (cm)`,
      fields: [
        { key: 'armRightCm', label: $localize`:@@training.body.measure.arm-right:Braço D` },
        { key: 'armLeftCm', label: $localize`:@@training.body.measure.arm-left:Braço E` },
        {
          key: 'forearmRightCm',
          label: $localize`:@@training.body.measure.forearm-right:Antebraço D`,
        },
        {
          key: 'forearmLeftCm',
          label: $localize`:@@training.body.measure.forearm-left:Antebraço E`,
        },
      ],
    },
    {
      key: 'legs',
      title: $localize`:@@training.body.measure.legs:Pernas (cm)`,
      fields: [
        { key: 'thighRightCm', label: $localize`:@@training.body.measure.thigh-right:Coxa D` },
        { key: 'thighLeftCm', label: $localize`:@@training.body.measure.thigh-left:Coxa E` },
        { key: 'calfRightCm', label: $localize`:@@training.body.measure.calf-right:Panturrilha D` },
        { key: 'calfLeftCm', label: $localize`:@@training.body.measure.calf-left:Panturrilha E` },
      ],
    },
    {
      key: 'skinfolds',
      title: $localize`:@@training.body.measure.skinfolds:Dobras (mm)`,
      fields: [
        {
          key: 'chestSkinfoldMm',
          label: $localize`:@@training.body.measure.chest-skinfold:Peitoral`,
        },
        {
          key: 'abdomenSkinfoldMm',
          label: $localize`:@@training.body.measure.abdomen-skinfold:Abdominal`,
        },
        { key: 'thighSkinfoldMm', label: $localize`:@@training.body.measure.thigh-skinfold:Coxa` },
      ],
    },
  ]);
  protected readonly canCalculateNavy = computed(
    () =>
      NAVY_BODY_FAT_ENABLED && this.profile() !== null && this.age() !== null && this.age()! >= 18,
  );
  protected readonly navyResultText = computed(() => {
    const value = this.navyResult();
    return value === null
      ? ''
      : $localize`:@@training.body.fat.navy-result:${toFieldText(value)}:percent: % · Marinha · estimado`;
  });

  protected fieldId(key: MeasureKey): string {
    return `measure-${key}-${this.uid}`;
  }
  protected draft(field: DraftKey): string {
    return this.drafts()[field];
  }
  protected set(field: DraftKey, value: string): void {
    this.drafts.update((current) => ({ ...current, [field]: value }));
    this.navyResult.set(null);
  }

  protected calculateNavy(): void {
    const profile = this.profile();
    const age = this.age();
    const values = this.drafts();
    if (!profile || age === null) return;
    const result = navyBodyFat({
      sex: profile.sex,
      heightCm: profile.heightCm,
      ageYears: age,
      // Na fórmula o homem entra com o abdômen (na altura do umbigo) e a mulher com a cintura; quem só preencheu a
      // cintura continua podendo calcular, como antes de o abdômen ter campo próprio.
      waistCm:
        (profile.sex === 'male'
          ? (parseDecimal(values.abdomenCm) ?? parseDecimal(values.waistCm))
          : parseDecimal(values.waistCm)) ?? Number.NaN,
      neckCm: parseDecimal(values.neckCm) ?? Number.NaN,
      hipCm: parseDecimal(values.hipCm),
    });
    if (result === null) {
      this.error.set(
        $localize`:@@training.body.fat.navy-invalid:Confira as medidas. Elas não permitem calcular uma estimativa dentro da faixa aceita.`,
      );
      this.navyResult.set(null);
      return;
    }
    this.error.set('');
    this.navyResult.set(result);
  }

  protected async save(): Promise<void> {
    const values = this.drafts();
    const read = (key: DraftKey) => (values[key].trim() === '' ? null : parseDecimal(values[key]));
    const fat = this.navyResult() ?? read('fat');
    const method = this.navyResult() === null ? this.fatMethod() : 'navy';
    if (
      Object.values(values).some((value) => value.trim() !== '' && parseDecimal(value) === null)
    ) {
      this.error.set(
        $localize`:@@training.body.measure.number:Digite números válidos, usando vírgula ou ponto decimal.`,
      );
      return;
    }
    const measures: Partial<Record<MeasureKey, number | null>> = {};
    for (const key of MEASURE_KEYS) {
      const value = read(key);
      measures[key] = value === null ? null : round1(value);
    }
    const result = await this.body.saveEntry({
      measuredOn: this.dateDraft() ?? this.today(),
      bodyFatPct: fat === null ? null : round1(fat),
      fatMethod: fat === null ? null : method,
      ...measures,
    });
    if (result.status === 'saved' || result.status === 'not-found') {
      this.sheet().close();
      return;
    }
    if (result.status === 'storage-full') {
      this.error.set(
        $localize`:@@training.body.measure.storage:Sem espaço no aparelho para guardar as medidas. Libere espaço e tente de novo.`,
      );
      return;
    }
    this.error.set(this.issueText(result.issues));
  }

  private issueText(issues: readonly BodyEntryIssue[]): string {
    if (issues.some((issue) => issue.path === 'measuredOn'))
      return $localize`:@@training.body.measure.date-invalid:Escolha um dia até hoje.`;
    if (issues.some((issue) => issue.path === 'fatMethod'))
      return $localize`:@@training.body.measure.method-required:Escolha o método usado para o percentual.`;
    if (issues.some((issue) => issue.path === 'values'))
      return $localize`:@@training.body.measure.empty:Preencha pelo menos uma medida ou o percentual de gordura.`;
    if (issues.some((issue) => issue.path.endsWith('SkinfoldMm')))
      return $localize`:@@training.body.measure.skinfold-range:Confira as dobras: de 1 a 100 mm.`;
    return $localize`:@@training.body.measure.range:Confira os valores. Medidas: 10 a 250 cm; gordura: 2 a 70%.`;
  }
}
