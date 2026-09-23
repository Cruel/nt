export type CliStaticCompletion =
  | 'none'
  | 'daemon-control'
  | 'authoring-cache'
  | 'runtime-cache'
  | 'native-tool';

export type CliProjectAccess = 'none' | 'read' | 'transactional-write' | 'opaque-write';
export type CliStdinRequirement = 'none' | 'json';
export type CliExecutionClass = 'owner-short' | 'owner-mutation' | 'disposable-heavy';

export interface CliCommandRouting {
  readonly staticCompletion: CliStaticCompletion;
  readonly executionClass: CliExecutionClass;
  readonly quickJsRequiredAfterStaticMiss: boolean;
  readonly requiresExistingProject: boolean;
  readonly projectAccess: CliProjectAccess;
  readonly replaySafe: boolean;
  readonly stdin: CliStdinRequirement;
  readonly streamedEvents: boolean;
  readonly cancellation: boolean;
}

const noProjectRead: CliCommandRouting = {
  staticCompletion: 'none',
  executionClass: 'disposable-heavy',
  quickJsRequiredAfterStaticMiss: true,
  requiresExistingProject: false,
  projectAccess: 'none',
  replaySafe: true,
  stdin: 'none',
  streamedEvents: false,
  cancellation: false,
};

const projectRead: CliCommandRouting = {
  ...noProjectRead,
  requiresExistingProject: true,
  projectAccess: 'read',
  executionClass: 'owner-short',
};

const projectDirectoryTool: CliCommandRouting = {
  ...noProjectRead,
  requiresExistingProject: true,
};

function includes(arguments_: readonly string[], value: string): boolean {
  return arguments_.includes(value);
}

function projectMutation(command: readonly string[], dryRunFlag = '--dry-run'): CliCommandRouting {
  if (includes(command, dryRunFlag)) return projectRead;
  return {
    ...projectRead,
    projectAccess: 'transactional-write',
    executionClass: 'owner-mutation',
    replaySafe: false,
  };
}

/**
 * Classifies one canonical CLI command path without loading authoring modules. The result is the
 * single execution-tier contract shared by bootstrap validation, the standalone host, and the
 * resident Project application layer.
 */
export function classifyNovelTeaCliCommand(command: readonly string[]): CliCommandRouting | null {
  const family = command[0];
  const operation = command[1];
  const detail = command[2];

  if (family === 'daemon' && (operation === 'status' || operation === 'stop'))
    return {
      ...noProjectRead,
      staticCompletion: 'daemon-control',
      quickJsRequiredAfterStaticMiss: false,
      replaySafe: operation === 'status',
    };

  if (family === 'shaderc' || family === 'texturec')
    return {
      ...noProjectRead,
      staticCompletion: 'native-tool',
      quickJsRequiredAfterStaticMiss: false,
      replaySafe: false,
    };

  if (family === 'project') {
    if (operation === 'create' || operation === 'import')
      return { ...noProjectRead, replaySafe: false };
    if (operation === 'export')
      return {
        ...projectRead,
        executionClass: 'disposable-heavy',
        replaySafe: false,
        streamedEvents: true,
        cancellation: true,
      };
    return null;
  }

  if (family === 'agent' && operation === 'sync')
    return { ...projectDirectoryTool, replaySafe: false };

  if (family === 'comfyui') {
    if (operation === 'status' || operation === 'workflows' || operation === 'verify')
      return noProjectRead;
    if (operation === 'run')
      return {
        ...noProjectRead,
        projectAccess: 'opaque-write',
        executionClass: 'disposable-heavy',
        replaySafe: false,
        streamedEvents: true,
        cancellation: true,
      };
    return null;
  }

  if (family === 'validate') return { ...projectRead, staticCompletion: 'authoring-cache' };
  if (family === 'usages') return projectRead;

  if (family === 'asset') {
    if (operation === 'audit') return projectRead;
    if (operation === 'import') return projectMutation(command);
    return null;
  }

  if (family === 'entity') {
    if (operation === 'create' || operation === 'rename' || operation === 'delete')
      return projectMutation(command);
    return null;
  }

  if (family === 'localization') {
    if (operation === 'view') return projectRead;
    if (operation === 'sync') return projectMutation(command);
    if (operation === 'reconcile') {
      if (!includes(command, '--apply')) return projectRead;
      return {
        ...projectRead,
        projectAccess: 'transactional-write',
        executionClass: 'owner-mutation',
        replaySafe: false,
        stdin: 'json',
      };
    }
    if (operation === 'accept' || operation === 'review') return projectMutation(command);
    return null;
  }

  if (family === 'shaders' && operation === 'compile')
    return {
      ...projectRead,
      executionClass: 'disposable-heavy',
      replaySafe: false,
      cancellation: true,
    };

  if (family === 'test') {
    if (operation !== 'run' && operation !== 'run-spec' && operation !== 'run-ui-spec') return null;
    return {
      ...projectRead,
      staticCompletion: 'runtime-cache',
      executionClass: 'disposable-heavy',
      stdin: operation === 'run-spec' || operation === 'run-ui-spec' ? 'json' : 'none',
      cancellation: true,
    };
  }

  if (family === 'package' && operation === 'export')
    return {
      ...projectRead,
      executionClass: 'disposable-heavy',
      replaySafe: false,
      streamedEvents: true,
      cancellation: true,
    };

  if (family === 'platform') {
    if (operation === 'profiles') return projectRead;
    if (operation === 'export') {
      if (includes(command, '--check'))
        return { ...projectRead, streamedEvents: true, cancellation: true };
      return {
        ...projectRead,
        projectAccess: 'opaque-write',
        executionClass: 'disposable-heavy',
        replaySafe: false,
        streamedEvents: true,
        cancellation: true,
      };
    }
    if (operation === 'template') {
      if (detail === 'list' || detail === 'inspect') return noProjectRead;
      if (detail === 'install' || detail === 'remove')
        return { ...noProjectRead, replaySafe: false };
      return null;
    }
    if (operation === 'config' && detail === 'init') return { ...noProjectRead, replaySafe: false };
    return null;
  }

  return null;
}
