import { createContext, useContext, type ReactNode } from 'react';

export interface WorkbenchEditorLocation {
  tabId: string;
  groupId: string;
  isActiveInGroup: boolean;
  isVisible: boolean;
}

const WorkbenchEditorLocationContext = createContext<WorkbenchEditorLocation | null>(null);

export function WorkbenchEditorLocationProvider({
  location,
  children,
}: {
  location: WorkbenchEditorLocation;
  children: ReactNode;
}) {
  return (
    <WorkbenchEditorLocationContext.Provider value={location}>
      {children}
    </WorkbenchEditorLocationContext.Provider>
  );
}

export function useWorkbenchEditorLocation(): WorkbenchEditorLocation {
  const location = useContext(WorkbenchEditorLocationContext);
  if (!location) throw new Error('useWorkbenchEditorLocation must be used within a WorkbenchEditorLocationProvider.');
  return location;
}

export function useOptionalWorkbenchEditorLocation(): WorkbenchEditorLocation | null {
  return useContext(WorkbenchEditorLocationContext);
}
