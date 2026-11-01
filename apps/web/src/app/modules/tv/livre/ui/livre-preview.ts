import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { GearIcon } from '../../../../core/layout/gear-icon';
import { ClockService } from '../../../../core/time/clock.service';
import { AppIcon } from '../../ui/app-icon';
import { LivreAppRow, PREVIEW_MAX_TILES, gradientCss, previewClock } from '../data/livre-config';
import { LivreConfig } from '../data/livre-types';

/**
 * A Home da TV em miniatura, fiel ao launcher: fundo (degradê ou foto com o escurecimento), relógio grande e centralizado com
 * a data e, embaixo, a fileira centrada de apps em círculos. Todas as medidas são frações da altura da tela, as mesmas do
 * launcher (`Metrics`): o desenho na TV e esta miniatura têm a mesma proporção em qualquer tamanho. A altura é a de uma tela
 * 16:9 e vem da largura do quadro (`cqw`), então a miniatura acompanha a coluna sem medir nada em código. O nome do sistema
 * não aparece, como na TV. É um desenho: o leitor de tela ouve só o rótulo.
 */
@Component({
  selector: 'app-livre-preview',
  imports: [AppIcon, GearIcon],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      class="frame"
      role="img"
      aria-label="Pré-visualização da Home da TV"
      i18n-aria-label="@@tv-livre.preview.label"
    >
      <div class="stage" [style.background]="gradient()" [class]="sizes()">
        @if (photo(); as url) {
          <img class="photo" [src]="url" alt="" draggable="false" />
          <span class="dim" [style.opacity]="config().wallpaper.dim"></span>
        }
        <div class="content">
          @if (config().clock.enabled) {
            <div class="clock">
              <p class="time">{{ clock().time }}</p>
              @if (config().clock.date) {
                <p class="date">{{ clock().date }}</p>
              }
            </div>
          }
          <ul class="row">
            @for (app of shown(); track app.package) {
              <li class="tile">
                <app-tv-app-icon class="icon" [shortcut]="app.subject" />
                @if (config().icons.labels === 'always') {
                  <span class="name">{{ app.label }}</span>
                }
              </li>
            }
            @if (config().builtin.settings) {
              <li class="tile">
                <span class="icon gear"><app-gear-icon /></span>
              </li>
            }
          </ul>
        </div>
      </div>
    </div>
  `,
  styles: `
    :host {
      display: block;
    }
    .frame {
      container-type: inline-size;
      aspect-ratio: 16 / 9;
      overflow: hidden;
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: #000;
      box-shadow: var(--shadow-1);
    }
    /* 1 unidade = a altura da tela (a largura do quadro dividida por 16:9). */
    .stage {
      --u: 56.25cqw;
      --clock: 0.17;
      --date: 0.04;
      --icon: 0.18;
      position: relative;
      width: 100%;
      height: 100%;
      color: #fff;
    }
    .stage.clock-medium {
      --clock: 0.11;
      --date: 0.032;
    }
    .stage.clock-small {
      --clock: 0.07;
      --date: 0.026;
    }
    .stage.icon-small {
      --icon: 0.14;
    }
    .stage.icon-large {
      --icon: 0.22;
    }
    .photo {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      object-fit: cover;
      user-select: none;
      -webkit-user-select: none;
    }
    .dim {
      position: absolute;
      inset: 0;
      background: #000;
    }
    .content {
      position: absolute;
      inset: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: calc(var(--u) * 0.09);
      padding: 0 calc(var(--u) * 0.12);
    }
    .clock {
      text-align: center;
    }
    .time,
    .date {
      margin: 0;
    }
    .time {
      font-size: calc(var(--u) * var(--clock));
      font-weight: 300;
      line-height: 1;
      font-variant-numeric: tabular-nums;
    }
    .date {
      margin-top: calc(var(--u) * 0.015);
      color: rgb(255 255 255 / 0.8);
      font-size: calc(var(--u) * var(--date));
      line-height: 1.2;
    }
    .row {
      display: flex;
      justify-content: center;
      gap: calc(var(--u) * 0.045);
      margin: 0;
      padding: 0;
      list-style: none;
    }
    .tile {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: calc(var(--u) * 0.022);
      min-width: 0;
    }
    .icon {
      --tile: calc(var(--u) * var(--icon));
      --tile-radius: 50%;
      --tile-edge: rgb(255 255 255 / 0.18);
    }
    .name {
      max-width: calc(var(--u) * 0.24);
      overflow: hidden;
      font-size: max(7px, calc(var(--u) * 0.026));
      font-weight: 500;
      line-height: 1.15;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* O círculo de Configurações da TV, no fim da fileira como no launcher. */
    .gear {
      display: grid;
      place-items: center;
      width: var(--tile);
      height: var(--tile);
      border-radius: 50%;
      background: rgb(255 255 255 / 0.16);
      color: #fff;
    }
    :host ::ng-deep .gear app-gear-icon {
      display: flex;
      width: 48%;
      height: 48%;
    }
    :host ::ng-deep .gear svg {
      width: 100%;
      height: 100%;
    }
  `,
})
export class LivrePreview {
  readonly config = input.required<LivreConfig>();
  /** O que a Home mostrará, na ordem do launcher (a tela calcula, a miniatura só desenha). */
  readonly apps = input.required<readonly LivreAppRow[]>();
  /** A foto de fundo como `data:`, quando há; o fundo em foto sem ela cai no degradê, como no launcher. */
  readonly photoUrl = input<string | null>(null);

  private readonly now = inject(ClockService).now;

  protected readonly gradient = computed(() =>
    gradientCss(this.config().wallpaper.colors, this.config().wallpaper.angle),
  );
  protected readonly photo = computed(() =>
    this.config().wallpaper.type === 'photo' ? this.photoUrl() : null,
  );
  protected readonly clock = computed(() => previewClock(this.now(), this.config().clock));
  protected readonly sizes = computed(
    () => `clock-${this.config().clock.size} icon-${this.config().icons.size}`,
  );
  /** Cabem poucos círculos na miniatura; a Configurações da TV, quando ligada, ocupa um dos lugares. */
  protected readonly shown = computed(() =>
    this.apps().slice(0, PREVIEW_MAX_TILES - (this.config().builtin.settings ? 1 : 0)),
  );
}
