/**
 * Ilustrações dos exercícios (Everkinetic, CC BY-SA 4.0). Os originais (SVG e PNG) ficam sem modificação em
 * `assets-third-party/everkinetic/`; o app publica a versão adaptada de todos (WebP leve de 536x550, mesmo recorte
 * nas duas poses, em `assets-derived/everkinetic/`, com aviso próprio das mudanças). Cada exercício do catálogo que tem um equivalente SEGURO (mesmo movimento
 * e mesmo equipamento) aponta para o par de poses; o que não está aqui não mostra imagem nenhuma. Na dúvida, fica
 * de fora: nunca se usa a figura de outro exercício.
 */

/** Uma ilustração de dois quadros: a pose do início e a do fim do movimento. */
export interface ExerciseIllustrationEntry {
  /** Título do exercício na origem (em inglês), para o crédito. */
  readonly title: string;
  /** Nomes de arquivo (em `/exercise-art/`) da pose inicial e da final, sempre WebP. */
  readonly frames: readonly [string, string];
  /** Onde o arquivo original da primeira pose está na origem, no commit fixado. */
  readonly sourceUrl: string;
}

/** Commit do repositório de origem de onde os arquivos foram obtidos (o mesmo do NOTICE). */
export const EVERKINETIC_COMMIT = '446bb9a3d0c3beb6b84f7c9d77dfc8af707a2ab6';

/** Pasta pública (mesma origem) de onde o app serve os arquivos. */
export const EXERCISE_ART_BASE = '/exercise-art/';

function art(title: string, id: string): ExerciseIllustrationEntry {
  return {
    title,
    frames: [`${id}-relaxation.webp`, `${id}-tension.webp`],
    sourceUrl: `https://github.com/everkinetic/data/blob/${EVERKINETIC_COMMIT}/dist/svg/${id}-relaxation.svg`,
  };
}

/**
 * Alguns exercícios só têm o par original em PNG no repositório da origem. A adaptação leve em WebP tem o nome do PNG
 * (recorte único do par, mesma proporção de todas as figuras); o crédito aponta para o PNG original.
 */
function pngArt(
  title: string,
  name: string,
  order: readonly [number, number] = [1, 2],
): ExerciseIllustrationEntry {
  const frames = order.map((pose) => `${name}-${pose}.webp`) as [string, string];
  return {
    title,
    frames,
    sourceUrl: `https://github.com/everkinetic/data/blob/${EVERKINETIC_COMMIT}/src/images-web/${name}-${order[0]}.png`,
  };
}

