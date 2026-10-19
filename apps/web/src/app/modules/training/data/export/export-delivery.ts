import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';

/**
 * O que aconteceu ao compartilhar. `shared`: a folha de compartilhar do sistema recebeu. `copied`: não há compartilhar
 * (ou ele falhou), e o texto foi para a área de transferência. `cancelled`: o usuário fechou a folha de propósito (não se
 * copia nada: ele desistiu). `unsupported`: nem compartilhar nem copiar funcionaram; para arquivo, a saída é baixar.
 */
export type ShareOutcome = 'shared' | 'copied' | 'cancelled' | 'unsupported';

export interface SharePayload {
  readonly title?: string;
  readonly text?: string;
  readonly file?: File;
}

/** Quanto tempo o endereço do arquivo baixado fica vivo: alguns navegadores só terminam o download depois do clique. */
const OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Entrega ao usuário: baixar um arquivo e compartilhar texto ou arquivo pelo sistema. Tudo é melhor esforço: o navegador
 * decide o que existe (o compartilhar de **arquivo** em PWA instalada no iPhone e o download dela **não foram medidos**).
 */
@Injectable()
export class ExportDelivery {
  private readonly doc = inject(DOCUMENT);
  private readonly runtime = inject(QUEUE_RUNTIME);

  /** Baixa o arquivo por uma âncora com `download`. */
  download(blob: Blob, filename: string): void {
    const win = this.doc.defaultView;
    if (!win) return;
    const url = win.URL.createObjectURL(blob);
    const anchor = this.doc.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    anchor.style.display = 'none';
    this.doc.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    this.runtime.setTimeout(() => win.URL.revokeObjectURL(url), OBJECT_URL_LIFETIME_MS);
  }

  /**
   * Compartilha pelo sistema (`navigator.share`), conferindo `canShare` antes. Sem suporte, ou se o sistema recusar por
   * outro motivo que não o usuário ter fechado a folha, copia o texto para a área de transferência.
   */
  async share(payload: SharePayload): Promise<ShareOutcome> {
    const nav = this.doc.defaultView?.navigator;
    if (nav && typeof nav.share === 'function') {
      const data: ShareData = {};
      if (payload.title !== undefined) data.title = payload.title;
      if (payload.text !== undefined) data.text = payload.text;
      if (payload.file !== undefined) data.files = [payload.file];

      if (typeof nav.canShare !== 'function' || nav.canShare(data)) {
        try {
          await nav.share(data);
          return 'shared';
        } catch (error) {
          if ((error as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
          // Qualquer outra recusa (por exemplo, fora de um toque) cai na reserva.
        }
      }
    }

    if (
      payload.text !== undefined &&
      nav?.clipboard &&
      typeof nav.clipboard.writeText === 'function'
    ) {
      try {
        await nav.clipboard.writeText(payload.text);
        return 'copied';
      } catch {
        // Sem permissão para copiar: segue sem a reserva.
      }
    }
    return 'unsupported';
  }
}
