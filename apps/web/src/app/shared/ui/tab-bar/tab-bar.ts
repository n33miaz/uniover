import { Component, input } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';

export interface TabItem {
  /** Caminho absoluto da aba, por exemplo `/tv`. */
  readonly link: string;
  readonly label: string;
}

/** Barra de abas de um módulo, embaixo da tela. Cada módulo entrega as suas pelo `data.tabs` da rota. */
@Component({
  selector: 'app-tab-bar',
  imports: [RouterLink, RouterLinkActive],
  template: `
    <nav aria-label="Abas do módulo" i18n-aria-label="@@shared.tabs">
      <ul>
        @for (tab of tabs(); track tab.link) {
          <li>
            <a
              [routerLink]="tab.link"
              routerLinkActive="active"
              ariaCurrentWhenActive="page"
              [routerLinkActiveOptions]="{ exact: true }"
              >{{ tab.label }}</a
            >
          </li>
        }
      </ul>
    </nav>
  `,
  styles: `
    nav {
      background: var(--a-surface);
      border-top: 1px solid var(--a-line);
      padding-bottom: env(safe-area-inset-bottom);
    }
    ul {
      display: flex;
      margin: 0;
      padding: 0;
      list-style: none;
    }
    li {
      flex: 1 1 0;
      min-width: 0;
    }
    a {
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 56px;
      padding: 0 8px;
      color: var(--a-ink2);
      font-weight: 600;
      text-decoration: none;
      border-top: 3px solid transparent;
      /* Sem transição de cor do texto: ao trocar o tema ele não pode ficar a meio caminho sobre o fundo novo. */
      transition:
        border-color var(--dur-base) var(--ease-out),
        background-color var(--dur-fast) linear;
    }
    a:active {
      background: var(--a-elev);
    }
    a.active {
      color: var(--a-accent);
      border-top-color: var(--a-accent);
    }
    @media (prefers-reduced-motion: reduce) {
      a {
        transition: none;
      }
    }
  `,
})
export class TabBar {
  readonly tabs = input.required<readonly TabItem[]>();
}
