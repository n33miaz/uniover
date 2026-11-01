/**
 * Taxonomia do catálogo de exercícios: ids estáveis (os mesmos que a API devolve), o mapa de músculo para grupo, o
 * salto padrão de carga por equipamento e os rótulos em português. O id é dado; o rótulo é texto de tela e por isso
 * passa pelo i18n. Os conjuntos são fechados: um id novo na API precisa de uma linha aqui, e o teste acusa a falta.
 */

export const MUSCLE_IDS = [
  'abdominals',
  'abductors',
  'adductors',
  'biceps',
  'calves',
  'chest',
  'forearms',
  'glutes',
  'hamstrings',
  'lats',
  'lower_back',
  'middle_back',
  'neck',
  'quadriceps',
  'shoulders',
  'traps',
  'triceps',
] as const;
export type MuscleId = (typeof MUSCLE_IDS)[number];

export const MUSCLE_GROUP_IDS = ['chest', 'back', 'legs', 'shoulders', 'arms', 'core'] as const;
export type MuscleGroupId = (typeof MUSCLE_GROUP_IDS)[number];

export const EQUIPMENT_IDS = [
  'barbell',
  'dumbbell',
  'machine',
  'cable',
  'bodyweight',
  'kettlebell',
  'band',
  'cardio',
  'other',
] as const;
export type EquipmentId = (typeof EQUIPMENT_IDS)[number];

export const RECORD_TYPES = ['weight_reps', 'reps_only', 'time'] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Cada músculo pertence a exatamente um grupo (o do filtro da tela). O pescoço acompanha os ombros. */
export const MUSCLE_GROUP_OF: Readonly<Record<MuscleId, MuscleGroupId>> = {
  chest: 'chest',
  lats: 'back',
  middle_back: 'back',
  lower_back: 'back',
  traps: 'back',
  quadriceps: 'legs',
  hamstrings: 'legs',
  glutes: 'legs',
  calves: 'legs',
  adductors: 'legs',
  abductors: 'legs',
  shoulders: 'shoulders',
  neck: 'shoulders',
  biceps: 'arms',
  triceps: 'arms',
  forearms: 'arms',
  abdominals: 'core',
};

/**
 * Salto mínimo de carga (kg) quando o exercício não define o seu. São valores iniciais combinados, não de fonte:
 * variam por academia, e cada exercício pode sobrescrever o seu.
 */
export const DEFAULT_STEP_KG: Readonly<Record<EquipmentId, number>> = {
  barbell: 2.5,
  dumbbell: 2,
  machine: 5,
  cable: 5,
  bodyweight: 0,
  kettlebell: 4,
  band: 0,
  cardio: 0,
  other: 0,
};

function isIn<T extends string>(ids: readonly T[], value: string): value is T {
  return (ids as readonly string[]).includes(value);
}

export const isMuscleId = (value: string): value is MuscleId => isIn(MUSCLE_IDS, value);
export const isEquipmentId = (value: string): value is EquipmentId => isIn(EQUIPMENT_IDS, value);
export const isRecordType = (value: string): value is RecordType => isIn(RECORD_TYPES, value);
export const isMuscleGroupId = (value: string): value is MuscleGroupId =>
  isIn(MUSCLE_GROUP_IDS, value);

/** Grupo do músculo; `undefined` para um id que esta versão do app ainda não conhece. */
export function muscleGroupOf(muscle: string): MuscleGroupId | undefined {
  return isMuscleId(muscle) ? MUSCLE_GROUP_OF[muscle] : undefined;
}

/** Músculos de um grupo, na ordem da lista de músculos. */
export function musclesOfGroup(group: string): MuscleId[] {
  return MUSCLE_IDS.filter((muscle) => MUSCLE_GROUP_OF[muscle] === group);
}

/** Salto de carga que vale para o exercício: o escolhido, ou o do equipamento (0 para equipamento desconhecido). */
export function effectiveStepKg(exercise: {
  readonly stepKg: number | null;
  readonly equipment: string;
}): number {
  if (exercise.stepKg !== null) return exercise.stepKg;
  return isEquipmentId(exercise.equipment) ? DEFAULT_STEP_KG[exercise.equipment] : 0;
}

