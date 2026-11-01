import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';
import { AgentDiagnostics, readAgentDiagnostics } from './agent-diagnostics';

/** A configuração da TV padrão, como a API a entrega (tipo gerado do OpenAPI). */
export type TvConfig = components['schemas']['TvConfigResponse'];

/**
 * O retrato da capacidade como o administrador o vê em `GET /api/v1/identity/capacity`. O tipo é local porque o OpenAPI
 * gerado descreve todo número como `number | string`: o JSON traz números. Os campos `band`, `memoryBand` e `hoursBand`
 * são {@link CapacityBand}; `state` da tendência é `few`, `flat` ou `growing`, e `daysToAmber`/`daysToRed` valem 0 quando o
 * limite já passou e `null` quando não há data honesta.
 */
export interface CapacityReport {
  readonly database: {
    readonly bytes: number;
    readonly limitBytes: number;
    readonly percent: number;
    readonly band: CapacityBand;
    readonly tables: readonly {
      readonly schema: string;
      readonly name: string;
      readonly bytes: number;
    }[];
  };
  readonly server: {
    readonly workingSetBytes: number;
    readonly heapBytes: number;
    readonly memoryLimitBytes: number;
    readonly memoryPercent: number;
    readonly memoryBand: CapacityBand;
    readonly startedAt: string;
    readonly uptimeSeconds: number;
    readonly monthHours: number;
    readonly hoursLimit: number;
    readonly hoursPercent: number;
    readonly hoursBand: CapacityBand;
    /** O mês inteiro se tudo ficar ligado: dias do mês × 24 × serviços do workspace. */
    readonly hoursProjected: number;
    readonly servicesInWorkspace: number;
  };
  readonly growth: {
    readonly points: readonly { readonly day: string; readonly bytes: number }[];
    readonly bytesPerDay: number | null;
    readonly daysToAmber: number | null;
    readonly daysToRed: number | null;
    readonly state: 'few' | 'flat' | 'growing';
  };
  readonly alerts: readonly {
    readonly id: string;
    readonly metric: 'database' | 'memory' | 'hours';
    readonly percent: number;
    readonly detectedAt: string;
  }[];
  readonly measuredAt: string;
}

/**
 * A faixa de uso: verde abaixo de 50%, âmbar de 50% a 80%, vermelho de 80% em diante. As horas do mês são só informativas
 * (`neutral`) e só ficam vermelhas quando a projeção do mês inteiro passa do limite.
 */
export type CapacityBand = 'neutral' | 'green' | 'amber' | 'red';

/** Um computador pareado que pode controlar a TV. */
export type TvComputer = components['schemas']['TvAgentChoice'];

/** Como está o computador escolhido (os valores que a API usa em `agentStatus`). */
export type TvComputerStatus = 'online' | 'offline' | 'revoked' | 'unknown';

/** De onde vem o computador escolhido (os valores que a API usa em `source`). */
export type TvConfigSource = 'saved' | 'none';

/**
 * Uma TV como o administrador a vê em `GET /api/v1/tv/tvs`. O tipo é local enquanto os tipos HTTP gerados não incluem
 * estas rotas (e um módulo de tela não importa de outro): `agentSlug` é o computador que a controla, `kind` o tipo
 * declarado por ele (nulo com o computador desligado), `online` se o computador está ligado e `capabilities` o que ele
 * anunciou ao conectar.
 */
export interface TvItem {
  readonly id: string;
  readonly name: string;
  readonly isDefault: boolean;
  readonly agentSlug: string | null;
  readonly kind: 'android' | 'samsung' | null;
  readonly online: boolean;
  readonly capabilities: readonly string[];
  /** A limpeza pode fechar apps em segundo plano nesta TV. Desligado até o administrador ligar. */
  readonly allowBackgroundAppClosing: boolean;
  readonly focusModeEnabled?: boolean;
  /** Com o Modo Foco ligado, fecha os outros apps em segundo plano. Só existe em TV cujo agente anuncia a capacidade. */
  readonly focusClosesBackground?: boolean;
  readonly shortAnimationsEnabled?: boolean;
  readonly restrictedBackgroundPackages?: readonly string[];
  /** A TV Samsung esqueceu o UniOver: falta alguém escolher "Permitir" na tela dela (o agente não pede sozinho). */
  readonly permissionNeeded?: boolean;
}

/** Uma TV compatível que o computador achou na rede dele. O `id` é opaco: nunca há endereço nem MAC. */
export interface NearbyTv {
  readonly id: string;
  readonly kind: 'android' | 'samsung';
  readonly name: string | null;
  /** É a TV que este computador já controla. */
  readonly controlled: boolean;
}

