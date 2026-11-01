import { ModuleDefinition } from '../../core/modules/module-registry';
import { PersonHome } from './people-api';
import { homeModuleTitles } from './people-home';

const module = (
  id: string,
  title: string,
  status: 'available' | 'soon' = 'available',
): ModuleDefinition => ({
  id,
  title,
  description: '',
  icon: 'tv',
  status,
  defaultSize: 'small',
});

const CATALOG = [
  module('tv', 'TV'),
  module('training', 'Treino'),
  module('health', 'Saúde e Eventos', 'soon'),
  module('pc', 'Controle do PC', 'soon'),
];

const custom = (...entries: [string, boolean][]): PersonHome => ({
  state: 'custom',
  entries: entries.map(([id, enabled]) => ({ id, enabled })),
});

describe('homeModuleTitles', () => {
  it('lists the enabled modules in the order the person chose', () => {
    const home = custom(['training', true], ['tv', true]);
    expect(homeModuleTitles(home, CATALOG, 'owner', null)).toEqual(['Treino', 'TV']);
  });

  it('drops what the person turned off', () => {
    const home = custom(['training', true], ['tv', false]);
    expect(homeModuleTitles(home, CATALOG, 'owner', null)).toEqual(['Treino']);
  });

  it('never lists a planned module, saved or not (it is always on the Início and says nothing about the choice)', () => {
    const home = custom(['health', true], ['tv', true]);
    expect(homeModuleTitles(home, CATALOG, 'owner', null)).toEqual(['TV', 'Treino']);
  });

  it('appends, at the end, a module the catalog gained after the person saved (the app turns it on by default)', () => {
    const home = custom(['training', true]);
    expect(homeModuleTitles(home, CATALOG, 'owner', null)).toEqual(['Treino', 'TV']);
  });

  it('does not bring back a module the person turned off just because it is missing from the enabled ones', () => {
    const home = custom(['tv', false], ['training', true]);
    expect(homeModuleTitles(home, CATALOG, 'owner', null)).toEqual(['Treino']);
  });

  it('ignores a saved id the catalog does not know any more', () => {
    const home = custom(['ghost', true], ['tv', true]);
    expect(homeModuleTitles(home, CATALOG, 'owner', null)).toEqual(['TV', 'Treino']);
  });

  it('shows a guest only what the permissions of that guest allow', () => {
    const home = custom(['tv', true], ['training', true]);
    expect(homeModuleTitles(home, CATALOG, 'guest', ['module:training'])).toEqual(['Treino']);
    expect(homeModuleTitles(home, CATALOG, 'guest', ['module:tv', 'tv:control'])).toEqual(['TV']);
  });

  it('shows nothing for a guest without any module permission', () => {
    expect(homeModuleTitles(custom(['tv', true]), CATALOG, 'guest', [])).toEqual([]);
  });

  it('gives the owner everything available when the permissions are unknown', () => {
    expect(
      homeModuleTitles(custom(['tv', true], ['training', true]), CATALOG, 'owner', null),
    ).toEqual(['TV', 'Treino']);
  });
});
