import { Injectable, effect, inject, signal, untracked } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { CatalogRepository } from '../../data/catalog/catalog-repository';
import type { LocalExercise } from '../../data/catalog/exercise';
import { ProgressRepository } from '../../data/progress/progress-repository';
import { TrainingSync } from '../../data/sync/training-sync';

/**
 * O que o mapa do corpo lê do banco local, sempre pelos repositórios e sem rede: os exercícios de cada músculo e as
 * séries da semana de cada um. Fica no componente da tela (e não no módulo), porque a lista de Exercícios tem o seu
 * próprio estado de filtros e o mapa não pode mexer nele.
 *
 * A contagem de exercícios segue a regra do filtro da lista (o músculo está entre os principais), então o "Ver todos (N)" do
 * painel promete exatamente o que a lista vai mostrar. O volume vem do progresso, que só conta o primeiro músculo principal
 * de cada exercício: os dois números podem diferir num exercício com dois músculos principais.
 */
@Injectable()
export class BodyMapData {
  private readonly catalog = inject(CatalogRepository);
  private readonly progress = inject(ProgressRepository);
  private readonly sync = inject(TrainingSync);
  private readonly runtime = inject(QUEUE_RUNTIME);

  private readonly _byMuscle = signal<ReadonlyMap<string, readonly LocalExercise[]>>(new Map());
  private readonly _total = signal(0);
  private readonly _ready = signal(false);
  private readonly _weekSets = signal<Readonly<Record<string, number>>>({});

  /** Verdadeiro depois da primeira leitura do catálogo no banco local. */
  readonly ready = this._ready.asReadonly();
  /** Quantos exercícios existem no catálogo (zero: o catálogo ainda não chegou ao aparelho). */
  readonly total = this._total.asReadonly();

  // Leituras assíncronas podem terminar fora de ordem; só a do pedido mais recente vale.
  private catalogTicket = 0;
  private volumeTicket = 0;

  constructor() {
    effect(() => {
      this.catalog.revision();
      untracked(() => void this.readCatalog());
    });
    // O volume muda quando chega treino novo do servidor (o fim de cada puxada) e quando o catálogo muda (o músculo de um
    // exercício foi corrigido).
    effect(() => {
      this.sync.lastPullAt();
      this.catalog.revision();
      untracked(() => void this.readVolume());
    });
  }

  /** Os exercícios que têm o músculo entre os principais, por nome. */
  exercises(muscle: string): readonly LocalExercise[] {
    return this._byMuscle().get(muscle) ?? [];
  }

  exerciseCount(muscle: string): number {
    return this.exercises(muscle).length;
  }

  /** Séries de trabalho do músculo na semana de hoje (segunda a domingo). */
  weekSets(muscle: string): number {
    return this._weekSets()[muscle] ?? 0;
  }

  private async readCatalog(): Promise<void> {
    const ticket = ++this.catalogTicket;
    const rows = await this.catalog.search();
    if (ticket !== this.catalogTicket) return;
    const grouped = new Map<string, LocalExercise[]>();
    for (const row of rows) {
      for (const muscle of new Set(row.primaryMuscles)) {
        const list = grouped.get(muscle);
        if (list) list.push(row);
        else grouped.set(muscle, [row]);
      }
    }
    this._byMuscle.set(grouped);
    this._total.set(rows.length);
    this._ready.set(true);
  }

  private async readVolume(): Promise<void> {
    const ticket = ++this.volumeTicket;
    try {
      const { volume } = await this.progress.weekVolume(this.runtime.now());
      if (ticket === this.volumeTicket) this._weekSets.set(volume.byMuscle);
    } catch {
      // Sem a leitura do volume o desenho fica neutro (como "sem registro"); o mapa não depende dele.
    }
  }
}
