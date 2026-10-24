import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  inject,
  input,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { leaveDialog } from '../../shared/ui/dialog-motion';
import { InstallHintService, InstallMode } from './install-hint.service';

/** Traços dos desenhos dos passos (grade de 24), no mesmo estilo dos outros ícones do app: só caminhos. */
const SHARE_ICON = [
  'M12 15V3',
  'M8 7l4-4 4 4',
  'M7.5 10h-1a2 2 0 0 0-2 2v7.5a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V12a2 2 0 0 0-2-2h-1',
] as const;
const ADD_ICON = [
  'M5.5 3.5h13a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2v-13a2 2 0 0 1 2-2z',
  'M12 8v8',
  'M8 12h8',
] as const;
const CONFIRM_ICON = ['M5 12.5l4.5 4.5L19 7.5'] as const;
const SAFARI_ICON = [
  'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  'M15.8 8.2l-2.1 5.5-5.5 2.1 2.1-5.5z',
] as const;
const COPY_ICON = [
  'M9 9h10a1.5 1.5 0 0 1 1.5 1.5v9A1.5 1.5 0 0 1 19 21H9a1.5 1.5 0 0 1-1.5-1.5v-9A1.5 1.5 0 0 1 9 9z',
  'M5 15h-.5A1.5 1.5 0 0 1 3 13.5v-9A1.5 1.5 0 0 1 4.5 3h9A1.5 1.5 0 0 1 15 4.5V5',
] as const;

type CopyState = 'idle' | 'copied' | 'failed';

/**
 * Folha "Atalho na tela de início": explica, conforme o aparelho, como pôr o app na tela de início. No Chromium
 * oferece o botão "Instalar"; no iPhone mostra os passos do menu Compartilhar (o iOS não tem faixa de instalação);
 * dentro de outro app (Instagram, Facebook...) o primeiro passo é abrir no Safari, com "Copiar endereço".
 *
 * Sobe de baixo como a de pareamento (`ui-dialog` + `leaveDialog`) e é uma só no app: quem a hospeda é
 * `InstallHint`, na casca. Esc vale como "Agora não". Aberta por uma linha de Ajustes ou de Personalizar (`manual`)
 * não oferece "Não mostrar de novo": a pessoa pediu para ver, e o botão serviria só para esconder a folha automática.
 */
@Component({
  selector: 'app-install-hint-sheet',
  templateUrl: './install-hint-sheet.html',
  styleUrl: './install-hint-sheet.css',
})
export class InstallHintSheet {
  private readonly hint = inject(InstallHintService);
  private readonly doc = inject(DOCUMENT);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  /** O campo do endereço existe só no passo "abrir no Safari" (o único que copia). */
  private readonly ghost = viewChild<ElementRef<HTMLInputElement>>('ghost');
  private readonly copyButton = viewChild<ElementRef<HTMLButtonElement>>('copyButton');

  /** Aberta pela pessoa (uma linha de Ajustes ou de Personalizar), e não sozinha. */
  readonly manual = input(false);
  readonly closed = output<void>();

  private readonly frozenMode = signal<InstallMode | null>(null);
  protected readonly mode = computed(() => this.frozenMode() ?? this.hint.mode());
  protected readonly iosNotInstalled = computed(() => {
    const mode = this.mode();
    return mode === 'ios-safari' || mode === 'ios-other' || mode === 'ios-in-app';
  });
  protected readonly shareIcon = SHARE_ICON;
  protected readonly addIcon = ADD_ICON;
  protected readonly confirmIcon = CONFIRM_ICON;
  protected readonly safariIcon = SAFARI_ICON;
  protected readonly copyIcon = COPY_ICON;

