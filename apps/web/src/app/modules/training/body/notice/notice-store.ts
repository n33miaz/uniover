import { Injectable, inject, signal } from '@angular/core';
import { TRAINING_DB } from '../../data/training-db';

/** Chave, na tabela `meta` do banco local, de "o dono já leu o aviso de saúde completo". */
export const META_BODY_NOTICE_SEEN = 'body.notice.seen';

/**
 * Guarda, só neste aparelho, que o dono já leu o aviso de saúde completo: a primeira abertura mostra o texto inteiro com
 * "Entendi", e depois fica só o cartão curto (com o texto completo atrás de um toque). É o único ponto desta tela que fala
 * direto com o banco local, e só na tabela `meta` (um sinalizador, nenhum dado de saúde): por isso não passa pela fila.
 *
 * Banco que não abre não vira erro: o aviso completo continua aparecendo (o lado seguro) e o "Entendi" vale até fechar a tela.
 */
@Injectable()
export class BodyNoticeStore {
  private readonly db = inject(TRAINING_DB);
  private readonly _seen = signal<boolean | null>(null);

  /** `null` até a leitura terminar; depois, se o aviso completo já foi aceito. */
  readonly seen = this._seen.asReadonly();

  constructor() {
    void this.read();
  }

  /** O dono tocou em "Entendi". */
  async acknowledge(): Promise<void> {
    this._seen.set(true);
    try {
      await this.db.meta.put({ key: META_BODY_NOTICE_SEEN, value: true });
    } catch {
      // Sem como guardar: vale nesta abertura, e o aviso volta na próxima.
    }
  }

  private async read(): Promise<void> {
    let seen = false;
    try {
      seen = (await this.db.meta.get(META_BODY_NOTICE_SEEN))?.value === true;
    } catch {
      // Banco que não abre: o aviso aparece.
    }
    // Um "Entendi" que chegou durante a leitura não se desfaz.
    if (this._seen() !== true) this._seen.set(seen);
  }
}
