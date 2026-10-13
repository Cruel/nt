import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { authoringRecordSchemas } from '../../shared/project-schema/authoring-records';
import {
  cloneAuthoringProject,
  createAuthoringProject,
} from '../../shared/project-schema/authoring-project';
import { defaultVerbData } from '../../shared/project-schema/authoring-verbs';
import {
  defaultInteractionData,
  validateInteractionData,
} from '../../shared/project-schema/authoring-interactions';
import { analyzeInteractionRules } from '../../shared/interaction-resolver-analysis';
import {
  InMemoryProjectWorkspaceFileSystem,
  ProjectWorkspaceService,
  projectWorkspaceFiles,
} from '../../shared/project-workspace';
import { projectWorkspaceSourceCodec } from '../../shared/project-workspace/project-workspace-source-codec';

const root = '/project';
const verbPath = 'records/verbs/inspect.yaml';
const interactionPath = 'records/interactions/inspect-rules.yaml';

function sample() {
  const project = createAuthoringProject({ id: 'verbs-test', name: 'Verbs' });
  const text = (value: string) => ({
    source: { kind: 'inline' as const, text: value },
    markup: 'plain' as const,
  });
  const verb = defaultVerbData('Inspect');
  verb.slots = [
    {
      id: 'object',
      label: text('Object'),
      prompt: text('Choose {object}'),
      selectors: [{ kind: 'any-subject' }],
    },
  ];
  verb.bindingOrder = ['object'];
  verb.completedCommandText = text('Inspect {object}');
  verb.offers = [
    {
      id: 'general',
      slotId: 'object',
      selectors: [{ kind: 'family', family: 'interactable' }],
      rank: 0,
      primary: false,
    },
    {
      id: 'specific',
      slotId: 'object',
      selectors: [
        {
          kind: 'exact',
          subject: {
            kind: 'interactable',
            interactable: { $ref: { registry: 'interactableInstances', id: 'sealed-box' } },
          },
        },
      ],
      condition: { kind: 'not', condition: { kind: 'always' } },
      rank: 7,
      primary: true,
    },
  ];
  verb.defaultProgram = { instructions: [], completion: { kind: 'return' }, outcome: 'unhandled' };
  project.verbs.inspect = { id: 'inspect', label: 'Inspect', data: verb };
  const rules = defaultInteractionData();
  rules.rules = [
    {
      id: 'narrow',
      verb: { $ref: { collection: 'verbs', id: 'inspect' } },
      slots: [
        {
          slotId: 'object',
          selectors: [
            {
              kind: 'exact',
              subject: {
                kind: 'interactable',
                interactable: { $ref: { registry: 'interactableInstances', id: 'sealed-box' } },
              },
            },
          ],
        },
      ],
      offer: null,
      guard: { kind: 'not', condition: { kind: 'always' } },
      priority: 100,
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'unhandled' },
    },
    {
      id: 'broad',
      verb: { $ref: { collection: 'verbs', id: 'inspect' } },
      slots: [{ slotId: 'object', selectors: [{ kind: 'any-subject' }] }],
      offer: { slotId: 'object', rank: 0, primary: false },
      guard: { kind: 'always' },
      priority: 0,
      program: {
        instructions: [
          {
            id: 'first',
            kind: 'set-enabled',
            subject: { kind: 'interaction-slot', slotId: 'object' },
            enabled: true,
          },
          {
            id: 'second',
            kind: 'set-visible',
            subject: { kind: 'interaction-slot', slotId: 'object' },
            visible: true,
          },
        ],
        completion: { kind: 'return' },
        outcome: 'handled',
      },
    },
  ];
  project.interactions['inspect-rules'] = {
    id: 'inspect-rules',
    label: 'Inspect Rules',
    data: rules,
  };
  return project;
}

function sourceFiles(project = sample()) {
  const files = projectWorkspaceFiles(
    project,
    project.editor,
    {},
    new Set([verbPath, interactionPath]),
  );
  return Object.fromEntries(Object.entries(files).map(([file, text]) => [`${root}/${file}`, text]));
}

