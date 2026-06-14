Module.preRun = Module.preRun || [];
Module.preRun.push(function() {
  var dependency = 'noveltea-idbfs';
  addRunDependency(dependency);

  FS.mkdirTree('/persist');
  FS.mount(IDBFS, {}, '/persist');
  FS.syncfs(true, function(err) {
    if (err) {
      console.error('[web_fs] initial sync failed:', err);
    } else {
      console.log('[web_fs] persistent filesystem mounted');
    }
    removeRunDependency(dependency);
  });
});
