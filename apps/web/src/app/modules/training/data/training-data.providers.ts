import type { Provider } from '@angular/core';
import { CatalogRepository } from './catalog/catalog-repository';
import { CatalogStore } from './catalog/catalog-store';
import { CatalogWriter } from './catalog/catalog-writer';
import { ExercisesResourceSync } from './catalog/exercises-resource-sync';
import { provideRoutinesData } from './routines/routines-resource-sync';
import { provideResourceSync } from './sync/resource-sync';
import { TrainingSync } from './sync/training-sync';

/**
 * Provedores da camada de dados do Treino. A casca do módulo chama esta função nos `providers` da rota e, ao
 * entrar, chama `TrainingSync.start()`. Nada daqui vai para `app.config.ts`: o módulo só existe quando alguém
 * entra nele.
 *
 * Para um recurso novo sincronizável: crie a classe que implementa `ResourceSync` e acrescente UMA linha em
 * "Recursos sincronizáveis", copiando a do catálogo. As classes de acesso ao banco do recurso (repositório etc.)
 * entram na lista "Acesso aos dados", pois precisam viver no mesmo injetor que o `ResourceSync` que as usa.
 */
export function provideTrainingData(): Provider[] {
  return [
    // Puxador genérico (cursor, fila, gatilhos).
    TrainingSync,

    // Acesso aos dados do catálogo.
    CatalogRepository,
    CatalogStore,
    CatalogWriter,

    // Recursos sincronizáveis: uma linha por recurso.
    provideResourceSync(ExercisesResourceSync),

    // Fichas (rotinas): acesso aos dados e recurso sincronizável.
    ...provideRoutinesData(),
  ];
}
