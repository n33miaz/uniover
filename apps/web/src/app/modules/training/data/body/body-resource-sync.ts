import { Injectable, type Provider, inject } from '@angular/core';
import { provideResourceSync, type ResourceSync } from '../sync/resource-sync';
import { BODY_ENTRIES_PATH, BODY_PROFILE_PATH } from './body-api';
import { type BodyEntryDto, toLocalBodyEntry } from './body-entry';
import { type BodyProfileDto, type LocalBodyProfile, toLocalBodyProfile } from './body-profile';
import { BodyRepository } from './body-repository';
import { ProfileRepository } from './profile-repository';

/** As medições do corpo como recurso sincronizável: o servidor entrega a medição, aqui se converte e se funde. */
@Injectable()
export class BodyEntriesResourceSync implements ResourceSync<BodyEntryDto> {
  private readonly repository = inject(BodyRepository);

  readonly resource = 'bodyEntries';
  readonly path = BODY_ENTRIES_PATH;

  merge(items: readonly BodyEntryDto[]): Promise<void> {
    return this.repository.applyRemote(items.map(toLocalBodyEntry));
  }
}

/** O perfil do corpo como recurso sincronizável (no mesmo envelope de cursor, com no máximo um item). */
@Injectable()
export class BodyProfileResourceSync implements ResourceSync<BodyProfileDto> {
  private readonly repository = inject(ProfileRepository);

  readonly resource = 'bodyProfile';
  readonly path = BODY_PROFILE_PATH;

  merge(items: readonly BodyProfileDto[]): Promise<void> {
    const rows = items
      .map(toLocalBodyProfile)
      .filter((row): row is LocalBodyProfile => row !== null);
    return this.repository.applyRemote(rows);
  }
}

/**
 * Tudo o que as medições e o perfil registram no módulo: o acesso aos dados e os dois recursos sincronizáveis. As seções da
 * exportação são registradas à parte (`provideBodyExportSections`, depois das seções que já existiam, para a ordem do JSON
 * não mudar) e as fotos de progresso de propósito não têm recurso sincronizável nem seção de exportação (`providePhotoData`).
 * `provideTrainingData` o chama numa linha só.
 */
export function provideBodyData(): Provider[] {
  return [
    BodyRepository,
    ProfileRepository,
    provideResourceSync(BodyEntriesResourceSync),
    provideResourceSync(BodyProfileResourceSync),
  ];
}
