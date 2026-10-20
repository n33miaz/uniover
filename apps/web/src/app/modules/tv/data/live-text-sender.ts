import { LiveTextSender } from './live-text';
import { TvFailure } from './tv-errors';
import { TvStore, isValidTvText } from './tv-store';

/**
 * Hoje cada envio leva o texto completo do campo (a TV passa a ter exatamente aquele texto). É o único ponto que
 * conhece essa forma de enviar: trocar por acréscimos ou por apagar é trocar esta classe, sem tocar na pausa de
 * digitação, na regra de uma requisição por vez nem na coalescência da {@link LiveTextSync}.
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
