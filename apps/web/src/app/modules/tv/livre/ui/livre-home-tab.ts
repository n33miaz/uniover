import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AppIcon } from '../../ui/app-icon';
import { LivreAppRow } from '../data/livre-config';
import { TvLivreStore } from '../data/livre-store';
import { LivrePreview } from './livre-preview';

/**
 * Tela "Home da TV": a pré-visualização fiel ao launcher e, embaixo, a lista para ESCOLHER e ORDENAR os apps. Qualquer app
 * instalado pode entrar; os de fábrica (que o launcher esconde por padrão) ficam num grupo recolhido. Sem nenhum escolhido a
 * Home mostra tudo o que não é de fábrica; com algum, só os escolhidos, na ordem daqui. Nada vai à TV até "Aplicar na TV".
 */
@Component({
  selector: 'app-livre-home-tab',
  imports: [NgTemplateOutlet, AppIcon, LivrePreview],
  templateUrl: './livre-home-tab.html',
  styleUrl: './livre-home-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivreHomeTab {
  protected readonly store = inject(TvLivreStore);
  protected readonly factoryOpen = signal(false);

  /** Escolher e ordenar mexe na configuração, não na TV, mas só vale com a TV ao alcance. */
  protected readonly enabled = computed(() => this.store.canUse() && this.store.busy() === null);

  protected toggleFactory(): void {
    this.factoryOpen.update((open) => !open);
  }

  protected showLabel(row: LivreAppRow): string {
    const name = row.label;
    return $localize`:@@tv-livre.home.show-label:Mostrar ${name}:name: na Home`;
  }

  protected upLabel(row: LivreAppRow): string {
    const name = row.label;
    return $localize`:@@tv-livre.home.up-label:Subir ${name}:name:`;
  }

  protected downLabel(row: LivreAppRow): string {
    const name = row.label;
    return $localize`:@@tv-livre.home.down-label:Descer ${name}:name:`;
  }

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
