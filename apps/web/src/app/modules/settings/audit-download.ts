import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { QUEUE_RUNTIME } from '../../core/offline-queue/queue-ports';

/** Quanto tempo o endereço do arquivo baixado fica vivo: alguns navegadores só terminam o download depois do clique. */
const OBJECT_URL_LIFETIME_MS = 60_000;

/**
 * Entrega do CSV da auditoria: baixa o arquivo por uma âncora com `download`, o mesmo mecanismo da exportação do Treino
 * (que esta tela não pode importar: um módulo de tela nunca importa de outro). Não passa por `fetch`, `<img>` nem
 * `window.open`: o endereço `blob:` de uma âncora de download não esbarra na CSP do app (`connect-src` e `img-src` ficam
 * como estão).
 */
@Injectable({ providedIn: 'root' })
export class AuditDownload {
  private readonly doc = inject(DOCUMENT);
  private readonly runtime = inject(QUEUE_RUNTIME);

  save(blob: Blob, filename: string): void {
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
}
