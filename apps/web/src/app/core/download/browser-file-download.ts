import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { QUEUE_RUNTIME } from '../offline-queue/queue-ports';

/** Alguns navegadores só iniciam o download depois do clique; o endereço precisa continuar disponível. */
const OBJECT_URL_LIFETIME_MS = 60_000;

@Injectable({ providedIn: 'root' })
export class BrowserFileDownload {
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
