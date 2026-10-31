import { Injectable, inject } from '@angular/core';
import { PcAvailability } from './pc-availability';
import { ScopedModuleSlug } from './module-slugs';

export type ModuleStatus = 'available' | 'soon';
export type ModuleIconName =
  'tv' | 'activity' | 'health' | 'monitor' | 'network' | 'backup' | 'bell' | 'desktop';
export type WidgetSize = 'small' | 'wide';

export interface ModuleDefinition {
  readonly id: string;
  /**
   * Primeiro segmento do caminho; também é o escopo do manifest do módulo. Só módulo que já tem tela tem `slug`:
   * um módulo apenas planejado não ganha rota, manifest nem escopo no service worker, e a Início o mostra sem link.
   */
  readonly slug?: ScopedModuleSlug;
  /**
   * Caminho de um módulo que tem tela mas mora dentro do app principal, sem manifest nem escopo próprios (não é um app
   * instalável à parte). Sem `slug` nem `route` o módulo é só planejado.
   */
  readonly route?: string;
  /**
   * O módulo só deixa de ser "Em Breve" quando a casa tem o que ele precisa: `pc-agent` pede um computador com o controle
   * do PC ligado. Enquanto isso o cartão fica como planejado, sem link.
   */
  readonly liveWith?: 'pc-agent';
  readonly title: string;
  /** Uma linha que diz para que serve o módulo (ou para que vai servir, quando ainda é "em breve"). */
  readonly description: string;
  /** Ação principal mostrada no bloco da Início; só existe junto com o `slug` ou o `route`. */
  readonly actionLabel?: string;
  readonly icon: ModuleIconName;
  readonly status: ModuleStatus;
  readonly defaultSize: WidgetSize;
}

/**
 * Catálogo dos módulos do app. Cada módulo novo entra aqui; a Início e os ajustes leem daqui, e o service worker
 * lê só `module-slugs.ts` (que lista os módulos que já têm tela). A ordem é a padrão da Início: o que já abre
 * primeiro, depois o que está a caminho, na ordem do plano.
 */
@Injectable({ providedIn: 'root' })
export class ModuleRegistry {
  private readonly pcAvailability = inject(PcAvailability);

  readonly modules: readonly ModuleDefinition[] = [
    {
      id: 'tv',
      slug: 'tv',
      title: $localize`:@@module.tv.title:TV`,
      description: $localize`:@@home.module.tv-hint:Ligar, volume, canais e apps`,
      actionLabel: $localize`:@@module.tv.action:Abrir controle`,
      icon: 'tv',
      status: 'available',
      defaultSize: 'small',
    },
    {
      id: 'training',
      slug: 'treino',
      title: $localize`:@@module.training.title:Treino`,
      description: $localize`:@@home.module.training-hint:Fichas, séries e progresso`,
      actionLabel: $localize`:@@module.training.action:Ver treino`,
      icon: 'activity',
      status: 'available',
      defaultSize: 'small',
    },
    {
      id: 'health',
      title: $localize`:@@module.health.title:Saúde e Eventos`,
      description: $localize`:@@module.health.hint:Aparelhos e linha do tempo`,
      icon: 'health',
      status: 'soon',
      defaultSize: 'small',
    },
    {
      id: 'monitor',
      title: $localize`:@@module.monitor.title:Monitor dos Serviços`,
      description: $localize`:@@module.monitor.hint:Seus serviços na internet`,
      icon: 'monitor',
      status: 'soon',
      defaultSize: 'small',
    },
    {
      id: 'network',
      title: $localize`:@@module.network.title:Rede da Casa`,
      description: $localize`:@@module.network.hint:A rede de casa num lugar só`,
      icon: 'network',
      status: 'soon',
      defaultSize: 'small',
    },
    {
      id: 'backup',
      title: $localize`:@@module.backup.title:Backup de Fotos`,
      description: $localize`:@@module.backup.hint:Cópia das fotos do Android`,
      icon: 'backup',
      status: 'soon',
      defaultSize: 'small',
    },
    {
      id: 'notifications',
      title: $localize`:@@module.notifications.title:Avisos`,
      description: $localize`:@@module.notifications.hint:Avisos e notificações`,
      icon: 'bell',
      status: 'soon',
      defaultSize: 'small',
    },
    {
      id: 'pc',
      route: 'pc',
      liveWith: 'pc-agent',
      title: $localize`:@@module.pc.title:Controle do PC`,
      description: $localize`:@@module.pc.hint:Mouse, teclado, mídia e energia`,
      actionLabel: $localize`:@@module.pc.action:Abrir controle`,
      icon: 'desktop',
      status: 'soon',
      defaultSize: 'small',
    },
  ];

  find(id: string): ModuleDefinition | undefined {
    return this.modules.find((module) => module.id === id);
  }

  /**
   * O que o módulo é agora: o do catálogo, exceto o que depende da casa (`liveWith`), que passa a "disponível" quando a casa
   * tem o que ele precisa. Quem desenha a Início e a folha de edição pergunta aqui, nunca ao campo `status`.
   */
  statusOf(module: ModuleDefinition): ModuleStatus {
    if (module.liveWith === 'pc-agent' && this.pcAvailability.available()) return 'available';
    return module.status;
  }

  /** Caminho da tela do módulo, ou `null` enquanto ele é só planejado (sem rota para abrir). */
  path(module: ModuleDefinition): string | null {
    const target = module.slug ?? module.route;
    return target && this.statusOf(module) === 'available' ? `/${target}` : null;
  }
}
