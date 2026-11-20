import { Component, ElementRef, computed, inject, input, output, signal } from '@angular/core';
import { TvStore } from '../data/tv-store';
import { filterApps, rankInstalledApps, replacementOrder } from '../data/tv-suggestions';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from './app-icon';
import { AppsUnavailable } from './apps-unavailable';

let nextPickerId = 0;

/**
 * Escolher um app instalado na TV para o controle (vai dentro de um painel). Com `replacing`, o app escolhido toma o
 * lugar daquele atalho na fileira (o antigo sai do controle, mas segue no painel Apps); sem ele, o escolhido só é
 * fixado no fim da fileira. A lista é a que a TV informou, com os ícones dela: as marcas conhecidas primeiro, o resto
 * em ordem alfabética, com busca por nome ou pacote (sem acento nem caixa). Cada app é um botão com o nome visível; as
 * setas para cima e para baixo andam entre a busca e os apps. Sem lista, diz por que e oferece o conserto.
 */
@Component({
  selector: 'app-tv-app-picker',
  imports: [AppIcon, AppsUnavailable],
  templateUrl: './app-picker.html',
  styleUrl: './app-picker.css',
  // As setas sobem dos campos e botões de dentro (que já são focáveis) até aqui.
  host: { '(keydown)': 'onKey($event)' },
})
export class AppPicker {
  protected readonly store = inject(TvStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  /** O atalho a trocar; `null` fixa o escolhido no fim da fileira. */
  readonly replacing = input<TvShortcut | null>(null);
  /** O app escolhido já está no controle: quem hospeda pode fechar. */
  readonly done = output<TvShortcut>();

  protected readonly searchId = `tv-picker-search-${nextPickerId++}`;
  protected readonly query = signal('');
  protected readonly busy = signal(false);

  /** Todos os apps instalados, na ordem de escolha. */
  protected readonly installed = computed(() => rankInstalledApps(this.store.shortcuts()));

  /**
   * Os que dá para escolher: trocando, todos menos o próprio atalho (um que já está no controle muda de lugar para o do
   * antigo); fixando, só os que ainda não estão no controle.
   */
  protected readonly candidates = computed(() => {
    const replacing = this.replacing();
    return this.installed().filter((item) =>
      replacing ? item.id !== replacing.id : !item.enabled,
    );
  });

  protected readonly visible = computed(() => filterApps(this.candidates(), this.query()));

  protected readonly countText = computed(() => {
    const count = this.visible().length;
    return count === 1
      ? $localize`:@@tv.picker.count-one:1 app`
      : $localize`:@@tv.picker.count:${count}:count: apps`;
  });

  protected label(item: TvShortcut): string {
    return shortcutLabel(item);
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  /** Setas andam entre a busca e os apps (o Tab continua passando por todos, como sempre). */
  protected onKey(event: KeyboardEvent): void {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const root = this.host.nativeElement;
    const stops = [
      root.querySelector<HTMLElement>('input[type="search"]'),
      ...root.querySelectorAll<HTMLElement>('button.option'),
    ].filter((item): item is HTMLElement => item !== null);
    const index = stops.indexOf(event.target as HTMLElement);
    if (index < 0) return;
    const next = stops[index + (event.key === 'ArrowDown' ? 1 : -1)];
    if (!next) return;
    event.preventDefault();
    next.focus();
  }

  protected async choose(item: TvShortcut): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (await this.apply(item)) this.done.emit(item);
    } finally {
      this.busy.set(false);
    }
  }

  /**
   * Fixa o escolhido e, trocando, o põe no lugar do antigo antes de tirar o antigo do controle. Cada passo só segue se
   * o anterior foi salvo (o aviso de erro do store diz o que falhou); no pior caso os dois ficam no controle, nunca
   * nenhum.
   */
  private async apply(item: TvShortcut): Promise<boolean> {
    const replacing = this.replacing();
    if (!replacing) return this.store.setShortcutEnabled(item.id, true);

    const ids = replacementOrder(this.store.shortcuts() ?? [], replacing.id, item.id);
    if (ids && !(await this.store.reorder(ids))) return false;
    if (!item.enabled && !(await this.store.setShortcutEnabled(item.id, true))) return false;
    return this.store.setShortcutEnabled(replacing.id, false);
  }
}
