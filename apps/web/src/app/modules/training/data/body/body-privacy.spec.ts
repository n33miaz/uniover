import { TestBed } from '@angular/core/testing';
import { ExportDelivery } from '../export/export-delivery';
import { PHOTO_ENCODER, PhotoStore } from '../photos/photo-store';
import { setupBody } from './body-data-test-kit';

class FakeEncoder {
  async encode() {
    return {
      blob: new Blob(['FOTO-DO-CORPO'], { type: 'image/jpeg' }),
      width: 1280,
      height: 960,
    };
  }
}

function setup() {
  const t = setupBody(undefined, [
    { provide: PHOTO_ENCODER, useValue: new FakeEncoder() },
    {
      provide: ExportDelivery,
      useValue: { download: () => undefined, share: async () => 'shared' },
    },
  ]);
  return { ...t, photos: TestBed.inject(PhotoStore) };
}

describe('health data and the write queue', () => {
  it('every health write goes through the queue exactly once, and the photo never does', async () => {
    const t = setup();

    const entry = await t.repository.saveEntry({ weightKg: 82.4, waistCm: 86 });
    const profile = await t.profiles.save({
      heightCm: 180,
      birthDate: '1995-06-15',
      sex: 'male',
      activityFactor: 1.55,
    });
    const photo = await t.photos.add(new File(['x'], 'foto.jpg', { type: 'image/jpeg' }));
    expect(entry.status).toBe('saved');
    expect(profile.status).toBe('saved');
    expect(photo.status).toBe('saved');

    // Na fila: uma escrita por gravação de saúde, e nada de foto.
    const queued = await t.outbox();
    expect(queued.map((item) => [item.method, item.url])).toEqual([
      ['PUT', `/api/v1/training/body/entries/${entry.status === 'saved' ? entry.entry.id : ''}`],
      ['PUT', '/api/v1/training/body/profile'],
    ]);
    expect(JSON.stringify(queued)).not.toMatch(/FOTO-DO-CORPO|photo|foto|data:image|base64/i);

    // No envio de verdade: cada escrita sai uma vez, e o que sai não carrega foto.
    t.resume();
    await t.queue().syncNow();
    expect(t.transport.requests.map((request) => [request.method, request.url])).toEqual([
      ['PUT', `/api/v1/training/body/entries/${entry.status === 'saved' ? entry.entry.id : ''}`],
      ['PUT', '/api/v1/training/body/profile'],
    ]);
    expect(new Set(t.transport.keys).size).toBe(2);
    expect(JSON.stringify(t.transport.requests)).not.toMatch(
      /FOTO-DO-CORPO|photo|foto|data:image|base64/i,
    );
    expect(t.queue().pendingCount()).toBe(0);
  });

  it('a photo alone leaves the queue untouched, and removing it changes nothing there', async () => {
    const t = setup();

    const photo = await t.photos.add(new File(['x'], 'foto.jpg', { type: 'image/jpeg' }));
    if (photo.status === 'saved') await t.photos.remove(photo.photo.id);

    expect(await t.outbox()).toHaveLength(0);
    expect(await t.trainingDb.photos.count()).toBe(0);
  });
});
