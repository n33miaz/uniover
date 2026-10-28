import { TestBed } from '@angular/core/testing';
import { CSV_BOM } from '../../data/export/csv';
import {
  ExportDelivery,
  type ShareOutcome,
  type SharePayload,
} from '../../data/export/export-delivery';
import { SessionRepository } from '../../data/sessions/session-repository';
import { eventually, seedHistory } from '../../shell/screen-test-kit';
import { BENCH_HISTORY, setupProgress } from '../progress-test-kit';
import { ProgressExport } from './export-section';

const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim() ?? '';

/** A entrega falsa: anota o que seria baixado ou compartilhado, e responde como o teste mandar. */
class FakeDelivery {
  readonly downloads: { blob: Blob; filename: string }[] = [];
  readonly shared: SharePayload[] = [];
  outcome: ShareOutcome = 'shared';
  failDownload = false;

  download(blob: Blob, filename: string): void {
    if (this.failDownload) throw new Error('sem espaço');
    this.downloads.push({ blob, filename });
  }

  async share(payload: SharePayload): Promise<ShareOutcome> {
    this.shared.push(payload);
    return this.outcome;
  }
}

/** Os bytes do arquivo: ler como texto esconderia a marca de ordem de bytes do começo do CSV. */
function blobBytes(blob: Blob): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

