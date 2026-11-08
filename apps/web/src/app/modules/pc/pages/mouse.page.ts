import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  effect,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';
import { PcArmed } from '../data/pc-armed';
import { PcPrefs } from '../data/pc-prefs';
import { PcStore } from '../data/pc-store';
import { PC_MODIFIERS, type PcKey, type PcModifier } from '../data/pc-types';
import { tick } from '../input/haptics';
import { PadButton, PadGesture } from '../input/pad-gesture';
import { PcActionBar } from '../ui/action-bar';
import { PcKeyPanel } from '../ui/key-panel';
import { PcPadSettingsSheet } from '../ui/pad-settings-sheet';
import { ScreenWakeLock } from '../ui/wake-lock';

/** Os nomes das teclas modificadoras não se traduzem: são as que estão no teclado do PC. */
const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

/** Teclas enviadas e ainda sem resposta a partir das quais a repetição de apagar e das setas pula a rodada. */
const MAX_KEYS_IN_FLIGHT = 2;

/** Quanto tempo a falha de uma tecla fica na tela. */
const ERROR_MS = 4_000;

/**
 * A tela principal do controle do PC: a superfície do touchpad enche tudo o que sobra, e embaixo fica a barra de ações
 * (teclado, Enter, apagar, Esc, Tab, o painel de teclas e os atalhos), sempre à vista. Um dedo move o ponteiro, um toque
 * clica, um dedo parado por um instante segura o botão esquerdo (o arrasto termina quando o dedo sai), dois dedos rolam e
 * um toque de dois dedos clica com o botão direito. Os botões Esquerdo, Arrastar e Direito só aparecem se a pessoa os ligar
 * nos ajustes. Enquanto a tela está aberta o aparelho não apaga a tela (onde o navegador permite).
 */
