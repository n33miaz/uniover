import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { PcStore } from '../data/pc-store';

/**
 * O nível do volume do PC (0 a 100) e uma faixa para definir um nível exato, ao lado da faixa relativa de `app-pc-volume`, que
 * continua onde estava. O número é o que o PC avisou (o agente o manda ao conectar, a cada comando de volume e quando o teclado
 * do próprio PC o muda); sem leitura ainda mostra um traço, nunca um número inventado. A faixa é um controle nativo (teclado e
 * leitor de tela de graça): cada passo dela sai por `setVolume`, que manda um pedido por vez e deixa só o mais novo esperando.
 * Só existe com um PC que declarou o volume absoluto: quem monta a tela confere (`supportsVolume`).
 */
@Component({
  selector: 'app-pc-volume-level',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <span class="name" id="pc-volume-level-name" i18n="@@pc.volume.level-name">Volume</span>
    <input
      type="range"
      class="range"
      min="0"
      max="100"
      step="1"
      aria-labelledby="pc-volume-level-name"
      [attr.aria-valuetext]="text()"
      [value]="level()"
      [disabled]="!store.canSend() || volume() === null"
      (input)="onInput($event)"
    />
    <output class="value" [class.muted]="muted()">{{ text() }}</output>
  `,
  styleUrl: './volume-level.css',
})
export class PcVolumeLevelControl {
  protected readonly store = inject(PcStore);
  protected readonly volume = this.store.volume;
  protected readonly level = computed(() => this.volume()?.level ?? 0);
  protected readonly muted = computed(() => this.volume()?.muted === true);
  protected readonly text = computed(() => {
    const volume = this.volume();
    if (volume === null) return '—';
    return volume.muted
      ? $localize`:@@pc.volume.level-muted:${volume.level}:level:% · mudo`
      : `${volume.level}%`;
  });

  protected onInput(event: Event): void {
    const value = Number((event.target as HTMLInputElement).value);
    if (Number.isFinite(value)) void this.store.setVolume({ level: value });
  }
}
