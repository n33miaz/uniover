import { Injectable, inject } from '@angular/core';
import { BrowserFileDownload } from '../../core/download/browser-file-download';

/**
 * Entrega do CSV da auditoria pelo mecanismo de download comum aos módulos.
 */
@Injectable({ providedIn: 'root' })
export class AuditDownload {
  private readonly download = inject(BrowserFileDownload);

  save(blob: Blob, filename: string): void {
    this.download.save(blob, filename);
  }
}
