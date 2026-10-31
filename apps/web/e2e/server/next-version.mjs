// Fabrica, a partir de um build pronto, uma "versão seguinte" como um deploy novo a deixaria: todo arquivo com hash no
// nome (main, polyfills, chunk, styles) ganha outro hash e as referências (index.html, os próprios arquivos e a lista
// do precache do sw.js) acompanham; as páginas do precache ganham outra revisão. O conteúdo é o mesmo, mas nenhum nome
// de arquivo da versão antiga existe na nova, que é o que importa para provar o defeito das "casca antiga pedindo
// pedaço que sumiu". Assim o e2e não precisa de um segundo build do Angular (a máquina tem pouca memória).
import { createHash } from 'node:crypto';
import { cp, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const HASHED = /^(main|polyfills|chunk|styles)-([A-Za-z0-9_-]{8})\.(js|css)$/;
const TEXT = /\.(js|css|html|json|webmanifest)$/;

function otherHash(hash) {
  // Mesmo alfabeto e tamanho do Angular, derivado do original: determinístico e sempre diferente.
  const digest = createHash('sha256').update(`v2:${hash}`).digest('base64url');
  return digest.slice(0, 8);
}

export async function createNextVersion(sourceDir, targetDir) {
  await cp(sourceDir, targetDir, { recursive: true });
  const renames = new Map();
  for (const name of await readdir(targetDir)) {
    const match = HASHED.exec(name);
    if (!match) continue;
    const next = `${match[1]}-${otherHash(match[2])}.${match[3]}`;
    renames.set(name, next);
    await rename(join(targetDir, name), join(targetDir, next));
  }
  if (renames.size === 0) throw new Error(`nenhum arquivo com hash em ${sourceDir}`);
  const sorted = [...renames.entries()];
  for (const name of await readdir(targetDir)) {
    if (!TEXT.test(name)) continue;
    const file = join(targetDir, name);
    let text = await readFile(file, 'utf8');
    const before = text;
    for (const [from, to] of sorted) text = text.replaceAll(from, to);
    if (name === 'sw.js') {
      // As páginas do precache (`/`, `/tv/`, `/treino/`) têm revisão de 16 hexadecimais; trocá-la faz o worker
      // baixá-las de novo, como num deploy que mudou o index.html.
      text = text.replace(
        /"revision":"([0-9a-f]{16})","url":"(\/[^"]*)"/g,
        (_all, revision, url) =>
          `"revision":"${createHash('sha256').update(`v2:${revision}`).digest('hex').slice(0, 16)}","url":"${url}"`,
      );
    }
    if (text !== before) await writeFile(file, text);
  }
  return { renames: sorted.length };
}
