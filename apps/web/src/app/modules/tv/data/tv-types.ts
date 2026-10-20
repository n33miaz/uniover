import type { TvKeyV2BodyKey, TvWatchdogV1Body } from '../../../core/api/generated/agent';
import type { components } from '../../../core/api/generated/schema';

/** Teclas que o controle envia por `/keys`. `POWER` não está aqui: desligar tem rota e botão próprios. */
export type TvKey = Exclude<TvKeyV2BodyKey, 'POWER'>;

/** Atalho como a API entrega (tipo gerado do OpenAPI). */
export type TvShortcut = components['schemas']['TvShortcut'];

type TvStateDto = components['schemas']['TvState'];

/** `hot`: sessão aberta · `hibernating`: controle dormindo (não é "TV desligada") · `disconnected`: sem sessão. */
export type TvConnection = 'hot' | 'hibernating' | 'disconnected';
export type TvPower = 'on' | 'off' | 'unknown';

/** O estado já normalizado: o gerador tipa `volume` como número ou texto e `connection`/`power` como texto livre. */
export interface TvState {
  readonly power: TvPower;
  readonly volume: number | null;
  readonly app: string | null;
  readonly connection: TvConnection;
  readonly agentOnline: boolean;
  readonly updatedAt: string | null;
}

/** Evento do vigia como chega pelo SSE; o formato é o mesmo do corpo da mensagem do agente. */
export type TvWatchdog = Pick<TvWatchdogV1Body, 'kind' | 'severity' | 'detail' | 'attempts' | 'at'>;

/** Nomes dos eventos do fluxo `/api/v1/tv/events`. */
export const TV_STREAM_EVENTS = {
  state: 'tv.state',
  shortcuts: 'tv.shortcuts',
  watchdog: 'tv.watchdog',
} as const;

function toVolume(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function toPower(value: unknown): TvPower {
  return value === 'on' || value === 'off' ? value : 'unknown';
}

function toConnection(value: unknown, agentOnline: boolean): TvConnection {
  // Sem agente conectado não há sessão com a TV, qualquer que seja a última leitura.
  if (!agentOnline) return 'disconnected';
  return value === 'hot' || value === 'hibernating' ? value : 'disconnected';
}

/** Lê o estado vindo da API ou do SSE; `null` quando o corpo não tem a forma esperada. */
export function parseState(value: unknown): TvState | null {
  if (!value || typeof value !== 'object') return null;
  const dto = value as Partial<TvStateDto>;
  const agentOnline = dto.agentOnline === true;
  return {
    power: toPower(dto.power),
    volume: agentOnline ? toVolume(dto.volume) : null,
    app: typeof dto.app === 'string' ? dto.app : null,
    connection: toConnection(dto.connection, agentOnline),
    agentOnline,
    updatedAt: typeof dto.updatedAt === 'string' ? dto.updatedAt : null,
  };
}

/**
 * Lê a lista de atalhos, descartando o que não tem o mínimo; a ordem é a de `position`. `iconDataUri` sempre sai
 * como texto ou `null`: linhas guardadas antes dos ícones não têm o campo.
 */
export function parseShortcuts(value: unknown): TvShortcut[] | null {
  if (!Array.isArray(value)) return null;
  const list = value.filter(
    (item): item is TvShortcut =>
      !!item &&
      typeof item === 'object' &&
      typeof (item as TvShortcut).id === 'string' &&
      typeof (item as TvShortcut).position === 'number',
  );
  return list
    .map((item) => {
      const icon = typeof item.iconDataUri === 'string' ? item.iconDataUri : null;
      return item.iconDataUri === icon ? item : { ...item, iconDataUri: icon };
    })
    .sort((a, b) => a.position - b.position);
}

export function parseWatchdog(value: unknown): TvWatchdog | null {
  if (!value || typeof value !== 'object') return null;
  const entry = value as Partial<TvWatchdog>;
  if (typeof entry.kind !== 'string' || typeof entry.at !== 'string') return null;
  return {
    kind: entry.kind,
    severity: entry.severity ?? 'info',
    detail: typeof entry.detail === 'string' ? entry.detail : '',
    attempts: typeof entry.attempts === 'number' ? entry.attempts : 0,
    at: entry.at,
  };
}

/**
 * Nome mostrado de um atalho: o nome próprio do dono, depois o nome que o agente publica para o app (`tvLabel`) e só
 * então "Atalho n", com a posição que a API deu (estável, nunca renumerada).
 */
export function shortcutLabel(
  shortcut: Pick<TvShortcut, 'customLabel' | 'tvLabel' | 'position'>,
): string {
  const own = shortcut.customLabel?.trim();
  if (own) return own;
  const published = shortcut.tvLabel?.trim();
  if (published) return published;
  const position = shortcut.position;
  return $localize`:@@tv.shortcut.default-label:Atalho ${position}:position:`;
}

/** Hora local `HH:MM` de um instante ISO; vazio se o texto não for uma data. */
export function clockText(value: string | number | Date | null): string {
  if (value === null) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('pt-BR', { hour: '2-digit', minute: '2-digit' }).format(date);
}
