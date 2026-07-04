import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TagInput } from '@/components/tags/TagInput';
import type { ProjectTagSummary } from '../../shared/project-schema/authoring-tags';

const suggestions: ProjectTagSummary[] = [
  { key: 'hero', name: 'Hero', color: 'tag-slate', count: 2, collections: { assets: 1, scenes: 1 } },
  { key: 'school', name: 'School', color: 'tag-red', count: 1, collections: { rooms: 1 } },
];

function Harness({ initial = [] as string[] }) {
  const [tags, setTags] = useState(initial);
  return <TagInput value={tags} onChange={setTags} suggestions={suggestions} placeholder="New Tag" />;
}

describe('TagInput', () => {
  it('creates tag badges from comma-delimited input', () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('New Tag'), { target: { value: 'Travel,' } });
    expect(screen.getByText('Travel')).toBeInTheDocument();
    expect(screen.getByRole('textbox')).toHaveValue('');
  });

  it('restores the previous badge text when backspace is pressed on an empty input', () => {
    render(<Harness initial={['Hero', 'School']} />);
    const input = screen.getByRole('textbox');
    fireEvent.keyDown(input, { key: 'Backspace' });
    expect(screen.queryByLabelText('Remove School tag')).not.toBeInTheDocument();
    expect(input).toHaveValue('School');
  });

  it('shows matching existing tags as suggestions', () => {
    render(<Harness />);
    fireEvent.change(screen.getByPlaceholderText('New Tag'), { target: { value: 'sch' } });
    expect(screen.getByText('School')).toBeInTheDocument();
  });

  it('shows all existing tag suggestions from the chevron toggle', () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText('Show all tag suggestions'));
    expect(screen.getByText('Hero')).toBeInTheDocument();
    expect(screen.getByText('School')).toBeInTheDocument();
  });
});
