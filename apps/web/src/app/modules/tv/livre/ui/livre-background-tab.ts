import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { GRADIENT_PRESETS, GradientPreset, gradientCss, presetFor } from '../data/livre-config';
import { TvLivreStore } from '../data/livre-store';
import { DIM_MAX } from '../data/livre-types';
import { LivrePreview } from './livre-preview';

/**
 * Tela "Fundo": degradê de duas cores (seletor de cor do próprio aparelho e algumas combinações prontas) ou foto (reduzida
 * no navegador antes de enviar). A pré-visualização é a mesma da Home da TV. Escurecer a foto é o único ajuste dela: o
 * relógio e os nomes são brancos e precisam continuar legíveis. As mudanças ficam no rascunho até "Aplicar na TV".
 */
@Component({
  selector: 'app-livre-background-tab',
  imports: [LivrePreview],
  templateUrl: './livre-background-tab.html',
  styleUrl: './livre-background-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivreBackgroundTab {
  protected readonly store = inject(TvLivreStore);
  protected readonly presets = GRADIENT_PRESETS;
  protected readonly dimMax = Math.round(DIM_MAX * 100);

  protected readonly enabled = computed(() => this.store.canUse() && this.store.busy() === null);
  protected readonly isPhoto = computed(() => this.store.draft()?.wallpaper.type === 'photo');
  protected readonly colors = computed(() => this.store.draft()?.wallpaper.colors ?? []);
  protected readonly activePreset = computed(() => presetFor(this.colors())?.id ?? null);
  /** O escurecimento em porcentagem inteira (0 a 80), do jeito que o controle mostra. */
  protected readonly dimPercent = computed(() =>
    Math.round((this.store.draft()?.wallpaper.dim ?? 0) * 100),
  );

  protected swatch(preset: GradientPreset): string {
    return gradientCss(preset.colors, 315);
  }

  protected presetLabel(preset: GradientPreset): string {
    const name = preset.label;
    return $localize`:@@tv-livre.background.preset-label:Cores ${name}:name:`;
  }

  protected setColor(index: 0 | 1, event: Event): void {
    this.store.setColor(index, (event.target as HTMLInputElement).value);
  }

  protected setDim(event: Event): void {
    this.store.setDim(Number((event.target as HTMLInputElement).value) / 100);
  }

  protected async pickPhoto(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    // Limpa a escolha: o mesmo arquivo, escolhido de novo depois de um erro, precisa disparar o evento outra vez.
    input.value = '';
    if (file) await this.store.choosePhoto(file);
  }
}
