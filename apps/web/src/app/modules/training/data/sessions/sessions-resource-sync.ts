import { Injectable, type Provider, inject } from '@angular/core';
import { RestAlert } from '../session-live/rest-alert';
import { RestTimerService } from '../session-live/rest-timer.service';
import { WakeLockService } from '../session-live/wake-lock.service';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { type SessionDto, type SetDto, toLocalSession, toLocalSet } from './session';
import { SESSIONS_PATH, SETS_PATH } from './session-api';
import { SessionRepository } from './session-repository';

/** Os treinos como recurso sincronizável: o servidor entrega o treino, aqui se converte e se funde. */
@Injectable()
export class SessionsResourceSync implements ResourceSync<SessionDto> {
  private readonly repository = inject(SessionRepository);

  readonly resource = 'sessions';
  readonly path = SESSIONS_PATH;

  merge(items: readonly SessionDto[]): Promise<void> {
    return this.repository.applyRemoteSessions(items.map(toLocalSession));
  }
}

/** As séries como recurso sincronizável (vêm depois dos treinos: o puxador segue a ordem de registro). */
@Injectable()
export class SetsResourceSync implements ResourceSync<SetDto> {
  private readonly repository = inject(SessionRepository);

  readonly resource = 'sets';
  readonly path = SETS_PATH;

  merge(items: readonly SetDto[]): Promise<void> {
    return this.repository.applyRemoteSets(items.map(toLocalSet));
  }
}

/**
 * Tudo o que o treino ao vivo registra no módulo: o acesso aos dados, os dois recursos sincronizáveis e os serviços do
 * treino em andamento (timer de descanso, aviso e tela acesa). `provideTrainingData` o chama numa linha só.
 */
export function provideSessionsData(): Provider[] {
  return [
    SessionRepository,
    provideResourceSync(SessionsResourceSync),
    provideResourceSync(SetsResourceSync),
    RestAlert,
    RestTimerService,
    WakeLockService,
  ];
}
