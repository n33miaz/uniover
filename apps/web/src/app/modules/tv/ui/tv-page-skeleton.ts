import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Mantém o espaço do controle enquanto o estado da TV ainda chega. O cabeçalho real permanece acima dele;
 * daqui para baixo a grade repete atalhos, direcional, teclas e as duas colunas de volume/canal.
 */
@Component({
  selector: 'app-tv-page-skeleton',
  template: `
    <section class="remote" aria-hidden="true">
      <div class="shortcuts"><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span></div>
      <div class="ring ui-skeleton"><span class="disk ui-skeleton"></span></div>
      <div class="dots"><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span></div>
      <div class="bottom"><span class="pill ui-skeleton"></span><div class="keys"><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span><span class="ui-skeleton"></span></div><span class="pill ui-skeleton"></span></div>
    </section>
  `,
  styles: `
    :host { display: block; min-height: 0; flex: 1; }
    .remote { display: flex; flex: 1; min-height: 0; flex-direction: column; align-items: center; gap: var(--space-2); padding: var(--space-2) 0 var(--safe-bottom); }
    .shortcuts, .dots { display: flex; align-items: center; justify-content: center; gap: var(--space-2); min-height: var(--tap); }
    .shortcuts span { width: 60px; height: 60px; border-radius: 16px; }
    .ring { display: grid; place-items: center; flex: 1; width: min(72vw, 300px); min-height: 180px; aspect-ratio: 1; border-radius: 50%; }
    .disk { width: 72%; aspect-ratio: 1; border-radius: 50%; }
    .dots span { width: 8px; height: 8px; border-radius: 50%; }
    .bottom { display: grid; grid-template-columns: 52px minmax(0, 1fr) 52px; width: 100%; max-width: 36rem; gap: var(--space-2); }
    .pill { min-height: 132px; border-radius: 26px; }
    .keys { display: grid; grid-template-columns: repeat(4, minmax(44px, 1fr)); gap: var(--space-2); place-items: center; }
    .keys span { width: min(100%, 72px); aspect-ratio: 1; border-radius: 50%; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TvPageSkeleton {}
