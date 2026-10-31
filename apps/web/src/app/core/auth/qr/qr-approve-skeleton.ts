import { ChangeDetectionStrategy, Component } from '@angular/core';
import { LoadingFrame } from '../../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../../shared/ui/skeleton/skeleton';

/**
 * A forma da confirmação do QR enquanto o app pergunta à API sobre o computador: as duas linhas de fatos, o aviso e os dois
 * botões, nas mesmas alturas da tela pronta, para ela não pular quando o dado entra. O título já é o da tela de verdade, então
 * fica fora daqui. A moldura cuida do atraso e do prazo.
 */
@Component({
  selector: 'app-qr-approve-skeleton',
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label">
      <div class="content">
        <div class="fact">
          <span appSkeleton class="icon"></span>
          <span appSkeleton class="line"></span>
        </div>
        <div class="fact">
          <span appSkeleton class="icon"></span>
          <span appSkeleton class="line short"></span>
        </div>
        <span appSkeleton class="caution"></span>
        <span appSkeleton class="button"></span>
        <span appSkeleton class="button"></span>
      </div>
    </app-loading-frame>
  `,
  styles: `
    :host {
      display: block;
    }
    .content {
      display: flex;
      flex-direction: column;
      gap: var(--space-2);
    }
    .fact {
      display: flex;
      align-items: center;
      gap: var(--space-3);
      min-height: var(--tap);
      padding: 0 var(--space-4);
      border: 1px solid var(--a-line);
      border-radius: var(--radius);
      background: var(--a-elev);
    }
    .icon {
      display: block;
      flex: none;
      width: 20px;
      height: 20px;
      min-height: 0;
      border-radius: var(--radius-pill);
    }
    .line {
      display: block;
      width: 55%;
      height: 14px;
      min-height: 0;
    }
    .line.short {
      width: 70%;
    }
    .caution {
      display: block;
      align-self: center;
      width: 60%;
      height: 14px;
      min-height: 0;
      margin: var(--space-2) 0 var(--space-4);
    }
    .button {
      display: block;
      height: 48px;
      min-height: 0;
      border-radius: var(--radius);
    }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class QrApproveSkeleton {
  protected readonly label = $localize`:@@auth.qr-approve.loading:Abrindo…`;
}
