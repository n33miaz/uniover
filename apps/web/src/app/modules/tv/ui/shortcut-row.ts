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
import { TvPrefs } from '../data/tv-prefs';
import { TvStore } from '../data/tv-store';
import {
  TV_SUGGESTED_APPS,
  TvSuggestedApp,
  matchSuggestion,
  pickSuggestions,
  suggestionCapacity,
} from '../data/tv-suggestions';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from './app-icon';
import { AppIconSubject } from './app-icon-source';

/** O pedido de abrir uma sugestão: o app e o botão tocado, para o painel devolver o foco a ele ao fechar. */
export interface TvSuggestionRequest {
  readonly app: TvSuggestedApp;
  readonly opener: HTMLElement;
}

/**
 * Fileira de cima do controle: os atalhos favoritos como azulejos quadrados, todos do mesmo tamanho, que abrem o app
 * (a faixa rola na horizontal quando passa da largura). Cada atalho é o ícone do app; o nome vai no nome acessível do
 * botão e na dica de quem passa o mouse. Sem nenhum atalho ativo, uma dica da altura de um azulejo diz onde fixá-los,
 * para o layout não saltar quando o primeiro chegar. Só apresenta: quem decide o que fazer com o toque é o controle,
 * e o painel Apps abre por um botão do cabeçalho.
 *
 * Numa TV sem nenhum atalho escolhido, quem edita os atalhos vê no lugar da dica algumas sugestões de apps conhecidos,
 * tantas quantas cabem na largura da faixa com folga (medida, nunca um número fixo). Cada sugestão tem cara de "ainda
 * não é atalho" (borda tracejada, ícone esmaecido e o sinal de mais) e toca para abrir um painel onde a pessoa confirma
 * ou remove; nada é presumido sobre o app estar instalado.
 *
 * Quem não pode abrir apps (`launchable` falso) vê a mesma fileira, mas como figuras: sem botão, sem foco por azulejo,
 * sem realce ao passar o dedo ou o mouse, para nada ali prometer o que não faz. A faixa em si ganha o foco do teclado,
 * porque ela rola quando passa da largura e, sem nenhum botão dentro, o teclado não a alcançaria.
 */
@Component({
  selector: 'app-tv-shortcut-row',
  imports: [AppIcon],
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

  private readonly store = inject(TvStore);
  private readonly prefs = inject(TvPrefs);
  private readonly top = viewChild.required<ElementRef<HTMLElement>>('top');
  /** Só quem edita os atalhos fixa apps: para os outros a dica não manda abrir o painel para fixar. */
  protected readonly canEdit = inject(TvAccess).editShortcuts;

  /** A lista ainda não chegou, nem a guardada: fileira vazia nesse instante não quer dizer "sem atalhos". */
  private readonly loading = computed(() => this.store.shortcuts() === null);
  protected readonly showHint = computed(() => this.shortcuts().length === 0 && !this.loading());

  /** A largura útil da faixa, medida depois de desenhada e a cada mudança; 0 até a primeira medida (e sem como medir). */
  private readonly width = signal(0);

  /**
   * As sugestões à vista: só para quem edita os atalhos (confirmar fixa um atalho), com a faixa sem atalho nenhum, e as
   * que a pessoa não removeu, no máximo as que cabem. Vazio quando não cabe nenhuma, e então vale a dica de sempre.
   */
  protected readonly suggestions = computed<readonly TvSuggestedApp[]>(() =>
    this.canEdit() && this.showHint()
      ? pickSuggestions(this.prefs.dismissedSuggestions(), suggestionCapacity(this.width()))
      : [],
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

  /** O nome acessível da sugestão diz o que ela é e o que o toque faz: abre um painel, não o app. */
  protected suggestionLabel(app: TvSuggestedApp): string {
    const name = app.label;
    return $localize`:@@tv.shortcuts.suggestion:Sugestão: ${name}:name:`;
  }

  /** Com o atalho real vem o ícone real; sem ele, a inicial do nome sobre a cor do pacote. */
  protected subject(app: TvSuggestedApp): AppIconSubject {
    return (
      matchSuggestion(app, this.store.shortcuts()) ?? {
        package: app.packages[0] ?? app.key,
        position: TV_SUGGESTED_APPS.indexOf(app) + 1,
        customLabel: null,
        tvLabel: app.label,
      }
    );
  }

  protected suggestApp(app: TvSuggestedApp, event: Event): void {
    this.suggest.emit({ app, opener: event.currentTarget as HTMLElement });
  }
}