/** Como terminou a procura: `ok` (lista, talvez vazia), computador sem sinal, agente antigo, procura em andamento ou falha. */
export type NearbyStatus = 'ok' | 'offline' | 'unsupported' | 'busy' | 'failed';

export interface NearbyResult {
  readonly status: NearbyStatus;
  readonly items: readonly NearbyTv[];
}

export interface TvAppOption {
  readonly package: string;
  readonly label: string;
}

/** Uma limpeza da TV como o Sistema a mostra: o que fez ou por que foi pulada (`reason` é um código estável). */
export interface TvCleanupReportItem {
  readonly kind: string;
  readonly trigger: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly memoryBeforeMb: number | null;
  readonly memoryAfterMb: number | null;
  readonly closedApps: number;
  readonly closedPackages: readonly string[];
  readonly backgroundProcesses: number | null;
  readonly sessionOpenMs: number | null;
  readonly result: string;
  readonly reason: string | null;
}

/** Uma linha do histórico de uma TV: quem mandou (a conta), o quê, quando e se deu certo. Só o administrador a lê. */
export interface TvHistoryItem {
  readonly id: string;
  readonly userId: string;
  readonly command: string;
  readonly detail: string | null;
  readonly ok: boolean;
  readonly errorCode: string | null;
  readonly occurredAt: string;
}

/** As TVs que uma conta vê hoje (as ids), pela regra do servidor. */
export interface TvAccessPerson {
  readonly userId: string;
  readonly tvIds: readonly string[];
}

/** O catálogo do Modo Foco de uma TV: o que vale, a lista de fábrica e se o administrador já a mudou. */
export interface TvFocusCatalog {
  readonly packages: readonly string[];
  readonly defaults: readonly string[];
  readonly isCustom: boolean;
}

const BASE = `${APP_CONFIG.apiBase}/v1/tv`;
const SETTINGS_BASE = `${APP_CONFIG.apiBase}/v1/identity/system-settings`;

export type SystemSettingKey =
  | 'training.off-contact'
  | 'devices.max-per-guest'
  | 'devices.agent-offline-minutes'
  | 'tv.light-cleanup-enabled'
  | 'tv.deep-cleanup-enabled'
  | 'tv.deep-cleanup-memory-threshold-mb';

export interface SystemSettingValue {
  readonly key: SystemSettingKey;
  readonly value: string | number | boolean;
  readonly source: 'app' | 'server';
}

/** Um computador pareado, só o que a leitura de saúde mostra (o módulo de dispositivos tem o tipo completo). */
export interface HealthAgent {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly connected: boolean;
  readonly lastSeenAt: string | null;
}

/**
 * Um evento interno que esgotou as tentativas de entrega e saiu da fila (dead letter). Sem o conteúdo: `module` é quem o
 * gerou, `lastError` só o tipo da falha. Local enquanto os tipos HTTP gerados não incluem esta rota.
 */
export interface DeadLetterEntry {
  readonly module: string;
  readonly id: string;
  readonly type: string;
  readonly failedAt: string;
  readonly attempts: number;
  readonly lastError: string | null;
}

/** Os eventos mortos de todos os módulos: o total real, os mais recentes e os módulos que não puderam ser lidos. */
export interface DeadLetterReport {
  readonly total: number;
  readonly items: readonly DeadLetterEntry[];
  readonly unavailableModules: readonly string[];
}

/** Identificação pública da versão da API em execução. */
export interface DeploymentVersion {
  readonly commit: string | null;
}

function readTv(value: unknown): TvItem | null {
  if (!value || typeof value !== 'object') return null;
  const dto = value as Record<string, unknown>;
  if (typeof dto['id'] !== 'string' || typeof dto['name'] !== 'string') return null;
  return {
    id: dto['id'],
    name: dto['name'],
    isDefault: dto['isDefault'] === true,
    agentSlug: typeof dto['agentSlug'] === 'string' ? dto['agentSlug'] : null,
    kind: dto['kind'] === 'android' || dto['kind'] === 'samsung' ? dto['kind'] : null,
    online: dto['online'] === true,
    allowBackgroundAppClosing: dto['allowBackgroundAppClosing'] === true,
    ...(dto['focusModeEnabled'] === true ? { focusModeEnabled: true } : {}),
    ...(dto['focusClosesBackground'] === true ? { focusClosesBackground: true } : {}),
    ...(dto['shortAnimationsEnabled'] === true ? { shortAnimationsEnabled: true } : {}),
    ...(dto['permissionNeeded'] === true ? { permissionNeeded: true } : {}),
    ...(Array.isArray(dto['restrictedBackgroundPackages'])
      ? {
          restrictedBackgroundPackages: dto['restrictedBackgroundPackages'].filter(
            (item): item is string => typeof item === 'string',
          ),
        }
      : {}),
    capabilities: Array.isArray(dto['capabilities'])
      ? dto['capabilities'].filter((item): item is string => typeof item === 'string')
      : [],
  };
}

