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
import { ProfileRepository } from '../data/body/profile-repository';
import type { BodyProfileIssue } from '../domain/body/body-limits';
import { TrainingSheet } from '../shell/training-sheet';
import { formatFactor, parseDecimal, toFieldText } from './body-text';

let nextProfileId = 0;

@Component({
  selector: 'app-body-profile-sheet',
  imports: [TrainingSheet],
  template: `
    <app-training-sheet [heading]="heading" [dismissLabel]="cancelLabel" (closed)="closed.emit()">
      <p class="explanation" i18n="@@training.body.profile.explanation">
        Seu perfil só é usado para estimativas; não é diagnóstico.
      </p>
      <div class="ui-field">
        <label [for]="heightId" i18n="@@training.body.profile.height">Altura (cm)</label>
        <input
          class="ui-input"
          [id]="heightId"
          [attr.inputmode]="'decimal'"
          [value]="heightText()"
          (input)="heightDraft.set($any($event.target).value)"
        />
      </div>
      <div class="ui-field">
        <label [for]="birthId" i18n="@@training.body.profile.birth">Data de nascimento</label>
        <input
          class="ui-input"
          [id]="birthId"
          type="date"
          min="1900-01-01"
          [max]="today()"
          [value]="birthDraft() ?? profile()?.birthDate ?? ''"
          (input)="birthDraft.set($any($event.target).value)"
        />
      </div>
      <fieldset class="choice-group">
        <legend i18n="@@training.body.profile.sex">Sexo usado nas fórmulas</legend>
        <div class="choices">
          <label class="choice" [for]="sexMaleId">
            <input
              type="radio"
              [id]="sexMaleId"
              [name]="sexName"
              value="male"
              [checked]="(sexDraft() ?? profile()?.sex ?? 'male') === 'male'"
              (change)="sexDraft.set('male')"
            />
            <span i18n="@@training.body.profile.sex.male">Masculino</span>
          </label>
          <label class="choice" [for]="sexFemaleId">
            <input
              type="radio"
              [id]="sexFemaleId"
              [name]="sexName"
              value="female"
              [checked]="(sexDraft() ?? profile()?.sex ?? 'male') === 'female'"
              (change)="sexDraft.set('female')"
            />
            <span i18n="@@training.body.profile.sex.female">Feminino</span>
          </label>
        </div>
      </fieldset>
      <fieldset class="choice-group">
        <legend i18n="@@training.body.profile.factor">Fator de atividade</legend>
        <div class="choices factors">
          @for (factor of factors; track factor.value) {
            <label class="choice" [for]="factor.id">
              <input
                type="radio"
                [id]="factor.id"
                [name]="factorName"
                [value]="factor.value"
                [checked]="(factorDraft() ?? profile()?.activityFactor ?? 1.55) === factor.value"
                (change)="factorDraft.set(factor.value)"
              />
              <span>{{ factor.label }}</span>
            </label>
          }
        </div>
      </fieldset>
      @if (minor()) {
        <p class="minor" role="status" i18n="@@training.body.profile.minor">
          Você pode guardar o perfil, mas os cálculos de saúde ficam indisponíveis para menores de
          18 anos.
        </p>
      }
      @if (error(); as message) {
        <p class="error" role="alert" [id]="errorId">{{ message }}</p>
      }
      <button sheetAction type="button" class="primary ui-btn" (click)="save()">
        <span i18n="@@training.body.profile.save">Salvar perfil</span>
      </button>
    </app-training-sheet>
  `,
  styleUrl: './profile-sheet.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyProfileSheet {
  private readonly profiles = inject(ProfileRepository);
  private readonly sheet = viewChild.required(TrainingSheet);
  readonly profile = input<LocalBodyProfile | null>(null);
  readonly today = input.required<string>();
  readonly closed = output<void>();
  protected readonly heading = $localize`:@@training.body.profile.sheet:Seu perfil`;
  protected readonly cancelLabel = $localize`:@@training.body.profile.cancel:Cancelar`;
  protected readonly heightId = `body-height-${nextProfileId}`;
  protected readonly birthId = `body-birth-${nextProfileId}`;
  protected readonly sexMaleId = `body-sex-male-${nextProfileId}`;
  protected readonly sexFemaleId = `body-sex-female-${nextProfileId}`;
  protected readonly sexName = `body-sex-${nextProfileId}`;
  protected readonly factorName = `body-factor-${nextProfileId}`;
  protected readonly errorId = `body-profile-error-${nextProfileId++}`;
  protected readonly heightDraft = signal<string | null>(null);
  protected readonly birthDraft = signal<string | null>(null);
  protected readonly sexDraft = signal<'male' | 'female' | null>(null);
  protected readonly factorDraft = signal<number | null>(null);
  protected readonly error = signal('');
  protected readonly factors = [1.2, 1.375, 1.55, 1.725, 1.9].map((value, index) => ({
    value,
    label: formatFactor(value),
    id: `body-factor-${nextProfileId}-${index}`,
  }));
  protected readonly minor = computed(() => {
    const birth = this.birthDraft() ?? this.profile()?.birthDate;
    if (!birth || !this.today()) return false;
    const [by, bm, bd] = birth.split('-').map(Number);
    const [ty, tm, td] = this.today().split('-').map(Number);
    const age = ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
    return age < 18;
  });
  protected readonly heightText = computed(
    () => this.heightDraft() ?? (this.profile() ? toFieldText(this.profile()!.heightCm) : ''),
  );

  protected async save(): Promise<void> {
    const heightCm = parseDecimal(this.heightText());
    const birthDate = this.birthDraft() ?? this.profile()?.birthDate ?? '';
    const result = await this.profiles.save({
      heightCm: heightCm ?? Number.NaN,
      birthDate,
      sex: this.sexDraft() ?? this.profile()?.sex ?? 'male',
      activityFactor: this.factorDraft() ?? this.profile()?.activityFactor ?? 1.55,
    });
    if (result.status === 'saved') {
      this.sheet().close();
      return;
    }
    if (result.status === 'storage-full') {
      this.error.set(
        $localize`:@@training.body.profile.storage:Sem espaço no aparelho para guardar o perfil. Libere espaço e tente de novo.`,
      );
      return;
    }
    this.error.set(this.issueText(result.issues));
  }

  private issueText(issues: readonly BodyProfileIssue[]): string {
    if (issues.some((issue) => issue.path === 'birthDate'))
      return $localize`:@@training.body.profile.birth-invalid:Escolha uma data de nascimento válida.`;
    if (issues.some((issue) => issue.path === 'heightCm'))
      return $localize`:@@training.body.profile.height-invalid:Use uma altura entre 100 e 250 cm.`;
    return $localize`:@@training.body.profile.invalid:Confira os dados do perfil.`;
  }
}
