import { Component, computed, inject, signal } from '@angular/core';
import { TvStore } from '../data/tv-store';
import { TvShortcut, shortcutLabel } from '../data/tv-types';
import { TvIcon } from '../ui/tv-icon';

/** Tamanho máximo do nome próprio, o mesmo da API. */
const LABEL_MAX = 40;

/**
 * Aba Apps: a lista de atalhos que a TV informou. Tocar abre o app na TV; cada linha também deixa dar um nome
 * próprio (vazio volta a "Atalho n") e esconder ou mostrar. Nenhum nome de app vem do código: o texto padrão é
 * "Atalho" mais a posição, e o pacote aparece só como texto pequeno.
 */
@Component({
  selector: 'app-tv-apps',
  imports: [TvIcon],
  templateUrl: './apps.page.html',
  styleUrl: './apps.page.css',
})
export class AppsPage {
  protected readonly store = inject(TvStore);

  protected readonly maxLabel = LABEL_MAX;
  protected readonly list = computed(() => this.store.shortcuts() ?? []);
  protected readonly loaded = computed(() => this.store.shortcuts() !== null);

  protected readonly editing = signal<string | null>(null);
  protected readonly draft = signal('');
  protected readonly busy = signal(false);

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

  protected async launch(shortcut: TvShortcut): Promise<void> {
    await this.store.launch(shortcut);
  }

  protected async refresh(): Promise<void> {
    this.busy.set(true);
    try {
      await this.store.refreshShortcuts();
    } finally {
      this.busy.set(false);
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
