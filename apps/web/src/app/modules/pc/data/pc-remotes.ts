import { shortcutById, type ShortcutNeeds } from './pc-shortcuts';
import type { PcFocusTarget, PcKey, PcMediaAction, PcModifier } from './pc-types';

/**
 * Os controles por programa (como os "remotes" do Unified Remote): um painel por programa, feito só de teclas que o próprio
 * programa já entende, dos comandos de mídia do Windows e, num caso, de um caractere digitado. Nada de processo novo no
 * agente: tudo sai pelos mesmos `pc.key`, `pc.media` e `pc.text` das outras telas.
 *
 * Este arquivo é a tabela de teclas dos controles e diz de onde veio cada uma (`source`, a página oficial de atalhos do
 * programa). Os rótulos moram em `ui/remote-labels` e os desenhos em `ui/remote-icons`. Os botões do navegador vêm do catálogo
 * de atalhos (`pc-shortcuts`), para a mesma tecla não ficar escrita em dois lugares.
 */

/** Os programas, na ordem da lista. O id também é o endereço (`/pc/controles/<id>`). */
export type RemoteId = 'navegador' | 'youtube' | 'netflix' | 'spotify' | 'vlc' | 'teclado-numerico';

/** O que um botão manda: uma tecla com modificadores, um comando de mídia do Windows ou um texto digitado (Unicode). */
export type RemoteAction =
  | { readonly kind: 'keys'; readonly key: PcKey; readonly modifiers: readonly PcModifier[] }
  | { readonly kind: 'media'; readonly action: PcMediaAction }
  | { readonly kind: 'text'; readonly text: string };

export interface RemoteButton {
  /** Único dentro do controle; dá o rótulo e o desenho. */
  readonly id: string;
  readonly action: RemoteAction;
  /** Só aparece num PC que declarou `pc.key.v2` (teclas que a v1 não tem). */
  readonly needs?: ShortcutNeeds;
  /** Só sai segurando o botão (o que destrói alguma coisa, como fechar a aba); um toque curto só mostra a dica. */
  readonly hold?: true;
}

/** Os três botões grandes (voltar, tocar ou pausar, avançar): salto de tempo ou faixa. */
export interface RemoteTransport {
  readonly kind: 'seek' | 'track';
  readonly previous: RemoteButton;
  readonly toggle: RemoteButton;
  readonly next: RemoteButton;
}

export interface PcRemote {
  readonly id: RemoteId;
  /** A página oficial de onde vêm as teclas. */
  readonly source: string;
  readonly transport?: RemoteTransport;
  readonly buttons: readonly RemoteButton[];
  /** O controle inteiro precisa da `pc.key.v2` (o teclado numérico: dígitos) e some da lista sem ela. */
  readonly needs?: ShortcutNeeds;
  /** Tem a barra de endereço (Ctrl+L, o texto do teclado do celular e Enter). */
  readonly address?: true;
  /**
   * O programa que precisa estar na frente no PC: as teclas e o texto deste controle levam `target`, e o agente não aperta nada se
   * a janela da frente for de outro programa. Os comandos de mídia não levam (vão à sessão de mídia do Windows, não à janela).
   */
  readonly target?: PcFocusTarget;
}

const key = (id: string, k: PcKey, ...modifiers: PcModifier[]): RemoteButton => ({
  id,
  action: { kind: 'keys', key: k, modifiers },
});
const keyV2 = (id: string, k: PcKey, ...modifiers: PcModifier[]): RemoteButton => ({
  ...key(id, k, ...modifiers),
  needs: 'key-v2',
});
const media = (id: string, action: PcMediaAction): RemoteButton => ({
  id,
  action: { kind: 'media', action },
});
const text = (id: string, value: string): RemoteButton => ({
  id,
  action: { kind: 'text', text: value },
});

/** Um botão que é um atalho do catálogo: a tecla e o `needs` vêm de lá. */
function fromCatalog(id: string): RemoteButton {
  const shortcut = shortcutById(id);
  if (shortcut?.action.kind !== 'keys') throw new Error(`atalho sem tecla: ${id}`);
  const { key: k, modifiers } = shortcut.action;
  return shortcut.needs
    ? { id, action: { kind: 'keys', key: k, modifiers }, needs: shortcut.needs }
    : { id, action: { kind: 'keys', key: k, modifiers } };
}

