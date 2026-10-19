import { Injectable, inject } from '@angular/core';
import { TRAINING_DB } from '../data/training-db';

/** Um autor de exercícios do wger, com a licença e quantos exercícios ele assina no aparelho. */
export interface WgerCredit {
  readonly author: string;
  readonly license: string;
  /** Link da licença; só endereço https é guardado (outro formato vira `null`). */
  readonly licenseUrl: string | null;
  readonly count: number;
}

/** O wger entrega autor e licença junto de cada exercício; o app os guarda no banco local. */
export const WGER_SOURCE = 'wger';

/**
 * Lê os autores e as licenças dos exercícios do wger direto do banco local (sem rede), agrupados por autor e
 * licença. Exercício apagado ou sem autor/licença não entra (sem eles não há como creditar).
 */
@Injectable({ providedIn: 'root' })
export class WgerCreditsReader {
  private readonly db = inject(TRAINING_DB);

  async read(): Promise<WgerCredit[]> {
    const rows = await this.db.exercises
      .filter((row) => row.source === WGER_SOURCE && row.deletedAt === null)
      .toArray();
    const groups = new Map<string, { credit: Omit<WgerCredit, 'count'>; count: number }>();
    for (const row of rows) {
      const author = row.licenseAuthor?.trim();
      const license = row.license?.trim();
      if (!author || !license) continue;
      const licenseUrl = httpsOrNull(row.licenseUrl);
      const key = `${author}\u0000${license}\u0000${licenseUrl ?? ''}`;
      const group = groups.get(key);
      if (group) group.count += 1;
      else groups.set(key, { credit: { author, license, licenseUrl }, count: 1 });
    }
    return [...groups.values()]
      .map(({ credit, count }) => ({ ...credit, count }))
      .sort(
        (a, b) => a.author.localeCompare(b.author, 'pt-BR') || a.license.localeCompare(b.license),
      );
  }
}

function httpsOrNull(value: string | null): string | null {
  const text = value?.trim();
  if (!text) return null;
  try {
    return new URL(text).protocol === 'https:' ? text : null;
  } catch {
    return null;
  }
}
