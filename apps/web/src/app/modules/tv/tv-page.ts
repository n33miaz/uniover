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
import { SessionState } from '../../core/session/session-state';
import { TvAccess } from './data/tv-access';
import { TvPrefs } from './data/tv-prefs';
import { TvRoundKeys } from './data/tv-round-keys';
import { TvStore } from './data/tv-store';
import { AppsPanel } from './panels/apps-panel';
import { KeyboardPanel } from './panels/keyboard-panel';
import { MoreKeysPanel } from './panels/more-keys-panel';
import { CustomizeSheet } from './ui/customize-sheet';
import { SuggestionSheet } from './ui/suggestion-sheet';
import { TvMenu, TvMenuChoice } from './ui/tv-menu';
import { TvSwitcher } from './ui/tv-switcher';
import { PowerSheet } from './ui/power-sheet';
import { TvSuggestionRequest } from './ui/shortcut-row';
import { PcOffIcon } from './ui/pc-off-icon';
import { StatusIndicator } from './ui/status-indicator';
import { TvIcon } from './ui/tv-icon';
import { TvPanel } from './ui/tv-panel';
import { TvPageSkeleton } from './ui/tv-page-skeleton';

/**
 * Até quantas letras o nome cabe numa linha no tamanho inteiro (curto) e no médio. A coluna do meio do cabeçalho é a
 * tela menos duas colunas iguais (a da volta e dos três pontos, e a do ponto de estado e do desligar), então o nome vai encolhendo
 * e, se preciso, passa a usar até duas linhas. Os limites só dependem do número de letras, sem medir a tela.
 */
const TITLE_SHORT_MAX = 6;
const TITLE_MEDIUM_MAX = 12;

