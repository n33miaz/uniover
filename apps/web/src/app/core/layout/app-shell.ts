import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { TabBar } from '../../shared/ui/tab-bar/tab-bar';
import { collectShellData } from './route-data';

/**
 * Casca de tela: na Início só o conteúdo; dentro de um módulo, cabeçalho com "Início" e título em cima e
 * barra de abas embaixo. Quem decide é o `data` da rota (`title` e `tabs`).
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, TabBar],
  template: `
    @if (data().title; as title) {
      <header class="bar">
        <a routerLink="/" class="back" i18n="@@shell.back-home">&larr; Início</a>
        <h1>{{ title }}</h1>
      </header>
    }
    <main [class.no-header]="!data().title">
      <router-outlet />
    </main>
    @if (tabs().length > 0) {
      <app-tab-bar class="tabs" [tabs]="tabs()" />
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    .bar {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 8px var(--gutter) 12px;
      padding-top: calc(8px + env(safe-area-inset-top));
      background: var(--a-surface);
      border-bottom: 1px solid var(--a-line);
    }
    .back {
      display: inline-flex;
      align-items: center;
      align-self: flex-start;
      min-height: 44px;
      font-weight: 600;
      text-decoration: none;
    }
    h1 {
      font-size: 1.5rem;
    }
    main {
      flex: 1 1 auto;
    }
    /* Sem cabeçalho (Início) o conteúdo começa abaixo da área segura do aparelho. */
    main.no-header {
      padding-top: calc(var(--gutter) + env(safe-area-inset-top));
    }
    .tabs {
      position: sticky;
      bottom: 0;
    }
  `,
})
export class AppShell {
  private readonly router = inject(Router);

  protected readonly data = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => collectShellData(this.router.routerState.snapshot.root)),
      startWith(collectShellData(this.router.routerState.snapshot.root)),
    ),
    { requireSync: true },
  );

  protected readonly tabs = computed(() => this.data().tabs ?? []);
}
