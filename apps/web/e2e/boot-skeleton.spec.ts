import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';

const html = readFileSync(resolve(process.cwd(), 'src/index.html'), 'utf8').replace(
  '<script src="boot-skeleton.js"></script>',
  '',
);
const styles = readFileSync(resolve(process.cwd(), 'src/styles.css'), 'utf8');
const skeletonStyles = readFileSync(resolve(process.cwd(), 'src/boot-skeleton.css'), 'utf8');

const variants = [
  'home',
  'tv',
  'training-today',
  'training-session',
  'training-session-exercise',
  'training-glossary',
  'training-library',
  'training-exercise-form',
  'training-map',
  'training-exercise-detail',
  'training-routines',
  'training-routine-editor',
  'training-progress',
  'training-food',
  'training-body',
  'training-assessments',
  'training-assessment-import',
  'training-assessment-editor',
  'training-assessment-detail',
  'settings',
  'settings-profile',
  'settings-appearance',
  'settings-security',
  'settings-people',
  'settings-tv-people',
  'settings-tv-history',
  'settings-audit',
  'settings-system',
  'settings-devices',
  'settings-about',
  'settings-credits',
  'auth-login',
  'auth-qr',
  'auth-invite',
  'auth-welcome',
  'devices-connect',
] as const;

const namedContent: Readonly<Record<string, string>> = {
  'training-today': '.bs-training-today-content',
  'training-progress': '.bs-training-progress-content',
  'training-body': '.bs-training-body-content',
  'settings-profile': '.bs-settings-profile-content',
  'settings-appearance': '.bs-settings-appearance-content',
  'settings-people': '.bs-settings-data-content',
  'settings-audit': '.bs-settings-data-content',
  'settings-devices': '.bs-settings-data-content',
  'settings-system': '.bs-settings-system-content',
};

test('cada endereço mostra um desenho próprio e formas visíveis desde o primeiro quadro', async ({
  page,
}) => {
  await page.setContent(html);
  await page.addStyleTag({ content: styles });
  await page.addStyleTag({ content: skeletonStyles });
  const silhouettes = new Map<string, string>();
  for (const variant of variants) {
    const result = await page.evaluate(
      ({ name, content }) => {
        document.documentElement.setAttribute('data-boot', name);
        const visible = [
          ...document.querySelectorAll<HTMLElement>('#boot-skeleton > .bs-variant'),
        ].filter((element) => getComputedStyle(element).display !== 'none');
        const selector = content[name] ?? '.bs-route-content';
        const measure = (root: HTMLElement) => {
          const target = root.querySelector<HTMLElement>(selector) ?? root;
          return {
            display: getComputedStyle(target).display,
            boxes: [...target.querySelectorAll<HTMLElement>('.bone')]
              .map((bone) => bone.getBoundingClientRect())
              .filter((box) => box.width > 0 && box.height > 0)
              .map(
                (box) =>
                  `${Math.round(box.x)},${Math.round(box.y)},${Math.round(box.width)},${Math.round(box.height)}`,
              ),
          };
        };
        const staticShape = visible[0] && measure(visible[0]);
        const overlay = document.createElement('div');
        overlay.className = 'bs-root';
        overlay.setAttribute('data-boot-variant', name);
        if (visible[0]) overlay.append(visible[0].cloneNode(true));
        document.body.append(overlay);
        // O endereço inicial continua na Início quando o app navega; só o atributo do overlay sabe o novo destino.
        document.documentElement.setAttribute('data-boot', 'home');
        const angularShape =
          overlay.firstElementChild && measure(overlay.firstElementChild as HTMLElement);
        overlay.remove();
        return {
          visible: visible.length,
          staticShape,
          angularShape,
        };
      },
      { name: variant, content: namedContent },
    );
    expect(result.visible, variant).toBe(1);
    expect(result.staticShape?.display, variant).not.toBe('none');
    expect(result.staticShape?.boxes.length, variant).toBeGreaterThan(3);
    expect(result.angularShape?.boxes, variant).toEqual(result.staticShape?.boxes);
    if (!(variant in namedContent) && !['home', 'tv', 'settings'].includes(variant)) {
      const silhouette = result.staticShape!.boxes.join('|');
      expect([...silhouettes.values()], variant).not.toContain(silhouette);
      silhouettes.set(variant, silhouette);
    }
  }
});
