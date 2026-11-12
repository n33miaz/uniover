import { CATEGORY_TABLE } from './shopping-categories.data';

/**
 * As categorias de mercado (os corredores) e o que se sabe de um nome de produto: a categoria, o emoji de um item comum
 * e os tipos de um nome genérico ("leite" → integral, desnatado...). A categoria segue a mesma regra da API (tabela de
 * `contracts/shopping/categories.json`), então aparelho e servidor chegam à mesma resposta. Tudo aqui é dado do próprio
 * app: funciona sem sinal e não busca imagem nenhuma fora.
 */

export type CategoryKey = (typeof CATEGORY_TABLE.categories)[number]['key'];

/** As chaves na ordem dos corredores. */
export const CATEGORY_KEYS: readonly CategoryKey[] = CATEGORY_TABLE.categories.map((c) => c.key);

export const FALLBACK_CATEGORY = CATEGORY_TABLE.fallback as CategoryKey;

const LABELS: Record<CategoryKey, string> = {
  hortifruti: $localize`:@@shopping.category.hortifruti:Hortifrúti`,
  padaria: $localize`:@@shopping.category.padaria:Padaria`,
  mercearia: $localize`:@@shopping.category.mercearia:Mercearia`,
  carnes: $localize`:@@shopping.category.carnes:Carnes`,
  laticinios: $localize`:@@shopping.category.laticinios:Laticínios e frios`,
  congelados: $localize`:@@shopping.category.congelados:Congelados`,
  bebidas: $localize`:@@shopping.category.bebidas:Bebidas`,
  limpeza: $localize`:@@shopping.category.limpeza:Limpeza`,
  higiene: $localize`:@@shopping.category.higiene:Higiene`,
  bebe: $localize`:@@shopping.category.bebe:Bebê`,
  pet: $localize`:@@shopping.category.pet:Pet`,
  outros: $localize`:@@shopping.category.outros:Outros`,
};

export function categoryLabel(key: CategoryKey): string {
  return LABELS[key];
}

export function isCategory(value: string | null | undefined): value is CategoryKey {
  return !!value && (CATEGORY_KEYS as readonly string[]).includes(value);
}

/** A posição no percurso do mercado (para ordenar a lista por corredor). */
export function categoryOrder(key: CategoryKey): number {
  return CATEGORY_KEYS.indexOf(key);
}

