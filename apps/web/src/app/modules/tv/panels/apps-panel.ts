import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from '../ui/app-icon';
import { TvIcon } from '../ui/tv-icon';
import { AppsTile } from './apps-tile';

/** Tamanho máximo do nome próprio, o mesmo da API. */
const LABEL_MAX = 40;

/** Quantos azulejos do começo entram em escalonado; o resto já está parado quando alguém rolar até ele. */
const STAGGER_TILES = 12;

/** Minúsculas e sem acento: "Câmera" é achada por "camera". */
function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/**
 * Painel Apps: o lançador dos apps instalados na TV, em grade de azulejos quadrados com o ícone grande e o nome
 * embaixo. Tocar em qualquer azulejo abre o app, esteja ele no controle ou não: "fixar no controle" só decide quem
 * aparece na fileira de atalhos de cima. Sem busca, a grade vem em duas seções, os que estão no controle e os que
 * ficaram de fora. Com busca, uma lista só, com os do controle marcados. App que saiu da TV some da grade (não há o que
 * abrir nem o que fixar). O dono tem o modo Editar: uma lista só com todos os apps, e em cada azulejo os botões de
 * fixar no controle (ou tirar de lá) e de renomear; nesse modo tocar no azulejo não abre nada, para um dedo errado não
 * ligar app na TV. O pacote só aparece nesse modo. Sem lista ainda, um estado vazio com o botão que a pede à TV. Nenhum
 * nome de app vem do código: o nome é o do dono, o que o agente publicou para o app ou, por último, "Atalho" mais a
 * posição.
 */
@Component({
  selector: 'app-tv-apps',
  imports: [AppIcon, AppsTile, NgTemplateOutlet, TvIcon],
  templateUrl: './apps-panel.html',
  styleUrl: './apps-panel.css',
})
export class AppsPanel {
  protected readonly store = inject(TvStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** Renomear e fixar atalhos é só do dono (a API recusa o convidado com 403): o convidado só abre os apps. */
  protected readonly isGuest = inject(SessionState).isGuest;

  /** O app foi aberto na TV: o painel pode fechar e devolver o controle. */
  readonly done = output<void>();

  protected readonly maxLabel = LABEL_MAX;
  protected readonly stagger = STAGGER_TILES;
  /** Só o que está instalado na TV: quem saiu da lista dela não tem o que abrir, então some (da busca e da edição também). */
  protected readonly all = computed(() =>
    (this.store.shortcuts() ?? []).filter((item) => item.installed),
  );
  protected readonly loaded = computed(() => this.store.shortcuts() !== null);

  protected readonly query = signal('');
  protected readonly visible = computed(() => {
    const needle = plain(this.query().trim());
    if (!needle) return this.all();
    return this.all().filter((item) =>
      plain(`${shortcutLabel(item)} ${item.tvLabel ?? ''} ${item.package}`).includes(needle),
    );
  });
  protected readonly searching = computed(() => this.query().trim() !== '');

  /** Modo Editar (só do dono): todos os apps numa lista só, com os botões de fixar e renomear em cada um. */
  protected readonly editMode = signal(false);
  /** Uma lista só, sem seções: na busca e na edição (onde o azulejo não pode mudar de lugar ao ser fixado). */
  protected readonly flat = computed(() => this.searching() || this.editMode());
  /** Os atalhos ativos (os da fileira de cima) e os que ficaram de fora, na ordem da posição. */
  protected readonly pinned = computed(() => this.visible().filter((item) => item.enabled));
  protected readonly unpinned = computed(() => this.visible().filter((item) => !item.enabled));

  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  /** Pedindo a lista à TV (mostra "Buscando…"); o erro, se houver, aparece no aviso do próprio painel. */
  protected readonly refreshing = signal(false);
  /** Já pediu a lista à TV pelo menos uma vez, com sucesso (para dizer que ela segue vazia). */
  protected readonly asked = signal(false);

  protected readonly searchingText = $localize`:@@tv.apps.searching-short:Buscando…`;
  /** O botão de atualizar é só um ícone: o nome acessível diz também o que está acontecendo. */
  protected readonly refreshLabel = computed(() =>
    this.refreshing() ? this.searchingText : $localize`:@@tv.apps.refresh:Atualizar lista`,
  );

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected toggleEdit(): void {
    this.editMode.update((on) => !on);
    this.editing.set(null);
  }

  protected async launch(shortcut: TvShortcut): Promise<void> {
    if (await this.store.launch(shortcut)) this.done.emit();
  }

  protected async refresh(): Promise<void> {
    // Sem `disabled` durante o pedido (o botão perderia o foco): o segundo toque é que não faz nada.
    if (this.refreshing()) return;
    this.refreshing.set(true);
    try {
      if (await this.store.refreshShortcuts()) this.asked.set(true);
    } finally {
      this.refreshing.set(false);
    }
  }

  protected startRename(shortcut: TvShortcut): void {
    this.editing.set(shortcut.id);
    this.draft.set(shortcut.customLabel ?? '');
    this.focusAfterRender('.edit input');
  }

  protected cancelRename(shortcut: TvShortcut): void {
    this.editing.set(null);
    this.focusRenameButton(shortcut);
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected async saveRename(shortcut: TvShortcut, event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    try {
      if (await this.store.renameShortcut(shortcut.id, this.draft().trim())) {
        this.editing.set(null);
        this.focusRenameButton(shortcut);
      }
    } finally {
      this.busy.set(false);
    }
  }

  protected async toggle(shortcut: TvShortcut): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.store.setShortcutEnabled(shortcut.id, !shortcut.enabled);
    } finally {
      this.busy.set(false);
    }
  }

  /** O campo de renomear entra e sai no lugar do azulejo: o foco acompanha, em vez de se perder no painel. */
  private focusRenameButton(shortcut: TvShortcut): void {
    this.focusAfterRender(`[data-rename="${shortcut.id}"]`);
  }

  private focusAfterRender(selector: string): void {
    afterNextRender(() => this.host.nativeElement.querySelector<HTMLElement>(selector)?.focus(), {
      injector: this.injector,
    });
  }
}
