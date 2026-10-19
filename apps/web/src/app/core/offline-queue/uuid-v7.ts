/**
 * UUID v7 (RFC 9562): os 48 primeiros bits são o instante em milissegundos, então os identificadores ordenam por
 * criação. Dentro do mesmo milissegundo um contador de 12 bits mantém a ordem estrita.
 */
export interface UuidV7Source {
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
}

const defaultSource: UuidV7Source = {
  now: () => Date.now(),
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
};

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

function format(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 16; i++) {
    if (i === 4 || i === 6 || i === 8 || i === 10) out += '-';
    out += HEX[bytes[i]];
  }
  return out;
}

/** Gerador com estado próprio (último instante e contador); cada instância garante ordem estrita. */
export function createUuidV7Generator(source: UuidV7Source = defaultSource): () => string {
  let lastMs = -1;
  let counter = 0;

  return () => {
    let ms = source.now();
    const random = source.randomBytes(10);

    if (ms > lastMs) {
      lastMs = ms;
      // Começa em algum ponto da primeira metade, deixando folga para os UUIDs do mesmo milissegundo.
      counter = ((random[0] << 8) | random[1]) & 0x7ff;
    } else {
      // Mesmo milissegundo (ou relógio que recuou): segue o último instante e conta para cima.
      ms = lastMs;
      counter++;
      if (counter > 0xfff) {
        counter = 0;
        lastMs++;
        ms = lastMs;
      }
    }

    const bytes = new Uint8Array(16);
    // 48 bits de milissegundos sem usar operadores de 32 bits (passam de 2^32).
    bytes[0] = Math.floor(ms / 2 ** 40) & 0xff;
    bytes[1] = Math.floor(ms / 2 ** 32) & 0xff;
    bytes[2] = Math.floor(ms / 2 ** 24) & 0xff;
    bytes[3] = Math.floor(ms / 2 ** 16) & 0xff;
    bytes[4] = Math.floor(ms / 2 ** 8) & 0xff;
    bytes[5] = ms & 0xff;
    bytes[6] = 0x70 | ((counter >> 8) & 0x0f);
    bytes[7] = counter & 0xff;
    bytes[8] = 0x80 | (random[2] & 0x3f);
    bytes.set(random.subarray(3, 10), 9);
    return format(bytes);
  };
}

/** Gerador padrão do app (relógio e `crypto.getRandomValues` do navegador). */
export const uuidV7 = createUuidV7Generator();

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}
