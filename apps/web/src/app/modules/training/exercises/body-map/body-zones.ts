import type { MuscleId } from '../../domain/taxonomy';
import { MUSCLE_IDS } from '../../domain/taxonomy';
import { Rect, mirrorRect } from './body-shapes';

/** Desenho vetorial próprio. As curvas seguem uma silhueta contínua; as zonas são regiões estilizadas, sem precisão clínica. */
export type BodyFace = 'front' | 'back';
export const BODY_FACES: readonly BodyFace[] = ['front', 'back'];
export const BODY_WIDTH = 250;
export const BODY_HEIGHT = 300;

export interface BodyZone {
  readonly muscle: MuscleId;
  readonly shapes: readonly string[];
  readonly tiles: readonly Rect[];
}

/** Espelha os pontos, e não o elemento SVG: desenho e áreas de toque compartilham o mesmo sistema de coordenadas. */
const pair = (draw: (x: (value: number) => number) => string): string[] => [
  draw((value) => value),
  draw((value) => BODY_WIDTH - value),
];
const tilePair = (rect: Rect): Rect[] => [rect, mirrorRect(rect, BODY_WIDTH)];

export const BODY_OUTLINE: readonly string[] = [
  'M111 19C111 9 116 4 125 4C134 4 139 9 139 19L138 27C140 26 140 33 137 34C135 38 133 40 131 41L132 47L118 47L119 41C117 40 115 38 113 34C110 33 110 26 112 27Z',
  'M118 39C118 46 114 48 108 50C101 52 95 52 88 56L89 72C91 82 96 89 98 101C100 112 104 122 103 131C103 140 97 146 95 157C104 165 115 168 125 168C135 168 146 165 155 157C153 146 147 140 147 131C146 122 150 112 152 101C154 89 159 82 161 72L162 56C155 52 149 52 142 50C136 48 132 46 132 39Z',
  ...pair(
    (x) =>
      `M${x(92)} 53C${x(82)} 51 ${x(76)} 56 ${x(74)} 65` +
      `C${x(72)} 76 ${x(69)} 87 ${x(66)} 97C${x(64)} 104 ${x(63)} 111 ${x(60)} 117` +
      `C${x(54)} 128 ${x(51)} 141 ${x(47)} 153C${x(46)} 157 ${x(42)} 159 ${x(41)} 163` +
      `L${x(38)} 172C${x(37)} 175 ${x(39)} 176 ${x(41)} 174L${x(44)} 169` +
      `L${x(42)} 178C${x(42)} 181 ${x(46)} 182 ${x(48)} 179` +
      `C${x(51)} 176 ${x(54)} 172 ${x(55)} 167L${x(58)} 156` +
      `C${x(62)} 148 ${x(69)} 138 ${x(73)} 127C${x(76)} 120 ${x(75)} 114 ${x(78)} 108` +
      `C${x(83)} 98 ${x(89)} 89 ${x(92)} 79C${x(96)} 68 ${x(102)} 58 ${x(92)} 53Z`,
  ),
  ...pair(
    (x) =>
      `M${x(98)} 147C${x(91)} 160 ${x(93)} 179 ${x(97)} 194` +
      `C${x(99)} 204 ${x(102)} 212 ${x(101)} 221C${x(100)} 229 ${x(96)} 234 ${x(97)} 244` +
      `C${x(98)} 257 ${x(103)} 266 ${x(103)} 276C${x(103)} 281 ${x(99)} 284 ${x(96)} 287` +
      `C${x(94)} 290 ${x(96)} 292 ${x(100)} 292L${x(110)} 292` +
      `C${x(115)} 292 ${x(116)} 289 ${x(114)} 285C${x(111)} 279 ${x(112)} 273 ${x(114)} 265` +
      `C${x(116)} 256 ${x(121)} 245 ${x(119)} 234C${x(118)} 228 ${x(116)} 223 ${x(117)} 216` +
      `C${x(120)} 199 ${x(123)} 184 ${x(123)} 172L${x(125)} 159Z`,
  ),
];

