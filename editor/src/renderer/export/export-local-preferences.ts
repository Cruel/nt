interface ExportProjectLocation {
  projectId: string;
  projectRoot: string | null;
  projectFilePath: string | null;
}

export function exportProjectPreferenceKey(location: ExportProjectLocation): string {
  // Newly created projects share the placeholder ID; only durable project
  // identities can safely identify preferences across directory moves.
  return location.projectId && location.projectId !== 'new-project'
    ? `project-id:${location.projectId}`
    : `project-path:${location.projectFilePath ?? location.projectRoot ?? 'unsaved'}`;
}
