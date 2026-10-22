import type { MuscleId } from '../../domain/taxonomy';
import { MUSCLE_IDS } from '../../domain/taxonomy';
import { Rect, circle, ellipse, mirrorRect, pill } from './body-shapes';

/**
 * O mapa do corpo como dados: o contorno da silhueta e, para cada face, as zonas tocáveis. Desenho vetorial próprio, feito
 * com curvas suaves e proporções estilizadas (sem anatomia realista), num espaço de 250 por 300 que o SVG escala.
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
  `M${sx(72)} 56C${sx(88)} 48 ${sx(132)} 48 ${sx(148)} 56` +
  `C${sx(145)} 71 ${sx(143)} 88 ${sx(140)} 102` +
  `C${sx(137)} 116 ${sx(132)} 130 ${sx(134)} 143L${sx(139)} 164` +
  `C${sx(134)} 169 ${sx(129)} 172 ${AXIS} 172` +
  `C${sx(105)} 172 ${sx(94)} 170 ${sx(81)} 164L${sx(86)} 143` +
  `C${sx(88)} 130 ${sx(83)} 116 ${sx(79)} 102` +
  `C${sx(76)} 88 ${sx(74)} 71 ${sx(72)} 56Z`;

/** Silhueta neutra, igual nas duas faces: cabeça, pescoço, tronco, braços e pernas (mãos e pés só de enfeite). */
export const BODY_OUTLINE: readonly string[] = [
  circle(AXIS, 20, 15),
  pill(AXIS - 9, 32, 18, 20, 7),
  TORSO,
  ...pair(
    ({ x }) =>
      `M${x(69)} 62C${x(77)} 62 ${x(80)} 68 ${x(78)} 76` +
      `L${x(63)} 109C${x(60)} 117 ${x(55)} 121 ${x(49)} 118` +
      `C${x(42)} 115 ${x(40)} 109 ${x(43)} 101L${x(55)} 70` +
      `C${x(58)} 64 ${x(63)} 61 ${x(69)} 62Z`,
  ),
  ...pair(
    ({ x }) =>
      `M${x(50)} 116C${x(56)} 118 ${x(56)} 125 ${x(53)} 133` +
      `L${x(45)} 158C${x(42)} 165 ${x(36)} 167 ${x(31)} 163` +
      `C${x(27)} 159 ${x(27)} 153 ${x(30)} 146L${x(39)} 122` +
      `C${x(41)} 117 ${x(45)} 115 ${x(50)} 116Z`,
  ),
  ...pair(({ x }) => ellipse(x(33), 172, 7.5, 9.5)),
  ...pair(
    ({ x }) =>
      `M${x(104)} 167C${x(114)} 168 ${x(119)} 176 ${x(118)} 188` +
      `L${x(115)} 219C${x(114)} 229 ${x(108)} 235 ${x(101)} 233` +
      `C${x(94)} 231 ${x(90)} 225 ${x(90)} 217L${x(87)} 188` +
      `C${x(86)} 176 ${x(93)} 168 ${x(104)} 167Z`,
  ),
  ...pair(
    ({ x }) =>
      `M${x(100)} 229C${x(107)} 230 ${x(109)} 239 ${x(108)} 249` +
      `C${x(107)} 260 ${x(105)} 271 ${x(103)} 279` +
      `C${x(101)} 285 ${x(94)} 286 ${x(90)} 282` +
      `C${x(86)} 278 ${x(86)} 270 ${x(87)} 262L${x(89)} 240` +
      `C${x(90)} 232 ${x(94)} 228 ${x(100)} 229Z`,
  ),
  ...pair(({ x }) => ellipse(x(90), 287, 13, 5.5)),
];

