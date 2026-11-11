import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import {
  DirectChannel,
  DirectNotSent,
  PC_RTC_CAPABILITY,
  TV_RTC_CAPABILITY,
  type TvDirectCommandType,
} from '../../../core/direct/direct-channel';
import { TvAccess } from './tv-access';
import { TvSelection } from './tv-selection';

/**
 * A ponte da tela da TV com o canal direto do aparelho (`core/direct`). O canal é um acelerador OPCIONAL: as teclas e o texto da TV
 * saem por ele quando ele está aberto com o escopo da TV e a nuvem não tem nada da TV em voo; senão, e sempre que o canal não puder
 * levar o comando, saem pela API como sempre, sem a pessoa perceber. O que já saiu no canal e não foi respondido nunca é reenviado
 * pela nuvem (o resultado é incerto, como o `504` dela).
 *
 * Quando o canal pode abrir: a tela da TV aberta, a TV escolhida com agente conectado que declara `pc.rtc.v1` e `tv.rtc.v1`, e a conta
 * com `tv:control` (a API confere de novo, escopo a escopo, no instante da oferta). Quando leva: com a sessão da TV aberta (`hot`).
 * Desligar, abrir app, limpar e as demais ações só existem pela nuvem (confirmação e trilha na API), e o `POWER` nunca passa por aqui.
 */
@Injectable({ providedIn: 'root' })
export class TvDirect {
  private readonly channel = inject(DirectChannel);
  private readonly selection = inject(TvSelection);
  private readonly access = inject(TvAccess);

  /** A tela da TV está aberta (quem pede o canal). */
  private readonly active = signal(false);
  /** A sessão com a TV está aberta agora (o estado `hot`): o `TvStore` a informa. */
  private readonly live = signal(false);

  constructor() {
    effect(() => {
      const tv = this.selection.selected();
      const tvId = this.selection.tvId();
      const control = this.access.control();
      const active = this.active();
      const live = this.live();
      // `online` da lista não entra: ela é lida ao abrir a tela e pode estar velha (o agente estava fora quando a tela abriu); quem diz
      // que a TV está de pé agora é o fluxo (`live`), e uma oferta que falha só recua e tenta de novo.
      const capable =
        tv !== null &&
        tv.capabilities.includes(PC_RTC_CAPABILITY) &&
        tv.capabilities.includes(TV_RTC_CAPABILITY);
      untracked(() =>
        this.channel.setTvTarget(active && control && capable ? { tvId, usable: true, live } : null),
      );
    });
  }

  /** A tela da TV abriu: o canal passa a tentar abrir (com a tela visível). */
  start(): void {
    this.active.set(true);
    this.channel.start('tv');
  }

  /** A tela da TV fechou: o canal só fecha se a tela do PC também não o quer. */
  stop(): void {
    this.active.set(false);
    this.live.set(false);
    this.channel.stop('tv');
  }

  /** A sessão com a TV está aberta (`hot`)? Só então o canal leva as teclas. */
  setLive(live: boolean): void {
    this.live.set(live);
  }

  /** O canal leva a TV agora (aberto, com o escopo da TV, nada da TV em voo pela nuvem, ida e volta abaixo do piso)? */
  canUse(): boolean {
    return this.channel.canUseTv();
  }

  /**
   * Manda a tecla ou o texto pelo canal e espera a resposta do agente: `true` se a TV o executou, `false` se nada saiu e a nuvem deve
   * levar. A falha de verdade (recusa do agente, resposta que não veio) sobe como erro, no mesmo formato da nuvem.
   */
  async command(type: TvDirectCommandType, body: Record<string, unknown>): Promise<boolean> {
    // Um agente que não listou a mensagem no `ready` do canal não a entende: a nuvem leva.
    if (!this.canUse() || !this.channel.accepts(type)) return false;
    try {
      await this.channel.command(type, body);
      return true;
    } catch (error) {
      if (error instanceof DirectNotSent) return false;
      throw error;
    }
  }

  /** O pedido da TV pela nuvem, contado como em voo: o canal só volta a levar a TV quando nenhum está no ar (a ordem das teclas). */
  trackCloud<T>(call: Promise<T>): Promise<T> {
    return this.channel.trackTvCloud(call);
  }
}
