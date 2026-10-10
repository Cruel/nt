// The server can observe PWA service-worker precaching independently of player
// startup. Accept HTTP requests only as supplemental transport evidence; the
// required proof is the player's completed preload plus filesystem readback.
export function verifyWebLicensePreloadEvidence(item, player, requests) {
  const prefix = `case '${item.label}'`;
  if (player?.status !== 'verified')
    throw new Error(`${prefix} license preload did not complete: ${player?.error ?? player?.status ?? 'missing player signal'}`);
  if (player.indexSha256 !== item.engineCatalogSha256 ||
      player.mountedIndexSha256 !== item.engineCatalogSha256)
    throw new Error(`${prefix} did not mount the verified engine notice index`);
  if (!Array.isArray(player.notices) || !Array.isArray(player.mountedNotices) ||
      player.notices.length !== item.notices.length ||
      player.mountedNotices.length !== item.notices.length)
    throw new Error(`${prefix} has incomplete player-side license evidence`);
  const observed = new Map();
  const mounted = new Map();
  for (const entry of player.notices) {
    if (!entry || typeof entry.path !== 'string' || observed.has(entry.path))
      throw new Error(`${prefix} has duplicated or malformed preload evidence`);
    observed.set(entry.path, entry);
  }
  for (const entry of player.mountedNotices) {
    if (!entry || typeof entry.path !== 'string' || mounted.has(entry.path))
      throw new Error(`${prefix} has duplicated or malformed mounted license evidence`);
    mounted.set(entry.path, entry);
  }
  for (const expected of item.notices) {
    for (const [label, entries] of [['preload', observed], ['filesystem', mounted]]) {
      const actual = entries.get(expected.path);
      if (!actual || actual.size !== expected.size || actual.sha256 !== expected.sha256)
        throw new Error(`${prefix} ${label} does not contain verified notice '${expected.path}'`);
    }
  }
  const expectedResponses = [
    { path: item.engineCatalog, sha256: item.engineCatalogSha256 },
    ...item.notices.map((notice) => ({
      path: `assets/system/${notice.path}`,
      sha256: notice.sha256,
    })),
  ];
  const httpObservations = expectedResponses.map((expected) => {
    const url = `${item.basePath}${expected.path}`;
    const seen = requests.filter((entry) => entry.case === item.label && entry.path === url);
    const successful = seen.filter((entry) => entry.status === 200 && entry.sha256 === expected.sha256);
    // A successful cache hit may reach the player without another server request.
    // Conversely, a service-worker installation may request an asset twice.
    return { path: expected.path, serverRequests: seen.length, matchingResponses: successful.length };
  });
  return {
    status: 'verified',
    engineNoticePreloadCount: player.notices.length,
    engineNoticeMountedCount: player.mountedNotices.length,
    engineCatalogSha256: item.engineCatalogSha256,
    mountedIndexSha256: player.mountedIndexSha256,
    httpObservations,
  };
}
