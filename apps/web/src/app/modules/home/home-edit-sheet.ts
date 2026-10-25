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
import { ModuleRegistry } from '../../core/modules/module-registry';
import { leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import { HomeGlyph, HomeGlyphName, moduleGlyph } from './home-glyph';

/**
 * Folha de edição da Início: sobe de baixo, sem botão de fechar (a saída é "Cancelar" ou "Aplicar").
 * Trabalha numa cópia; só "Aplicar" devolve a nova disposição. A folha desce antes de avisar o pai, que a tira do DOM.
 */
@Component({
  selector: 'app-home-edit-sheet',
  imports: [HomeGlyph],
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
  private leaving = false;

  ngOnInit(): void {
    this.draft.set(this.widgets());
  }

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.cancel());
    });
  }

  protected title(id: string): string {
    return this.registry.find(id)?.title ?? id;
  }

  protected glyph(id: string): HomeGlyphName {
    const module = this.registry.find(id);
    return module ? moduleGlyph(module.icon) : 'grid';
  }

  protected showLabel(id: string): string {
    return $localize`:@@home.sheet.show:Mostrar ${this.title(id)}:title: na Início`;
  }

  protected upLabel(id: string): string {
    return $localize`:@@home.sheet.up:Subir ${this.title(id)}:title:`;
  }

  protected downLabel(id: string): string {
    return $localize`:@@home.sheet.down:Descer ${this.title(id)}:title:`;
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
    this.leave(() => this.applied.emit(this.draft()));
  }

  protected cancel(event?: Event): void {
    event?.preventDefault(); // o pai tira a folha do DOM; evita o fechamento duplo do navegador
    this.leave(() => this.cancelled.emit());
  }

  /** Toca a descida da folha e só então avisa o pai; um segundo toque durante a descida não repete o aviso. */
  private leave(then: () => void): void {
    if (this.leaving) return;
    this.leaving = true;
    leaveDialog(this.dialog().nativeElement, then);
  }
}
