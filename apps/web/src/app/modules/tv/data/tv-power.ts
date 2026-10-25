import { TvPowerOffOutcome } from './tv-types';

/**
 * O aviso do que o pedido de desligar fez. `off` e `already_off` vêm de um agente que confirma o que aconteceu; `sent` é
 * o agente que só entrega a tecla, e por isso o texto fala em pedido enviado, sem prometer que a TV desligou.
 */
export function powerOffNotice(outcome: TvPowerOffOutcome): string {
  switch (outcome) {
    case 'off':
      return $localize`:@@tv.power.off:TV desligada. Ela só volta com o controle original.`;
    case 'already_off':
      return $localize`:@@tv.power.already-off:A TV já estava desligada. Nenhuma tecla foi enviada.`;
    case 'sent':
      return $localize`:@@tv.power.sent:Pedido de desligar enviado. A TV só volta com o controle original.`;
  }
}
