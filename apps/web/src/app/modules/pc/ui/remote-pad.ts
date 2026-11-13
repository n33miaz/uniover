import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  input,
  signal,
} from '@angular/core';
import type { PcFailure } from '../data/pc-failure';
import { PcInput } from '../data/pc-input';
import type { PcRemote, RemoteButton } from '../data/pc-remotes';
import { PcStore } from '../data/pc-store';
import type { PcKeyOptions } from '../data/pc-types';
import { tick } from '../input/haptics';
import { LONG_PRESS_MS } from '../input/pad-gesture';
import { remoteButtonIcon } from './remote-icons';
import { holdHint, needsUpdateHint, remoteButtonLabel, remoteNotInFront } from './remote-labels';
import { PcTransport } from './transport';

/**
 * O painel de um controle por programa: a barra de endereço (só o navegador), os três botões grandes (quando o programa os
 * tem) e a grade de botões com desenho e rótulo curto. Cada toque manda só a tecla do próprio botão: as teclas armadas na
 * tela do mouse não valem, e com o Alt do "Trocar janela" segurado tudo fica desligado (sairia Alt+tecla). O que precisa da
 * `pc.key.v2` some num PC que não a declarou.
 *
 * As teclas e o texto de um controle com programa (`target`) só saem com aquele programa na frente no PC: o agente confere a
 * janela e, se for outra, não aperta nada e o painel avisa numa linha. Um PC que ainda não confere (sem `pc.target.v1`) fica com
 * essas teclas desligadas: os comandos de mídia (do Spotify) seguem, pois vão à sessão de mídia do Windows, não à janela.
 * "Fechar Aba" só sai segurando, uma vez por toque longo.
 */
