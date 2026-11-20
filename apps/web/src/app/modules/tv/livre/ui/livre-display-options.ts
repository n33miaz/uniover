import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TvLivreStore } from '../data/livre-store';
import type {
  LivreClockFormat,
  LivreClockSize,
  LivreIconSize,
  LivreLabels,
} from '../data/livre-types';

interface Choice<T extends string> {
  readonly value: T;
  readonly label: string;
}

/**
 * Tudo que a tela inicial da TV aceita além do fundo: o relógio (tamanho, 12 ou 24 horas, data, segundos), o tamanho dos
 * ícones e quando mostrar o nome dos apps. Mais o círculo Dormir (ligado por padrão, existe desde o primeiro launcher) e
 * os círculos Rede e Entradas e o nome do sistema, que só o launcher novo conhece (sem ele, não aparecem aqui). Tudo vai no rascunho e vale com "Aplicar na TV", como o resto da configuração.
 */
@Component({
  selector: 'app-livre-display-options',
  templateUrl: './livre-display-options.html',
  styleUrl: './livre-display-options.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivreDisplayOptions {
  protected readonly store = inject(TvLivreStore);

  protected readonly enabled = computed(() => this.store.canUse() && this.store.busy() === null);
  protected readonly clock = computed(() => this.store.draft()?.clock ?? null);
  protected readonly icons = computed(() => this.store.draft()?.icons ?? null);
  protected readonly builtin = computed(() => this.store.draft()?.builtin ?? null);

  protected readonly sizes: readonly Choice<LivreClockSize>[] = [
    { value: 'large', label: $localize`:@@tv-livre.display.size-large:Grande` },
    { value: 'medium', label: $localize`:@@tv-livre.display.size-medium:Médio` },
    { value: 'small', label: $localize`:@@tv-livre.display.size-small:Pequeno` },
  ];
  protected readonly formats: readonly Choice<LivreClockFormat>[] = [
    { value: '24h', label: $localize`:@@tv-livre.display.format-24:24 h` },
    { value: '12h', label: $localize`:@@tv-livre.display.format-12:12 h` },
    { value: 'auto', label: $localize`:@@tv-livre.display.format-auto:Da TV` },
  ];
  protected readonly iconSizes: readonly Choice<LivreIconSize>[] = [
    { value: 'small', label: $localize`:@@tv-livre.display.icon-small:Pequenos` },
    { value: 'medium', label: $localize`:@@tv-livre.display.icon-medium:Médios` },
    { value: 'large', label: $localize`:@@tv-livre.display.icon-large:Grandes` },
  ];
  protected readonly labelModes: readonly Choice<LivreLabels>[] = [
    { value: 'always', label: $localize`:@@tv-livre.display.names-always:Sempre` },
    { value: 'focus', label: $localize`:@@tv-livre.display.names-focus:No Foco` },
    { value: 'never', label: $localize`:@@tv-livre.display.names-never:Nunca` },
  ];

  protected checked(event: Event): boolean {
    return (event.target as HTMLInputElement).checked;
  }
}
