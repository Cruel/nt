import { useQuery } from '@tanstack/react-query';
import { FilePlus2, FolderOpen, Info, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecentProjectsStore } from './recent-projects-store';
import { dispatchWorkspaceToolbarCommand } from './workspace-toolbar-events';

function AppInfoCard() {
  const { data, isLoading } = useQuery({
    queryKey: ['app-info'],
    queryFn: () => window.noveltea.getAppInfo(),
  });

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Application Info</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-2/3" />
        </CardContent>
      </Card>
    );
  }

  if (!data) return null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" />
          <CardTitle>Application Info</CardTitle>
        </div>
        <CardDescription>Runtime environment and platform details</CardDescription>
      </CardHeader>
      <CardContent>
        <dl className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Version</dt>
            <dd className="font-mono text-xs">{data.version}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Electron</dt>
            <dd className="font-mono text-xs">{data.electronVersion}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Platform</dt>
            <dd className="font-mono text-xs">{data.platform}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Architecture</dt>
            <dd className="font-mono text-xs">{data.arch}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Packaged</dt>
            <dd>
              <Badge variant={data.packaged ? 'default' : 'secondary'}>
                {data.packaged ? 'Yes' : 'No'}
              </Badge>
            </dd>
          </div>
        </dl>
      </CardContent>
    </Card>
  );
}

function RecentProjectsCard() {
  const recentProjects = useRecentProjectsStore((state) => state.recentProjects);
  const removeRecentProject = useRecentProjectsStore((state) => state.removeRecentProject);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent Projects</CardTitle>
        <CardDescription>Open a recent project to get started</CardDescription>
      </CardHeader>
      <CardContent>
        {recentProjects.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No recent projects. Click &ldquo;Open Project&rdquo; to browse for a NovelTea project.
          </p>
        ) : (
          <div className="space-y-1">
            {recentProjects.map((entry) => (
              <div key={entry.projectPath} className="group/recent flex items-center gap-1 rounded-md hover:bg-muted/60">
                <button
                  type="button"
                  className="min-w-0 flex-1 rounded-md px-2 py-1.5 text-left"
                  onClick={() => dispatchWorkspaceToolbarCommand({ command: 'open-project', projectPath: entry.projectPath })}
                >
                  <div className="truncate text-sm font-medium">{entry.label}</div>
                  <div className="truncate font-mono text-[10px] text-muted-foreground">{entry.projectPath}</div>
                </button>
                <Button
                  aria-label={`Remove ${entry.label} from recent projects`}
                  size="icon-xs"
                  variant="ghost"
                  className="mr-1 opacity-0 group-hover/recent:opacity-100 focus-visible:opacity-100"
                  onClick={() => removeRecentProject(entry.projectPath)}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkspaceDashboard() {
  return (
    <div className="flex h-full items-center justify-center overflow-y-auto p-6">
      <div className="flex w-full max-w-2xl flex-col items-center justify-center gap-6">
        <div className="flex flex-wrap justify-center gap-3">
          <Button onClick={() => dispatchWorkspaceToolbarCommand('new-project')} className="gap-2">
            <FilePlus2 className="h-4 w-4" />
            New Project
          </Button>
          <Button onClick={() => dispatchWorkspaceToolbarCommand('open-project')} className="gap-2">
            <FolderOpen className="h-4 w-4" />
            Open Project
          </Button>
        </div>

        <div className="grid w-full gap-4 md:grid-cols-2">
          <AppInfoCard />
          <RecentProjectsCard />
        </div>
      </div>
    </div>
  );
}
