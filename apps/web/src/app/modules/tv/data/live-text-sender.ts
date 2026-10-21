import { LiveTextSender } from './live-text';
import { TvFailure } from './tv-errors';
import { TvStore, isValidTvText } from './tv-store';

/**
 * Hoje cada envio leva o texto completo do campo (a TV passa a ter exatamente aquele texto; o agente é quem calcula
 * a diferença e apaga o que sobrou). É o único ponto que conhece essa forma de enviar: trocar por acréscimos é trocar
 * esta classe, sem tocar no ritmo de envio, na regra de uma requisição por vez nem na coalescência da
 * {@link LiveTextSync}. O texto vazio vai como qualquer outro: é o pedido de apagar tudo.
 */
export class FullTextSender implements LiveTextSender {
  constructor(private readonly store: Pick<TvStore, 'sendText'>) {}

  send(text: string): Promise<TvFailure | null> {
    return this.store.sendText(text);
  }

  isValid(text: string): boolean {
    return isValidTvText(text);
  }
}
