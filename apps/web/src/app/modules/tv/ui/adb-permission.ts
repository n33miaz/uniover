import { Component, DestroyRef, effect, inject, untracked } from '@angular/core';
import { TvAdbPermission } from '../data/tv-adb-permission';
import { TvStore } from '../data/tv-store';

/**
 * Folha "Liberar na TV" e o recado "Aceite na TV". Fica por cima do controle **sem bloqueá-lo**: não é diálogo modal, não
 * prende o foco nem torna o resto inerte, então as direções, o volume e os atalhos seguem usáveis enquanto ela está lá.
 * Abre quando algo que precisa do ADB falha por falta de permissão ou quando o agente conta que ela falta; "Pedir na TV"
 * faz o pedido que mostra o aviso na tela da TV, e "Agora não" cala a folha até o próximo abrir do app.
 *
 * Enquanto o aviso está na TV um recado fixo diz o que fazer lá (aceitar e marcar Sempre permitir). Toda vez que o aviso
 * aparece na TV, o recado aparece aqui, também quando foi um caminho automático que o abriu. A lógica toda é de
 * `TvAdbPermission`; o que o agente conta no estado entra aqui, porque só este controle recebe o fluxo da TV.
 */
@Component({
  selector: 'app-tv-adb-permission',
  templateUrl: './adb-permission.html',
  styleUrl: './adb-permission.css',
})
export class AdbPermissionNotice {
  protected readonly permission = inject(TvAdbPermission);
  private readonly store = inject(TvStore);

  constructor() {
    // O estado do agente só vale com a conexão em dia: um estado guardado (sem rede) não diz o que a TV pensa agora.
    effect(() => {
      const state = this.store.state();
      const live = this.store.link() === 'ok' && state?.agentOnline === true;
      const value = live ? (state?.adbPermission ?? null) : null;
      untracked(() => this.permission.observe(value));
    });
    // Sem tela que a hospede, a falta de permissão vira só o erro curto (nada aparece sozinho em outra tela).
    this.permission.attach();
    // Um painel modal que fecha libera a folha que ficou esperando por ele (o evento não sobe: vale a captura).
    const onClose = () => this.permission.modalClosed();
    document.addEventListener('close', onClose, true);
    inject(DestroyRef).onDestroy(() => {
      document.removeEventListener('close', onClose, true);
      this.permission.detach();
    });
  }
}
