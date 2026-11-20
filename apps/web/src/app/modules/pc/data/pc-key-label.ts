import type { PcSystem } from '../../../core/modules/pc-availability';
import type { PcModifier } from './pc-types';

const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

export function systemKeyLabel(system?: PcSystem): string {
  if (system === 'macos') return '⌘';
  if (system === 'linux') return 'Super';
  return MODIFIER_LABEL.WIN;
}

export function modifierLabel(modifier: PcModifier, system?: PcSystem): string {
  return modifier === 'WIN' ? systemKeyLabel(system) : MODIFIER_LABEL[modifier];
}
