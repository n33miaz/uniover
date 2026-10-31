import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import type { components } from '../../core/api/generated/schema';
import { APP_CONFIG } from '../../core/config/app-config';

type Schemas = components['schemas'];

export type CreatedInvite = Readonly<Schemas['CreateGuestInviteResponse']>;
export type GuestPermissions = Readonly<Schemas['GuestSummary']>;

/** Quantas vezes algo aconteceu nos últimos 7 e 30 dias. */
export interface UsageCounts {
  readonly last7Days: number;
  readonly last30Days: number;
}

/** O uso de uma conta, só contagens: o dono vê quando entrou e quanto usou, nunca o conteúdo. */
export interface PersonUsage {
  readonly id: string;
  readonly displayName: string;
  readonly role: string;
  readonly disabledAt: string | null;
  readonly lastAccessAt: string | null;
  readonly activeSessions: number;
  readonly tvCommands: UsageCounts;
  readonly workouts: UsageCounts;
}

const BASE = `${APP_CONFIG.apiBase}/v1/identity`;

/**
 * O que a tela Pessoas pede à API de identidade e o cliente de login ainda não faz: criar o convite já com as
 * permissões e mudar as de quem já entrou. Usa o `HttpClient`, cujos interceptadores levam o Bearer, renovam a
 * sessão e, no 403 de confirmação pendente, abrem a passkey e repetem o pedido uma única vez; por isso nada aqui trata
 * isso (o `DevicesApi` segue o mesmo desenho).
 */
@Injectable({ providedIn: 'root' })
export class PeopleApi {
  private readonly http = inject(HttpClient);

  /** O uso de cada conta (último acesso, sessões, comandos da TV e treinos); só o administrador. */
  usage(): Promise<readonly PersonUsage[]> {
    return firstValueFrom(this.http.get<PersonUsage[]>(`${BASE}/people-usage`));
  }

  /** Gerar o convite concede acesso: exige a passkey. A lista vai sempre explícita, para a tela mostrar o que foi enviado. */
  createInvite(displayName: string, permissions: readonly string[]): Promise<CreatedInvite> {
    const body: Schemas['CreateGuestInviteRequest'] = {
      displayName,
      permissions: [...permissions],
    };
    return firstValueFrom(this.http.post<CreatedInvite>(`${BASE}/guest-invites`, body));
  }

  /**
   * Troca as permissões de um convidado pela lista COMPLETA desejada (não é um acréscimo). Só o administrador, e com a
   * passkey: ampliar o acesso é conceder. Devolve o convidado como ficou.
   */
  setPermissions(id: string, permissions: readonly string[]): Promise<GuestPermissions> {
    const body: Schemas['SetGuestPermissionsRequest'] = { permissions: [...permissions] };
    return firstValueFrom(
      this.http.put<GuestPermissions>(`${BASE}/guests/${encodeURIComponent(id)}/permissions`, body),
    );
  }
}
