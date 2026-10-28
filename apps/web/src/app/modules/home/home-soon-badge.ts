import { Component } from '@angular/core';

/**
 * Rótulo dos módulos que ainda não têm tela: uma linha pequena, em cor secundária, embaixo do nome. A aparência fica
 * concentrada aqui, para uma próxima escolha visual não mexer na grade.
 */
@Component({
  selector: 'app-home-soon-badge',
  template: `<span class="soon" i18n="@@home.soon">Em Breve</span>`,
  styles: `
    :host {
      display: block;
      max-width: 100%;
      margin-top: calc(var(--space-1) / -2);
    }

    .soon {
      display: block;
      overflow: hidden;
      color: var(--a-ink2);
      font-size: var(--fs-small);
      font-weight: 650;
      line-height: 1.2;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `,
})
export class HomeSoonBadge {}
