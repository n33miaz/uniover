import { DOCUMENT } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  signal,
  viewChild,
} from '@angular/core';
import { ActivatedRoute } from '@angular/router';
import { PcArmed } from '../data/pc-armed';
import { MAX_BATCHES_IN_FLIGHT, MAX_KEYS_IN_FLIGHT, PcInput } from '../data/pc-input';
import { PcPrefs } from '../data/pc-prefs';
import { SessionState } from '../../../core/session/session-state';
import { PcStore } from '../data/pc-store';
import { PcSwitcher } from '../data/pc-switcher';
import { PC_MODIFIERS, type PcKey, type PcModifier } from '../data/pc-types';
import { tick } from '../input/haptics';
import { PadButton, PadGesture, PadPoint } from '../input/pad-gesture';
import { ScrollInertia } from '../input/scroll-inertia';
import { PcActionBar } from '../ui/action-bar';
import { PcLiveKeyboard } from '../ui/live-keyboard';
import { PcKeyPanel } from '../ui/key-panel';
import { PcPadSettingsSheet } from '../ui/pad-settings-sheet';
import { PcShortcutSheet } from '../ui/shortcut-sheet';
import { ScreenWakeLock } from '../ui/wake-lock';

/** Os nomes das teclas modificadoras não se traduzem: são as que estão no teclado do PC. */
const MODIFIER_LABEL: Readonly<Record<PcModifier, string>> = {
  CTRL: 'Ctrl',
  SHIFT: 'Shift',
  ALT: 'Alt',
  WIN: 'Win',
};

/** Quanto tempo a falha de uma tecla fica na tela. */
const ERROR_MS = 4_000;

/** Quanto tempo o anel de um toque fica na tela. */
const RING_MS = 450;

interface Ring {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly kind: 'left' | 'right' | 'middle';
}

/**
 * A tela principal do controle do PC: a superfície do touchpad enche tudo o que sobra, e embaixo fica a barra de ações
 * (teclado, Enter, apagar, Esc, Tab, o painel de teclas e os atalhos), sempre à vista. Um dedo move o ponteiro, um toque
 * clica, um dedo parado por um instante segura o botão esquerdo (o arrasto termina quando o dedo sai), dois dedos rolam e
 * um toque de dois dedos clica com o botão direito. Os botões Esquerdo, Arrastar e Direito só aparecem se a pessoa os ligar
 * nos ajustes. Enquanto a tela está aberta o aparelho não apaga a tela (onde o navegador permite).
 */
