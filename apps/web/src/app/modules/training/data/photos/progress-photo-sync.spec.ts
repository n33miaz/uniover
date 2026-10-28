import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import {
  PROGRESS_PHOTO_API,
  type ProgressPhotoApi,
  type ProgressPhotoDto,
} from './progress-photo-api';
import { ProgressPhotoSync } from './progress-photo-sync';
import { PHOTO_ENCODER, PhotoStore } from './photo-store';
import type { EncodedPhoto, PhotoEncoder } from './photo-encoder';
import { setupTraining } from '../sync/training-test-kit';

class FakeEncoder implements PhotoEncoder {
  async encode(): Promise<EncodedPhoto> {
    return { blob: new Blob(['jpeg'], { type: 'image/jpeg' }), width: 40, height: 30 };
  }
}

class FakeProgressPhotoApi implements ProgressPhotoApi {
  readonly puts: string[] = [];
  readonly remote = new Map<string, { dto: ProgressPhotoDto; data: ArrayBuffer }>();
  online = true;
  failures = 0;
  deletes: string[] = [];
  deleteStatus: number | null = null;

  async list(): Promise<readonly ProgressPhotoDto[]> {
    if (!this.online) throw new Error('sem rede');
    return [...this.remote.values()].map((item) => item.dto);
  }

  async read(_accountId: string, id: string): Promise<ArrayBuffer> {
    const item = this.remote.get(id);
    if (!item) throw new Error('não encontrada');
    return item.data;
  }

  async put(
    _accountId: string,
    id: string,
    takenOn: string,
    bytes: ArrayBuffer,
  ): Promise<ProgressPhotoDto> {
    this.puts.push(id);
    if (!this.online || this.failures-- > 0) throw new Error('não enviou');
    const dto: ProgressPhotoDto = {
      id,
      takenOn,
      width: 40,
      height: 30,
      byteLength: bytes.byteLength,
      createdAt: '2026-10-09T12:00:00.0000000+00:00',
    };
    this.remote.set(id, { dto, data: bytes });
    return dto;
  }

  async delete(_accountId: string, id: string): Promise<void> {
    if (!this.online) throw new Error('sem rede');
    this.deletes.push(id);
    if (this.deleteStatus !== null) throw new HttpErrorResponse({ status: this.deleteStatus });
    this.remote.delete(id);
  }
}

async function savePhoto(store: PhotoStore) {
  const saved = await store.add(new File(['original'], 'foto.jpg', { type: 'image/jpeg' }));
  if (saved.status !== 'saved') throw new Error('a foto deveria ser salva');
  return saved.photo;
}

function setup() {
  const training = setupTraining();
  const api = new FakeProgressPhotoApi();
  TestBed.configureTestingModule({
    providers: [
      { provide: PHOTO_ENCODER, useValue: new FakeEncoder() },
      { provide: PROGRESS_PHOTO_API, useValue: api },
    ],
  });
  return {
    ...training,
    api,
    store: TestBed.inject(PhotoStore),
    sync: TestBed.inject(ProgressPhotoSync),
  };
}

