import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { FakeRuntime } from '../../../../core/offline-queue/queue-test-kit';
import { QUEUE_RUNTIME } from '../../../../core/offline-queue/queue-ports';
import { ExportDelivery } from './export-delivery';

interface FakeNavigator {
  share?: ReturnType<typeof vi.fn>;
  canShare?: ReturnType<typeof vi.fn>;
  clipboard?: { writeText: ReturnType<typeof vi.fn> };
}

function setup(navigator: FakeNavigator) {
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: { display: '' },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const url = {
    createObjectURL: vi.fn(() => 'blob:arquivo'),
    revokeObjectURL: vi.fn(),
  };
  const body = { appendChild: vi.fn() };
  const doc = {
    defaultView: { URL: url, navigator },
    createElement: vi.fn(() => anchor),
    body,
  };
  const runtime = new FakeRuntime();
  TestBed.configureTestingModule({
    providers: [
      ExportDelivery,
      { provide: DOCUMENT, useValue: doc },
      { provide: QUEUE_RUNTIME, useValue: runtime },
    ],
  });
  return { delivery: TestBed.inject(ExportDelivery), anchor, url, body, doc, runtime };
}

const abort = () => Object.assign(new Error('fechou'), { name: 'AbortError' });
const denied = () => Object.assign(new Error('sem toque'), { name: 'NotAllowedError' });

describe('ExportDelivery', () => {
  describe('download', () => {
    it('clicks an anchor with the download name and frees the address later', () => {
      const t = setup({});
      const blob = new Blob(['x']);

      t.delivery.download(blob, 'treino.json');

      expect(t.url.createObjectURL).toHaveBeenCalledWith(blob);
      expect(t.doc.createElement).toHaveBeenCalledWith('a');
      expect(t.anchor).toMatchObject({ href: 'blob:arquivo', download: 'treino.json' });
      expect(t.body.appendChild).toHaveBeenCalledWith(t.anchor);
      expect(t.anchor.click).toHaveBeenCalledTimes(1);
      expect(t.anchor.remove).toHaveBeenCalledTimes(1);

      // O navegador ainda precisa do endereço depois do clique: ele só é liberado depois de um tempo.
      expect(t.url.revokeObjectURL).not.toHaveBeenCalled();
      t.runtime.advance(59_000);
      expect(t.url.revokeObjectURL).not.toHaveBeenCalled();
      t.runtime.advance(1_000);
      expect(t.url.revokeObjectURL).toHaveBeenCalledWith('blob:arquivo');
    });
  });

  describe('share', () => {
    it('shares a text by the system sheet, asking canShare first', async () => {
      const navigator = { share: vi.fn(async () => undefined), canShare: vi.fn(() => true) };
      const t = setup(navigator);

      const outcome = await t.delivery.share({ title: 'Resumo', text: 'Treinos: 3' });

      expect(outcome).toBe('shared');
      expect(navigator.canShare).toHaveBeenCalledWith({ title: 'Resumo', text: 'Treinos: 3' });
      expect(navigator.share).toHaveBeenCalledWith({ title: 'Resumo', text: 'Treinos: 3' });
    });

    it('shares a file when the system says it can share files', async () => {
      const navigator = { share: vi.fn(async () => undefined), canShare: vi.fn(() => true) };
      const t = setup(navigator);
      const file = new File(['x'], 'treino.csv', { type: 'text/csv' });

      expect(await t.delivery.share({ file })).toBe('shared');

      expect(navigator.canShare).toHaveBeenCalledWith({ files: [file] });
      expect(navigator.share).toHaveBeenCalledWith({ files: [file] });
    });

    it('shares even when canShare does not exist', async () => {
      const navigator = { share: vi.fn(async () => undefined) };
      const t = setup(navigator);

      expect(await t.delivery.share({ text: 'oi' })).toBe('shared');
    });

    it('falls back to copying the text when the system cannot share it', async () => {
      const navigator = {
        share: vi.fn(async () => undefined),
        canShare: vi.fn(() => false),
        clipboard: { writeText: vi.fn(async () => undefined) },
      };
      const t = setup(navigator);

      expect(await t.delivery.share({ text: 'Treinos: 3' })).toBe('copied');

      expect(navigator.share).not.toHaveBeenCalled();
      expect(navigator.clipboard.writeText).toHaveBeenCalledWith('Treinos: 3');
    });

    it('falls back to copying the text when there is no share at all', async () => {
      const navigator = { clipboard: { writeText: vi.fn(async () => undefined) } };
      const t = setup(navigator);

      expect(await t.delivery.share({ text: 'Treinos: 3' })).toBe('copied');
    });

    it('falls back to copying when the system refuses for a reason other than the user closing the sheet', async () => {
      const navigator = {
        share: vi.fn(async () => {
          throw denied();
        }),
        clipboard: { writeText: vi.fn(async () => undefined) },
      };
      const t = setup(navigator);

      expect(await t.delivery.share({ text: 'Treinos: 3' })).toBe('copied');
    });

    it('does not copy when the user closed the sheet: that is a decision, not a failure', async () => {
      const navigator = {
        share: vi.fn(async () => {
          throw abort();
        }),
        clipboard: { writeText: vi.fn(async () => undefined) },
      };
      const t = setup(navigator);

      expect(await t.delivery.share({ text: 'Treinos: 3' })).toBe('cancelled');

      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });

    it('says it is unsupported when nothing works', async () => {
      expect(await setup({}).delivery.share({ text: 'x' })).toBe('unsupported');
    });

    it('says it is unsupported when copying is refused too', async () => {
      const navigator = { clipboard: { writeText: vi.fn(async () => Promise.reject(denied())) } };
      const t = setup(navigator);

      expect(await t.delivery.share({ text: 'x' })).toBe('unsupported');
    });

    it('does not pretend to copy a file: without sharing support a file is unsupported (the caller downloads)', async () => {
      const navigator = {
        share: vi.fn(),
        canShare: vi.fn(() => false),
        clipboard: { writeText: vi.fn(async () => undefined) },
      };
      const t = setup(navigator);

      const outcome = await t.delivery.share({ file: new File(['x'], 'a.csv') });

      expect(outcome).toBe('unsupported');
      expect(navigator.clipboard.writeText).not.toHaveBeenCalled();
    });
  });
});
