import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAllExperiments } from '../experiments/run.js';
import { renderBlocks, BLOCK_IDS } from '../experiments/markdown.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');

describe('experiment evidence is code-recomputed and fresh', () => {
  const evidence = runAllExperiments();

  it('matches the committed experiments/evidence.json byte-for-byte', () => {
    const onDisk = readFileSync(path.join(root, 'experiments', 'evidence.json'), 'utf8');
    const canonical = `${JSON.stringify(evidence, null, 2)}\n`;
    expect(onDisk).toBe(canonical);
  });

  it('keeps every generated marker block in the seam experiment doc up to date', () => {
    const md = readFileSync(path.join(root, 'docs', 'surface-seam-experiments.md'), 'utf8');
    const blocks = renderBlocks(evidence);
    for (const id of BLOCK_IDS) {
      const segment = `<!-- EXP:${id}:BEGIN -->\n${blocks[id].trim()}\n<!-- EXP:${id}:END -->`;
      expect(md).toContain(segment);
    }
  });

  it('records the measured headline relationships used in the conclusions', () => {
    // Unequal speed: G1 zero move / true ratio, C1 ratio back to ~1 at real cost.
    const lambda2 = evidence.velocity.find((v) => v.lambda === 2)!;
    expect(lambda2.g1Move!).toBeLessThan(1e-6);
    expect(lambda2.g1Ratio).toContain('2.00');
    expect(lambda2.c1Move!).toBeGreaterThan(0.03);
    expect(lambda2.c1Ratio.startsWith('1.00')).toBe(true);

    // Lock lab side1 is the participating, healing edge.
    const side1 = evidence.locks.find((l) => l.edge === 'side1')!;
    expect(side1.participates).toBe(true);
    expect(side1.concession!).toBeGreaterThan(0.1);
    expect(side1.healedFractionOfBad!).toBeGreaterThan(0.5);
    const opposite = evidence.locks.find((l) => l.edge === 'opposite')!;
    expect(opposite.participates).toBe(false);

    // Correct reversed direction is the non-opposed ok run.
    const correct = evidence.reverse.find((r) => r.direction === -1 && r.stage === 'G1')!;
    expect(correct.opposed).toBe(false);
    expect(correct.status).toBe('ok');

    // All seven scenes produced all three mode rows (old samples run end to end).
    expect(evidence.scenes.length).toBe(21);
  });
});
