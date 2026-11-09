import type { PcKey } from './pc-types';

/** O maior número de slide que o campo aceita (três dígitos). */
export const MAX_SLIDE = 999;

/** O número digitado como slide (1 a `MAX_SLIDE`, só dígitos); `null` quando não vale. */
export function parseSlideNumber(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[0-9]{1,3}$/.test(trimmed)) return null;
  const slide = Number(trimmed);
  return slide >= 1 && slide <= MAX_SLIDE ? slide : null;
}

/**
 * As teclas que levam ao slide N no PowerPoint e nos leitores de PDF: os dígitos e o Enter. Os dígitos só a `pc.key.v2`
 * traz; quem chama confere `store.supportsKeyV2` antes.
 */
export function slideKeys(slide: number): readonly PcKey[] {
  return [...String(slide)].map((digit) => `D${digit}` as PcKey).concat('ENTER');
}
