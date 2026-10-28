import type { Provider } from '@angular/core';
import { PhotoStore } from './photo-store';
import { ProgressPhotoSync } from './progress-photo-sync';

/**
 * Tudo o que as fotos de progresso registram no módulo: bytes locais e a fila binária privada. Não há recurso sincronizável
 * genérico nem seção da exportação: o JPEG não entra na fila JSON nem no documento exportado. `provideTrainingData` o chama
 * numa linha só.
 */
export function providePhotoData(): Provider[] {
  return [PhotoStore, ProgressPhotoSync];
}
