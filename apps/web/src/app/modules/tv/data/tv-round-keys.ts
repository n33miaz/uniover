import { Injectable, computed, inject } from '@angular/core';
import { TvAccess } from './tv-access';
import { MAIN_EXTRAS_MAX, TvExtraKey, fitColumns, mainExtras, supportedExtras } from './tv-extras';
import { TvPrefs } from './tv-prefs';
import { TvSelection } from './tv-selection';
import { TvKey } from './tv-types';

/** Quantos botões redondos fixos existem além do teclado e das teclas de mídia: voltar, início e menu. */
const FIXED_ROUND_KEYS = 3;
/** As teclas de mídia: anterior, tocar ou pausar, próxima e mudo. */
const MEDIA_ROUND_KEYS = 4;

/**
 * Os botões redondos da tela principal e os extras que os completam. O controle, o painel "Mais botões" e Personalizar
 * leem daqui, para os três concordarem sobre o que está na tela, quantas colunas a grade tem e o que sobrou.
 *
 * A grade nunca tem um espaço vazio: os extras que a TV declara (e que a pessoa escolheu, ou os mais importantes) entram
 * até a última fileira fechar. Colunas e contagem dependem do que a TV faz (a Samsung não tem teclado) e do que a pessoa
 * liga ou desliga (mídia, tamanho dos botões, disposição das pílulas).
 */
@Injectable({ providedIn: 'root' })
export class TvRoundKeys {
  private readonly access = inject(TvAccess);
  private readonly prefs = inject(TvPrefs);
  private readonly selection = inject(TvSelection);

  /** Botões redondos fixos (sem os extras). */
  readonly base = computed(
    () =>
      FIXED_ROUND_KEYS +
      (this.access.text() ? 1 : 0) +
      (this.prefs.showMedia() ? MEDIA_ROUND_KEYS : 0),
  );

  /**
   * Colunas dos botões redondos. Com as pílulas nas laterais: quatro por fileira; no tamanho grande, quebra em três (não
   * cabem mais quatro entre as pílulas numa tela estreita); sem as teclas de mídia sobram poucos, em duas colunas. Com as
   * pílulas em fileira os botões têm a largura toda: sempre quatro (até no tamanho grande). Sem o Teclado (a TV não
   * digita) são três botões fixos em vez de quatro, e a conta muda com eles.
   */
  readonly columns = computed(() => {
    const keyboard = this.access.text();
    if (this.prefs.pillLayout() === 'row') return keyboard || this.prefs.showMedia() ? 4 : 3;
    if (!this.prefs.showMedia()) return keyboard ? 2 : 3;
    return this.prefs.buttonSize() === 'large' ? 3 : 4;
  });

  /**
   * As colunas de fato usadas: as de `columns`, ou menos quando a TV não tem teclas para fechar a última fileira (um
   * agente antigo só declara a Fonte). Assim nunca sobra uma célula vazia.
   */
  readonly gridColumns = computed(
    () => fitColumns(this.base() + this.shown().length, this.columns()) ?? this.columns(),
  );

  /** Os extras que a TV em uso tem, do mais ao menos importante. */
  readonly supported = computed(() => supportedExtras(this.selection.selected()));

  /** Os extras que estão na tela principal. */
  readonly shown = computed(() =>
    mainExtras({
      base: this.base(),
      columns: this.columns(),
      supported: this.supported(),
      chosen: this.prefs.extraKeys(),
    }),
  );

  /** O que a TV tem e não coube na tela principal: vai para "Mais botões". */
  readonly more = computed<readonly TvExtraKey[]>(() => {
    const shown = new Set(this.shown());
    return this.supported().filter((extra) => !shown.has(extra));
  });

  /** Os extras que a pessoa escolheu de fato (os outros da tela principal foram postos para completar a fileira). */
  readonly chosen = computed<readonly string[]>(() => {
    const supported = new Set(this.supported().map((extra) => extra.key));
    return (this.prefs.extraKeys() ?? []).filter((key) => supported.has(key));
  });

  /**
   * Escolhe ou tira a escolha de um extra. A grade se completa sozinha depois (ver `mainExtras`): escolher um botão o põe
   * na tela principal, e tirar a escolha de todos devolve o preenchimento automático.
   */
  toggle(key: TvKey): void {
    const list = this.chosen();
    const next = list.includes(key) ? list.filter((item) => item !== key) : [...list, key];
    this.prefs.set({ extraKeys: next.length === 0 ? null : (next as readonly TvKey[]) });
  }

  /**
   * O botão pode ser escolhido agora: cabe na tela principal e a TV tem teclas para fechar a última fileira junto com
   * ele. Tirar a escolha de um botão escolhido sempre pode.
   */
  canToggle(key: TvKey): boolean {
    const list = this.chosen();
    if (list.includes(key)) return true;
    if (list.length >= MAIN_EXTRAS_MAX) return false;
    const next = mainExtras({
      base: this.base(),
      columns: this.columns(),
      supported: this.supported(),
      chosen: [...list, key],
    });
    return next.some((extra) => extra.key === key);
  }
}
