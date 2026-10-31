import type { Provider } from '@angular/core';
import { PhotoStore } from './photo-store';

/**
 * Tudo o que as fotos de progresso registram no módulo: os bytes locais. Não há recurso sincronizável nem seção da
 * exportação: o JPEG não entra na fila JSON nem no documento exportado, e a cópia na nuvem foi aposentada. `provideTrainingData`
 * o chama numa linha só.
 */
export function providePhotoData(): Provider[] {
  return [PhotoStore];
}
