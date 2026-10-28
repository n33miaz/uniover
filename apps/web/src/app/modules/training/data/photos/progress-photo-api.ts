import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { APP_CONFIG } from '../../../../core/config/app-config';
import { AUTH_CONFIG, AuthService } from '../../../../core/auth/auth.service';
import { SessionState } from '../../../../core/session/session-state';
import type { components } from '../../../../core/api/generated/schema';

const BASE = `${APP_CONFIG.apiBase}/v1/training/progress-photos`;

export type ProgressPhotoDto = components['schemas']['ProgressPhotoResponse'];

/** A porta das rotas privadas de fotos. Os bytes nunca recebem URL pública ou permanente. */
export interface ProgressPhotoApi {
  list(accountId: string): Promise<readonly ProgressPhotoDto[]>;
  read(accountId: string, id: string): Promise<ArrayBuffer>;
  put(
    accountId: string,
    id: string,
    takenOn: string,
    bytes: ArrayBuffer,
  ): Promise<ProgressPhotoDto>;
  delete(accountId: string, id: string): Promise<void>;
}

export class ProgressPhotoAccessError extends Error {}

@Injectable({ providedIn: 'root' })
export class ProgressPhotoHttpApi implements ProgressPhotoApi {
  private readonly http = inject(HttpClient);
  private readonly auth = inject(AuthService);
  private readonly session = inject(SessionState);
  private readonly minLeadMs = inject(AUTH_CONFIG).minLeadMs;

  async list(accountId: string): Promise<readonly ProgressPhotoDto[]> {
    return firstValueFrom(
      this.http.get<ProgressPhotoDto[]>(BASE, { headers: await this.headers(accountId) }),
    );
  }

  async read(accountId: string, id: string): Promise<ArrayBuffer> {
    return firstValueFrom(
      this.http.get(`${BASE}/${encodeURIComponent(id)}/content`, {
        headers: await this.headers(accountId),
        responseType: 'arraybuffer',
      }),
    );
  }

  async put(
    accountId: string,
    id: string,
    takenOn: string,
    bytes: ArrayBuffer,
  ): Promise<ProgressPhotoDto> {
    return firstValueFrom(
      this.http.put<ProgressPhotoDto>(`${BASE}/${encodeURIComponent(id)}`, bytes, {
        headers: (await this.headers(accountId))
          .set('Content-Type', 'image/jpeg')
          .set('Idempotency-Key', id),
        params: { takenOn },
      }),
    );
  }

  async delete(accountId: string, id: string): Promise<void> {
    await firstValueFrom(
      this.http.put(`${BASE}/${encodeURIComponent(id)}/deletion`, null, {
        headers: await this.headers(accountId),
      }),
    );
  }

  private async headers(accountId: string): Promise<HttpHeaders> {
    let token = this.session.bearerOf(accountId, Date.now() + this.minLeadMs);
    if (token === null) {
      await this.auth.accessToken();
      token = this.session.bearerOf(accountId);
    }
    if (token === null) throw new ProgressPhotoAccessError();
    return new HttpHeaders({ Authorization: `Bearer ${token}`, 'Cache-Control': 'no-store' });
  }
}

export const PROGRESS_PHOTO_API = new InjectionToken<ProgressPhotoApi>('PROGRESS_PHOTO_API', {
  providedIn: 'root',
  factory: () => inject(ProgressPhotoHttpApi),
});
