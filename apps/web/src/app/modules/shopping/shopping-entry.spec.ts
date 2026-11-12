import { categorize } from './shopping-categories';
import { parseEntry, takePayPrice } from './shopping-entry';
import { lineTotal } from './shopping-model';

describe('parseEntry', () => {
  it.each([
    // [digitado, nome, quantidade, unidade, preço, promoção]
    ['leite 5,49', 'Leite', 1, null, 5.49, false],
    ['Leite 5.49', 'Leite', 1, null, 5.49, false],
    ['leite', 'Leite', 1, null, null, false],
    ['  leite   integral  ', 'Leite integral', 1, null, null, false],
    ['arroz 2x 12,90', 'Arroz', 2, null, 12.9, false],
    ['arroz 2 x 12,90', 'Arroz', 2, null, 12.9, false],
    ['arroz x2 12,90', 'Arroz', 2, null, 12.9, false],
    ['2x arroz 12,90', 'Arroz', 2, null, 12.9, false],
    ['12 ovos', 'Ovos', 12, null, null, false],
    ['12 ovos 15,90', 'Ovos', 12, null, 15.9, false],
    // A granel: Hortifrúti e Carnes, o peso é o que vai na sacola e o preço é por quilo.
    ['banana 1,2kg 6,99', 'Banana', 1.2, 'kg', 6.99, false],
    ['banana 1,2 kg 6,99', 'Banana', 1.2, 'kg', 6.99, false],
    ['tomate 1,2kg 6,99/kg', 'Tomate', 1.2, 'kg', 6.99, false],
    ['tomate 1,2 kg 6,99 /kg', 'Tomate', 1.2, 'kg', 6.99, false],
    ['tomate 1,2kg R$ 6,99/kg', 'Tomate', 1.2, 'kg', 6.99, false],
    ['batata 800g 4,99', 'Batata', 0.8, 'kg', 4.99, false],
    ['carne moída 500g 39,90', 'Carne moída', 0.5, 'kg', 39.9, false],
    ['picanha 1,350kg 79,90', 'Picanha', 1.35, 'kg', 79.9, false],
    ['frango 2kg', 'Frango', 2, 'kg', null, false],
    // "/kg" leva qualquer item para o peso a granel, mesmo fora das duas categorias.
    ['queijo 300g 49,90/kg', 'Queijo', 0.3, 'kg', 49.9, false],
    ['mussarela 0,250 kg 54,90/kg', 'Mussarela', 0.25, 'kg', 54.9, false],
    // "/kg" sem peso: a granel, e a balança diz o peso depois.
    ['tomate 6,99/kg', 'Tomate', 1, 'kg', 6.99, false],
    // Fora disso, peso, volume e unidades são da embalagem: ficam no nome e o preço é o do pacote.
    ['arroz 5kg 24,90', 'Arroz 5kg', 1, null, 24.9, false],
    ['arroz 5 kg 24,90', 'Arroz 5kg', 1, null, 24.9, false],
    ['café 500g 18,90', 'Café 500g', 1, null, 18.9, false],
    ['feijão 1kg 8,49', 'Feijão 1kg', 1, null, 8.49, false],
    ['açúcar 2x 5kg 21,90', 'Açúcar 5kg', 2, null, 21.9, false],
    ['queijo 500g 49,90', 'Queijo 500g', 1, null, 49.9, false],
    ['queijo 350 g', 'Queijo 350g', 1, null, null, false],
    ['ovos 30un 19,90', 'Ovos 30un', 1, null, 19.9, false],
    ['iogurte 6un 12,00', 'Iogurte 6un', 1, null, 12, false],
    ['iogurte 6 un', 'Iogurte 6un', 1, null, null, false],
    ['coca 2l 9,99', 'Coca 2l', 1, null, 9.99, false],
    ['leite 1 l 4,79', 'Leite 1 l', 1, null, 4.79, false],
    ['sabão em pó 1,6kg 22,90', 'Sabão em pó 1,6kg', 1, null, 22.9, false],
    // Inteiro sozinho no fim, sem "R$" e sem vírgula: é quantidade, nunca preço.
    ['pão 10', 'Pão', 10, null, null, false],
    ['ovos 12', 'Ovos', 12, null, null, false],
    ['leite 2 5,49', 'Leite', 2, null, 5.49, false],
    ['cerveja 12 3,29', 'Cerveja', 12, null, 3.29, false],
    ['tomate 3', 'Tomate', 3, null, null, false],
    ['pão R$ 10', 'Pão', 1, null, 10, false],
    ['pão r$10', 'Pão', 1, null, 10, false],
    ['leite R$ 5,49', 'Leite', 1, null, 5.49, false],
    ['leite r$5,49', 'Leite', 1, null, 5.49, false],
    // Com a quantidade já dita, outro inteiro fica no nome (nunca vira preço).
    ['pão 2x 10', 'Pão 10', 2, null, null, false],
    ['2 leite 3', 'Leite 3', 2, null, null, false],
    ['leite 5,49 promo', 'Leite', 1, null, 5.49, true],
    ['leite promoção 5,49', 'Leite', 1, null, 5.49, true],
    ['sabão em pó oferta 18,9', 'Sabão em pó', 1, null, 18.9, true],
    ['café 3x 15,5', 'Café', 3, null, 15.5, false],
    ['açúcar 2 x 4,39 promo', 'Açúcar', 2, null, 4.39, true],
    ['banana 1kg 5,99 oferta', 'Banana', 1, 'kg', 5.99, true],
  ])('"%s" → %s, %s %s, %s, promo %s', (text, name, quantity, unit, price, promo) => {
    expect(parseEntry(text)).toEqual({ name, quantity, unit, unitPrice: price, promo });
  });

  it.each([[''], ['   '], ['5,49'], ['2x 5,49'], ['R$ 10'], ['10'], ['1,2kg 6,99/kg']])(
    '"%s" has no item',
    (text) => {
      expect(parseEntry(text)).toBeNull();
    },
  );

  it.each([
    // [digitado, total da linha]: o que a compra soma, sem multiplicar o tamanho da embalagem.
    ['arroz 5kg 24,90', 24.9],
    ['café 500g 18,90', 18.9],
    ['ovos 30un 19,90', 19.9],
    ['banana 1,2kg 6,99', 8.39],
    ['tomate 1,2kg 6,99/kg', 8.39],
    ['carne moída 500g 39,90', 19.95],
    ['leite 2 5,49', 10.98],
    ['cerveja 12 3,29', 39.48],
  ])('"%s" adds R$ %s to the purchase', (text, total) => {
    const entry = parseEntry(text)!;
    expect(lineTotal(entry.quantity, entry.unitPrice!)).toBe(total);
  });

  it('uses the category the person chose for the product, not only the name', () => {
    // "Queijo minas" escolhido como Hortifrúti (vendido a granel na feira): o peso vai para a quantidade.
    const chosen = (name: string) => (name === 'queijo minas' ? 'hortifruti' : categorize(name));
    expect(parseEntry('queijo minas 400g 39,90', chosen)).toEqual({
      name: 'Queijo minas',
      quantity: 0.4,
      unit: 'kg',
      unitPrice: 39.9,
      promo: false,
    });
    expect(parseEntry('queijo minas 400g 39,90')).toMatchObject({
      name: 'Queijo minas 400g',
      quantity: 1,
      unit: null,
    });
  });

  it('keeps the last money as the price when two appear', () => {
    expect(parseEntry('leite 4,99 5,49')).toMatchObject({ name: 'Leite 4,99', unitPrice: 5.49 });
  });

  it('refuses a price above what the server accepts, keeping the item', () => {
    expect(parseEntry('carro R$ 99999999')).toMatchObject({ unitPrice: null });
  });

  it('ignores a zero quantity', () => {
    expect(parseEntry('leite 0x 5,49')).toMatchObject({ quantity: 1, unitPrice: 5.49 });
    expect(parseEntry('pão 0')).toMatchObject({ name: 'Pão', quantity: 1, unitPrice: null });
    expect(parseEntry('banana 0kg 5,99')).toMatchObject({ quantity: 1, unit: null });
  });
});

describe('takePayPrice', () => {
  it.each([
    [4.99, 3, 2, 3.33],
    [10, 2, 1, 5],
    [7.5, 4, 3, 5.63],
  ])('sticker %s, take %s pay %s → %s each', (sticker, take, pay, each) => {
    expect(takePayPrice(sticker, take, pay)).toBe(each);
  });

  it.each([
    [5, 2, 2],
    [5, 2, 3],
    [5, 0, 0],
    [-1, 3, 2],
  ])('refuses a promotion that makes no sense (%s, %s, %s)', (sticker, take, pay) => {
    expect(takePayPrice(sticker, take, pay)).toBeNull();
  });
});
