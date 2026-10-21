import { NgTemplateOutlet } from '@angular/common';
import {
  Component,
  ElementRef,
  Injector,
  afterNextRender,
  computed,
  effect,
  inject,
  output,
  signal,
} from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { controlRanks, movedOrder } from '../data/tv-order';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { AppIcon } from '../ui/app-icon';
import { CleanupSheet } from '../ui/cleanup-sheet';
import { TvIcon } from '../ui/tv-icon';
import { AppsTile, TileMove } from './apps-tile';

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
 * abrir nem o que fixar). Quem edita os atalhos tem o modo Editar: uma lista só com todos os apps, e em cada azulejo os botões de
 * fixar no controle (ou tirar de lá) e de renomear; nesse modo tocar no azulejo não abre nada, para um dedo errado não
 * ligar app na TV. O pacote só aparece nesse modo. Nele, quem está no controle também ganha as setas que mudam a ordem da
 * fileira de atalhos (só sem busca, que esconde os vizinhos). Sem lista ainda, um estado vazio com o botão que a pede à TV. Nenhum
 * nome de app vem do código: o nome é o do dono, o que o agente publicou para o app ou, por último, "Atalho" mais a
 * posição. Na barra de cima, ao lado de atualizar, fica "Limpar a TV": abre uma folha de confirmação e, confirmada, fecha
 * os apps e libera memória sem derrubar o controle. A limpeza leva alguns segundos; enquanto ela roda o botão mostra
 * "Limpando…" e o resto do painel segue normal.
 *
 * Cada parte só aparece para quem pode usá-la (`TvAccess`): abrir apps e atualizar a lista são de `tv:launch`, o modo
 * Editar (fixar, renomear e mudar a ordem) é de `tv:edit-shortcuts` e "Limpar a TV" é de `tv:control`. Sem
 * `tv:launch` os azulejos são só figuras. O painel abre para quem pode abrir apps, editar os atalhos ou limpar a TV (ver
 * `TvAccess.apps`); quem só controla vê nele uma coisa só, o "Limpar a TV", sem a grade.
 */
@Component({
  selector: 'app-tv-apps',
  imports: [AppIcon, AppsTile, CleanupSheet, NgTemplateOutlet, TvIcon],
  templateUrl: './apps-panel.html',
  styleUrl: './apps-panel.css',
})
export class AppsPanel {
  protected readonly store = inject(TvStore);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  private readonly injector = inject(Injector);

  /** O que a conta pode fazer aqui: abrir apps, editar os atalhos e limpar a TV são permissões separadas. */
  protected readonly access = inject(TvAccess);

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

  /** Modo Editar (só de quem edita os atalhos): todos os apps numa lista só, com os botões de fixar e renomear em cada um. */
  protected readonly editMode = signal(false);
  /** Uma lista só, sem seções: na busca e na edição (onde o azulejo não pode mudar de lugar ao ser fixado). */
  protected readonly flat = computed(() => this.searching() || this.editMode());
  /** Os atalhos ativos (os da fileira de cima) e os que ficaram de fora, na ordem da posição. */
  protected readonly pinned = computed(() => this.visible().filter((item) => item.enabled));
  /**
   * Mudar a ordem da fileira: só na edição, sem busca (o filtro esconderia os vizinhos e o app pareceria não sair do
   * lugar). A ordem é a da fileira do controle, que mostra só os atalhos ativos: por isso conta a lista completa do
   * servidor e não o que o painel exibe.
   */
  protected readonly reorderable = computed(() => this.editMode() && !this.searching());
  /** Lugar de cada atalho do controle na fileira (só dele; os demais não têm lugar nenhum). */
  protected readonly ranks = computed(() => controlRanks(this.store.shortcuts() ?? []));
  /** Quantos atalhos há na fileira: o aviso de como mudar a ordem só faz sentido com mais de um. */
  protected readonly pinnedCount = computed(() => this.ranks().size);
  /** Frase lida pelo leitor de tela depois de mover um atalho ("Spotify, posição 2 de 6"); vazia quando não há o que dizer. */
  protected readonly announcement = signal('');
  protected readonly unpinned = computed(() => this.visible().filter((item) => !item.enabled));

  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  /** Pedindo a lista à TV (mostra "Buscando…"); o erro, se houver, aparece no aviso do próprio painel. */
  protected readonly refreshing = signal(false);
  /** Já pediu a lista à TV pelo menos uma vez, com sucesso (para dizer que ela segue vazia). */
  protected readonly asked = signal(false);

