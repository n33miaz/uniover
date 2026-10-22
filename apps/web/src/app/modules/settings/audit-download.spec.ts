import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { QUEUE_RUNTIME } from '../../core/offline-queue/queue-ports';
import { FakeRuntime } from '../../core/offline-queue/queue-test-kit';
import { AuditDownload } from './audit-download';

function setup(withWindow = true) {
  const anchor = {
    href: '',
    download: '',
    rel: '',
    style: { display: '' },
    click: vi.fn(),
    remove: vi.fn(),
  };
  const url = { createObjectURL: vi.fn(() => 'blob:auditoria'), revokeObjectURL: vi.fn() };
  const body = { appendChild: vi.fn() };
  const doc = {
    defaultView: withWindow ? { URL: url } : null,
    createElement: vi.fn(() => anchor),
    body,
  };
  const runtime = new FakeRuntime();
  TestBed.configureTestingModule({
    providers: [
      { provide: DOCUMENT, useValue: doc },
      { provide: QUEUE_RUNTIME, useValue: runtime },
    ],
  });
  return { download: TestBed.inject(AuditDownload), anchor, url, body, runtime };
}

describe('AuditDownload', () => {
  it('clicks a hidden anchor with the file name, the way the other exports of the app do', () => {
    const t = setup();
    const blob = new Blob(['a;b']);

    t.download.save(blob, 'auditoria-20261021-1500.csv');

    expect(t.url.createObjectURL).toHaveBeenCalledWith(blob);
    expect(t.anchor).toMatchObject({
      href: 'blob:auditoria',
      download: 'auditoria-20261021-1500.csv',
      rel: 'noopener',
    });
    expect(t.anchor.style.display).toBe('none');
    expect(t.body.appendChild).toHaveBeenCalledWith(t.anchor);
    expect(t.anchor.click).toHaveBeenCalledTimes(1);
    expect(t.anchor.remove).toHaveBeenCalledTimes(1);
  });

  it('frees the address of the file only later, once the browser has had time to start the download', () => {
    const t = setup();
    t.download.save(new Blob(['x']), 'a.csv');
    expect(t.url.revokeObjectURL).not.toHaveBeenCalled();
    t.runtime.advance(60_000);
    expect(t.url.revokeObjectURL).toHaveBeenCalledWith('blob:auditoria');
  });

  it('does nothing without a window', () => {
    const t = setup(false);
    t.download.save(new Blob(['x']), 'a.csv');
    expect(t.anchor.click).not.toHaveBeenCalled();
  });
});
