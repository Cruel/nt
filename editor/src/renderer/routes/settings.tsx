import { createFileRoute } from '@tanstack/react-router';
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

function SettingsPage() {
  const theme = usePreferencesStore((s) => s.theme);
  const density = usePreferencesStore((s) => s.density);
  const showInspector = usePreferencesStore((s) => s.showInspectorByDefault);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const setDensity = usePreferencesStore((s) => s.setDensity);
  const setShowInspector = usePreferencesStore((s) => s.setShowInspectorByDefault);

  return (
    <>
      <PageHeader
        title="Settings"
        description="Editor preferences"
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
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
            <CardTitle>Workspace</CardTitle>
            <CardDescription>
              Editor layout defaults
            </CardDescription>
          </CardHeader>
          <CardContent>
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
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setTheme('system');
              setDensity('compact');
              setShowInspector(true);
            }}
          >
            Reset to Defaults
          </Button>
        </div>
      </div>
    </>
  );
}