function readTvOrThrow(value: unknown): TvItem {
  const tv = readTv(value);
  if (!tv) throw new Error('TV em formato inesperado.');
  return tv;
}

/**
 * Cliente da API de configuração do sistema (hoje, só a da TV). Usa o `HttpClient`, cujos interceptadores já levam o
 * Bearer, renovam a sessão e, no 403 de confirmação pendente, abrem a passkey e repetem o pedido uma única vez; por
 * isso nada aqui trata isso.
 */
@Injectable({ providedIn: 'root' })
export class SystemApi {
  private readonly http = inject(HttpClient);

  systemSettings(): Promise<SystemSettingValue[]> {
    return firstValueFrom(this.http.get<SystemSettingValue[]>(SETTINGS_BASE));
  }

  /** Os computadores pareados e o estado de cada um (só o administrador). */
  async agents(): Promise<HealthAgent[]> {
    const items = await firstValueFrom(
      this.http.get<HealthAgent[]>(`${APP_CONFIG.apiBase}/v1/devices/agents`),
    );
    return items.map(({ id, slug, name, connected, lastSeenAt }) => ({
      id,
      slug,
      name,
      connected,
      lastSeenAt: lastSeenAt ?? null,
    }));
  }

  /** Os eventos que viraram dead letter (só o administrador). */
  async deadLetters(): Promise<DeadLetterReport> {
    const dto = await firstValueFrom(
      this.http.get<Partial<DeadLetterReport>>(`${APP_CONFIG.apiBase}/v1/system/dead-letters`),
    );
    return {
      total: typeof dto?.total === 'number' ? dto.total : 0,
      items: Array.isArray(dto?.items) ? dto.items : [],
      unavailableModules: Array.isArray(dto?.unavailableModules) ? dto.unavailableModules : [],
    };
  }

  /** O que os próprios computadores contaram sobre si nos últimos dias, do mais novo ao mais velho (só o administrador). */
  async agentDiagnostics(limit = 50): Promise<AgentDiagnostics> {
    const dto = await firstValueFrom(
      this.http.get<components['schemas']['AgentDiagnosticsResponse']>(
        `${APP_CONFIG.apiBase}/v1/devices/agents/diagnostics`,
        { params: { limit } },
      ),
    );
    if (!dto || !Array.isArray(dto.items)) throw new Error('Lista de erros em formato inesperado.');
    return readAgentDiagnostics(dto);
  }

  /** Banco, memória, horas do mês e tendência (só o administrador). */
  capacity(): Promise<CapacityReport> {
    return firstValueFrom(
      this.http.get<CapacityReport>(`${APP_CONFIG.apiBase}/v1/identity/capacity`),
    );
  }

  /** O administrador viu os avisos de capacidade: eles saem do cartão. */
  async dismissCapacityAlerts(): Promise<void> {
    await firstValueFrom(
      this.http.post<void>(`${APP_CONFIG.apiBase}/v1/identity/capacity/alerts/seen`, null),
    );
  }

  /** O endpoint de saúde é público e não lê dados da conta. */
  deploymentVersion(): Promise<DeploymentVersion> {
    return firstValueFrom(this.http.get<DeploymentVersion>(`${APP_CONFIG.apiBase}/health/version`));
  }

  saveSystemSetting(
    key: SystemSettingKey,
    value: string | number | boolean,
  ): Promise<SystemSettingValue> {
    return firstValueFrom(
      this.http.put<SystemSettingValue>(`${SETTINGS_BASE}/${encodeURIComponent(key)}`, { value }),
    );
  }

  resetSystemSetting(key: SystemSettingKey): Promise<SystemSettingValue> {
    return firstValueFrom(
      this.http.delete<SystemSettingValue>(`${SETTINGS_BASE}/${encodeURIComponent(key)}`),
    );
  }

  tvConfig(): Promise<TvConfig> {
    return firstValueFrom(this.http.get<TvConfig>(`${BASE}/config`));
  }

