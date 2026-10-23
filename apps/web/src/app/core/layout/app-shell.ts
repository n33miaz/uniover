import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
  viewChild,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { guestHome } from '../auth/role.guard';
import { ModuleRegistry } from '../modules/module-registry';
import { InstallHint } from '../pwa/install-hint';
import { SessionState } from '../session/session-state';
import { TabBar } from '../../shared/ui/tab-bar/tab-bar';
import { GearIcon } from './gear-icon';
import { ShellBack, collectShellData } from './route-data';

/** Para onde a seta leva por padrão: o dono volta ao Início; o convidado, que não tem Início, volta ao módulo dele. */
const OWNER_BACK: ShellBack = {
  link: '/',
  label: $localize`:@@shell.back-home-label:Voltar ao Início`,
};

/** A seta do convidado dentro de Ajustes: leva à tela inicial dele (o controle da TV, o Treino ou "sem acesso"). */
function guestBack(link: string): ShellBack {
  switch (link) {
    case '/treino':
      return { link, label: $localize`:@@shell.back-training-label:Voltar ao Treino` };
    case '/tv':
      return { link, label: $localize`:@@shell.back-control-label:Voltar ao controle` };
    default:
      return { link, label: $localize`:@@shell.back-label:Voltar` };
  }
}

/** O que ocupa o primeiro lugar do cabeçalho: a seta de voltar ou, para quem não tem Início, o botão de configurações. */
type ShellLead = ({ readonly kind: 'back' } & ShellBack) | { readonly kind: 'settings' };

