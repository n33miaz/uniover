/** Formatação do cartão de capacidade: números em pt-BR, unidades curtas, nenhuma casa decimal que não diga nada. */

const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

const oneDecimal = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const twoDecimals = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 });

/** Bytes na unidade que cabe (base 1024, a mesma do limite de 1 GB): "336 KB", "14,7 MB", "1 GB". */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < KIB) return `${Math.round(bytes)} B`;
  if (bytes < MIB) return `${oneDecimal.format(bytes / KIB)} KB`;
  if (bytes < GIB) return `${oneDecimal.format(bytes / MIB)} MB`;
  return `${twoDecimals.format(bytes / GIB)} GB`;
}

/** Percentual com uma casa quando é pequeno (1,4%) e inteiro quando já é grande (55%). */
export function formatPercent(percent: number): string {
  if (!Number.isFinite(percent) || percent <= 0) return '0%';
  if (percent < 10) return `${oneDecimal.format(percent)}%`;
  return `${Math.round(percent)}%`;
}

/** Tempo no ar em duas unidades no máximo: "3 d 4 h", "5 h 12 min", "8 min". */
export function formatUptime(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days > 0) return `${days} d ${hours} h`;
  if (hours > 0) return `${hours} h ${minutes} min`;
  return `${minutes} min`;
}

/** Horas inteiras: "612 h". */
export function formatHours(hours: number): string {
  return `${Math.round(Math.max(0, hours))} h`;
}

/**
 * Quando a projeção chega a um limite. `0` quer dizer que já passou; `null`, que não há data honesta (poucos dados ou
 * banco que não cresce). Acima de dois anos a precisão não diz nada.
 */
export function formatDaysAhead(days: number | null | undefined): string {
  if (days === null || days === undefined)
    return $localize`:@@settings.system.capacity.no-date:Sem data`;
  if (days <= 0) return $localize`:@@settings.system.capacity.already:Já passou`;
  if (days < 1) return $localize`:@@settings.system.capacity.under-a-day:Menos de 1 dia`;
  if (days < 90) {
    const count = Math.round(days);
    return count === 1
      ? $localize`:@@settings.system.capacity.in-one-day:Em 1 dia`
      : $localize`:@@settings.system.capacity.in-days:Em ${count}:count: dias`;
  }
  if (days < 730) {
    const count = Math.round(days / 30);
    return $localize`:@@settings.system.capacity.in-months:Em ${count}:count: meses`;
  }
  return $localize`:@@settings.system.capacity.over-two-years:Mais de 2 anos`;
}

/** Os pontos da curva já em coordenadas do SVG (0..width, 0..height, y de cima para baixo). Um ponto só vira um traço. */
export function sparklinePoints(values: readonly number[], width: number, height: number): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  return values
    .map((value, index) => {
      // Série sem variação: a linha corre pelo meio, em vez de grudar na borda.
      const y = span === 0 ? height / 2 : height - ((value - min) / span) * height;
      return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
