import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TvLivreStore } from '../data/livre-store';
import { SLEEP_MAX_MINUTES } from '../data/livre-types';

/**
 * Tela "Dormir": o botão grande que põe a TV no Modo Dormir (tela preta; qualquer tecla do controle acorda) e o tempo
 * máximo no escuro, que faz parte da configuração e vai com "Aplicar na TV". Zero quer dizer "só acorda com tecla".
 */
@Component({
  selector: 'app-livre-sleep-tab',
  templateUrl: './livre-sleep-tab.html',
  styleUrl: './livre-sleep-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivreSleepTab {
  protected readonly store = inject(TvLivreStore);
  protected readonly maxMinutes = SLEEP_MAX_MINUTES;

  protected readonly idle = computed(() => this.store.canUse() && this.store.busy() === null);
  protected readonly sleeping = computed(() => this.store.busy() === 'sleep');
  protected readonly minutes = computed(() => this.store.draft()?.sleep.maxMinutes ?? 0);

  protected setMinutes(event: Event): void {
    const field = event.target as HTMLInputElement;
    // Campo vazio ou fora de 0 a 720 vale o limite mais próximo; o valor aceito volta ao campo.
    this.store.setSleepMax(field.value === '' ? 0 : Number(field.value));
    field.value = String(this.minutes());
  }
}
