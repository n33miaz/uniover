import {
  DEFAULT_STEP_KG,
  EQUIPMENT_IDS,
  MUSCLE_GROUP_IDS,
  MUSCLE_GROUP_OF,
  MUSCLE_IDS,
  RECORD_TYPES,
  effectiveStepKg,
  equipmentLabel,
  muscleGroupLabel,
  muscleGroupOf,
  muscleLabel,
  musclesOfGroup,
  recordTypeLabel,
} from './taxonomy';

describe('training taxonomy', () => {
  it('maps every muscle to a known group, and every group has at least one muscle', () => {
    expect(Object.keys(MUSCLE_GROUP_OF).sort()).toEqual([...MUSCLE_IDS].sort());
    for (const muscle of MUSCLE_IDS) {
      expect(MUSCLE_GROUP_IDS).toContain(MUSCLE_GROUP_OF[muscle]);
    }
    for (const group of MUSCLE_GROUP_IDS) {
      expect(musclesOfGroup(group).length).toBeGreaterThan(0);
    }
  });

  it('keeps the fixed muscle to group map', () => {
    expect(musclesOfGroup('back')).toEqual(['lats', 'lower_back', 'middle_back', 'traps']);
    expect(musclesOfGroup('shoulders')).toEqual(['neck', 'shoulders']);
    expect(musclesOfGroup('core')).toEqual(['abdominals']);
    expect(musclesOfGroup('nothing')).toEqual([]);
    expect(muscleGroupOf('triceps')).toBe('arms');
    expect(muscleGroupOf('unknown')).toBeUndefined();
  });

  it('has a default load step for every equipment', () => {
    expect(Object.keys(DEFAULT_STEP_KG).sort()).toEqual([...EQUIPMENT_IDS].sort());
    expect(DEFAULT_STEP_KG).toEqual({
      barbell: 2.5,
      dumbbell: 2,
      machine: 5,
      cable: 5,
      bodyweight: 0,
      other: 0,
    });
  });

  it('prefers the chosen step and falls back to the equipment one', () => {
    expect(effectiveStepKg({ stepKg: 1.25, equipment: 'barbell' })).toBe(1.25);
    expect(effectiveStepKg({ stepKg: 0, equipment: 'barbell' })).toBe(0);
    expect(effectiveStepKg({ stepKg: null, equipment: 'barbell' })).toBe(2.5);
    expect(effectiveStepKg({ stepKg: null, equipment: 'kettlebell' })).toBe(0);
  });

  it('gives every id a non-empty Portuguese label and echoes ids it does not know', () => {
    for (const id of MUSCLE_IDS) expect(muscleLabel(id)).not.toBe('');
    for (const id of MUSCLE_GROUP_IDS) expect(muscleGroupLabel(id)).not.toBe('');
    for (const id of EQUIPMENT_IDS) expect(equipmentLabel(id)).not.toBe('');
    for (const id of RECORD_TYPES) expect(recordTypeLabel(id)).not.toBe('');
    expect(muscleLabel('chest')).toBe('Peitoral');
    expect(muscleGroupLabel('chest')).toBe('Peito');
    expect(equipmentLabel('bodyweight')).toBe('Peso do corpo');
    expect(recordTypeLabel('time')).toBe('Tempo');
    expect(muscleLabel('future_muscle')).toBe('future_muscle');
    expect(equipmentLabel('future_gear')).toBe('future_gear');
  });
});
