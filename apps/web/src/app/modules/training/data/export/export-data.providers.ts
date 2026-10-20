import type { Provider } from '@angular/core';
import { ExportDelivery } from './export-delivery';
import { provideExportSections } from './export-sections';
import { ExportService } from './export-service';

/**
 * Tudo o que a exportação registra no módulo: o serviço, a entrega (baixar e compartilhar) e as seções do JSON que esta
 * camada de dados conhece. Outras áreas registram as seções delas no token `TRAINING_EXPORT_SECTIONS`.
 * `provideTrainingData` o chama numa linha só.
 */
export function provideExportData(): Provider[] {
  return [ExportService, ExportDelivery, ...provideExportSections()];
}
