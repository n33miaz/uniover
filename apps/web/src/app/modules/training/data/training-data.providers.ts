import type { Provider } from '@angular/core';
import { provideBodyExportSections } from './body/body-export-sections';
import { provideBodyData } from './body/body-resource-sync';
import { CatalogRepository } from './catalog/catalog-repository';
import { CatalogStore } from './catalog/catalog-store';
import { CatalogWriter } from './catalog/catalog-writer';
import { ExercisesResourceSync } from './catalog/exercises-resource-sync';
import { provideExportData } from './export/export-data.providers';
import { provideGoalsData } from './goals/goals-resource-sync';
import { provideFoodsData } from './foods/foods-resource-sync';
import { provideMealsData } from './meals/meals-resource-sync';
import { MealsExportSection } from './meals/meals-export-section';
import { TRAINING_EXPORT_SECTIONS } from './export/export-sections';
import { providePhotoData } from './photos/photo-data.providers';
import { PhysicalAssessmentRepository } from './physical-assessments/physical-assessment-repository';
import { PhysicalAssessmentExport } from './physical-assessments/physical-assessment-export';
import { provideProgressData } from './progress/progress-data.providers';
import { provideRoutinesData } from './routines/routines-resource-sync';
import { provideSessionsData } from './sessions/sessions-resource-sync';
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

    // Treino ao vivo: sessões, séries, timer de descanso e tela acesa.
    ...provideSessionsData(),

    // Metas do dono: acesso aos dados e recurso sincronizável.
    ...provideGoalsData(),

    // Alimentos e refeições: diário local com escrita pela fila e sincronização por cursor.
    ...provideFoodsData(),
    ...provideMealsData(),

    // Corpo: medições e perfil (acesso aos dados e recursos sincronizáveis).
    ...provideBodyData(),

    // Fotos de progresso: só neste aparelho (sem fila, sem leitura do servidor, fora da exportação).
    ...providePhotoData(),

    // Avaliações físicas históricas e documentos: armazenamento privado por conta, sem sincronização.
    PhysicalAssessmentRepository,
    PhysicalAssessmentExport,

    // Progresso: consultas de leitura, recalculadas das séries (nada a sincronizar).
    ...provideProgressData(),

    // Exportação em JSON e CSV, com as seções de dados do módulo.
    ...provideExportData(),

    // Seções do corpo na exportação em JSON (depois das que já existiam: a ordem das seções do arquivo não muda).
    ...provideBodyExportSections(),

    // Lançamentos de refeição no fim da exportação; os valores já estão congelados no registro.
    { provide: TRAINING_EXPORT_SECTIONS, useClass: MealsExportSection, multi: true },
  ];
}