/**
 * Casca de tela: na Início só o conteúdo; dentro de um módulo, cabeçalho com a seta de voltar ao Início e o
 * título, e a barra de abas embaixo. Quem decide é o `data` da rota (`title`, `tabs` e `back`). Hospeda também a
 * folha do atalho na tela de início (`app-install-hint`), que vale para dono e convidado.
 *
 * Quem não tem Início (o convidado) não ganha seta ali: no lugar dela fica um botão redondo de configurações do
 * sistema. Dentro de Ajustes ele tem a seta (para o controle, ou para a lista), porque ali o botão não levaria a lugar nenhum.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, TabBar, InstallHint, GearIcon],
  template: `
    @if (data().shellStyle !== 'training' && data().title; as title) {
      <header class="bar" [class.training]="data().shellStyle === 'training'">
        @let current = lead();
        @if (current.kind === 'back') {
          <a [routerLink]="current.link" class="back ui-tap" [attr.aria-label]="current.label">
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
        } @else {
          <a
            routerLink="/ajustes"
            class="back settings ui-tap"
            aria-label="Ajustes"
            i18n-aria-label="@@shell.settings-label"
          >
            <app-gear-icon />
          </a>
        }
        <h1 #pageTitle tabindex="-1">{{ title }}</h1>
      </header>
    }
    <main
      [class.no-header]="!data().title"
      [class.training-main]="data().shellStyle === 'training'"
    >
      <router-outlet />
    </main>
    @if (tabs().length > 0) {
      <app-tab-bar class="tabs" [tabs]="tabs()" [variant]="data().shellStyle ?? 'default'" />
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
    .bar.training {
      gap: var(--space-2);
      padding-block: var(--space-1);
      background: linear-gradient(
        112deg,
        color-mix(in srgb, var(--a-accent) 14%, var(--a-surface)),
        var(--a-surface) 72%
      );
      border-bottom-color: color-mix(in srgb, var(--a-accent) 20%, var(--a-line));
    }
    .bar.training h1 {
      font-size: 1.25rem;
      font-weight: 760;
      letter-spacing: -0.025em;
    }
    .bar.training .module-mark {
      display: grid;
      flex: none;
      place-items: center;
      width: 34px;
      height: 34px;
      border: 1px solid color-mix(in srgb, var(--a-accent) 18%, transparent);
      border-radius: 11px;
      background: var(--a-accent-soft);
      color: var(--a-accent-ink);
    }
    .bar.training .module-mark svg {
      width: 21px;
      height: 21px;
    }
    .bar.training .back {
      border-color: transparent;
      border-radius: var(--radius-sm);
      background: transparent;
      box-shadow: none;
      color: var(--a-accent-ink);
    }
    .bar.training .back:hover,
    .bar.training .back:active {
      background: var(--a-accent-soft);
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
    /* A engrenagem gira um pouco, no lugar do deslize da seta. */
    .settings app-gear-icon {
      transition: rotate var(--dur-slow) var(--ease-out);
    }
    @media (hover: hover) {
      .back:hover {
        background: var(--a-surface-2);
      }
      .back:hover svg {
        translate: -2px 0;
      }
      .settings:hover app-gear-icon {
        rotate: 45deg;
      }
      .settings:hover svg {
        translate: none;
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .back,
      .back svg,
      .settings app-gear-icon {
        transition: none;
      }
      .back:hover svg {
        translate: none;
      }
      .settings:hover app-gear-icon {
        rotate: none;
      }
    }
    h1 {
      min-width: 0;
      font-size: 1.5rem;
      overflow-wrap: anywhere;
    }
    /* O título recebe o foco ao navegar dentro de Ajustes (para leitor de tela e teclado): sem contorno, não é controle. */
    h1:focus {
      outline: none;
    }
    main {
      flex: 1 1 auto;
    }
    /* Sem cabeçalho (Início) o conteúdo começa abaixo da área segura do aparelho. */
    main.no-header {
      padding-top: calc(var(--gutter) + env(safe-area-inset-top));
    }
    main.training-main {
      padding: 0;
    }
    .tabs {
      position: sticky;
      bottom: 0;
    }
  `,
})
export class AppShell {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly registry = inject(ModuleRegistry);
  private readonly injector = inject(Injector);

  /** Traços da seta de voltar (a mesma seta da tela da TV): a haste e a ponta. */
  protected readonly backArrow = ['M19 12H5', 'M11 18l-6-6 6-6'] as const;

  /** Convidado: sem Início, então sem a seta para ele (no lugar vai o botão de configurações). */
  protected readonly isGuest = this.session.isGuest;

  protected readonly data = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => collectShellData(this.router.routerState.snapshot.root)),
      startWith(collectShellData(this.router.routerState.snapshot.root)),
    ),
    { requireSync: true },
  );

  protected readonly tabs = computed(() => this.data().tabs ?? []);

  /** A seta (para o destino da rota, ou o Início, ou o controle) ou, para quem não tem Início, o botão de configurações. */
  protected readonly lead = computed<ShellLead>(() => {
    const data = this.data();
    if (data.back) return { kind: 'back', ...data.back };
    if (!this.isGuest()) return { kind: 'back', ...OWNER_BACK };
    return data.settings
      ? { kind: 'back', ...guestBack(guestHome(this.session, this.registry)) }
      : { kind: 'settings' };
  });

  private readonly pageTitle = viewChild<ElementRef<HTMLElement>>('pageTitle');

  constructor() {
    // Dentro de Ajustes cada tela nova leva o foco ao título: sem isso o foco ficaria num link que já não existe (e quem
    // usa leitor de tela não ouviria a tela nova). A primeira tela da casca fica de fora: o foco de uma página recém
    // aberta é do navegador.
    let first = true;
    this.router.events
      .pipe(
        filter((event) => event instanceof NavigationEnd),
        takeUntilDestroyed(),
      )
      .subscribe(() => {
        if (first) {
          first = false;
          return;
        }
        if (!collectShellData(this.router.routerState.snapshot.root).settings) return;
        afterNextRender(() => this.pageTitle()?.nativeElement.focus({ preventScroll: true }), {
          injector: this.injector,
        });
      });

    // Rede de segurança do guarda de boas-vindas: se o usuário só chega depois de a casca abrir (servidor acordando) e o
    // nome ainda não foi escolhido, a pergunta vem na hora, guardando onde a pessoa estava.
    effect(() => {
      if (!this.session.needsWelcome()) return;
      untracked(
        () =>
          void this.router.navigateByUrl(this.auth.welcomeUrlTree(this.router.url), {
            replaceUrl: true,
          }),
      );
    });
  }
}
