import {
  SIRI_HEADER,
  SIRI_PATH,
  SIRI_TOKEN_PLACEHOLDER,
  actionOfCode,
  appAction,
  bodyOf,
  endpointUrl,
  expiryOptions,
  fieldsOf,
  fixedActions,
  instructionsText,
} from './siri-model';

const TV = '11111111-1111-4111-8111-111111111111';
const APP = '22222222-2222-4222-8222-222222222222';

describe('siri model', () => {
  it('offers only what the API can do: no way to turn the TV on and never the power key', () => {
    const codes = fixedActions().map((action) => action.code);
    expect(codes).toEqual([
      'power_off',
      'volume_up',
      'volume_down',
      'mute',
      'key:HOME',
      'key:BACK',
      'key:OK',
      'key:UP',
      'key:DOWN',
      'key:LEFT',
      'key:RIGHT',
      'key:PLAY_PAUSE',
    ]);
    expect(codes).not.toContain('wake');
    expect(codes).not.toContain('key:POWER');
  });

  it('gives every action a phrase to say and a label, in the groups the screen shows', () => {
    for (const action of fixedActions()) {
      expect(action.label.length).toBeGreaterThan(0);
      expect(action.phrase.length).toBeGreaterThan(0);
    }
    expect(fixedActions().find((a) => a.code === 'key:HOME')?.phrase).toBe('Tecla Início da TV');
    expect(fixedActions().find((a) => a.code === 'power_off')?.group).toBe('power');
    expect(fixedActions().find((a) => a.code === 'mute')?.group).toBe('sound');
    expect(fixedActions().find((a) => a.code === 'key:OK')?.group).toBe('keys');
  });

  it('turns a stored code back into an action, naming the app from the TV list', () => {
    const names = new Map([[APP, 'Vídeo']]);
    expect(actionOfCode('volume_up', names)?.label).toBe('Aumentar o volume');
    expect(actionOfCode(`app:${APP}`, names)).toEqual(appAction(APP, 'Vídeo'));
    expect(actionOfCode(`app:${APP}`, names)?.phrase).toBe('Abrir Vídeo na TV');
    expect(actionOfCode(`app:${APP}`, new Map())?.label).toBe('App');
    expect(actionOfCode('wake', names)).toBeNull();
    expect(actionOfCode('algo estranho', names)).toBeNull();
  });

  it('builds the JSON fields the Shortcuts app needs, tv and action first', () => {
    expect(fieldsOf('power_off', TV)).toEqual([
      { name: 'tv', value: TV },
      { name: 'action', value: 'power_off' },
    ]);
    expect(fieldsOf('key:HOME', TV)).toEqual([
      { name: 'tv', value: TV },
      { name: 'action', value: 'key' },
      { name: 'key', value: 'HOME' },
    ]);
    expect(fieldsOf(`app:${APP}`, TV)).toEqual([
      { name: 'tv', value: TV },
      { name: 'action', value: 'app' },
      { name: 'app', value: APP },
    ]);
  });

  it('writes the body as one line of JSON with the same fields', () => {
    expect(JSON.parse(bodyOf('mute', TV))).toEqual({ tv: TV, action: 'mute' });
    expect(JSON.parse(bodyOf('key:BACK', TV))).toEqual({ tv: TV, action: 'key', key: 'BACK' });
  });

  it('builds the address from the origin of the app, with or without a trailing slash', () => {
    expect(endpointUrl('https://uniover.exemplo.com')).toBe(
      `https://uniover.exemplo.com${SIRI_PATH}`,
    );
    expect(endpointUrl('https://uniover.exemplo.com/')).toBe(
      `https://uniover.exemplo.com${SIRI_PATH}`,
    );
    expect(SIRI_PATH).toBe('/api/v1/shortcuts/tv');
  });

  it('writes the whole recipe as text, with the key when there is one and a marker when there is not', () => {
    const action = fixedActions().find((a) => a.code === 'volume_up')!;

    const withToken = instructionsText(action, 'https://uniover.exemplo.com', TV, 'atalho_abc');
    expect(withToken).toContain('Aumentar o volume da TV');
    expect(withToken).toContain('URL: https://uniover.exemplo.com/api/v1/shortcuts/tv');
    expect(withToken).toContain('Método: POST');
    expect(withToken).toContain(`${SIRI_HEADER} = atalho_abc`);
    expect(withToken).toContain(`tv = ${TV}`);
    expect(withToken).toContain('action = volume_up');

    const hidden = instructionsText(action, 'https://uniover.exemplo.com', TV, null);
    expect(hidden).toContain(`${SIRI_HEADER} = ${SIRI_TOKEN_PLACEHOLDER}`);
    expect(hidden).not.toContain('atalho_abc');
  });

  it('lists the expiries, starting with no deadline', () => {
    expect(expiryOptions().map((option) => option.days)).toEqual([null, 30, 90, 365]);
  });
});
