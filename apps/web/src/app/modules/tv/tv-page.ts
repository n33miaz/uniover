import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ControlPage } from './pages/control.page';
import { TV_PANEL_PARAM, TvPanelName, panelFromParam } from './data/tv-panels';
import { GearIcon } from '../../core/layout/gear-icon';
import { SessionState } from '../../core/session/session-state';
import { TvPrefs } from './data/tv-prefs';
import { TvStore } from './data/tv-store';
import { AppsPanel } from './panels/apps-panel';
import { KeyboardPanel } from './panels/keyboard-panel';
import { CustomizeSheet } from './ui/customize-sheet';
import { PowerSheet } from './ui/power-sheet';
import { StatusIndicator } from './ui/status-indicator';
import { TvIcon } from './ui/tv-icon';
import { TvPanel } from './ui/tv-panel';

/**
 * Até quantas letras o nome cabe numa linha no tamanho inteiro (curto) e no médio. A coluna do meio do cabeçalho é a
 * tela menos duas colunas iguais (os botões dos lados e o ponto de estado ficam com elas), então o nome vai encolhendo
 * e, se preciso, passa a usar até duas linhas. Os limites são os de antes de o Apps ir para a esquerda, quando a coluna
 * era mais estreita; seguem valendo porque só dependem do número de letras, sem medir a tela.
 */
const TITLE_SHORT_MAX = 6;
const TITLE_MEDIUM_MAX = 12;

/**
 * Tela única do módulo da TV: cabeçalho (à esquerda voltar ao Início e os três pontos do painel Apps, no meio o nome com
 * o ponto de estado e à direita a energia), o controle e,
 * por cima dele, os painéis flutuantes de Apps e Teclado e as folhas de Personalizar e de desligar. O nome é o apelido
 * que a pessoa deu à TV (tocar nele abre Personalizar). O estado da TV (`TvStore`) é um só; ele só fala com o
 * servidor enquanto esta tela existe (ao sair, o fluxo e o "aquecer" param). Fica na raiz, e não nos `providers`
 * do componente, porque o recurso de providers de componente puxaria código do Angular para o pacote inicial.
 *
 * Os endereços antigos `/tv/apps` e `/tv/teclado` redirecionam para `/tv?painel=...`: ao chegar com esse
 * parâmetro a tela abre o painel e tira o parâmetro do endereço (recarregar não reabre).
 */
@Component({
  selector: 'app-tv-page',
  imports: [
    RouterLink,
    GearIcon,
    ControlPage,
    StatusIndicator,
    TvIcon,
    PowerSheet,
    CustomizeSheet,
    TvPanel,
    AppsPanel,
    KeyboardPanel,
  ],
  templateUrl: './tv-page.html',
  styleUrl: './tv-page.css',
})
export class TvPage {
  protected readonly store = inject(TvStore);
  protected readonly prefs = inject(TvPrefs);
  /** Convidado vê só o controle: sem o retorno ao Início (ele não tem Início); no lugar, o botão de configurações. */
  protected readonly isGuest = inject(SessionState).isGuest;

  protected readonly powerOpen = signal(false);
  protected readonly customizeOpen = signal(false);
  /** O título que abriu Personalizar, para devolver o foco a ele (o Safari não foca botão ao toque). */
  private customizeOpener: HTMLElement | null = null;
  /** Painel flutuante aberto no momento (um por vez). */
  protected readonly panel = signal<TvPanelName | null>(null);
  /** O botão que abriu o painel (vazio quando o painel abriu pelo endereço). */
  protected readonly panelOpener = signal<HTMLElement | null>(null);

  protected readonly appsTitle = $localize`:@@tv.apps.title:Apps da TV`;
  protected readonly keyboardTitle = $localize`:@@tv.keyboard.title:Teclado`;

  /** Tamanho do nome no cabeçalho: o CSS escolhe a letra e as linhas por esta classe. */
  protected readonly titleSize = computed<'short' | 'medium' | 'long'>(() => {
    const letters = this.prefs.title().length;
    if (letters <= TITLE_SHORT_MAX) return 'short';
    return letters <= TITLE_MEDIUM_MAX ? 'medium' : 'long';
  });

  /** O nome do título falado pelo leitor de tela: o apelido e o que o toque faz. */
  protected readonly titleLabel = computed(() => {
    const name = this.prefs.title();
    return $localize`:@@tv.header.customize:${name}:name:, personalizar`;
  });

  /** O aviso flutuante some enquanto há um painel aberto: o painel mostra o aviso dentro dele. */
  protected readonly showToast = computed(
    () => this.panel() === null && !this.powerOpen() && !this.customizeOpen(),
  );

  private readonly injector = inject(Injector);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);

  constructor() {
    // O store só abre o fluxo e começa a "aquecer" quando a tela nasce e para quando ela é destruída.
    this.store.start();
    inject(DestroyRef).onDestroy(() => this.store.stop());

    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((params) => {
      const requested = panelFromParam(params.get(TV_PANEL_PARAM));
      if (requested === null) return;
      this.panelOpener.set(null);
      this.panel.set(requested);
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { [TV_PANEL_PARAM]: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });
  }

  protected open(panel: TvPanelName, opener: HTMLElement): void {
    this.panelOpener.set(opener);
    this.panel.set(panel);
  }

  protected closePanel(): void {
    this.panel.set(null);
  }

  protected openCustomize(opener: HTMLElement): void {
    this.customizeOpener = opener;
    this.customizeOpen.set(true);
  }

  protected closeCustomize(): void {
    this.customizeOpen.set(false);
    // Com a folha ainda no DOM a tela está inerte e o foco não entra: devolve-o depois que ela sair.
    afterNextRender(() => this.customizeOpener?.focus({ preventScroll: true }), {
      injector: this.injector,
    });
  }
}
