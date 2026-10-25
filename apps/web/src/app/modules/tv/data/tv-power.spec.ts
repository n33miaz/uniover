import { powerOffNotice } from './tv-power';

describe('powerOffNotice', () => {
  it('says the TV is off only when the agent confirmed it', () => {
    expect(powerOffNotice('off')).toBe('TV desligada. Ela só volta com o controle original.');
  });

  it('says nothing was sent when the TV was already off', () => {
    expect(powerOffNotice('already_off')).toBe(
      'A TV já estava desligada. Nenhuma tecla foi enviada.',
    );
  });

  it('keeps the wording of before for an agent that does not confirm', () => {
    expect(powerOffNotice('sent')).toBe(
      'Pedido de desligar enviado. A TV só volta com o controle original.',
    );
  });
});
