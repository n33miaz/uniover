import { Injectable, signal } from '@angular/core';

export interface TrainingHeaderAction {
  readonly id: string;
  readonly label: string;
  readonly run: () => void;
}

/** Ações da tela aberta que entram no único menu do cabeçalho. */
@Injectable({ providedIn: 'root' })
export class TrainingHeaderActions {
  readonly actions = signal<readonly TrainingHeaderAction[]>([]);
  readonly backHandler = signal<(() => void) | null>(null);

  register(action: TrainingHeaderAction): () => void {
    this.actions.update((actions) => [...actions.filter((item) => item.id !== action.id), action]);
    return () => this.actions.update((actions) => actions.filter((item) => item !== action));
  }

  registerBack(handler: () => void): () => void {
    this.backHandler.set(handler);
    return () => {
      if (this.backHandler() === handler) this.backHandler.set(null);
    };
  }
}
