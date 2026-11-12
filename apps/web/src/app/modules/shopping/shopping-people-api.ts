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
}
