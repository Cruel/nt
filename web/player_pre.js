Module.preRun = Module.preRun || [];
Module.preRun.push(function () {
  var dependency = 'noveltea-player-package';
  addRunDependency(dependency);

  function fail(error) {
    var message = error instanceof Error ? error.message : String(error);
    console.error('[player_bootstrap] ' + message);
    if (typeof Module.onNovelTeaStartupError === 'function') {
      Module.onNovelTeaStartupError(message);
    }
  }

  function hex(buffer) {
    return Array.from(new Uint8Array(buffer), function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  fetch('player.json', { cache: 'no-store' })
    .then(function (response) {
      if (!response.ok) throw new Error('Could not load player.json (' + response.status + ').');
      return response.arrayBuffer();
    })
    .then(function (configBuffer) {
      var configText = new TextDecoder().decode(configBuffer);
      var config = JSON.parse(configText);
      if (!config.package || !config.package.path || !config.package.sha256) {
        throw new Error('player.json does not contain a valid package declaration.');
      }
      FS.writeFile('/player.json', new Uint8Array(configBuffer));
      Module.novelteaSaveNamespace = config.saveNamespace;
      var namespace = String(config.saveNamespace).replace(/[^a-zA-Z0-9._-]/g, '_');
      var mount = '/persist/' + namespace;
      FS.mkdirTree(mount);
      FS.mount(IDBFS, {}, mount);
      return new Promise(function (resolve, reject) {
        FS.syncfs(true, function (error) { error ? reject(error) : resolve(); });
      }).then(function () { return fetch(config.package.path, { cache: 'no-store' }); }).then(function (response) {
        if (!response.ok) throw new Error('Could not load the game package (' + response.status + ').');
        return response.arrayBuffer();
      }).then(function (packageBuffer) {
        return crypto.subtle.digest('SHA-256', packageBuffer).then(function (digest) {
          if (hex(digest) !== config.package.sha256) {
            throw new Error('The downloaded game package checksum does not match player.json.');
          }
          FS.writeFile('/' + config.package.path, new Uint8Array(packageBuffer));
        });
      });
    })
    .then(function () { removeRunDependency(dependency); })
    .catch(fail);
});
