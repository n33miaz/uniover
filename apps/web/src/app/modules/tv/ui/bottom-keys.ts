import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, output } from '@angular/core';
import { TvAccess } from '../data/tv-access';
import { TvPrefs } from '../data/tv-prefs';
import { TvRoundKeys } from '../data/tv-round-keys';
import { TvStore } from '../data/tv-store';
import { KeyButton } from '../input/key-button';
import { TvIcon } from './tv-icon';

/** As partes de uma pílula: o botão que aumenta, o nível (ou o rótulo) e o botão que diminui. */
type PillPart = 'more' | 'level' | 'less';

/**
 * Por baixo do controle: as pílulas de volume e de canal e os botões redondos. Onde ficam as pílulas (uma de cada lado dos
 * botões ou numa fileira acima deles), se o canal e as teclas de mídia aparecem e o tamanho dos botões vêm de Personalizar
 * (`TvPrefs`; o tamanho chega pela variável `--key-scale` do controle). O Teclado não é tela: este bloco só avisa
 * (`openKeyboard`, com o botão tocado) para o controle abrir o painel flutuante.
 */
@Component({
  selector: 'app-tv-bottom-keys',
  imports: [NgTemplateOutlet, KeyButton, TvIcon],
  templateUrl: './bottom-keys.html',
  styleUrl: './bottom-keys.css',
})
export class BottomKeys {
  protected readonly store = inject(TvStore);
  protected readonly prefs = inject(TvPrefs);
  protected readonly access = inject(TvAccess);
  /** As colunas dos botões redondos e os extras que completam a grade. */
  protected readonly roundKeys = inject(TvRoundKeys);

  /** Leva o botão tocado: o painel devolve o foco a ele ao fechar (o Safari não foca botão ao toque). */
  readonly openKeyboard = output<HTMLElement>();

  /** As pílulas de volume e canal numa fileira deitada, acima dos botões redondos (Personalizar). */
  protected readonly rowPills = computed(() => this.prefs.pillLayout() === 'row');

  /**
   * As três partes de uma pílula na ordem em que aparecem (e em que o foco passa): em pé, mais em cima e menos embaixo;
   * deitada, menos à esquerda e mais à direita.
   */
  protected readonly pillParts = computed<readonly PillPart[]>(() =>
    this.rowPills() ? ['less', 'level', 'more'] : ['more', 'level', 'less'],
  );

  /** O nível que o agente leu na TV (ou na soundbar). Sem leitura possível o app não inventa um número. */
  private readonly volumeRead = computed(() => this.store.state()?.volume ?? null);
  /** Os passos que a TV confirmou há pouco, para a pílula responder ao toque quando não há nível a mostrar. */
  private readonly volumeSteps = computed(() =>
    this.volumeRead() === null ? this.store.volumeNudge() : 0,
  );
  protected readonly volumeKnown = computed(() => this.volumeRead() !== null);
  protected readonly volumeText = computed(() => {
    const volume = this.volumeRead();
    if (volume !== null) return String(volume);
    const steps = this.volumeSteps();
    if (steps === 0) return '';
    return `${steps > 0 ? '+' : '−'}${Math.abs(steps)}`;
  });
  /** Quanto da pílula de volume se enche (0 a 100); sem nível conhecido fica vazia. */
  protected readonly volumePercent = computed(() => {
    const volume = this.volumeRead();
    return volume === null ? 0 : Math.min(100, Math.max(0, volume));
  });
  protected readonly volumeLabel = computed(() => {
    const volume = this.volumeRead();
    if (volume !== null) return $localize`:@@tv.volume.level:Volume ${volume}:level:`;
    const text = this.volumeText();
    return text === ''
      ? $localize`:@@tv.volume.unread:Volume sem leitura`
      : $localize`:@@tv.volume.nudge:Volume ${text}:steps:`;
  });

  protected askKeyboard(event: Event): void {
    this.openKeyboard.emit(event.currentTarget as HTMLElement);
  }
}
