// Browser media decoding is a private typed-texture preparation adapter, never a playback clock.
addToLibrary({
  $NTVideoTextures: {
    next: 1,
    tasks: new Map(),
    queue: [],
    active: 0,
    release(task) {
      if (task.video) {
        task.video.onloadedmetadata = task.video.onloadeddata = task.video.onseeked = task.video.onerror = null;
        task.video.pause();
        task.video.removeAttribute('src');
        task.video.load();
        task.video = null;
        URL.revokeObjectURL(task.url);
        clearTimeout(task.timer);
        NTVideoTextures.active--;
      }
      task.blob = null;
      NTVideoTextures.pump();
    },
    pump() {
      while (NTVideoTextures.active < 2 && NTVideoTextures.queue.length) {
        const task = NTVideoTextures.queue.shift();
        if (!NTVideoTextures.tasks.has(task.id)) continue;
        NTVideoTextures.active++;
        const video = task.video = document.createElement('video');
        video.muted = true;
        video.preload = 'auto';
        video.playsInline = true;
        const fail = (message) => {
          if (task.state !== 0) return;
          task.state = -1;
          stringToUTF8(message, task.error, task.errorCapacity);
          Atomics.store(HEAP32, task.status >> 2, -1);
          NTVideoTextures.release(task);
        };
        const capture = () => {
          if (task.state !== 0 || !task.seekStarted || video.seeking || video.readyState < 2) return;
          try {
            if (video.videoWidth !== task.width || video.videoHeight !== task.height)
              throw new Error('Prepared browser video dimensions do not match its Animation canvas.');
            const canvas = document.createElement('canvas');
            canvas.width = task.width;
            canvas.height = task.height;
            const context = canvas.getContext('2d', { willReadFrequently: true });
            if (!context) throw new Error('Browser video rasterization is unavailable.');
            context.drawImage(video, 0, 0);
            HEAPU8.set(context.getImageData(0, 0, task.width, task.height).data, task.pixels);
            task.state = 1;
            Atomics.store(HEAP32, task.status >> 2, 1);
            NTVideoTextures.release(task);
          } catch (error) { fail(String(error)); }
        };
        video.onloadedmetadata = () => {
          if (!Number.isFinite(video.duration) || video.duration <= 0) {
            fail('Prepared browser video has invalid duration.');
            return;
          }
          // Seek inside the final coded sample if container duration rounds below semantic end.
          task.seekStarted = true;
          video.currentTime = Math.min(task.time, Math.max(0, video.duration - 0.001));
        };
        video.onloadeddata = capture;
        video.onseeked = capture;
        video.onerror = () => fail('Browser cannot decode the packaged opaque video representation.');
        task.timer = setTimeout(() => fail('Browser video sample preparation timed out.'), 15000);
        task.url = URL.createObjectURL(task.blob);
        video.src = task.url;
      }
    },
  },
  nt_web_video_start__deps: ['$NTVideoTextures', '$stringToUTF8'],
  nt_web_video_start__proxy: 'sync',
  nt_web_video_start: function(bytes, length, timeMs, width, height, pixels, status, error, errorCapacity) {
    if (NTVideoTextures.next > 0x7fffffff) return 0;
    const id = NTVideoTextures.next++;
    const task = { id, width, height, pixels, status, error, errorCapacity, time: timeMs / 1000, state: 0,
      blob: new Blob([HEAPU8.slice(bytes, bytes + length)], { type: 'video/webm' }) };
    NTVideoTextures.tasks.set(id, task);
    NTVideoTextures.queue.push(task);
    NTVideoTextures.pump();
    return id;
  },
  nt_web_video_dispose__deps: ['$NTVideoTextures'],
  nt_web_video_dispose__proxy: 'sync',
  nt_web_video_dispose: function(id) {
    const task = NTVideoTextures.tasks.get(id);
    if (!task) return;
    NTVideoTextures.tasks.delete(id);
    NTVideoTextures.queue = NTVideoTextures.queue.filter((queued) => queued !== task);
    task.state = -2;
    NTVideoTextures.release(task);
  },
});
