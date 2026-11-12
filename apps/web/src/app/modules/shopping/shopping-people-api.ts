import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../core/config/app-config';

const BASE = `${APP_CONFIG.apiBase}/v1/shopping`;

/** Uma pessoa na tela de pessoas: quem já está no grupo (`isMember`) ou quem pode ser adicionado. */
export interface ShoppingPerson {
  readonly userId: string;
  readonly name: string;
  readonly isOwner: boolean;
  readonly isMember: boolean;
}

/** O convite recém-criado: o segredo só aparece aqui (o servidor guarda o hash). */
export interface CreatedGroupInvite {
  readonly id: string;
  readonly token: string;
  readonly expiresAt: string;
}

export interface GroupInvite {
  readonly id: string;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export interface ShoppingGroup {
  readonly id: string;
  readonly isOwner: boolean;
}

/**
 * As pessoas do grupo de compras. Mexer em pessoas pede sinal (não entra na fila do aparelho): quem entra ou sai muda
 * o que cada um enxerga, e isso só vale quando o servidor confirma. `operationId` é o mesmo a cada nova tentativa do
 * mesmo toque, para o reenvio não repetir a mudança.
 */
@Injectable({ providedIn: 'root' })
export class ShoppingPeopleApi {
  private readonly http = inject(HttpClient);

  group(): Promise<ShoppingGroup> {
    return firstValueFrom(this.http.get<ShoppingGroup>(`${BASE}/group`));
  }

  people(): Promise<readonly ShoppingPerson[]> {
    return firstValueFrom(this.http.get<ShoppingPerson[]>(`${BASE}/group/people`));
  }

  setMember(userId: string, member: boolean, operationId: string): Promise<unknown> {
    return firstValueFrom(
      this.http.put(`${BASE}/group/members/${encodeURIComponent(userId)}`, {
        operationId,
        deleted: !member,
      }),
    );
  }

  leave(operationId: string): Promise<unknown> {
    return firstValueFrom(this.http.post(`${BASE}/group/leave`, { operationId }));
  }

  /** Só quem criou o grupo. Uso único, vale 7 dias. */
  createInvite(): Promise<CreatedGroupInvite> {
    return firstValueFrom(this.http.post<CreatedGroupInvite>(`${BASE}/group/invites`, {}));
  }

  invites(): Promise<readonly GroupInvite[]> {
    return firstValueFrom(this.http.get<GroupInvite[]>(`${BASE}/group/invites`));
  }

  revokeInvite(id: string): Promise<unknown> {
    return firstValueFrom(
      this.http.post(`${BASE}/group/invites/${encodeURIComponent(id)}/revoke`, {}),
    );
  }

  /** Entra no grupo do convite. */
  acceptInvite(token: string): Promise<ShoppingGroup> {
    return firstValueFrom(this.http.post<ShoppingGroup>(`${BASE}/group/invites/accept`, { token }));
  }
}
