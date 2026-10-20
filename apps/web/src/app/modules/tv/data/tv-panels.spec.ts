import { TV_PANEL_PARAM, TV_PANEL_VALUES, panelFromParam } from './tv-panels';

describe('tv panels', () => {
  it('keeps the old address names as the parameter values', () => {
    expect(TV_PANEL_PARAM).toBe('painel');
    expect(TV_PANEL_VALUES).toEqual({ apps: 'apps', keyboard: 'teclado' });
  });

  it('reads a known value as its panel, and anything else as none', () => {
    expect(panelFromParam('apps')).toBe('apps');
    expect(panelFromParam('teclado')).toBe('keyboard');
    expect(panelFromParam('keyboard')).toBeNull();
    expect(panelFromParam('')).toBeNull();
    expect(panelFromParam(null)).toBeNull();
  });
});
