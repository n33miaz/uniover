import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { TrainingGlyph } from '../../shell/training-glyph';
import { TrainingSheet } from '../../shell/training-sheet';
import { BodyNoticeStore } from './notice-store';

/** Os quatro avisos de saúde completos (texto da pesquisa), na ordem em que aparecem. */
export function fullNoticeTexts(): readonly string[] {
  return [
    $localize`:@@training.body.notice.long-1:Este app registra seus dados e faz estimativas. Não é orientação médica, nutricional nem de educador físico.`,
    $localize`:@@training.body.notice.long-2:Fórmulas de gasto, 1RM e percentual de gordura têm margem de erro grande para cada pessoa.`,
    $localize`:@@training.body.notice.long-3:Procure um profissional de saúde antes de mudar muito a dieta ou o treino, e se tiver doença, lesão, dor no peito, tontura ou falta de ar.`,
    $localize`:@@training.body.notice.long-4:Não use o app para metas de peso ou calorias muito baixas.`,
  ];
}

/**
 * O aviso de saúde da tela Corpo. Sempre há um cartão curto à vista, em qualquer seção; tocar nele abre o texto completo
 * numa folha. Na primeira abertura o texto completo vem no lugar do cartão curto, na própria página (não numa folha que
 * tomaria a tela), com "Entendi"; o "Entendi" fica guardado no aparelho e dali em diante só resta o cartão curto.
 */
@Component({
  selector: 'app-body-health-notice',
  imports: [TrainingGlyph, TrainingSheet],
  template: `
    @if (store.seen() === false) {
      <section class="full ui-card" aria-labelledby="body-notice-title">
        <div class="head">
          <span class="ui-tile"><app-training-glyph name="info" /></span>
          <h3 id="body-notice-title" class="title" i18n="@@training.body.notice.title">
            Antes de Começar
          </h3>
        </div>
        <ul class="list">
          @for (text of texts; track $index) {
            <li>{{ text }}</li>
          }
        </ul>
        <button type="button" class="primary ui-btn block" (click)="acknowledge()">
          <span i18n="@@training.body.notice.ack">Entendi</span>
        </button>
      </section>
    } @else {
      <button
        type="button"
        class="short ui-notice"
        aria-haspopup="dialog"
        i18n-aria-haspopup="@@common.aria.dialog-popup"
        (click)="sheetOpen.set(true)"
      >
        <app-training-glyph name="info" />
        <span class="text" i18n="@@training.body.notice.short"
          >Estimativas, não é orientação médica, nutricional nem de educador físico. Procure um
          profissional antes de mudar muito a dieta ou o treino.</span
        >
        <app-training-glyph class="chevron" name="next" />
      </button>
    }
    @if (sheetOpen()) {
      <app-training-sheet [heading]="sheetHeading" (closed)="sheetOpen.set(false)">
        <ul class="list sheet-list">
          @for (text of texts; track $index) {
            <li>{{ text }}</li>
          }
        </ul>
      </app-training-sheet>
    }
  `,
  styleUrl: './health-notice.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class HealthNotice {
  protected readonly store = inject(BodyNoticeStore);

  protected readonly texts = fullNoticeTexts();
  protected readonly sheetHeading = $localize`:@@training.body.notice.sheet:Aviso de Saúde`;
  protected readonly sheetOpen = signal(false);

  protected acknowledge(): void {
    void this.store.acknowledge();
  }
}
