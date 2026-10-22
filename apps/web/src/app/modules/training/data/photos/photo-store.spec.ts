import { TestBed } from '@angular/core/testing';
import { ExportDelivery, type ShareOutcome } from '../export/export-delivery';
import { ExportService } from '../export/export-service';
import { TRAINING_RESOURCE_SYNCS } from '../sync/resource-sync';
import { setupTraining } from '../sync/training-test-kit';
import type { EncodedPhoto, EncodeOptions, PhotoEncoder } from './photo-encoder';
import { PHOTO_ENCODER, type PhotoAddResult, PhotoStore } from './photo-store';

// O relógio falso do teste marca 09/10/2025: é o "hoje" do aparelho.
const TODAY = '2025-10-09';

async function jpegBlob(content: string): Promise<Blob> {
  return new Blob([content], { type: 'image/jpeg' });
}

class FakeEncoder implements PhotoEncoder {
  calls: { size: number; options: EncodeOptions }[] = [];
  result: 'ok' | 'not-an-image' | 'throws' = 'ok';
  width = 1280;
  height = 960;
  content = 'jpeg-bytes';

  async encode(file: Blob, options: EncodeOptions): Promise<EncodedPhoto | null> {
    this.calls.push({ size: file.size, options });
    if (this.result === 'throws') throw new Error('falhou ao decodificar');
    if (this.result === 'not-an-image') return null;
    return { blob: await jpegBlob(this.content), width: this.width, height: this.height };
  }
}

class FakeDelivery {
  downloads: { blob: Blob; filename: string }[] = [];
  shares: { file?: File }[] = [];
  outcome: ShareOutcome = 'shared';

  download(blob: Blob, filename: string): void {
    this.downloads.push({ blob, filename });
  }

  async share(payload: { file?: File }): Promise<ShareOutcome> {
    this.shares.push(payload);
    return this.outcome;
  }
}

const quota = () => Object.assign(new Error('cheio'), { name: 'QuotaExceededError' });

function setup() {
  const training = setupTraining();
  const encoder = new FakeEncoder();
  const delivery = new FakeDelivery();
  TestBed.configureTestingModule({
    providers: [
      { provide: PHOTO_ENCODER, useValue: encoder },
      { provide: ExportDelivery, useValue: delivery },
    ],
  });
  training.pause();
  return {
    ...training,
    encoder,
    delivery,
    store: TestBed.inject(PhotoStore),
    outbox: () => training.db.outbox.orderBy('createdAt').toArray(),
  };
}

const original = () => new File(['foto-original-grande'], 'IMG_0001.heic', { type: 'image/heic' });

function saved(result: PhotoAddResult) {
  if (result.status !== 'saved') throw new Error(`esperava "saved", veio "${result.status}"`);
  return result.photo;
}

afterEach(() => {
  // O jsdom não tem `navigator.storage`: os testes de cota o definem e aqui se limpa (a suíte inteira divide o mesmo jsdom).
  Reflect.deleteProperty(navigator, 'storage');
});