  /** Passa o controle da TV para outro computador. Exige a confirmação com a passkey. Devolve a configuração nova. */
  bindTvComputer(agentSlug: string): Promise<TvConfig> {
    const body: components['schemas']['BindAgentRequest'] = { agentSlug, name: null };
    return firstValueFrom(this.http.put<TvConfig>(`${BASE}/config/agent`, body));
  }

  /** Todas as TVs (o administrador vê todas), a padrão primeiro. */
  async tvs(): Promise<TvItem[]> {
    const dto = await firstValueFrom(this.http.get<{ items?: unknown }>(`${BASE}/tvs`));
    if (!Array.isArray(dto?.items)) throw new Error('Lista de TVs em formato inesperado.');
    return dto.items.map(readTv).filter((tv): tv is TvItem => tv !== null);
  }

  /**
   * As TVs compatíveis que o computador achou na rede dele (só o administrador). Leva alguns segundos: o agente varre a
   * rede. Nunca lança por causa do estado do computador; o `status` conta o que houve.
   */
  async nearbyTvs(agentSlug: string): Promise<NearbyResult> {
    const dto = await firstValueFrom(
      this.http.get<{ status?: unknown; items?: unknown }>(`${BASE}/tvs/nearby`, {
        params: { agent: agentSlug },
      }),
    );
    const status = (['ok', 'offline', 'unsupported', 'busy'] as const).find(
      (value) => value === dto?.status,
    );
    const items = Array.isArray(dto?.items) ? dto.items : [];
    return {
      status: status ?? 'failed',
      items: items.flatMap((item): NearbyTv[] => {
        const tv = item as Record<string, unknown> | null;
        if (!tv || typeof tv['id'] !== 'string') return [];
        if (tv['kind'] !== 'android' && tv['kind'] !== 'samsung') return [];
        return [
          {
            id: tv['id'],
            kind: tv['kind'],
            name: typeof tv['name'] === 'string' ? tv['name'] : null,
            controlled: tv['controlled'] === true,
          },
        ];
      }),
    };
  }

  /** Cria uma TV ligada a um computador pareado que ainda não tem TV (409 se já tiver). Exige a passkey. */
  async createTv(agentSlug: string, name: string): Promise<TvItem> {
    return readTvOrThrow(await firstValueFrom(this.http.post(`${BASE}/tvs`, { agentSlug, name })));
  }

  /** Muda só o que vier (nome, computador e/ou fechar apps em segundo plano). Exige a passkey. */
  async updateTv(
    id: string,
    change: {
      name?: string;
      agentSlug?: string;
      allowBackgroundAppClosing?: boolean;
      focusModeEnabled?: boolean;
      focusClosesBackground?: boolean;
      shortAnimationsEnabled?: boolean;
      restrictedBackgroundPackages?: readonly string[];
      focusPackages?: readonly string[];
    },
  ): Promise<TvItem> {
    const body: Record<string, string | boolean | string[]> = {};
    if (change.name !== undefined) body['name'] = change.name;
    if (change.agentSlug !== undefined) body['agentSlug'] = change.agentSlug;
    if (change.allowBackgroundAppClosing !== undefined)
      body['allowBackgroundAppClosing'] = change.allowBackgroundAppClosing;
    if (change.focusModeEnabled !== undefined) body['focusModeEnabled'] = change.focusModeEnabled;
    if (change.focusClosesBackground !== undefined)
      body['focusClosesBackground'] = change.focusClosesBackground;
    if (change.shortAnimationsEnabled !== undefined)
      body['shortAnimationsEnabled'] = change.shortAnimationsEnabled;
    if (change.restrictedBackgroundPackages !== undefined)
      body['restrictedBackgroundPackages'] = [...change.restrictedBackgroundPackages];
    if (change.focusPackages !== undefined) body['focusPackages'] = [...change.focusPackages];
    return readTvOrThrow(
      await firstValueFrom(this.http.patch(`${BASE}/tvs/${encodeURIComponent(id)}`, body)),
    );
  }

  async tvApps(id: string): Promise<TvAppOption[]> {
    const dto = await firstValueFrom(
      this.http.get<{ items?: TvAppOption[] }>(`${BASE}/tvs/${encodeURIComponent(id)}/apps`),
    );
    if (!Array.isArray(dto?.items)) throw new Error('Lista de apps em formato inesperado.');
    return dto.items.filter(
      (item): item is TvAppOption =>
        typeof item?.package === 'string' && typeof item?.label === 'string',
    );
  }