describe('staged sparse Verb and Interaction YAML', () => {
  it('round-trips all current Feature Lab Verbs and Interactions through strict source codecs', () => {
    for (const family of ['verbs', 'interactions'] as const) {
      const directory = resolve(process.cwd(), `../tests/projects/feature-lab/records/${family}`);
      const names = readdirSync(directory).filter((name) => name.endsWith('.json'));
      expect(names.length).toBeGreaterThan(6);
      for (const name of names) {
        const record = authoringRecordSchemas[family].parse(
          JSON.parse(readFileSync(resolve(directory, name), 'utf8')),
        );
        const codec = projectWorkspaceSourceCodec(`records/${family}/${name.slice(0, -5)}.yaml`);
        const source = codec.encode(record);
        expect(source, name).not.toMatch(/^  kind: (verb|interaction)$/mu);
        expect(codec.decode(source), name).toEqual(record);
      }
    }
  }, 20_000);

  it('retains Offer suppression, exact subjects, fallback outcomes, named bindings and command order', () => {
    const project = sample();
    const files = sourceFiles(project);
    const verb = files[`${root}/${verbPath}`]!;
    const interaction = files[`${root}/${interactionPath}`]!;
    expect(verb).toContain('id: specific');
    expect(verb).toContain('registry: interactableInstances');
    expect(verb).toContain('outcome: unhandled');
    expect(verb).not.toContain('availability:');
    expect(verb).toContain('rank: 7');
    expect(interaction).toContain('verb: inspect');
    expect(interaction).toContain('priority: 100');
    expect(interaction).not.toContain('priority: 0');
    expect(interaction).toContain('outcome: unhandled');
    expect(interaction).not.toContain('guard: always');
    expect(interaction).toContain('condition: always');
    expect(interaction.indexOf('id: first')).toBeLessThan(interaction.indexOf('id: second'));
    const decodedVerb = projectWorkspaceSourceCodec(verbPath).decode(verb);
    const decodedRules = projectWorkspaceSourceCodec(interactionPath).decode(interaction);
    expect(decodedVerb).toEqual(project.verbs.inspect);
    expect(decodedRules).toEqual(project.interactions['inspect-rules']);
    const restored = cloneAuthoringProject(project);
    restored.verbs.inspect = decodedVerb as typeof restored.verbs.inspect;
    restored.interactions['inspect-rules'] =
      decodedRules as (typeof restored.interactions)['inspect-rules'];
    expect(
      validateInteractionData(restored, 'inspect-rules', restored.interactions['inspect-rules']!),
    ).toEqual(
      validateInteractionData(project, 'inspect-rules', project.interactions['inspect-rules']!),
    );
    expect(
      analyzeInteractionRules(restored, restored.interactions['inspect-rules']!.data.rules),
    ).toEqual(analyzeInteractionRules(project, project.interactions['inspect-rules']!.data.rules));
  });

  it('retains analyzer ambiguity and lower-priority shadow diagnostics from authored YAML', () => {
    const original = sample();
    const broad = original.interactions['inspect-rules']!.data.rules[1]!;
    original.interactions['inspect-rules']!.data.rules.push({
      ...structuredClone(broad),
      id: 'ambiguous',
    });
    const codec = projectWorkspaceSourceCodec(interactionPath);
    const source = codec.encode(original.interactions['inspect-rules']);
    const parsed = codec.decode(source) as (typeof original.interactions)['inspect-rules'];
    const before = analyzeInteractionRules(
      original,
      original.interactions['inspect-rules']!.data.rules,
    );
    const restored = cloneAuthoringProject(original);
    restored.interactions['inspect-rules'] = parsed;
    const after = analyzeInteractionRules(
      restored,
      restored.interactions['inspect-rules']!.data.rules,
    );
    expect(after).toEqual(before);
    expect(after.find((entry) => entry.rule.id === 'broad')?.conflicts).toContainEqual(
      expect.objectContaining({ ruleId: 'ambiguous', certainty: 'yes' }),
    );
    parsed.data.rules.at(-1)!.priority = 10;
    const resaved = codec.decode(codec.encode(parsed, undefined, source)) as typeof parsed;
    const analysis = analyzeInteractionRules(restored, resaved.data.rules);
    expect(analysis.find((entry) => entry.rule.id === 'broad')?.unreachable).toBe('yes');
  });

  it('opens, edits, preserves comments and unchanged YAML, and adds ordered rules', async () => {
    const files = sourceFiles();
    files[`${root}/${verbPath}`] = files[`${root}/${verbPath}`]!.replace(
      'label: Inspect',
      'label: Inspect # verb note',
    );
    files[`${root}/${interactionPath}`] = files[`${root}/${interactionPath}`]!.replace(
      'label: Inspect Rules',
      'label: Inspect Rules # rule note',
    );
    const fs = new InMemoryProjectWorkspaceFileSystem(files);
    const service = new ProjectWorkspaceService(fs);
    const opened = await service.open(root);
    expect(opened.ok ? '' : opened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (!opened.ok) return;
    const untouched = await fs.readText(`${root}/${verbPath}`);
    const project = cloneAuthoringProject(opened.snapshot.project);
    project.interactions['inspect-rules']!.data.rules[1]!.priority = 12;
    project.interactions['inspect-rules']!.data.rules.push({
      id: 'fallback',
      verb: { $ref: { collection: 'verbs', id: 'inspect' } },
      slots: [{ slotId: 'object', selectors: [{ kind: 'family', family: 'character' }] }],
      offer: null,
      guard: { kind: 'always' },
      priority: -2,
      program: { instructions: [], completion: { kind: 'return' }, outcome: 'unhandled' },
    });
    await service.write(
      root,
      opened.snapshot.workspaceRevision,
      project,
      project.editor,
      {},
      {
        affectedPaths: ['/interactions/inspect-rules/data/rules'],
      },
    );
    expect(await fs.readText(`${root}/${verbPath}`)).toBe(untouched);
    const updated = await fs.readText(`${root}/${interactionPath}`);
    expect(updated).toContain('# rule note');
    expect(updated).toContain('priority: 12');
    expect(updated).toContain('priority: -2');
    const reopened = await service.open(root);
    expect(reopened.ok ? '' : reopened.diagnostics.map((d) => d.message).join('; ')).toBe('');
    if (reopened.ok)
      expect(
        reopened.snapshot.project.interactions['inspect-rules']!.data.rules.map((rule) => rule.id),
      ).toEqual(['narrow', 'broad', 'fallback']);
  });

  it('rejects unknown union variants, invented subjects, scalar strings outside Condition positions and duplicate YAML/JSON owners', async () => {
    const files = sourceFiles();
    const verb = files[`${root}/${verbPath}`]!;
    const interaction = files[`${root}/${interactionPath}`]!;
    const verbCodec = projectWorkspaceSourceCodec(verbPath);
    const ruleCodec = projectWorkspaceSourceCodec(interactionPath);
    expect(() => verbCodec.decode(verb.replace('kind: family', 'kind: unknown'))).not.toThrow();
    expect(
      authoringRecordSchemas.verbs.safeParse(
        verbCodec.decode(verb.replace('kind: family', 'kind: unknown')),
      ).success,
    ).toBe(false);
    expect(
      authoringRecordSchemas.verbs.safeParse(
        verbCodec.decode(verb.replace('primary: true', 'primary: always')),
      ).success,
    ).toBe(false);
    expect(() =>
      ruleCodec.decode(
        interaction.replace('verb: inspect', 'verb: { $ref: { collection: verbs, id: inspect } }'),
      ),
    ).toThrow();
    const fs = new InMemoryProjectWorkspaceFileSystem({
      ...files,
      [`${root}/records/verbs/inspect.json`]: JSON.stringify(sample().verbs.inspect),
    });
    expect((await new ProjectWorkspaceService(fs).open(root)).ok).toBe(false);
  });
});
