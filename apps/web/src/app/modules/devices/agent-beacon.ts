import type { components } from '../../core/api/generated/schema';

type Dto = components['schemas']['AgentBeaconItem'];

/**
 * O último sinal que o próprio computador mandou antes de conectar (a baliza de partida) e o último handshake que a API
 * recusou para ele. Só pista: a baliza vem de uma rota anônima e nunca prova que o computador está ligado.
 */
export interface AgentBeacon {
  readonly agentId: string;
  readonly stage: string | null;
  readonly code: string | null;
  readonly at: string | null;
  readonly rejectReason: string | null;
  readonly rejectedAt: string | null;
}

export function readAgentBeacons(
  dto: { items?: readonly Dto[] } | null | undefined,
): AgentBeacon[] {
  if (!dto || !Array.isArray(dto.items)) return [];
  return dto.items.map((item) => ({
    agentId: item.agentId,
    stage: item.stage ?? null,
    code: item.code ?? null,
    at: item.at ?? null,
    rejectReason: item.rejectReason ?? null,
    rejectedAt: item.rejectedAt ?? null,
  }));
}

/** Uma linha de estado do computador: o texto, se é falha (forma e cor próprias) e quando aconteceu. */
export interface StartupLine {
  readonly text: string;
  readonly failed: boolean;
  readonly at: string;
  /** Veio do servidor com o agente autenticado (a recusa de protocolo): é a única pista que não vem de rota anônima. */
  readonly verified: boolean;
}

/** O que impediu a partida, em poucas palavras. Um código novo do agente cai no texto neutro. */
export function codeReason(code: string): string | null {
  switch (code) {
    case 'no_config':
      return $localize`:@@devices.startup.code.no-config:falta a configuração`;
    case 'vault_unreadable':
      return $localize`:@@devices.startup.code.vault:não leu a credencial guardada`;
    case 'net_unreachable':
      return $localize`:@@devices.startup.code.net:sem acesso à rede`;
    case 'crash_loop':
      return $localize`:@@devices.startup.code.crash-loop:o agente fecha ao abrir`;
    case 'blocked_sac':
      return $localize`:@@devices.startup.code.blocked-sac:o Windows bloqueou o programa`;
    case 'blocked_av':
      return $localize`:@@devices.startup.code.blocked-av:o antivírus bloqueou`;
    case 'startup_disabled':
      return $localize`:@@devices.startup.code.startup-disabled:o início automático está desligado`;
    case 'disk_full':
      return $localize`:@@devices.startup.code.disk-full:o disco está cheio`;
    default:
      return null;
  }
}

/** A etapa em que a partida parou, quando ela deu certo até ali. */
export function stageLabel(stage: string): string | null {
  switch (stage) {
    case 'bootstrap':
      return $localize`:@@devices.startup.stage.bootstrap:abertura`;
    case 'supervisor':
      return $localize`:@@devices.startup.stage.supervisor:supervisor`;
    case 'child_spawn':
      return $localize`:@@devices.startup.stage.child-spawn:abertura do agente`;
    case 'child_exit':
      return $localize`:@@devices.startup.stage.child-exit:saída do agente`;
    case 'selftest':
      return $localize`:@@devices.startup.stage.selftest:autoteste`;
    case 'hello_sent':
      return $localize`:@@devices.startup.stage.hello-sent:contato com o servidor`;
    default:
      return null;
  }
}

/** Por que o servidor recusou a conexão. */
export function rejectionText(reason: string): string {
  switch (reason) {
    case 'protocol':
      return $localize`:@@devices.startup.reject.protocol:Versão do agente recusada`;
    default:
      // invalid_token, wrong_agent e o que vier de novo: para o dono é a mesma coisa, a credencial não vale.
      return $localize`:@@devices.startup.reject.invalid:Credencial recusada`;
  }
}

function startupText(beacon: AgentBeacon): string {
  if (beacon.code !== null && beacon.code !== 'ok') {
    const reason = codeReason(beacon.code);
    return reason
      ? $localize`:@@devices.startup.failed:Não conseguiu iniciar: ${reason}:reason:`
      : $localize`:@@devices.startup.failed-unknown:Não conseguiu iniciar`;
  }
  if (beacon.stage === 'stopped_by_user') {
    return $localize`:@@devices.startup.stopped:Parado pelo usuário`;
  }
  const stage = beacon.stage === null ? null : stageLabel(beacon.stage);
  return stage
    ? $localize`:@@devices.startup.last-stage:Última etapa: ${stage}:stage:`
    : $localize`:@@devices.startup.signal:Mandou sinal ao iniciar`;
}

/**
 * A linha que explica o estado de um computador, ou `null`.
 *
 * A recusa de protocolo é o caso "conectado, mas mudo": o hello foi recusado com a conexão aberta, então a anotação nasce
 * depois do contato e antes da queda, e o último contato (`lastSeenAt`) a passa. Por isso ela vale sem esse piso e aparece
 * mesmo com o computador conectado; quem a apaga é a API, no primeiro hello aceito.
 *
 * Para um computador desconectado, as demais pistas só valem se vierem depois do último contato de verdade: uma falha de
 * semana passada não pode esconder um computador que depois voltou. Só a recusa que exige um token verdadeiro (`wrong_agent`)
 * vence a baliza, mesmo que a baliza seja mais nova. As outras (`invalid_token`, que qualquer um provoca com um token
 * inventado) disputam com a baliza pelo horário: a mais nova vence.
 */
export function startupLine(
  connected: boolean,
  lastSeenAt: string | null,
  beacon: AgentBeacon | undefined,
): StartupLine | null {
  if (!beacon) return null;
  if (beacon.rejectReason === 'protocol' && beacon.rejectedAt !== null) {
    return {
      text: connected
        ? $localize`:@@devices.startup.reject.protocol-connected:Conectado, mas a versão do agente foi recusada`
        : rejectionText('protocol'),
      failed: true,
      at: beacon.rejectedAt,
      verified: true,
    };
  }
  if (connected) return null;
  const floor = lastSeenAt ? Date.parse(lastSeenAt) : Number.NEGATIVE_INFINITY;
  const newer = (iso: string | null): iso is string => iso !== null && Date.parse(iso) > floor;

  const signalled = newer(beacon.at) ? beacon.at : null;
  if (newer(beacon.rejectedAt) && beacon.rejectReason !== null) {
    const trusted = beacon.rejectReason === 'wrong_agent';
    if (trusted || signalled === null || Date.parse(beacon.rejectedAt) >= Date.parse(signalled)) {
      return {
        text: rejectionText(beacon.rejectReason),
        failed: true,
        at: beacon.rejectedAt,
        verified: false,
      };
    }
  }
  if (signalled !== null) {
    return {
      text: startupText(beacon),
      failed: beacon.code !== null && beacon.code !== 'ok',
      at: signalled,
      verified: false,
    };
  }
  return null;
}

/** "agora", "há 5 min", "há 3 h", "há 2 dias": o tempo curto ao lado da linha. */
export function agoText(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return $localize`:@@devices.startup.ago.now:agora`;
  if (minutes < 60) return $localize`:@@devices.startup.ago.minutes:há ${minutes}:count: min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return $localize`:@@devices.startup.ago.hours:há ${hours}:count: h`;
  const days = Math.floor(hours / 24);
  return days === 1
    ? $localize`:@@devices.startup.ago.day:há 1 dia`
    : $localize`:@@devices.startup.ago.days:há ${days}:count: dias`;
}
