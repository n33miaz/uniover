import { actionLabel, actionTitle } from './step-up-dialog';

describe('actionLabel', () => {
  it.each([
    ['devices.pair-approve', 'aprovar o pareamento de um aparelho'],
    ['identity.passkey-remove', 'remover uma passkey'],
    ['identity.guest-invite', 'criar um convite de convidado'],
    ['identity.password-change', 'trocar a senha'],
    ['tv.bind-agent', 'ligar um computador à TV'],
    ['identity.permissions-change', 'mudar as permissões de uma pessoa'],
    ['identity.qr-login-approve', 'liberar a entrada de um computador'],
  ])('names %s in plain words', (action, text) => {
    expect(actionLabel(action)).toBe(text);
  });

  it('falls back to a generic sentence for an action it does not know', () => {
    expect(actionLabel('outra.coisa')).toBe('fazer uma ação protegida');
    expect(actionLabel(null)).toBe('fazer uma ação protegida');
  });
});

describe('actionTitle', () => {
  it('says what is being confirmed when permissions change', () => {
    expect(actionTitle('identity.permissions-change')).toBe('Confirmar a mudança de permissões');
  });

  it.each(['identity.passkey-remove', 'identity.guest-invite', 'outra.coisa', null])(
    'keeps the usual title for %s',
    (action) => {
      expect(actionTitle(action)).toBe('Confirmar com passkey');
    },
  );
});