describe('PhotoStore', () => {
  describe('add', () => {
    it('reduces the image (longest side 1280, JPEG 0,8) and stores only the reduced one, on the device', async () => {
      const t = setup();

      const photo = saved(await t.store.add(original()));

      expect(t.encoder.calls).toEqual([
        { size: original().size, options: { maxSide: 1280, quality: 0.8 } },
      ]);
      expect(photo).toMatchObject({
        takenOn: TODAY,
        width: 1280,
        height: 960,
        bytes: 'jpeg-bytes'.length,
      });
      expect(photo.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
      const row = await t.trainingDb.photos.get(photo.id);
      expect(row?.data.byteLength).toBe('jpeg-bytes'.length);
      expect(row?.bytes).toBe(row?.data.byteLength);
      expect(row?.type).toBe('image/jpeg');
      // A lista não carrega o blob.
      expect(Object.keys((await t.store.list())[0])).not.toContain('blob');
    });

    it('keeps the bytes as an ArrayBuffer, never as a Blob (the WebKit IndexedDB refuses a Blob in an ephemeral session)', async () => {
      const t = setup();
      const photo = saved(await t.store.add(original()));

      const row = (await t.trainingDb.photos.get(photo.id)) as unknown as Record<string, unknown>;

      expect(Object.prototype.toString.call(row['data'])).toBe('[object ArrayBuffer]');
      expect(Object.keys(row)).not.toContain('blob');
    });

    it('takes the day the owner gave', async () => {
      const t = setup();

      expect(saved(await t.store.add(original(), '2025-09-30')).takenOn).toBe('2025-09-30');
    });

    it('is not an image: nothing is stored', async () => {
      const t = setup();
      t.encoder.result = 'not-an-image';

      expect(await t.store.add(new File(['x'], 'nota.txt'))).toEqual({ status: 'invalid-image' });

      expect(await t.trainingDb.photos.count()).toBe(0);
    });

    it('treats an encoder that throws as an image it cannot read', async () => {
      const t = setup();
      t.encoder.result = 'throws';

      expect(await t.store.add(original())).toEqual({ status: 'invalid-image' });

      expect(await t.trainingDb.photos.count()).toBe(0);
    });

    it('turns a full device into a typed result the screen can show ("não coube no aparelho")', async () => {
      const t = setup();
      vi.spyOn(t.trainingDb.photos, 'add').mockRejectedValue(quota());

      expect(await t.store.add(original())).toEqual({ status: 'storage-full' });

      expect(await t.trainingDb.photos.count()).toBe(0);
    });

    it('recognizes the quota error when Dexie wraps it', async () => {
      const t = setup();
      const wrapped = Object.assign(new Error('abortado'), { name: 'AbortError', inner: quota() });
      vi.spyOn(t.trainingDb.photos, 'add').mockRejectedValue(wrapped);

      expect(await t.store.add(original())).toEqual({ status: 'storage-full' });
    });

    it('does not hide an error that is not about space', async () => {
      const t = setup();
      vi.spyOn(t.trainingDb.photos, 'add').mockRejectedValue(new Error('outro problema'));

      await expect(t.store.add(original())).rejects.toThrow('outro problema');
    });

    it('bumps the revision on every change', async () => {
      const t = setup();
      const before = t.store.revision();

      const photo = saved(await t.store.add(original()));
      const afterAdd = t.store.revision();
      await t.store.remove(photo.id);

      expect(afterAdd).toBeGreaterThan(before);
      expect(t.store.revision()).toBeGreaterThan(afterAdd);
    });
  });

  describe('list', () => {
    it('is newest first by the day of the photo, and the one added last first on the same day', async () => {
      const t = setup();
      const old = saved(await t.store.add(original(), '2025-08-01'));
      const first = saved(await t.store.add(original(), '2025-10-05'));
      t.runtime.advance(1000);
      const second = saved(await t.store.add(original(), '2025-10-05'));
      const middle = saved(await t.store.add(original(), '2025-09-01'));

      expect((await t.store.list()).map((photo) => photo.id)).toEqual([
        second.id,
        first.id,
        middle.id,
        old.id,
      ]);
    });

    it('is empty with no photo', async () => {
      const t = setup();

      expect(await t.store.list()).toEqual([]);
    });
  });

  describe('dataUrl', () => {
    it('gives a data: URL with the exact bytes of the stored photo, never a blob: URL', async () => {
      const t = setup();
      t.encoder.content = 'ÿØÿà-bytes-da-foto';
      const photo = saved(await t.store.add(original()));

      const url = await t.store.dataUrl(photo.id);

      expect(url).not.toBeNull();
      expect(url as string).toMatch(/^data:image\/jpeg;base64,/);
      expect((url as string).startsWith('blob:')).toBe(false);
      const decoded = Uint8Array.from(atob((url as string).split(',')[1]), (c) => c.charCodeAt(0));
      const expected = new Uint8Array(await (await jpegBlob('ÿØÿà-bytes-da-foto')).arrayBuffer());
      expect(decoded).toEqual(expected);
    });

    it('survives a photo bigger than the argument limit of one call (hundreds of KB)', async () => {
      const t = setup();
      t.encoder.content = 'a'.repeat(400_000);
      const photo = saved(await t.store.add(original()));

      const url = (await t.store.dataUrl(photo.id)) as string;

      expect(url.length).toBeGreaterThan(500_000);
      expect(atob(url.split(',')[1])).toHaveLength(400_000);
    });

    it('is null for a photo that does not exist', async () => {
      const t = setup();

      expect(await t.store.dataUrl('nao-existe')).toBeNull();
    });
  });

  describe('remove', () => {
    it('removes the photo from the device, and says when there was none', async () => {
      const t = setup();
      const photo = saved(await t.store.add(original()));

      expect(await t.store.remove(photo.id)).toBe(true);
      expect(await t.store.remove(photo.id)).toBe(false);

      expect(await t.store.list()).toEqual([]);
      expect(await t.store.dataUrl(photo.id)).toBeNull();
    });
  });

  describe('shareFile', () => {
    it('hands the system share sheet a JPEG file with the day in its name', async () => {
      const t = setup();
      t.encoder.content = 'conteudo';
      const photo = saved(await t.store.add(original(), '2025-10-05'));

      expect(await t.store.shareFile(photo.id)).toBe('shared');

      expect(t.delivery.shares).toHaveLength(1);
      const file = t.delivery.shares[0].file as File;
      expect(file.name).toBe('progresso-2025-10-05.jpg');
      expect(file.type).toBe('image/jpeg');
      expect(file.size).toBe('conteudo'.length);
      expect(t.delivery.downloads).toEqual([]);
    });

    it('does not download when the owner closes the sheet on purpose', async () => {
      const t = setup();
      const photo = saved(await t.store.add(original()));
      t.delivery.outcome = 'cancelled';

      expect(await t.store.shareFile(photo.id)).toBe('cancelled');

      expect(t.delivery.downloads).toEqual([]);
    });

    it('downloads the file when the system cannot share files', async () => {
      const t = setup();
      const photo = saved(await t.store.add(original(), '2025-10-05'));
      t.delivery.outcome = 'unsupported';

      expect(await t.store.shareFile(photo.id)).toBe('downloaded');

      expect(t.delivery.downloads).toHaveLength(1);
      expect(t.delivery.downloads[0].filename).toBe('progresso-2025-10-05.jpg');
      expect((t.delivery.downloads[0].blob as File).type).toBe('image/jpeg');
    });

    it('says when there is no such photo, without opening any sheet', async () => {
      const t = setup();

      expect(await t.store.shareFile('nao-existe')).toBe('not-found');

      expect(t.delivery.shares).toEqual([]);
      expect(t.delivery.downloads).toEqual([]);
    });
  });

  describe('usage', () => {
    it('sums the photos and reports the share of the browser quota', async () => {
      const t = setup();
      t.encoder.content = 'a'.repeat(1000);
      saved(await t.store.add(original()));
      saved(await t.store.add(original()));
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({ usage: 50_000, quota: 100_000 }) },
      });

      expect(await t.store.usage()).toEqual({
        photoCount: 2,
        photoBytes: 2000,
        usageBytes: 50_000,
        quotaBytes: 100_000,
        usedPercent: 50,
        photosPercent: 2,
      });
    });

    it('has no quota figures when the browser has no estimate, and that is not an error', async () => {
      const t = setup();
      saved(await t.store.add(original()));

      expect(await t.store.usage()).toEqual({
        photoCount: 1,
        photoBytes: 'jpeg-bytes'.length,
        usageBytes: null,
        quotaBytes: null,
        usedPercent: null,
        photosPercent: null,
      });
    });

    it('survives an estimate that fails or that answers with nothing useful', async () => {
      const t = setup();
      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => Promise.reject(new Error('sem estimativa')) },
      });
      expect((await t.store.usage()).quotaBytes).toBeNull();

      Object.defineProperty(navigator, 'storage', {
        configurable: true,
        value: { estimate: async () => ({}) },
      });
      expect(await t.store.usage()).toMatchObject({
        quotaBytes: null,
        usedPercent: null,
        photosPercent: null,
      });
    });
  });
});

describe('photos stay on the device', () => {
  it('never reach the write queue: adding, sharing and removing leave it empty', async () => {
    const t = setup();

    const photo = saved(await t.store.add(original()));
    await t.store.shareFile(photo.id);
    await t.store.remove(photo.id);

    expect(await t.outbox()).toHaveLength(0);
    expect(t.queue().pendingCount()).toBe(0);
  });

  it('are not a synchronized resource: the pull never asks the server for photos', () => {
    setup();

    const resources = TestBed.inject(TRAINING_RESOURCE_SYNCS);

    expect(resources.map((resource) => resource.path).join(' ')).not.toMatch(/photo|foto/i);
    expect(resources.map((resource) => resource.resource)).not.toContain('photos');
  });

  it('never go into the JSON export, with or without photos stored', async () => {
    const t = setup();
    t.encoder.content = 'SEGREDO-DA-FOTO';
    saved(await t.store.add(original()));

    const document = await TestBed.inject(ExportService).buildJson();
    const text = JSON.stringify(document);

    expect(Object.keys(document.sections)).not.toContain('photos');
    expect(text).not.toContain('SEGREDO-DA-FOTO');
    expect(text).not.toMatch(/photo|foto|data:image|base64/i);
  });
});
