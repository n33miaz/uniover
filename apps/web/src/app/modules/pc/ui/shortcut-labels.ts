import type { ShortcutGroup } from '../data/pc-shortcuts';

/** O título de cada grupo da folha de atalhos. */
export const GROUP_LABEL: Readonly<Record<ShortcutGroup | 'pinned', () => string>> = {
  pinned: () => $localize`:@@pc.sc.group.pinned:Fixados`,
  edit: () => $localize`:@@pc.sc.group.edit:Edição`,
  window: () => $localize`:@@pc.sc.group.window:Janela`,
  system: () => $localize`:@@pc.sc.group.system:Sistema`,
  browser: () => $localize`:@@pc.sc.group.browser:Navegador`,
  video: () => $localize`:@@pc.sc.group.video:Vídeo`,
  slides: () => $localize`:@@pc.sc.group.slides:Apresentação`,
};

/** O que cada atalho faz, em poucas palavras (a tecla aparece pequena embaixo). */
const LABELS: Readonly<Record<string, () => string>> = {
  copy: () => $localize`:@@pc.sc.copy:Copiar`,
  paste: () => $localize`:@@pc.sc.paste:Colar`,
  cut: () => $localize`:@@pc.sc.cut:Recortar`,
  undo: () => $localize`:@@pc.sc.undo:Desfazer`,
  redo: () => $localize`:@@pc.sc.redo:Refazer`,
  'select-all': () => $localize`:@@pc.sc.select-all:Selecionar Tudo`,
  save: () => $localize`:@@pc.sc.save:Salvar`,
  find: () => $localize`:@@pc.sc.find:Procurar`,

  'switch-window': () => $localize`:@@pc.sc.switch-window:Trocar Janela`,
  'close-window': () => $localize`:@@pc.sc.close-window:Fechar Janela`,
  'show-desktop': () => $localize`:@@pc.sc.show-desktop:Área de Trabalho`,
  'task-view': () => $localize`:@@pc.sc.task-view:Visão de Tarefas`,
  'snap-left': () => $localize`:@@pc.sc.snap-left:Encaixar à Esquerda`,
  'snap-right': () => $localize`:@@pc.sc.snap-right:Encaixar à Direita`,
  maximize: () => $localize`:@@pc.sc.maximize:Maximizar`,
  minimize: () => $localize`:@@pc.sc.minimize:Minimizar`,
  'minimize-all': () => $localize`:@@pc.sc.minimize-all:Minimizar Tudo`,

  lock: () => $localize`:@@pc.sc.lock:Bloquear`,
  explorer: () => $localize`:@@pc.sc.explorer:Explorador`,
  run: () => $localize`:@@pc.sc.run:Executar`,
  'task-manager': () => $localize`:@@pc.sc.task-manager:Gerenciador de Tarefas`,
  'clipboard-history': () =>
    $localize`:@@pc.sc.clipboard-history:Histórico da Área de Transferência`,
  screenshot: () => $localize`:@@pc.sc.screenshot:Captura de Tela`,
  settings: () => $localize`:@@pc.sc.settings:Configurações`,
  search: () => $localize`:@@pc.sc.search:Pesquisar`,
  project: () => $localize`:@@pc.sc.project:Projetar`,
  'quick-menu': () => $localize`:@@pc.sc.quick-menu:Menu Rápido`,

  'new-tab': () => $localize`:@@pc.sc.new-tab:Nova Aba`,
  'close-tab': () => $localize`:@@pc.sc.close-tab:Fechar Aba`,
  'reopen-tab': () => $localize`:@@pc.sc.reopen-tab:Reabrir Aba`,
  'next-tab': () => $localize`:@@pc.sc.next-tab:Aba Seguinte`,
  'previous-tab': () => $localize`:@@pc.sc.previous-tab:Aba Anterior`,
  reload: () => $localize`:@@pc.sc.reload:Atualizar`,
  back: () => $localize`:@@pc.sc.back:Voltar`,
  forward: () => $localize`:@@pc.sc.forward:Avançar`,
  address: () => $localize`:@@pc.sc.address:Endereço`,
  'new-window': () => $localize`:@@pc.sc.new-window:Nova Janela`,
  'browser-fullscreen': () => $localize`:@@pc.sc.browser-fullscreen:Tela Cheia`,

  'play-pause': () => $localize`:@@pc.sc.play-pause:Tocar ou Pausar`,
  'video-fullscreen': () => $localize`:@@pc.sc.video-fullscreen:Tela Cheia do Vídeo`,
  'video-back-5': () => $localize`:@@pc.sc.video-back-5:Voltar 5 s`,
  'video-forward-5': () => $localize`:@@pc.sc.video-forward-5:Avançar 5 s`,
  'video-back-10': () => $localize`:@@pc.sc.video-back-10:Voltar 10 s`,
  'video-forward-10': () => $localize`:@@pc.sc.video-forward-10:Avançar 10 s`,
  'video-volume-up': () => $localize`:@@pc.sc.video-volume-up:Volume +`,
  'video-volume-down': () => $localize`:@@pc.sc.video-volume-down:Volume −`,
  'video-mute': () => $localize`:@@pc.sc.video-mute:Mudo`,
  'video-subtitles': () => $localize`:@@pc.sc.video-subtitles:Legendas`,

  'slides-start': () => $localize`:@@pc.sc.slides-start:Iniciar`,
  'slides-here': () => $localize`:@@pc.sc.slides-here:Iniciar Daqui`,
  'slides-next': () => $localize`:@@pc.sc.slides-next:Próximo Slide`,
  'slides-previous': () => $localize`:@@pc.sc.slides-previous:Slide Anterior`,
  'slides-black': () => $localize`:@@pc.sc.slides-black:Tela Preta`,
  'slides-white': () => $localize`:@@pc.sc.slides-white:Tela Branca`,
  'slides-end': () => $localize`:@@pc.sc.slides-end:Encerrar`,
};

/** O rótulo do atalho; o id (em inglês, só para dentro) é o único recurso se faltar o texto. */
export function shortcutLabel(id: string): string {
  return LABELS[id]?.() ?? id;
}

/** Os ids que têm rótulo (o teste confere o catálogo inteiro contra isto). */
export const LABELLED_SHORTCUTS: readonly string[] = Object.keys(LABELS);
