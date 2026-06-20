import { createFileRoute } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { FolderOpen, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';
import { useWorkspaceStore } from '@/stores/workspace-store';

export const Route = createFileRoute('/')({
  component: DashboardPage,
});

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
        <CardDescription>
          Runtime environment and platform details
        </CardDescription>
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

function DashboardPage() {
  const projectPath = useWorkspaceStore((s) => s.projectPath);
  const setProjectPath = useWorkspaceStore((s) => s.setProjectPath);
  const setProjectFilePath = useWorkspaceStore((s) => s.setProjectFilePath);
  const setProject = useWorkspaceStore((s) => s.setProject);
  const setDiagnostics = useWorkspaceStore((s) => s.setDiagnostics);
  const setPlaybackTests = useWorkspaceStore((s) => s.setPlaybackTests);
  const setStatusMessage = useWorkspaceStore((s) => s.setStatusMessage);

  async function handleOpenProject() {
    const dir = await window.noveltea.selectProjectDirectory();
    if (!dir) return;
    try {
      const loaded = await window.noveltea.openProject(dir);
      setProjectPath(loaded.projectPath);
      setProjectFilePath(loaded.projectFilePath);
      setProject(loaded.project ?? null);
      setDiagnostics(loaded.diagnostics ?? []);
      if (loaded.project) {
        const tests = await window.noveltea.listPlaybackTests(loaded.project);
        setPlaybackTests(tests.tests ?? []);
      }
      setStatusMessage(loaded.success ? 'Project loaded' : loaded.error ?? 'Project loaded with diagnostics');
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'Project open failed');
    }
  }

  return (
    <>
      <PageHeader title="Dashboard" description="Welcome to NovelTea Editor" />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-semibold tracking-tight">
            NovelTea Editor
          </h2>
          <p className="max-w-prose text-sm text-muted-foreground">
            A visual novel editor built for the NovelTea runtime. Create,
            manage, and preview your interactive fiction projects.
          </p>
        </div>

        <div className="flex flex-wrap gap-4">
          <Button onClick={handleOpenProject} className="gap-2">
            <FolderOpen className="h-4 w-4" />
            Open Project
          </Button>
        </div>

        {projectPath && (
          <Card>
            <CardHeader>
              <CardTitle>Current Project</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="font-mono text-xs text-muted-foreground">
                {projectPath}
              </p>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <AppInfoCard />

          <Card>
            <CardHeader>
              <CardTitle>Recent Projects</CardTitle>
              <CardDescription>Open a recent project to get started</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground">
                No recent projects. Click &ldquo;Open Project&rdquo; to browse
                for a NovelTea project directory.
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