@Component({
  selector: 'app-pc-mouse-page',
  imports: [PcActionBar, PcKeyPanel, PcPadSettingsSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stage">
      <div
        class="pad"
        role="group"
        aria-labelledby="pad-help"
        [class.active]="active()"
        [class.holding]="holding()"
        tabindex="0"
        (pointerdown)="onDown($event)"
        (pointermove)="onMove($event)"
        (pointerup)="onUp($event)"
        (pointercancel)="onCancel()"
        (contextmenu)="$event.preventDefault()"
        (keydown)="onKey($event)"
      >
        <!-- A região fica sempre no DOM e só o texto muda: o leitor de tela anuncia a mudança, não o elemento novo. -->
        <span class="holding-label" role="status">{{ holding() ? draggingLabel : '' }}</span>
        @if (!holding() && !prefs.hintSeen()) {
          <!-- Dica de primeiro uso: três gestos, sem frase; some ao primeiro toque e não volta. -->
          <span class="hints" aria-hidden="true">
            <svg viewBox="0 0 24 24">
              <circle cx="8" cy="12" r="3.5" />
              <path [attr.d]="'M14 12h7M18.5 9.5 21 12l-2.5 2.5'" />
            </svg>
            <svg viewBox="0 0 24 24">
              <circle cx="8" cy="9" r="3" />
              <circle cx="16" cy="9" r="3" />
              <path [attr.d]="'M12 15v6M9.5 18.5 12 21l2.5-2.5'" />
            </svg>
            <svg viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="2.5" />
              <circle cx="12" cy="12" r="7.5" />
            </svg>
          </span>
        }
        @if (armedList().length > 0) {
          <span class="armed" role="status" [attr.aria-label]="armedLabel">
            @for (mod of armedList(); track mod) {
              <span class="armed-key">{{ label(mod) }}</span>
            }
          </span>
        }
      </div>
      <button
        type="button"
        class="settings"
        aria-label="Ajustes do touchpad"
        i18n-aria-label="@@pc.pad.settings"
        (click)="settingsOpen.set(true)"
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path [attr.d]="'M4 7h9M17 7h3M4 17h3M11 17h9'" />
          <circle cx="15" cy="7" r="2" />
          <circle cx="9" cy="17" r="2" />
        </svg>
      </button>

      @if (panelOpen()) {
        <app-pc-key-panel
          class="overlay"
          [disabled]="!store.canSend()"
          [busy]="keysBusy"
          (key)="sendKey($event)"
        />
      }
      @if (error(); as message) {
        <p class="toast" role="alert">{{ message }}</p>
      }
    </div>
    <p id="pad-help" class="sr-only" i18n="@@pc.pad.help">
      Touchpad: deslize um dedo para mover o ponteiro do PC, toque para clicar, mantenha o dedo
      parado para arrastar, deslize dois dedos para rolar e toque com dois dedos para o botão
      direito. As teclas rápidas ficam na barra abaixo.
    </p>

    @if (prefs.clickButtons()) {
      <div class="buttons">
        <button
          type="button"
          class="ui-btn"
          [disabled]="!store.canSend()"
          (click)="press('LEFT')"
          i18n="@@pc.pad.left"
        >
          Esquerdo
        </button>
        <button
          type="button"
          class="ui-btn"
          [attr.aria-pressed]="store.dragging()"
          [class.on]="store.dragging()"
          [disabled]="!store.canSend() && !store.dragging()"
          (click)="drag()"
          i18n="@@pc.pad.drag"
        >
          Arrastar
        </button>
        <button
          type="button"
          class="ui-btn"
          [disabled]="!store.canSend()"
          (click)="press('RIGHT')"
          i18n="@@pc.pad.right"
        >
          Direito
        </button>
      </div>
    }

    <app-pc-action-bar
      [disabled]="!store.canSend()"
      [panelOpen]="panelOpen()"
      [busy]="keysBusy"
      (key)="sendKey($event)"
      (keyboard)="openKeyboard()"
      (panel)="panelOpen.set(!panelOpen())"
      (shortcuts)="openShortcuts()"
    />

    @if (settingsOpen()) {
      <app-pc-pad-settings-sheet (closed)="settingsOpen.set(false)" />
    }
  `,
  styleUrl: './mouse.page.css',
})
export class MousePage {
  /** A casca do módulo dá a esta tela a altura toda que sobra (as outras abas crescem com o conteúdo). */
  readonly fillsScreen = true;

  protected readonly store = inject(PcStore);
  protected readonly prefs = inject(PcPrefs);
  private readonly armed = inject(PcArmed);
  private readonly router = inject(Router);
  protected readonly active = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly panelOpen = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Uma pressão longa apertou o botão (vale na hora, antes de a resposta do PC chegar: o iOS não vibra). */
  private readonly pressing = signal(false);
  protected readonly draggingLabel = $localize`:@@pc.pad.dragging:Arrastando`;
  protected readonly armedLabel = $localize`:@@pc.pad.armed:Teclas armadas`;
  /** O botão está apertado (ou acabou de ser apertado pelo dedo): a superfície mostra isso com força. */
  protected readonly holding = computed(() => this.pressing() || this.store.dragging());
  protected readonly armedList = computed(() =>
    PC_MODIFIERS.filter((modifier) => this.armed.armed().has(modifier)),
  );
  /** O botão está apertado por uma pressão longa (e então é o fim do dedo que solta; o "Arrastar" é do botão). */
  private pressHold = false;
  /** O número do aperto que este dedo começou: o fim do dedo só solta esse (não um mais novo, do botão "Arrastar"). */
  private holdEpoch = 0;
  /** Teclas pedidas e ainda sem resposta (a repetição de apagar e das setas espera por elas). */
  private pendingKeys = 0;
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  /** Devolve `true` quando já há teclas demais sem resposta (a repetição pula a rodada em vez de empilhar). */
  protected readonly keysBusy = () => this.pendingKeys >= MAX_KEYS_IN_FLIGHT;

  private readonly wakeLock = new ScreenWakeLock(inject(DOCUMENT));

  private readonly gesture = new PadGesture({
    move: (dx, dy, elapsedMs) => this.store.movePointer(dx, dy, elapsedMs),
    scroll: (dx, dy, elapsedMs) => this.store.scrollPointer(dx, dy, elapsedMs),
    tap: (button) => this.press(button),
    dragStart: () => this.startHold(),
    dragEnd: () => this.endHold(),
  });

  constructor() {
    effect(() => {
      if (this.prefs.keepAwake()) this.wakeLock.start();
      else this.wakeLock.stop();
    });
    inject(DestroyRef).onDestroy(() => {
      this.wakeLock.stop();
      clearTimeout(this.errorTimer);
      // Cancelar solta o que uma pressão longa segurava; o resto (o "Arrastar") o store solta aqui.
      this.gesture.cancel();
      // Largar a tela com o botão apertado deixaria o PC arrastando para sempre.
      void this.store.release({ persistent: true });
    });
  }

  protected label(modifier: PcModifier): string {
    return MODIFIER_LABEL[modifier];
  }

  protected onDown(event: PointerEvent): void {
    if (!this.store.canSend()) return;
    (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    if (!this.prefs.hintSeen()) this.prefs.set({ hintSeen: true });
    if (!this.gesture.active) this.store.beginGesture();
    this.active.set(true);
    this.gesture.down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
  }

  protected onMove(event: PointerEvent): void {
    if (!this.active()) return;
    this.gesture.move(event.pointerId, event.clientX, event.clientY, event.timeStamp);
  }

  protected onUp(event: PointerEvent): void {
    if (!this.active()) return;
    this.gesture.up(event.pointerId, event.timeStamp);
    if (!this.gesture.active) this.finish();
  }

  /**
   * O sistema tomou o toque (uma rolagem do navegador, uma ligação). Não se escuta `lostpointercapture`: ele também chega
   * depois de cada dedo que sai, e cancelaria o segundo dedo no meio do toque de dois dedos.
   */
  protected onCancel(): void {
    this.gesture.cancel();
    this.finish();
  }

  /** Teclado: as setas movem de dez em dez pixels e Enter ou Espaço clicam. */
  protected onKey(event: KeyboardEvent): void {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.press('LEFT');
      return;
    }
    const steps: Record<string, [number, number]> = {
      ArrowUp: [0, -10],
      ArrowDown: [0, 10],
      ArrowLeft: [-10, 0],
      ArrowRight: [10, 0],
    };
    const step = steps[event.key];
    if (step) {
      event.preventDefault();
      this.store.movePointer(step[0], step[1], 16);
      this.store.endGesture();
    }
  }

  protected press(button: PadButton): void {
    tick();
    void this.store.click(button);
  }

  protected drag(): void {
    tick();
    void this.store.toggleDrag();
  }

  /**
   * Uma tecla da barra, do painel ou da folha de atalhos. As teclas armadas valem para ela e se soltam. A falha aparece
   * na tela por alguns segundos.
   */
  protected sendKey(key: PcKey, modifiers: readonly PcModifier[] = []): void {
    if (!this.store.canSend()) return;
    tick();
    const taken = this.armed.take(modifiers);
    this.pendingKeys++;
    void this.store
      .sendKey(key, taken)
      .then((failure) => {
        if (failure && failure.kind !== 'cancelled') this.fail(failure.message);
      })
      .finally(() => this.pendingKeys--);
  }

  /** O teclado do celular ainda vive na aba Atalhos; a digitação ao vivo o substitui. */
  protected openKeyboard(): void {
    void this.router.navigateByUrl('/pc/atalhos');
  }

  protected openShortcuts(): void {
    void this.router.navigateByUrl('/pc/atalhos');
  }

  /**
   * Um dedo parado apertou o botão esquerdo. Se o "Arrastar" já o segurava, ou o aperto dele ainda está saindo, o dedo não
   * assume nada: o fim do dedo não pode soltar o que não apertou.
   */
  private startHold(): void {
    if (this.store.dragging() || this.store.buttonBusy) return;
    tick(20);
    this.pressHold = true;
    this.pressing.set(true);
    const started = this.store.startDrag();
    this.holdEpoch = this.store.pressEpoch;
    void started.then((failure) => {
      // O aperto não passou: a superfície deixa de dizer que está arrastando. O `pressHold` fica: se o `UP` de segurança do
      // store também falhou, o botão pode estar apertado, e o fim do dedo ainda precisa soltar (sem botão é um não-fazer).
      if (failure) this.pressing.set(false);
    });
  }

  private endHold(): void {
    if (!this.pressHold) return;
    this.pressHold = false;
    this.pressing.set(false);
    // Um aperto mais novo (o botão "Arrastar" tocado enquanto o dedo ainda estava na tela) não é deste dedo.
    if (this.store.pressEpoch !== this.holdEpoch) return;
    void this.store.release({ persistent: true });
  }

  private finish(): void {
    this.active.set(false);
    this.store.endGesture();
  }

  private fail(message: string): void {
    this.error.set(message);
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.error.set(null), ERROR_MS);
  }
}
