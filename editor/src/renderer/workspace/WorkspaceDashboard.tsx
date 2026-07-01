import { X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { recentProjectKey, useRecentProjectsStore } from './recent-projects-store';
import { dispatchWorkspaceToolbarCommand } from './workspace-toolbar-events';

function WelcomeMessage() {
  return (
    <div className="rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
      <h2 className="text-lg font-semibold">Welcome</h2>
    </div>
  );
}

function RecentProjectsList() {
  const recentProjects = useRecentProjectsStore((state) => state.recentProjects);
  const removeRecentProject = useRecentProjectsStore((state) => state.removeRecentProject);

  if (recentProjects.length === 0) return null;

  return (
    <section className="w-full space-y-2">
      <h2 className="px-1 text-sm font-medium">Recent Projects</h2>
      <Card>
        <CardContent className="px-2 py-0">
          <div className="space-y-1">
            {recentProjects.map((entry) => {
              const projectKey = recentProjectKey(entry);
              return (
              <div key={projectKey} className="group/recent flex items-center gap-1 rounded-md hover:bg-muted/60">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
                  onClick={() => dispatchWorkspaceToolbarCommand({ command: 'open-project', projectPath: projectKey })}
                >
                  <div className="truncate text-sm font-medium">{entry.label}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">
                    {entry.projectFilePath ?? entry.projectPath}
                  </div>
                </button>
                <Button
                  aria-label={`Remove ${entry.label} from recent projects`}
                  size="icon-xs"
                  variant="ghost"
                  className="mr-1 opacity-0 group-hover/recent:opacity-100 focus-visible:opacity-100"
                  onClick={() => removeRecentProject(projectKey)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
              );
            })}
          </div>
        </CardContent>
      </Card>
    </section>
  );
}

export function WorkspaceDashboard() {
  const hasRecentProjects = useRecentProjectsStore((state) => state.recentProjects.length > 0);

  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-2xl flex-col justify-center gap-6">
        {hasRecentProjects ? <RecentProjectsList /> : <WelcomeMessage />}
      </div>
    </div>
  );
}