describe('ProgressExport', () => {
  // O jsdom não tem `URL.createObjectURL`: sem ele a tela diria que o aparelho não baixa arquivos.
  const original = URL.createObjectURL;
  beforeEach(() => {
    URL.createObjectURL = () => 'blob:teste';
  });
  afterEach(() => {
    URL.createObjectURL = original;
  });

  async function open() {
    const delivery = new FakeDelivery();
    const kit = await setupProgress(undefined, [{ provide: ExportDelivery, useValue: delivery }]);
    await seedHistory(kit.trainingDb, 'supino-reto', BENCH_HISTORY);
    const fixture = TestBed.createComponent(ProgressExport);
    const el = fixture.nativeElement as HTMLElement;
    fixture.detectChanges();
    el.querySelector<HTMLButtonElement>('button.toggle')!.click();
    fixture.detectChanges();
    const row = (index: number) =>
      el.querySelectorAll<HTMLButtonElement>('.list button.ui-row')[index];
    const status = (index: number) => text(el.querySelectorAll('.status')[index]);
    return { ...kit, delivery, fixture, el, row, status };
  }

  it('lists the three actions, with a short description each, and the note about losing browser data', async () => {
    const { el } = await open();

    expect(text(el.querySelector('.ui-row-sub'))).toBe('JSON, CSV e resumo da semana');
    const titles = Array.from(el.querySelectorAll('.list .ui-row-title')).map((title) =>
      text(title),
    );
    expect(titles).toEqual([
      'Exportar Tudo (JSON)',
      'Exportar Séries (CSV)',
      'Compartilhar Resumo da Semana',
    ]);
    expect(text(el)).toContain('seguro extra contra o navegador apagar dados de site');
    // Antes de tocar, nenhuma mensagem.
    expect(Array.from(el.querySelectorAll('.status')).map((status) => text(status))).toEqual([
      '',
      '',
      '',
    ]);
  });

  it('downloads the JSON with everything, named by the day, and says what it made', async () => {
    const { fixture, delivery, row, status } = await open();

    row(0).click();
    await eventually(fixture, () => expect(delivery.downloads).toHaveLength(1));

    const [download] = delivery.downloads;
    expect(download.filename).toBe('uniover-treino-2025-10-09.json');
    expect(download.blob.type).toBe('application/json');
    const document = JSON.parse(await blobText(download.blob));
    expect(document).toMatchObject({ app: 'uniover', module: 'training', exportVersion: 1 });
    expect(document.sections.sessions).toHaveLength(6);
    expect(document.sections.sets).toHaveLength(6);
    await eventually(fixture, () =>
      expect(status(0)).toBe(
        'Arquivo gerado: uniover-treino-2025-10-09.json. Se o download não aparecer neste aparelho, tente de novo pelo navegador.',
      ),
    );
    expect(status(1)).toBe('');
  });

  it('downloads the sets as a CSV that opens in a spreadsheet: header, accents, the BOM', async () => {
    const { fixture, delivery, row, status } = await open();

    row(1).click();
    await eventually(fixture, () => expect(delivery.downloads).toHaveLength(1));

    const [download] = delivery.downloads;
    expect(download.filename).toBe('uniover-treino-2025-10-09.csv');
    expect(download.blob.type).toBe('text/csv;charset=utf-8');
    const bytes = await blobBytes(download.blob);
    // UTF-8 com marca de ordem de bytes (EF BB BF): a planilha reconhece os acentos.
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const csv = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    expect(csv.startsWith(CSV_BOM)).toBe(true);
    const lines = csv.slice(1).split('\r\n');
    expect(lines[0]).toBe(
      'date,session_id,routine,exercise,set_type,weight_kg,reps,duration_s,rir,rpe,note',
    );
    // Seis séries, da mais antiga (32,5 × 10) à mais nova (42,5 × 8), com o nome acentuado do exercício.
    expect(lines.filter((line) => line.includes('Supino reto com barra'))).toHaveLength(6);
    expect(lines[1]).toMatch(/,Supino reto com barra,work,32\.5,10,/);
    expect(lines[6]).toMatch(/,Supino reto com barra,work,42\.5,8,/);
    await eventually(fixture, () => expect(status(1)).toContain('Arquivo gerado: uniover-treino-'));
  });

  it('says so, with the reason, when the file could not be made, and lets the owner try again', async () => {
    const { fixture, delivery, row, status } = await open();
    delivery.failDownload = true;

    row(0).click();
    await eventually(fixture, () =>
      expect(status(0)).toBe('Não foi possível gerar o arquivo agora. Tente de novo.'),
    );
    expect(row(0).disabled).toBe(false);

    delivery.failDownload = false;
    row(0).click();
    await eventually(fixture, () => expect(status(0)).toContain('Arquivo gerado'));
    expect(delivery.downloads).toHaveLength(1);
  });

  it('says so when the device cannot download files at all', async () => {
    const { fixture, delivery, row, status } = await open();
    URL.createObjectURL = undefined as unknown as typeof URL.createObjectURL;

    row(0).click();
    await eventually(fixture, () =>
      expect(status(0)).toBe(
        'Este aparelho não baixa arquivos por aqui. Tente abrir o app no navegador.',
      ),
    );
    expect(delivery.downloads).toHaveLength(0);
  });

  it('shares the week summary text, with volume and records', async () => {
    const { fixture, delivery, row, status } = await open();

    row(2).click();
    await eventually(fixture, () => expect(delivery.shared).toHaveLength(1));

    expect(delivery.shared[0].title).toBe('Resumo da semana');
    expect(delivery.shared[0].text).toContain('Treino: resumo da semana de');
    expect(delivery.shared[0].text).toContain('Séries de trabalho:');
    await eventually(fixture, () =>
      expect(status(2)).toBe('Resumo enviado ao compartilhar do aparelho.'),
    );
  });

  it('never shares a stale summary: reads the week again when data arrived after the section opened', async () => {
    const { fixture, delivery, row, trainingDb } = await open();
    await eventually(fixture, () => expect(delivery.shared).toHaveLength(0));

    // Chegou um treino desta semana (o "agora" dos testes é quinta-feira, 9/10/2025) depois de a seção abrir.
    await seedHistory(trainingDb, 'agachamento', [[115, 60, 8]]);
    const set = (await trainingDb.sets.where('exerciseId').equals('agachamento').first())!;
    await TestBed.inject(SessionRepository).applyRemoteSets([set]);

    row(2).click();
    await eventually(fixture, () => expect(delivery.shared).toHaveLength(1));
    expect(delivery.shared[0].text).toContain('Treinos: 1');
    expect(delivery.shared[0].text).toContain('Séries de trabalho: 1');
  });

  it('copies the summary when the device has no share sheet, and says it did', async () => {
    const { fixture, delivery, row, status } = await open();
    delivery.outcome = 'copied';

    row(2).click();
    await eventually(fixture, () =>
      expect(status(2)).toBe(
        'Este aparelho não abre o compartilhar: o resumo foi copiado, é só colar onde quiser.',
      ),
    );
  });

  it('says plainly when the device can neither share nor copy', async () => {
    const { fixture, delivery, row, status, el } = await open();
    delivery.outcome = 'unsupported';

    row(2).click();
    await eventually(fixture, () =>
      expect(status(2)).toBe(
        'Este aparelho não consegue compartilhar nem copiar o texto. Use o JSON ou o CSV.',
      ),
    );
    expect(el.querySelectorAll('.status')[2].classList.contains('error')).toBe(true);
  });

  it('stays quiet when the owner closes the share sheet on purpose', async () => {
    const { fixture, delivery, row, status } = await open();
    delivery.outcome = 'cancelled';

    row(2).click();
    await eventually(fixture, () => expect(delivery.shared).toHaveLength(1));
    fixture.detectChanges();
    expect(status(2)).toBe('');
    expect(row(2).disabled).toBe(false);
  });
});
