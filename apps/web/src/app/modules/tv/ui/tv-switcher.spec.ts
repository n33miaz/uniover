import { TestBed } from '@angular/core/testing';
import { TvStore } from '../data/tv-store';
import { FakeTvStore, createFakeTvStore, makeTv } from '../tv-test-kit';
import { TvSwitcher } from './tv-switcher';

describe('TvSwitcher', () => {
  let store: FakeTvStore;
  let fixture: ReturnType<typeof TestBed.createComponent<TvSwitcher>>;
  let root: HTMLElement;
  let picked: string[];

  const CASA = makeTv('casa', { name: 'Casa', isDefault: true });
  const AMIGO = makeTv('amigo', { name: 'Raphael', online: false, kind: 'samsung' });

  const rows = () => [...root.querySelectorAll<HTMLButtonElement>('button.ui-row')];
  const titles = () => rows().map((row) => row.querySelector('.ui-row-title')?.textContent?.trim());

  const mount = () => {
    store = createFakeTvStore();
    store.tvs.set([CASA, AMIGO]);
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(TvSwitcher);
    picked = [];
    fixture.componentInstance.pick.subscribe((id) => picked.push(id));
    fixture.detectChanges();
    root = fixture.nativeElement;
  };

  it('lists the TVs the account sees and renews the list when it opens', () => {
    mount();
    expect(titles()).toEqual(['Casa', 'Raphael']);
    expect(store.refreshTvs).toHaveBeenCalledTimes(1);
  });

  it('marks the TV in use with aria-current, and only that one', () => {
    mount();
    expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual(['true', null]);
    store.selectTv('amigo');
    fixture.detectChanges();
    expect(rows().map((row) => row.getAttribute('aria-current'))).toEqual([null, 'true']);
  });

  it('says the state in words (the dot is only a drawing) and has a dot for each TV', () => {
    mount();
    const subs = rows().map((row) => row.querySelector('.ui-row-sub')?.textContent?.trim());
    expect(subs).toEqual(['conectada', 'agente desligado']);
    expect(root.querySelectorAll('app-status-dot')).toHaveLength(2);
    expect(root.querySelector('app-status-dot svg')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('asks to switch to the TV that was touched, including the one already in use', () => {
    mount();
    rows()[1].click();
    rows()[0].click();
    expect(picked).toEqual(['amigo', 'casa']);
  });

  it('shows nothing while the list has not arrived', () => {
    store = createFakeTvStore();
    TestBed.configureTestingModule({ providers: [{ provide: TvStore, useValue: store }] });
    fixture = TestBed.createComponent(TvSwitcher);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('button.ui-row')).toHaveLength(0);
  });
});