@Component({
  selector: 'app-pc-remote-pad',
  imports: [PcTransport],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (remote().address) {
      <form class="address" (submit)="go($event)">
        <input
          class="field"
          type="text"
          [attr.inputmode]="'url'"
          [attr.enterkeyhint]="'go'"
          [attr.autocapitalize]="'off'"
          autocomplete="off"
          spellcheck="false"
          aria-label="Endereço ou pesquisa"
          i18n-aria-label="@@pc.remote.address"
          placeholder="Endereço ou pesquisa"
          i18n-placeholder="@@pc.remote.address"
          [value]="address()"
          (input)="address.set($any($event.target).value)"
        />
        <button
          type="submit"
          class="go"
          aria-label="Abrir no navegador"
          i18n-aria-label="@@pc.remote.address-go"
          [disabled]="!canPressKeys() || address().trim() === ''"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path [attr.d]="'M5 12h14M13 6l6 6-6 6'" />
          </svg>
        </button>
      </form>
    }

    @if (remote().transport; as transport) {
      <app-pc-transport
        [kind]="transport.kind"
        [disabled]="input.held() || !canUse(transport.toggle)"
        [previousLabel]="label(transport.previous)"
        [toggleLabel]="label(transport.toggle)"
        [nextLabel]="label(transport.next)"
        (previous)="send(transport.previous)"
        (playPause)="send(transport.toggle)"
        (next)="send(transport.next)"
      />
    }

    <div class="grid" [class.digits]="remote().id === 'teclado-numerico'">
      @for (item of buttons(); track item.id) {
        @if (item.hold) {
          <button
            type="button"
            class="cell hold"
            [class.holding]="holding() === item.id"
            [attr.data-button]="item.id"
            [attr.aria-label]="label(item)"
            [disabled]="!canUse(item)"
            (pointerdown)="holdStart($event, item)"
            (pointerup)="holdEnd()"
            (pointercancel)="holdCancel()"
            (pointerleave)="holdCancel()"
            (contextmenu)="$event.preventDefault()"
            (click)="holdClick($event)"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="icon(item)" /></svg>
            <span class="name" aria-hidden="true">{{ label(item) }}</span>
          </button>
        } @else {
          <button
            type="button"
            class="cell"
            [attr.data-button]="item.id"
            [attr.aria-label]="label(item)"
            [disabled]="!canUse(item)"
            (click)="send(item)"
          >
            @if (icon(item); as d) {
              <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="d" /></svg>
              <span class="name" aria-hidden="true">{{ label(item) }}</span>
            } @else {
              <span class="char" aria-hidden="true">{{ label(item) }}</span>
            }
          </button>
        }
      }
    </div>

    <p class="notice" role="status">{{ notice() || updateNotice() }}</p>
  `,
  styleUrl: './remote-pad.css',
})
export class PcRemotePad {
  protected readonly store = inject(PcStore);
  protected readonly input = inject(PcInput);

  readonly remote = input.required<PcRemote>();

  protected readonly address = signal('');
  /** A linha de aviso embaixo (programa fora da frente, dica de segurar, PC que precisa atualizar). */
  protected readonly notice = signal('');
  /** O botão de segurar com o dedo em cima agora. */
  protected readonly holding = signal<string | null>(null);

  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  /** O toque longo atual já mandou a tecla: o mesmo dedo não manda outra. */
  private holdSent = false;

  protected readonly buttons = computed<readonly RemoteButton[]>(() =>
    this.remote().buttons.filter((button) => !button.needs || this.store.supportsKeyV2()),
  );

  /** O PC confere o programa da frente, ou este controle não tem programa (o teclado numérico). */
  private readonly guarded = computed(
    () => this.remote().target === undefined || this.store.supportsTarget(),
  );

  protected readonly canPressKeys = computed(
    () => this.store.canSend() && !this.input.held() && this.guarded(),
  );

  constructor() {
    // A falha de uma tecla ou do texto (pela fila de entrada) vira a linha de aviso: o caso comum é outro programa na frente.
    const stop = this.input.onFailure((failure) => this.show(failure));
    inject(DestroyRef).onDestroy(() => {
      stop();
      this.clearHoldTimer();
    });
  }

  protected label(button: RemoteButton): string {
    return remoteButtonLabel(button.id);
  }

  protected icon(button: RemoteButton): string | undefined {
    return remoteButtonIcon(button.id);
  }

  /** O botão pode ser tocado agora: a mídia não precisa do programa na frente; tecla e texto, sim. */
  protected canUse(button: RemoteButton): boolean {
    if (button.action.kind === 'media') return this.store.canSend();
    return this.canPressKeys();
  }

  /** A linha embaixo quando o PC ainda não confere o programa da frente. */
  protected readonly updateNotice = computed(() =>
    this.store.canSend() && !this.guarded() ? needsUpdateHint() : '',
  );

  /** Manda o botão; devolve `false` quando nada saiu (PC ausente, Alt segurado ou PC que não confere a janela). */
  send(button: RemoteButton): boolean {
    const action = button.action;
    if (!this.canUse(button)) {
      this.notice.set(this.updateNotice());
      return false;
    }
    this.notice.set('');
    switch (action.kind) {
      case 'keys':
        return this.input.plain(action.key, action.modifiers, this.keyOptions());
      case 'media':
        tick();
        void this.store.sendMedia(action.action).then((failure) => this.show(failure));
        return true;
      case 'text': {
        tick();
        // Um caractere avulso (o "+" do VLC): vai direto, com o programa, sem passar pela fila do teclado ao vivo.
        const target = this.remote().target;
        void this.store
          .sendText(action.text, ...(target === undefined ? [] : [target]))
          .then((failure) => this.show(failure));
        this.input.diverge();
        return true;
      }
    }
  }

  /** A barra de endereço: Ctrl+L, o texto e Enter, na ordem da fila. Se o Ctrl+L é recusado, a fila descarta o resto. */
  protected go(event: Event): void {
    event.preventDefault();
    const value = this.address().trim();
    if (value === '' || !this.canPressKeys()) return;
    const options = this.keyOptions();
    if (!this.input.plain('L', ['CTRL'], options)) return;
    this.notice.set('');
    this.input.edit({ erase: 0, insert: value });
    if (options === undefined) this.input.sendKey('ENTER');
    else this.input.plain('ENTER', [], options);
    this.input.diverge();
    this.address.set('');
  }

  // ---- segurar para mandar ----------------------------------------------------------------------------------------

  protected holdStart(event: PointerEvent, button: RemoteButton): void {
    if (!this.canUse(button)) return;
    event.preventDefault();
    this.clearHoldTimer();
    this.holdSent = false;
    this.holding.set(button.id);
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      // Um envio por vez: com algo ainda na fila de entrada, o toque longo não manda outro.
      if (this.holdSent || this.input.pending > 0) return;
      this.holdSent = true;
      this.send(button);
    }, LONG_PRESS_MS);
  }

  protected holdEnd(): void {
    const early = this.holdTimer !== null;
    this.holdCancel();
    if (early && !this.holdSent) this.notice.set(holdHint());
  }

  protected holdCancel(): void {
    this.clearHoldTimer();
    this.holding.set(null);
  }

  /** O clique do botão de segurar nunca manda nada (o teclado e o leitor de tela só veem a dica). */
  protected holdClick(event: MouseEvent): void {
    event.preventDefault();
    if (event.detail === 0) this.notice.set(holdHint());
  }

  private clearHoldTimer(): void {
    if (this.holdTimer !== null) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  // ---- avisos -------------------------------------------------------------------------------------------------------

  private keyOptions(): PcKeyOptions | undefined {
    const target = this.remote().target;
    return target === undefined ? undefined : { target };
  }

  private show(failure: PcFailure | null): void {
    if (failure === null || failure.kind === 'cancelled') return;
    this.notice.set(
      failure.kind === 'not-in-front' ? remoteNotInFront(this.remote().id) : failure.message,
    );
  }
}
