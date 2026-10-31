import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { PhotoInfo, PhotoUsage } from '../data/photos/photo';
import { PhotoStore } from '../data/photos/photo-store';
import { TrainingSheet } from '../shell/training-sheet';
import { formatBytes, formatFullDate } from './body-text';
import { BodyPhotosSkeleton } from './body-skeleton';

/** `src` é a miniatura da lista; a foto inteira só é lida ao ampliar ou comparar (`FullPhoto`). */
interface DisplayPhoto extends PhotoInfo {
  readonly src: string;
}

interface FullPhoto extends PhotoInfo {
  readonly src: string;
}

@Component({
  selector: 'app-body-photo-panel',
  imports: [TrainingSheet, BodyPhotosSkeleton],
  template: `
    <section class="photos" aria-labelledby="photos-title">
      <h2 id="photos-title" i18n="@@training.body.photos.title">Fotos de Progresso</h2>
      <p class="usage" aria-live="polite" i18n-aria-live="@@common.aria.polite">
        <span i18n="@@training.body.photos.usage">Fotos: {{ photoBytesText() }}</span>
        @if (usage()?.quotaBytes; as quota) {
          <span i18n="@@training.body.photos.quota-used">
            · {{ formatBytes(usage()?.usageBytes ?? 0) }} / {{ formatBytes(quota) }} do
            aparelho</span
          >
        }
      </p>
      <p class="retention" i18n="@@training.body.photos.retention">
        Se o navegador apagar os dados do site, suas fotos somem. Salve uma cópia de vez em quando.
      </p>
      <label class="primary ui-btn add-photo">
        <span i18n="@@training.body.photos.add">Tirar ou Escolher Foto</span>
        <input
          type="file"
          [attr.accept]="'image/*'"
          [attr.capture]="'environment'"
          (change)="add($event)"
        />
      </label>
      @if (error(); as message) {
        <p class="error" role="alert">{{ message }}</p>
      }
      @if (!loaded()) {
        <app-body-photos-skeleton />
      } @else if (photos().length) {
        <div class="grid">
          @for (photo of photos(); track photo.id) {
            <article class="photo-card">
              <button
                class="image-button"
                type="button"
                (click)="view(photo)"
                [attr.aria-label]="viewLabel(photo.takenOn)"
              >
                <img
                  [src]="photo.src"
                  [alt]="photoAlt(photo.takenOn)"
                  [attr.loading]="'lazy'"
                  [attr.decoding]="'async'"
                />
              </button>
              <time>{{ formatDate(photo.takenOn) }}</time>
              <button
                class="compare-choice secondary ui-btn"
                type="button"
                [attr.aria-pressed]="selected().includes(photo.id)"
                (click)="toggle(photo.id)"
                i18n="@@training.body.photos.compare-select"
              >
                Comparar
              </button>
              @if (confirmingId() === photo.id) {
                <div class="confirm" role="group" [attr.aria-label]="deleteLabel(photo.takenOn)">
                  <button
                    class="danger ui-btn"
                    type="button"
                    (click)="remove(photo.id)"
                    i18n="@@training.body.photos.confirm-delete"
                  >
                    Apagar Foto
                  </button>
                  <button
                    class="secondary ui-btn"
                    type="button"
                    (click)="confirmingId.set(null)"
                    i18n="@@training.body.photos.cancel"
                  >
                    Cancelar
                  </button>
                </div>
              } @else {
                <div class="photo-actions">
                  <button
                    class="secondary ui-btn"
                    type="button"
                    (click)="confirmingId.set(photo.id)"
                    [attr.aria-label]="deleteLabel(photo.takenOn)"
                    i18n="@@training.body.photos.delete"
                  >
                    Apagar
                  </button>
                  <button
                    class="secondary ui-btn"
                    type="button"
                    (click)="share(photo.id)"
                    [attr.aria-label]="shareLabel(photo.takenOn)"
                    i18n="@@training.body.photos.share"
                  >
                    Salvar
                  </button>
                </div>
              }
            </article>
          }
        </div>
      } @else {
        <p class="empty" i18n="@@training.body.photos.empty">
          Suas fotos de progresso ficam privadas neste aparelho.
        </p>
      }
      @if (comparison().length === 2) {
        <section class="comparison" aria-labelledby="compare-title">
          <h3 id="compare-title" i18n="@@training.body.photos.comparison">Comparação</h3>
          @for (photo of comparison(); track photo.id) {
            <figure>
              <img [src]="photo.src" [alt]="photoAlt(photo.takenOn)" [attr.decoding]="'async'" />
              <figcaption>{{ formatDate(photo.takenOn) }}</figcaption>
            </figure>
          }
        </section>
      }
      @if (viewing(); as photo) {
        <app-training-sheet [heading]="viewLabel(photo.takenOn)" (closed)="viewing.set(null)">
          <img class="large" [src]="photo.src" [alt]="photoAlt(photo.takenOn)" />
          <p>{{ formatDate(photo.takenOn) }}</p>
        </app-training-sheet>
      }
      @if (message(); as status) {
        <p role="status" aria-live="polite" i18n-aria-live="@@common.aria.polite">{{ status }}</p>
      }
    </section>
  `,
  styleUrl: './photo-panel.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BodyPhotoPanel {
  private readonly store = inject(PhotoStore);
  protected readonly photos = signal<readonly DisplayPhoto[]>([]);
  /** A lista só vale depois da primeira leitura do aparelho: antes disso "nenhuma foto" seria uma afirmação falsa. */
  protected readonly loaded = signal(false);
  protected readonly usage = signal<PhotoUsage | null>(null);
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly viewing = signal<FullPhoto | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly comparison = signal<readonly FullPhoto[]>([]);

  constructor() {
    effect(() => {
      this.store.revision();
      untracked(() => void this.load());
    });
  }

  protected formatBytes = formatBytes;
  protected formatDate = formatFullDate;
  protected photoBytesText = () => {
    const bytes = this.usage()?.photoBytes ?? 0;
    return bytes === 0 ? '0 KB' : formatBytes(bytes);
  };

  protected async add(event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    this.error.set('');
    this.message.set('');
    let result: Awaited<ReturnType<PhotoStore['add']>>;
    try {
      result = await this.store.add(file);
    } catch {
      input.value = '';
      this.error.set(
        $localize`:@@training.body.photos.save-error:Não foi possível salvar a foto neste aparelho. Tente novamente.`,
      );
      return;
    }
    input.value = '';
    if (result.status === 'storage-full') {
      this.error.set(
        $localize`:@@training.body.photos.quota:Sem espaço no aparelho para guardar esta foto. Salve ou apague uma foto e tente de novo.`,
      );
    } else if (result.status === 'invalid-image') {
      this.error.set(
        $localize`:@@training.body.photos.invalid:Não foi possível abrir esta imagem. Escolha outra foto.`,
      );
    } else {
      this.message.set($localize`:@@training.body.photos.saved:Foto salva só neste aparelho.`);
    }
    await this.load();
  }

  protected async toggle(id: string): Promise<void> {
    const current = this.selected();
    const next = current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id].slice(-2);
    this.selected.set(next);
    if (next.length !== 2) {
      this.comparison.set([]);
      return;
    }
    // A comparação mostra as duas fotos inteiras: só agora elas são lidas e viram `data:`.
    const pair = await Promise.all(next.map((value) => this.full(value)));
    // Se a seleção mudou enquanto as fotos eram lidas, esta resposta ficou velha.
    if (this.selected() !== next) return;
    this.comparison.set(pair.filter((photo): photo is FullPhoto => photo !== null));
  }

  protected async view(photo: DisplayPhoto): Promise<void> {
    const full = await this.full(photo.id);
    if (full !== null) this.viewing.set(full);
  }

  protected async remove(id: string): Promise<void> {
    await this.store.remove(id);
    this.confirmingId.set(null);
    this.selected.set(this.selected().filter((value) => value !== id));
    this.comparison.set([]);
    await this.load();
  }
  protected async share(id: string): Promise<void> {
    try {
      const outcome = await this.store.shareFile(id);
      this.message.set(
        outcome === 'shared'
          ? $localize`:@@training.body.photos.shared:Foto enviada para compartilhar.`
          : outcome === 'downloaded'
            ? $localize`:@@training.body.photos.downloaded:Uma cópia da foto foi salva.`
            : $localize`:@@training.body.photos.share-cancelled:Compartilhamento cancelado.`,
      );
    } catch {
      this.error.set(
        $localize`:@@training.body.photos.share-error:Não foi possível salvar ou compartilhar esta foto.`,
      );
    }
  }
  protected viewLabel(date: string): string {
    return $localize`:@@training.body.photos.view:Ver foto de ${formatFullDate(date)}:date:`;
  }
  protected deleteLabel(date: string): string {
    return $localize`:@@training.body.photos.delete-label:Apagar foto de ${formatFullDate(date)}:date:`;
  }
  protected shareLabel(date: string): string {
    return $localize`:@@training.body.photos.share-label:Salvar foto de ${formatFullDate(date)}:date:`;
  }
  protected photoAlt(date: string): string {
    return $localize`:@@training.body.photos.alt:Foto de progresso de ${formatFullDate(date)}:date:`;
  }

  /** A foto inteira (bytes em `data:`) de um id que ainda está na lista. */
  private async full(id: string): Promise<FullPhoto | null> {
    const info = this.photos().find((photo) => photo.id === id);
    if (info === undefined) return null;
    const src = await this.store.dataUrl(id).catch(() => null);
    return src === null ? null : { ...info, src };
  }

  private async load(): Promise<void> {
    try {
      const [items, usage] = await Promise.all([this.store.list(), this.store.usage()]);
      const photos = await Promise.all(
        items.map(async (photo) => ({
          ...photo,
          src: (await this.store.thumbUrl(photo.id)) ?? '',
        })),
      );
      this.photos.set(photos.filter((photo) => photo.src.startsWith('data:')));
      this.usage.set(usage);
    } catch {
      this.photos.set([]);
      this.usage.set(null);
      this.error.set(
        $localize`:@@training.body.photos.load-error:Não foi possível acessar as fotos salvas neste aparelho.`,
      );
    } finally {
      this.loaded.set(true);
    }
  }
}