const SHOULDERS: BodyZone = {
  muscle: 'shoulders',
  shapes: pair(
    (x) =>
      `M${x(91)} 55C${x(82)} 54 ${x(77)} 60 ${x(77)} 68C${x(77)} 72 ${x(76)} 76 ${x(75)} 80` +
      `C${x(82)} 79 ${x(88)} 74 ${x(93)} 69C${x(97)} 65 ${x(99)} 58 ${x(91)} 55Z`,
  ),
  tiles: tilePair([52, 38, 98, 80]),
};
const FOREARMS: BodyZone = {
  muscle: 'forearms',
  shapes: pair(
    (x) =>
      `M${x(65)} 119C${x(70)} 117 ${x(73)} 121 ${x(70)} 129` +
      `C${x(66)} 140 ${x(59)} 149 ${x(54)} 157L${x(50)} 155` +
      `C${x(54)} 143 ${x(55)} 131 ${x(61)} 123C${x(62)} 121 ${x(63)} 120 ${x(65)} 119Z`,
  ),
  tiles: tilePair([25, 118, 80, 175]),
};
const CALVES: BodyZone = {
  muscle: 'calves',
  shapes: pair(
    (x) =>
      `M${x(105)} 232C${x(100)} 235 ${x(100)} 245 ${x(103)} 253` +
      `C${x(106)} 261 ${x(106)} 266 ${x(107)} 271C${x(109)} 264 ${x(111)} 258 ${x(114)} 251` +
      `C${x(117)} 244 ${x(117)} 236 ${x(112)} 233C${x(110)} 231 ${x(107)} 230 ${x(105)} 232Z`,
  ),
  tiles: tilePair([82, 232, 125, 296]),
};
const upperArm = (): readonly string[] =>
  pair(
    (x) =>
      `M${x(77)} 82C${x(81)} 80 ${x(86)} 78 ${x(89)} 77` +
      `C${x(87)} 86 ${x(83)} 98 ${x(78)} 107C${x(76)} 112 ${x(72)} 114 ${x(70)} 111` +
      `C${x(68)} 107 ${x(70)} 100 ${x(72)} 94C${x(74)} 89 ${x(75)} 85 ${x(77)} 82Z`,
  );

