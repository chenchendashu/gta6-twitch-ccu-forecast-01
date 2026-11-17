const { mkdirSync, readFileSync, readdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

type ModelParams = {
  SIGMA_W: number;
  WIDEN: number;
  FLOOR_K: number;
  SMOOTH: boolean;
};

const PARAMS: ModelParams = {
  SIGMA_W: 0.6,
  WIDEN: 1.0,
  FLOOR_K: 0,
  SMOOTH: false,
};

const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];
const HERE = __dirname;
type JsonObject = Record<string, unknown>;
type HourForecast = { hour: number; q: number[] };
type Shape = { median: number; deviations: number[] };
type Analog = {
  index: number;
  name: string;
  day: string;
  viewers: number[];
  hour1Channels: number | undefined;
  preReleaseLevel: number | null;
};

function object(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function readParams(): ModelParams {
  const params = { ...PARAMS };
  try {
    const overrides: unknown = JSON.parse(readFileSync(join(HERE, 'params.json'), 'utf8'));
    if (!object(overrides)) return params;
    for (const key of ['SIGMA_W', 'WIDEN', 'FLOOR_K'] as const) {
      const value = overrides[key];
      if (finite(value) && (key === 'SIGMA_W' ? value > 0 : value >= 0)) {
        params[key] = value;
      }
    }
    if (typeof overrides.SMOOTH === 'boolean') params.SMOOTH = overrides.SMOOTH;
  } catch {
    // The development override is optional; malformed overrides keep the defaults.
  }
  return params;
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

// Inputs are ISO UTC timestamps. Parse their calendar fields without using Date.
function utcHour(value: unknown): { day: string; hour: number } | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):([0-5]\d)(?::([0-5]\d)(?:\.\d+)?)?(?:Z|\+00:00)$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const hour = Number(match[4]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month) || hour > 23) {
    return null;
  }
  return { day: value.slice(0, 10), hour: hour + 1 };
}

