(function (root) {
  'use strict';

  const LoadingPhase = Object.freeze({
    DownloadingPackage: 'DownloadingPackage',
    VerifyingPackage: 'VerifyingPackage',
    OpeningPackageIndex: 'OpeningPackageIndex',
    LoadingStartupContent: 'LoadingStartupContent',
    LoadingRuntimeDemand: 'LoadingRuntimeDemand',
  });
  const LoadingState = Object.freeze({
    Active: 'Active',
    Completed: 'Completed',
    Failed: 'Failed',
    Canceled: 'Canceled',
  });
  let nextLoadingOperationId = 0;

  class PlayerBootstrapError extends Error {
    constructor(code, message, retryable, sourcePath) {
      super(message);
      this.name = 'PlayerBootstrapError';
      this.code = code;
      this.retryable = Boolean(retryable);
      this.sourcePath = sourcePath || '';
    }
  }

  function diagnostic(error) {
    return [{
      code: error.code || 'player.web_bootstrap_failed',
      message: error instanceof Error ? error.message : String(error),
      sourcePath: error.sourcePath || '',
    }];
  }

  function responseError(response, label, sourcePath) {
    const status = Number(response && response.status) || 0;
    const retryable = status === 0 || status === 408 || status === 425 || status === 429 || status >= 500;
    return new PlayerBootstrapError(
      'player.web_http_failed',
      `${label} could not be downloaded${status ? ` (${status})` : ''}.`,
      retryable,
      sourcePath,
    );
  }

  function networkError(error, label, sourcePath) {
    if (error && error.name === 'AbortError') return error;
    return new PlayerBootstrapError(
      'player.web_network_failed',
      `${label} could not be downloaded: ${error instanceof Error ? error.message : String(error)}`,
      true,
      sourcePath,
    );
  }

  function contentLength(response) {
    const raw = response && response.headers && response.headers.get
      ? response.headers.get('content-length')
      : null;
    if (raw === null || raw === '') return null;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  async function readResponseBytes(response, signal, onProgress) {
    let total = contentLength(response);
    if (!response.body || typeof response.body.getReader !== 'function') {
      const buffer = await response.arrayBuffer();
      const bytes = new Uint8Array(buffer);
      if (total !== bytes.byteLength) total = null;
      onProgress(bytes.byteLength, total);
      return bytes;
    }

    const reader = response.body.getReader();
    let exact = total === null ? null : new Uint8Array(total);
    const chunks = [];
    let received = 0;
    try {
      for (;;) {
        if (signal.aborted) throw new DOMException('The download was canceled.', 'AbortError');
        const result = await reader.read();
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        if (exact && received + chunk.byteLength <= exact.byteLength) {
          exact.set(chunk, received);
        } else {
          if (exact) {
            chunks.push(exact.slice(0, received));
            exact = null;
            total = null;
          }
          chunks.push(chunk);
        }
        received += chunk.byteLength;
        onProgress(received, total);
      }
    } finally {
      reader.releaseLock();
    }

    if (exact && received === exact.byteLength) return exact;
    if (exact) {
      total = null;
      const truncated = exact.slice(0, received);
      onProgress(received, total);
      return truncated;
    }
    const combined = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return combined;
  }

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function validateConfig(config) {
    const packageConfig = config && config.package;
    if (!packageConfig || typeof packageConfig.path !== 'string' || packageConfig.path.length === 0 ||
        typeof packageConfig.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(packageConfig.sha256)) {
      throw new PlayerBootstrapError(
        'player.web_config_invalid',
        'player.json does not contain a valid package declaration.',
        false,
        'player.json',
      );
    }
    const pathSegments = packageConfig.path.split('/');
    if (packageConfig.path.startsWith('/') || packageConfig.path.includes('\\') ||
        packageConfig.path.includes(':') ||
        pathSegments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      throw new PlayerBootstrapError(
        'player.web_config_invalid',
        'player.json contains an unsafe package path.',
        false,
        'player.json',
      );
    }
    if (typeof config.saveNamespace !== 'string' || config.saveNamespace.length === 0) {
      throw new PlayerBootstrapError(
        'player.web_config_invalid',
        'player.json does not contain a valid save namespace.',
        false,
        'player.json',
      );
    }
    return config;
  }

  function createPlayerBootstrap(options) {
    if (!options || typeof options.fetch !== 'function' || !options.crypto ||
        typeof options.handoffPackage !== 'function') {
      throw new TypeError('Player bootstrap requires fetch, crypto, and handoffPackage.');
    }

    let currentOperation = 0;
    let currentPhase = LoadingPhase.DownloadingPackage;
    let currentState = LoadingState.Canceled;
    let currentController = null;
    let retainedCompletedPackageBytes = 0;
    let activePromise = null;
    let lastProgress = null;

    const emit = (record) => {
      if (!record || !record.operation || record.operation.value !== currentOperation) return;
      if (lastProgress && lastProgress.state !== LoadingState.Active) return;
      currentPhase = record.phase;
      currentState = record.state;
      lastProgress = Object.freeze({
        operation: Object.freeze({ value: record.operation.value }),
        phase: record.phase,
        state: record.state,
        completedUnits: record.completedUnits || 0,
        totalUnits: record.totalUnits === undefined ? null : record.totalUnits,
        retryable: Boolean(record.retryable),
        diagnostics: Object.freeze([...(record.diagnostics || [])]),
      });
      if (typeof options.onProgress === 'function') options.onProgress(lastProgress);
    };

    const active = (phase, completedUnits, totalUnits) => emit({
      operation: { value: currentOperation },
      phase,
      state: LoadingState.Active,
      completedUnits,
      totalUnits,
      retryable: false,
      diagnostics: [],
    });

    async function run() {
      nextLoadingOperationId += 1;
      if (!Number.isSafeInteger(nextLoadingOperationId) || nextLoadingOperationId > 0xffffffff) {
        throw new PlayerBootstrapError(
          'player.web_operation_id_exhausted',
          'The player exhausted its loading operation identifiers.',
          false,
          '',
        );
      }
      currentOperation = nextLoadingOperationId;
      currentController = new AbortController();
      currentPhase = LoadingPhase.DownloadingPackage;
      currentState = LoadingState.Active;
      retainedCompletedPackageBytes = 0;
      lastProgress = null;

      try {
        let configResponse;
        try {
          configResponse = await options.fetch('player.json', {
            cache: 'no-store',
            signal: currentController.signal,
          });
        } catch (error) {
          throw networkError(error, 'player.json', 'player.json');
        }
        if (!configResponse.ok) throw responseError(configResponse, 'player.json', 'player.json');
        const configBytes = new Uint8Array(await configResponse.arrayBuffer());
        let config;
        try {
          const decoder = options.TextDecoder ? new options.TextDecoder() : new TextDecoder();
          config = validateConfig(JSON.parse(decoder.decode(configBytes)));
        } catch (error) {
          if (error instanceof PlayerBootstrapError) throw error;
          throw new PlayerBootstrapError(
            'player.web_config_invalid',
            `player.json is invalid: ${error instanceof Error ? error.message : String(error)}`,
            false,
            'player.json',
          );
        }

        if (typeof options.prepareStorage === 'function') {
          try {
            await options.prepareStorage(config, configBytes, currentController.signal);
          } catch (error) {
            if (error && error.name === 'AbortError') throw error;
            throw new PlayerBootstrapError(
              'player.web_storage_failed',
              `Persistent storage could not be prepared: ${error instanceof Error ? error.message : String(error)}`,
              true,
              '',
            );
          }
        }

        active(LoadingPhase.DownloadingPackage, 0, null);
        let packageResponse;
        try {
          packageResponse = await options.fetch(config.package.path, {
            cache: 'no-store',
            signal: currentController.signal,
          });
        } catch (error) {
          throw networkError(error, 'The game package', config.package.path);
        }
        if (!packageResponse.ok) {
          throw responseError(packageResponse, 'The game package', config.package.path);
        }
        let packageBytes = await readResponseBytes(
          packageResponse,
          currentController.signal,
          (completed, total) => active(LoadingPhase.DownloadingPackage, completed, total),
        );
        retainedCompletedPackageBytes = packageBytes.byteLength;

        active(LoadingPhase.VerifyingPackage, 0, packageBytes.byteLength);
        const digest = await options.crypto.subtle.digest('SHA-256', packageBytes);
        if (hex(digest) !== config.package.sha256) {
          throw new PlayerBootstrapError(
            'player.web_package_checksum_mismatch',
            'The downloaded game package checksum does not match player.json.',
            false,
            config.package.path,
          );
        }
        active(LoadingPhase.VerifyingPackage, packageBytes.byteLength, packageBytes.byteLength);

        await options.handoffPackage(packageBytes, currentOperation);
        packageBytes = null;
        retainedCompletedPackageBytes = 0;
        if (typeof options.onReady === 'function') await options.onReady(currentOperation, config);
      } catch (error) {
        retainedCompletedPackageBytes = 0;
        const canceled = currentController.signal.aborted || (error && error.name === 'AbortError');
        emit({
          operation: { value: currentOperation },
          phase: currentPhase,
          state: canceled ? LoadingState.Canceled : LoadingState.Failed,
          completedUnits: lastProgress ? lastProgress.completedUnits : 0,
          totalUnits: lastProgress ? lastProgress.totalUnits : null,
          retryable: canceled ? false : Boolean(error && error.retryable),
          diagnostics: canceled ? [] : diagnostic(error),
        });
        if (!canceled && typeof options.onError === 'function') options.onError(error, lastProgress);
      } finally {
        currentController = null;
        activePromise = null;
      }
    }

    const start = () => {
      if (activePromise) return activePromise;
      activePromise = run();
      return activePromise;
    };

    return Object.freeze({
      start,
      retry() {
        if (!lastProgress || lastProgress.state !== LoadingState.Failed || !lastProgress.retryable) {
          return Promise.resolve();
        }
        return start();
      },
      cancel() {
        if (currentController) currentController.abort();
      },
      acceptProgress(record) {
        emit(record);
      },
      snapshot() {
        return Object.freeze({
          operationId: currentOperation,
          phase: currentPhase,
          state: currentState,
          retainedCompletedPackageBytes,
          retryable: Boolean(lastProgress && lastProgress.retryable),
        });
      },
    });
  }

  function installDefaultLoadingUi(documentObject) {
    if (!documentObject || typeof documentObject.createElement !== 'function') return null;
    let rootElement = documentObject.getElementById('noveltea-loading');
    if (!rootElement) {
      rootElement = documentObject.createElement('div');
      rootElement.id = 'noveltea-loading';
      rootElement.innerHTML = '<div class="noveltea-loading-card"><h1 id="noveltea-loading-title">Loading</h1><p id="noveltea-loading-phase"></p><progress id="noveltea-loading-progress"></progress><p id="noveltea-loading-detail"></p><button id="noveltea-loading-retry" type="button" hidden>Retry</button></div>';
      const style = documentObject.createElement('style');
      style.textContent = '#noveltea-loading{position:fixed;inset:0;z-index:10000;display:grid;place-items:center;padding:2rem;background:#05070b;color:#f8fafc;font-family:system-ui,sans-serif}.noveltea-loading-card{width:min(32rem,100%);text-align:center}#noveltea-loading-progress{width:100%;height:1rem}#noveltea-loading-detail{min-height:2.5rem;color:#cbd5e1;white-space:pre-wrap}#noveltea-loading-retry{font:inherit;padding:.7rem 1.2rem}';
      documentObject.head.appendChild(style);
      documentObject.body.appendChild(rootElement);
    }
    const title = documentObject.getElementById('noveltea-loading-title');
    const phase = documentObject.getElementById('noveltea-loading-phase');
    const progress = documentObject.getElementById('noveltea-loading-progress');
    const detail = documentObject.getElementById('noveltea-loading-detail');
    const retry = documentObject.getElementById('noveltea-loading-retry');
    const labels = {
      DownloadingPackage: 'Downloading game package',
      VerifyingPackage: 'Verifying game package',
      OpeningPackageIndex: 'Opening package index',
      LoadingStartupContent: 'Loading startup content',
      LoadingRuntimeDemand: 'Loading required content',
    };
    return {
      render(record) {
        rootElement.style.display = record.state === LoadingState.Completed ? 'none' : 'grid';
        title.textContent = record.state === LoadingState.Failed
          ? 'Unable to start'
          : record.state === LoadingState.Canceled ? 'Loading canceled' : 'Loading';
        phase.textContent = labels[record.phase] || record.phase;
        if (record.totalUnits === null) {
          progress.removeAttribute('value');
          progress.removeAttribute('max');
        } else {
          progress.max = Math.max(1, record.totalUnits);
          progress.value = Math.min(record.completedUnits, progress.max);
        }
        detail.textContent = record.diagnostics.map((item) => item.message).join('\n');
        retry.hidden = !(record.state === LoadingState.Failed && record.retryable);
      },
      bindRetry(callback) {
        retry.addEventListener('click', callback);
      },
    };
  }

  root.NovelTeaPlayerBootstrap = Object.freeze({
    LoadingPhase,
    LoadingState,
    PlayerBootstrapError,
    createPlayerBootstrap,
    installDefaultLoadingUi,
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