/** As áreas invisíveis ampliam o toque sem disputar espaço. A lista completa oferece alvos de pelo menos 44 px. */
export const BODY_ZONES: Readonly<Record<BodyFace, readonly BodyZone[]>> = {
  front: [
    {
      muscle: 'neck',
      shapes: pair((x) => `M${x(119)} 41L${x(123)} 44L${x(124)} 52Q${x(119)} 50 ${x(116)} 50Z`),
      tiles: [[105, 24, 145, 52]],
    },
    SHOULDERS,
    {
      muscle: 'chest',
      shapes: pair(
        (x) =>
          `M${x(102)} 58C${x(110)} 57 ${x(118)} 59 ${x(123)} 62` +
          `L${x(123)} 84C${x(121)} 90 ${x(111)} 93 ${x(104)} 89` +
          `C${x(99)} 86 ${x(98)} 80 ${x(94)} 76C${x(98)} 72 ${x(100)} 64 ${x(102)} 58Z`,
      ),
      tiles: [[98, 52, 152, 94]],
    },
    { muscle: 'biceps', shapes: upperArm(), tiles: tilePair([38, 80, 98, 118]) },
    {
      muscle: 'abdominals',
      shapes: [
        ...pair(
          (x) =>
            `M${x(115)} 96Q${x(119)} 94 ${x(123)} 95L${x(123)} 105Q${x(118)} 107 ${x(113)} 104Z`,
        ),
        ...pair(
          (x) =>
            `M${x(113)} 108Q${x(118)} 110 ${x(123)} 108L${x(123)} 118Q${x(118)} 120 ${x(113)} 117Z`,
        ),
        ...pair(
          (x) =>
            `M${x(114)} 121Q${x(119)} 123 ${x(123)} 121L${x(123)} 140Q${x(116)} 136 ${x(114)} 129Z`,
        ),
        ...pair(
          (x) =>
            `M${x(102)} 94Q${x(106)} 96 ${x(110)} 97C${x(108)} 111 ${x(110)} 129 ${x(118)} 140` +
            `C${x(110)} 136 ${x(106)} 129 ${x(105)} 119Z`,
        ),
      ],
      tiles: [[98, 94, 152, 150]],
    },
    FOREARMS,
    {
      muscle: 'quadriceps',
      shapes: pair(
        (x) =>
          `M${x(100)} 154C${x(95)} 164 ${x(97)} 179 ${x(100)} 191` +
          `C${x(102)} 202 ${x(103)} 210 ${x(106)} 215C${x(108)} 218 ${x(112)} 215 ${x(114)} 210` +
          `C${x(117)} 202 ${x(118)} 193 ${x(117)} 184C${x(115)} 171 ${x(110)} 160 ${x(100)} 154Z`,
      ),
      tiles: [...tilePair([80, 150, 113, 175]), ...tilePair([70, 175, 113, 232])],
    },
    {
      muscle: 'adductors',
      shapes: pair(
        (x) =>
          `M${x(115)} 155C${x(118)} 157 ${x(122)} 162 ${x(123)} 168` +
          `C${x(122)} 181 ${x(120)} 192 ${x(117)} 201C${x(120)} 183 ${x(119)} 170 ${x(115)} 155Z`,
      ),
      tiles: [[113, 150, 137, 232]],
    },
    CALVES,
  ],
  back: [
    {
      muscle: 'traps',
      shapes: pair(
        (x) =>
          `M${x(119)} 43C${x(116)} 51 ${x(107)} 55 ${x(100)} 58` +
          `C${x(109)} 64 ${x(116)} 74 ${x(123)} 82L${x(123)} 48Z`,
      ),
      tiles: [[98, 38, 152, 85]],
    },
    SHOULDERS,
    { muscle: 'triceps', shapes: upperArm(), tiles: tilePair([38, 80, 80, 118]) },
    {
      muscle: 'lats',
      shapes: pair(
        (x) =>
          `M${x(96)} 78C${x(101)} 80 ${x(107)} 86 ${x(112)} 89` +
          `C${x(115)} 103 ${x(113)} 119 ${x(108)} 129C${x(103)} 121 ${x(101)} 110 ${x(100)} 101` +
          `C${x(100)} 92 ${x(98)} 85 ${x(96)} 78Z`,
      ),
      tiles: tilePair([80, 85, 113, 131]),
    },
    FOREARMS,
    {
      muscle: 'middle_back',
      shapes: pair(
        (x) =>
          `M${x(115)} 89Q${x(119)} 88 ${x(123)} 85L${x(123)} 127C${x(117)} 122 ${x(115)} 107 ${x(115)} 89Z`,
      ),
      tiles: [[113, 85, 137, 131]],
    },
    {
      muscle: 'lower_back',
      shapes: pair(
        (x) =>
          `M${x(114)} 128Q${x(118)} 131 ${x(123)} 132L${x(123)} 153C${x(118)} 150 ${x(112)} 150 ${x(108)} 148Q${x(109)} 136 ${x(114)} 128Z`,
      ),
      tiles: [[98, 131, 152, 161]],
    },
    {
      muscle: 'glutes',
      shapes: pair(
        (x) =>
          `M${x(109)} 154C${x(101)} 156 ${x(99)} 167 ${x(101)} 178` +
          `C${x(103)} 187 ${x(117)} 190 ${x(122)} 181C${x(124)} 176 ${x(123)} 166 ${x(123)} 160` +
          `C${x(119)} 157 ${x(114)} 155 ${x(109)} 154Z`,
      ),
      tiles: [[104, 161, 146, 194]],
    },
    {
      muscle: 'abductors',
      shapes: pair(
        (x) =>
          `M${x(101)} 157C${x(97)} 163 ${x(96)} 177 ${x(99)} 187C${x(100)} 182 ${x(99)} 173 ${x(101)} 167Q${x(103)} 160 ${x(101)} 157Z`,
      ),
      tiles: tilePair([80, 161, 104, 194]),
    },
    {
      muscle: 'hamstrings',
      shapes: pair(
        (x) =>
          `M${x(102)} 190C${x(108)} 193 ${x(115)} 193 ${x(120)} 187` +
          `C${x(119)} 198 ${x(115)} 208 ${x(114)} 216C${x(113)} 220 ${x(110)} 224 ${x(108)} 223` +
          `C${x(106)} 221 ${x(106)} 213 ${x(105)} 208C${x(104)} 201 ${x(102)} 195 ${x(102)} 190Z`,
      ),
      tiles: tilePair([80, 194, 125, 232]),
    },
    CALVES,
  ],
};

