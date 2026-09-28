import type { DevtoolsDebugReport } from '../../../shared/preview-protocol';

export function devtoolsDebugReportFixture(): DevtoolsDebugReport {
  const snapshot: DevtoolsDebugReport['snapshot'] = {
    host: {
      platform: 'SDL3',
      renderer: 'WebGL',
      hostGeneration: 2,
      surface: {
        logicalWidth: 640,
        logicalHeight: 360,
        framebufferWidth: 640,
        framebufferHeight: 360,
        framebufferScaleX: 1,
        framebufferScaleY: 1,
      },
    },
    input: {
      referenceX: 0,
      referenceY: 0,
      pointerValid: false,
      lastEvent: '',
      debugProcessed: false,
      debugConsumed: false,
      runtimeUiProcessed: false,
      runtimeUiConsumed: false,
      runtimeUiWantsPointer: false,
      gameplayEvent: false,
      gameplayAdmitted: false,
      gameplayBlockReason: 'none',
      governingLayout: null,
      governingLayoutMode: 'none',
    },
    rmlui: [],
    rmluiDebugger: { available: true, visible: false, context: 'runtime-ui' },
    world: {
      referenceX: 0,
      referenceY: 0,
      pointerValid: false,
      captureActive: false,
      underPointer: null,
      hovered: null,
      pressed: null,
      hotspots: [],
    },
    tooling: {
      previewRunning: true,
      renderPerfLogging: false,
      nativeDebugUiAvailable: false,
      nativeDebugUiEnabled: false,
    },
    runtime: null,
  };
  return {
    formatVersion: 1,
    build: {
      engineVersion: '1.0.0',
      buildConfiguration: 'RelWithDebInfo',
      targetPlatform: 'Emscripten',
      hostPlatform: 'SDL3',
      renderer: 'WebGL',
    },
    capabilities: ['devtools-debug-report-v1'],
    snapshot,
    diagnostics: [],
    rmlui: { contexts: snapshot.rmlui, debugger: snapshot.rmluiDebugger },
    console: {
      afterSequence: '0',
      earliestRetainedSequence: '1',
      latestSequence: '0',
      lostRecordCount: '0',
      historyGap: false,
      records: [],
    },
    trace: {
      afterSequence: '0',
      earliestRetainedSequence: '1',
      latestSequence: '0',
      lostRecordCount: '0',
      historyGap: false,
      records: [],
    },
  };
}
