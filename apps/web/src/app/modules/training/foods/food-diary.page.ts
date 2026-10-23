import { ChangeDetectionStrategy, Component, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { FoodRepository, type OwnFoodDraft } from '../data/foods/food-repository';
import type { LocalFood } from '../data/foods/food';
import { MealRepository, type MealDraft } from '../data/meals/meal-repository';
import { type LocalMealEntry, type MealType } from '../data/meals/meal';

type EntryMode = 'food' | 'free';
type SearchState =
  'idle' | 'loading' | 'ok' | 'offline' | 'rate-limited' | 'not-configured' | 'unavailable';

@Component({
  selector: 'app-food-diary-page',
  imports: [RouterLink],
  template: `
    <main class="page" aria-labelledby="diary-title">
      <header class="page-header">
        <a routerLink="/treino/corpo" class="back" i18n="@@training.food.back">Corpo</a>
        <h1 id="diary-title" i18n="@@training.food.title">Diário alimentar</h1>
      </header>

      <section class="day-card" aria-label="{{ dayLabel }}">
        <button
          type="button"
          class="day-step"
          (click)="moveDay(-1)"
          [attr.aria-label]="previousDayLabel"
          i18n
        >
          ‹
        </button>
        <label for="diary-day" i18n="@@training.food.day">Dia</label>
        <input id="diary-day" type="date" [value]="day()" (change)="changeDay($event)" />
        <button
          type="button"
          class="day-step"
          (click)="moveDay(1)"
          [disabled]="day() >= today"
          [attr.aria-label]="nextDayLabel"
          i18n
        >
          ›
        </button>
      </section>

      @if (!loaded()) {
        <p role="status" class="notice" i18n="@@training.food.loading">Carregando lançamentos…</p>
      } @else if (loadError()) {
        <section class="error" role="alert">
          <p>{{ loadError() }}</p>
          <button type="button" class="secondary" (click)="loadDay()" i18n="@@training.food.retry">
            Tentar novamente
          </button>
        </section>
      } @else if (entries().length === 0) {
        <section class="empty">
          <h2 i18n="@@training.food.empty-title">Nada registrado neste dia</h2>
          <p i18n="@@training.food.empty-text">
            Se quiser, registre uma refeição para acompanhar seus dados.
          </p>
        </section>
      }

      @for (group of groups; track group.type) {
        <section class="meal-group" [attr.aria-labelledby]="'group-' + group.type">
          <div class="group-heading">
            <h2 [id]="'group-' + group.type">{{ group.label }}</h2>
            <span
              >{{ groupKcal(group.type) }} <span i18n="@@training.food.kcal-short">kcal</span></span
            >
          </div>
          @for (entry of groupEntries(group.type); track entry.id) {
            <article class="entry">
              <div class="entry-main">
                <strong>{{ entry.name }}</strong>
                <span i18n="@@training.food.entry-quantity"
                  >{{ entry.quantityGrams }} g · {{ entry.kcal }} kcal</span
                >
                @if (entry.note) {
                  <small>{{ entry.note }}</small>
                }
              </div>
              <div class="entry-actions">
                <button
                  type="button"
                  class="text-button"
                  (click)="edit(entry)"
                  [attr.aria-label]="editLabel(entry.name)"
                  i18n="@@training.food.edit"
                >
                  Editar
                </button>
                @if (confirmDelete() === entry.id) {
                  <button
                    type="button"
                    class="text-button danger"
                    (click)="remove(entry)"
                    [disabled]="deletingId() === entry.id"
                    i18n="@@training.food.confirm-delete"
                  >
                    Confirmar
                  </button>
                  <button
                    type="button"
                    class="text-button"
                    (click)="confirmDelete.set(null)"
                    i18n="@@common.cancel"
                  >
                    Cancelar
                  </button>
                } @else {
                  <button
                    type="button"
                    class="text-button danger"
                    (click)="confirmDelete.set(entry.id)"
                    [attr.aria-label]="deleteLabel(entry.name)"
                    i18n="@@training.food.delete"
                  >
                    Apagar
                  </button>
                }
              </div>
            </article>
          }
        </section>
      }

      <section class="editor" aria-labelledby="entry-title">
        <h2 id="entry-title">{{ editingId() ? editHeading : addHeading }}</h2>
        <div class="field-grid">
          <div class="field">
            <span i18n="@@training.food.meal-type">Refeição</span>
            <div
              class="meal-type-grid"
              role="group"
              aria-label="Refeição"
              i18n-aria-label="@@training.food.meal-type"
            >
              @for (group of groups; track group.type) {
                <button
                  type="button"
                  [attr.aria-pressed]="mealType() === group.type"
                  (click)="mealType.set(group.type)"
                >
                  {{ group.label }}
                </button>
              }
            </div>
          </div>
          <div class="field">
            <label for="entry-time" i18n="@@training.food.time">Horário (opcional)</label>
            <input
              id="entry-time"
              type="time"
              [value]="time()"
              (input)="time.set($any($event.target).value)"
            />
          </div>
        </div>
        <div class="mode-tabs" role="group" [attr.aria-label]="entryModeLabel">
          <button
            type="button"
            [attr.aria-pressed]="mode() === 'food'"
            (click)="mode.set('food')"
            i18n="@@training.food.mode-food"
          >
            Alimento
          </button>
          <button
            type="button"
            [attr.aria-pressed]="mode() === 'free'"
            (click)="mode.set('free')"
            i18n="@@training.food.mode-free"
          >
            Lançamento livre
          </button>
        </div>

        @if (mode() === 'food') {
          <div class="field search-field">
            <label for="food-search" i18n="@@training.food.search">Buscar alimento</label>
            <div class="search-row">
              <input
                id="food-search"
                type="search"
                maxlength="80"
                [value]="query()"
                (input)="query.set($any($event.target).value)"
                (keydown.enter)="search()"
                placeholder="Ex.: arroz"
                i18n-placeholder="@@training.food.search-placeholder"
              />
              <button
                type="button"
                class="secondary"
                (click)="search()"
                [disabled]="searching()"
                i18n="@@training.food.search-action"
              >
                Buscar
              </button>
            </div>
            @if (searchMessage()) {
              <p class="notice" role="status">{{ searchMessage() }}</p>
            }
            @if (searchState() === 'loading') {
              <p role="status" class="muted" i18n="@@training.food.searching">Buscando…</p>
            }
            @if (foods().length > 0) {
              <ul class="food-results" aria-label="{{ resultsLabel }}">
                @for (food of foods(); track food.id) {
                  <li>
                    <button
                      type="button"
                      class="food-result"
                      [class.selected]="selectedFood()?.id === food.id"
                      (click)="selectFood(food)"
                    >
                      <span
                        ><strong>{{ food.name }}</strong>
                        @if (food.brand) {
                          <small>{{ food.brand }}</small>
                        }
                      </span>
                      <span i18n="@@training.food.kcal-per-100g"
                        >{{ food.kcalPer100g }} kcal/100 g</span
                      >
                    </button>
                    @if (food.attribution) {
                      <small class="attribution">{{ food.attribution }}</small>
                    }
                  </li>
                }
              </ul>
            }
          </div>
          @if (selectedFood(); as food) {
            <div class="selected-food">
              <strong>{{ food.name }}</strong>
              <div class="field">
                <label for="quantity" i18n="@@training.food.quantity">Quantidade em gramas</label>
                <input
                  id="quantity"
                  type="number"
                  inputmode="decimal"
                  i18n-inputmode="@@common.input.decimal"
                  min="0.01"
                  max="10000"
                  step="0.01"
                  [value]="grams()"
                  (input)="grams.set($any($event.target).value)"
                />
              </div>
              <p class="nutrition-line" i18n="@@training.food.nutrition-preview">
                {{ scaledKcal() }} kcal · P {{ scaledProtein() }} g · C {{ scaledCarbs() }} g · G
                {{ scaledFat() }} g
              </p>
            </div>
          }
          <details class="own-food">
            <summary i18n="@@training.food.create-own">Cadastrar alimento próprio</summary>
            <div class="own-form">
              <div class="field">
                <label for="own-name" i18n="@@training.food.food-name">Nome</label
                ><input
                  id="own-name"
                  maxlength="160"
                  [value]="ownName()"
                  (input)="ownName.set($any($event.target).value)"
                />
              </div>
              <div class="field">
                <label for="own-brand" i18n="@@training.food.brand">Marca (opcional)</label
                ><input
                  id="own-brand"
                  maxlength="120"
                  [value]="ownBrand()"
                  (input)="ownBrand.set($any($event.target).value)"
                />
              </div>
              <p class="muted" i18n="@@training.food.per-100g">Valores por 100 g</p>
              <div class="nutrient-grid">
                <div class="field">
                  <label for="own-kcal" i18n="@@training.food.kcal">Energia (kcal)</label
                  ><input
                    id="own-kcal"
                    type="number"
                    min="0"
                    max="99999.99"
                    step="0.01"
                    [value]="ownKcal()"
                    (input)="ownKcal.set($any($event.target).value)"
                  />
                </div>
                <div class="field">
                  <label for="own-protein" i18n="@@training.food.protein">Proteína (g)</label
                  ><input
                    id="own-protein"
                    type="number"
                    min="0"
                    max="99999.99"
                    step="0.01"
                    [value]="ownProtein()"
                    (input)="ownProtein.set($any($event.target).value)"
                  />
                </div>
                <div class="field">
                  <label for="own-carbs" i18n="@@training.food.carbs">Carboidratos (g)</label
                  ><input
                    id="own-carbs"
                    type="number"
                    min="0"
                    max="99999.99"
                    step="0.01"
                    [value]="ownCarbs()"
                    (input)="ownCarbs.set($any($event.target).value)"
                  />
                </div>
                <div class="field">
                  <label for="own-fat" i18n="@@training.food.fat">Gorduras (g)</label
                  ><input
                    id="own-fat"
                    type="number"
                    min="0"
                    max="99999.99"
                    step="0.01"
                    [value]="ownFat()"
                    (input)="ownFat.set($any($event.target).value)"
                  />
                </div>
              </div>
              <button
                type="button"
                class="secondary"
                (click)="saveOwnFood()"
                [disabled]="savingFood()"
                i18n="@@training.food.save-food"
              >
                Salvar alimento
              </button>
            </div>
          </details>
        } @else {
          <div class="field">
            <label for="free-name" i18n="@@training.food.free-name">Descrição do lançamento</label
            ><input
              id="free-name"
              maxlength="160"
              [value]="freeName()"
              (input)="freeName.set($any($event.target).value)"
            />
          </div>
          <p class="muted" i18n="@@training.food.explicit-values">
            Informe os valores nutricionais desta porção. Zero é um valor válido.
          </p>
          <div class="nutrient-grid">
            <div class="field">
              <label for="free-kcal" i18n="@@training.food.kcal">Energia (kcal)</label
              ><input
                id="free-kcal"
                type="number"
                min="0"
                max="99999.99"
                step="0.01"
                [value]="freeKcal()"
                (input)="freeKcal.set($any($event.target).value)"
              />
            </div>
            <div class="field">
              <label for="free-protein" i18n="@@training.food.protein">Proteína (g)</label
              ><input
                id="free-protein"
                type="number"
                min="0"
                max="99999.99"
                step="0.01"
                [value]="freeProtein()"
                (input)="freeProtein.set($any($event.target).value)"
              />
            </div>
            <div class="field">
              <label for="free-carbs" i18n="@@training.food.carbs">Carboidratos (g)</label
              ><input
                id="free-carbs"
                type="number"
                min="0"
                max="99999.99"
                step="0.01"
                [value]="freeCarbs()"
                (input)="freeCarbs.set($any($event.target).value)"
              />
            </div>
            <div class="field">
              <label for="free-fat" i18n="@@training.food.fat">Gorduras (g)</label
              ><input
                id="free-fat"
                type="number"
                min="0"
                max="99999.99"
                step="0.01"
                [value]="freeFat()"
                (input)="freeFat.set($any($event.target).value)"
              />
            </div>
          </div>
        }
        <div class="field">
          <label for="entry-note" i18n="@@training.food.note">Observação (opcional)</label
          ><input
            id="entry-note"
            maxlength="300"
            [value]="note()"
            (input)="note.set($any($event.target).value)"
          />
        </div>
        @if (formError()) {
          <p class="error" role="alert">{{ formError() }}</p>
        }
        <div class="form-actions">
          <button type="button" class="primary" (click)="saveEntry()" [disabled]="saving()">
            {{ editingId() ? saveEditLabel : saveLabel }}
          </button>
          @if (editingId()) {
            <button type="button" class="secondary" (click)="resetForm()" i18n="@@common.cancel">
              Cancelar
            </button>
          }
        </div>
      </section>
      <p class="footer-note" i18n="@@training.food.disclaimer">
        Os valores dependem dos dados cadastrados e servem apenas para registro pessoal.
      </p>
      @if (savedMessage()) {
        <p class="saved" role="status">{{ savedMessage() }}</p>
      }
    </main>
  `,
  styleUrl: './food-diary.page.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FoodDiaryPage {
  private readonly meals = inject(MealRepository);
  private readonly foodRepository = inject(FoodRepository);
  protected readonly today = this.meals.today();
  protected readonly day = signal(this.today);
  protected readonly loaded = signal(false);
  protected readonly loadError = signal('');
  protected readonly entries = signal<LocalMealEntry[]>([]);
  protected readonly foods = signal<LocalFood[]>([]);
  protected readonly selectedFood = signal<LocalFood | null>(null);
  protected readonly mode = signal<EntryMode>('food');
  protected readonly mealType = signal<MealType>('breakfast');
  protected readonly query = signal('');
  protected readonly grams = signal('100');
  protected readonly time = signal('');
  protected readonly note = signal('');
  protected readonly freeName = signal('');
  protected readonly freeKcal = signal('');
  protected readonly freeProtein = signal('');
  protected readonly freeCarbs = signal('');
  protected readonly freeFat = signal('');
  protected readonly ownName = signal('');
  protected readonly ownBrand = signal('');
  protected readonly ownKcal = signal('');
  protected readonly ownProtein = signal('');
  protected readonly ownCarbs = signal('');
  protected readonly ownFat = signal('');
  protected readonly editingId = signal<string | null>(null);
  protected readonly confirmDelete = signal<string | null>(null);
  protected readonly searchState = signal<SearchState>('idle');
  protected readonly searching = signal(false);
  protected readonly formError = signal('');
  protected readonly savedMessage = signal('');
  protected readonly groups = [
    { type: 'breakfast' as const, label: $localize`:@@training.food.breakfast:Café da manhã` },
    { type: 'lunch' as const, label: $localize`:@@training.food.lunch:Almoço` },
    { type: 'snack' as const, label: $localize`:@@training.food.snack:Lanche` },
    { type: 'dinner' as const, label: $localize`:@@training.food.dinner:Jantar` },
    { type: 'other' as const, label: $localize`:@@training.food.other:Outros` },
  ];
  protected readonly dayLabel = $localize`:@@training.food.day-label:Lançamentos por dia`;
  protected readonly previousDayLabel = $localize`:@@training.food.previous-day:Dia anterior`;
  protected readonly nextDayLabel = $localize`:@@training.food.next-day:Dia seguinte`;
  protected readonly resultsLabel = $localize`:@@training.food.results:Resultados de alimentos`;
  protected readonly entryModeLabel = $localize`:@@training.food.entry-mode:Tipo de lançamento`;
  protected readonly addHeading = $localize`:@@training.food.add-heading:Adicionar refeição`;
  protected readonly editHeading = $localize`:@@training.food.edit-heading:Editar refeição`;
  protected readonly saveLabel = $localize`:@@training.food.save-entry:Registrar refeição`;
  protected readonly saveEditLabel = $localize`:@@training.food.save-edit:Salvar alterações`;
  protected readonly editLabel = (name: string) =>
    $localize`:@@training.food.edit-label:Editar ${name}:name:`;
  protected readonly deleteLabel = (name: string) =>
    $localize`:@@training.food.delete-label:Apagar ${name}:name:`;
  protected readonly scaledKcal = () => this.scaled('kcal');
  protected readonly scaledProtein = () => this.scaled('proteinG');
  protected readonly scaledCarbs = () => this.scaled('carbsPer100g');
  protected readonly scaledFat = () => this.scaled('fatPer100g');
  protected readonly saving = signal(false);
  protected readonly savingFood = signal(false);
  protected readonly deletingId = signal<string | null>(null);
  private dayLoad = 0;
  private searchRequest = 0;
  private localSearchRequest = 0;
  private editRequest = 0;
  private observedQuery = '';

  constructor() {
    effect(() => {
      this.meals.revision();
      void this.loadDay();
    });
    effect(() => {
      this.foodRepository.revision();
      const query = this.query().trim();
      const request = ++this.localSearchRequest;
      if (query !== this.observedQuery) {
        this.observedQuery = query;
        this.searchRequest++;
        this.searching.set(false);
        if (this.searchState() === 'loading') this.searchState.set('idle');
      }
      if (query) void this.refreshLocalSearch(query, request);
      else this.foods.set([]);
    });
  }

  protected async loadDay(): Promise<void> {
    const request = ++this.dayLoad;
    const day = this.day();
    this.loaded.set(false);
    this.loadError.set('');
    try {
      const entries = await this.meals.entriesOf(day);
      if (request === this.dayLoad && day === this.day()) this.entries.set(entries);
    } catch {
      if (request === this.dayLoad && day === this.day()) {
        this.entries.set([]);
        this.loadError.set(
          $localize`:@@training.food.load-failed:Não foi possível ler os lançamentos deste dia. Tente novamente.`,
        );
      }
    } finally {
      if (request === this.dayLoad && day === this.day()) this.loaded.set(true);
    }
  }

  protected async changeDay(event: Event): Promise<void> {
    const requested = (event.target as HTMLInputElement).value;
    this.day.set(requested && requested <= this.today ? requested : this.today);
    this.resetForm();
    await this.loadDay();
  }

  protected async moveDay(offset: number): Promise<void> {
    const date = new Date(`${this.day()}T12:00:00`);
    date.setDate(date.getDate() + offset);
    const next = localDate(date);
    if (next > this.today) return;
    this.day.set(next);
    this.resetForm();
    await this.loadDay();
  }

  protected groupEntries(type: MealType): LocalMealEntry[] {
    return this.entries().filter((entry) => entry.mealType === type);
  }

  protected groupKcal(type: MealType): number {
    return this.groupEntries(type).reduce((sum, entry) => sum + entry.kcal, 0);
  }

  protected async search(): Promise<void> {
    const query = this.query().trim();
    const request = ++this.searchRequest;
    this.searching.set(true);
    this.searchState.set('loading');
    try {
      const result = await this.foodRepository.searchOnline(query);
      if (request !== this.searchRequest || query !== this.query().trim()) return;
      this.foods.set([...result.foods]);
      this.searchState.set(result.status === 'invalid-query' ? 'ok' : result.status);
    } catch {
      if (request !== this.searchRequest || query !== this.query().trim()) return;
      this.searchState.set('unavailable');
    } finally {
      if (request === this.searchRequest) this.searching.set(false);
    }
  }

  private async refreshLocalSearch(query: string, request: number): Promise<void> {
    try {
      const foods = await this.foodRepository.searchLocal(query);
      if (request === this.localSearchRequest && query === this.query().trim())
        this.foods.set(foods);
    } catch {
      if (request === this.localSearchRequest && query === this.query().trim()) {
        this.foods.set([]);
        this.searchState.set('unavailable');
      }
    }
  }

  protected searchMessage(): string {
    switch (this.searchState()) {
      case 'offline':
        return $localize`:@@training.food.offline:Sem conexão. Mostrando alimentos salvos neste aparelho; você ainda pode cadastrar um alimento próprio.`;
      case 'rate-limited':
        return $localize`:@@training.food.rate-limited:O catálogo externo recebeu muitas consultas. Os resultados locais continuam disponíveis.`;
      case 'not-configured':
        return $localize`:@@training.food.off-not-configured:O catálogo externo não está configurado. Você pode buscar alimentos locais ou cadastrar os seus.`;
      case 'unavailable':
        return $localize`:@@training.food.unavailable:Não foi possível consultar o catálogo externo. Os alimentos locais continuam disponíveis.`;
      default:
        return '';
    }
  }

  protected selectFood(food: LocalFood): void {
    this.selectedFood.set(food);
    this.mode.set('food');
    this.grams.set(String(food.defaultPortionGrams ?? 100));
  }

  protected async saveOwnFood(): Promise<void> {
    this.formError.set('');
    this.savingFood.set(true);
    const draft: OwnFoodDraft = {
      name: this.ownName(),
      brand: this.ownBrand(),
      kcalPer100g: this.num(this.ownKcal()),
      proteinPer100g: this.num(this.ownProtein()),
      carbsPer100g: this.num(this.ownCarbs()),
      fatPer100g: this.num(this.ownFat()),
    };
    try {
      const result = await this.foodRepository.saveOwn(draft);
      if (result.status !== 'saved') {
        this.formError.set(this.foodError(result.status));
        return;
      }
      this.ownName.set('');
      this.ownBrand.set('');
      this.ownKcal.set('');
      this.ownProtein.set('');
      this.ownCarbs.set('');
      this.ownFat.set('');
      this.searchRequest++;
      this.query.set(result.food.name);
      this.foods.set([result.food]);
      this.searching.set(false);
      this.searchState.set('ok');
      this.selectFood(result.food);
      this.savedMessage.set($localize`:@@training.food.food-saved:Alimento salvo neste aparelho.`);
    } catch {
      this.formError.set(this.foodError('unavailable'));
    } finally {
      this.savingFood.set(false);
    }
  }

  protected edit(entry: LocalMealEntry): void {
    const request = ++this.editRequest;
    this.editingId.set(entry.id);
    this.mealType.set(entry.mealType);
    this.time.set(entry.eatenAt === null ? '' : new Date(entry.eatenAt).toTimeString().slice(0, 5));
    this.note.set(entry.note);
    this.formError.set('');
    const food = this.foods().find((item) => item.id === entry.foodId);
    if (entry.foodId) {
      this.mode.set('food');
      this.selectedFood.set(null);
      void this.foodRepository
        .searchLocal(entry.name)
        .then((found) => {
          if (request !== this.editRequest || this.editingId() !== entry.id) return;
          const match = found.find((item) => item.id === entry.foodId);
          if (match) {
            this.selectFood(match);
            this.grams.set(String(entry.quantityGrams));
          } else this.useFreeEntry(entry);
        })
        .catch(() => {
          if (request === this.editRequest && this.editingId() === entry.id)
            this.useFreeEntry(entry);
        });
      if (food) {
        this.selectFood(food);
        this.grams.set(String(entry.quantityGrams));
      }
    } else this.useFreeEntry(entry);
    document.getElementById('entry-title')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  private useFreeEntry(entry: LocalMealEntry): void {
    this.mode.set('free');
    this.selectedFood.set(null);
    this.freeName.set(entry.name);
    this.freeKcal.set(String(entry.kcal));
    this.freeProtein.set(String(entry.proteinG));
    this.freeCarbs.set(String(entry.carbG));
    this.freeFat.set(String(entry.fatG));
  }

  protected async remove(entry: LocalMealEntry): Promise<void> {
    this.deletingId.set(entry.id);
    try {
      const result = await this.meals.softDelete(entry.id);
      this.confirmDelete.set(null);
      if (result.status === 'saved') {
        this.savedMessage.set($localize`:@@training.food.deleted:Refeição apagada.`);
        await this.loadDay();
      } else this.formError.set(this.mealError(result.status));
    } catch {
      this.formError.set(this.mealError('unavailable'));
    } finally {
      this.deletingId.set(null);
    }
  }

  protected async saveEntry(): Promise<void> {
    this.formError.set('');
    const eatenAt = this.time() ? this.dateTimeStamp(this.day(), this.time()) : null;
    let draft: MealDraft;
    if (this.mode() === 'food') {
      const food = this.selectedFood();
      if (!food) {
        this.formError.set(
          $localize`:@@training.food.choose-food:Escolha um alimento da lista ou cadastre um alimento próprio.`,
        );
        return;
      }
      draft = {
        foodId: food.id,
        grams: this.num(this.grams()),
        eatenOn: this.day(),
        mealType: this.mealType(),
        eatenAt,
        note: this.note(),
      };
    } else {
      draft = {
        name: this.freeName(),
        nutrition: {
          kcal: this.num(this.freeKcal()),
          proteinG: this.num(this.freeProtein()),
          carbG: this.num(this.freeCarbs()),
          fatG: this.num(this.freeFat()),
        },
        eatenOn: this.day(),
        mealType: this.mealType(),
        eatenAt,
        note: this.note(),
      };
    }
    this.saving.set(true);
    const id = this.editingId();
    try {
      const result = id ? await this.meals.editEntry(id, draft) : await this.meals.addEntry(draft);
      if (result.status !== 'saved') {
        this.formError.set(this.mealError(result.status));
        return;
      }
      this.resetForm();
      this.savedMessage.set(
        id
          ? $localize`:@@training.food.entry-updated:Refeição atualizada neste aparelho.`
          : $localize`:@@training.food.entry-saved:Refeição registrada neste aparelho.`,
      );
      await this.loadDay();
    } catch {
      this.formError.set(this.mealError('unavailable'));
    } finally {
      this.saving.set(false);
    }
  }

  protected resetForm(): void {
    this.editRequest++;
    this.editingId.set(null);
    this.selectedFood.set(null);
    this.mode.set('food');
    this.mealType.set('breakfast');
    this.query.set('');
    this.grams.set('100');
    this.time.set('');
    this.note.set('');
    this.freeName.set('');
    this.freeKcal.set('');
    this.freeProtein.set('');
    this.freeCarbs.set('');
    this.freeFat.set('');
    this.formError.set('');
  }

  private scaled(field: 'kcal' | 'proteinG' | 'carbsPer100g' | 'fatPer100g'): string {
    const food = this.selectedFood();
    const grams = this.num(this.grams());
    if (!food || !Number.isFinite(grams) || grams <= 0) return '—';
    const value =
      field === 'kcal'
        ? food.kcalPer100g
        : field === 'proteinG'
          ? food.proteinPer100g
          : field === 'carbsPer100g'
            ? food.carbsPer100g
            : food.fatPer100g;
    return (Math.round(value * grams) / 100).toLocaleString(undefined, {
      maximumFractionDigits: 2,
    });
  }

  private num(value: string): number {
    return value.trim() === '' ? Number.NaN : Number(value.replace(',', '.'));
  }
  private dateTimeStamp(day: string, time: string): number {
    return new Date(`${day}T${time}:00`).getTime();
  }
  private mealError(status: string): string {
    return status === 'storage-full'
      ? $localize`:@@training.food.storage-full:Sem espaço no aparelho para guardar a alteração. Libere espaço e tente de novo.`
      : status === 'not-found'
        ? $localize`:@@training.food.not-found:Este registro não está mais disponível. Atualize a lista e tente de novo.`
        : $localize`:@@training.food.invalid:Confira os campos e os limites indicados e tente novamente.`;
  }
  private foodError(status: string): string {
    return status === 'storage-full'
      ? $localize`:@@training.food.storage-full:Sem espaço no aparelho para guardar a alteração. Libere espaço e tente de novo.`
      : $localize`:@@training.food.invalid:Confira os campos e os limites indicados e tente novamente.`;
  }
}

function localDate(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}
