import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PreviewPane,
  type PreviewHostLease,
  type PreviewPanePolicy,
} from '@/preview/preview-host-pool';
import type { PreviewDocument, PreviewMode } from '../../shared/preview-protocol';
import type { PreviewRootKey } from '../../shared/focused-preview-contracts';
import { usePreferencesStore } from '@/stores/preferences-store';
import { useProjectStore } from '@/project/project-store';
import {
  authoringDependencyGraphService,
  useCurrentAuthoringDependencyGraphSnapshot,
} from '@/project/authoring-dependency-graph-runtime';
import { FocusedPreviewFreshnessCoordinator } from './focused-preview-coordinator';
import { isAuthoringProject } from '../../shared/project-schema/authoring-project';
import { projectSettingsFromProject } from '../../shared/project-schema/authoring-project-settings';
import { authoredPreviewEnvironment, effectivePreviewDisplay } from '../../shared/preview-display';
import { usePreviewManagerStore } from './preview-manager-store';

type FocusedProps = {
  ownerTabId: string;
  previewMode: PreviewMode;
  root: PreviewRootKey;
  inputs: unknown;
  previewDocument?: never;
  resetBeforeLoad?: never;
  paneId?: string;
  className?: string;
  hostPolicy?: PreviewPanePolicy;
  enabled?: boolean;
};

type LegacyProps = {
  ownerTabId: string;
  previewMode: PreviewMode;
  previewDocument: PreviewDocument;
  resetBeforeLoad?: boolean;
  root?: never;
  inputs?: never;
  paneId?: string;
  className?: string;
  hostPolicy?: PreviewPanePolicy;
  enabled?: boolean;
};

export function legacyPreviewContentKey(
  projectInstanceId: string | null,
  previewMode: PreviewMode,
  previewDocument: PreviewDocument,
  previewEnvironment: unknown,
) {
  return JSON.stringify([
    'legacy',
    projectInstanceId,
    previewMode,
    previewDocument,
    previewEnvironment ?? null,
  ]);
}

