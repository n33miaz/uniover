import {
  ChangeDetectionStrategy,
  Component,
  effect,
  inject,
  signal,
  untracked,
} from '@angular/core';
import type { PhotoCloudState, PhotoInfo, PhotoUsage } from '../data/photos/photo';
import { PhotoStore } from '../data/photos/photo-store';
import { ProgressPhotoSync } from '../data/photos/progress-photo-sync';
import { TrainingSheet } from '../shell/training-sheet';
import { formatBytes, formatFullDate } from './body-text';

interface DisplayPhoto extends PhotoInfo {
  readonly src: string;
}

@Component({
  selector: 'app-body-photo-panel',
  imports: [TrainingSheet],
  template: `
    <section class="photos" aria-labelledby="photos-title">
      <h2 id="photos-title" i18n="@@training.body.photos.title">Fotos de Progresso</h2>
      @if (!sync.accepted()) {
        <section class="cloud-choice" aria-labelledby="cloud-title">
          <h3 id="cloud-title" i18n="@@training.body.photos.cloud-title">Fotos na Nuvem</h3>
          <p i18n="@@training.body.photos.cloud-description">
            Suas novas fotos vão para a nuvem privada, só sua. Para apagar, use Apagar na foto: a
            cópia na nuvem sai também.
          </p>
          <button
            class="secondary ui-btn"
            type="button"
            (click)="acceptCloud()"
            i18n="@@training.body.photos.cloud-accept"
          >
            Ativar Fotos na Nuvem
          </button>
        </section>
      } @else {
        <p class="cloud-status" aria-live="polite" i18n-aria-live="@@common.aria.polite">
          {{ cloudStatusLabel() }}
        </p>
        @if (hasUnsent()) {
          <button
            class="secondary ui-btn"
            type="button"
            (click)="sendDevicePhotos()"
            i18n="@@training.body.photos.cloud-send-device"
          >
            Enviar Fotos Deste Aparelho
          </button>
        }
        @if (hasErrors()) {
          <button
            class="secondary ui-btn"
            type="button"
            (click)="retryCloud()"
            i18n="@@training.body.photos.cloud-retry"
          >
            Tentar De Novo
          </button>
        }
      }
      <p class="usage" aria-live="polite" i18n-aria-live="@@common.aria.polite">
        <span i18n="@@training.body.photos.usage">Fotos: {{ photoBytesText() }}</span>
        @if (usage()?.quotaBytes; as quota) {
          <span i18n="@@training.body.photos.quota-used">
            · {{ formatBytes(usage()?.usageBytes ?? 0) }} / {{ formatBytes(quota) }} do
            aparelho</span
          >
        }
      </p>
      @if (cloudOn()) {
        <p class="retention" i18n="@@training.body.photos.retention-cloud">
          As fotos já enviadas ficam guardadas na nuvem privada. As que ainda não foram enviadas só
          existem neste aparelho.
        </p>
      } @else {
        <p class="retention" i18n="@@training.body.photos.retention">
          Se o navegador apagar os dados do site, suas fotos somem. Salve uma cópia de vez em
          quando.
        </p>
      }
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
      @if (photos().length) {
        <div class="grid">
          @for (photo of photos(); track photo.id) {
            <article class="photo-card" [class.cloud-photo]="isCloudPhoto(photo.id)">
              <button
                class="image-button"
                type="button"
                (click)="view(photo)"
                [attr.aria-label]="viewLabel(photo.takenOn)"
              >
                <img [src]="photo.src" [alt]="photoAlt(photo.takenOn)" />
              </button>
              <time>{{ formatDate(photo.takenOn) }}</time>
              <small class="storage-badge" [class.cloud]="isCloudPhoto(photo.id)">{{
                photoStorageLabel(photo.id)
              }}</small>
              @if (sync.stateOf(photo.id); as cloud) {
                @if (cloud.state !== 'cloud') {
                  <small class="cloud-photo-state">{{ photoCloudLabel(cloud.state) }}</small>
                }
              }
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
              <img [src]="photo.src" [alt]="photoAlt(photo.takenOn)" />
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
  protected readonly sync = inject(ProgressPhotoSync);
  protected readonly photos = signal<readonly DisplayPhoto[]>([]);
  protected readonly usage = signal<PhotoUsage | null>(null);
  protected readonly selected = signal<readonly string[]>([]);
  protected readonly confirmingId = signal<string | null>(null);
  protected readonly viewing = signal<DisplayPhoto | null>(null);
  protected readonly error = signal('');
  protected readonly message = signal('');
  protected readonly comparison = signal<readonly DisplayPhoto[]>([]);

  constructor() {
    effect(() => {
      this.store.revision();
      this.sync.revision();
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
      await this.sync.queueNew(result.photo.id);
      this.message.set(
        this.sync.accepted()
          ? $localize`:@@training.body.photos.saved-cloud:Foto salva e preparada para enviar.`
          : $localize`:@@training.body.photos.saved:Foto salva só neste aparelho.`,
      );
    }
    await this.load();
  }

  protected toggle(id: string): void {
    const current = this.selected();
    const next = current.includes(id)
      ? current.filter((value) => value !== id)
      : [...current, id].slice(-2);
    this.selected.set(next);
    this.comparison.set(
      next.length === 2
        ? next.map((value) => this.photos().find((photo) => photo.id === value)!).filter(Boolean)
        : [],
    );
  }

  protected view(photo: DisplayPhoto): void {
    this.viewing.set(photo);
  }
  protected async remove(id: string): Promise<void> {
    await this.sync.remove(id);
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

  protected async acceptCloud(): Promise<void> {
    this.error.set('');
    try {
      await this.sync.accept();
    } catch {
      this.error.set(
        $localize`:@@training.body.photos.cloud-accept-error:Não foi possível guardar sua escolha agora.`,
      );
    }
  }

  protected async sendDevicePhotos(): Promise<void> {
    await this.sync.sendDevicePhotos();
    this.message.set(
      $localize`:@@training.body.photos.cloud-send-status:As fotos deste aparelho foram preparadas para enviar.`,
    );
  }

  protected async retryCloud(): Promise<void> {
    await this.sync.retry();
  }

  /** Só oferece o envio manual quando há foto local que ainda não entrou na fila nem chegou à nuvem. */
  protected hasUnsent(): boolean {
    return this.sync.hasUnsent(this.photos().map((photo) => photo.id));
  }

  /** A nuvem está aceita neste aparelho e o servidor respondeu: o aviso de retenção muda. */
  protected cloudOn(): boolean {
    return this.sync.accepted() && this.sync.availability() === 'available';
  }

  protected hasErrors(): boolean {
    return this.photos().some((photo) => this.sync.stateOf(photo.id)?.state === 'error');
  }

  protected cloudStatusLabel(): string {
    switch (this.sync.availability()) {
      case 'checking':
        return $localize`:@@training.body.photos.cloud-checking:Conferindo a nuvem privada…`;
      case 'available':
        return $localize`:@@training.body.photos.cloud-ready:Nuvem privada ativa neste aparelho.`;
      case 'disabled':
        return $localize`:@@training.body.photos.cloud-disabled:Fotos na Nuvem está desligado no sistema.`;
      case 'unavailable':
        return $localize`:@@training.body.photos.cloud-unavailable:Nuvem privada indisponível. Suas fotos continuam neste aparelho.`;
      default:
        return $localize`:@@training.body.photos.cloud-waiting:Suas fotos continuam neste aparelho.`;
    }
  }

  protected photoCloudLabel(state: PhotoCloudState): string {
    switch (state) {
      case 'pending':
        return $localize`:@@training.body.photos.cloud-pending:Aguardando envio`;
      case 'uploading':
        return $localize`:@@training.body.photos.cloud-uploading:Enviando`;
      case 'error':
        return $localize`:@@training.body.photos.cloud-error:Erro ao enviar`;
      case 'cloud':
        return $localize`:@@training.body.photos.cloud-saved:Na nuvem privada`;
      case 'deleting':
        return $localize`:@@training.body.photos.cloud-deleting:Apagando`;
    }
  }

  /** O destino visível impede confundir o acompanhamento na nuvem com anexos de uma avaliação, que ficam locais. */
  protected isCloudPhoto(id: string): boolean {
    return this.sync.stateOf(id)?.state === 'cloud';
  }

  protected photoStorageLabel(id: string): string {
    return this.isCloudPhoto(id)
      ? $localize`:@@training.body.photos.storage-cloud:Nuvem Privada`
      : $localize`:@@training.body.photos.storage-device:Neste Aparelho`;
  }

  private async load(): Promise<void> {
    try {
      const [items, usage] = await Promise.all([this.store.list(), this.store.usage()]);
      const photos = await Promise.all(
        items.map(async (photo) => ({
          ...photo,
          src: (await this.store.dataUrl(photo.id)) ?? '',
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
    }
  }
}
