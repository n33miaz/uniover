import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Location } from '@angular/common';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { ConnectivityService } from '../../../../core/connectivity/connectivity.service';
import { CatalogStore } from '../../data/catalog/catalog-store';
import { TrainingSync } from '../../data/sync/training-sync';
import {
  EQUIPMENT_IDS,
  MUSCLE_GROUP_IDS,
  equipmentLabel,
  muscleGroupLabel,
  muscleLabel,
} from '../../domain/taxonomy';
import { awaitingFirstPull } from '../../shell/first-pull';
import { ExercisesSwitch } from '../../shell/exercises-switch';
import { ChipOption, TrainingChips } from '../../shell/training-chips';
import { TrainingGlyph } from '../../shell/training-glyph';
import { ExerciseRowBody } from '../exercise-row-body';
import { LastSetLabels } from '../last-set-labels';
import {
  LibraryParams,
  isFiltered,
  parseLibraryParams,
  toCatalogQuery,
  toQueryParams,
} from './library-params';
import { TrainingRowsSkeleton } from '../../shell/training-rows-skeleton';

/** Quantas linhas a lista mostra de cada vez; o resto vem em "Mostrar mais". */
export const PAGE_SIZE = 50;
/** Espera depois da última tecla antes de gravar a busca no endereço. */
const SEARCH_URL_DELAY_MS = 300;
/** Espera depois da última tecla antes de reler o catálogo: digitar não refaz a leitura do banco a cada letra. */
export const SEARCH_QUERY_DELAY_MS = 150;

/**
 * Catálogo de exercícios: busca (sem acento e sem caixa), filtros por grupo e equipamento e a lista. Tudo vem do
 * banco local, sem rede. Os filtros moram no endereço (`?q=&group=&muscle=&equipment=`) para o mapa do corpo abrir a
 * lista já filtrada e o botão "voltar" trazer de volta a lista como estava; a tela escreve o endereço trocando a entrada
 * do histórico (a lista é uma entrada só, por mais que o filtro mude).
 */
