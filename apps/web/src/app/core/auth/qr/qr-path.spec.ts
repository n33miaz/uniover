import { encode } from 'uqr';
import { qrDrawing } from './qr-path';

/** Refaz a matriz a partir do caminho (cada `M x y h n v1 h-n z` é uma sequência de módulos escuros numa linha). */
function matrixOf(drawing: { size: number; path: string }): boolean[][] {
  const grid = Array.from({ length: drawing.size }, () => Array<boolean>(drawing.size).fill(false));
  for (const [, x, y, run] of drawing.path.matchAll(/M(\d+) (\d+)h(\d+)v1h-\3z/g)) {
    for (let i = 0; i < Number(run); i++) grid[Number(y)][Number(x) + i] = true;
  }
  return grid;
}

describe('qrDrawing', () => {
  const link = 'https://uniover.exemplo.app/entrar/qr?codigo=AbC_123-xyz45678';

  it('draws exactly the modules the encoder produced', () => {
    const { data, size } = encode(link, { ecc: 'M', border: 0 });
    const drawing = qrDrawing(link);

    expect(drawing.size).toBe(size);
    expect(matrixOf(drawing)).toEqual(data);
  });

  it('keeps the three finder patterns every scanner locks onto (7x7 ring around a 3x3 core)', () => {
    const drawing = qrDrawing(link);
    const grid = matrixOf(drawing);
    const finderAt = (top: number, left: number) => {
      for (let y = 0; y < 7; y++) {
        for (let x = 0; x < 7; x++) {
          const ring = y === 0 || y === 6 || x === 0 || x === 6;
          const core = y >= 2 && y <= 4 && x >= 2 && x <= 4;
          expect(grid[top + y][left + x], `módulo ${x},${y} em ${top},${left}`).toBe(ring || core);
        }
      }
    };
    finderAt(0, 0);
    finderAt(0, drawing.size - 7);
    finderAt(drawing.size - 7, 0);
  });

  it('is a single path made only of rectangles, with no style, script or image to trip the CSP', () => {
    const { path } = qrDrawing(link);

    expect(path).toMatch(/^(M\d+ \d+h\d+v1h-\d+z)+$/);
  });

  it('is deterministic and grows only a little for the real link (small, easy to scan)', () => {
    expect(qrDrawing(link)).toEqual(qrDrawing(link));
    // O link real tem ~60 caracteres: versão 5 ou menos (37 módulos) mantém o QR grande o bastante na tela.
    expect(qrDrawing(link).size).toBeLessThanOrEqual(37);
  });

  it('encodes different links differently', () => {
    expect(qrDrawing(link).path).not.toBe(qrDrawing(link.replace('AbC', 'XyZ')).path);
  });
});
