/**
 * Os nomes que a pessoa reconhece dos apps de vídeo que o Modo Foco já conhece de fábrica. A lista de apps instalados da TV
 * traz o nome certo de cada um; este mapa só cobre o que ela não traz (app que o administrador deixou no catálogo e que
 * não está instalado agora), para a tela nunca mostrar o identificador do pacote quando há um nome melhor.
 */
export const FOCUS_APP_NAMES: Readonly<Record<string, string>> = {
  'com.amazon.amazonvideo.livingroom': 'Prime Video',
  'com.apple.atve.androidtv.appletv': 'Apple TV',
  'com.cbs.ott': 'Paramount+',
  'com.cnvs.apptv': 'CineVS',
  'com.crunchyroll.crunchyroid': 'Crunchyroll',
  'com.disney.disneyplus': 'Disney+',
  'com.globo.globotv': 'Globoplay',
  'com.google.android.youtube.tv': 'YouTube',
  'com.netflix.ninja': 'Netflix',
  'com.plexapp.android': 'Plex',
  'com.wbd.stream': 'Max',
  'org.videolan.vlc': 'VLC',
  'org.xbmc.kodi': 'Kodi',
  'tv.pluto.android': 'Pluto TV',
  'tv.twitch.android.app': 'Twitch',
};
