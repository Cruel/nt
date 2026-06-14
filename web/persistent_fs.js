mergeInto(LibraryManager.library, {
  noveltea_web_sync_persistent_fs: function() {
    FS.syncfs(false, function(err) {
      if (err) {
        console.error('[web_fs] sync failed:', err);
      }
    });
  }
});
