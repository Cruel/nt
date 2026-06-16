import { createFileRoute } from '@tanstack/react-router';
import { useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Select, SelectItem } from '@/components/ui/select';
import {
  Dialog,
  DialogTrigger,
  DialogPopup,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import {
  Menu,
  MenuTrigger,
  MenuPopup,
  MenuItem,
  MenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  Tooltip,
  TooltipTrigger,
  TooltipPopup,
} from '@/components/ui/tooltip';
import { Separator } from '@/components/ui/separator';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/page-header';
import { cn } from '@/lib/utils';
import { Bell, Settings, User, LogOut, Info } from 'lucide-react';

export const Route = createFileRoute('/components')({
  component: ComponentsPage,
});

function ComponentsPage() {
  const [inputValue, setInputValue] = useState('');
  const [switchChecked, setSwitchChecked] = useState(false);
  const [selectValue, setSelectValue] = useState('');

  return (
    <>
      <PageHeader
        title="Components"
        description="shadcn Base UI component demonstration"
      />
      <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-6">
        <Card>
          <CardHeader>
            <CardTitle>Button</CardTitle>
            <CardDescription>Button variants and sizes</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Button variant="default">Default</Button>
            <Button variant="secondary">Secondary</Button>
            <Button variant="destructive">Destructive</Button>
            <Button variant="outline">Outline</Button>
            <Button variant="ghost">Ghost</Button>
            <Button variant="link">Link</Button>
            <Button size="sm">Small</Button>
            <Button size="lg">Large</Button>
            <Button size="icon">
              <Bell className="h-4 w-4" />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Card &amp; Badge</CardTitle>
            <CardDescription>Combined card and badge styling</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Badge variant="default">Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="destructive">Destructive</Badge>
            <Badge variant="outline">Outline</Badge>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Form Controls</CardTitle>
            <CardDescription>
              Input, label, switch, and select
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-2">
              <Label htmlFor="demo-input">Text Input</Label>
              <Input
                id="demo-input"
                placeholder="Type something..."
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Value: {inputValue || '(empty)'}
              </p>
            </div>

            <div className="flex items-center gap-3">
              <Label htmlFor="demo-switch">Toggle</Label>
              <Switch
                id="demo-switch"
                checked={switchChecked}
                onCheckedChange={setSwitchChecked}
              />
              <span className="text-xs text-muted-foreground">
                {switchChecked ? 'On' : 'Off'}
              </span>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="demo-select">Choose an option</Label>
              <Select
                value={selectValue}
                onValueChange={(v) => {
                  setSelectValue(v as string);
                }}
              >
                <SelectItem value="apple">Apple</SelectItem>
                <SelectItem value="banana">Banana</SelectItem>
                <SelectItem value="cherry">Cherry</SelectItem>
                <SelectItem value="date" disabled>
                  Date (disabled)
                </SelectItem>
              </Select>
              <p className="text-xs text-muted-foreground">
                Selected: {selectValue || '(none)'}
              </p>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Dialogs, Menus &amp; Tooltips</CardTitle>
            <CardDescription>Popups, portals, and overlays</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <Dialog>
              <DialogTrigger
                className={cn(buttonVariants({ variant: 'outline' }))}
              >
                Open Dialog
              </DialogTrigger>
              <DialogPopup>
                <DialogTitle>Confirm Action</DialogTitle>
                <DialogDescription>
                  This demonstrates the dialog component working within the
                  Electron renderer. Press Escape or click the close button.
                </DialogDescription>
                <div className="flex justify-end gap-2">
                  <Button variant="outline">Cancel</Button>
                  <Button>Continue</Button>
                </div>
              </DialogPopup>
            </Dialog>

            <Menu>
              <MenuTrigger
                className={cn(
                  buttonVariants({ variant: 'outline' }),
                  'gap-2',
                )}
              >
                <Settings className="h-4 w-4" />
                Menu
              </MenuTrigger>
              <MenuPopup>
                <MenuItem>
                  <User className="h-4 w-4" />
                  Profile
                </MenuItem>
                <MenuItem>
                  <Settings className="h-4 w-4" />
                  Settings
                </MenuItem>
                <MenuSeparator />
                <MenuItem>
                  <LogOut className="h-4 w-4" />
                  Log out
                </MenuItem>
              </MenuPopup>
            </Menu>

            <Tooltip>
              <TooltipTrigger
                className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }))}
              >
                <Info className="h-4 w-4" />
              </TooltipTrigger>
              <TooltipPopup>Help tooltip</TooltipPopup>
            </Tooltip>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Separator &amp; Skeleton</CardTitle>
            <CardDescription>Layout and loading states</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="flex items-center gap-3">
              <span className="text-sm">Left</span>
              <Separator orientation="vertical" className="h-5" />
              <span className="text-sm">Right</span>
            </div>
            <Separator />
            <div className="space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-20 w-full" />
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
