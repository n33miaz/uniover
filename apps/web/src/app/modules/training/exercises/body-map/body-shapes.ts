/**
 * Formas do desenho do corpo, como textos de caminho SVG (`d`). Tudo é gerado por poucas funções simples (cápsula,
 * elipse, retângulo arredondado), então o desenho inteiro vem de dados: o modelo só repete `<path [attr.d]>`, sem
 * atributo solto, sem `style` e sem imagem.
 */

/** Um retângulo `[esquerda, topo, direita, base]` no espaço do desenho. */
export type Rect = readonly [left: number, top: number, right: number, bottom: number];

const num = (value: number): string => String(Math.round(value * 10) / 10);

/** Elipse com centro `(cx, cy)`, raios `rx` e `ry` e giro de `degrees` (no sentido horário). */
export function ellipse(cx: number, cy: number, rx: number, ry: number, degrees = 0): string {
  const rad = (degrees * Math.PI) / 180;
  const dx = rx * Math.cos(rad);
  const dy = rx * Math.sin(rad);
  const [x1, y1, x2, y2] = [cx - dx, cy - dy, cx + dx, cy + dy].map(num);
  const arc = `A${num(rx)} ${num(ry)} ${num(degrees)} 1 0`;
  return `M${x1} ${y1}${arc} ${x2} ${y2}${arc} ${x1} ${y1}Z`;
}

/** Círculo: a elipse de raios iguais. */
export const circle = (cx: number, cy: number, r: number): string => ellipse(cx, cy, r, r);

/** Cápsula: o segmento `(x1, y1)`-`(x2, y2)` engrossado pelo raio `r`, com as pontas redondas (braços e pernas). */
export function capsule(x1: number, y1: number, x2: number, y2: number, r: number): string {
  const length = Math.hypot(x2 - x1, y2 - y1);
  const nx = ((y2 - y1) / length) * r;
  const ny = (-(x2 - x1) / length) * r;
  const arc = `A${num(r)} ${num(r)} 0 0`;
  return (
    `M${num(x1 + nx)} ${num(y1 + ny)}L${num(x2 + nx)} ${num(y2 + ny)}` +
    `${arc} 1 ${num(x2 - nx)} ${num(y2 - ny)}L${num(x1 - nx)} ${num(y1 - ny)}` +
    `${arc} 1 ${num(x1 + nx)} ${num(y1 + ny)}Z`
  );
}

/** Retângulo de cantos redondos com o canto superior esquerdo em `(x, y)`. */
export function pill(x: number, y: number, width: number, height: number, r: number): string {
  const [right, bottom] = [x + width, y + height];
  const arc = `A${num(r)} ${num(r)} 0 0 1`;
  return (
    `M${num(x + r)} ${num(y)}H${num(right - r)}${arc} ${num(right)} ${num(y + r)}V${num(bottom - r)}` +
    `${arc} ${num(right - r)} ${num(bottom)}H${num(x + r)}${arc} ${num(x)} ${num(bottom - r)}` +
    `V${num(y + r)}${arc} ${num(x + r)} ${num(y)}Z`
  );
}

/** Polígono pelos pontos dados (quinas vivas; o contorno com `stroke-linejoin: round` as arredonda). */
export function polygon(...points: readonly (readonly [number, number])[]): string {
  return `M${points.map(([x, y]) => `${num(x)} ${num(y)}`).join('L')}Z`;
}

/** O retângulo como caminho (a área de toque de uma zona). */
export function rectPath([left, top, right, bottom]: Rect): string {
  return `M${num(left)} ${num(top)}H${num(right)}V${num(bottom)}H${num(left)}Z`;
}

/** O mesmo retângulo do outro lado do corpo (espelho em torno do eixo vertical do desenho). */
export function mirrorRect([left, top, right, bottom]: Rect, width: number): Rect {
  return [width - right, top, width - left, bottom];
}

/** Dois retângulos se invadem (encostar na borda não conta). */
export function rectsOverlap(a: Rect, b: Rect): boolean {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}
