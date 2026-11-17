import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import model from './main.ts';

const { getUsableAnalogs, readParams } = model;

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, 'main.ts');
const KIT = resolve(HERE, '../gta6-forecast-01-kit/input');
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

function pinball(actual, prediction, level) {
  const d = Math.log(actual) - Math.log(prediction);
  return 2 * Math.max(level * d, (level - 1) * d);
}

function validateOutput(raw, label) {
  if (Buffer.byteLength(raw) > 65536) throw new Error(`${label}: output exceeds 65,536 bytes`);
  const output = JSON.parse(raw);
  if (!output || Object.keys(output).join(',') !== 'hours' || !Array.isArray(output.hours) || output.hours.length !== 23) {
    throw new Error(`${label}: expected exactly {hours: [23 rows]}`);
  }
  const byHour = new Map();
  for (const row of output.hours) {
    if (!row || Object.keys(row).sort().join(',') !== 'hour,q' || !Number.isInteger(row.hour) || row.hour < 2 || row.hour > 24 || byHour.has(row.hour)) {
      throw new Error(`${label}: invalid or duplicate hour`);
    }
    if (!Array.isArray(row.q) || row.q.length !== 5 || row.q.some((q, i) => !Number.isFinite(q) || q <= 0 || q > 1e9 || (i > 0 && q < row.q[i - 1]))) {
      throw new Error(`${label}: invalid quantiles at hour ${row.hour}`);
    }
    byHour.set(row.hour, row.q);
  }
  return byHour;
}

function loadPractices() {
  return ['p00', 'p01', 'p02', 'p03'].map(id => {
    const data = JSON.parse(readFileSync(join(KIT, `${id}.in`), 'utf8'));
    const analogs = getUsableAnalogs(data.comparables);
    if (!analogs.length) throw new Error(`${id}: no usable analog launches`);
    return { id, data, analogs };
  });
}

function evaluate(practices, mainPath, work, progress = true) {
  const input = join(work, 'input');
  const output = join(work, 'output');
  mkdirSync(input, { recursive: true });
  mkdirSync(output, { recursive: true });
  let modelSum = 0, baselineSum = 0, terms = 0, pseudoCases = 0, skippedHours = 0;
  const perPractice = [];
  for (const practice of practices) {
    let caseModel = 0, caseBaseline = 0, caseTerms = 0;
    const inPath = join(input, `${practice.id}.in`);
    const outPath = join(output, `${practice.id}.out`);
    for (const analog of practice.analogs) {
      const label = `${practice.id} / ${analog.name}`;
      const pseudo = {
        ...practice.data,
        known: [{ hour: 1, viewers: analog.viewers[0], channels: analog.hour1Channels }],
        comparables: practice.data.comparables.filter((_, index) => index !== analog.index),
      };
      writeFileSync(inPath, JSON.stringify(pseudo));
      rmSync(outPath, { force: true });
      // One fresh Node subprocess and exactly one input file per held-out launch.
      const child = spawnSync(process.execPath, [mainPath], {
        cwd: dirname(mainPath),
        env: { ...process.env, MAKEFUN_INPUT_DIR: input, MAKEFUN_OUTPUT_DIR: output },
        encoding: 'utf8', timeout: 8000, maxBuffer: 1024 * 1024,
      });
      if (child.error || child.status !== 0 || child.signal) {
        throw new Error(`${label}: subprocess failed: ${child.error?.message || child.signal || child.status}\n${child.stderr || ''}`);
      }
      if (child.stderr.trim()) throw new Error(`${label}: subprocess reported a problem: ${child.stderr.trim()}`);
      const predicted = validateOutput(readFileSync(outPath, 'utf8'), label);
      const p1 = Math.max(1, analog.viewers[0]);
      for (let hour = 2; hour <= 24; hour++) {
        const actual = analog.viewers[hour - 1];
        if (actual === undefined || actual === null) { skippedHours++; continue; }
        if (!Number.isFinite(actual) || actual <= 0) throw new Error(`${label}: cannot score actual ${actual} at hour ${hour}`);
        for (let i = 0; i < LEVELS.length; i++) {
          // Inline house formula, scored on the identical held-out actuals.
          const houseQ = p1 * Math.exp(Z[i] * 0.15 * Math.sqrt(hour - 1));
          caseModel += pinball(actual, predicted.get(hour)[i], LEVELS[i]);
          caseBaseline += pinball(actual, houseQ, LEVELS[i]);
          caseTerms++;
        }
      }
      pseudoCases++;
      rmSync(inPath);
      rmSync(outPath);
    }
    if (!caseTerms) throw new Error(`${practice.id}: no scored hours`);
    const result = { id: practice.id, cases: practice.analogs.length, terms: caseTerms, model: caseModel / caseTerms, baseline: caseBaseline / caseTerms };
    perPractice.push(result);
    modelSum += caseModel;
    baselineSum += caseBaseline;
    terms += caseTerms;
    if (progress) console.log(`${result.id}: ${result.cases} pseudo-cases; model ${result.model.toFixed(9)}; baseline ${result.baseline.toFixed(9)}`);
  }
  return { model: modelSum / terms, baseline: baselineSum / terms, pseudoCases, terms, skippedHours, perPractice };
}

