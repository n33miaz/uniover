import {
  Component,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  OnInit,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { problemOf } from '../../core/auth/api-problem';
import { ConnectivityService } from '../../core/connectivity/connectivity.service';
import { leaveDialog, onDialogBackdropClick } from '../../shared/ui/dialog-motion';
import { LoadingSkeleton } from '../../shared/ui/skeleton/loading-skeleton';
import { AgentLog, DeviceAgent, DevicesApi } from './devices-api';

/**
 * Folha "Registro do aparelho" (só o administrador): pede ao agente as últimas linhas do registro dele, que já chegam
 * sem tokens nem senhas, e mostra num bloco monoespaçado com rolagem. "Copiar" leva o texto inteiro para a área de
 * transferência (para mandar a quem ajuda); "Atualizar" pede de novo. Agente de versão antiga, sem essa capacidade,
 * recebe um aviso para atualizar, não um erro genérico.
 */
@Component({
  selector: 'app-agent-log-sheet',
  imports: [LoadingSkeleton],
  templateUrl: './agent-log-sheet.html',
  styleUrl: './agent-log-sheet.css',
})
export class AgentLogSheet implements OnInit {
  private readonly api = inject(DevicesApi);
  private readonly connectivity = inject(ConnectivityService);
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  private readonly output = viewChild<ElementRef<HTMLElement>>('output');

  readonly agent = input.required<DeviceAgent>();
  readonly closed = output<void>();

  protected readonly online = this.connectivity.online;
  protected readonly log = signal<AgentLog | null>(null);
  protected readonly loading = signal(true);
  protected readonly error = signal<string | null>(null);
  protected readonly copyNote = signal<string | null>(null);
  private readonly leaving = signal(false);

  protected readonly title = computed(
    () => $localize`:@@devices.log.title:Registro de ${this.agent().name}:name:`,
  );
  protected readonly summary = computed(() => {
    const log = this.log();
    if (!log) return '';
    if (log.lines === 0) return $localize`:@@devices.log.empty:O registro está vazio.`;
    const base = $localize`:@@devices.log.lines:${log.lines}:count: linhas, as mais recentes.`;
    return log.truncated
      ? `${base} ${$localize`:@@devices.log.truncated:Só o fim coube no limite do canal.`}`
      : base;
  });

  constructor() {
    afterNextRender(() => {
      // showModal prende o foco na folha, deixa o resto da tela inerte e trata o Esc.
      const dialog = this.dialog().nativeElement;
      dialog.showModal();
      onDialogBackdropClick(dialog, () => this.close());
    });
    // O fim do registro é o que importa: sempre que o bloco aparece (ou muda), a rolagem vai para baixo.
    effect(() => {
      const element = this.output()?.nativeElement;
      if (element && this.log()) element.scrollTop = element.scrollHeight;
    });
  }

  /** O `agent` (entrada obrigatória) só existe depois da construção: o primeiro pedido sai daqui. */
  ngOnInit(): void {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.copyNote.set(null);
    try {
      this.log.set(await this.api.logs(this.agent().id));
    } catch (error) {
      this.log.set(null);
      this.error.set(this.errorText(error));
    } finally {
      this.loading.set(false);
    }
  }

  protected async copy(): Promise<void> {
    const log = this.log();
    if (!log) return;
    try {
      await navigator.clipboard.writeText(log.text);
      this.copyNote.set($localize`:@@devices.log.copied:Copiado.`);
    } catch {
      this.copyNote.set(
        $localize`:@@devices.log.copy-failed:Não foi possível copiar. Toque no texto, selecione e copie.`,
      );
    }
  }

  protected close(event?: Event): void {
    event?.preventDefault(); // quem tira a folha do DOM é a página; evita o fechamento duplo do navegador
    if (this.leaving()) return;
    this.leaving.set(true);
    leaveDialog(this.dialog().nativeElement, () => this.closed.emit());
  }

  private errorText(error: unknown): string {
    const problem = problemOf(error);
    if (problem?.isNetwork) {
      return $localize`:@@devices.log.error.network:Sem conexão com o servidor. Tente de novo.`;
    }
    switch (problem?.kind) {
      case 'agent-outdated':
        return $localize`:@@devices.log.error.outdated:Atualize o agente neste computador para ver o registro. Quando ele atualizar sozinho, tente de novo.`;
      case 'agent-offline':
        return $localize`:@@devices.log.error.offline:O agente está desconectado. Ligue o PC e tente de novo.`;
      case 'agent-timeout':
        return $localize`:@@devices.log.error.timeout:O agente não respondeu a tempo. Tente de novo.`;
      case 'logs-in-progress':
        return $localize`:@@devices.log.error.busy:Já há um pedido de registro em andamento. Espere um instante.`;
      case 'command-failed':
      case 'logs-missing':
        return $localize`:@@devices.log.error.failed:O agente não conseguiu ler o registro agora.`;
      default:
        return problem?.status === 429
          ? $localize`:@@devices.log.error.rate-limited:Muitos pedidos seguidos. Espere um pouco e tente de novo.`
          : $localize`:@@devices.log.error.generic:Não foi possível ver o registro agora. Tente de novo.`;
    }
  }
}