/** Linhas leves de referência anatômica; não criam zonas nem interceptam o toque. */
export const BODY_DETAILS: Readonly<Record<BodyFace, readonly string[]>> = {
  front: [
    ...pair(
      (x) =>
        `M${x(118)} 53Q${x(109)} 52 ${x(102)} 55M${x(105)} 95L${x(110)} 99M${x(106)} 101L${x(110)} 105M${x(107)} 108L${x(110)} 111`,
    ),
    ...pair(
      (x) =>
        `M${x(100)} 146Q${x(108)} 145 ${x(121)} 154M${x(104)} 162C${x(108)} 180 ${x(111)} 195 ${x(108)} 208`,
    ),
    ...pair(
      (x) =>
        `M${x(104)} 220Q${x(109)} 217 ${x(114)} 220L${x(113)} 225Q${x(109)} 229 ${x(105)} 225Z`,
    ),
    ...pair(
      (x) =>
        `M${x(108)} 235Q${x(107)} 248 ${x(109)} 257M${x(104)} 274L${x(109)} 278M${x(49)} 159L${x(54)} 161M${x(46)} 166L${x(43)} 174`,
    ),
    'M125 94V136M124 144Q125 146 126 144',
  ],
  back: [
    ...pair(
      (x) =>
        `M${x(112)} 67C${x(103)} 66 ${x(99)} 72 ${x(103)} 79L${x(111)} 85M${x(116)} 95Q${x(120)} 108 ${x(120)} 119`,
    ),
    ...pair(
      (x) => `M${x(105)} 193Q${x(109)} 202 ${x(109)} 214M${x(105)} 226Q${x(109)} 228 ${x(114)} 225`,
    ),
    ...pair(
      (x) =>
        `M${x(108)} 233Q${x(110)} 240 ${x(109)} 249M${x(106)} 262L${x(107)} 278M${x(113)} 262L${x(111)} 278M${x(49)} 159L${x(54)} 161M${x(46)} 166L${x(43)} 174`,
    ),
    'M125 49V148M125 163V179',
  ],
};

/** As faces em que o músculo tem zona (a frente primeiro). */
export function facesOf(muscle: string): BodyFace[] {
  return BODY_FACES.filter((face) => BODY_ZONES[face].some((zone) => zone.muscle === muscle));
}

export function faceFor(muscle: string, current: BodyFace): BodyFace {
  const faces = facesOf(muscle);
  return faces.includes(current) || faces.length === 0 ? current : faces[0];
}

export const MUSCLES_WITHOUT_ZONE: readonly MuscleId[] = MUSCLE_IDS.filter(
  (muscle) => facesOf(muscle).length === 0,
);
