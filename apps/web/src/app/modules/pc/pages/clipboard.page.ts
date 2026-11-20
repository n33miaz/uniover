import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { PcStore } from '../data/pc-store';
import { PC_CLIPBOARD_MAX, clipboardTextFits } from '../data/pc-types';
import { tick } from '../input/haptics';

/**
 * Área de transferência do PC, nos dois sentidos e sempre a pedido: "Trazer do PC" lê o texto copiado no PC e o mostra aqui
 * (com o botão de copiar para o celular), e "Enviar ao PC" põe o texto escrito aqui na área do PC, pronto para colar. Só texto.
 * O que passa por aqui pode ser uma senha: fica só na memória desta tela, nunca é guardado, e some ao sair dela ou em
 * "Limpar". Só existe para um PC que declarou `pc.clipboard.v1`.
 */
@Component({
  selector: 'app-pc-clipboard-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.supportsClipboard()) {
      @if (store.capabilities().includes('pc.clipboard.read.v1')) {
        <section class="block" aria-labelledby="pc-clipboard-from">
          <h2 id="pc-clipboard-from" i18n="@@pc.clipboard.from-pc">Do PC para Cá</h2>
          <button
            type="button"
            class="ui-btn"
            [attr.data-action]="'read'"
            [disabled]="!store.canSend() || busy()"
            (click)="read()"
          >
            <span i18n="@@pc.clipboard.read">Trazer do PC</span>
          </button>
          @if (fromPc(); as text) {
            <textarea
              class="text"
              readonly
              rows="4"
              aria-label="Texto da área de transferência do PC"
              i18n-aria-label="@@pc.clipboard.read-label"
              [value]="text"
            ></textarea>
            <div class="row">
              <button
                type="button"
                class="ui-btn"
                [attr.data-action]="'copy'"
                (click)="copyHere(text)"
              >
                <span i18n="@@pc.clipboard.copy-here">Copiar Aqui</span>
              </button>
              <button type="button" class="ui-btn" [attr.data-action]="'forget'" (click)="forget()">
                <span i18n="@@pc.clipboard.forget">Limpar</span>
              </button>
            </div>
          } @else if (emptyOnPc()) {
            <p class="hint" i18n="@@pc.clipboard.empty">
              A área de transferência do PC não tem texto.
            </p>
          }
        </section>
      }

      <section class="block" aria-labelledby="pc-clipboard-to">
        <h2 id="pc-clipboard-to" i18n="@@pc.clipboard.to-pc">Daqui para o PC</h2>
        <textarea
          class="text"
          rows="4"
          aria-label="Texto para a área de transferência do PC"
          i18n-aria-label="@@pc.clipboard.write-label"
          [attr.maxlength]="max"
          [value]="draft()"
          (input)="onDraft($event)"
        ></textarea>
        <button
          type="button"
          class="ui-btn"
          [attr.data-action]="'write'"
          [disabled]="!store.canSend() || busy() || !draftFits()"
          (click)="write()"
        >
          <span i18n="@@pc.clipboard.write">Enviar ao PC</span>
        </button>
      </section>

      @if (notice(); as text) {
        <p class="ui-notice" role="status">{{ text }}</p>
      }
      @if (error(); as text) {
        <p class="error ui-notice bad" role="alert">{{ text }}</p>
      }
    } @else {
      <p class="hint" i18n="@@pc.clipboard.unsupported">
        Este PC ainda não troca a área de transferência. Atualize o agente do PC.
      </p>
    }
  `,
  styles: `
    :host {
      display: flex;
      flex-direction: column;
      gap: var(--space-4);
    }
    .block {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    h2 {
      margin: 0;
      font-size: 1rem;
    }
    .text {
      box-sizing: border-box;
      width: 100%;
      padding: var(--space-2) var(--space-3);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-surface);
      color: var(--a-ink);
      font: inherit;
      resize: vertical;
    }
    .text:focus-visible {
      outline: 3px solid var(--a-accent);
      outline-offset: 2px;
    }
    .row {
      display: flex;
      gap: var(--space-2);
    }
    .hint {
      margin: 0;
      color: var(--a-ink3);
    }
  `,
})
export class ClipboardPage {
  protected readonly store = inject(PcStore);
  protected readonly max = PC_CLIPBOARD_MAX;
  protected readonly busy = signal(false);
  /** O texto que veio do PC: só na memória desta tela. */
  protected readonly fromPc = signal<string | null>(null);
  /** A última leitura veio vazia (sem texto copiado no PC). */
  protected readonly emptyOnPc = signal(false);
  protected readonly draft = signal('');
  protected readonly draftFits = computed(() => clipboardTextFits(this.draft()));
  protected readonly notice = signal<string | null>(null);
  protected readonly error = signal<string | null>(null);

  protected async read(): Promise<void> {
    tick();
    this.start();
    const read = await this.store.readClipboard();
    this.busy.set(false);
    if (!read.ok) {
      this.error.set(read.failure.message);
      return;
    }
    this.fromPc.set(read.value === '' ? null : read.value);
    this.emptyOnPc.set(read.value === '');
  }

  protected async write(): Promise<void> {
    const text = this.draft();
    if (!clipboardTextFits(text)) return;
    tick();
    this.start();
    const failure = await this.store.writeClipboard(text);
    this.busy.set(false);
    if (failure) {
      this.error.set(failure.message);
      return;
    }
    this.draft.set('');
    this.notice.set($localize`:@@pc.clipboard.sent:Enviado. É só colar no PC.`);
  }

  /** Copia para a área de transferência deste aparelho; sem permissão do navegador, avisa para copiar à mão. */
  protected async copyHere(text: string): Promise<void> {
    tick();
    this.error.set(null);
    try {
      await navigator.clipboard.writeText(text);
      this.notice.set($localize`:@@pc.clipboard.copied:Copiado neste aparelho.`);
    } catch {
      this.error.set(
        $localize`:@@pc.clipboard.copy-failed:O navegador não deixou copiar. Selecione o texto e copie à mão.`,
      );
    }
  }

  protected forget(): void {
    this.fromPc.set(null);
    this.emptyOnPc.set(false);
    this.notice.set(null);
  }

  protected onDraft(event: Event): void {
    this.draft.set((event.target as HTMLTextAreaElement).value);
    this.notice.set(null);
  }

  private start(): void {
    this.busy.set(true);
    this.notice.set(null);
    this.error.set(null);
  }
}
