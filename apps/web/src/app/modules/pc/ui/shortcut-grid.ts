import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { PcInput } from '../data/pc-input';
import { PcPinned } from '../data/pc-pinned';
import {
  MAX_PINNED,
  SHORTCUTS,
  SHORTCUT_GROUPS,
  keysText,
  type PcShortcut,
  type ShortcutGroup,
} from '../data/pc-shortcuts';
import { PcStore } from '../data/pc-store';
import { PcSwitcher } from '../data/pc-switcher';
import type { PcKey } from '../data/pc-types';
import { tick } from '../input/haptics';
import { GROUP_LABEL, shortcutLabel } from './shortcut-labels';

interface Section {
  readonly id: ShortcutGroup | 'pinned';
  readonly title: string;
  readonly items: readonly PcShortcut[];
}

let nextGrid = 0;

/**
 * A grade de atalhos: "Fixados" no topo e depois os grupos (edição, janela, sistema, navegador, vídeo, apresentação). O
 * rótulo diz o que o atalho faz e a tecla aparece pequena embaixo. Tocar manda o atalho (as teclas armadas valem para ele)
 * e a grade continua como está: um segundo toque encadeia. No modo de edição, tocar fixa ou solta o atalho, e nada é
 * enviado. Bloquear é a ação de energia do PC (não a tecla Win+L, que a injeção de entrada não faz de forma confiável).
 */
@Component({
  selector: 'app-pc-shortcut-grid',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @for (section of sections(); track section.id) {
      <section class="group" [attr.aria-labelledby]="prefix + section.id">
        <h3 class="title" [id]="prefix + section.id">{{ section.title }}</h3>
        <div class="cells">
          @for (item of section.items; track item.id) {
            <button
              type="button"
              class="cell"
              [class.on]="editing() && pinned.isPinned(item.id)"
              [attr.aria-pressed]="editing() ? pinned.isPinned(item.id) : null"
              [attr.aria-expanded]="item.action.kind === 'goto-slide' ? gotoOpen() : null"
              [attr.data-shortcut]="item.id"
              [disabled]="!editing() && !store.canSend()"
              (click)="activate(item)"
            >
              <span class="name">{{ label(item) }}</span>
              @if (keys(item); as text) {
                <span class="keys">{{ text }}</span>
              }
            </button>
          }
        </div>
      </section>
    }
    @if (gotoOpen()) {
      <form class="goto" novalidate (submit)="goto($event, slide)">
        <label class="goto-label" for="{{ prefix }}slide" i18n="@@pc.sc.goto-label">
          Número do slide
        </label>
        <input
          #slide
          id="{{ prefix }}slide"
          class="goto-input"
          type="text"
          [attr.inputmode]="'numeric'"
          pattern="[0-9]*"
          maxlength="3"
          autocomplete="off"
        />
        <button type="submit" class="goto-go" [disabled]="!store.canSend()" i18n="@@pc.sc.goto-go">
          Ir
        </button>
      </form>
    }
    @if (note(); as message) {
      <p class="note" role="alert">{{ message }}</p>
    }
  `,
  styleUrls: ['./shortcut-grid.css'],
})
export class PcShortcutGrid {
  protected readonly store = inject(PcStore);
  protected readonly pinned = inject(PcPinned);
  private readonly input = inject(PcInput);
  protected readonly prefix = `sc-${nextGrid++}-`;

  constructor() {
    // O campo do número do slide recebe o foco ao abrir (o teclado numérico sobe) e a linha aparece inteira na folha.
    effect(() => {
      const field = this.slideField()?.nativeElement;
      if (!field) return;
      field.focus();
      field.closest('form')?.scrollIntoView?.({ block: 'nearest' });
    });
  }

  private readonly switcher = inject(PcSwitcher);

  /** Modo de edição: tocar fixa e solta, em vez de enviar. */
  readonly editing = input(false);
  /** O atalho começou algo que continua depois do toque (o "Trocar janela" segurou o Alt): quem tem a grade pode fechá-la. */
  readonly began = output<void>();
  /** O campo do número do slide está aberto. */
  protected readonly gotoOpen = signal(false);
  private readonly slideField = viewChild<ElementRef<HTMLInputElement>>('slide');

  /** Um aviso curto (a lista de fixados está cheia; a falha de bloquear). */
  protected readonly note = signal<string | null>(null);
  private readonly fullNote = $localize`:@@pc.sc.full:Fixados cheio: solte um para fixar outro.`;

  protected readonly sections = computed<readonly Section[]>(() => {
    const sections: Section[] = [];
    // Um atalho que precisa da `pc.key.v2` não aparece para um PC que não a declarou (nem entre os fixados).
    const supported = (shortcut: PcShortcut) => !shortcut.needs || this.store.supportsKeyV2();
    const fixed = this.pinned.shortcuts().filter(supported);
    // Fora da edição, sem nenhum fixado a seção nem aparece; na edição ela aparece vazia para dizer onde eles ficam.
    if (fixed.length > 0 || this.editing()) {
      sections.push({ id: 'pinned', title: GROUP_LABEL.pinned(), items: fixed });
    }
    for (const group of SHORTCUT_GROUPS) {
      sections.push({
        id: group,
        title: GROUP_LABEL[group](),
        items: SHORTCUTS.filter((shortcut) => shortcut.group === group && supported(shortcut)),
      });
    }
    return sections;
  });

  protected label(item: PcShortcut): string {
    return shortcutLabel(item.id);
  }

  protected keys(item: PcShortcut): string {
    return keysText(item);
  }

  protected activate(item: PcShortcut): void {
    this.note.set(null);
    if (this.editing()) {
      if (!this.pinned.toggle(item.id)) this.note.set(`${this.fullNote} (${MAX_PINNED})`);
      return;
    }
    if (!this.store.canSend()) return;
    if (item.action.kind === 'goto-slide') {
      this.gotoOpen.set(!this.gotoOpen());
      return;
    }
    if (item.switcher && this.switcher.available()) {
      tick();
      this.input.diverge();
      if (this.switcher.begin()) this.began.emit();
      return;
    }
    if (item.action.kind === 'lock') {
      tick();
      this.input.diverge();
      void this.store.power('LOCK').then((failure) => {
        if (failure && failure.kind !== 'cancelled') this.note.set(failure.message);
      });
      return;
    }
    this.input.shortcut(item.action.key, item.action.modifiers);
  }

  /** "Ir ao slide N": os dígitos e o Enter, pelo que o PowerPoint e os leitores de PDF entendem. */
  protected goto(event: Event, field: HTMLInputElement): void {
    event.preventDefault();
    const text = field.value.trim();
    if (!this.store.canSend()) return;
    if (!/^[0-9]{1,3}$/.test(text) || Number(text) < 1) {
      this.note.set($localize`:@@pc.sc.goto-invalid:Digite o número do slide, de 1 a 999.`);
      return;
    }
    this.note.set(null);
    tick();
    for (const digit of text) this.input.sendKey(`D${digit}` as PcKey);
    this.input.sendKey('ENTER');
    this.input.diverge();
    field.value = '';
  }
}
