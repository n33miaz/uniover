import contract from '../../../../../../contracts/shopping/categories.json';
import {
  CATEGORY_KEYS,
  categorize,
  categoryLabel,
  categoryOf,
  itemEmoji,
  variantsOf,
  withVariant,
} from './shopping-categories';
import { CATEGORY_TABLE } from './shopping-categories.data';

describe('the category table', () => {
  it('is the same table the API embeds (contracts/shopping/categories.json)', () => {
    expect({ fallback: contract.fallback, categories: contract.categories }).toEqual(
      CATEGORY_TABLE,
    );
  });

  it('starts in the produce aisle, ends with "Outros" and has a label for each key', () => {
    expect(CATEGORY_KEYS[0]).toBe('hortifruti');
    expect(CATEGORY_KEYS.at(-1)).toBe('outros');
    for (const key of CATEGORY_KEYS) expect(categoryLabel(key)).not.toBe('');
  });
});

describe('categorize (the same cases as ShoppingCategoriesTests on the API)', () => {
  it.each([
    ['Leite', 'laticinios'],
    ['leite integral', 'laticinios'],
    ['Leite condensado', 'mercearia'],
    ['Creme de leite', 'mercearia'],
    ['Papel higiênico', 'higiene'],
    ['Sabão em pó', 'limpeza'],
    ['Sabonete', 'higiene'],
    ['Pão de queijo congelado', 'congelados'],
    ['Pão de queijo', 'padaria'],
    ['Bananas', 'hortifruti'],
    ['OVOS brancos', 'laticinios'],
    ['Água sanitária', 'limpeza'],
    ['Água com gás', 'bebidas'],
    ['Ração de gato', 'pet'],
    ['Fralda G', 'bebe'],
    ['Picanha', 'carnes'],
    ['Salsa', 'hortifruti'],
    ['Sal', 'mercearia'],
    ['Chá gelado', 'bebidas'],
    ['Pilhas AA', 'outros'],
    ['', 'outros'],
  ])('%s → %s', (name, key) => {
    expect(categorize(name)).toBe(key);
  });

  it('a chosen category wins over the name; an unknown section falls back to the name', () => {
    expect(categoryOf({ name: 'Leite', section: 'bebidas' })).toBe('bebidas');
    expect(categoryOf({ name: 'Leite', section: 'Frios' })).toBe('laticinios');
    expect(categoryOf({ name: 'Leite', section: '' })).toBe('laticinios');
  });
});

describe('item helpers', () => {
  it('gives common items an emoji, the longest name first, and none to the unknown', () => {
    expect(itemEmoji('Leite integral')).toBe('🥛');
    expect(itemEmoji('Bananas')).toBe('🍌');
    expect(itemEmoji('Batata doce')).toBe('🍠');
    expect(itemEmoji('Pilhas')).toBeNull();
  });

  it('suggests kinds only for a generic name', () => {
    expect(variantsOf('Leite')).toContain('sem lactose');
    expect(variantsOf('ovos')).toContain('caipira');
    expect(variantsOf('Leite integral')).toEqual([]);
    expect(variantsOf('Pilhas')).toEqual([]);
    expect(withVariant('Leite ', 'sem lactose')).toBe('Leite sem lactose');
  });
});
