import { Component, computed, inject, output, signal } from '@angular/core';
import { SessionState } from '../../../core/session/session-state';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { TvIcon } from '../ui/tv-icon';

/** Tamanho máximo do nome próprio, o mesmo da API. */
const LABEL_MAX = 40;
const VIEW_KEY = 'uniover.tv.apps-view';

export type AppsView = 'grid' | 'list';

/** Minúsculas e sem acento: "Câmera" é achada por "camera". */
function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

function storedView(): AppsView {
  try {
    return localStorage.getItem(VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    return 'grid';
  }
}

/**
 * Painel Apps: a lista completa dos atalhos que a TV informou, com busca por texto, grade ou lista, toque para
 * abrir, renomear e ocultar. Sem lista ainda, mostra um estado vazio com o botão que pede a lista à TV. Nenhum nome
 * de app vem do código: o nome é o do dono, o que o agente publicou para o app ou, por último, "Atalho" mais a
 * posição; o pacote aparece só como texto pequeno e a busca também o enxerga.
 */
@Component({
  selector: 'app-tv-apps',
  imports: [TvIcon],
  templateUrl: './apps-panel.html',
  styleUrl: './apps-panel.css',
})
export class AppsPanel {
  protected readonly store = inject(TvStore);

  /** Renomear e ocultar atalhos é só do dono (a API recusa o convidado com 403): o convidado só abre os apps. */
  protected readonly isGuest = inject(SessionState).isGuest;

  /** O app foi aberto na TV: o painel pode fechar e devolver o controle. */
  readonly done = output<void>();

  protected readonly maxLabel = LABEL_MAX;
  protected readonly all = computed(() => this.store.shortcuts() ?? []);
  protected readonly loaded = computed(() => this.store.shortcuts() !== null);

  protected readonly query = signal('');
  protected readonly view = signal<AppsView>(storedView());
  protected readonly visible = computed(() => {
    const needle = plain(this.query().trim());
    if (!needle) return this.all();
    return this.all().filter((item) =>
      plain(`${shortcutLabel(item)} ${item.tvLabel ?? ''} ${item.package}`).includes(needle),
    );
  });

  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);
  /** Pedindo a lista à TV (mostra "Buscando…"); o erro, se houver, aparece no aviso do próprio painel. */
  protected readonly refreshing = signal(false);
  /** Já pediu a lista à TV pelo menos uma vez, com sucesso (para dizer que ela segue vazia). */
  protected readonly asked = signal(false);

  protected label(shortcut: TvShortcut): string {
    return shortcutLabel(shortcut);
  }

  protected renameLabel(shortcut: TvShortcut): string {
    const name = shortcutLabel(shortcut);
    return $localize`:@@tv.apps.rename-label:Renomear ${name}:name:`;
  }

  protected toggleLabel(shortcut: TvShortcut): string {
    const name = shortcutLabel(shortcut);
    return shortcut.enabled
      ? $localize`:@@tv.apps.hide-label:Ocultar ${name}:name:`
      : $localize`:@@tv.apps.show-label:Mostrar ${name}:name:`;
  }

  protected setView(view: AppsView): void {
    this.view.set(view);
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // sem armazenamento: a escolha vale só até fechar o painel
    }
  }

  protected onQuery(event: Event): void {
    this.query.set((event.target as HTMLInputElement).value);
  }

  protected async launch(shortcut: TvShortcut): Promise<void> {
    if (await this.store.launch(shortcut)) this.done.emit();
  }

  protected async refresh(): Promise<void> {
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
  }

  protected cancelRename(): void {
    this.editing.set(null);
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLInputElement).value);
  }

  protected async saveRename(shortcut: TvShortcut, event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    try {
      if (await this.store.renameShortcut(shortcut.id, this.draft().trim())) this.editing.set(null);
    } finally {
      this.busy.set(false);
    }
  }

  protected async toggle(shortcut: TvShortcut): Promise<void> {
    this.busy.set(true);
    try {
      await this.store.setShortcutEnabled(shortcut.id, !shortcut.enabled);
    } finally {
      this.busy.set(false);
    }
  }
}
