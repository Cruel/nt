mergeInto(LibraryManager.library, {
  noveltea_web_report_loading_progress: function (
    operation, phase, state, completed, total, retryable, diagnosticCode, diagnosticMessage) {
    if (typeof Module.novelteaAcceptLoadingProgress !== 'function') return;
    var phases = [
      'DownloadingPackage',
      'VerifyingPackage',
      'OpeningPackageIndex',
      'LoadingStartupContent',
      'LoadingRuntimeDemand',
    ];
    var states = ['Active', 'Completed', 'Failed', 'Canceled'];
    var diagnostics = [];
    if (diagnosticMessage) {
      diagnostics.push({
        code: diagnosticCode ? UTF8ToString(diagnosticCode) : 'player.startup_failed',
        message: UTF8ToString(diagnosticMessage),
        sourcePath: '',
      });
    }
    Module.novelteaAcceptLoadingProgress({
      operation: { value: operation },
      phase: phases[phase] || phases[0],
      state: states[state] || states[0],
      completedUnits: completed,
      totalUnits: total < 0 ? null : total,
      retryable: Boolean(retryable),
      diagnostics: diagnostics,
    });
  },
});
