import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** Cabeçalho de página de módulo: volta para o Início e mostra o título. */
@Component({
  selector: 'app-page-header',
  imports: [RouterLink],
  template: `
    <header class="bar">
      <a routerLink="/" class="back" i18n="@@shared.back-home">&larr; Início</a>
      <h1>{{ heading() }}</h1>
    </header>
  `,
  styles: `
    .bar {
      display: flex;
      flex-direction: column;
      gap: 8px;
      padding: var(--gutter);
      background: var(--a-surface);
      border-bottom: 1px solid var(--a-line);
    }
    .back {
      display: inline-flex;
      align-items: center;
      min-height: 44px;
      font-weight: 600;
      text-decoration: none;
    }
    h1 {
      font-size: 1.5rem;
    }
  `,
})
export class PageHeader {
  readonly heading = input.required<string>();
}
