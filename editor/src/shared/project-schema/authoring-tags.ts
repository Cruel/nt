import { authoringCollectionKeys, type AuthoringCollectionKey } from './authoring-collections';
import type { AuthoringProject } from './authoring-project';
import type { EditorTagsState } from './editor-project-state';

export const TAG_COLOR_POOL = [
  'tag-slate',
  'tag-red',
  'tag-orange',
  'tag-amber',
  'tag-yellow',
  'tag-lime',
  'tag-green',
  'tag-emerald',
  'tag-teal',
  'tag-cyan',
  'tag-sky',
  'tag-blue',
  'tag-indigo',
  'tag-violet',
  'tag-purple',
  'tag-fuchsia',
  'tag-pink',
  'tag-rose',
  'tag-stone',
  'tag-zinc',
] as const;

export type TagColor = (typeof TAG_COLOR_POOL)[number];

export interface ProjectTagSummary {
  key: string;
  name: string;
  color: TagColor;
  count: number;
  collections: Partial<Record<AuthoringCollectionKey, number>>;
}

export function normalizeTagName(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

export function normalizeTagKey(value: string): string {
  return normalizeTagName(value).toLocaleLowerCase();
}

export function normalizeTags(values: string[]): string[] {
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of values) {
    const name = normalizeTagName(value);
    if (!name) continue;
    const key = normalizeTagKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(name);
  }
  return tags;
}

export function tagColorForIndex(index: number): TagColor {
  return TAG_COLOR_POOL[((index % TAG_COLOR_POOL.length) + TAG_COLOR_POOL.length) % TAG_COLOR_POOL.length]!;
}

export function isTagColor(value: string): value is TagColor {
  return TAG_COLOR_POOL.includes(value as TagColor);
}

function editorTagsState(project: AuthoringProject): EditorTagsState {
  return project.editor.tags ?? { records: {} };
}

export function collectProjectTags(project: AuthoringProject, pendingTags: string[] = []): ProjectTagSummary[] {
  const registry = editorTagsState(project);
  const summaries = new Map<string, ProjectTagSummary>();
  let nextColorIndex = 0;

  for (const [key, record] of Object.entries(registry.records)) {
    if (!key || !record.name.trim()) continue;
    summaries.set(key, {
      key,
      name: record.name,
      color: isTagColor(record.color) ? record.color : tagColorForIndex(nextColorIndex),
      count: 0,
      collections: {},
    });
    nextColorIndex += 1;
  }

  function ensureTag(nameValue: string): ProjectTagSummary | null {
    const name = normalizeTagName(nameValue);
    if (!name) return null;
    const key = normalizeTagKey(name);
    const existing = summaries.get(key);
    if (existing) return existing;
    const summary: ProjectTagSummary = {
      key,
      name,
      color: tagColorForIndex(nextColorIndex),
      count: 0,
      collections: {},
    };
    summaries.set(key, summary);
    nextColorIndex += 1;
    return summary;
  }

  for (const collection of authoringCollectionKeys) {
    for (const record of Object.values(project[collection])) {
      for (const tag of normalizeTags(record.tags ?? [])) {
        const summary = ensureTag(tag);
        if (!summary) continue;
        summary.count += 1;
        summary.collections[collection] = (summary.collections[collection] ?? 0) + 1;
      }
    }
  }

  for (const tag of pendingTags) ensureTag(tag);

  return [...summaries.values()];
}

export function tagColorForName(project: AuthoringProject, name: string, pendingTags: string[] = []): TagColor {
  const key = normalizeTagKey(name);
  return collectProjectTags(project, pendingTags).find((tag) => tag.key === key)?.color ?? tagColorForIndex(0);
}

