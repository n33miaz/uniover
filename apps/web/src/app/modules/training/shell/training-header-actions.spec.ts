import { TestBed } from '@angular/core/testing';
import { TrainingHeaderActions } from './training-header-actions';

describe('TrainingHeaderActions', () => {
  const actions = () => TestBed.inject(TrainingHeaderActions);

  it('registers an action, replaces the one with the same id and removes only its own on cleanup', () => {
    const first = vi.fn();
    const second = vi.fn();
    const removeFirst = actions().register({ id: 'menu', label: 'Opções', run: first });
    expect(
      actions()
        .actions()
        .map((item) => item.id),
    ).toEqual(['menu']);

    // Outra tela com o mesmo id toma o lugar; a limpeza da primeira não pode apagar a nova.
    const removeSecond = actions().register({ id: 'menu', label: 'Opções', run: second });
    expect(actions().actions()).toHaveLength(1);
    removeFirst();
    expect(actions().actions()).toHaveLength(1);
    actions().actions()[0].run();
    expect(second).toHaveBeenCalledOnce();
    expect(first).not.toHaveBeenCalled();

    removeSecond();
    expect(actions().actions()).toEqual([]);
  });

  it('keeps one back handler and clears it only when it is still the registered one', () => {
    const a = vi.fn();
    const b = vi.fn();
    const removeA = actions().registerBack(a);
    const removeB = actions().registerBack(b);
    removeA();
    expect(actions().backHandler()).toBe(b);
    removeB();
    expect(actions().backHandler()).toBeNull();
  });
});
