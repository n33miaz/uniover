import type { MuscleId } from '../../domain/taxonomy';
import { MUSCLE_IDS } from '../../domain/taxonomy';
import { Rect, capsule, circle, ellipse, mirrorRect, pill, polygon } from './body-shapes';

/**
 * O mapa do corpo como dados: o contorno da silhueta e, para cada face, as zonas tocáveis. Desenho próprio e simples (formas
 * arredondadas, sem anatomia realista), num espaço de 250 por 300 que o SVG escala.
 *
 * Cada zona é **um músculo da taxonomia**; os dois lados do corpo são a mesma zona (tocar em qualquer um vale). Cada zona
 * tem duas camadas:
 * - `shapes`: o que se vê (contorno e preenchimento);
 * - `tiles`: a área de toque, **retângulos que não se sobrepõem** e ocupam o espaço em volta da forma. O dedo erra o músculo
 *   pequeno por poucos milímetros, e o toque que cai no espaço entre duas formas vai para a zona mais próxima, sem ambiguidade
 *   (nenhum retângulo invade outro; um teste confere). Num celular baixo só os músculos grandes chegam a 44 px; os
 *   demais ficam entre 24 e 44 px (o teste de toque confere esse piso), e a lista de músculos logo abaixo da figura
 *   alcança todos eles com alvos de 44 px.
 */

export type BodyFace = 'front' | 'back';
export const BODY_FACES: readonly BodyFace[] = ['front', 'back'];

export const BODY_WIDTH = 250;
export const BODY_HEIGHT = 300;

export interface BodyZone {
  readonly muscle: MuscleId;
  readonly shapes: readonly string[];
  readonly tiles: readonly Rect[];
}

// O corpo é um pouco mais largo que alto-e-fino: as posições na horizontal (e a largura das formas largas) saem de uma grade
// de 220 esticada por `STRETCH` em torno do eixo, que dá mais área de toque no tronco sem deformar círculos e cápsulas.
const STRETCH = 1.15;
const AXIS = BODY_WIDTH / 2;
const sx = (value: number): number => Math.round((AXIS + (value - 110) * STRETCH) * 10) / 10;
const sw = (value: number): number => value * STRETCH;

/** Lado do corpo: `x` posiciona (espelha no lado direito) e `turn` inverte o sentido de giro das elipses. */
interface Side {
  readonly x: (value: number) => number;
  readonly turn: 1 | -1;
}
const LEFT: Side = { x: sx, turn: 1 };
const RIGHT: Side = { x: (value) => BODY_WIDTH - sx(value), turn: -1 };

/** A mesma forma nos dois lados do corpo. */
const pair = (make: (side: Side) => string): string[] => [make(LEFT), make(RIGHT)];

/** Retângulo `[esquerda, topo, direita, base]` da grade de 220 passado para o espaço do desenho. */
const tile = ([left, top, right, bottom]: Rect): Rect => [sx(left), top, sx(right), bottom];
/** Uma área de toque do lado esquerdo e a espelhada. */
const tilePair = (rect: Rect): Rect[] => [tile(rect), mirrorRect(tile(rect), BODY_WIDTH)];

const TORSO =
  `M${sx(72)} 56Q${AXIS} 47 ${sx(148)} 56L${sx(141)} 106Q${sx(134)} 126 ${sx(134)} 142` +
  `L${sx(139)} 166Q${AXIS} 174 ${sx(81)} 166L${sx(86)} 142Q${sx(86)} 126 ${sx(79)} 106Z`;

/** Silhueta neutra, igual nas duas faces: cabeça, pescoço, tronco, braços e pernas (mãos e pés só de enfeite). */
export const BODY_OUTLINE: readonly string[] = [
  circle(AXIS, 20, 15),
  pill(AXIS - 9, 32, 18, 20, 7),
  TORSO,
  ...pair(({ x }) => capsule(x(64), 66, x(48), 112, 11.5)),
  ...pair(({ x }) => capsule(x(47), 118, x(36), 162, 9.5)),
  ...pair(({ x }) => ellipse(x(33), 172, 7.5, 9.5)),
  ...pair(({ x }) => capsule(x(95), 168, x(94), 224, 16)),
  ...pair(({ x }) => capsule(x(94), 229, x(93), 278, 11.5)),
  ...pair(({ x }) => ellipse(x(90), 287, 13, 5.5)),
];