// Zonas que valem nas duas faces (o ombro, o antebraço e a panturrilha aparecem de frente e de costas).
const SHOULDERS: BodyZone = {
  muscle: 'shoulders',
  shapes: pair(
    ({ x }) =>
      `M${x(69)} 55C${x(79)} 55 ${x(85)} 62 ${x(84)} 70` +
      `C${x(83)} 79 ${x(76)} 85 ${x(69)} 82` +
      `C${x(62)} 79 ${x(60)} 71 ${x(63)} 63C${x(64)} 59 ${x(66)} 56 ${x(69)} 55Z`,
  ),
  tiles: tilePair([40, 42, 84, 90]),
};
const FOREARMS: BodyZone = {
  muscle: 'forearms',
  shapes: pair(
    ({ x }) =>
      `M${x(48)} 117C${x(54)} 119 ${x(55)} 125 ${x(52)} 133` +
      `L${x(44)} 153C${x(41)} 160 ${x(36)} 161 ${x(32)} 158` +
      `C${x(29)} 155 ${x(30)} 150 ${x(32)} 144L${x(39)} 123` +
      `C${x(41)} 118 ${x(44)} 116 ${x(48)} 117Z`,
  ),
  tiles: tilePair([14, 126, 56, 196]),
};
const CALVES: BodyZone = {
  muscle: 'calves',
  shapes: pair(
    ({ x }) =>
      `M${x(98)} 232C${x(104)} 233 ${x(106)} 240 ${x(105)} 248` +
      `C${x(104)} 258 ${x(102)} 268 ${x(100)} 274` +
      `C${x(98)} 280 ${x(92)} 280 ${x(89)} 276` +
      `C${x(86)} 272 ${x(87)} 266 ${x(88)} 259L${x(90)} 242` +
      `C${x(91)} 235 ${x(94)} 231 ${x(98)} 232Z`,
  ),
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
      shapes: pair(
        ({ x }) =>
          `M${x(98)} 75C${x(90)} 73 ${x(82)} 79 ${x(81)} 87` +
          `C${x(80)} 96 ${x(88)} 101 ${x(98)} 101` +
          `C${x(104)} 97 ${x(105)} 83 ${x(98)} 75Z`,
      ),
      tiles: [tile([84, 54, 136, 104])],
    },
    {
      muscle: 'biceps',
      shapes: pair(
        ({ x }) =>
          `M${x(63)} 74C${x(57)} 74 ${x(51)} 78 ${x(49)} 85` +
          `C${x(46)} 93 ${x(48)} 102 ${x(53)} 107` +
          `C${x(57)} 110 ${x(62)} 107 ${x(65)} 101` +
          `C${x(69)} 92 ${x(69)} 81 ${x(63)} 74Z`,
      ),
      tiles: tilePair([30, 90, 84, 126]),
    },
    {
      muscle: 'abdominals',
      shapes: [
        `M${sx(98)} 105C${sx(92)} 105 ${sx(90)} 111 ${sx(91)} 119` +
          `L${sx(93)} 140C${sx(94)} 147 ${sx(101)} 151 ${AXIS} 151` +
          `C${sx(119)} 151 ${sx(126)} 147 ${sx(127)} 140L${sx(129)} 119` +
          `C${sx(130)} 111 ${sx(128)} 105 ${sx(122)} 105Z`,
      ],
      tiles: [tile([84, 104, 136, 170])],
    },
    FOREARMS,
    {
      muscle: 'quadriceps',
      shapes: pair(
        ({ x }) =>
          `M${x(97)} 171C${x(89)} 169 ${x(83)} 175 ${x(82)} 185` +
          `C${x(81)} 198 ${x(84)} 214 ${x(88)} 224` +
          `C${x(91)} 230 ${x(98)} 229 ${x(101)} 223` +
          `C${x(105)} 212 ${x(105)} 181 ${x(97)} 171Z`,
      ),
      tiles: tilePair([56, 170, 98, 234]),
    },
    {
      muscle: 'adductors',
      shapes: pair(
        ({ x }) =>
          `M${x(106)} 180C${x(110)} 181 ${x(111)} 187 ${x(110)} 195` +
          `L${x(109)} 211C${x(108)} 217 ${x(104)} 219 ${x(101)} 215` +
          `C${x(99)} 211 ${x(100)} 190 ${x(102)} 184C${x(103)} 181 ${x(104)} 180 ${x(106)} 180Z`,
      ),
      tiles: [tile([98, 170, 122, 234])],
    },
    CALVES,
  ],
  back: [
    {
      muscle: 'traps',
      shapes: [
        `M${AXIS} 50C${sx(124)} 54 ${sx(135)} 59 ${sx(137)} 67` +
          `C${sx(132)} 77 ${sx(122)} 86 ${AXIS} 96` +
          `C${sx(98)} 86 ${sx(88)} 77 ${sx(83)} 67` +
          `C${sx(85)} 59 ${sx(96)} 54 ${AXIS} 50Z`,
      ],
      tiles: [tile([84, 36, 136, 92])],
    },
    SHOULDERS,
    {
      muscle: 'triceps',
      shapes: pair(
        ({ x }) =>
          `M${x(63)} 74C${x(57)} 73 ${x(50)} 78 ${x(48)} 86` +
          `C${x(46)} 95 ${x(49)} 103 ${x(54)} 107` +
          `C${x(58)} 110 ${x(63)} 105 ${x(66)} 98` +
          `C${x(69)} 89 ${x(68)} 79 ${x(63)} 74Z`,
      ),
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
      shapes: [
        `M${sx(103)} 101C${sx(100)} 101 ${sx(99)} 105 ${sx(99)} 111` +
          `L${sx(100)} 125C${sx(101)} 131 ${sx(106)} 133 ${AXIS} 133` +
          `C${sx(114)} 133 ${sx(119)} 131 ${sx(120)} 125L${sx(121)} 111` +
          `C${sx(121)} 105 ${sx(120)} 101 ${sx(117)} 101Z`,
      ],
      tiles: [tile([98, 92, 122, 134])],
    },
    {
      muscle: 'lower_back',
      shapes: [
        `M${sx(96)} 138C${sx(102)} 135 ${sx(118)} 135 ${sx(124)} 138` +
          `C${sx(128)} 140 ${sx(130)} 146 ${sx(127)} 152` +
          `C${sx(124)} 158 ${sx(116)} 161 ${AXIS} 161` +
          `C${sx(104)} 161 ${sx(96)} 158 ${sx(93)} 152` +
          `C${sx(90)} 146 ${sx(92)} 140 ${sx(96)} 138Z`,
      ],
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
      shapes: pair(
        ({ x }) =>
          `M${x(97)} 201C${x(90)} 200 ${x(84)} 205 ${x(83)} 213` +
          `C${x(82)} 221 ${x(86)} 229 ${x(91)} 232` +
          `C${x(97)} 235 ${x(102)} 231 ${x(104)} 224` +
          `C${x(106)} 216 ${x(104)} 205 ${x(97)} 201Z`,
      ),
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
