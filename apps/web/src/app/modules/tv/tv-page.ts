import {
  Component,
  DestroyRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ControlPage } from './pages/control.page';
import { ViewOnlyPage } from './pages/view-only.page';
import { TV_PANEL_PARAM, TvPanelName, panelFromParam } from './data/tv-panels';
import { GearIcon } from '../../core/layout/gear-icon';
import { SessionState } from '../../core/session/session-state';
import { TvAccess } from './data/tv-access';
import { TvPrefs } from './data/tv-prefs';
import { TvStore } from './data/tv-store';
import { AppsPanel } from './panels/apps-panel';
import { KeyboardPanel } from './panels/keyboard-panel';
import { CustomizeSheet } from './ui/customize-sheet';
import { SuggestionSheet } from './ui/suggestion-sheet';
import { TvMenu, TvMenuChoice } from './ui/tv-menu';
import { PowerSheet } from './ui/power-sheet';
import { TvSuggestionRequest } from './ui/shortcut-row';
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
 * Tela única do módulo da TV: cabeçalho (à esquerda voltar ao Início e a energia, no meio o nome com o ponto de estado e
 * à direita os três pontos do menu), o controle e, por cima dele, o menu, os painéis flutuantes de Apps, Teclado e da
 * sugestão de atalho e as folhas de Personalizar e de desligar. O menu reúne os apps da TV, Personalizar e, para o
 * administrador, trocar a TV; escolher uma linha fecha o menu e só então abre o painel dela, um modal por vez. Sem TV
 * configurada o controle dá lugar a um estado vazio com a ação certa para cada conta. O nome é o apelido
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
    ViewOnlyPage,
    StatusIndicator,
    TvIcon,
    PowerSheet,
    CustomizeSheet,
    TvPanel,
    TvMenu,
    SuggestionSheet,
    AppsPanel,
    KeyboardPanel,
  ],
  templateUrl: './tv-page.html',
  styleUrl: './tv-page.css',
})
export class TvPage {
  protected readonly store = inject(TvStore);
  protected readonly prefs = inject(TvPrefs);
  /** O que a conta pode fazer na TV: o que ela não pode, a tela não mostra. */
  protected readonly access = inject(TvAccess);
  /** Convidado vê só o controle: sem o retorno ao Início (ele não tem Início); no lugar, o botão de configurações. */
  protected readonly isGuest = inject(SessionState).isGuest;

  protected readonly powerOpen = signal(false);
  protected readonly customizeOpen = signal(false);
  protected readonly menuOpen = signal(false);
  /** O botão dos três pontos: o menu devolve o foco a ele, e os painéis que abrem pelo menu também. */
  protected readonly menuOpener = signal<HTMLElement | null>(null);
  /** A linha do menu escolhida: o painel dela só abre depois que o menu terminar de sair. */
  private pendingChoice: TvMenuChoice | null = null;
  /** A sugestão de atalho aberta (o app e o botão tocado), ou nada. */
  protected readonly suggestion = signal<TvSuggestionRequest | null>(null);
  private suggestionWantsApps = false;
  /** Pedindo de novo o estado ao agente (o botão "Tentar de novo" fica ocupado até voltar). */
  protected readonly retrying = signal(false);
  /** O título que abriu Personalizar, para devolver o foco a ele (o Safari não foca botão ao toque). */
  private customizeOpener: HTMLElement | null = null;
  /** Painel flutuante aberto no momento (um por vez). */
  protected readonly panel = signal<TvPanelName | null>(null);
  /** O botão que abriu o painel (vazio quando o painel abriu pelo endereço). */
  protected readonly panelOpener = signal<HTMLElement | null>(null);

  /**
   * O painel dos três pontos se chama Apps da TV quando traz a grade de apps; para quem só controla (sem abrir apps nem
   * editar atalhos) ele traz só a limpeza da TV e se chama Opções da TV, no botão e no título.
   */
  protected readonly appsTitle = computed(() =>
    this.access.appList()
      ? $localize`:@@tv.apps.title:Apps da TV`
      : $localize`:@@tv.options.title:Opções da TV`,
  );
  protected readonly appsLabel = computed(() =>
    this.access.appList()
      ? $localize`:@@tv.apps.open:Apps da TV`
      : $localize`:@@tv.options.open:Opções da TV`,
  );
  protected readonly keyboardTitle = $localize`:@@tv.keyboard.title:Teclado`;
  protected readonly menuTitle = $localize`:@@tv.menu.title:Mais opções`;