// Os rótulos são funções (e não textos) para o `$localize` rodar na hora do uso, com o idioma já definido.
const MUSCLE_LABELS: Readonly<Record<MuscleId, () => string>> = {
  abdominals: () => $localize`:@@training.muscle.abdominals:Abdômen`,
  abductors: () => $localize`:@@training.muscle.abductors:Abdutores`,
  adductors: () => $localize`:@@training.muscle.adductors:Adutores`,
  biceps: () => $localize`:@@training.muscle.biceps:Bíceps`,
  calves: () => $localize`:@@training.muscle.calves:Panturrilhas`,
  chest: () => $localize`:@@training.muscle.chest:Peitoral`,
  forearms: () => $localize`:@@training.muscle.forearms:Antebraços`,
  glutes: () => $localize`:@@training.muscle.glutes:Glúteos`,
  hamstrings: () => $localize`:@@training.muscle.hamstrings:Posteriores de coxa`,
  lats: () => $localize`:@@training.muscle.lats:Dorsais`,
  lower_back: () => $localize`:@@training.muscle.lowerBack:Lombar`,
  middle_back: () => $localize`:@@training.muscle.middleBack:Meio das costas`,
  neck: () => $localize`:@@training.muscle.neck:Pescoço`,
  quadriceps: () => $localize`:@@training.muscle.quadriceps:Quadríceps`,
  shoulders: () => $localize`:@@training.muscle.shoulders:Ombros`,
  traps: () => $localize`:@@training.muscle.traps:Trapézio`,
  triceps: () => $localize`:@@training.muscle.triceps:Tríceps`,
};

const GROUP_LABELS: Readonly<Record<MuscleGroupId, () => string>> = {
  chest: () => $localize`:@@training.group.chest:Peito`,
  back: () => $localize`:@@training.group.back:Costas`,
  legs: () => $localize`:@@training.group.legs:Pernas`,
  shoulders: () => $localize`:@@training.group.shoulders:Ombros`,
  arms: () => $localize`:@@training.group.arms:Braços`,
  core: () => $localize`:@@training.group.core:Abdômen`,
};

const EQUIPMENT_LABELS: Readonly<Record<EquipmentId, () => string>> = {
  barbell: () => $localize`:@@training.equipment.barbell:Barra`,
  dumbbell: () => $localize`:@@training.equipment.dumbbell:Halteres`,
  machine: () => $localize`:@@training.equipment.machine:Máquina`,
  cable: () => $localize`:@@training.equipment.cable:Polia`,
  bodyweight: () => $localize`:@@training.equipment.bodyweight:Peso do corpo`,
  kettlebell: () => $localize`:@@training.equipment.kettlebell:Kettlebell`,
  band: () => $localize`:@@training.equipment.band:Elástico`,
  cardio: () => $localize`:@@training.equipment.cardio:Cardio`,
  other: () => $localize`:@@training.equipment.other:Outro`,
};

const RECORD_TYPE_LABELS: Readonly<Record<RecordType, () => string>> = {
  weight_reps: () => $localize`:@@training.recordType.weightReps:Carga e repetições`,
  reps_only: () => $localize`:@@training.recordType.repsOnly:Só repetições`,
  time: () => $localize`:@@training.recordType.time:Tempo`,
};

// Um id que o app ainda não conhece (a API pode ter crescido) aparece como veio, em vez de sumir ou quebrar a tela.
export function muscleLabel(id: string): string {
  return isMuscleId(id) ? MUSCLE_LABELS[id]() : id;
}

export function muscleGroupLabel(id: string): string {
  return isMuscleGroupId(id) ? GROUP_LABELS[id]() : id;
}

export function equipmentLabel(id: string): string {
  return isEquipmentId(id) ? EQUIPMENT_LABELS[id]() : id;
}

export function recordTypeLabel(id: string): string {
  return isRecordType(id) ? RECORD_TYPE_LABELS[id]() : id;
}
