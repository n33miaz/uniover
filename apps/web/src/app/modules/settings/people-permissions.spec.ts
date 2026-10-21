import {
  CATALOG,
  TRAINING_ONLY,
  TV_ACTIONS,
  TV_CONTROL_ONLY,
  applyModel,
  hasModule,
  modelLabel,
  modelOf,
  normalizePermissions,
  permissionOptionLabel,
  permissionSummary,
  samePermissions,
  togglePermission,
} from './people-permissions';

describe('people permissions', () => {
  describe('the catalog and the ready-made models', () => {
    it('keeps the order the API sends them in', () => {
      expect(CATALOG).toEqual([
        'module:tv',
        'tv:control',
        'tv:power',
        'tv:launch',
        'tv:edit-shortcuts',
        'tv:history',
        'module:training',
      ]);
    });

    it('"only control the TV" is what the API grants an invite without a list: the whole TV but editing shortcuts', () => {
      expect(TV_CONTROL_ONLY).toEqual([
        'module:tv',
        'tv:control',
        'tv:power',
        'tv:launch',
        'tv:history',
      ]);
      expect(TV_CONTROL_ONLY).not.toContain('tv:edit-shortcuts');
      expect(TV_CONTROL_ONLY).not.toContain('module:training');
    });

    it('"only the Training" is the module and nothing of the TV', () => {
      expect(TRAINING_ONLY).toEqual(['module:training']);
    });
  });

  describe('toggling a switch', () => {
    it('turning on any TV action also turns on "see the TV"', () => {
      for (const action of TV_ACTIONS) {
        expect(togglePermission([], action, true)).toEqual(['module:tv', action]);
      }
    });

    it('turning on "see the TV" alone grants only the module', () => {
      expect(togglePermission([], 'module:tv', true)).toEqual(['module:tv']);
    });

    it('turning off "see the TV" turns off every TV action and leaves the Training alone', () => {
      expect(togglePermission([...TV_CONTROL_ONLY, 'module:training'], 'module:tv', false)).toEqual(
        ['module:training'],
      );
    });

    it('turning off one TV action keeps the module and the others', () => {
      expect(togglePermission(TV_CONTROL_ONLY, 'tv:power', false)).toEqual([
        'module:tv',
        'tv:control',
        'tv:launch',
        'tv:history',
      ]);
    });

    it('always answers in the catalog order, whatever order things were turned on', () => {
      const first = togglePermission([], 'tv:history', true);
      const second = togglePermission(first, 'module:training', true);
      expect(togglePermission(second, 'tv:control', true)).toEqual([
        'module:tv',
        'tv:control',
        'tv:history',
        'module:training',
      ]);
    });

    it('never refuses a flip: turning the last module off leaves an empty list', () => {
      expect(togglePermission(['module:training'], 'module:training', false)).toEqual([]);
    });
  });

  describe('comparing and recognizing', () => {
    it('compares lists without looking at the order or at repeats', () => {
      expect(samePermissions(['tv:power', 'module:tv'], ['module:tv', 'tv:power'])).toBe(true);
      expect(samePermissions(['module:tv', 'module:tv'], ['module:tv'])).toBe(true);
      expect(samePermissions(['module:tv'], ['module:tv', 'tv:power'])).toBe(false);
      expect(samePermissions([], [])).toBe(true);
    });

    it('needs at least one module to give any access', () => {
      expect(hasModule([])).toBe(false);
      expect(hasModule(['tv:control'])).toBe(false);
      expect(hasModule(['module:tv'])).toBe(true);
      expect(hasModule(['module:training'])).toBe(true);
    });

    it('names the model a list matches, and calls anything else custom', () => {
      expect(modelOf(TV_CONTROL_ONLY)).toBe('tv-control');
      expect(modelOf([...TV_CONTROL_ONLY].reverse())).toBe('tv-control');
      expect(modelOf(['module:training'])).toBe('training');
      expect(modelOf([...TV_CONTROL_ONLY, 'tv:edit-shortcuts'])).toBe('custom');
      expect(modelOf([...TV_CONTROL_ONLY, 'module:training'])).toBe('custom');
      expect(modelOf([])).toBe('custom');
    });

    it('does not let a permission the screen cannot name hide the model', () => {
      expect(modelOf([...TV_CONTROL_ONLY, 'module:audit'])).toBe('tv-control');
    });
  });

  describe('applying a model', () => {
    it('replaces what the screen knows with the model', () => {
      expect(applyModel(['module:training'], 'tv-control')).toEqual(TV_CONTROL_ONLY);
      expect(applyModel(TV_CONTROL_ONLY, 'training')).toEqual(TRAINING_ONLY);
    });

    it('keeps a permission the screen cannot name, so editing never takes it away by accident', () => {
      expect(applyModel(['module:training', 'module:audit'], 'tv-control')).toEqual([
        ...TV_CONTROL_ONLY,
        'module:audit',
      ]);
      expect(normalizePermissions(['module:audit', 'tv:power', 'module:tv'])).toEqual([
        'module:tv',
        'tv:power',
        'module:audit',
      ]);
    });
  });

  describe('the one-line summary, with the same phrases as the Profile', () => {
    it('summarizes the control-only model', () => {
      expect(permissionSummary(TV_CONTROL_ONLY)).toBe(
        'Controlar a TV · Desligar a TV · Abrir apps · Ver o histórico',
      );
    });

    it('summarizes the Training', () => {
      expect(permissionSummary(TRAINING_ONLY)).toBe('Usar o Treino');
    });

    it('says only "see the TV" when that is all there is', () => {
      expect(permissionSummary(['module:tv'])).toBe('Ver a TV');
    });

    it('lists the TV and the Training together', () => {
      expect(permissionSummary(['module:tv', 'tv:edit-shortcuts', 'module:training'])).toBe(
        'Editar atalhos · Usar o Treino',
      );
    });

    it('says what to do when nothing is on, instead of an empty line', () => {
      expect(permissionSummary([])).toContain('Ligue ao menos a TV ou o Treino');
    });

    it('never shows a technical identifier', () => {
      expect(permissionSummary([...CATALOG, 'module:audit'])).not.toMatch(/module:|tv:/);
    });
  });

  describe('the texts of the switches and the models', () => {
    it('gives every permission of the catalog a plain phrase', () => {
      for (const permission of CATALOG) {
        expect(permissionOptionLabel(permission)).not.toBe(permission);
        expect(permissionOptionLabel(permission)).not.toMatch(/:/);
      }
      expect(permissionOptionLabel('tv:control')).toBe('Usar o controle e o teclado');
      expect(permissionOptionLabel('tv:launch')).toBe('Abrir apps e atualizar a lista');
      expect(permissionOptionLabel('tv:edit-shortcuts')).toBe('Editar e reordenar atalhos');
    });

    it('names the three models', () => {
      expect(modelLabel('tv-control')).toBe('Só controlar a TV');
      expect(modelLabel('training')).toBe('Só o Treino');
      expect(modelLabel('custom')).toBe('Personalizado');
    });
  });
});
