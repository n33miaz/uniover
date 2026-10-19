// Habilita $localize nos testes (no build isso vem de polyfills).
import '@angular/localize/init';

// O jsdom não implementa o <dialog> modal; este substituto só alterna o atributo `open`.
if (typeof HTMLDialogElement !== 'undefined' && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}
