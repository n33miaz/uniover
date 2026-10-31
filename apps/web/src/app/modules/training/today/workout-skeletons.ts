import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * Os esqueletos das telas do treino aberto. Cada uma repete a forma da tela pronta (medidas de `workout-day.css`,
 * `live-session.css` e `session-summary.css`), inclusive o botão fixo de baixo, para nada pular quando a leitura local termina.
 * A moldura compartilhada cuida do atraso, do texto para o leitor de tela e do prazo. As classes levam o prefixo `sk-`
 * para nenhuma repetir o nome de uma classe da tela pronta (quem procura a tela de verdade nunca toma a espera por ela).
 */

/** A lista de exercícios do treino: o nome do treino, os cartões com a ilustração e o botão de concluir fixo embaixo. */
@Component({
  selector: 'app-workout-day-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-page">
        <span appSkeleton class="sk-routine-name"></span>
        <div class="sk-cards">
          @for (card of cards; track card) {
            <div class="sk-exercise ui-card">
              <span appSkeleton class="sk-art"></span>
              <span class="sk-details">
                <span appSkeleton class="sk-name"></span>
                <span appSkeleton class="sk-meta"></span>
              </span>
            </div>
          }
        </div>
      </div>
      <div class="sk-dock">
        <span appSkeleton class="sk-go"></span>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      max-width: 40rem;
      margin-inline: auto;
      padding-bottom: 96px;
    }
    .sk-routine-name {
      display: block;
      width: 50%;
      height: 24px;
      min-height: 0;
      margin-inline: auto;
    }
    .sk-cards {
      display: grid;
      grid-auto-rows: minmax(120px, auto);
      gap: var(--space-2);
    }
    .sk-exercise {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2);
    }
    .sk-art {
      display: block;
      flex: none;
      width: clamp(104px, 33vw, 150px);
      height: clamp(104px, 33vw, 150px);
      min-height: 0;
      border-radius: var(--radius);
    }
    .sk-details {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      gap: var(--space-2);
      min-width: 0;
    }
    .sk-name {
      display: block;
      width: 70%;
      height: 18px;
      min-height: 0;
    }
    .sk-meta {
      display: block;
      width: 45%;
      height: 14px;
      min-height: 0;
    }
    .sk-dock {
      position: fixed;
      inset-inline: 0;
      bottom: var(--kb-inset, 0px);
      z-index: 2;
      padding: var(--space-3) var(--gutter) calc(var(--space-3) + var(--safe-bottom));
      border-top: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    .sk-go {
      display: block;
      max-width: 40rem;
      height: 56px;
      min-height: 0;
      margin-inline: auto;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class WorkoutDaySkeleton {
  protected readonly label = $localize`:@@training.day.loading:Carregando os exercícios do treino…`;
  protected readonly cards = [1, 2, 3, 4];
}

/** O registro de uma série: a linha da tela acesa, o nome e a série, a ilustração, os campos e o botão fixo de baixo. */
@Component({
  selector: 'app-live-session-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-page">
        <div class="sk-tools">
          <span appSkeleton class="sk-switch"></span>
        </div>
        <div class="sk-first">
          <div class="sk-top">
            <span appSkeleton class="sk-name"></span>
            <span appSkeleton class="sk-sub"></span>
            <div class="sk-chips">
              <span appSkeleton class="sk-chip"></span>
              <span appSkeleton class="sk-chip"></span>
            </div>
          </div>
          <div class="sk-focus">
            <span appSkeleton class="sk-set-title"></span>
            <span appSkeleton class="sk-chip"></span>
          </div>
          <span appSkeleton class="sk-art"></span>
          <div class="sk-fields ui-card">
            <span appSkeleton class="sk-field"></span>
            <span appSkeleton class="sk-field"></span>
          </div>
        </div>
      </div>
      <div class="sk-dock">
        <span appSkeleton class="sk-go"></span>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      max-width: 40rem;
      margin-inline: auto;
      padding-bottom: 96px;
    }
    .sk-tools {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      min-height: var(--tap);
    }
    .sk-switch {
      display: block;
      width: 44px;
      height: 26px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    /* A mesma altura mínima da tela pronta: a ilustração toma o que sobra, como lá. */
    .sk-first {
      --sk-top-offset: calc(
        env(safe-area-inset-top) + var(--space-3) + var(--tap) + var(--space-3) + var(--tap) +
          var(--space-2)
      );
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
      min-height: calc(100svh - var(--sk-top-offset) - 96px - var(--safe-bottom));
    }
    .sk-top {
      display: flex;
      flex-direction: column;
      gap: var(--space-1);
    }
    .sk-name {
      display: block;
      width: 65%;
      height: 26px;
      min-height: 0;
    }
    .sk-sub {
      display: block;
      width: 45%;
      height: 14px;
      min-height: 0;
    }
    .sk-chips {
      display: flex;
      gap: var(--space-2);
    }
    .sk-chip {
      display: block;
      width: 5rem;
      height: 24px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    .sk-focus {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: var(--space-2);
    }
    .sk-set-title {
      display: block;
      width: 30%;
      height: 20px;
      min-height: 0;
    }
    .sk-art {
      display: block;
      flex: 1 1 auto;
      min-height: 10rem;
      border-radius: var(--radius);
    }
    .sk-fields {
      display: flex;
      gap: var(--space-2);
      padding: var(--space-3);
    }
    .sk-field {
      display: block;
      flex: 1 1 0;
      height: 64px;
      min-height: 0;
      border-radius: var(--radius-sm);
    }
    .sk-dock {
      position: fixed;
      inset-inline: 0;
      bottom: var(--kb-inset, 0px);
      z-index: 2;
      padding: var(--space-3) var(--gutter) calc(var(--space-3) + var(--safe-bottom));
      border-top: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    .sk-go {
      display: block;
      max-width: 40rem;
      height: 64px;
      min-height: 0;
      margin-inline: auto;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LiveSessionSkeleton {
  protected readonly label = $localize`:@@training.live.loading:Carregando o treino…`;
}

/** O resumo do treino concluído: o título, o selo, os quatro números, o botão de editar e o de concluir fixo embaixo. */
@Component({
  selector: 'app-session-summary-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="sk-page">
        <span appSkeleton class="sk-title"></span>
        <div class="sk-hero">
          <span appSkeleton class="sk-seal"></span>
          <span appSkeleton class="sk-sub"></span>
          <span appSkeleton class="sk-saved"></span>
        </div>
        <div class="sk-stats">
          @for (stat of stats; track stat) {
            <span appSkeleton class="sk-stat"></span>
          }
        </div>
        <span appSkeleton class="sk-edit"></span>
      </div>
      <div class="sk-dock">
        <span appSkeleton class="sk-go"></span>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-page {
      display: flex;
      flex-direction: column;
      gap: var(--space-3);
      max-width: 40rem;
      margin-inline: auto;
      padding-bottom: 96px;
    }
    .sk-title {
      display: block;
      width: 50%;
      height: 24px;
      min-height: 0;
      margin-inline: auto;
    }
    .sk-hero {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: var(--space-2);
    }
    .sk-seal {
      display: block;
      width: 56px;
      height: 56px;
      min-height: 0;
      border-radius: var(--radius);
    }
    .sk-sub {
      display: block;
      width: 45%;
      height: 16px;
      min-height: 0;
    }
    .sk-saved {
      display: block;
      width: 55%;
      height: 14px;
      min-height: 0;
    }
    .sk-stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--space-2);
    }
    .sk-stat {
      display: block;
      height: 74px;
      min-height: 0;
      border-radius: var(--radius-lg);
    }
    .sk-edit {
      display: block;
      height: var(--tap);
      min-height: 0;
      border-radius: var(--radius);
    }
    .sk-dock {
      position: fixed;
      inset-inline: 0;
      bottom: var(--kb-inset, 0px);
      z-index: 2;
      padding: var(--space-3) var(--gutter) calc(var(--space-3) + var(--safe-bottom));
      border-top: 1px solid var(--a-line);
      background: var(--a-surface);
    }
    .sk-go {
      display: block;
      max-width: 40rem;
      height: 64px;
      min-height: 0;
      margin-inline: auto;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SessionSummarySkeleton {
  protected readonly label = $localize`:@@training.summary.loading:Carregando o resumo do treino…`;
  protected readonly stats = [1, 2, 3, 4];
}

/**
 * As seções da folha de troca de rotina (meta, ausência e nota do dia) enquanto os valores são lidos: elas só aparecem com
 * o dado já lido, porque um campo preenchido depois da digitação apagaria o que a pessoa escreveu.
 */
@Component({
  selector: 'app-picker-settings-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      @for (section of sections; track section) {
        <div class="sk-section">
          <span appSkeleton class="sk-heading"></span>
          <span appSkeleton class="sk-field"></span>
          <div class="sk-actions">
            <span appSkeleton class="sk-button"></span>
            <span appSkeleton class="sk-button"></span>
          </div>
        </div>
      }
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .sk-section {
      display: grid;
      gap: var(--space-2);
      margin-top: var(--space-4);
    }
    .sk-heading {
      display: block;
      width: 40%;
      height: 18px;
      min-height: 0;
    }
    .sk-field {
      display: block;
      height: 44px;
      min-height: 0;
      border-radius: var(--radius-sm);
    }
    .sk-actions {
      display: flex;
      gap: var(--space-2);
    }
    .sk-button {
      display: block;
      flex: 1 1 0;
      height: var(--tap);
      min-height: 0;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class PickerSettingsSkeleton {
  protected readonly label = $localize`:@@training.today.picker-loading:Carregando as opções da rotina…`;
  protected readonly sections = [1, 2, 3];
}