export const REMOTES: readonly PcRemote[] = [
  {
    // Chrome: https://support.google.com/chrome/answer/157179 (o Edge e o Firefox usam as mesmas teclas para estes).
    id: 'navegador',
    source: 'https://support.google.com/chrome/answer/157179',
    target: 'browser',
    address: true,
    buttons: [
      fromCatalog('back'), // Alt+←
      fromCatalog('reload'), // F5
      fromCatalog('forward'), // Alt+→
      fromCatalog('previous-tab'), // Ctrl+Shift+Tab
      fromCatalog('new-tab'), // Ctrl+T
      fromCatalog('next-tab'), // Ctrl+Tab
      fromCatalog('zoom-out'), // Ctrl+- (v2)
      { ...fromCatalog('close-tab'), hold: true }, // Ctrl+W, só segurando
      fromCatalog('zoom-in'), // Ctrl+= (v2)
      fromCatalog('browser-fullscreen'), // F11
    ],
  },
  {
    // YouTube: https://support.google.com/youtube/answer/7631406 (o player precisa estar em foco).
    id: 'youtube',
    source: 'https://support.google.com/youtube/answer/7631406',
    target: 'browser',
    transport: {
      kind: 'seek',
      previous: key('back-10', 'J'),
      toggle: key('play-pause', 'K'),
      next: key('forward-10', 'L'),
    },
    buttons: [
      key('volume-down', 'DOWN'),
      key('mute', 'M'),
      key('volume-up', 'UP'),
      // "<" e ">" são Shift+vírgula e Shift+ponto nos layouts americano e ABNT2.
      keyV2('slower', 'COMMA', 'SHIFT'),
      key('subtitles', 'C'),
      keyV2('faster', 'PERIOD', 'SHIFT'),
      key('previous-video', 'P', 'SHIFT'),
      key('fullscreen', 'F'),
      key('next-video', 'N', 'SHIFT'),
    ],
  },
  {
    // Netflix: https://help.netflix.com/en/node/24855 (pular a abertura é a tecla S, da mesma página).
    id: 'netflix',
    source: 'https://help.netflix.com/en/node/24855',
    target: 'browser',
    transport: {
      kind: 'seek',
      previous: key('back-10', 'LEFT'),
      toggle: key('play-pause', 'SPACE'),
      next: key('forward-10', 'RIGHT'),
    },
    buttons: [
      key('volume-down', 'DOWN'),
      key('mute', 'M'),
      key('volume-up', 'UP'),
      key('skip-intro', 'S'),
      key('fullscreen', 'F'),
      key('exit-fullscreen', 'ESCAPE'),
    ],
  },
  {
    // Spotify: https://support.spotify.com/article/keyboard-shortcuts/ (curtir Alt+Shift+B, aleatório Ctrl+S, repetir Ctrl+R).
    // Tocar, faixas e volume vão pelas teclas de mídia do Windows, que o Spotify atende mesmo sem estar em foco:
    // https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes (VK_MEDIA_*, VK_VOLUME_*).
    id: 'spotify',
    source: 'https://support.spotify.com/article/keyboard-shortcuts/',
    target: 'spotify',
    transport: {
      kind: 'track',
      previous: media('previous', 'PREVIOUS'),
      toggle: media('play-pause', 'PLAY_PAUSE'),
      next: media('next', 'NEXT'),
    },
    buttons: [
      media('volume-down', 'VOLUME_DOWN'),
      media('mute', 'MUTE'),
      media('volume-up', 'VOLUME_UP'),
      key('shuffle', 'S', 'CTRL'),
      key('like', 'B', 'ALT', 'SHIFT'),
      key('repeat', 'R', 'CTRL'),
    ],
  },
  {
    // VLC: https://vlc-user-documentation.readthedocs.io/en/latest/userguide/hotkeys.html e a tabela completa em
    // https://wiki.videolan.org/Hotkeys_table/ (Alt+setas: salto de 10 s; V: trilha de legenda; S: parar).
    id: 'vlc',
    source: 'https://vlc-user-documentation.readthedocs.io/en/latest/userguide/hotkeys.html',
    target: 'vlc',
    transport: {
      kind: 'seek',
      previous: key('back-10', 'LEFT', 'ALT'),
      toggle: key('play-pause', 'SPACE'),
      next: key('forward-10', 'RIGHT', 'ALT'),
    },
    buttons: [
      key('volume-down', 'DOWN', 'CTRL'),
      key('mute', 'M'),
      key('volume-up', 'UP', 'CTRL'),
      keyV2('slower', 'MINUS'),
      keyV2('normal-speed', 'EQUALS'),
      // "+" não é tecla do contrato (no teclado é Shift+=, que o VLC lê como outra combinação): sai digitado.
      text('faster', '+'),
      key('subtitles', 'V'),
      key('fullscreen', 'F'),
      key('stop', 'S'),
    ],
  },
  {
    // A fileira de dígitos (o contrato não tem as teclas do teclado numérico em si; para digitar números dá no mesmo).
    id: 'teclado-numerico',
    source: 'https://learn.microsoft.com/windows/win32/inputdev/virtual-key-codes',
    needs: 'key-v2',
    buttons: [
      keyV2('1', 'D1'),
      keyV2('2', 'D2'),
      keyV2('3', 'D3'),
      keyV2('4', 'D4'),
      keyV2('5', 'D5'),
      keyV2('6', 'D6'),
      keyV2('7', 'D7'),
      keyV2('8', 'D8'),
      keyV2('9', 'D9'),
      keyV2(',', 'COMMA'),
      keyV2('0', 'D0'),
      key('backspace', 'BACKSPACE'),
      keyV2('-', 'MINUS'),
      keyV2('.', 'PERIOD'),
      key('enter', 'ENTER'),
    ],
  },
];

const BY_ID = new Map(REMOTES.map((remote) => [remote.id, remote]));

export function remoteById(id: string | null | undefined): PcRemote | undefined {
  return id ? BY_ID.get(id as RemoteId) : undefined;
}