function printResult(result) {
  console.log(`Overall: model ${result.model.toFixed(9)}; baseline ${result.baseline.toFixed(9)}`);
  console.log(`Scored ${result.pseudoCases} pseudo-cases, ${result.terms} hour/level terms; skipped ${result.skippedHours} hours.`);
}

// Optional step 3: all overrides live beside a temporary COPY of main.ts.
function grid(practices, work) {
  const defaults = { ...model.PARAMS };
  const options = { SIGMA_W: [0.6, 0.9, 1.3, 1e9], WIDEN: [1.0, 1.15, 1.3], FLOOR_K: [0, 0.5], SMOOTH: [true, false] };
  const copy = join(work, 'model');
  mkdirSync(copy);
  const mainPath = join(copy, 'main.ts');
  copyFileSync(MAIN, mainPath);
  const tried = [];
  function run(params) {
    const key = JSON.stringify(params);
    const previous = tried.find(row => JSON.stringify(row.params) === key);
    if (previous) return previous;
    writeFileSync(join(copy, 'params.json'), key);
    const result = evaluate(practices, mainPath, work, false);
    const row = { params: { ...params }, result };
    tried.push(row);
    console.log(`${key}: model ${result.model.toFixed(9)}; baseline ${result.baseline.toFixed(9)}`);
    return row;
  }
  const complexity = params => Number(params.SIGMA_W !== 1e9)
    + Number(params.WIDEN !== 1.0) + Number(params.FLOOR_K !== 0) + Number(params.SMOOTH);
  run(defaults);
  const combined = { ...defaults };
  const robustCombined = { ...defaults };
  for (const [key, values] of Object.entries(options)) {
    const candidates = values.map(value => run({ ...defaults, [key]: value }));
    const best = candidates.reduce((a, b) => a.result.model <= b.result.model ? a : b);
    combined[key] = best.params[key];
    const nearby = candidates.filter(row => row.result.model <= best.result.model + 0.005);
    nearby.sort((a, b) => complexity(a.params) - complexity(b.params) || a.result.model - b.result.model);
    robustCombined[key] = nearby[0].params[key];
  }
  // Measure both combinations before applying the overall 0.005 preference.
  run(combined);
  run(robustCombined);
  const minimum = Math.min(...tried.map(row => row.result.model));
  const nearby = tried.filter(row => row.result.model <= minimum + 0.005);
  nearby.sort((a, b) => complexity(a.params) - complexity(b.params) || a.result.model - b.result.model);
  console.log(`Preferred parameters (within 0.005 of best): ${JSON.stringify(nearby[0].params)}`);
  printResult(nearby[0].result);
}

function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 1 || args[0] !== '--grid')) throw new Error('Usage: node backtest.mjs [--grid]');
  const practices = loadPractices();
  // Keep every generated file inside this project, including temporary inputs.
  const work = mkdtempSync(join(HERE, '.backtest-'));
  try {
    if (args[0] === '--grid') grid(practices, work);
    else {
      console.log(`Parameters: ${JSON.stringify(readParams())}`);
      printResult(evaluate(practices, MAIN, work));
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

try { main(); } catch (error) {
  console.error(`Backtest failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
