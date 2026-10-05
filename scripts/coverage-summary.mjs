import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export function coverageSummary(kind, report, scope) {
  let title;
  let metrics;
  if (kind === 'cpp') {
    title = 'C++';
    metrics = [
      ['Lines', report.line_covered, report.line_total],
      ['Branches', report.branch_covered, report.branch_total],
    ];
  } else if (kind === 'editor') {
    title = 'Editor';
    metrics = ['lines', 'functions', 'branches'].map((key) => [
      key[0].toUpperCase() + key.slice(1), report.total?.[key]?.covered, report.total?.[key]?.total,
    ]);
  } else {
    throw new Error(`Unknown coverage kind: ${kind}`);
  }
  const rows = metrics.map(([name, covered, total]) => {
    if (!Number.isInteger(covered) || !Number.isInteger(total) || covered < 0 || total < covered) {
      throw new Error(`Invalid ${title} ${name} coverage counts`);
    }
    const percent = total === 0 ? 'n/a' : `${(100 * covered / total).toFixed(2)}%`;
    return `| ${name} | ${covered} / ${total} | ${percent} |`;
  });
  return `## ${title} coverage${scope ? ` — ${scope}` : ''}\n\n| Metric | Covered / Total | Coverage |\n| --- | --- | --- |\n${rows.join('\n')}\n\nInformational hole detector; coverage does not prove behavioral correctness.\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , kind, file, scope] = process.argv;
  process.stdout.write(coverageSummary(kind, JSON.parse(readFileSync(file, 'utf8')), scope));
}