export function DerivedPreviewPane(props: FocusedProps | LegacyProps) {
  const {
    ownerTabId,
    previewMode,
    paneId = 'main',
    className = 'h-full w-full bg-zinc-950',
    hostPolicy = 'dedicated-while-open',
    enabled = true,
  } = props;
  const previewDisplay = usePreferencesStore((state) => state.previewDisplay);
  const projectDocument = useProjectStore((state) => state.document);
  const project = useProjectStore((state) => state.admittedProject);
  const projectInstanceId = useProjectStore((state) => state.projectInstanceId);
  const projectRevision = useProjectStore((state) => state.projectRevision);
  const publication = useProjectStore((state) => state.lastMutationPublication);
  const graph = useCurrentAuthoringDependencyGraphSnapshot();
  const sourceAnalysis = useMemo(
    () =>
      graph && projectInstanceId
        ? (authoringDependencyGraphService.currentSourceAnalysis(
            projectInstanceId,
            projectRevision,
          ) ?? [])
        : [],
    [graph, projectInstanceId, projectRevision],
  );
  const previousGraph = useMemo(
    () =>
      graph && projectInstanceId
        ? authoringDependencyGraphService.previousSnapshot(projectInstanceId, projectRevision)
        : null,
    [graph, projectInstanceId, projectRevision],
  );
  const [lease, setLease] = useState<PreviewHostLease | null>(null);
  const [readyRevision, setReadyRevision] = useState(0);
  const coordinatorRef = useRef<FocusedPreviewFreshnessCoordinator | null>(null);
  if (!coordinatorRef.current) coordinatorRef.current = new FocusedPreviewFreshnessCoordinator();

  const root = props.root;
  const inputs = props.inputs;
  const previewDocument = props.previewDocument;
  const resetBeforeLoad = props.resetBeforeLoad ?? false;
  const projectSettings = useMemo(
    () =>
      isAuthoringProject(projectDocument) ? projectSettingsFromProject(projectDocument) : undefined,
    [projectDocument],
  );
  const effectiveDisplay = useMemo(
    () => effectivePreviewDisplay(previewDisplay, projectSettings?.display),
    [previewDisplay, projectSettings?.display],
  );
  const previewEnvironment = useMemo(
    () =>
      previewDocument?.kind === 'layout-preview'
        ? authoredPreviewEnvironment(
            previewDocument,
            effectiveDisplay,
            projectSettings?.display,
            projectSettings?.accessibility,
          )
        : undefined,
    [effectiveDisplay, previewDocument, projectSettings?.accessibility, projectSettings?.display],
  );

  const effectiveInputs = useMemo(
    () =>
      root?.kind === 'layout-preview'
        ? { ...(inputs as Record<string, unknown>), displayPreference: previewDisplay }
        : inputs,
    [inputs, previewDisplay, root?.kind],
  );

  const handleLease = useCallback((nextLease: PreviewHostLease | null) => {
    setLease((current) => {
      if (current && current !== nextLease) coordinatorRef.current?.release(current.leaseId);
      return nextLease;
    });
  }, []);

  useEffect(() => {
    if (!lease || !project || !projectInstanceId || !root) return;
    coordinatorRef.current?.submit({
      project,
      projectInstanceId,
      projectRevision,
      affectedPaths:
        publication?.changeSet.projectInstanceId === projectInstanceId &&
        publication.changeSet.projectRevision === projectRevision
          ? publication.changeSet.affectedPaths
          : ['/'],
      graph,
      previousGraph,
      sourceAnalysis,
      root,
      inputs: effectiveInputs,
      lease,
      reportBuildFailure: (message) =>
        usePreviewManagerStore.getState().recordPreviewDiagnostic({
          severity: 'error',
          source: 'manager',
          message,
          target: {
            collection:
              root.kind === 'layout-preview'
                ? 'layouts'
                : root.kind === 'shader-preview'
                  ? 'shaders'
                  : 'rooms',
            entityId: root.recordId,
            kind: root.kind.replace('-preview', ''),
          },
        }),
    });
  }, [
    effectiveInputs,
    graph,
    previousGraph,
    sourceAnalysis,
    lease,
    project,
    projectInstanceId,
    projectRevision,
    publication,
    readyRevision,
    root,
  ]);

  useEffect(() => {
    if (!lease) return undefined;
    return lease.subscribeReady(() => setReadyRevision((current) => current + 1));
  }, [lease]);

  useEffect(() => {
    if (!lease || !previewDocument) return;
    const contentKey = legacyPreviewContentKey(
      projectInstanceId,
      previewMode,
      previewDocument,
      previewEnvironment,
    );
    if (lease.committedContentKey() === contentKey) {
      lease.reveal();
      return;
    }
    void (
      resetBeforeLoad
        ? lease.send((controller) => controller.reset()).catch(() => undefined)
        : Promise.resolve()
    )
      .then(() => lease.send((controller) => controller.setPreviewMode(previewMode)))
      .then(() =>
        lease.send((controller) =>
          previewEnvironment === undefined
            ? controller.loadPreviewDocument(previewDocument)
            : controller.loadPreviewDocument(previewDocument, previewEnvironment),
        ),
      )
      .then(() => {
        lease.commitContent(contentKey);
        lease.reveal();
      })
      .catch(() => undefined);
  }, [lease, previewDocument, previewEnvironment, previewMode, projectInstanceId, resetBeforeLoad]);

  useEffect(
    () => () => {
      coordinatorRef.current?.dispose();
      coordinatorRef.current = null;
    },
    [],
  );

  return (
    <PreviewPane
      ownerTabId={ownerTabId}
      paneId={paneId}
      policy={hostPolicy}
      persistence="derived"
      mode={previewMode}
      enabled={enabled}
      className={className}
      onLease={handleLease}
    />
  );
}
