import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { filter, map, startWith } from 'rxjs';
import { AuthService } from '../auth/auth.service';
import { ModulePrefs } from '../modules/module-prefs';
import { InstallHint } from '../pwa/install-hint';
import { TvPermissionHost } from '../tv-permission/tv-permission-host';
import { SessionState } from '../session/session-state';
import { PageTopBar } from '../../shared/ui/page-top-bar';
import { TabBar } from '../../shared/ui/tab-bar/tab-bar';
import { ShellBack, collectShellData } from './route-data';

/** Para onde a seta leva por padrão: toda conta volta ao Início. */
const HOME_BACK: ShellBack = {
  link: '/',
  label: $localize`:@@shell.back-home-label:Voltar ao Início`,
};

/**
 * Casca de tela: na Início só o conteúdo; dentro de um módulo, cabeçalho com a seta de voltar ao Início e o
 * título, e a barra de abas embaixo. Quem decide é o `data` da rota (`title`, `tabs` e `back`). Hospeda também a
 * folha do atalho na tela de início (`app-install-hint`), que vale para dono e convidado.
 *
 * Toda conta tem a seta de volta ao Início. O botão de configurações existe só no topo da Início (dono e convidado):
 * nenhum módulo tem atalho para Ajustes.
 */
@Component({
  selector: 'app-shell',
  imports: [RouterOutlet, RouterLink, TabBar, InstallHint, TvPermissionHost, PageTopBar],
  template: `
    @if (data().shellStyle !== 'training' && data().title; as title) {
      <app-page-top-bar [title]="title" [backLabel]="lead().label" (back)="goBack()" />
    }
    <main
      [class.no-header]="!data().title"
      [class.settings-main]="data().settings"
      [class.training-main]="data().shellStyle === 'training'"
    >
      <router-outlet />
    </main>
    @if (tabs().length > 0) {
      <app-tab-bar class="tabs" [tabs]="tabs()" [variant]="data().shellStyle ?? 'default'" />
    }
    <!-- Fora do <main>: a folha do atalho na tela de início é diálogo (camada do topo) e nunca entra no layout. -->
    <app-install-hint />
    <!-- Antes de qualquer tela: a TV que esqueceu o UniOver pede o aceite numa folha modal (só se houver pendência). -->
    <app-tv-permission />
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      min-height: 100dvh;
    }
    /* Respiro em cima, como o da Início e o do controle da TV (o main dá o mesmo à margem de baixo). */
    app-page-top-bar {
      padding-top: var(--gutter);
    }
    main {
      flex: 1 1 auto;
    }
    /* Sem cabeçalho (Início) o conteúdo começa abaixo da área segura do aparelho. */
    main.no-header {
      padding-top: calc(var(--gutter) + env(safe-area-inset-top));
    }
    /* Em Ajustes (e nas telas dentro dele) os cartões têm o canto do controle da TV, não o do cartão grande. */
    main.settings-main {
      --radius-lg: var(--radius);
    }
    main.training-main {
      padding: 0;
    }
    .tabs {
      position: sticky;
      bottom: var(--kb-inset);
    }
  `,
})
export class AppShell {
  private readonly router = inject(Router);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly injector = inject(Injector);

  protected readonly data = toSignal(
    this.router.events.pipe(
      filter((event) => event instanceof NavigationEnd),
      map(() => collectShellData(this.router.routerState.snapshot.root)),
      startWith(collectShellData(this.router.routerState.snapshot.root)),
    ),
    { requireSync: true },
  );

  protected readonly tabs = computed(() => this.data().tabs ?? []);

  /** A seta: para o destino da rota (dentro de Ajustes, a lista) ou, no resto, o Início. */
  protected readonly lead = computed<ShellBack>(() => this.data().back ?? HOME_BACK);

  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  protected goBack(): void {
    void this.router.navigateByUrl(this.lead().link);
  }

  constructor() {
    // Vivo em toda tela autenticada (e não só na Início): a sincronização da Início com a conta começa quando a sessão se
    // confirma, mesmo para quem abre direto o Treino ou a TV pelo atalho da tela de início.
    inject(ModulePrefs);

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
        afterNextRender(() => this.focusTitle(), { injector: this.injector });
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

  /** O título da barra recebe o foco só por código: não é controle, então ganha `tabindex=-1` aqui e não no componente da barra. */
  private focusTitle(): void {
    const heading = this.host.nativeElement.querySelector<HTMLElement>('app-page-top-bar h1');
    if (!heading) return;
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  }
}
