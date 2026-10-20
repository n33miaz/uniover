import { Injectable, inject } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { illustrationFor, illustrationUrl } from './illustration-map';

interface NetworkInformationLike {
  readonly saveData?: boolean;
}

/**
 * "Aquece" as ilustrações: busca os arquivos na mesma origem para que o service worker os guarde e eles apareçam
 * também sem rede (na academia). Só age com rede e sem o modo de economia de dados; busca um arquivo por vez e não
 * tenta de novo. Quem decide quais exercícios aquecer (as rotinas ativas) é o chamador.
 */
@Injectable({ providedIn: 'root' })
export class IllustrationPrefetcher {
  private readonly connectivity = inject(ConnectivityService);

  /**
   * Busca as duas poses de cada exercício que tem ilustração. Devolve quantos ARQUIVOS vieram com sucesso. Para na
   * primeira falha de rede (sem rede não adianta insistir); resposta com erro de HTTP pula só aquele arquivo.
   */
  async warm(slugs: readonly string[]): Promise<number> {
    if (!this.connectivity.online() || saveDataOn()) return 0;
    const files = new Set<string>();
    for (const slug of slugs) {
      for (const file of illustrationFor(slug)?.frames ?? []) files.add(file);
    }
    let fetched = 0;
    for (const file of files) {
      try {
        const response = await fetch(illustrationUrl(file));
        if (response.ok) fetched += 1;
      } catch {
        break;
      }
    }
    return fetched;
  }
}

function saveDataOn(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return connection?.saveData === true;
}