  /** O catálogo do Modo Foco da TV (só o administrador). */
  async tvFocusCatalog(id: string): Promise<TvFocusCatalog> {
    const dto = await firstValueFrom(
      this.http.get<Partial<TvFocusCatalog>>(`${BASE}/tvs/${encodeURIComponent(id)}/focus-catalog`),
    );
    const names = (value: unknown): string[] =>
      Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
    if (!Array.isArray(dto?.packages) || !Array.isArray(dto?.defaults)) {
      throw new Error('Catálogo do Modo Foco em formato inesperado.');
    }
    return {
      packages: names(dto.packages),
      defaults: names(dto.defaults),
      isCustom: dto.isCustom === true,
    };
  }

  /**
   * O histórico de comandos da TV, do mais novo para o mais antigo (só o administrador; a rota é dele e nenhuma outra conta
   * a alcança).
   */
  async tvHistory(id: string, limit = 50): Promise<TvHistoryItem[]> {
    const dto = await firstValueFrom(
      this.http.get<unknown>(`${BASE}/commands/recent`, { params: { tvId: id, limit } }),
    );
    if (!Array.isArray(dto)) throw new Error('Histórico em formato inesperado.');
    return dto.flatMap((row): TvHistoryItem[] => {
      const item = row as Record<string, unknown> | null;
      if (!item || typeof item['id'] !== 'string' || typeof item['userId'] !== 'string') return [];
      if (typeof item['command'] !== 'string' || typeof item['occurredAt'] !== 'string') return [];
      return [
        {
          id: item['id'],
          userId: item['userId'],
          command: item['command'],
          detail: typeof item['detail'] === 'string' ? item['detail'] : null,
          ok: item['ok'] === true,
          errorCode: typeof item['errorCode'] === 'string' ? item['errorCode'] : null,
          occurredAt: item['occurredAt'],
        },
      ];
    });
  }

  /** As TVs que cada conta pedida vê hoje (só o administrador). Até 50 contas por pedido. */
  async tvAccess(userIds: readonly string[]): Promise<TvAccessPerson[]> {
    if (userIds.length === 0) return [];
    const dto = await firstValueFrom(
      this.http.get<{ items?: unknown }>(`${BASE}/tvs/access`, {
        params: { userId: [...userIds] },
      }),
    );
    if (!Array.isArray(dto?.items)) throw new Error('Acessos às TVs em formato inesperado.');
    return dto.items.flatMap((row): TvAccessPerson[] => {
      const item = row as Record<string, unknown> | null;
      if (!item || typeof item['userId'] !== 'string' || !Array.isArray(item['tvIds'])) return [];
      return [
        {
          userId: item['userId'],
          tvIds: item['tvIds'].filter((id): id is string => typeof id === 'string'),
        },
      ];
    });
  }

  /** As últimas limpezas da TV, da mais nova para a mais antiga. */
  async tvCleanupReports(id: string): Promise<TvCleanupReportItem[]> {
    const dto = await firstValueFrom(
      this.http.get<{ items?: TvCleanupReportItem[] }>(
        `${BASE}/tvs/${encodeURIComponent(id)}/cleanup-reports`,
      ),
    );
    if (!Array.isArray(dto?.items)) throw new Error('Relatórios de limpeza em formato inesperado.');
    return dto.items;
  }

  /** Remove a TV (a padrão não: 409). Exige a passkey. */
  async deleteTv(id: string): Promise<void> {
    await firstValueFrom(this.http.delete(`${BASE}/tvs/${encodeURIComponent(id)}`));
  }

  /** As contas que usam a TV (os ids). */
  async tvMembers(id: string): Promise<string[]> {
    const dto = await firstValueFrom(
      this.http.get<{ userIds?: unknown }>(`${BASE}/tvs/${encodeURIComponent(id)}/members`),
    );
    if (!Array.isArray(dto?.userIds)) throw new Error('Lista de contas em formato inesperado.');
    return dto.userIds.filter((item): item is string => typeof item === 'string');
  }

  /** Troca as contas da TV pela lista COMPLETA desejada (não é um acréscimo). Exige a passkey. */
  async setTvMembers(id: string, userIds: readonly string[]): Promise<string[]> {
    const dto = await firstValueFrom(
      this.http.put<{ userIds?: unknown }>(`${BASE}/tvs/${encodeURIComponent(id)}/members`, {
        userIds: [...userIds],
      }),
    );
    return Array.isArray(dto?.userIds)
      ? dto.userIds.filter((item): item is string => typeof item === 'string')
      : [...userIds];
  }
}
