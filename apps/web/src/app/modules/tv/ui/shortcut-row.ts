import {
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { TvAdbPermission } from '../data/tv-adb-permission';
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import { appsAvailability } from '../data/tv-apps-availability';
import { pickSuggestions, suggestionCapacity } from '../data/tv-suggestions';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from './app-icon';
import { AppsUnavailable } from './apps-unavailable';
import { TvIcon } from './tv-icon';

/** O pedido de abrir uma sugestão: o app e o botão tocado, para o painel devolver o foco a ele ao fechar. */
export interface TvSuggestionRequest {
  readonly app: TvShortcut;
  readonly opener: HTMLElement;
}

/** O pedido de abrir o seletor de apps: o atalho a trocar (ou `null`, para fixar mais um) e o botão tocado. */
export interface TvPickRequest {
  readonly replacing: TvShortcut | null;
  readonly opener: HTMLElement;
}

/**
 * Fileira de cima do controle: os atalhos favoritos como azulejos quadrados, todos do mesmo tamanho, que abrem o app
 * (a faixa rola na horizontal quando passa da largura). Cada atalho é o ícone do app; o nome vai no nome acessível do
 * botão e na dica de quem passa o mouse. Sem nenhum atalho ativo, uma dica da altura de um azulejo diz onde fixá-los,
 * para o layout não saltar quando o primeiro chegar. Só apresenta: quem decide o que fazer com o toque é o controle,
 * e o painel Apps abre por um botão do cabeçalho.
 *
 * Numa TV sem nenhum atalho escolhido, quem edita os atalhos vê no lugar da dica sugestões tiradas dos apps que a TV
 * informou como instalados (com o ícone dela), as marcas conhecidas primeiro, tantas quantas cabem na largura da faixa
 * com folga (medida, nunca um número fixo). Cada sugestão tem cara de "ainda não é atalho" (borda tracejada, ícone
 * esmaecido e o sinal de mais) e toca para abrir um painel onde a pessoa confirma, escolhe outro app ou remove. Sem a
 * lista de apps, a faixa diz por que (computador sem ADB, TV sem permissão, TV desligada) e oferece o conserto. Com
 * atalhos e apps ainda fora do controle, quem edita ganha no fim da faixa um azulejo que abre o seletor de apps.
 *
 * Quem não pode abrir apps (`launchable` falso) vê a mesma fileira, mas como figuras: sem botão, sem foco por azulejo,
 * sem realce ao passar o dedo ou o mouse, para nada ali prometer o que não faz. A faixa em si ganha o foco do teclado,
 * porque ela rola quando passa da largura e, sem nenhum botão dentro, o teclado não a alcançaria.
 */
@Component({
  selector: 'app-tv-shortcut-row',
  imports: [AppIcon, AppsUnavailable, TvIcon],
  templateUrl: './shortcut-row.html',
  styleUrl: './shortcut-row.css',
})
export class ShortcutRow {
  /** Só os atalhos ativos, já na ordem da posição. */
  readonly shortcuts = input.required<readonly TvShortcut[]>();
  /** Sem agente ou sem rede os azulejos ficam apagados, mas focáveis (a faixa rolável precisa de algo que o teclado alcance). */
  readonly canSend = input(true);
  /** A pessoa pode abrir apps (`tv:launch`); sem isso os azulejos são só figuras. */
  readonly launchable = input(true);

  readonly open = output<TvShortcut>();
  /** Tocou numa sugestão: a tela abre o painel de confirmar ou remover. */
  readonly suggest = output<TvSuggestionRequest>();
  /** Tocou no azulejo de escolher apps: a tela abre o seletor. */
  readonly pick = output<TvPickRequest>();

  private readonly store = inject(TvStore);
  /** O ADB da TV pede permissão: os azulejos mostram um sinal discreto (a folha pede, e "Agora não" não esconde isto). */
  protected readonly needsPermission = inject(TvAdbPermission).needs;
  private readonly prefs = inject(TvPrefs);
  private readonly top = viewChild.required<ElementRef<HTMLElement>>('top');
  /** Só quem edita os atalhos fixa apps: para os outros a dica não manda abrir o painel para fixar. */
  protected readonly canEdit = inject(TvAccess).editShortcuts;

  /** A lista ainda não chegou, nem a guardada: fileira vazia nesse instante não quer dizer "sem atalhos". */
  private readonly loading = computed(() => this.store.shortcuts() === null);
  protected readonly showHint = computed(() => this.shortcuts().length === 0 && !this.loading());
  /** Esqueleto só depois da espera curta do store e só enquanto a lista não chegou; nunca em laço (o store tem teto). */
  protected readonly showSkeleton = computed(
    () => this.shortcuts().length === 0 && this.loading() && !!this.store.shortcutsLoading(),
  );
  protected readonly placeholders = [0, 1, 2, 3];
  /** A lista não veio dentro do prazo do store (nunca é esqueleto em laço): fica uma frase no lugar da fileira. */
  protected readonly failed = computed(
    () => this.shortcuts().length === 0 && this.loading() && !!this.store.shortcutsFailed(),
  );

  /** A largura útil da faixa, medida depois de desenhada e a cada mudança; 0 até a primeira medida (e sem como medir). */
  private readonly width = signal(0);

  /**
   * As sugestões à vista: só para quem edita os atalhos (confirmar fixa um atalho), com a faixa sem atalho nenhum, e só
   * apps instalados que a pessoa não removeu, no máximo os que cabem. Vazio quando não cabe nenhum (ou a TV ainda não
   * informou apps), e então vale a dica, ou o motivo de não haver lista.
   */
  protected readonly suggestions = computed<readonly TvShortcut[]>(() =>
    this.canEdit() && this.showHint()
      ? pickSuggestions(
          this.store.shortcuts(),
          this.prefs.dismissedSuggestions(),
          suggestionCapacity(this.width()),
        )
      : [],
  );

  /** A lista de apps não está à vista por um motivo que a pessoa pode entender (e às vezes consertar). */
  protected readonly unavailable = computed(
    () =>
      this.showHint() &&
      appsAvailability({
        shortcuts: this.store.shortcuts(),
        state: this.store.state(),
        tv: this.store.selectedTv(),
      }) !== 'ready',
  );

  /** O azulejo de escolher apps: só para quem edita, com atalhos à vista e algum app instalado ainda fora do controle. */
  protected readonly canPick = computed(
    () =>
      this.canEdit() &&
      this.shortcuts().length > 0 &&
      (this.store.shortcuts() ?? []).some((item) => item.installed && !item.enabled),
  );

  constructor() {
    const destroyRef = inject(DestroyRef);
    afterNextRender(() => {
      const element = this.top().nativeElement;
      this.width.set(element.clientWidth);
      if (typeof ResizeObserver !== 'function') return;
      const observer = new ResizeObserver((entries) => {
        const box = entries[0]?.contentRect;
        if (box) this.width.set(Math.round(box.width));
      });
      observer.observe(element);
      destroyRef.onDestroy(() => observer.disconnect());
    });
  }

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }

  /** O nome acessível do azulejo: com a TV pedindo permissão, ele diz isso também. */
  protected accessibleName(shortcut: TvShortcut): string {
    const name = shortcutLabel(shortcut);
    return this.needsPermission()
      ? $localize`:@@tv.shortcuts.needs-permission:${name}:name:, precisa de permissão`
      : name;
  }

  /** O nome acessível da sugestão diz o que ela é e o que o toque faz: abre um painel, não o app. */
  protected suggestionLabel(app: TvShortcut): string {
    const name = shortcutLabel(app);
    return $localize`:@@tv.shortcuts.suggestion:Sugestão: ${name}:name:`;
  }

  protected suggestApp(app: TvShortcut, event: Event): void {
    this.suggest.emit({ app, opener: event.currentTarget as HTMLElement });
  }

  protected pickApp(event: Event): void {
    this.pick.emit({ replacing: null, opener: event.currentTarget as HTMLElement });
  }
}
