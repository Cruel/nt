Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  var dependency = 'noveltea-player-package';
  var dependencyReleased = false;
  addRunDependency(dependency);

  // The Web template's .data archive is compiled before a game selects its target.
  // Finalized exports add that target's verified notices as ordinary static system assets.
  // Stage those bytes into Emscripten's existing system:/ mount before the native player
  // starts; RuntimeUI still reads only through AssetManager and verifies every notice.
  var noticeDependency = 'noveltea-player-license-assets';
  addRunDependency(noticeDependency);
  (async function stageTargetNotices() {
    var root = new URL('assets/system/', document.baseURI);
    var indexUrl = new URL('licenses/index.json', root);
    var indexResponse = await fetch(indexUrl, { cache: 'no-store' });
    if (indexResponse.status === 404) return; // This target has no engine notice inventory.
    if (!indexResponse.ok) throw new Error('Engine license index could not be downloaded.');
    var indexBuffer = await indexResponse.arrayBuffer();
    if (indexBuffer.byteLength > 1024 * 1024) throw new Error('Engine license index exceeds 1 MiB.');
    var index = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(indexBuffer));
    if (!index || index.format !== 'noveltea.engine-licenses' || !Array.isArray(index.components))
      throw new Error('Engine license index format is invalid.');
    var entries = [];
    var seen = new Set();
    var total = 0;
    for (var component of index.components) {
      if (!component || !Array.isArray(component.files)) throw new Error('Engine license component is invalid.');
      for (var file of component.files) {
        if (!file || typeof file.path !== 'string' ||
          !file.path.startsWith('licenses/') || !file.path.endsWith('.txt') ||
          file.path.includes('\\') || file.path.includes(':') ||
          file.path.split('/').some(function (part) { return !part || part === '.' || part === '..'; }) ||
          !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 1024 * 1024 ||
          typeof file.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(file.sha256) ||
          seen.has(file.path) || entries.length >= 512)
          throw new Error('Engine license index entry is invalid.');
        total += file.size;
        if (total > 64 * 1024 * 1024) throw new Error('Engine license inventory exceeds 64 MiB.');
        seen.add(file.path);
        entries.push(file);
      }
    }
    var verified = [];
    for (var entry of entries) {
      var response = await fetch(new URL(entry.path, root), { cache: 'no-store' });
      if (!response.ok) throw new Error('Engine license notice could not be downloaded.');
      var buffer = await response.arrayBuffer();
      if (buffer.byteLength !== entry.size || buffer.byteLength > 1024 * 1024)
        throw new Error('Engine license notice length differs from the inventory.');
      var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
      var hash = Array.from(digest, function (byte) { return byte.toString(16).padStart(2, '0'); }).join('');
      if (hash !== entry.sha256) throw new Error('Engine license notice checksum differs from the inventory.');
      verified.push({ path: entry.path, bytes: new Uint8Array(buffer) });
    }
    FS.mkdirTree('/assets/system/licenses');
    for (var item of verified) {
      var target = '/assets/system/' + item.path;
      FS.mkdirTree(target.slice(0, target.lastIndexOf('/')));
      FS.writeFile(target, item.bytes);
    }
    FS.writeFile('/assets/system/licenses/index.json', new Uint8Array(indexBuffer));
  })().catch(function (error) {
    // A corrupted/missing index never silently substitutes another platform's notices.
    console.warn('[player] target license inventory unavailable:', error);
  }).finally(function () {
    removeRunDependency(noticeDependency);
  });

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
