import { Injectable } from '@angular/core';
import { ScopedModuleSlug } from './module-slugs';

export type ModuleStatus = 'available' | 'soon';
export type ModuleIconName = 'tv' | 'activity';
export type WidgetSize = 'small' | 'wide';

export interface ModuleDefinition {
  readonly id: string;
  /** Primeiro segmento do caminho; também é o escopo do manifest do módulo. */
  readonly slug: ScopedModuleSlug;
  readonly title: string;
  /** Ação principal mostrada no bloco da Início. */
  readonly actionLabel: string;
  readonly icon: ModuleIconName;
  readonly status: ModuleStatus;
  readonly defaultSize: WidgetSize;
}

/** Catálogo dos módulos do app. Cada módulo novo entra aqui; a Início, o service worker e os ajustes leem daqui. */
@Injectable({ providedIn: 'root' })
export class ModuleRegistry {
  readonly modules: readonly ModuleDefinition[] = [
    {
      id: 'tv',
      slug: 'tv',
      title: $localize`:@@module.tv.title:TV`,
      actionLabel: $localize`:@@module.tv.action:Abrir controle`,
      icon: 'tv',
      status: 'available',
      defaultSize: 'small',
    },
    {
      id: 'training',
      slug: 'treino',
      title: $localize`:@@module.training.title:Treino`,
      actionLabel: $localize`:@@module.training.action:Ver treino`,
      icon: 'activity',
      status: 'soon',
      defaultSize: 'wide',
    },
  ];

  find(id: string): ModuleDefinition | undefined {
    return this.modules.find((module) => module.id === id);
  }

  path(module: ModuleDefinition): string {
    return `/${module.slug}`;
  }
}