@Component({
  selector: 'app-pc-mouse-page',
  imports: [PcActionBar, PcKeyPanel, PcLiveKeyboard, PcPadSettingsSheet, PcShortcutSheet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stage">
      <div
        #pad
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
        @for (ring of rings(); track ring.id) {
          <!-- O iPhone não vibra: todo toque reconhecido nasce como um anel no ponto do dedo (decorativo). -->
          <span
            class="ring"
            aria-hidden="true"
            [attr.data-kind]="ring.kind"
            [style.left.px]="ring.x"
            [style.top.px]="ring.y"
          ></span>
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
        (click)="openSheet('settings')"
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
          (pointerdown)="holdKeyboard()"
          (click)="keepKeyboard()"
          [disabled]="!store.canSend()"
          [busy]="repeatBusy()"
          [moreKeys]="moreKeys()"
          [batched]="store.supportsKeyV2()"
          [switching]="switcher.active()"
          (key)="sendKey($event)"
          (keyRepeat)="sendKeyRepeat($event.key, $event.count)"
          (switchWindow)="toggleSwitcher()"
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

    <app-pc-live-keyboard
      [disabled]="!store.canSend()"
      (typing)="typing.set($event)"
      (failed)="fail($event)"
    />

    <app-pc-action-bar
      (pointerdown)="holdKeyboard()"
      (click)="keepKeyboard()"
      [disabled]="!store.canSend()"
      [typing]="typing()"
      [panelOpen]="panelOpen()"
      [panelDisabled]="switcher.active()"
      [shortcutsOpen]="shortcutsOpen()"
      [busy]="repeatBusy()"
      [batched]="store.supportsKeyV2()"
      (key)="sendKey($event)"
      (keyRepeat)="sendKeyRepeat($event.key, $event.count)"
      (keyboard)="openKeyboard()"
      (panel)="togglePanel()"
      (shortcuts)="openSheet('shortcuts')"
    />

    @if (shortcutsOpen()) {
      <app-pc-shortcut-sheet (closed)="shortcutsOpen.set(false)" />
    }
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
  private readonly input = inject(PcInput);
  protected readonly switcher = inject(PcSwitcher);
  /** O PC entende as teclas novas (`pc.key.v2`): o painel mostra os dígitos e o "Trocar janela". */
  protected readonly moreKeys = computed(() => this.store.supportsKey('D0'));
  private readonly route = inject(ActivatedRoute);
  private readonly session = inject(SessionState);
  private readonly doc = inject(DOCUMENT);
  private readonly padRef = viewChild.required<ElementRef<HTMLElement>>('pad');
  protected readonly rings = signal<readonly Ring[]>([]);
  private ringId = 0;
  private readonly ringTimers = new Set<ReturnType<typeof setTimeout>>();
  /** Os dedos que só pararam a rolagem que seguia sozinha: o gesto os ignora até saírem. */
  private readonly swallowed = new Set<number>();
  protected readonly active = signal(false);
  protected readonly settingsOpen = signal(false);
  protected readonly panelOpen = signal(false);
  protected readonly shortcutsOpen = signal(false);
  /** O teclado do celular está aberto (o campo escondido tem o foco). */
  protected readonly typing = signal(false);
  private readonly keyboard = viewChild.required(PcLiveKeyboard);
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
  private errorTimer: ReturnType<typeof setTimeout> | undefined;

  /** Devolve `true` quando já há teclas demais sem resposta (a repetição pula a rodada em vez de empilhar). */
  private readonly keysBusy = () => this.input.pending >= MAX_KEYS_IN_FLIGHT;
  /** O mesmo para a repetição em lotes: cada pedido leva vários apertos, então só um por vez. */
  private readonly batchesBusy = () => this.input.pending >= MAX_BATCHES_IN_FLIGHT;
  /** A rodada que a barra e o painel usam: a de lotes num PC com `pc.key.v2`, a de sempre nos outros. */
  protected readonly repeatBusy = computed(() =>
    this.store.supportsKeyV2() ? this.batchesBusy : this.keysBusy,
  );

  private readonly wakeLock = new ScreenWakeLock(this.doc);

  /**
   * A rolagem que segue depois dos dedos saírem. Para num toque novo, ao esconder a página, ao sair da tela, ao trocar de conta
   * e quando o PC some: depois de o dedo sair, nada pode continuar mandando entrada sem ninguém olhar.
   */
  private readonly inertia = new ScrollInertia({
    frames: {
      request: (callback) => requestAnimationFrame(callback),
      cancel: (handle) => cancelAnimationFrame(handle),
    },
    scroll: (dx, dy, dt) => this.store.scrollPointer(dx, dy, dt),
    canRun: () => this.store.canSend() && this.doc.visibilityState !== 'hidden',
    reducedMotion: () =>
      this.doc.defaultView?.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false,
  });

  private readonly gesture = new PadGesture({
    move: (dx, dy, elapsedMs) => this.store.movePointer(dx, dy, elapsedMs),
    scroll: (dx, dy, elapsedMs) => this.store.scrollPointer(dx, dy, elapsedMs),
    tap: (button, at) => {
      this.press(button);
      this.showRing(button, at);
    },
    dragStart: () => this.startHold(),
    dragEnd: () => this.endHold(),
    scrollEnd: (vx, vy) => this.inertia.start(vx, vy),
  });

  constructor() {
    // O endereço antigo do teclado chega aqui com `?teclado`: onde o navegador deixa, o teclado já abre. No iOS o foco só
    // vale dentro de um toque, então a pessoa toca no botão do teclado.
    afterNextRender(() => {
      if (this.route.snapshot.queryParamMap.has('teclado')) this.keyboard().open();
    });
    // A barra do "Trocar janela" ocuparia o lugar do painel: ele fecha quando o Alt é segurado.
    effect(() => {
      if (this.switcher.active()) this.panelOpen.set(false);
    });
    effect(() => {
      if (this.prefs.keepAwake()) this.wakeLock.start();
      else this.wakeLock.stop();
    });
    // Os ajustes de gesto valem do próximo toque em diante, sem recarregar a tela.
    effect(() =>
      this.gesture.configure({
        doubleTapDrag: this.prefs.doubleTapDrag(),
        middleClick: this.prefs.middleClick(),
      }),
    );
    // Com outra conta, ou sem PC, a rolagem que seguia sozinha para.
    effect(() => {
      this.session.accountId();
      this.inertia.stop();
    });
    effect(() => {
      if (!this.store.canSend()) this.inertia.stop();
    });
    const hide = () => this.inertia.stop();
    const onVisibility = () => {
      if (this.doc.visibilityState === 'hidden') hide();
    };
    this.doc.addEventListener('visibilitychange', onVisibility);
    this.doc.defaultView?.addEventListener('pagehide', hide);
    inject(DestroyRef).onDestroy(() => {
      this.doc.removeEventListener('visibilitychange', onVisibility);
      this.doc.defaultView?.removeEventListener('pagehide', hide);
      this.inertia.stop();
      this.ringTimers.forEach((timer) => clearTimeout(timer));
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
    // Um toque novo para a rolagem que seguia sozinha, na hora. Esse toque só a parou: não clica, não começa pressão longa e
    // não move nada (os dedos que pousarem junto com ele também). Só vale enquanto a rolagem ainda é visível: depois de ela quase
    // parar, o toque é um toque comum. O gesto seguinte, depois de todos saírem, é normal.
    const stoppedGlide = this.inertia.visible;
    this.inertia.stop();
    if (stoppedGlide || this.swallowed.size > 0) {
      this.swallowed.add(event.pointerId);
      return;
    }
    try {
      (event.currentTarget as Element).setPointerCapture?.(event.pointerId);
    } catch {
      // o ponteiro já acabou (ou não é um dedo de verdade): o gesto segue sem a captura
    }
    if (!this.prefs.hintSeen()) this.prefs.set({ hintSeen: true });
    if (!this.gesture.active) this.store.beginGesture();
    this.active.set(true);
    this.gesture.down(event.pointerId, event.clientX, event.clientY, event.timeStamp);
  }

  protected onMove(event: PointerEvent): void {
    if (this.swallowed.has(event.pointerId) || !this.active()) return;
    this.gesture.move(event.pointerId, event.clientX, event.clientY, event.timeStamp);
  }

  protected onUp(event: PointerEvent): void {
    if (this.swallowed.delete(event.pointerId)) return;
    if (!this.active()) return;
    this.gesture.up(event.pointerId, event.timeStamp);
    if (!this.gesture.active) this.finish();
  }

  /**
   * O sistema tomou o toque (uma rolagem do navegador, uma ligação). Não se escuta `lostpointercapture`: ele também chega
   * depois de cada dedo que sai, e cancelaria o segundo dedo no meio do toque de dois dedos.
   */
  protected onCancel(): void {
    this.swallowed.clear();
    this.inertia.stop();
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
    this.keyboard().press(key, modifiers);
  }

  /**
   * Segurar uma tecla num PC que entende `pc.key.v2`: um pedido com `count` repetições (a tela manda um por rodada). Sem esse
   * suporte a repetição é a de sempre, uma tecla por vez (`sendKey`).
   */
  protected sendKeyRepeat(key: PcKey, count: number): void {
    this.keyboard().pressRepeat(key, count);
  }

  /** O painel de teclas não abre com o Alt segurado: a barra do "Trocar janela" ficaria por cima dele. */
  protected togglePanel(): void {
    if (this.switcher.active()) return;
    this.panelOpen.set(!this.panelOpen());
  }

  /** O botão "Alt+Tab" do painel: segura o Alt e dá o primeiro Tab; com o Alt segurado, solta. */
  protected toggleSwitcher(): void {
    if (this.switcher.active()) void this.switcher.release();
    else this.switcher.begin();
  }

  /** O botão do teclado abre e fecha o teclado do celular; o foco tem de nascer neste toque (regra do iOS). */
  protected openKeyboard(): void {
    if (this.keyboard().active) this.keyboard().close();
    else this.keyboard().open();
  }

  /** Começo de um toque nas teclas da tela: a perda de foco que vem junto não é o sistema fechando o teclado. */
  protected holdKeyboard(): void {
    this.keyboard().holdFocus();
  }

  /** Uma folha por cima fica com o foco: o teclado do celular fecha, e o modo teclado acaba junto. */
  protected openSheet(sheet: 'settings' | 'shortcuts'): void {
    this.keyboard().close();
    if (sheet === 'settings') this.settingsOpen.set(true);
    else this.shortcutsOpen.set(true);
  }

  /** Tocar numa tecla da tela tira o foco do campo: no modo teclado ele volta (o teclado do celular não fecha). */
  protected keepKeyboard(): void {
    this.keyboard().restore();
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

  /** O anel do toque: aparece no ponto do dedo e some sozinho (o iOS não vibra, então é a resposta de todo toque). */
  private showRing(button: PadButton, at: PadPoint): void {
    const box = this.padRef().nativeElement.getBoundingClientRect();
    const ring: Ring = {
      id: ++this.ringId,
      x: at.x - box.left,
      y: at.y - box.top,
      kind: button === 'RIGHT' ? 'right' : button === 'MIDDLE' ? 'middle' : 'left',
    };
    this.rings.update((current) => [...current, ring]);
    const timer = setTimeout(() => {
      this.ringTimers.delete(timer);
      this.rings.update((current) => current.filter((item) => item.id !== ring.id));
    }, RING_MS);
    this.ringTimers.add(timer);
  }

  private finish(): void {
    this.active.set(false);
    this.store.endGesture();
  }

  protected fail(message: string): void {
    this.error.set(message);
    clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => this.error.set(null), ERROR_MS);
  }
}
