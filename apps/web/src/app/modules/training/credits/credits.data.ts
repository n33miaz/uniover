/**
 * O material de terceiros que o app usa, com o que a Creative Commons recomenda mostrar: título, autor, fonte e
 * licença, mais o que foi feito com ele e onde aparece. Cada fonte nova entra aqui com UMA entrada nova (por
 * exemplo, as bases de alimentos): a tela só percorre esta lista.
 *
 * Nomes próprios (autor, licença, endereço) não são traduzidos; os textos que explicam vêm de `$localize`.
 */
export interface CreditSource {
  /** Identificador estável, só para a lista da tela. */
  readonly id: string;
  readonly title: string;
  readonly author: string;
  /** Endereço da fonte (link externo). */
  readonly sourceUrl: string;
  /** Como o endereço aparece escrito. */
  readonly sourceLabel: string;
  readonly license: string;
  readonly licenseUrl: string;
  /** O que foi feito com o material ("sem alterações", "texto reescrito"...). */
  readonly changes: string;
  /** Em que lugares do app o material aparece. */
  readonly usage: string;
}

export const CREDIT_SOURCES: readonly CreditSource[] = [
  {
    id: 'everkinetic',
    title: $localize`:@@credits.everkinetic.title:Everkinetic: ilustrações de exercícios`,
    author: 'Greg Priday',
    sourceUrl: 'https://github.com/everkinetic/data',
    sourceLabel: 'github.com/everkinetic/data',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    changes: $localize`:@@credits.everkinetic.changes:Os desenhos foram convertidos para WebP, recortados e padronizados em um só tamanho (as duas poses com o mesmo recorte), sem alterações no traço.`,
    usage: $localize`:@@credits.everkinetic.usage:Ilustração dos exercícios do catálogo que têm um equivalente seguro. Os demais mostram só o texto.`,
  },
  {
    id: 'free-exercise-db',
    title: $localize`:@@credits.free-exercise-db.title:free-exercise-db: base de exercícios`,
    author: 'Clint Plummer (yuhonas) e colaboradores',
    sourceUrl: 'https://github.com/yuhonas/free-exercise-db',
    sourceLabel: 'github.com/yuhonas/free-exercise-db',
    license: 'Unlicense (domínio público)',
    licenseUrl: 'https://unlicense.org/',
    changes: $localize`:@@credits.free-exercise-db.changes:Texto reescrito em português por nós, a partir dos nomes e das instruções originais. As imagens dessa fonte não são usadas.`,
    usage: $localize`:@@credits.free-exercise-db.usage:Nomes, instruções e classificação dos exercícios do catálogo.`,
  },
];