// Zonas que valem nas duas faces (o ombro, o antebraço e a panturrilha aparecem de frente e de costas).
const SHOULDERS: BodyZone = {
  muscle: 'shoulders',
  shapes: pair(({ x }) => circle(x(70), 68, 12.5)),
  tiles: tilePair([40, 42, 84, 90]),
};
const FOREARMS: BodyZone = {
  muscle: 'forearms',
  shapes: pair(({ x }) => capsule(x(46), 124, x(39), 152, 7)),
  tiles: tilePair([14, 126, 56, 196]),
};
const CALVES: BodyZone = {
  muscle: 'calves',
  shapes: pair(({ x }) => capsule(x(93), 238, x(93), 268, 9.5)),
  tiles: tilePair([68, 234, 110, 296]),
};

/** As zonas de cada face, de cima para baixo (a ordem da tabulação). */
export const BODY_ZONES: Readonly<Record<BodyFace, readonly BodyZone[]>> = {
  front: [
    {
      muscle: 'neck',
      shapes: [pill(AXIS - sw(7), 36, sw(14), 13, 5)],
      tiles: [tile([92, 24, 128, 54])],
    },
    SHOULDERS,
    {
      muscle: 'chest',
      shapes: pair(({ x }) => ellipse(x(97), 88, sw(15), 13.5)),
      tiles: [tile([84, 54, 136, 104])],
    },
    {
      muscle: 'biceps',
      shapes: pair(({ x }) => capsule(x(60), 80, x(52), 104, 7.5)),
      tiles: tilePair([30, 90, 84, 126]),
    },
    {
      muscle: 'abdominals',
      shapes: [pill(AXIS - sw(11), 106, sw(22), 42, 10)],
      tiles: [tile([84, 104, 136, 170])],
    },
    FOREARMS,
    {
      muscle: 'quadriceps',
      shapes: pair(({ x }) => capsule(x(93), 178, x(93), 214, 11)),
      tiles: tilePair([56, 170, 98, 234]),
    },
    {
      muscle: 'adductors',
      shapes: pair(({ x }) => capsule(x(106.5), 182, x(106.5), 210, 4)),
      tiles: [tile([98, 170, 122, 234])],
    },
    CALVES,
  ],
  back: [
    {
      muscle: 'traps',
      shapes: [polygon([AXIS, 50], [sx(130), 62], [AXIS, 100], [sx(90), 62])],
      tiles: [tile([84, 36, 136, 92])],
    },
    SHOULDERS,
    {
      muscle: 'triceps',
      shapes: pair(({ x }) => capsule(x(60), 80, x(52), 104, 7.5)),
      tiles: tilePair([30, 90, 68, 126]),
    },
    {
      muscle: 'lats',
      shapes: pair(({ turn, x }) => ellipse(x(88), 108, sw(9), 20, -8 * turn)),
      tiles: tilePair([68, 92, 98, 134]),
    },
    FOREARMS,
    {
      muscle: 'middle_back',
      shapes: [pill(AXIS - sw(8), 104, sw(16), 26, 7)],
      tiles: [tile([98, 92, 122, 134])],
    },
    {
      muscle: 'lower_back',
      shapes: [pill(AXIS - sw(12), 138, sw(24), 24, 9)],
      tiles: [tile([86, 134, 134, 168])],
    },
    {
      muscle: 'glutes',
      shapes: pair(({ x }) => ellipse(x(98), 182, sw(12.5), 11)),
      tiles: [tile([80, 168, 140, 200])],
    },
    {
      muscle: 'abductors',
      shapes: pair(({ x }) => ellipse(x(77), 184, 4.5, 10)),
      tiles: tilePair([56, 160, 80, 200]),
    },
    {
      muscle: 'hamstrings',
      shapes: pair(({ x }) => capsule(x(93), 206, x(93), 224, 11)),
      tiles: tilePair([64, 200, 110, 234]),
    },
    CALVES,
  ],
};

/** As faces em que o músculo tem zona (a frente primeiro). */
export function facesOf(muscle: string): BodyFace[] {
  return BODY_FACES.filter((face) => BODY_ZONES[face].some((zone) => zone.muscle === muscle));
}

/** A face a mostrar quando o músculo é escolhido: a atual, se ele aparece nela; senão a primeira em que aparece. */
export function faceFor(muscle: string, current: BodyFace): BodyFace {
  const faces = facesOf(muscle);
  return faces.includes(current) || faces.length === 0 ? current : faces[0];
}

/** Músculos da taxonomia sem zona em nenhuma face (devem ficar vazios; o teste cobra). */
export const MUSCLES_WITHOUT_ZONE: readonly MuscleId[] = MUSCLE_IDS.filter(
  (muscle) => facesOf(muscle).length === 0,
);