  protected readonly searchingText = $localize`:@@tv.apps.searching-short:Buscando…`;
  /** A folha "Limpar a TV?" está aberta. */
  protected readonly cleanupOpen = signal(false);
  protected readonly cleaningText = $localize`:@@tv.cleanup.running:Limpando a TV…`;
  /** O botão de limpar é só um ícone: o nome acessível diz também o que está acontecendo. */
  protected readonly cleanLabel = computed(() =>
    this.store.cleaning() ? this.cleaningText : $localize`:@@tv.cleanup.open:Limpar a TV`,
  );

  /** O botão de atualizar é só um ícone: o nome acessível diz também o que está acontecendo. */
  protected readonly refreshLabel = computed(() =>
    this.refreshing() ? this.searchingText : $localize`:@@tv.apps.refresh:Atualizar lista`,
  );

  constructor() {
    // O administrador pode tirar a permissão de editar com o painel aberto: o modo Editar sai, em vez de ficar à vista.
    effect(() => {
      if (this.access.editShortcuts()) return;
      this.editMode.set(false);
      this.editing.set(null);
    });
  }

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected toggleEdit(): void {
    this.editMode.update((on) => !on);
    this.editing.set(null);
    this.announcement.set('');
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

  protected openCleanup(): void {
    // Apagado e focável, não `disabled`: sem agente (ou com uma limpeza em curso) o toque não faz nada, e o botão
    // continua achável por quem navega pelo teclado ou pelo leitor de tela.
    if (!this.store.canSend() || this.store.cleaning() || !this.access.control()) return;
    this.cleanupOpen.set(true);
  }

  protected closeCleanup(): void {
    this.cleanupOpen.set(false);
    // Com a folha ainda no DOM o painel está inerte e o foco não entra: devolve-o depois que ela sair.
    this.focusAfterRender('.clean');
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

  /**
   * Move um atalho um passo na fileira. A tela já mostra a ordem nova quando o pedido volta do `reorder` (ele é
   * otimista); o foco acompanha o botão que o dono usou, que muda de lugar na lista, e o leitor de tela ouve onde o app
   * ficou. Se a ordem não mudou (sem rede, por exemplo, ou já na ponta), nada é dito nem refocado.
   */
  protected move(change: TileMove): void {
    const { shortcut, delta } = change;
    const before = this.ranks().get(shortcut.id);
    const ids = movedOrder(this.store.shortcuts() ?? [], shortcut.id, delta);
    if (!before || !ids) return;

    void this.store.reorder(ids).then((saved) => {
      // Recusada: a lista já voltou ao que era e o aviso de erro diz isso; "onde ficou" deixou de ser verdade.
      if (!saved) this.announcement.set('');
    });

    const after = this.ranks().get(shortcut.id);
    if (!after || after.index === before.index) return;
    const moved = (this.store.shortcuts() ?? []).find((item) => item.id === shortcut.id);
    const name = shortcutLabel(moved ?? shortcut);
    const position = after.index + 1;
    const count = after.count;
    this.announcement.set(
      $localize`:@@tv.apps.moved:${name}:name:, posição ${position}:position: de ${count}:count:`,
    );
    this.focusAfterRender(
      `[data-move="${delta < 0 ? 'left' : 'right'}"][data-for="${shortcut.id}"]`,
    );
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
