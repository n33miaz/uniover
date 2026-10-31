/**
 * Nome do cache de execução das ilustrações. O service worker (`sw.ts`) serve a pasta da arte a partir dele, e o
 * aquecimento (`IllustrationPrefetcher`) também grava nele, direto da página: assim os arquivos ficam guardados mesmo
 * na primeira visita, quando o service worker ainda não controla a página e o `fetch` não passa por ele.
 */
export const EXERCISE_ART_CACHE = 'exercise-art';
