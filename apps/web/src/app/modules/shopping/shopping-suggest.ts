import { COMMON_NAMES, nameWords } from './shopping-categories';
import { normalizeName, type Snapshot } from './shopping-model';

/**
 * Sugestões enquanto a pessoa digita: primeiro o que o grupo já comprou ou listou, depois os nomes comuns do catálogo do
 * app. Casa pelo começo de qualquer palavra ("lei" acha "Leite" e "Creme de leite"); o que começa pelo texto vem antes.
 * Nada que seja exatamente o que já foi digitado.
 */
export function suggestNames(snapshot: Snapshot, text: string, limit = 6): readonly string[] {
  const wanted = normalizeName(text.replace(/[\d,.$]+/g, ' '));
  if (wanted.length < 2) return [];
  const seen = new Set<string>();
  const scored: { name: string; rank: number; own: boolean }[] = [];
  const consider = (name: string, own: boolean): void => {
    const key = normalizeName(name);
    if (seen.has(key) || key === wanted) return;
    seen.add(key);
    const rank = key.startsWith(wanted)
      ? 0
      : key.split(' ').some((word) => word.startsWith(wanted)) ||
          nameWords(key).some((word) => word.startsWith(wanted))
        ? 1
        : -1;
    if (rank >= 0) scored.push({ name, rank, own });
  };
  for (const product of snapshot.products.values()) {
    if (!product.deleted) consider(product.name, true);
  }
  for (const name of COMMON_NAMES) consider(name, false);
  return scored
    .sort(
      (a, b) =>
        a.rank - b.rank || Number(b.own) - Number(a.own) || a.name.localeCompare(b.name, 'pt-BR'),
    )
    .slice(0, limit)
    .map((match) => match.name);
}