/** `slug` do catálogo -> ilustração. Um par de arquivos por exercício, nunca repetido. */
export const EXERCISE_ILLUSTRATIONS: Readonly<Record<string, ExerciseIllustrationEntry>> = {
  'abdominal-com-pernas-na-bola': art('Crunches with Legs on Stability Ball', '0290'),
  'abdominal-crunch': art('Crunches', '0291'),
  'abdominal-cruzado': art('Cross Body Crunch', '0289'),
  'abdominal-declinado': art('Decline Crunch', '0292'),
  'bicicleta-no-ar': art('Air Bike', '0284'),
  'elevacao-de-pernas-deitado-no-banco': art('Flat Bench Leg Raises', '0021'),
  'elevacao-de-quadril-com-joelhos-dobrados': art('Bent Knee Hip Raise', '0287'),
  'flexao-lateral-com-halter': art('Side Bend with Dumbbell', '0294'),
  'rollout-com-barra': art('Ab Rollout with Barbell', '0285'),
  'cadeira-abdutora': art('Thigh Abductor', '0156'),
  'cadeira-adutora': art('Thigh Adductor', '0157'),
  'rosca-alternada-com-halteres': art('Alternating Bicep Curl with Dumbbell', '0223'),
  'rosca-biceps-na-polia-alta': art('Overhead Curl with Cable', '0238'),
  'rosca-concentrada': art('Concentration Curls with Dumbbell', '0220'),
  'rosca-direta-com-barra': art('Biceps Curls with Barbell', '0211'),
  'rosca-direta-com-barra-w': art('EZ Bar Curl with Barbell', '0226'),
  'rosca-direta-com-halteres': art('Biceps Curl with Dumbbell', '0224'),
  'rosca-direta-na-polia': art('Standing Biceps Curl with Cable', '0212'),
  'rosca-direta-pegada-aberta-com-barra': art(
    'Wide Grip Standing Biceps Curl with Barbell',
    '0250',
  ),
  'rosca-martelo-alternada-com-halteres': art('Alternating Hammer Curl with Dumbbell', '0213'),
  'rosca-martelo-com-halteres': art('Biceps Hammer Curl with Dumbbell', '0227'),
  'rosca-martelo-cruzada-com-halteres': art('Cross Body Hammer Curl with Dumbbell', '0221'),
  'rosca-martelo-na-polia-com-corda': art('Hammer Curls with Rope and Cable', '0216'),
  'rosca-na-maquina': art('Bicep Curl with Machine', '0253'),
  'rosca-pegada-fechada-com-barra-w': art('Close Grip EZ Bar Curl with Barbell', '0218'),
  'rosca-scott-com-barra': art('Preacher Curl with Barbell', '0239'),
  'rosca-scott-com-halteres': art('Two-Arm Preacher Curl with Dumbbell', '0249'),
  'rosca-scott-na-maquina': art('Preacher Curl with Machine', '0236'),
  'rosca-unilateral-na-polia': art('Standing One Arm Bicep Curl with Cable', '0247'),
  'rosca-zottman': art('Zottman Curl with Dumbbells', '0251'),
  'panturrilha-em-pe-com-barra': art('Standing Barbell Calf Raise', '0281'),
  'panturrilha-em-pe-na-maquina': art('Standing Calf Raises using Machine', '0282'),
  'panturrilha-na-prensa-de-pernas': art('Calves Press on Leg Machine', '0273'),
  'panturrilha-sentado-com-barra': art('Seated Calf Raise with Barbell', '0272'),
  'panturrilha-sentado-na-maquina': art('Seated Calf Raise using Machine', '0279'),
  'panturrilha-sentado-unilateral-com-halter': art(
    'Seated One Leg Calf Raise with Dumbbell',
    '0276',
  ),
  'crossover-na-polia': art('Cable Crossover', '0048'),
  'crucifixo-declinado-com-halteres': art("Decline Dumbbell Fly's", '0053'),
  'crucifixo-inclinado-com-halteres': art("Incline Dumbbell Fly's", '0062'),
  'crucifixo-inclinado-na-polia': art("Incline Cable Fly's", '0060'),
  'crucifixo-reto-com-halteres': art('Dumbbell Flys', '0056'),
  'crucifixo-reto-na-polia': art('Flat Bench Cable Flys', '0057'),
  'crucifixo-unilateral-com-halter': art('One Arm Flat Bench Fly\u2019s', '0071'),
  'crucifixo-na-maquina-voador': pngArt('Butterfly Machine', 'butterfly-machine'),
  'supino-inclinado-articulado-na-maquina': pngArt('Incline Chest Press', 'incline-chest-press'),
  'flexao-de-bracos': art('Push Ups', '0077'),
  'flexao-de-bracos-fechada': art('Close Triceps Pushup', '0188'),
  'paralelas-para-peito': art('Chest Dips', '0054'),
  'pullover-com-halter-bracos-estendidos': art('Straight Arm Dumbbell Pullover', '0079'),
  'pullover-com-halter-bracos-flexionados': art('Dumbbell Bent Arm Pullover', '0046'),
  'pullover-com-barra': art('Bent Arm Pullover', '0045'),
  'supino-declinado-com-barra': art('Decline Barbell Bench Press', '0051'),
  'supino-declinado-com-halteres': art('Decline Dumbbell Bench Press', '0052'),
  'supino-inclinado-com-barra': art('Incline Bench Press', '0043'),
  'supino-inclinado-com-halteres': art('Incline Dumbbell Press', '0080'),
  'supino-inclinado-com-halteres-pegada-neutra': art('Hammer Grip Incline Bench Press', '0059'),
  'supino-inclinado-no-smith': art('Smith Machine Incline Bench Press', '0081'),
  'supino-na-maquina': art('Machine Bench Press', '0066'),
  'supino-reto-com-barra': art('Bench Press', '0042'),
  'supino-reto-com-barra-pegada-aberta': art('Wide Grip Bench Press', '0082'),
  'supino-reto-com-halteres': art('Bench Press Dumbbell', '0055'),
  'supino-reto-no-smith': art('Smith Machine Bench Press', '0078'),
  'supino-reto-unilateral-com-halter': art('One Arm Bench Press', '0068'),
  'supino-fechado-com-barra': art('Close Grip Barbell Bench Press', '0049'),
  'supino-fechado-no-smith': art('Smith Machine Close Grip Bench Press', '0195'),
  'supino-jm-com-barra': art('JM Press', '0175'),
  'coice-de-gluteo-na-polia': art('One Legged Cable Kickback', '0112'),
  'cadeira-flexora': art('Seated Leg Curl', '0119'),
  'flexora-em-pe-na-maquina': art('Standing Leg Curls', '0120'),
  'mesa-flexora': art('Lying Leg Curl Machine', '0117'),
  'levantamento-terra-romeno-com-barra': art('Romanian Dead Lift', '0118'),
  'good-morning-com-barra': art('Barbell Good Mornings', '0101'),
  'hiperextensao-lombar-no-banco': art('Hyperextensions', '0103'),
  'levantamento-terra-com-barra': art('Barbell Dead Lifts', '0099'),
  'barra-fixa': art('Pull Ups', '0087'),
  'puxada-com-triangulo-na-polia': art('V Bar Pull Down', '0096'),
  'puxada-com-bracos-estendidos-na-polia': art('Straight Arm Push Down', '0092'),
  'puxada-supinada-na-polia': art('Underhand Pull downs', '0093'),
  // Na origem, a pose com braços estendidos é a segunda imagem.
  'puxada-aberta-na-polia': pngArt('Wide Grip Lat Pull Down', 'wide-grip-lat-pull-down', [2, 1]),
  'remada-sentada-na-polia': art('Seated Cable Rows', '0025'),
  'remada-curvada-supinada-com-barra': art('Reverse Grips Bent Over Barbell Rows', '0026'),
  'remada-curvada-para-ombro-posterior-com-barra': art('Rear Deltoid Row Barbell', '0028'),
  'remada-alta-no-smith': art('Smith Machine Upright Row', '0013'),
  'remada-alta-com-barra': art('Upright Barbell Rows', '0014'),
  'remada-alta-na-polia': art('Upright Cable Row', '0015'),
  'remada-alta-com-halteres': art('Dumbbell Upright Rows', '0016'),
  'remada-alta-unilateral-com-halter': art('One Arm Upright Row', '0039'),
  'agachamento-com-base-estreita-com-barra': art('Narrow Stance Squat with Barbell', '0146'),
  'agachamento-com-base-larga-com-barra': art('Wide Stance Squat with Barbell', '0160'),
  'agachamento-com-halteres': art('Squats using Dumbbells', '0130'),
  'agachamento-com-halteres-ate-o-banco': art('Squat to Bench with Dumbbells', '0136'),
  'agachamento-frontal-com-barra': art('Front Squat with Barbell', '0138'),
  'agachamento-hack-com-base-estreita-na-maquina': art('Narrow Stance Hack Squats', '0145'),
  'agachamento-livre-com-barra': art('Barbell Squat', '0122'),
  'agachamento-no-smith': art('Smith Machine Squats', '0124'),
  'agachamento-plie-com-halter': art('Pile Squat with Dumbbell', '0152'),
  'avanco-com-barra': art('Barbell Lunges', '0114'),
  'avanco-com-halteres': art('Dumbbell Lunges', '0115'),
  'avanco-para-tras-com-halteres': art('Rear Lunges with Dumbbell', '0129'),
  'cadeira-extensora': art('Leg Extensions', '0142'),
  'prensa-de-pernas-com-pes-proximos': art('Narrow Stance Leg Press', '0143'),
  'prensa-de-pernas-na-maquina': art('Leg Press', '0127'),
  'subida-no-banco-com-barra': art('Step Ups with Barbell', '0134'),
  'subida-no-banco-com-halteres': art('Step Ups with Dumbbells', '0137'),
  'crucifixo-inverso-com-a-testa-apoiada-no-banco': art(
    'Bent Over Rear Deltoid Raise With Head On Bench',
    '0032',
  ),
  'desenvolvimento-militar-sentado-com-barra': art('Seated Military Press', '0004'),
  'desenvolvimento-com-halteres': pngArt('Dumbbell Shoulder Press', 'dumbbell-shoulder-press'),
  'desenvolvimento-arnold': pngArt('Arnold Press', 'arnold-press'),
  'desenvolvimento-na-maquina': pngArt(
    'Seated Shoulder Press Machine',
    'seated-shoulder-press-machine',
  ),
  'desenvolvimento-sentado-com-barra': pngArt(
    'Seated Barbell Shoulder Press',
    'barbell-shoulder-press',
  ),
  // Na origem, a pose com a barra baixa, junto às coxas, é a segunda imagem.
  'elevacao-frontal-com-barra': pngArt('Front Barbell Raises', 'front-barbell-raises', [2, 1]),
  'desenvolvimento-unilateral-com-halter': art('One Arm Dumbbell Shoulder Press', '0038'),
  'elevacao-frontal-com-halteres': art('Front Dumbbell Raise', '0033'),
  'elevacao-frontal-na-polia': art('Front Cable Raises', '0008'),
  'elevacao-lateral-com-halteres': art('Lateral Dumbbell Raises', '0018'),
  'encolhimento-com-barra': art('Barbell Shrugs', '0030'),
  'encolhimento-com-halteres': art('Shoulder Shrugs', '0005'),
  'encolhimento-na-polia': art('Cable Shoulder Shrugs', '0009'),
  'coice-com-dois-halteres': art('Bent-Over Two Arm Triceps Extension with Dumbbell', '0197'),
  'coice-com-halter': art('Triceps Kickback with Dumbbell', '0204'),
  'mergulho-no-banco': art('Bench Dips', '0162'),
  'paralelas-na-maquina': art('Tricep Dips using Machine', '0171'),
  'paralelas-para-triceps': art('Tricep Dips using Body Weight', '0172'),
  'triceps-frances-em-pe-com-barra': art(
    'Standing Overhead Triceps Extension with Barbell',
    '0201',
  ),
  'triceps-frances-sentado-com-halter': art('Seated Triceps Press with Dumbbell', '0194'),
  'triceps-na-maquina': art('Triceps Extensions using Machine', '0210'),
  'triceps-na-polia-com-barra-reta': art('Triceps Pushdown with Cable', '0205'),
  'triceps-na-polia-com-barra-v': art('Triceps Pushdown with V Bar and Cable', '0207'),
  'triceps-na-polia-com-corda': art('Triceps Pushdown with Rope and Cable', '0206'),
  'triceps-na-polia-com-pegada-supinada': art('Reverse Grip Triceps Pushdown', '0189'),
  'triceps-testa-atras-da-cabeca-com-barra': art(
    'Lying Close-Grip Triceps Extension Behind the Head with Barbell',
    '0179',
  ),
  'triceps-testa-com-halteres': art('Lying Triceps Extension with Dumbbells', '0181'),
  'triceps-testa-declinado-com-barra-w': art(
    'Decline EZ Bar Triceps Extension with Barbell',
    '0170',
  ),
  'triceps-testa-na-polia': art('Lying Tricep Extension with Cable', '0165'),
  'triceps-unilateral-na-polia': art('One Arm Tricep Extension with Cable', '0166'),
  // Completados depois, com o mesmo critério (movimento e equipamento iguais; na dúvida, fora).
  'prancha-lateral': art('Side Plank', '0113'),
  'agachamento-hack-na-maquina': art('Hack Squat Machine', '0123'),
  'agachamento-no-caixote-com-barra': art('Squat to Bench with Barbell', '0133'),
  'flexao-de-bracos-declinada': art('Push Up with Feet Elevated', '0075'),
  'supino-declinado-articulado-na-maquina': art('Decline Chest Press', '0085'),
  // Na origem a barra é reta; no catálogo, W. O movimento e o banco são os mesmos.
  'rosca-aranha-com-barra-w': art('Spider Curl with Barbell', '0245'),
  'ponte-de-gluteos-com-peso-do-corpo': art('Bridging', '0109'),
  'barra-fixa-supinada': pngArt('Chin Ups', 'chin-ups'),
  'puxada-de-bracos-estendidos-no-banco-inclinado-na-polia': art(
    'Incline Pushdown with Cable',
    '0163',
  ),
  'remada-cavalinho-com-barra-e-pegador': art('T-Bar Rows', '0029'),
  'remada-invertida': art('Body Row', '0086'),
  // Idem: barra reta na origem, W no catálogo.
  'triceps-testa-com-barra-w': art('Lying Triceps Press with Barbell', '0183'),
  'triceps-frances-unilateral-com-halter': pngArt(
    'Standing One Arm Triceps Extension with Dumbbell',
    'standing-one-arm-triceps-extension-with-dumbbell',
  ),
  'elevacao-de-perna-para-tras-em-pe': art('Body Leg Lifts', '0111'),
};

/** A ilustração do exercício, ou `undefined` quando não há uma segura. */
export function illustrationFor(slug: string): ExerciseIllustrationEntry | undefined {
  return Object.hasOwn(EXERCISE_ILLUSTRATIONS, slug) ? EXERCISE_ILLUSTRATIONS[slug] : undefined;
}

/** Endereço (mesma origem) de um quadro. */
export function illustrationUrl(file: string): string {
  return `${EXERCISE_ART_BASE}${file}`;
}
