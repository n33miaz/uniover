import type { RemoteId } from '../data/pc-remotes';

/** O nome de cada controle (as marcas não se traduzem). */
const NAMES: Readonly<Record<RemoteId, () => string>> = {
  navegador: () => $localize`:@@pc.remote.browser:Navegador`,
  youtube: () => 'YouTube',
  netflix: () => 'Netflix',
  spotify: () => 'Spotify',
  vlc: () => 'VLC',
  'teclado-numerico': () => $localize`:@@pc.remote.numpad:Teclado Numérico`,
};

export function remoteName(id: RemoteId): string {
  return NAMES[id]();
}

/** O aviso de quando outro programa estava na frente e nada foi apertado (o teclado numérico não confere). */
const NOT_IN_FRONT: Readonly<Partial<Record<RemoteId, () => string>>> = {
  navegador: () =>
    $localize`:@@pc.remote.not-in-front.browser:Abra o navegador no PC e deixe-o na frente.`,
  youtube: () =>
    $localize`:@@pc.remote.not-in-front.youtube:Abra o YouTube no PC e deixe-o na frente.`,
  netflix: () =>
    $localize`:@@pc.remote.not-in-front.netflix:Abra a Netflix no PC e deixe-a na frente.`,
  spotify: () =>
    $localize`:@@pc.remote.not-in-front.spotify:Abra o Spotify no PC e deixe-o na frente.`,
  vlc: () => $localize`:@@pc.remote.not-in-front.vlc:Abra o VLC no PC e deixe-o na frente.`,
};

export function remoteNotInFront(id: RemoteId): string {
  return (
    NOT_IN_FRONT[id]?.() ??
    $localize`:@@pc.error.not-in-front:Abra o programa no PC e deixe-o na frente.`
  );
}

/** A dica de um botão que só sai segurando (fechar a aba). */
export const holdHint = (): string => $localize`:@@pc.remote.hold-hint:Segure para fechar`;

/** Um PC que ainda não confere o programa da frente: as teclas do controle ficam desligadas. */
export const needsUpdateHint = (): string =>
  $localize`:@@pc.remote.needs-update:Atualize o UniOver no PC para usar este controle.`;

/**
 * O rótulo curto de cada botão (o mesmo id vale em todos os controles: "Mudo" é mudo no YouTube e no VLC). Os botões do
 * navegador usam os ids do catálogo de atalhos. As teclas do teclado numérico são o próprio caractere e não estão aqui.
 */
const LABELS: Readonly<Record<string, () => string>> = {
  back: () => $localize`:@@pc.remote.back:Voltar`,
  forward: () => $localize`:@@pc.remote.forward:Avançar`,
  reload: () => $localize`:@@pc.remote.reload:Atualizar`,
  'previous-tab': () => $localize`:@@pc.remote.previous-tab:Aba Anterior`,
  'new-tab': () => $localize`:@@pc.remote.new-tab:Nova Aba`,
  'next-tab': () => $localize`:@@pc.remote.next-tab:Aba Seguinte`,
  'zoom-out': () => $localize`:@@pc.remote.zoom-out:Zoom −`,
  'close-tab': () => $localize`:@@pc.remote.close-tab:Fechar Aba`,
  'zoom-in': () => $localize`:@@pc.remote.zoom-in:Zoom +`,
  'browser-fullscreen': () => $localize`:@@pc.remote.fullscreen:Tela Cheia`,

  'back-10': () => $localize`:@@pc.video.back-10:Voltar 10 segundos`,
  'play-pause': () => $localize`:@@pc.media.play-pause:Tocar ou pausar`,
  'forward-10': () => $localize`:@@pc.video.forward-10:Avançar 10 segundos`,
  previous: () => $localize`:@@pc.media.previous:Faixa anterior`,
  next: () => $localize`:@@pc.media.next:Próxima faixa`,

  'volume-down': () => $localize`:@@pc.remote.volume-down:Volume −`,
  mute: () => $localize`:@@pc.remote.mute:Mudo`,
  'volume-up': () => $localize`:@@pc.remote.volume-up:Volume +`,
  slower: () => $localize`:@@pc.remote.slower:Mais Lento`,
  faster: () => $localize`:@@pc.remote.faster:Mais Rápido`,
  'normal-speed': () => $localize`:@@pc.remote.normal-speed:Velocidade 1x`,
  subtitles: () => $localize`:@@pc.remote.subtitles:Legendas`,
  fullscreen: () => $localize`:@@pc.remote.fullscreen:Tela Cheia`,
  'exit-fullscreen': () => $localize`:@@pc.remote.exit-fullscreen:Sair da Tela Cheia`,
  'previous-video': () => $localize`:@@pc.remote.previous-video:Vídeo Anterior`,
  'next-video': () => $localize`:@@pc.remote.next-video:Próximo Vídeo`,
  'skip-intro': () => $localize`:@@pc.remote.skip-intro:Pular Abertura`,
  shuffle: () => $localize`:@@pc.remote.shuffle:Aleatório`,
  like: () => $localize`:@@pc.remote.like:Curtir`,
  repeat: () => $localize`:@@pc.remote.repeat:Repetir`,
  stop: () => $localize`:@@pc.remote.stop:Parar`,

  backspace: () => $localize`:@@pc.remote.backspace:Apagar`,
  enter: () => $localize`:@@pc.remote.enter:Enter`,
};

/** O rótulo do botão; sem um, o próprio id (é o caso das teclas do teclado numérico, que são o caractere). */
export function remoteButtonLabel(id: string): string {
  return LABELS[id]?.() ?? id;
}

/** Os ids que têm rótulo (o teste confere os controles contra isto). */
export const LABELLED_REMOTE_BUTTONS: readonly string[] = Object.keys(LABELS);
