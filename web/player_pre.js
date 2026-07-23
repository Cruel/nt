Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  var dependency = 'noveltea-player-package';
  var dependencyReleased = false;
  addRunDependency(dependency);

  var defaultView = null;
  if (typeof Module.onNovelTeaLoadingProgress !== 'function' && typeof document !== 'undefined') {
    defaultView = NovelTeaPlayerBootstrap.installDefaultLoadingUi(document);
    if (defaultView) Module.onNovelTeaLoadingProgress = defaultView.render;
  }

  function report(record) {
    if (typeof Module.onNovelTeaLoadingProgress === 'function') {
      Module.onNovelTeaLoadingProgress(record);
    }
  }

  function failRuntimeHandoff(error) {
    var message = error instanceof Error ? error.message : String(error);
    if (Module.novelteaLoadingController) {
      var snapshot = Module.novelteaLoadingController.snapshot();
      Module.novelteaLoadingController.acceptProgress({
        operation: { value: snapshot.operationId },
        phase: 'VerifyingPackage',
        state: 'Failed',
        completedUnits: 0,
        totalUnits: null,
        retryable: false,
        diagnostics: [{
          code: 'player.web_package_handoff_failed',
          message: message,
          sourcePath: '',
        }],
      });
    }
    throw error;
  }

  var previousRuntimeInitialized = Module.onRuntimeInitialized;
  Module.onRuntimeInitialized = function () {
    try {
      var packageBytes = Module.novelteaCompletedPackageBytes;
      var operationId = Module.novelteaCompletedPackageOperation;
      if (!(packageBytes instanceof Uint8Array) || packageBytes.byteLength === 0 || !operationId) {
        throw new Error('The completed game package is unavailable for runtime handoff.');
      }
      var pointer = Module._noveltea_player_prepare_package(packageBytes.byteLength);
      if (!pointer) {
        throw new Error('The player could not reserve memory for the game package.');
      }
      HEAPU8.set(packageBytes, pointer);
      packageBytes = null;
      Module.novelteaCompletedPackageBytes = null;
      Module.novelteaCompletedPackageOperation = 0;
      if (Module._noveltea_player_commit_package(operationId) !== 1) {
        throw new Error('The game package could not be transferred to the runtime.');
      }
    } catch (error) {
      failRuntimeHandoff(error);
      return;
    }
    if (typeof previousRuntimeInitialized === 'function') {
      previousRuntimeInitialized();
    }
  };

  var controller = NovelTeaPlayerBootstrap.createPlayerBootstrap({
    fetch: function (url, options) { return fetch(url, options); },
    crypto: crypto,
    TextDecoder: TextDecoder,
    onProgress: report,
    prepareStorage: function (config, configBytes) {
      FS.writeFile('/player.json', configBytes);
      Module.novelteaSaveNamespace = config.saveNamespace;
      var namespace = String(config.saveNamespace).replace(/[^a-zA-Z0-9._-]/g, '_');
      var mount = '/persist/' + namespace;
      FS.mkdirTree(mount);
      if (Module.novelteaPersistentStorageMount !== mount) {
        FS.mount(IDBFS, {}, mount);
        Module.novelteaPersistentStorageMount = mount;
      }
      return new Promise(function (resolve, reject) {
        FS.syncfs(true, function (error) { error ? reject(error) : resolve(); });
      });
    },
    handoffPackage: function (packageBytes, operationId) {
      if (Module.novelteaCompletedPackageBytes) {
        throw new NovelTeaPlayerBootstrap.PlayerBootstrapError(
          'player.web_package_handoff_failed',
          'A completed game package is already pending runtime handoff.',
          false,
          '',
        );
      }
      Module.novelteaCompletedPackageBytes = packageBytes;
      Module.novelteaCompletedPackageOperation = operationId;
    },
    onReady: function () {
      if (!dependencyReleased) {
        dependencyReleased = true;
        removeRunDependency(dependency);
      }
    },
    onError: function (error) {
      console.error('[player_bootstrap] ' + (error instanceof Error ? error.message : String(error)));
    },
  });

  Module.novelteaLoadingController = controller;
  Module.novelteaAcceptLoadingProgress = function (record) { controller.acceptProgress(record); };
  Module.novelteaRetryLoading = function () { return controller.retry(); };
  if (defaultView) defaultView.bindRetry(Module.novelteaRetryLoading);

  if (typeof addEventListener === 'function') {
    addEventListener('pagehide', function () { controller.cancel(); }, { once: true });
    addEventListener('beforeunload', function () { controller.cancel(); }, { once: true });
  }
  controller.start();
});
