import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { InstallHint } from '../pwa/install-hint';
import { SessionState } from '../session/session-state';
import { TabBar } from '../../shared/ui/tab-bar/tab-bar';
import { collectShellData } from './route-data';

/**
 * Casca de tela: na Início só o conteúdo; dentro de um módulo, cabeçalho com a seta de voltar ao Início e o
 * título, e a barra de abas embaixo. Quem decide é o `data` da rota (`title` e `tabs`). Hospeda também a folha
 * do atalho na tela de início (`app-install-hint`), que vale para dono e convidado.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, TabBar, InstallHint],
  template: `
    @if (data().title; as title) {
      <header class="bar">
        @if (!isGuest()) {
          <a
            routerLink="/"
            class="back ui-tap"
            aria-label="Voltar ao Início"
            i18n-aria-label="@@shell.back-home-label"
          >
            <svg
              viewBox="0 0 24 24"
              width="22"
              height="22"
              fill="none"
              stroke="currentColor"
              stroke-width="2.2"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              @for (d of backArrow; track d) {
                <path [attr.d]="d" />
              }
            </svg>
          </a>
        }
        <h1>{{ title }}</h1>
      </header>
    }
    <main [class.no-header]="!data().title">
      <router-outlet />
    </main>
    @if (tabs().length > 0) {
      <app-tab-bar class="tabs" [tabs]="tabs()" />
    }
    <!-- Fora do <main>: a folha do atalho na tela de início é diálogo (camada do topo) e nunca entra no layout. -->
    <app-install-hint />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    /* Seta e título na mesma linha, centrados um no outro; o título pode quebrar sem empurrar a seta. */
    .bar {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      padding: var(--space-2) var(--gutter);
      padding-top: calc(var(--space-2) + env(safe-area-inset-top));
      background: var(--a-surface);
      border-bottom: 1px solid var(--a-line);
    }
    .back {
      display: inline-flex;
      flex: none;
      align-items: center;
      justify-content: center;
      width: var(--tap);
      height: var(--tap);
      border: 1px solid var(--a-line);
      border-radius: 50%;
      background: var(--a-surface);
      color: var(--a-ink);
      box-shadow: var(--shadow-1);
      text-decoration: none;
      transition:
        background-color var(--dur-fast) linear,
        transform var(--dur-fast) var(--ease-out);
    }
    .back svg {
      transition: translate var(--dur-base) var(--ease-out);
    }
    .back:active {
      background: var(--a-elev);
    }
    @media (hover: hover) {
      .back:hover {
        background: var(--a-surface-2);
      }
      .back:hover svg {
        translate: -2px 0;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .back,
      .back svg {
        transition: none;
      }
      .back:hover svg {
        translate: none;
      }
    }
    h1 {
      min-width: 0;
      font-size: 1.5rem;
      overflow-wrap: anywhere;
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

  /** Traços da seta de voltar (a mesma seta da tela da TV): a haste e a ponta. */
  protected readonly backArrow = ['M19 12H5', 'M11 18l-6-6 6-6'] as const;

  /** Convidado: sem navegação para fora da TV (o retorno ao Início some). */
  protected readonly isGuest = inject(SessionState).isGuest;

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
