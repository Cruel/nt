import { createFileRoute } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PageHeader } from '@/components/page-header';
import { SourceEditor } from '@/components/source/SourceEditor';
import { codeEditorThemeLabel, codeEditorThemeOptions } from '@/components/source/source-editor-themes';
import type { CodeEditorThemeId } from '@/components/source/source-editor-theme-types';
import {
  usePreferencesStore,
  type Theme,
} from '@/stores/preferences-store';
import { ChevronLeft, ChevronRight, Code2, Monitor, Moon, Sun } from 'lucide-react';

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

const editorPreviewSource = `<div class="noveltea-layout-preview">
  <h1>NovelTea Fragment</h1>
  <p data-if="player.ready">Preview the selected editor theme.</p>
  <button id="layout-preview-counter"
    onclick="layout_preview.on_click(event, element, document)">
    Clicked 0 times
  </button>
</div>`;

function CodeEditorThemeDialog({
  currentTheme,
  onApply,
}: {
  currentTheme: CodeEditorThemeId;
  onApply: (theme: CodeEditorThemeId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [draftTheme, setDraftTheme] = useState<CodeEditorThemeId>(currentTheme);
  const currentIndex = Math.max(0, codeEditorThemeOptions.findIndex((option) => option.id === draftTheme));
  const draftOption = codeEditorThemeOptions[currentIndex] ?? codeEditorThemeOptions[0]!;

  function openDialog() {
    setDraftTheme(currentTheme);
    setOpen(true);
  }

  function cycle(offset: number) {
    const nextIndex = (currentIndex + offset + codeEditorThemeOptions.length) % codeEditorThemeOptions.length;
    setDraftTheme(codeEditorThemeOptions[nextIndex]!.id);
  }

  function applyTheme() {
    onApply(draftTheme);
    setOpen(false);
  }

  return (
    <>
      <Button type="button" variant="outline" onClick={openDialog}>
        <Code2 />
        {codeEditorThemeLabel(currentTheme)}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="!max-w-[min(960px,calc(100vw-2rem))] gap-4 p-5">
          <DialogHeader>
            <DialogTitle>Code Editor Theme</DialogTitle>
            <DialogDescription>
              Choose the syntax editor palette used by source, script, and shader editors.
            </DialogDescription>
          </DialogHeader>
          <div className="grid min-h-0 gap-4">
            <div className="grid gap-3 md:grid-cols-[minmax(220px,320px)_1fr] md:items-end">
              <div className="space-y-1">
                <Label>Theme</Label>
                <Select value={draftTheme} onValueChange={(value) => setDraftTheme(value as CodeEditorThemeId)}>
                  <SelectTrigger className="w-full">
                    <SelectValue>{draftOption.label}</SelectValue>
                  </SelectTrigger>
                  <SelectContent align="start" className="max-h-80">
                    {codeEditorThemeOptions.map((option) => (
                      <SelectItem key={option.id} value={option.id}>
                        <span>{option.label}</span>
                        <span className="text-muted-foreground">{option.variant}</span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <div className="flex min-w-0 flex-1 items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
                  <div className="truncate text-xs font-medium">{draftOption.label}</div>
                  <div className="shrink-0 text-[11px] text-muted-foreground">{currentIndex + 1} of {codeEditorThemeOptions.length}</div>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  <Button type="button" variant="outline" size="icon-sm" onClick={() => cycle(-1)} aria-label="Previous editor theme">
                    <ChevronLeft />
                  </Button>
                  <Button type="button" variant="outline" size="icon-sm" onClick={() => cycle(1)} aria-label="Next editor theme">
                    <ChevronRight />
                  </Button>
                </div>
              </div>
            </div>
            <div className="min-h-0 min-w-0">
              <SourceEditor
                value={editorPreviewSource}
                readOnly
                language="rml"
                themeId={draftTheme}
                className="h-[420px] min-h-0 w-full"
              />
            </div>
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button type="button" onClick={applyTheme}>Apply Theme</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export function SettingsPage() {
  const theme = usePreferencesStore((s) => s.theme);
  const codeEditorTheme = usePreferencesStore((s) => s.codeEditorTheme);
  const restoreLastProjectOnStart = usePreferencesStore((s) => s.restoreLastProjectOnStart);
  const setTheme = usePreferencesStore((s) => s.setTheme);
  const setCodeEditorTheme = usePreferencesStore((s) => s.setCodeEditorTheme);
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
            <CardTitle>Code Editor</CardTitle>
            <CardDescription>
              Source editor theme and preview
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex items-center justify-between gap-6">
              <div>
                <Label>Editor theme</Label>
                <p className="text-xs text-muted-foreground">
                  Applies to RML, RCSS, Lua, shader, and JSON source editors.
                </p>
              </div>
              <CodeEditorThemeDialog currentTheme={codeEditorTheme} onApply={setCodeEditorTheme} />
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
          </CardContent>
        </Card>

        <div className="flex justify-end">
          <Button
            variant="outline"
            onClick={() => {
              setTheme('system');
              setCodeEditorTheme('noveltea');
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