function previousDay(day: string): string {
  let [year, month, date] = day.split('-').map(Number);
  if (--date === 0) {
    if (--month === 0) { month = 12; year--; }
    date = daysInMonth(year, month);
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(date).padStart(2, '0')}`;
}

function getUsableAnalogs(comparables: unknown): Analog[] {
  if (!Array.isArray(comparables)) return [];
  const analogs: Analog[] = [];
  for (let index = 0; index < comparables.length; index++) {
    const comparable: unknown = comparables[index];
    if (!object(comparable) || !Array.isArray(comparable.hourly)) continue;
    const name = typeof comparable.name === 'string' ? comparable.name : '';
    const unlock = typeof comparable.unlock === 'string' ? comparable.unlock : '';
    if (/^Not a launch/i.test(unlock.trim()) || /before release/i.test(name)) continue;
    const start = utcHour(comparable.day_start);
    if (!start) continue;
    const before = previousDay(start.day);
    const viewers = new Array<number>(24).fill(NaN);
    const preViewers = new Array<number>(24).fill(NaN);
    let hour1Channels: number | undefined;
    for (const row of comparable.hourly) {
      if (!object(row)) continue;
      const time = utcHour(row.from);
      if (!time) continue;
      if (time.day === start.day) {
        viewers[time.hour - 1] = finite(row.viewers) ? row.viewers : NaN;
        if (time.hour === 1) hour1Channels = finite(row.channels) ? row.channels : undefined;
      } else if (time.day === before && finite(row.viewers) && row.viewers >= 0) {
        preViewers[time.hour - 1] = row.viewers;
      }
    }
    // Positive values are needed for the log-ratio curve at every forecast hour.
    if (viewers[0] < 50 || viewers.some(value => !Number.isFinite(value) || value <= 0)) continue;
    const available = preViewers.filter(Number.isFinite);
    analogs.push({
      index, name, day: start.day, viewers, hour1Channels,
      preReleaseLevel: available.length ? available.reduce((sum, value) => sum + value, 0) / available.length : null,
    });
  }
  return analogs.sort((a, b) => {
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    if (a.name !== b.name) return a.name < b.name ? -1 : 1;
    return a.index - b.index;
  });
}

function print1(data: unknown): number {
  if (!object(data) || !Array.isArray(data.known)) return NaN;
  const row = data.known.find(row => object(row) && row.hour === 1);
  return object(row) && finite(row.viewers) ? Math.max(1, row.viewers) : NaN;
}

function boundedQuantiles(values: number[]): number[] {
  const q = values.map(value => Math.round(Math.min(1e9, Math.max(1, value)) * 100) / 100);
  for (let i = 1; i < q.length; i++) q[i] = Math.max(q[i], q[i - 1]);
  return q;
}

function baselineHour(p1: number, hour: number): HourForecast {
  const print = Number.isFinite(p1) ? Math.max(1, p1) : 1;
  return { hour, q: boundedQuantiles(Z.map(z => print * Math.exp(z * 0.15 * Math.sqrt(hour - 1)))) };
}

function baseline(p1: number): { hours: HourForecast[] } {
  return { hours: Array.from({ length: 23 }, (_, i) => baselineHour(p1, i + 2)) };
}

// Interpolate x between adjacent cumulative-weight/total-weight coordinates.
// Below the first coordinate and above the last, use the nearest endpoint.
function weightedQuantile(sorted: { x: number; weight: number }[], total: number, level: number): number {
  const target = level * total;
  let cumulative = sorted[0].weight;
  if (target <= cumulative) return sorted[0].x;
  for (let i = 1; i < sorted.length; i++) {
    const next = cumulative + sorted[i].weight;
    if (target <= next) {
      return sorted[i - 1].x + (sorted[i].x - sorted[i - 1].x) * (target - cumulative) / sorted[i].weight;
    }
    cumulative = next;
  }
  return sorted[sorted.length - 1].x;
}

function forecast(data: unknown, params: ModelParams): { hours: HourForecast[] } {
  const p1 = print1(data);
  if (!Number.isFinite(p1) || !object(data)) return baseline(p1);
  const analogs = getUsableAnalogs(data.comparables);
  if (analogs.length < 8) return baseline(p1);
  const weights = analogs.map(analog => {
    const distance = Math.log10(analog.viewers[0]) - Math.log10(p1);
    return 0.05 + 0.95 * Math.exp(-0.5 * distance ** 2 / params.SIGMA_W ** 2);
  });
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const shapes: (Shape | null)[] = Array.from({ length: 23 }, (_, index) => {
    const hour = index + 2;
    const points = analogs.map((analog, i) => ({
      x: Math.log(analog.viewers[hour - 1] / analog.viewers[0]), weight: weights[i],
    })).sort((a, b) => a.x - b.x);
    if (!Number.isFinite(total) || total <= 0 || points.some(point => !Number.isFinite(point.x))) return null;
    const quantiles = LEVELS.map(level => weightedQuantile(points, total, level));
    const median = quantiles[2];
    const deviations = quantiles.map((q, i) => {
      const dev = q - median;
      return dev * params.WIDEN + Math.sign(dev) * params.FLOOR_K * 0.15 * Math.sqrt(hour - 1) * Math.abs(Z[i]) / 1.645;
    });
    return Number.isFinite(median) && deviations.every(Number.isFinite) ? { median, deviations } : null;
  });
  const hours = shapes.map((shape, index): HourForecast => {
    const hour = index + 2;
    if (!shape) return baselineHour(p1, hour);
    let median = shape.median, deviations = shape.deviations;
    if (params.SMOOTH) {
      const window = shapes.slice(Math.max(0, index - 1), Math.min(shapes.length, index + 2));
      if (window.some(value => value === null)) return baselineHour(p1, hour);
      const valid = window as Shape[];
      median = valid.reduce((sum, value) => sum + value.median, 0) / valid.length;
      deviations = LEVELS.map((_, i) => valid.reduce((sum, value) => sum + value.deviations[i], 0) / valid.length);
    }
    const q = deviations.map(dev => p1 * Math.exp(median + dev));
    return q.every(Number.isFinite) ? { hour, q: boundedQuantiles(q) } : baselineHour(p1, hour);
  });
  return { hours };
}

function main(): void {
  const input = process.env.MAKEFUN_INPUT_DIR || '/input';
  const output = process.env.MAKEFUN_OUTPUT_DIR || '/output';
  const params = readParams();
  mkdirSync(output, { recursive: true });
  const files = readdirSync(input).filter(name => name.endsWith('.in')).sort();
  for (const file of files) {
    let p1 = 1;
    let prediction = baseline(p1);
    try {
      const data: unknown = JSON.parse(readFileSync(join(input, file), 'utf8'));
      const known = print1(data);
      if (Number.isFinite(known)) p1 = known;
      prediction = forecast(data, params);
    } catch {
      prediction = baseline(p1);
    }
    try {
      writeFileSync(join(output, `${file.slice(0, -3)}.out`), JSON.stringify(prediction));
    } catch (error) {
      console.error(`Could not write forecast for ${file}: ${String(error)}`);
    }
  }
}

// Backtest imports only the usability helper; forecasts always run in a subprocess.
module.exports = { PARAMS, readParams, getUsableAnalogs };
if (require.main === module) {
  try { main(); } catch (error) { console.error(`Forecast runner: ${String(error)}`); }
}
