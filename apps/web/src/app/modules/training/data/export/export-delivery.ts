import { Injectable, inject } from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { BrowserFileDownload } from '../../../../core/download/browser-file-download';

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

/**
 * Entrega ao usuário: baixar um arquivo e compartilhar texto ou arquivo pelo sistema. Tudo é melhor esforço: o navegador
 * decide o que existe (o compartilhar de **arquivo** em PWA instalada no iPhone e o download dela **não foram medidos**).
 */
@Injectable()
export class ExportDelivery {
  private readonly doc = inject(DOCUMENT);
  private readonly downloadFile = inject(BrowserFileDownload);

  /** Baixa o arquivo por uma âncora com `download`. */
  download(blob: Blob, filename: string): void {
    this.downloadFile.save(blob, filename);
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
