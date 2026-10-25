import { Component, computed, inject } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthLayout } from '../../core/auth/auth-layout';
import { AuthService } from '../../core/auth/auth.service';
import { QrLoginPanel } from '../../core/auth/qr/qr-login-panel';
import { SessionState } from '../../core/session/session-state';
import { CONNECTOR_URL, isWindowsPc } from './windows-pc';

/**
 * Página pública `/conectar`: quem está no PC (inclusive sem conta) baixa o conector e vê os três passos, com os botões
 * exatos que o navegador e o Windows pedem ao abrir um arquivo .cmd. Fica fora da casca e sem guarda de login. Quem já
 * entrou vê com qual conta está e, na página que o conector abre, aprova o PC com um clique (o convidado com a TV aprova
 * a própria TV); quem não entrou pode entrar (e volta aqui) ou seguir sem conta e usar o QR que o conector mostra, lido
 * pelo celular de quem administra. Fora do Windows só explica que o conector é para o PC.
 */
@Component({
  selector: 'app-connect-page',
  imports: [AuthLayout, QrLoginPanel, RouterLink],
  templateUrl: './connect.page.html',
  styleUrl: './connect.page.css',
})
export class ConnectPage {
  protected readonly connectorUrl = CONNECTOR_URL;
  protected readonly windowsPc = isWindowsPc(navigator);

  private readonly session = inject(SessionState);
  /** Há conta aberta (também a sessão ainda por confirmar, sem rede): a página mostra quem é em vez de pedir a entrada. */
  protected readonly signedIn = computed(
    () => this.session.status() === 'authenticated' || this.session.status() === 'pending',
  );
  protected readonly accountName = computed(() => this.session.user()?.displayName ?? null);

  constructor() {
    // Só descobre se há sessão (renovando o cookie); nunca leva a outra tela, porque a página é pública.
    void inject(AuthService).init();
  }
}
