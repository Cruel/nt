import { describe, expect, it } from 'vite-plus/test';
import {
  inspectNovelTeaAgentBootstrapText,
  NOVELTEA_AGENT_BOOTSTRAP_END,
  NOVELTEA_AGENT_BOOTSTRAP_START,
  NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK,
  repairNovelTeaAgentBootstrapText,
} from '../../shared/project-workspace';

describe('NovelTea managed agent bootstrap', () => {
  it('inserts after only an initial H1 and preserves BOM and CRLF user content', () => {
    const source = '\uFEFF\r\n# Team Project\r\n\r\nTeam rules.\r\n';
    const repaired = repairNovelTeaAgentBootstrapText(inspectNovelTeaAgentBootstrapText(source));
    expect(repaired.startsWith('\uFEFF\r\n# Team Project\r\n\r\n')).toBe(true);
    expect(repaired).toContain(NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK.replaceAll('\n', '\r\n'));
    expect(repaired.endsWith('\r\nTeam rules.\r\n')).toBe(true);

    const laterHeading = 'Introduction.\n\n# Later heading\n';
    expect(
      repairNovelTeaAgentBootstrapText(inspectNovelTeaAgentBootstrapText(laterHeading)).startsWith(
        NOVELTEA_AGENT_BOOTSTRAP_START,
      ),
    ).toBe(true);
  });

  it('classifies current, outdated, duplicate, reversed, and unmatched markers strictly', () => {
    expect(inspectNovelTeaAgentBootstrapText(NOVELTEA_PROJECT_AGENTS_MANAGED_BLOCK).status).toBe(
      'current',
    );
    expect(
      inspectNovelTeaAgentBootstrapText(
        `${NOVELTEA_AGENT_BOOTSTRAP_START}\nold\n${NOVELTEA_AGENT_BOOTSTRAP_END}`,
      ).status,
    ).toBe('outdated');
    expect(
      inspectNovelTeaAgentBootstrapText(
        `${NOVELTEA_AGENT_BOOTSTRAP_START}\n${NOVELTEA_AGENT_BOOTSTRAP_START}\n${NOVELTEA_AGENT_BOOTSTRAP_END}`,
      ).status,
    ).toBe('malformed');
    expect(
      inspectNovelTeaAgentBootstrapText(
        `${NOVELTEA_AGENT_BOOTSTRAP_END}\n${NOVELTEA_AGENT_BOOTSTRAP_START}`,
      ).status,
    ).toBe('malformed');
    expect(inspectNovelTeaAgentBootstrapText(NOVELTEA_AGENT_BOOTSTRAP_START).status).toBe(
      'malformed',
    );
  });
});
