import { TV_CAPABILITY, type TvShortcut, type TvState, type TvSummary } from './tv-types';

/**
 * Por que a lista de apps da TV não está à vista, do jeito que a tela consegue saber:
 * - `ready`: há apps instalados na lista;
 * - `loading`: a lista ainda não chegou (o esqueleto do store cuida disso);
 * - `pc-off`: o computador que controla a TV está fora do ar;
 * - `no-adb`: o computador conectou, mas não declarou o ADB (`tv.adb`), que é quem lista os apps de uma Android TV;
 * - `adb-permission`: o agente conta que a TV ainda não liberou o ADB (`missing`);
 * - `adb-pending`: o aviso de liberar está na tela da TV, esperando o aceite;
 * - `tv-off`: a TV não responde (desligada, ou o agente não tem sessão com ela);
 * - `empty`: nada disso, e a lista veio vazia (a TV ainda não informou os apps).
 */
export type AppsAvailability =
  'ready' | 'loading' | 'pc-off' | 'no-adb' | 'adb-permission' | 'adb-pending' | 'tv-off' | 'empty';

export interface AppsAvailabilityInput {
  readonly shortcuts: readonly TvShortcut[] | null;
  readonly state: TvState | null;
  readonly tv: TvSummary | null;
}

/**
 * O motivo mais útil para a pessoa, do mais fundo ao mais raso: sem computador nada adianta; sem ADB no computador,
 * pedir permissão à TV não adianta; sem permissão, pedir a lista não adianta. Uma lista com apps instalados vale
 * sempre (`ready`), mesmo com a TV desligada agora: são os apps que ela informou da última vez.
 */
export function appsAvailability({
  shortcuts,
  state,
  tv,
}: AppsAvailabilityInput): AppsAvailability {
  if (shortcuts?.some((item) => item.installed)) return 'ready';
  if (state && !state.agentOnline) return 'pc-off';
  if (shortcuts === null) return 'loading';
  // Só a Android TV lista apps pelo ADB; sem a lista de capacidades (agente fora, servidor antigo) não se presume falta.
  if (tv?.kind === 'android' && tv.online && tv.capabilities.length > 0) {
    if (!tv.capabilities.includes(TV_CAPABILITY.adb)) return 'no-adb';
  }
  if (state?.adbPermission === 'pending') return 'adb-pending';
  if (state?.adbPermission === 'missing') return 'adb-permission';
  if (state && (state.power === 'off' || state.connection === 'disconnected')) return 'tv-off';
  return 'empty';
}
