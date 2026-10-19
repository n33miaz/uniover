import { Component } from '@angular/core';

/** A tela da TV chega com o módulo de controle; por ora só ocupa o lugar na casca. */
@Component({
  selector: 'app-tv-page',
  template: `<p class="soon" i18n="@@tv.placeholder">
    O controle da TV ainda não está disponível.
  </p>`,
})
export class TvPage {}
