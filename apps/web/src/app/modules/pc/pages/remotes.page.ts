import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { REMOTES, remoteById } from '../data/pc-remotes';
import { PcStore } from '../data/pc-store';
import { REMOTE_ICON } from '../ui/remote-icons';
import { remoteName } from '../ui/remote-labels';
import { PcRemotePad } from '../ui/remote-pad';

/**
 * Controles: a lista de programas (uma linha larga por programa, como a tela Mais), e cada um abre o próprio painel em
 * `/pc/controles/<id>`. O que precisa da `pc.key.v2` (o teclado numérico) só entra na lista de um PC que a declarou.
 */
@Component({
  selector: 'app-pc-remotes-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <ul class="list" aria-label="Controles" i18n-aria-label="@@pc.remotes.title">
      @for (item of items(); track item.id) {
        <li>
          <a class="row" [routerLink]="['/pc/controles', item.id]" [attr.data-remote]="item.id">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path [attr.d]="item.icon" /></svg>
            <span>{{ item.name }}</span>
            <svg class="chevron" viewBox="0 0 24 24" aria-hidden="true">
              <path [attr.d]="'M9 6l6 6-6 6'" />
            </svg>
          </a>
        </li>
      }
    </ul>
  `,
  styleUrl: './remotes.page.css',
})
export class RemotesPage {
  private readonly store = inject(PcStore);

  protected readonly items = computed(() =>
    REMOTES.filter((remote) => !remote.needs || this.store.supportsKeyV2()).map((remote) => ({
      id: remote.id,
      name: remoteName(remote.id),
      icon: REMOTE_ICON[remote.id],
    })),
  );
}

/**
 * Um controle aberto: o nome e o painel. A volta à lista é a seta do cabeçalho do app (o `back` da rota), a única da tela.
 * Um endereço que não é de controle fica vazio, com a mesma seta.
 */
@Component({
  selector: 'app-pc-remote-page',
  imports: [PcRemotePad],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (remote(); as current) {
      <h2 class="title">{{ name() }}</h2>
      <app-pc-remote-pad [remote]="current" />
    }
  `,
  styleUrl: './remotes.page.css',
})
export class RemotePage {
  private readonly store = inject(PcStore);
  private readonly id = toSignal(
    inject(ActivatedRoute).paramMap.pipe(map((params) => params.get('app'))),
    { initialValue: null },
  );

  protected readonly remote = computed(() => {
    const remote = remoteById(this.id());
    return remote && (!remote.needs || this.store.supportsKeyV2()) ? remote : undefined;
  });
  protected readonly name = computed(() => {
    const remote = this.remote();
    return remote ? remoteName(remote.id) : '';
  });
}