  /** A folha já está descendo: nada mais vale (nem instalar, nem fechar de novo). */
  protected readonly leaving = signal(false);
  protected readonly installing = signal(false);
  protected readonly installFailed = signal(false);
  protected readonly copy = signal<CopyState>('idle');
  /** Endereço sem a busca e sem o fragmento: o que a pessoa cola no Safari. */
  protected readonly address = this.currentAddress();
  protected readonly copyMessage = computed(() => {
    switch (this.copy()) {
      case 'copied':
        return $localize`:@@install.copy.done:Endereço copiado. Abra o Safari e cole na barra de endereço.`;
      case 'failed':
        return $localize`:@@install.copy.failed:Não deu para copiar sozinho. Toque e segure no endereço abaixo para copiar.`;
      default:
        return '';
    }
  });

  constructor() {
    afterNextRender(() => {
      const dialog = this.dialog().nativeElement;
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      dialog.showModal();
      // O primeiro controle recebe o foco de propósito (e não o que o navegador escolher).
      dialog.querySelector<HTMLElement>('button:not([disabled])')?.focus();
    });
  }

  /** "Agora não" e Esc: não volta sozinha por 14 dias. Aberta pela pessoa, só fecha. */
  protected later(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é o hospedeiro; evita o fechamento duplo do navegador
    if (this.leaving() || this.installing()) return;
    if (!this.manual()) this.hint.dismiss();
    this.leave();
  }

  protected never(): void {
    if (this.leaving() || this.installing()) return;
    this.hint.never();
    this.leave();
  }

  /** No iOS a página do Safari não consegue detectar que o atalho já foi instalado na tela de início. */
  protected alreadyInstalled(): void {
    if (this.leaving() || this.installing()) return;
    this.frozenMode.set(this.mode());
    this.hint.acknowledgeInstalled();
    this.leave();
  }

  protected async install(): Promise<void> {
    if (this.leaving() || this.installing()) return;
    this.frozenMode.set(this.mode());
    this.installing.set(true);
    this.installFailed.set(false);
    const outcome = await this.hint.prompt();
    // Recarregando: a página inteira está saindo e a folha reabre do outro lado; aqui não resta nada a fazer.
    if (outcome === 'reloading') return;
    this.installing.set(false);
    if (outcome === 'unavailable') {
      this.frozenMode.set(null);
      this.installFailed.set(true);
    } else this.leave();
  }

  protected async copyAddress(): Promise<void> {
    const clipboard = this.doc.defaultView?.navigator.clipboard;
    try {
      await clipboard?.writeText(this.address);
      if (clipboard) {
        this.copy.set('copied');
        return;
      }
    } catch {
      // Sem permissão ou sem contexto seguro: tenta o plano B.
    }
    this.copy.set(this.copyBySelection() ? 'copied' : 'failed');
  }

  /**
   * Plano B para navegadores sem Clipboard API: seleciona o endereço num campo da própria folha (fora dela tudo
   * está inerte) e pede `copy`. Se também falhar, o campo aparece para a pessoa copiar na mão.
   */
  private copyBySelection(): boolean {
    const field = this.ghost()?.nativeElement;
    if (!field) return false;
    try {
      field.value = this.address;
      field.focus();
      field.select();
      field.setSelectionRange(0, field.value.length);
      return this.doc.execCommand('copy');
    } catch {
      return false;
    } finally {
      this.copyButton()?.nativeElement.focus();
    }
  }

  private currentAddress(): string {
    const location = this.doc.defaultView?.location;
    return location ? `${location.origin}${location.pathname}` : '';
  }

  /** Toca a descida da folha e só então fecha o diálogo e avisa o hospedeiro, que a tira do DOM. */
  private leave(): void {
    if (this.leaving()) return;
    if (this.frozenMode() === null) this.frozenMode.set(this.mode());
    this.leaving.set(true);
    const dialog = this.dialog().nativeElement;
    leaveDialog(dialog, () => {
      // close() devolve o foco a quem a abriu (por exemplo, a linha de Personalizar).
      dialog.close();
      this.closed.emit();
    });
  }
}
