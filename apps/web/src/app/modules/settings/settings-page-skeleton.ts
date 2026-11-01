import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { LoadingFrame } from '../../shared/ui/skeleton/loading-frame';
import { Skeleton } from '../../shared/ui/skeleton/skeleton';

/** Formas locais das telas de Configurações; não usa a cobertura global depois que a casca já montou. */
@Component({
  selector: 'app-settings-page-skeleton',
  host: { '[attr.data-screen-skeleton]': 'marker()' },
  imports: [LoadingFrame, Skeleton],
  template: `
    <app-loading-frame [label]="label()">
      @if (kind() === 'list') {
        <div class="list"><div class="segments"><span appSkeleton></span><span appSkeleton></span><span appSkeleton></span></div><span appSkeleton class="label"></span><div class="group"><div><span appSkeleton class="tile"></span><span appSkeleton class="line"></span><span appSkeleton class="chevron"></span></div><div><span appSkeleton class="tile"></span><span appSkeleton class="line"></span><span appSkeleton class="chevron"></span></div></div><span appSkeleton class="label"></span><div class="group"><div><span appSkeleton class="tile"></span><span appSkeleton class="line"></span><span appSkeleton class="chevron"></span></div><div><span appSkeleton class="tile"></span><span appSkeleton class="line"></span><span appSkeleton class="chevron"></span></div></div></div>
      } @else if (kind() === 'profile') {
        <div class="profile"><span appSkeleton class="label"></span><div class="identity"><span appSkeleton class="avatar"></span><span class="identity-lines"><span appSkeleton></span><span appSkeleton></span></span><span appSkeleton class="chip"></span></div><span appSkeleton class="label"></span><div class="panel"><span appSkeleton class="field"></span><span appSkeleton class="hint"></span><span appSkeleton class="button"></span></div><span appSkeleton class="label"></span><div class="card"><span appSkeleton></span><span appSkeleton class="short"></span></div><span appSkeleton class="label"></span><div class="card"><span appSkeleton class="notice"></span><span appSkeleton class="button"></span></div></div>
      } @else {
        <div class="appearance"><span appSkeleton class="label"></span><div class="themes"><span appSkeleton class="theme"></span><span appSkeleton class="theme"></span><span appSkeleton class="theme"></span></div><div class="install"><span appSkeleton class="tile"></span><span class="identity-lines"><span appSkeleton></span><span appSkeleton class="short"></span></span></div></div>
      }
    </app-loading-frame>
  `,
  styles: `
    .list, .profile, .appearance { display: flex; flex-direction: column; gap: var(--space-3); }
    .segments { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--space-2); padding: var(--space-2); border: 1px solid var(--a-line); border-radius: var(--radius); }
    .segments [appSkeleton] { height: 40px; }
    .label { width: 5rem; height: 12px; }
    .group { overflow: hidden; border: 1px solid var(--a-line); border-radius: var(--radius); background: var(--a-surface); }
    .group > div { display: flex; align-items: center; gap: var(--space-3); min-height: 64px; padding: var(--space-3) var(--space-4); }
    .group > div + div { border-top: 1px solid var(--a-line); }
    .tile { width: 40px; height: 40px; } .line { width: 45%; height: 14px; } .chevron { width: 10px; height: 14px; margin-left: auto; }
    .identity, .panel, .card, .themes, .install { display: flex; gap: var(--space-3); padding: var(--space-4); border: 1px solid var(--a-line); border-radius: var(--radius); background: var(--a-surface); }
    .identity { align-items: center; min-height: 72px; } .identity-lines { display: flex; flex: 1; flex-direction: column; gap: var(--space-2); } .identity-lines [appSkeleton] { width: 72%; height: 14px; } .identity-lines .short { width: 46%; }
    .avatar { width: 52px; height: 52px; border-radius: 50%; } .chip { width: 64px; height: 24px; border-radius: var(--radius-pill); }
    .panel { flex-direction: column; } .card { flex-direction: column; } .field { height: var(--tap); } .hint { width: 45%; height: 12px; } .button { width: 100%; height: var(--tap); } .notice { height: 36px; } .short { width: 40%; }
    .themes { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); } .theme { height: 92px; border-radius: var(--radius-sm); } .install { align-items: center; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class SettingsPageSkeleton {
  readonly kind = input<'list' | 'profile' | 'appearance'>('list');
  readonly label = input.required<string>();
  readonly marker = input.required<string>();
}
