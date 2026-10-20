import { actionLabel } from './step-up-dialog';

describe('actionLabel', () => {
  it.each([
    ['devices.pair-approve', 'aprovar o pareamento de um aparelho'],
    ['identity.passkey-remove', 'remover uma passkey'],
    ['identity.guest-invite', 'criar um convite de convidado'],
    ['identity.password-change', 'trocar a senha'],
  ])('names %s in plain words', (action, text) => {
    expect(actionLabel(action)).toBe(text);
  });

  it('falls back to a generic sentence for an action it does not know', () => {
    expect(actionLabel('outra.coisa')).toBe('fazer uma ação protegida');
    expect(actionLabel(null)).toBe('fazer uma ação protegida');
  });
});
