import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { ApiProblem, networkProblem } from '../../core/auth/api-problem';
import { ShoppingPeople } from './shopping-people';
import { ShoppingPeopleApi, type ShoppingPerson } from './shopping-people-api';

/** O servidor de mentira das pessoas: guarda quem está no grupo e anota cada pedido com a chave que veio. */
class FakePeople {
  isOwner = true;
  people: ShoppingPerson[] = [
    { userId: 'neemias', name: 'Neemias', isOwner: true, isMember: true },
    { userId: 'raphael', name: 'Raphael', isOwner: false, isMember: true },
    { userId: 'carla', name: 'Carla', isOwner: false, isMember: false },
  ];
  readonly calls: string[] = [];
  failWith: unknown = null;

  async group() {
    return { id: 'group-1', isOwner: this.isOwner };
  }

  async people_() {
    return this.people;
  }

  async setMember(userId: string, member: boolean, operationId: string) {
    this.calls.push(`${member ? 'add' : 'remove'}:${userId}:${operationId}`);
    if (this.failWith) throw this.failWith;
    this.people = this.people.map((person) =>
      person.userId === userId ? { ...person, isMember: member } : person,
    );
  }

  async leave(operationId: string) {
    this.calls.push(`leave:${operationId}`);
    if (this.failWith) throw this.failWith;
    this.people = [{ userId: 'raphael', name: 'Raphael', isOwner: true, isMember: true }];
    this.isOwner = true;
  }
}

describe('ShoppingPeople', () => {
  let api: FakePeople;
  let fixture: ComponentFixture<ShoppingPeople>;
  let el: HTMLElement;
  let changed: number;

  async function render(): Promise<void> {
    TestBed.configureTestingModule({
      providers: [
        {
          provide: ShoppingPeopleApi,
          useValue: {
            group: () => api.group(),
            people: () => api.people_(),
            setMember: (userId: string, member: boolean, id: string) =>
              api.setMember(userId, member, id),
            leave: (id: string) => api.leave(id),
          },
        },
      ],
    });
    fixture = TestBed.createComponent(ShoppingPeople);
    el = fixture.nativeElement as HTMLElement;
    changed = 0;
    fixture.componentInstance.changed.subscribe(() => (changed += 1));
    await settle();
  }

  async function settle(): Promise<void> {
    for (let turn = 0; turn < 3; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await fixture.whenStable();
      fixture.detectChanges();
    }
  }

  const names = (list: string) =>
    Array.from(el.querySelectorAll(`.${list} .ui-row-title`)).map((title) =>
      title.textContent?.trim(),
    );

  async function click(text: string): Promise<void> {
    const found = Array.from(el.querySelectorAll('button')).find((candidate) =>
      candidate.textContent?.replace(/\s+/g, ' ').trim().startsWith(text),
    );
    if (!found) throw new Error(`sem botão "${text}"`);
    found.click();
    await settle();
  }

  const alert = () => el.querySelector('[role="alert"]')?.textContent?.trim();

  beforeEach(() => {
    api = new FakePeople();
  });

  it('shows who shares the list and, to who created the group, who can be added', async () => {
    await render();

    expect(names('members')).toEqual(['Neemias', 'Raphael']);
    expect(names('candidates')).toEqual(['Carla']);
    expect(el.textContent).toContain('Criou o grupo');
    expect(el.textContent).not.toContain('Sair do grupo');
  });

  it('adds and removes a person, and tells the list to read the group again', async () => {
    await render();

    await click('Adicionar: Carla');
    expect(names('members')).toEqual(['Neemias', 'Raphael', 'Carla']);
    expect(el.textContent).toContain('Ninguém para adicionar');

    await click('Tirar: Raphael');
    expect(names('members')).toEqual(['Neemias', 'Carla']);
    expect(names('candidates')).toEqual(['Raphael']);
    expect(changed).toBe(2);
    expect(api.calls.map((call) => call.split(':').slice(0, 2).join(':'))).toEqual([
      'add:carla',
      'remove:raphael',
    ]);
  });

  it('says in plain words why a person could not be added, and changes nothing', async () => {
    await render();
    api.failWith = new ApiProblem(409, 'shopping-member-in-another-group', 'x');

    await click('Adicionar: Carla');

    expect(alert()).toBe(
      'Essa pessoa já tem uma lista com itens. Ela precisa esvaziar a dela antes.',
    );
    expect(names('members')).toEqual(['Neemias', 'Raphael']);
    expect(changed).toBe(0);
  });

  it('a person who changed group under the request is not told to empty a list', async () => {
    await render();
    api.failWith = new ApiProblem(409, 'shopping-group-changed', 'x');

    await click('Adicionar: Carla');

    expect(alert()).toBe('A situação mudou. Tente de novo.');
    expect(names('members')).toEqual(['Neemias', 'Raphael']);
    expect(changed).toBe(0);
  });

  it('tries again with the same key after no answer, so the change is never applied twice', async () => {
    await render();
    api.failWith = networkProblem();
    await click('Adicionar: Carla');
    expect(alert()).toBe('Sem sinal. Tente de novo quando voltar.');

    api.failWith = null;
    await click('Adicionar: Carla');

    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]).toBe(api.calls[1]);
    expect(alert()).toBeUndefined();
    expect(names('members')).toEqual(['Neemias', 'Raphael', 'Carla']);
  });

  it('a member only sees the people and can leave, after a second tap', async () => {
    api.isOwner = false;
    api.people = api.people.filter((person) => person.isMember);
    await render();

    expect(names('members')).toEqual(['Neemias', 'Raphael']);
    expect(el.querySelector('.candidates')).toBeNull();
    expect(el.textContent).not.toContain('Tirar');

    await click('Sair do grupo');
    expect(api.calls).toEqual([]);
    expect(el.textContent).toContain('Você fica com uma lista nova, vazia.');

    await click('Sair mesmo?');
    expect(api.calls).toHaveLength(1);
    expect(api.calls[0]).toMatch(/^leave:/);
    expect(changed).toBe(1);
    expect(names('members')).toEqual(['Raphael']);
  });

  it('offers to try again when the people could not be read', async () => {
    api.group = () => Promise.reject(networkProblem());
    await render();

    expect(alert()).toBe('Não deu para abrir as pessoas.');
    api.group = async () => ({ id: 'group-1', isOwner: true });
    await click('Tentar de Novo');
    expect(names('members')).toEqual(['Neemias', 'Raphael']);
  });
});
