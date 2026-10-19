import type { Provider } from '@angular/core';
import { ProgressRepository } from './progress-repository';

/**
 * Tudo o que o progresso registra no módulo: só o acesso de leitura aos dados (nada de recurso sincronizável: tudo é
 * derivado das séries). `provideTrainingData` o chama numa linha só.
 */
export function provideProgressData(): Provider[] {
  return [ProgressRepository];
}
