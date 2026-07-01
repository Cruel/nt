import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';
import {
  usePreferencesStore,
  type Theme,
  type Density,
} from '@/stores/preferences-store';
import { Monitor, Sun, Moon, GripHorizontal, Maximize2 } from 'lucide-react';

export const Route = createFileRoute('/settings')({
  component: SettingsPage,
});

function ThemeOption({
  value,
  label,
  icon: Icon,
  current,
  onSelect,
}: {
  value: Theme;
  label: string;
  icon: typeof Sun;
  current: Theme;
  onSelect: (v: Theme) => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent ${
        selected
          ? 'border-primary bg-accent'
          : 'border-border'
      }`}
    >
      <Icon
        className={`h-5 w-5 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
      />
      <span
        className={`text-xs font-medium ${selected ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {label}
      </span>
    </button>
  );
}

function DensityOption({
  value,
  label,
  icon: Icon,
  current,
  onSelect,
}: {
  value: Density;
  label: string;
  icon: typeof GripHorizontal;
  current: Density;
  onSelect: (v: Density) => void;
}) {
  const selected = current === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex flex-col items-center gap-2 rounded-lg border p-4 transition-colors hover:bg-accent ${
        selected
          ? 'border-primary bg-accent'
          : 'border-border'
      }`}
    >
      <Icon
        className={`h-5 w-5 ${selected ? 'text-primary' : 'text-muted-foreground'}`}
      />
      <span
        className={`text-xs font-medium ${selected ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {label}
      </span>
    </button>
  );
}

export function SettingsPage() {
  const theme = usePreferencesStore((s) => s.theme);
  const density = usePreferencesStore((s) => s.density);
  const showInspector = usePreferencesStore((s) => s.showInspectorByDefault);
  const restoreLastProjectOnStart = usePreferencesStore((s) => s.restoreLastProjectOnStart);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const setDensity = usePreferencesStore((s) => s.setDensity);
  const setShowInspector = usePreferencesStore((s) => s.setShowInspectorByDefault);
  const setRestoreLastProjectOnStart = usePreferencesStore((s) => s.setRestoreLastProjectOnStart);
  const [nativeFrame, setNativeFrame] = useState(false);
  const [nativeFrameDefault, setNativeFrameDefault] = useState(false);
  const [nativeFrameSaved, setNativeFrameSaved] = useState(false);

  useEffect(() => {
    let mounted = true;
    void window.noveltea.getAppInfo().then((info) => {
      if (!mounted) return;
      setNativeFrame(info.nativeFrame);
      setNativeFrameDefault(info.platform === 'linux');
    });
    return () => {
      mounted = false;
    };
  }, []);

  function updateNativeFrame(value: boolean) {
    setNativeFrame(value);
    setNativeFrameSaved(false);
    void window.noveltea.setNativeWindowFrame(value).then((info) => {
      setNativeFrame(info.nativeFrame);
      setNativeFrameSaved(true);
    });
  }

  return (
    <>
      <PageHeader
        title="Settings"
        description="Editor preferences"
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6 [&>*]:shrink-0">
        <Card>
          <CardHeader>
            <CardTitle>Theme</CardTitle>
            <CardDescription>
              Choose your preferred appearance
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <ThemeOption
                value="system"
                label="System"
                icon={Monitor}
                current={theme}
                onSelect={setTheme}
              />
              <ThemeOption
                value="light"
                label="Light"
                icon={Sun}
                current={theme}
                onSelect={setTheme}
              />
              <ThemeOption
                value="dark"
                label="Dark"
                icon={Moon}
                current={theme}
                onSelect={setTheme}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Interface Density</CardTitle>
            <CardDescription>
              Control spacing and compactness
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex gap-3">
              <DensityOption
                value="compact"
                label="Compact"
                icon={GripHorizontal}
                current={density}
                onSelect={setDensity}
              />
              <DensityOption
                value="comfortable"
                label="Comfortable"
                icon={Maximize2}
                current={density}
                onSelect={setDensity}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Window</CardTitle>
            <CardDescription>
              Native frame and custom chrome behavior
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label htmlFor="native-window-frame">Use native window frame</Label>
                <p className="text-xs text-muted-foreground">
                  Uses the operating system title bar and window controls. Restart the editor to apply this change.
                </p>
                {nativeFrameSaved && (
                  <p className="mt-1 text-xs text-muted-foreground">
                    Saved. Restart the editor for the frame mode change to take effect.
                  </p>
                )}
              </div>
              <Switch
                id="native-window-frame"
                checked={nativeFrame}
                onCheckedChange={updateNativeFrame}
              />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Editor layout defaults
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="show-inspector">Show Inspector by default</Label>
                  <p className="text-xs text-muted-foreground">
                    Display the right-side inspector panel on workspace open
                  </p>
                </div>
                <Switch
                  id="show-inspector"
                  checked={showInspector}
                  onCheckedChange={setShowInspector}
                />
              </div>
              <div className="flex items-center justify-between">
                <div>
                  <Label htmlFor="restore-last-project">Restore last open project on startup</Label>
                  <p className="text-xs text-muted-foreground">
                    Automatically reopen the last project file when the editor starts.
                  </p>
                </div>
                <Switch
                  id="restore-last-project"
                  checked={restoreLastProjectOnStart}
                  onCheckedChange={setRestoreLastProjectOnStart}
                />
              </div>
            </div>
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setTheme('system');
              setDensity('compact');
              setShowInspector(true);
              setRestoreLastProjectOnStart(true);
              updateNativeFrame(nativeFrameDefault);
            }}
          >
            Reset to Defaults
          </Button>
        </div>
      </div>
    </>
  );
}