/**
 * Tela única do módulo da TV: cabeçalho (à esquerda voltar ao Início e os três pontos do menu, no meio o nome e à direita o
 * ponto de estado e a energia), o controle e, por cima dele, o menu, os painéis flutuantes de Apps, Teclado e da
 * sugestão de atalho e as folhas de Personalizar, de desligar e de trocar de TV. O menu reúne os apps da TV, Personalizar e,
 * para o administrador, gerenciar as TVs; escolher uma linha fecha o menu e só então abre o painel dela, um modal por vez. Sem TV
 * configurada o controle dá lugar a um estado vazio com a ação certa para cada conta. O nome é o apelido
 * que a pessoa deu à TV (tocar nele abre Personalizar) e, com mais de uma TV à vista, o nome fica ao lado de uma seta e
 * tocar nele abre a folha que troca de TV (Personalizar segue no menu). O estado da TV (`TvStore`) é um só; ele só fala com o
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
    PcOffIcon,
    ControlPage,
    ViewOnlyPage,
    StatusIndicator,
    TvIcon,
    PowerSheet,
    CustomizeSheet,
    TvPanel,
    TvMenu,
    TvSwitcher,
    SuggestionSheet,
    AppsPanel,
    KeyboardPanel,
    MoreKeysPanel,
    TvPageSkeleton,
  ],
  templateUrl: './tv-page.html',
  styleUrl: './tv-page.css',
})
export class TvPage {
  protected readonly store = inject(TvStore);
  protected readonly prefs = inject(TvPrefs);
  /** O que a conta pode fazer na TV: o que ela não pode, a tela não mostra. */
  protected readonly access = inject(TvAccess);
  protected readonly roundKeys = inject(TvRoundKeys);
  /** Quem administra pode escolher o computador da TV; o convidado só sabe que falta configurar. */
  protected readonly isGuest = inject(SessionState).isGuest;

  protected readonly powerOpen = signal(false);
  protected readonly customizeOpen = signal(false);
  protected readonly menuOpen = signal(false);
  /** A folha que troca de TV, e o título que a abriu (o foco volta a ele). */
  protected readonly switchOpen = signal(false);
  protected readonly switchOpener = signal<HTMLElement | null>(null);
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
  protected readonly keysTitle = $localize`:@@tv.keys.title:Mais botões`;
  protected readonly menuTitle = $localize`:@@tv.menu.title:Mais opções`;
  protected readonly switchTitle = $localize`:@@tv.switch.title:Escolher a TV`;

  /** A conta dona (a que administra) é a única que troca o computador da TV. */
  protected readonly isOwner = computed(() => !this.isGuest());
  /** O botão dos três pontos só existe se o menu tem alguma linha para esta conta. */
  protected readonly hasMenu = computed(
    () => this.access.view() && (this.access.apps() || this.access.control() || this.isOwner()),
  );
  /** Sem computador escolhido para a TV: nada de botões que não chegariam a lugar nenhum. */
  protected readonly unconfigured = computed(() => this.store.status() === 'unconfigured');
  /**
   * "Tentar de Novo" para o agente fora do ar e para a leitura sem resposta: sem rede ou com o servidor acordando a tela já
   * volta sozinha.
   */
  protected readonly canRetry = computed(() => {
    const status = this.store.status();
    return status === 'agent-off' || status === 'pc-off' || status === 'unresponsive';
  });

  /** Há um desligamento agendado (esperando ou já disparando): o botão de energia ganha o relógio miúdo. */
  protected readonly scheduled = computed(() => {
    const active = this.store.powerSchedule();
    return active !== null && (active.status === 'pending' || active.status === 'dispatching');
  });
  protected readonly powerLabel = computed(() =>
    this.scheduled()
      ? $localize`:@@tv.power.label-scheduled:Desligar a TV, há desligamento agendado`
      : $localize`:@@tv.power.label:Desligar a TV`,
  );
  /**
   * Quantos botões tem o lado mais cheio do cabeçalho (a volta e os três pontos à esquerda; o ponto de estado e o desligar à
   * direita): as duas colunas dos lados têm a largura dele, e o nome fica no centro da tela.
   */
  protected readonly sideCount = computed(() =>
    Math.max(
      1 + (this.hasMenu() ? 1 : 0),
      (this.access.view() ? 1 : 0) + (this.access.power() ? 1 : 0),
    ),
  );

  /** Tamanho do nome no cabeçalho: o CSS escolhe a letra e as linhas por esta classe. */
  protected readonly titleSize = computed<'short' | 'medium' | 'long'>(() => {
    const letters = this.prefs.title().length;
    if (letters <= TITLE_SHORT_MAX) return 'short';
    return letters <= TITLE_MEDIUM_MAX ? 'medium' : 'long';
  });

  /** O nome do título falado pelo leitor de tela: o apelido e o que o toque faz. */
  protected readonly titleLabel = computed(() => {
    const name = this.prefs.title();
    return this.store.multiple()
      ? $localize`:@@tv.header.switch:${name}:name:, trocar de TV`
      : $localize`:@@tv.header.customize:${name}:name:, personalizar`;
  });
  /** Com várias TVs o nome é o seletor (qualquer conta que veja a TV); com uma só, é o atalho para Personalizar (de quem controla). */
  protected readonly titleAction = computed<'switch' | 'customize' | null>(() => {
    if (this.store.multiple()) return 'switch';
    return this.access.control() ? 'customize' : null;
  });

  /** O aviso flutuante some enquanto há um painel aberto: o painel mostra o aviso dentro dele. */
  protected readonly showToast = computed(
    () =>
      this.panel() === null &&
      !this.powerOpen() &&
      !this.customizeOpen() &&
      !this.menuOpen() &&
      !this.switchOpen() &&
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
      if (!this.store.multiple()) this.switchOpen.set(false);
      if (!this.access.editShortcuts()) this.suggestion.set(null);
      const apps = this.access.apps();
      const text = this.access.text();
      const keys = this.access.control() && this.roundKeys.more().length > 0;
      this.panel.update((open) =>
        (open === 'apps' && !apps) || (open === 'keyboard' && !text) || (open === 'keys' && !keys)
          ? null
          : open,
      );
    });
  }

  private canOpen(panel: TvPanelName): boolean {
    if (panel === 'keys') return this.access.control() && this.roundKeys.more().length > 0;
    return panel === 'apps' ? this.access.apps() : this.access.text();
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

  protected openSwitch(opener: HTMLElement): void {
    this.switchOpener.set(opener);
    this.switchOpen.set(true);
  }

  /** Escolheu uma TV: troca e fecha a folha (a tela de trás já mostra "conectando" até a nova responder). */
  protected pickTv(id: string, sheet: TvPanel): void {
    this.store.selectTv(id);
    sheet.close();
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
      () => (choice === 'customize' ? this.openCustomize(opener) : this.open(choice, opener)),
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
