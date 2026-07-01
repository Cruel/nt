import { createFileRoute } from '@tanstack/react-router';
import { WorkspacePage } from './workspace';

export const Route = createFileRoute('/')({
  component: WorkspacePage,
});