  /** A conta dona (a que administra) é a única que troca o computador da TV. */
  protected readonly isOwner = computed(() => !this.isGuest());
  /** O botão dos três pontos só existe se o menu tem alguma linha para esta conta. */
  protected readonly hasMenu = computed(
    () => this.access.view() && (this.access.apps() || this.access.control() || this.isOwner()),
  );
  /** Sem computador escolhido para a TV: nada de botões que não chegariam a lugar nenhum. */
  protected readonly unconfigured = computed(() => this.store.status() === 'unconfigured');
  /** "Tentar de novo" só para o agente fora do ar: sem rede ou com o servidor acordando a tela já volta sozinha. */
  protected readonly canRetry = computed(() => this.store.status() === 'agent-off');

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
    () =>
      this.panel() === null &&
      !this.powerOpen() &&
      !this.customizeOpen() &&
      !this.menuOpen() &&
      this.suggestion() === null,
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
      // O endereço antigo não abre o que os botões escondem: sem permissão o painel não abre, mas o parâmetro sai igual.
      if (this.canOpen(requested)) {
        this.panelOpener.set(null);
        this.panel.set(requested);
      }
      void this.router.navigate([], {
        relativeTo: this.route,
        queryParams: { [TV_PANEL_PARAM]: null },
        queryParamsHandling: 'merge',
        replaceUrl: true,
      });
    });

    // A sessão pode trazer outra lista de permissões com a tela aberta: o que a pessoa deixou de poder usar fecha, em vez
    // de ficar aberto (ou de reaparecer se a permissão voltar).
    effect(() => {
      if (!this.access.power()) this.powerOpen.set(false);
      if (!this.access.control()) this.customizeOpen.set(false);
      if (!this.hasMenu()) this.menuOpen.set(false);
      if (!this.access.editShortcuts()) this.suggestion.set(null);
      const apps = this.access.apps();
      const control = this.access.control();
      this.panel.update((open) =>
        (open === 'apps' && !apps) || (open === 'keyboard' && !control) ? null : open,
      );
    });
  }

  private canOpen(panel: TvPanelName): boolean {
    return panel === 'apps' ? this.access.apps() : this.access.control();
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

  protected openMenu(opener: HTMLElement): void {
    this.menuOpener.set(opener);
    this.menuOpen.set(true);
  }

  /** Uma linha do menu: guarda a escolha e fecha o menu; o painel dela abre quando a saída terminar (`menuClosed`). */
  protected chooseFromMenu(choice: TvMenuChoice, menu: TvPanel): void {
    this.pendingChoice = choice;
    menu.close();
  }

  protected menuClosed(): void {
    this.menuOpen.set(false);
    const choice = this.pendingChoice;
    this.pendingChoice = null;
    const opener = this.menuOpener();
    if (!choice || !opener) return;
    // Com o menu ainda no DOM a tela está inerte: o painel seguinte só abre depois que ele sair.
    afterNextRender(
      () => (choice === 'apps' ? this.open('apps', opener) : this.openCustomize(opener)),
      { injector: this.injector },
    );
  }

  protected openSuggestion(request: TvSuggestionRequest): void {
    this.suggestion.set(request);
  }

  /** O painel da sugestão pediu o Apps: fecha primeiro, abre o Apps depois (um modal por vez). */
  protected suggestionToApps(panel: TvPanel): void {
    this.suggestionWantsApps = true;
    panel.close();
  }

  protected suggestionClosed(): void {
    const request = this.suggestion();
    this.suggestion.set(null);
    const wantsApps = this.suggestionWantsApps;
    this.suggestionWantsApps = false;
    if (!wantsApps || !request) return;
    afterNextRender(() => this.open('apps', request.opener), { injector: this.injector });
  }

  /** Lê o estado de novo e tenta acordar o controle: o que a pessoa faria à mão com o agente fora do ar. */
  protected async retry(): Promise<void> {
    if (this.retrying()) return;
    this.retrying.set(true);
    try {
      await this.store.refresh();
      await this.store.wake();
    } finally {
      this.retrying.set(false);
    }
  }

  protected closeCustomize(): void {
    this.customizeOpen.set(false);
    // Com a folha ainda no DOM a tela está inerte e o foco não entra: devolve-o depois que ela sair.
    afterNextRender(() => this.customizeOpener?.focus({ preventScroll: true }), {
      injector: this.injector,
    });
  }
}