@Component({
  selector: 'app-exercise-library-page',
  imports: [
    RouterLink,
    ExercisesSwitch,
    TrainingChips,
    TrainingGlyph,
    ExerciseRowBody,
    TrainingRowsSkeleton,
  ],
  providers: [LastSetLabels],
  templateUrl: './library.page.html',
  styleUrl: './library.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExerciseLibraryPage {
  protected readonly loadingLabel = $localize`:@@training.library.loading:Carregando os exercícios…`;
  private readonly store = inject(CatalogStore);
  private readonly sync = inject(TrainingSync);
  private readonly connectivity = inject(ConnectivityService);
  private readonly route = inject(ActivatedRoute);
  private readonly location = inject(Location);
  private readonly lastSets = inject(LastSetLabels);

  protected readonly text = signal('');
  protected readonly group = signal('');
  protected readonly muscle = signal('');
  protected readonly equipment = signal('');
  /** O bloco de equipamento abre sozinho quando já há um equipamento escolhido (vindo do endereço). */
  protected readonly equipmentOpen = signal(false);
  private readonly limit = signal(PAGE_SIZE);
  /** O texto que a lista de fato usa: acompanha `text` com a espera da digitação (o campo mostra `text` na hora). */
  private readonly searched = signal('');

  protected readonly ready = this.store.ready;
  protected readonly failed = this.store.failed;
  protected readonly total = this.store.total;
  protected readonly results = this.store.results;
  /** O aparelho está trazendo o catálogo agora, ou ainda vai começar (primeira abertura). */
  protected readonly downloading = computed(
    () => this.sync.pulling() || awaitingFirstPull(this.sync, this.connectivity),
  );
  protected readonly online = this.connectivity.online;
  protected readonly labels = this.lastSets.labels;

  protected readonly params = computed<LibraryParams>(() => ({
    q: this.text(),
    group: this.group(),
    muscle: this.muscle(),
    equipment: this.equipment(),
  }));
  protected readonly filtered = computed(() => isFiltered(this.params()));
  protected readonly shown = computed(() => this.results().slice(0, this.limit()));
  protected readonly hidden = computed(() => this.results().length - this.shown().length);

  protected readonly groupOptions = computed<readonly ChipOption[]>(() => [
    { id: '', label: $localize`:@@training.filter.all:Todos` },
    ...MUSCLE_GROUP_IDS.map((id) => ({ id, label: muscleGroupLabel(id) })),
  ]);
  protected readonly equipmentOptions = computed<readonly ChipOption[]>(() => [
    { id: '', label: $localize`:@@training.filter.all:Todos` },
    ...EQUIPMENT_IDS.filter((id) => id !== 'other').map((id) => ({
      id,
      label: equipmentLabel(id),
    })),
  ]);

  protected readonly muscleChipText = computed(() => {
    const name = muscleLabel(this.muscle());
    return $localize`:@@training.filter.muscle-chip:Músculo: ${name}:name:`;
  });
  protected readonly muscleRemoveLabel = computed(() => {
    const name = muscleLabel(this.muscle());
    return $localize`:@@training.filter.muscle-remove:Tirar o filtro de músculo: ${name}:name:`;
  });
  protected readonly equipmentToggleLabel = computed(() => {
    const name = this.equipment() ? equipmentLabel(this.equipment()) : '';
    return name
      ? $localize`:@@training.library.equipment-toggle-on:Equipamento: ${name}:name:`
      : $localize`:@@training.library.equipment-toggle:Equipamento`;
  });
  protected readonly groupFilterLabel = $localize`:@@training.filter.group:Filtrar por grupo muscular`;
  protected readonly equipmentFilterLabel = $localize`:@@training.filter.equipment:Filtrar por equipamento`;

  protected readonly countText = computed(() => {
    const count = this.results().length;
    const total = this.total();
    if (!this.filtered()) {
      return total === 1
        ? $localize`:@@training.library.count-one:1 exercício`
        : $localize`:@@training.library.count-many:${total}:total: exercícios`;
    }
    return count === 1
      ? $localize`:@@training.library.found-one:1 exercício achado`
      : $localize`:@@training.library.found-many:${count}:count: exercícios achados`;
  });

  /** O catálogo ainda não chegou ao aparelho (primeira abertura sem rede, ou o primeiro puxar em andamento). */
  protected readonly catalogEmpty = computed(() => this.ready() && this.total() === 0);
  /** Parâmetros do "Criar exercício": o texto que a busca não achou vira o nome sugerido. */
  protected readonly createParams = computed(() => {
    const name = this.text().trim();
    return name === '' ? {} : { nome: name };
  });

  private searchTimer: ReturnType<typeof setTimeout> | undefined;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor() {
    // O endereço que chega de fora: a primeira abertura, um link do mapa do corpo ou o botão "voltar". O que a própria
    // tela escreve (`mirror`) não passa pelo roteador e por isso não volta por aqui.
    this.route.queryParamMap.pipe(takeUntilDestroyed()).subscribe((map) => {
      const incoming = parseLibraryParams(map);
      this.setText(incoming.q);
      this.group.set(incoming.group);
      this.muscle.set(incoming.muscle);
      this.equipment.set(incoming.equipment);
      if (incoming.equipment) this.equipmentOpen.set(true);
    });

    // Tela -> banco local: cada mudança de filtro relê a lista, e a lista volta à primeira página.
    // Lê `searched` e não `text`: o texto ainda sendo digitado não refaz a leitura.
    effect(() => {
      const query = toCatalogQuery({
        q: this.searched(),
        group: this.group(),
        muscle: this.muscle(),
        equipment: this.equipment(),
      });
      this.store.setQuery(query);
      untracked(() => this.limit.set(PAGE_SIZE));
    });

    // O "seu último" só é lido para as linhas que aparecem.
    effect(() => {
      const visible = this.shown();
      untracked(() => this.lastSets.request(visible));
    });

    inject(DestroyRef).onDestroy(() => {
      clearTimeout(this.searchTimer);
      clearTimeout(this.queryTimer);
    });
  }

  protected onSearch(value: string): void {
    this.text.set(value);
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => this.mirror(), SEARCH_URL_DELAY_MS);
    clearTimeout(this.queryTimer);
    this.queryTimer = setTimeout(() => this.searched.set(this.text()), SEARCH_QUERY_DELAY_MS);
  }

  protected pickGroup(id: string): void {
    this.group.set(id);
    this.muscle.set('');
    this.mirror();
  }

  protected pickEquipment(id: string): void {
    this.equipment.set(id);
    this.mirror();
  }

  protected clearMuscle(): void {
    this.muscle.set('');
    this.mirror();
  }

  protected clearFilters(): void {
    this.setText('');
    this.group.set('');
    this.muscle.set('');
    this.equipment.set('');
    this.mirror();
  }

  protected toggleEquipment(): void {
    this.equipmentOpen.update((open) => !open);
  }

  /** Troca o texto da busca sem espera (endereço, limpar filtros): só a digitação é que espera. */
  private setText(value: string): void {
    clearTimeout(this.queryTimer);
    this.text.set(value);
    this.searched.set(value);
  }

  protected showMore(): void {
    this.limit.update((current) => current + PAGE_SIZE);
  }

  /** Antes de sair da lista, grava no endereço o que ainda estava na espera do teclado. */
  protected flush(): void {
    if (this.searchTimer === undefined) return;
    clearTimeout(this.searchTimer);
    this.mirror();
  }

  protected retryRead(): void {
    this.store.retry();
  }

  protected retryDownload(): void {
    void this.sync.pullNow();
  }

  /**
   * Escreve os filtros no endereço, trocando a entrada do histórico em vez de somar outra. É só o endereço do navegador
   * (`replaceState`): o roteador não navega, então a tela não é recriada, a barra de abas segue marcando "Exercícios" e a
   * escrita não corre contra o toque que leva à ficha. Quem voltar a esta entrada pelo histórico a traz com os filtros.
   */
  private mirror(): void {
    this.searchTimer = undefined;
    const query = new URLSearchParams();
    for (const [name, value] of Object.entries(toQueryParams(this.params()))) {
      if (typeof value === 'string' && value !== '') query.set(name, value);
    }
    const path = this.location.path().split('?')[0];
    this.location.replaceState(path, query.toString(), this.location.getState());
  }
}
