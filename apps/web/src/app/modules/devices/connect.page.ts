import { Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { AuthLayout } from '../../core/auth/auth-layout';
import { QrLoginPanel } from '../../core/auth/qr/qr-login-panel';
import { CONNECTOR_URL, isWindowsPc } from './windows-pc';

/**
 * Página pública `/conectar`: quem está no PC (inclusive sem conta) baixa o conector e vê os três passos, com os botões
 * exatos que o navegador e o Windows pedem ao abrir um arquivo .cmd. Fica fora da casca e sem guarda de login; o que
 * liga o PC à conta é o QR que o conector mostra, lido pelo celular de quem administra. Fora do Windows só explica que o
 * conector é para o PC.
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
}
