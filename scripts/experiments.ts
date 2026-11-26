import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAllExperiments } from '../src/experiments/run.ts';
import { renderBlocks, BLOCK_IDS } from '../src/experiments/markdown.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const evidenceDir = path.join(root, 'experiments');
const evidencePath = path.join(evidenceDir, 'evidence.json');
const docPath = path.join(root, 'docs', 'surface-seam-experiments.md');
const check = process.argv.includes('--check');

const evidence = runAllExperiments();
const json = `${JSON.stringify(evidence, null, 2)}\n`;
const blocks = renderBlocks(evidence);

function applyBlocks(md: string): string {
  let out = md;
  for (const id of BLOCK_IDS) {
    const marker = `EXP:${id}`;
    const re = new RegExp(`<!-- ${marker}:BEGIN -->[\\s\\S]*?<!-- ${marker}:END -->`);
    const repl = `<!-- ${marker}:BEGIN -->\n${blocks[id].trim()}\n<!-- ${marker}:END -->`;
    if (!re.test(out)) throw new Error(`missing markers <!-- ${marker}:BEGIN/END --> in ${docPath}`);
    out = out.replace(re, repl);
  }
  return out;
}

if (check) {
  const problems: string[] = [];
  const oldJson = fs.existsSync(evidencePath) ? fs.readFileSync(evidencePath, 'utf8') : null;
  if (oldJson !== json) problems.push('experiments/evidence.json 已过期或缺失（请运行 npm run experiments）');
  if (!fs.existsSync(docPath)) {
    problems.push('docs/surface-seam-experiments.md 缺失');
  } else {
    const md = fs.readFileSync(docPath, 'utf8');
    try {
      if (applyBlocks(md) !== md) problems.push('曲面接缝实验文档中的生成表格已过期（请运行 npm run experiments）');
    } catch (err) {
      problems.push((err as Error).message);
    }
  }
  if (problems.length) {
    console.error('实验一致性检查未通过：\n- ' + problems.join('\n- '));
    process.exit(1);
  }
  console.log('实验证据与文档生成块均为最新。');
} else {
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(evidencePath, json);
  if (fs.existsSync(docPath)) {
    const md = fs.readFileSync(docPath, 'utf8');
    fs.writeFileSync(docPath, applyBlocks(md));
    console.log(`已写入 ${path.relative(root, evidencePath)} 并更新文档生成块。`);
  } else {
    console.log(`已写入 ${path.relative(root, evidencePath)}；文档尚不存在，未更新 markdown。`);
  }
}
