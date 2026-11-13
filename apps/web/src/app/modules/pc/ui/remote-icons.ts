import type { RemoteId } from '../data/pc-remotes';

/** O desenho de cada controle na lista (traço em 24×24, como os ícones da tela Mais). */
export const REMOTE_ICON: Readonly<Record<RemoteId, string>> = {
  navegador:
    'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M3.6 9h16.8M3.6 15h16.8M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18',
  youtube:
    'M3 8.5a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3v7a3 3 0 0 1-3 3H6a3 3 0 0 1-3-3zM10 9.2v5.6l4.8-2.8z',
  netflix: 'M8 4v16M16 4v16M8 4l8 16',
  spotify:
    'M3 12a9 9 0 1 0 18 0a9 9 0 1 0-18 0M7 9.5c3.5-1 7-.7 10 1M7.8 12.7c2.8-.7 5.6-.4 8 .9M8.5 15.7c2-.4 4.1-.2 6 .7',
  vlc: 'M12 3l2 6h-4zM9.3 11h5.4l1.3 4H8zM7.3 17h9.4l1.3 4H6z',
  'teclado-numerico':
    'M5 4h4v4H5zM10 4h4v4h-4zM15 4h4v4h-4zM5 10h4v4H5zM10 10h4v4h-4zM15 10h4v4h-4zM10 16h4v4h-4z',
};

/** O desenho de cada botão. Sem desenho (as teclas do teclado numérico), o botão mostra o caractere grande. */
const ICONS: Readonly<Record<string, string>> = {
  back: 'M19 12H5M11 6l-6 6 6 6',
  forward: 'M5 12h14M13 6l6 6-6 6',
  reload: 'M19 8a8 8 0 1 0 1 6M19 3v5h-5',
  'previous-tab': 'M3 7h8l1.5 2H21v10H3zM14 14H8M10.5 11.5 8 14l2.5 2.5',
  'new-tab': 'M3 7h8l1.5 2H21v10H3zM12 11.5v5M9.5 14h5',
  'next-tab': 'M3 7h8l1.5 2H21v10H3zM10 14h6M13.5 11.5 16 14l-2.5 2.5',
  'zoom-out': 'M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M15.5 15.5 20 20M7.5 10.5h6',
  'close-tab': 'M3 7h8l1.5 2H21v10H3zM9.5 11.5l5 5M14.5 11.5l-5 5',
  'zoom-in': 'M4 10.5a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M15.5 15.5 20 20M7.5 10.5h6M10.5 7.5v6',
  'browser-fullscreen': 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  fullscreen: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  'exit-fullscreen': 'M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5',

  'volume-down': 'M4 10v4h3.5L12 18V6L7.5 10zM16 12h5',
  mute: 'M4 10v4h3.5L12 18V6L7.5 10zM16 9.5l5 5M21 9.5l-5 5',
  'volume-up': 'M4 10v4h3.5L12 18V6L7.5 10zM16 12h5M18.5 9.5v5',
  slower: 'M12 20a8 8 0 1 1 8-8M12 12 8.5 9.5M17 17h5',
  faster: 'M12 20a8 8 0 1 1 8-8M12 12l4-3M17 17h5M19.5 14.5v5',
  'normal-speed': 'M12 20a8 8 0 1 1 8-8M12 12V7',
  subtitles: 'M3 6h18v12H3zM6.5 11h4M12.5 11h5M6.5 14.5h7M15.5 14.5h2',
  'previous-video': 'M7 6v12M18 6.5v11L9.5 12z',
  'next-video': 'M17 6v12M6 6.5v11L14.5 12z',
  'skip-intro': 'M5 6.5v11L12 12zM12 6.5v11L19 12z',
  shuffle:
    'M3 7h3.5c4 0 7 10 11 10H21M3 17h3.5c1.6 0 3-1.6 4.2-3.5M13.3 10.5C14.5 8.6 15.9 7 17.5 7H21M18.5 4.5 21 7l-2.5 2.5M18.5 14.5 21 17l-2.5 2.5',
  like: 'M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10z',
  repeat: 'M4 11V9a2 2 0 0 1 2-2h13M16 4l3 3-3 3M20 13v2a2 2 0 0 1-2 2H5M8 20l-3-3 3-3',
  stop: 'M6.5 6.5h11v11h-11z',
  backspace: 'M9 5h11v14H9l-6-7zM12 9.5l5 5M17 9.5l-5 5',
  enter: 'M20 5v7a2 2 0 0 1-2 2H5M9 10l-4 4 4 4',
};

export function remoteButtonIcon(id: string): string | undefined {
  return ICONS[id];
}
