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
type MeasureField = 'fat' | 'waist' | 'neck' | 'hip' | 'arm' | 'thigh';

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
        Preencha só o que quiser registrar. Medidas em centímetros.
      </p>
      <div class="ui-field">
        <label [for]="waistId" i18n="@@training.body.measure.waist">Cintura / abdômen (cm)</label
        ><input
          class="ui-input"
          [id]="waistId"
          [attr.inputmode]="'decimal'"
          [value]="draft('waist')"
          (input)="set('waist', $any($event.target).value)"
        />
      </div>
      <div class="ui-field">
        <label [for]="neckId" i18n="@@training.body.measure.neck">Pescoço (cm)</label
        ><input
          class="ui-input"
          [id]="neckId"
          [attr.inputmode]="'decimal'"
          [value]="draft('neck')"
          (input)="set('neck', $any($event.target).value)"
        />
      </div>
      @if (profile()?.sex === 'female') {
        <div class="ui-field">
          <label [for]="hipId" i18n="@@training.body.measure.hip">Quadril (cm)</label
          ><input
            class="ui-input"
            [id]="hipId"
            [attr.inputmode]="'decimal'"
            [value]="draft('hip')"
            (input)="set('hip', $any($event.target).value)"
          />
        </div>
      }
      <div class="ui-field">
        <label [for]="armId" i18n="@@training.body.measure.arm">Braço (cm)</label
        ><input
          class="ui-input"
          [id]="armId"
          [attr.inputmode]="'decimal'"
          [value]="draft('arm')"
          (input)="set('arm', $any($event.target).value)"
        />
      </div>
      <div class="ui-field">
        <label [for]="thighId" i18n="@@training.body.measure.thigh">Coxa (cm)</label
        ><input
          class="ui-input"
          [id]="thighId"
          [attr.inputmode]="'decimal'"
          [value]="draft('thigh')"
          (input)="set('thigh', $any($event.target).value)"
        />
      </div>
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
          Para esta estimativa, informe cintura ou abdômen, pescoço e, para mulheres, quadril.
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
  protected readonly dateId = `measure-date-${nextMeasuresId}`;
  protected readonly waistId = `measure-waist-${nextMeasuresId}`;
  protected readonly neckId = `measure-neck-${nextMeasuresId}`;
  protected readonly hipId = `measure-hip-${nextMeasuresId}`;
  protected readonly armId = `measure-arm-${nextMeasuresId}`;
  protected readonly thighId = `measure-thigh-${nextMeasuresId}`;
  protected readonly fatId = `measure-fat-${nextMeasuresId}`;
  protected readonly methodName = `measure-method-${nextMeasuresId}`;
  protected readonly manualId = `measure-method-manual-${nextMeasuresId}`;
  protected readonly bioimpedanceId = `measure-method-bioimpedance-${nextMeasuresId}`;
  protected readonly errorId = `measure-error-${nextMeasuresId++}`;
  protected readonly dateDraft = signal<string | null>(null);
  protected readonly drafts = signal<Record<MeasureField, string>>({
    fat: '',
    waist: '',
    neck: '',
    hip: '',
    arm: '',
    thigh: '',
  });
  protected readonly fatMethod = signal<FatMethod>('manual');
  protected readonly navyResult = signal<number | null>(null);
  protected readonly error = signal('');
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

  protected draft(field: MeasureField): string {
    return this.drafts()[field];
  }
  protected set(field: MeasureField, value: string): void {
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
      waistCm: parseDecimal(values.waist) ?? Number.NaN,
      neckCm: parseDecimal(values.neck) ?? Number.NaN,
      hipCm: parseDecimal(values.hip),
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
    const read = (key: MeasureField) =>
      values[key].trim() === '' ? null : parseDecimal(values[key]);
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
    const result = await this.body.saveEntry({
      measuredOn: this.dateDraft() ?? this.today(),
      bodyFatPct: fat === null ? null : round1(fat),
      fatMethod: fat === null ? null : method,
      waistCm: read('waist') === null ? null : round1(read('waist')!),
      neckCm: read('neck') === null ? null : round1(read('neck')!),
      hipCm: read('hip') === null ? null : round1(read('hip')!),
      armCm: read('arm') === null ? null : round1(read('arm')!),
      thighCm: read('thigh') === null ? null : round1(read('thigh')!),
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
    return $localize`:@@training.body.measure.range:Confira os valores. Medidas: 10 a 250 cm; gordura: 2 a 70%.`;
  }
}
