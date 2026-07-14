if (typeof window !== 'undefined') {
  if (!window.crossOriginIsolated || typeof SharedArrayBuffer === 'undefined') {
    throw new Error(
      'NovelTea Web requires cross-origin isolation for pthread support. ' +
      'crossOriginIsolated=' + String(window.crossOriginIsolated) +
      ', SharedArrayBuffer=' + typeof SharedArrayBuffer +
      ', origin=' + String(window.location.origin) + '. ' +
      'Serve it with Cross-Origin-Opener-Policy: same-origin and ' +
      'Cross-Origin-Embedder-Policy: require-corp.'
    );
  }
}
