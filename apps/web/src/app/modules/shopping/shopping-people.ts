import {
  ChangeDetectionStrategy,
  Component,
  computed,
  inject,
  output,
  signal,
} from '@angular/core';
import { problemOf } from '../../core/auth/api-problem';
import { uuidV7 } from '../../core/offline-queue/uuid-v7';
import { ShoppingPeopleApi, type ShoppingPerson } from './shopping-people-api';

/** O `type` (sufixo) da recusa de incluir quem já tem a própria lista com itens ou outras pessoas. */
const MEMBER_ELSEWHERE = 'shopping-member-in-another-group';
/** O `type` da recusa de quem mudou de grupo no meio do pedido: nada foi feito, tentar de novo vale. */
const GROUP_CHANGED = 'shopping-group-changed';

/**
 * As pessoas do grupo de compras: quem divide a lista, quem pode entrar e a saída. Só quem criou o grupo adiciona e
 * tira pessoas; os demais veem quem participa e podem sair. Não há papel nenhum além desse: são grupos e pessoas.
 */
@Component({
  selector: 'app-shopping-people',
  templateUrl: './shopping-people.html',
  styleUrl: './shopping-people.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ShoppingPeople {
  private readonly api = inject(ShoppingPeopleApi);
  /** Uma chave por toque em andamento; a mesma vale para tentar de novo, e some quando o servidor responde. */
  private readonly operations = new Map<string, string>();

  /** O grupo mudou (alguém entrou ou saiu): a lista da tela principal precisa ser lida de novo. */
  readonly changed = output<void>();

  protected readonly state = signal<'loading' | 'ready' | 'failed'>('loading');
  protected readonly owner = signal(false);
  protected readonly people = signal<readonly ShoppingPerson[]>([]);
  protected readonly busy = signal(false);
  protected readonly notice = signal<string | null>(null);
  protected readonly leaving = signal(false);

  protected readonly members = computed(() => this.people().filter((person) => person.isMember));
  protected readonly candidates = computed(() =>
    this.people().filter((person) => !person.isMember),
  );

  constructor() {
    void this.load();
  }

  protected async load(): Promise<void> {
    this.state.set('loading');
    try {
      const [group, people] = await Promise.all([this.api.group(), this.api.people()]);
      this.owner.set(group.isOwner);
      this.people.set(people);
      this.state.set('ready');
    } catch {
      this.state.set('failed');
    }
  }

  protected name(person: ShoppingPerson): string {
    return person.name || $localize`:@@shopping.people.unnamed:Pessoa sem nome`;
  }

  protected add(person: ShoppingPerson): Promise<void> {
    return this.run(`add:${person.userId}`, (id) => this.api.setMember(person.userId, true, id));
  }

  protected remove(person: ShoppingPerson): Promise<void> {
    return this.run(`remove:${person.userId}`, (id) =>
      this.api.setMember(person.userId, false, id),
    );
  }

  /** Sair pede dois toques: o primeiro só pergunta. */
  protected async leave(): Promise<void> {
    if (!this.leaving()) {
      this.leaving.set(true);
      return;
    }
    await this.run('leave', (id) => this.api.leave(id));
    this.leaving.set(false);
  }

  private async run(key: string, send: (operationId: string) => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.notice.set(null);
    const operationId = this.operations.get(key) ?? uuidV7();
    this.operations.set(key, operationId);
    try {
      await send(operationId);
      this.operations.delete(key);
      this.changed.emit();
      await this.load();
    } catch (error) {
      const problem = problemOf(error);
      // A recusa do servidor encerra esta chave; sem resposta, a mesma chave vale na próxima tentativa.
      if (problem && !problem.isNetwork) this.operations.delete(key);
      this.notice.set(this.failure(problem?.kind, problem?.isNetwork ?? false));
    } finally {
      this.busy.set(false);
    }
  }

  private failure(kind: string | undefined, network: boolean): string {
    if (kind === MEMBER_ELSEWHERE) {
      return $localize`:@@shopping.people.elsewhere:Essa pessoa já tem uma lista com itens. Ela precisa esvaziar a dela antes.`;
    }
    if (kind === GROUP_CHANGED) {
      return $localize`:@@shopping.group-changed:A situação mudou. Tente de novo.`;
    }
    return network
      ? $localize`:@@shopping.people.offline:Sem sinal. Tente de novo quando voltar.`
      : $localize`:@@shopping.people.failed:Não deu certo. Tente de novo.`;
  }
}
