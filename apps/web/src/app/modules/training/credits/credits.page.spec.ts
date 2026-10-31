import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { CREDIT_SOURCES } from './credits.data';
import { CreditsPage } from './credits.page';
import { WgerCredit, WgerCreditsReader } from './wger-credits';

describe('CreditsPage', () => {
  const read = vi.fn<() => Promise<WgerCredit[]>>();

  async function render(reader: Pick<WgerCreditsReader, 'read'> = { read }) {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), { provide: WgerCreditsReader, useValue: reader }],
    });
    const fixture = TestBed.createComponent(CreditsPage);
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement as HTMLElement;
  }

  beforeEach(() => read.mockReset().mockResolvedValue([]));

  const items = (el: HTMLElement) => Array.from(el.querySelectorAll<HTMLElement>('.list > li'));
  const fact = (item: HTMLElement, label: string) =>
    Array.from(item.querySelectorAll('dl div')).find(
      (row) => row.querySelector('dt')?.textContent?.trim() === label,
    );

  it('has no back link of its own: the header arrow is the only one', async () => {
    const el = await render();
    expect(el.querySelector('a.back')).toBeNull();
  });

  it('lists every source with title, author, source, license, what was done and where it shows', async () => {
    const el = await render();
    expect(items(el)).toHaveLength(CREDIT_SOURCES.length);
    for (const [index, source] of CREDIT_SOURCES.entries()) {
      const item = items(el)[index];
      expect(item.querySelector('h2')?.textContent?.trim()).toBe(source.title);
      expect(fact(item, 'Autor')?.textContent).toContain(source.author);
      expect(fact(item, 'Fonte')?.querySelector('a')?.getAttribute('href')).toBe(source.sourceUrl);
      expect(fact(item, 'Licença')?.querySelector('a')?.getAttribute('href')).toBe(
        source.licenseUrl,
      );
      expect(fact(item, 'O que foi feito')?.textContent).toContain(source.changes);
      expect(fact(item, 'Onde aparece')?.textContent).toContain(source.usage);
    }
  });

  it('credits Everkinetic with CC BY-SA 4.0 and no changes', async () => {
    const el = await render();
    const item = items(el)[0];
    expect(item.querySelector('h2')?.textContent).toContain('Everkinetic');
    expect(fact(item, 'Autor')?.textContent).toContain('Greg Priday');
    expect(fact(item, 'Licença')?.textContent).toContain('CC BY-SA 4.0');
    expect(fact(item, 'Licença')?.querySelector('a')?.getAttribute('href')).toBe(
      'https://creativecommons.org/licenses/by-sa/4.0/',
    );
    expect(fact(item, 'O que foi feito')?.textContent).toContain('Sem alterações');
  });

  it('says the free-exercise-db text was rewritten and its images are not used', async () => {
    const el = await render();
    const item = items(el)[1];
    expect(item.querySelector('h2')?.textContent).toContain('free-exercise-db');
    expect(fact(item, 'Licença')?.textContent).toContain('Unlicense');
    const changes = fact(item, 'O que foi feito')?.textContent ?? '';
    expect(changes).toContain('reescrito em português');
    expect(changes).toContain('As imagens dessa fonte não são usadas');
  });

  it('opens every external link outside the app without leaking the opener', async () => {
    read.mockResolvedValue([
      { author: 'Ana', license: 'CC-BY-SA 4', licenseUrl: 'https://example.com/l', count: 2 },
    ]);
    const el = await render();
    const external = Array.from(el.querySelectorAll<HTMLAnchorElement>('a[href^="http"]'));
    expect(external.length).toBeGreaterThanOrEqual(5);
    for (const link of external) {
      expect(link.target, link.href).toBe('_blank');
      expect(link.rel, link.href).toContain('noopener');
      expect(link.rel, link.href).toContain('noreferrer');
    }
  });

  it('hides the wger section when there is no wger exercise', async () => {
    const el = await render();
    expect(el.textContent).not.toContain('wger');
    expect(items(el)).toHaveLength(CREDIT_SOURCES.length);
  });

  it('shows the wger authors, licenses and counts read from the local database', async () => {
    read.mockResolvedValue([
      { author: 'Ana', license: 'CC-BY-SA 4', licenseUrl: 'https://example.com/l', count: 2 },
      { author: 'Bruno', license: 'CC-BY-SA 3', licenseUrl: null, count: 1 },
    ]);
    const el = await render();
    const section = items(el)[CREDIT_SOURCES.length];
    expect(section.querySelector('h2')?.textContent).toContain('wger');
    const authors = Array.from(section.querySelectorAll('.author'));
    const cells = (row: Element) =>
      Array.from(row.children).map((cell) => cell.textContent?.trim());
    expect(authors.map(cells)).toEqual([
      ['Ana', 'CC-BY-SA 4', '2 exercícios'],
      ['Bruno', 'CC-BY-SA 3', '1 exercício'],
    ]);
    expect(authors[0].querySelector('a')?.getAttribute('href')).toBe('https://example.com/l');
    expect(authors[1].querySelector('a')).toBeNull();
  });

  it('still shows the fixed sources when the local database fails', async () => {
    const el = await render({ read: () => Promise.reject(new Error('indexeddb indisponível')) });
    expect(items(el)).toHaveLength(CREDIT_SOURCES.length);
  });

  it('holds the wger section as a busy skeleton while the local database is read, then drops it', async () => {
    let finish: (credits: WgerCredit[]) => void = () => undefined;
    const pending = new Promise<WgerCredit[]>((resolve) => (finish = resolve));
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        { provide: WgerCreditsReader, useValue: { read: () => pending } },
      ],
    });
    const fixture = TestBed.createComponent(CreditsPage);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;

    const loading = el.querySelector('.wger-loading') as HTMLElement;
    expect(loading.querySelector('app-loading-frame')?.getAttribute('aria-busy')).toBe('true');
    expect(loading.querySelector('[role="status"]')?.textContent).toContain(
      'Carregando os autores do wger',
    );
    expect(loading.querySelectorAll('.ui-skeleton').length).toBeGreaterThan(1);

    finish([]);
    await fixture.whenStable();
    fixture.detectChanges();
    expect(el.querySelector('.wger-loading')).toBeNull();
    expect(items(el)).toHaveLength(CREDIT_SOURCES.length);
  });

  it('declares no inline style in the markup', async () => {
    read.mockResolvedValue([{ author: 'Ana', license: 'L', licenseUrl: null, count: 1 }]);
    const el = await render();
    expect(el.querySelector('[style]')).toBeNull();
  });
});