describe('ProgressPhotoSync', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps photos local until the person accepts cloud storage', async () => {
    const t = setup();
    await t.sync.start();
    const photo = await savePhoto(t.store);

    await t.sync.queueNew(photo.id);

    expect(t.api.puts).toEqual([]);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
  });

  it('keeps a pending upload offline and resumes it with the same idempotency id', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    t.api.online = false;

    await t.sync.queueNew(photo.id);

    expect(t.api.puts).toEqual([]);
    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('pending');

    t.api.online = true;
    await t.sync.retry();

    expect(t.api.puts).toEqual([photo.id]);
    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('cloud');
  });

  it('retries a failed upload with the same photo id and reports the error until it succeeds', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    t.api.failures = 1;

    await t.sync.queueNew(photo.id);

    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('error');
    expect(t.api.puts).toEqual([photo.id]);

    await t.sync.retry();

    expect(t.api.puts).toEqual([photo.id, photo.id]);
    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('cloud');
  });

  it('never scans physical-assessment documents for cloud upload', async () => {
    const t = setup();
    await t.trainingDb.assessmentDocuments.put({
      id: 'assessment-image',
      assessmentId: 'assessment',
      addedAt: 1,
      data: new ArrayBuffer(8),
      type: 'image/jpeg',
    } as never);
    await t.sync.start();
    await t.sync.accept();

    await t.sync.sendDevicePhotos();

    expect(t.api.puts).toEqual([]);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
  });

  it('caches an authenticated photo from another device without a public URL', async () => {
    const t = setup();
    t.api.remote.set('4ce0884c-392d-7bd6-8a21-d0eec397e496', {
      dto: {
        id: '4ce0884c-392d-7bd6-8a21-d0eec397e496',
        takenOn: '2026-10-08',
        width: 40,
        height: 30,
        byteLength: 4,
        createdAt: '2026-10-08T12:00:00.0000000+00:00',
      },
      data: new Uint8Array([1, 2, 3, 4]).buffer,
    });
    await t.sync.start();
    await t.sync.accept();

    expect((await t.store.list()).map((photo) => photo.id)).toEqual([
      '4ce0884c-392d-7bd6-8a21-d0eec397e496',
    ]);
    expect(
      (await t.store.dataUrl('4ce0884c-392d-7bd6-8a21-d0eec397e496'))?.startsWith('data:'),
    ).toBe(true);
  });

  it('sends the same photo only once when the queue is resumed twice', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);

    await t.sync.queueNew(photo.id);
    await t.sync.retry();
    await t.sync.retry();

    expect(t.api.puts).toEqual([photo.id]);
  });

  it('removes a photo that never left the device without calling the API', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    t.api.online = false;
    await t.sync.queueNew(photo.id);

    await t.sync.remove(photo.id);

    expect(await t.trainingDb.photos.count()).toBe(0);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
    expect(t.api.deletes).toEqual([]);
  });

  it('hides a cloud photo at once and deletes it remotely when the network returns', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    await t.sync.queueNew(photo.id);
    t.api.online = false;

    await t.sync.remove(photo.id);

    expect((await t.store.list()).map((item) => item.id)).toEqual([]);
    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('deleting');

    t.api.online = true;
    await t.sync.retry();

    expect(t.api.deletes).toEqual([photo.id]);
    expect(t.api.remote.has(photo.id)).toBe(false);
    expect(await t.trainingDb.photos.count()).toBe(0);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
  });

  it('does not bring a photo back from the cloud list while its deletion is pending', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    await t.sync.queueNew(photo.id);
    t.api.deleteStatus = 500;

    await t.sync.remove(photo.id);

    await t.sync.retry();

    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('deleting');
    expect(t.api.remote.has(photo.id)).toBe(true);
    expect((await t.store.list()).length).toBe(0);

    t.api.deleteStatus = null;
    await t.sync.retry();

    expect(t.api.remote.has(photo.id)).toBe(false);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
  });

  it('treats a photo already gone from the cloud as deleted', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    await t.sync.queueNew(photo.id);
    t.api.deleteStatus = 404;

    await t.sync.remove(photo.id);

    expect(await t.trainingDb.photoSync.count()).toBe(0);
    expect(await t.trainingDb.photos.count()).toBe(0);
  });

  it('deletes remotely a photo whose upload failed, since the reply may have been lost', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    t.api.failures = 1;
    await t.sync.queueNew(photo.id);

    await t.sync.remove(photo.id);

    expect(t.api.deletes).toEqual([photo.id]);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
  });

  it('drops a photo from this device when it was deleted from the cloud elsewhere', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    await t.sync.queueNew(photo.id);
    t.api.remote.delete(photo.id);

    await t.sync.retry();

    expect(await t.trainingDb.photos.count()).toBe(0);
    expect(await t.trainingDb.photoSync.count()).toBe(0);
  });

  it('keeps old device photos local until the explicit send command', async () => {
    const t = setup();
    const old = await savePhoto(t.store);
    await t.sync.start();
    await t.sync.accept();

    expect(t.api.puts).toEqual([]);
    expect(await t.trainingDb.photoSync.count()).toBe(0);

    expect(await t.sync.sendDevicePhotos()).toBe(1);

    expect(t.api.puts).toEqual([old.id]);
    expect((await t.trainingDb.photoSync.get(old.id))?.state).toBe('cloud');
  });

  it('resets an interrupted upload to pending on the next start', async () => {
    const t = setup();
    const photo = await savePhoto(t.store);
    await t.trainingDb.meta.put({ key: 'progress-photos-cloud-consent', value: true });
    await t.trainingDb.photoSync.put({ id: photo.id, state: 'uploading', error: false });

    await t.sync.start();

    expect(t.api.puts).toEqual([photo.id]);
    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('cloud');
  });

  it('reports the storage as disabled when the server answers 503 and keeps the queue', async () => {
    const t = setup();
    await t.sync.start();
    await t.sync.accept();
    const photo = await savePhoto(t.store);
    vi.spyOn(t.api, 'list').mockRejectedValue(new HttpErrorResponse({ status: 503 }));

    await t.sync.queueNew(photo.id);

    expect(t.sync.availability()).toBe('disabled');
    expect(t.api.puts).toEqual([]);
    expect((await t.trainingDb.photoSync.get(photo.id))?.state).toBe('pending');
  });

  it('offers the manual send only while a local photo has no upload state', async () => {
    const t = setup();
    const old = await savePhoto(t.store);
    await t.sync.start();
    await t.sync.accept();

    expect(t.sync.hasUnsent([old.id])).toBe(true);
    expect(t.sync.hasUnsent([])).toBe(false);

    await t.sync.sendDevicePhotos();

    expect(t.sync.hasUnsent([old.id])).toBe(false);
  });
});
