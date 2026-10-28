import { Component, inject, input } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink } from '@angular/router';
import { filter, map, startWith } from 'rxjs';

export interface TabItem {
  /** Caminho absoluto da aba, por exemplo `/tv`. */
  readonly link: string;
  readonly label: string;
  /** Símbolo decorativo; o rótulo visível continua sendo o nome acessível do link. */
  readonly icon?: 'today' | 'exercises' | 'progress' | 'body';
  /**
   * Por padrão a aba só fica marcada no próprio caminho (`link`). Com `nested`, fica marcada também nas telas filhas
   * dele (`link/...`), por exemplo a ficha de um exercício dentro de `/treino/exercicios`.
   */
  readonly nested?: boolean;
  /**
   * Outros caminhos que também marcam a aba, com as telas filhas deles. Serve para uma tela que mora em outro
   * caminho mas pertence à aba (as rotinas, dentro de Exercícios).
   */
  readonly also?: readonly string[];
}

/** Caminho sem consulta, sem fragmento e sem a barra do fim (a raiz continua `/`). */
function pathOf(url: string): string {
  const path = url.split(/[?#]/)[0];
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/** `path` é `base` ou uma tela filha dele (`base/...`)? Prefixo por segmento: `/treino/rotinas2` não é filho de `/treino/rotinas`. */
function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(base === '/' ? '/' : `${base}/`);
}

/**
 * Barra de abas de um módulo, embaixo da tela. Cada módulo entrega as suas pelo `data.tabs` da rota. A aba marcada sai do
 * caminho da tela aberta (a consulta não conta): o caminho exato por padrão, e as telas filhas quando a aba pede
 * (`nested`, `also`). Marcação só por caminho exato deixava a aba apagada na ficha de um exercício e na lista filtrada.
 */
@Component({
  selector: 'app-tab-bar',
  imports: [RouterLink],
  template: `
    <nav
      [class.training]="variant() === 'training'"
      aria-label="Abas do módulo"
      i18n-aria-label="@@shared.tabs"
    >
      <ul>
        @for (tab of tabs(); track tab.link) {
          <li>
            <a
              [routerLink]="tab.link"
              [class.active]="isActive(tab)"
              [attr.aria-current]="isActive(tab) ? 'page' : null"
            >
              @if (tab.icon) {
                <!-- A pílula do item ativo fica só atrás do ícone; o rótulo embaixo nunca some. -->
                <span class="pill" aria-hidden="true">
                  <svg class="icon" viewBox="0 0 24 24" aria-hidden="true">
                    @switch (tab.icon) {
                      @case ('today') {
                        <rect x="3.5" y="5.5" width="17" height="15" rx="2.5" />
                        <path [attr.d]="'M8 3.5v4M16 3.5v4M3.5 10h17M8 14h2m4 0h2m-8 3h2m4 0h2'" />
                      }
                      @case ('exercises') {
                        <path [attr.d]="'M5 9v6m3-9v12m8-12v12m3-9v6M8 12h8'" />
                      }
                      @case ('progress') {
                        <path [attr.d]="'M4 19.5h16M5.5 16l4-4 3 2.5 6-7'" />
                        <path [attr.d]="'M15 7.5h3.5V11'" />
                      }
                      @case ('body') {
                        <circle cx="12" cy="5" r="2.25" />
                        <path
                          [attr.d]="'M8.5 21v-5.5l-2-3.5 2-3h7l2 3-2 3.5V21m-7-8h7m-5 2.5v5m-4-9L5 16m14-4 1.5 4'"
                        />
                      }
                    }
                  </svg>
                </span>
              }
              <span>{{ tab.label }}</span>
            </a>
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
    .pill {
      display: contents;
    }
    .icon {
      display: none;
    }
    a:active {
      background: var(--a-elev);
    }
    a.active {
      color: var(--a-accent);
      border-top-color: var(--a-accent);
    }
    nav.training {
      border-top-color: color-mix(in srgb, var(--a-accent) 20%, var(--a-line));
      box-shadow: 0 -5px 18px color-mix(in srgb, var(--a-ink) 5%, transparent);
      -webkit-tap-highlight-color: transparent;
      touch-action: manipulation;
    }
    nav.training a {
      position: relative;
      isolation: isolate;
      flex-direction: column;
      gap: 3px;
      min-height: 64px;
      justify-content: center;
      padding: 4px 4px 6px;
      border-top: 0;
      font-size: 0.75rem;
      line-height: 1.1;
      touch-action: manipulation;
    }
    /* Pílula atrás do ícone, só no item ativo: 64 por 30 de área, e o item inteiro segue com 44 de altura ou mais. */
    nav.training .pill {
      display: grid;
      place-items: center;
      width: 64px;
      height: 30px;
      border-radius: 999px;
      background: transparent;
      transition: background-color var(--dur-base) var(--ease-out);
    }
    nav.training a.active .pill {
      background: var(--a-accent-soft);
    }
    nav.training li {
      position: relative;
    }
    nav.training .icon {
      display: block;
      width: 20px;
      height: 20px;
      fill: none;
      stroke: currentColor;
      stroke-width: 1.8;
      stroke-linecap: round;
      stroke-linejoin: round;
    }
    nav.training a:active {
      background: transparent;
    }
    nav.training a:focus-visible {
      outline-offset: -3px;
    }
    @media (prefers-reduced-motion: reduce) {
      a {
        transition: none;
      }
      nav.training .pill {
        transition: none;
      }
    }
  `,
})
export class TabBar {
  private readonly router = inject(Router);

  readonly tabs = input.required<readonly TabItem[]>();
  readonly variant = input<'default' | 'training'>('default');

  /** O endereço da tela aberta, lido do roteador (o navegador pode ter filtros na consulta que o roteador não vê). */
  private readonly url = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => this.router.url),
      startWith(this.router.url),
    ),
    { requireSync: true },
  );

  protected isActive(tab: TabItem): boolean {
    const path = pathOf(this.url());
    if (tab.nested ? isWithin(path, tab.link) : path === pathOf(tab.link)) return true;
    return (tab.also ?? []).some((base) => isWithin(path, pathOf(base)));
  }
}
