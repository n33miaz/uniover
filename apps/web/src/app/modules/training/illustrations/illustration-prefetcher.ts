import { Injectable, inject } from '@angular/core';
import { ConnectivityService } from '../../../core/connectivity/connectivity.service';
import { EXERCISE_ART_CACHE } from './illustration-cache';
import { illustrationFor, illustrationUrl } from './illustration-map';

interface NetworkInformationLike {
  readonly saveData?: boolean;
}

/** Os arquivos (sem repetir) que o aquecimento busca para estes exercícios: as duas poses de cada um que tem ilustração. */
export function illustrationFiles(slugs: readonly string[]): string[] {
  const files = new Set<string>();
  for (const slug of slugs) {
    for (const file of illustrationFor(slug)?.frames ?? []) files.add(file);
  }
  return [...files];
}

/**
 * "Aquece" as ilustrações: busca os arquivos na mesma origem e os grava no cache de execução, para que apareçam também
 * sem rede (na academia). Só age com rede e sem o modo de economia de dados; busca um arquivo por vez e não tenta de
 * novo. Quem decide quais exercícios aquecer (as rotinas ativas) e quando repetir é o chamador.
 */
@Injectable({ providedIn: 'root' })
export class IllustrationPrefetcher {
  private readonly connectivity = inject(ConnectivityService);

  /**
   * Garante as duas poses de cada exercício que tem ilustração e devolve quantos ARQUIVOS estão guardados no fim (os que
   * já estavam e os que vieram agora), para o chamador comparar com `illustrationFiles`. Quem foi gravado no cache de
   * execução pela própria página conta como pronto mesmo que o service worker não controle a página ainda. Para na
   * primeira falha de rede (sem rede não adianta insistir); resposta com erro de HTTP pula só aquele arquivo.
   */
  async warm(slugs: readonly string[]): Promise<number> {
    if (!this.connectivity.online() || saveDataOn()) return 0;
    const cache = await openCache();
    let stored = 0;
    for (const file of illustrationFiles(slugs)) {
      const url = illustrationUrl(file);
      try {
        if (cache !== null && (await cache.match(url)) !== undefined) {
          stored += 1;
          continue;
        }
        const response = await fetch(url);
        if (!response.ok) continue;
        if (cache !== null) await cache.put(url, response.clone());
        stored += 1;
      } catch {
        break;
      }
    }
    return stored;
  }
}

/** O cache de execução, ou `null` onde a API não existe (testes, contexto sem https) ou o navegador recusa abrir. */
async function openCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null;
  try {
    return await caches.open(EXERCISE_ART_CACHE);
  } catch {
    return null;
  }
}

function saveDataOn(): boolean {
  const connection = (navigator as Navigator & { connection?: NetworkInformationLike }).connection;
  return connection?.saveData === true;
}
