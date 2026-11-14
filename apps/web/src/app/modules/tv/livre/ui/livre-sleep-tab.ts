import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TvLivreStore } from '../data/livre-store';
import { LivreSleepTime } from './livre-sleep-time';

/**
 * Tela "Dormir": o botão grande que põe a TV no Modo Dormir (tela preta; qualquer tecla do controle acorda, menos volume e
 * mídia no launcher novo) e o tempo máximo no escuro, em botões que valem na hora (`LivreSleepTime`). Zero quer dizer "só
 * acorda com tecla".
 */
@Component({
  selector: 'app-livre-sleep-tab',
  imports: [LivreSleepTime],
  templateUrl: './livre-sleep-tab.html',
  styleUrl: './livre-sleep-tab.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LivreSleepTab {
  protected readonly store = inject(TvLivreStore);

  protected readonly idle = computed(() => this.store.canUse() && this.store.busy() === null);
  protected readonly sleeping = computed(() => this.store.busy() === 'sleep');
}