/** O nome como a API compara produtos: sem acento, sem caixa, espaços juntos. */
function normalize(value: string): string {
  return value
    .trim()
    .normalize('NFD')
    .replace(/\p{Mn}/gu, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .normalize('NFC');
}

/** As palavras do nome, sem o "s" final das que têm mais de três letras (o plural casa: "bananas", "ovos"). */
export function nameWords(value: string): string[] {
  return normalize(value)
    .split(' ')
    .filter((word) => word.length > 0)
    .map((word) => (word.length > 3 && word.endsWith('s') ? word.slice(0, -1) : word));
}

function contains(words: readonly string[], keyword: readonly string[]): boolean {
  for (let start = 0; start + keyword.length <= words.length; start++) {
    if (keyword.every((word, i) => words[start + i] === word)) return true;
  }
  return false;
}

/** Das entradas que aparecem inteiras no nome, a mais longa (em palavras, depois em letras); no empate, a primeira. */
function bestMatch<T>(
  name: string,
  entries: readonly (readonly [T, readonly string[]])[],
): T | null {
  const words = nameWords(name);
  let best: T | null = null;
  let bestWords = 0;
  let bestLength = 0;
  for (const [value, keyword] of entries) {
    if (keyword.length < bestWords || !contains(words, keyword)) continue;
    const length = keyword.reduce((sum, word) => sum + word.length, 0);
    if (keyword.length > bestWords || length > bestLength) {
      best = value;
      bestWords = keyword.length;
      bestLength = length;
    }
  }
  return best;
}

const KEYWORDS: readonly (readonly [CategoryKey, readonly string[]])[] =
  CATEGORY_TABLE.categories.flatMap((category) =>
    category.keywords.map((keyword) => [category.key, nameWords(keyword)] as const),
  );

/** A categoria do nome, pela regra da API: a palavra-chave mais longa que aparece inteira; sem nenhuma, "Outros". */
export function categorize(name: string): CategoryKey {
  return bestMatch(name, KEYWORDS) ?? FALLBACK_CATEGORY;
}

/** A categoria que vale para um produto: a escolhida (ou a que o servidor deu); sem ela, a do nome. */
export function categoryOf(product: {
  readonly name: string;
  readonly section: string;
}): CategoryKey {
  return isCategory(product.section) ? product.section : categorize(product.name);
}

// Emoji de itens comuns: o "jeito" do item na lista, sem foto. Sem emoji, vale o desenho da categoria.
const EMOJI: readonly (readonly [string, readonly string[]])[] = (
  [
    ['🥛', 'leite'],
    ['🧀', 'queijo'],
    ['🧀', 'mussarela'],
    ['🧈', 'manteiga'],
    ['🥚', 'ovo'],
    ['🍞', 'pao'],
    ['🥐', 'croissant'],
    ['🥖', 'baguete'],
    ['🍰', 'bolo'],
    ['🍌', 'banana'],
    ['🍎', 'maca'],
    ['🍊', 'laranja'],
    ['🍊', 'tangerina'],
    ['🍋', 'limao'],
    ['🍇', 'uva'],
    ['🍓', 'morango'],
    ['🍉', 'melancia'],
    ['🍍', 'abacaxi'],
    ['🥭', 'manga'],
    ['🍐', 'pera'],
    ['🥝', 'kiwi'],
    ['🥑', 'abacate'],
    ['🍅', 'tomate'],
    ['🥔', 'batata'],
    ['🍠', 'batata doce'],
    ['🥕', 'cenoura'],
    ['🧄', 'alho'],
    ['🧅', 'cebola'],
    ['🥬', 'alface'],
    ['🥬', 'couve'],
    ['🥦', 'brocolis'],
    ['🌽', 'milho'],
    ['🥒', 'pepino'],
    ['🫑', 'pimentao'],
    ['🍆', 'berinjela'],
    ['🥩', 'carne'],
    ['🥩', 'picanha'],
    ['🍗', 'frango'],
    ['🥓', 'bacon'],
    ['🌭', 'salsicha'],
    ['🐟', 'peixe'],
    ['🐟', 'tilapia'],
    ['🦐', 'camarao'],
    ['🍚', 'arroz'],
    ['🍝', 'macarrao'],
    ['☕', 'cafe'],
    ['🍵', 'cha'],
    ['🍫', 'chocolate'],
    ['🍪', 'biscoito'],
    ['🍪', 'bolacha'],
    ['🍯', 'mel'],
    ['🧂', 'sal'],
    ['🍿', 'pipoca'],
    ['🥜', 'amendoim'],
    ['🫒', 'azeite'],
    ['🫒', 'azeitona'],
    ['🍺', 'cerveja'],
    ['🍷', 'vinho'],
    ['💧', 'agua'],
    ['🧃', 'suco'],
    ['🥤', 'refrigerante'],
    ['🥤', 'refri'],
    ['🥤', 'guarana'],
    ['🥥', 'agua de coco'],
    ['🍦', 'sorvete'],
    ['🍕', 'pizza'],
    ['🧊', 'gelo'],
    ['🧻', 'papel higienico'],
    ['🧻', 'papel toalha'],
    ['🧼', 'sabonete'],
    ['🧼', 'sabao'],
    ['🧽', 'esponja'],
    ['🪥', 'escova de dente'],
    ['🧴', 'shampoo'],
    ['🧴', 'condicionador'],
    ['🧴', 'detergente'],
    ['🍼', 'mamadeira'],
    ['🦴', 'racao'],
  ] as const
).map(([emoji, keyword]) => [emoji, nameWords(keyword)] as const);

/** O emoji de um item comum, ou `null`. */
export function itemEmoji(name: string): string | null {
  return bestMatch(name, EMOJI);
}

// Os tipos de um nome genérico. Só aparecem quando o nome é exatamente o genérico: "leite integral" já está detalhado.
const VARIANTS: Readonly<Record<string, readonly string[]>> = {
  leite: ['integral', 'desnatado', 'semidesnatado', 'sem lactose'],
  iogurte: ['natural', 'grego', 'de morango', 'desnatado'],
  queijo: ['mussarela', 'prato', 'minas', 'parmesão'],
  arroz: ['branco', 'integral', 'parboilizado'],
  feijao: ['carioca', 'preto', 'fradinho'],
  cafe: ['tradicional', 'extraforte', 'descafeinado', 'em cápsula'],
  acucar: ['refinado', 'cristal', 'mascavo', 'demerara'],
  pao: ['francês', 'de forma', 'integral', 'de queijo'],
  macarrao: ['espaguete', 'parafuso', 'penne', 'instantâneo'],
  carne: ['moída', 'alcatra', 'patinho', 'acém', 'costela'],
  frango: ['peito', 'coxa', 'sobrecoxa', 'inteiro'],
  oleo: ['de soja', 'de girassol', 'de canola'],
  farinha: ['de trigo', 'de mandioca', 'de milho'],
  biscoito: ['água e sal', 'recheado', 'maisena', 'integral'],
  refrigerante: ['de cola', 'guaraná', 'de laranja', 'zero'],
  suco: ['de laranja', 'de uva', 'de caixinha', 'concentrado'],
  sabao: ['em pó', 'líquido', 'em barra'],
  agua: ['sem gás', 'com gás'],
  cerveja: ['lata', 'long neck', 'garrafa'],
  ovo: ['branco', 'vermelho', 'caipira'],
  batata: ['inglesa', 'doce', 'palha'],
  molho: ['de tomate', 'shoyu', 'inglês'],
};

/** Os tipos a sugerir para o nome, ou nenhum (nome já detalhado, ou sem tipos conhecidos). */
export function variantsOf(name: string): readonly string[] {
  const words = nameWords(name);
  return words.length === 1 ? (VARIANTS[words[0]] ?? []) : [];
}

/** O nome com o tipo escolhido: "Leite" + "sem lactose" = "Leite sem lactose". */
export function withVariant(name: string, variant: string): string {
  return `${name.trim()} ${variant}`.replace(/\s+/g, ' ');
}

/**
 * Nomes comuns, com acento, para sugerir enquanto a pessoa digita (depois do que o grupo já comprou). A categoria de
 * cada um sai da tabela, pela mesma regra.
 */
export const COMMON_NAMES: readonly string[] = [
  'Abacate',
  'Abacaxi',
  'Abobrinha',
  'Achocolatado',
  'Açúcar',
  'Água',
  'Água com gás',
  'Água sanitária',
  'Alface',
  'Alho',
  'Amaciante',
  'Arroz',
  'Atum',
  'Azeite',
  'Bacon',
  'Banana',
  'Batata',
  'Batata doce',
  'Biscoito',
  'Bolacha',
  'Brócolis',
  'Café',
  'Carne moída',
  'Cebola',
  'Cenoura',
  'Cerveja',
  'Chocolate',
  'Condicionador',
  'Creme de leite',
  'Creme dental',
  'Desinfetante',
  'Desodorante',
  'Detergente',
  'Esponja',
  'Extrato de tomate',
  'Farinha de trigo',
  'Feijão',
  'Fralda',
  'Frango',
  'Iogurte',
  'Laranja',
  'Leite',
  'Leite condensado',
  'Limão',
  'Linguiça',
  'Maçã',
  'Macarrão',
  'Maionese',
  'Mamão',
  'Manteiga',
  'Margarina',
  'Melancia',
  'Molho de tomate',
  'Morango',
  'Óleo',
  'Ovos',
  'Pão de forma',
  'Pão francês',
  'Papel higiênico',
  'Papel toalha',
  'Peito de frango',
  'Pimentão',
  'Pizza',
  'Presunto',
  'Queijo',
  'Ração',
  'Refrigerante',
  'Requeijão',
  'Sabão em pó',
  'Sabonete',
  'Sal',
  'Saco de lixo',
  'Shampoo',
  'Sorvete',
  'Suco',
  'Tomate',
  'Uva',
  'Vinagre',
];
