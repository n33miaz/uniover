import { vi } from 'vitest';
import { readChartColors, watchTheme } from './chart-theme';

describe('readChartColors', () => {
  it('takes the colors from the app theme tokens, not from the chart library', () => {
    const element = document.createElement('div');
    element.style.setProperty('--a-accent', '#98c4a3');
    element.style.setProperty('--a-warn', '#e8a63c');
    document.body.appendChild(element);

    const colors = readChartColors(element);

    expect(colors.accent).toBe('#98c4a3');
    expect(colors.goal).toBe('#e8a63c');
    element.remove();
  });

  it('falls back to the light theme when a token is missing', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);

    const colors = readChartColors(element);

    expect(colors.accent).toBe('#3b6b4b');
    expect(colors.surface).toBe('#ffffff');
    expect(colors.ink2).toBe('#46544a');
    expect(colors.line).toBe('#d0dad0');
    expect(colors.goal).toBe('#8a5200');
    expect(colors.font.length).toBeGreaterThan(0);
    element.remove();
  });
});

describe('watchTheme', () => {
  afterEach(() => document.documentElement.removeAttribute('data-theme'));

  it('tells when the theme attribute of the root changes, and stops when released', async () => {
    const onChange = vi.fn();
    const stop = watchTheme(document, onChange);

    document.documentElement.setAttribute('data-theme', 'dark');
    await vi.waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));

    stop();
    document.documentElement.setAttribute('data-theme', 'light');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it('ignores other attributes of the root', async () => {
    const onChange = vi.fn();
    const stop = watchTheme(document, onChange);

    document.documentElement.setAttribute('lang', 'pt-BR');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(onChange).not.toHaveBeenCalled();
    stop();
  });
});
