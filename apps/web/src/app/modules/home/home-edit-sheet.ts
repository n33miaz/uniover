import {
  Component,
  ElementRef,
  Injector,
  OnInit,
  afterNextRender,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { WidgetPref, moveWidget, moveWidgetTo } from '../../core/modules/module-prefs';
import { ModuleRegistry, WidgetSize } from '../../core/modules/module-registry';
import { Icon } from '../../shared/ui/icon/icon';

/**
 * Folha de edição da Início: sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou "Aplicar").
 * Trabalha numa cópia; só "Aplicar" devolve a nova disposição.
 */
@Component({
  selector: 'app-home-edit-sheet',
  imports: [Icon],
  templateUrl: './home-edit-sheet.html',
  styleUrl: './home-edit-sheet.css',
})
export class HomeEditSheet implements OnInit {
  private readonly registry = inject(ModuleRegistry);
  private readonly injector = inject(Injector);

  readonly widgets = input.required<readonly WidgetPref[]>();
  readonly applied = output<readonly WidgetPref[]>();
  readonly cancelled = output<void>();

  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly draft = signal<readonly WidgetPref[]>([]);
  protected readonly dragging = signal<string | null>(null);
  protected readonly sizes: readonly WidgetSize[] = ['small', 'wide'];

  ngOnInit(): void {
    this.draft.set(this.widgets());
  }

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      this.dialog().nativeElement.showModal();
    });
  }

  protected title(id: string): string {
    return this.registry.find(id)?.title ?? id;
  }

  protected upLabel(id: string): string {
    return $localize`:@@home.sheet.up:Subir ${this.title(id)}:title:`;
  }

  protected downLabel(id: string): string {
    return $localize`:@@home.sheet.down:Descer ${this.title(id)}:title:`;
  }

  protected sizeLabel(size: WidgetSize): string {
    return size === 'small'
      ? $localize`:@@home.size.small:Pequeno`
      : $localize`:@@home.size.wide:Largo`;
  }

  protected setSize(id: string, size: WidgetSize): void {
    this.draft.update((list) => list.map((item) => (item.id === id ? { ...item, size } : item)));
  }

  protected setEnabled(id: string, enabled: boolean): void {
    this.draft.update((list) => list.map((item) => (item.id === id ? { ...item, enabled } : item)));
  }

  protected move(id: string, delta: -1 | 1): void {
    this.draft.update((list) => moveWidget(list, id, delta));
    // O botão que o usuário apertou muda de lugar na lista; devolve o foco para ele (ou para o par, na ponta).
    afterNextRender(
      () => {
        const row = this.dialog().nativeElement.querySelector<HTMLElement>(`[data-id="${id}"]`);
        const wanted = row?.querySelector<HTMLButtonElement>(delta < 0 ? '.up' : '.down');
        (wanted && !wanted.disabled
          ? wanted
          : row?.querySelector<HTMLButtonElement>('button:not(:disabled)')
        )?.focus();
      },
      { injector: this.injector },
    );
  }

  protected startDrag(event: PointerEvent, id: string): void {
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    this.dragging.set(id);
  }

  protected dragOver(event: PointerEvent): void {
    const id = this.dragging();
    if (!id) return;
    const doc = this.dialog().nativeElement.ownerDocument;
    const target = doc
      .elementFromPoint?.(event.clientX, event.clientY)
      ?.closest<HTMLElement>('[data-id]');
    const overId = target?.dataset['id'];
    if (!overId || overId === id) return;
    const to = this.draft().findIndex((item) => item.id === overId);
    this.draft.update((list) => moveWidgetTo(list, id, to));
  }

  protected endDrag(): void {
    this.dragging.set(null);
  }

  protected apply(): void {
    this.applied.emit(this.draft());
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // o pai tira a folha do DOM; evita o fechamento duplo do navegador
    this.cancelled.emit();
  }
}
