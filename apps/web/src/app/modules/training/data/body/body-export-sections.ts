import { Injectable, type Provider, inject } from '@angular/core';
import { TRAINING_EXPORT_SECTIONS, type ExportSection, iso } from '../export/export-sections';
import { TRAINING_DB } from '../training-db';

/**
 * As medições do corpo vivas, da mais antiga à mais nova. **Fotos NUNCA entram**: ficam só no aparelho e o JSON não as
 * carrega (tamanho); a proteção delas é compartilhar uma a uma.
 */
@Injectable()
export class BodyEntriesSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'bodyEntries';

  async build(): Promise<unknown> {
    const rows = await this.db.bodyEntries.toArray();
    return rows
      .filter((row) => row.deletedAt === null)
      .sort(
        (a, b) =>
          a.measuredOn.localeCompare(b.measuredOn) ||
          a.clientUpdatedAt - b.clientUpdatedAt ||
          a.id.localeCompare(b.id),
      )
      .map((row) => ({
        id: row.id,
        measuredOn: row.measuredOn,
        weightKg: row.weightKg,
        bodyFatPct: row.bodyFatPct,
        fatMethod: row.fatMethod,
        waistCm: row.waistCm,
        neckCm: row.neckCm,
        hipCm: row.hipCm,
        armCm: row.armCm,
        thighCm: row.thighCm,
        note: row.note === '' ? null : row.note,
        updatedAt: iso(row.clientUpdatedAt),
      }));
  }
}

/** O perfil do corpo (altura, nascimento, sexo, fator de atividade), ou `null` se ainda não foi preenchido. */
@Injectable()
export class BodyProfileSection implements ExportSection {
  private readonly db = inject(TRAINING_DB);
  readonly key = 'bodyProfile';

  async build(): Promise<unknown> {
    const row = (await this.db.bodyProfile.toArray())[0];
    if (row === undefined) return null;
    return {
      heightCm: row.heightCm,
      birthDate: row.birthDate,
      sex: row.sex,
      activityFactor: row.activityFactor,
      updatedAt: iso(row.clientUpdatedAt),
    };
  }
}

/** As seções do corpo no token da exportação: o `ExportService` não é editado, só junta o que estiver registrado. */
export function provideBodyExportSections(): Provider[] {
  return [
    { provide: TRAINING_EXPORT_SECTIONS, useClass: BodyEntriesSection, multi: true },
    { provide: TRAINING_EXPORT_SECTIONS, useClass: BodyProfileSection, multi: true },
  ];
}
