import type { Provider } from '@angular/core';
import { PhotoStore } from './photo-store';

/**
 * Tudo o que as fotos de progresso registram no módulo: só o acesso aos dados. De propósito NÃO há recurso sincronizável nem
 * seção da exportação: foto fica só no aparelho (nunca na fila, nunca puxada do servidor, nunca no JSON). `provideTrainingData`
 * o chama numa linha só.
 */
export function providePhotoData(): Provider[] {
  return [PhotoStore];
}
