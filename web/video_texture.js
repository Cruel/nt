// Browser media is a time-directed decoder, never the NovelTea playback clock.
addToLibrary({
  $NTVideoTextures: {
    next: 1,
    sessions: new Map(),
    queue: [],
    active: 0,
    finish(session, task, error) {
      if (session.task !== task || task.done) return;
      task.done = true;
      clearTimeout(task.timer);
      if (task.active) NTVideoTextures.active--;
      if (error) {
        session.failure = error;
        stringToUTF8(error, task.error, task.errorCapacity);
      }
      Atomics.store(HEAP32, task.status >> 2, error ? -1 : 1);
      NTVideoTextures.pump();
    },
    cancel(session) {
      const task = session.task;
      session.task = null;
      if (!task) return;
      clearTimeout(task.timer);
      if (task.active && !task.done) NTVideoTextures.active--;
      NTVideoTextures.queue = NTVideoTextures.queue.filter((entry) => entry !== session);
      if (session.video)
        session.video.onloadedmetadata = session.video.onloadeddata = session.video.onseeked = session.video.onerror = null;
      NTVideoTextures.pump();
    },
    pump() {
      while (NTVideoTextures.active < 2 && NTVideoTextures.queue.length) {
        const session = NTVideoTextures.queue.shift();
        const task = session.task;
        if (!task || task.done) continue;
        task.active = true;
        NTVideoTextures.active++;
        const video = session.video || (session.video = document.createElement('video'));
        video.muted = true;
        video.preload = 'metadata';
        video.playsInline = true;
        const finish = (error) => NTVideoTextures.finish(session, task, error);
        const ready = () => {
          if (session.task !== task || !task.seekCompleted || video.seeking || video.readyState < 2) return;
          if (video.videoWidth !== session.width || video.videoHeight !== session.height)
            finish('Prepared browser video dimensions do not match its Animation canvas.');
          else finish(null);
        };
        const seek = () => {
          if (session.task !== task) return;
          if (!Number.isFinite(video.duration) || video.duration <= 0) {
            finish('Prepared browser video has invalid duration.');
            return;
          }
          const time = Math.min(task.time, Math.max(0, video.duration - 0.001));
          // Initial loadeddata must not publish the old frame during a directed seek.
          task.seekCompleted = !video.seeking && video.currentTime === time;
          if (!task.seekCompleted) video.currentTime = time;
          ready();
        };
        video.onloadedmetadata = seek;
        video.onloadeddata = ready;
        video.onseeked = () => {
          if (session.task !== task || video.seeking) return;
          task.seekCompleted = true;
          ready();
        };
        video.onerror = () => {
          session.failure = 'Browser cannot decode the packaged opaque video representation.';
          if (session.task) NTVideoTextures.finish(session, session.task, session.failure);
        };
        task.timer = setTimeout(() => finish('Browser video sample preparation timed out.'), 15000);
        if (!session.url) {
          session.url = URL.createObjectURL(session.blob);
          video.src = session.url;
        } else if (video.readyState >= 1) seek();
      }
    },
  },
  nt_web_video_create__deps: ['$NTVideoTextures'],
  nt_web_video_create__proxy: 'sync',
  nt_web_video_create: function(bytes, length, width, height) {
    if (NTVideoTextures.next > 0x7fffffff) return 0;
    const id = NTVideoTextures.next++;
    try {
      // Blob rejects views of the threaded player's SharedArrayBuffer.
      NTVideoTextures.sessions.set(id, { id, width, height,
        blob: new Blob([HEAPU8.slice(bytes, bytes + length)], { type: 'video/webm' }) });
      return id;
    } catch (_) { return 0; }
  },
  nt_web_video_sample__deps: ['$NTVideoTextures', '$stringToUTF8'],
  nt_web_video_sample__proxy: 'sync',
  nt_web_video_sample: function(id, timeMs, status, error, errorCapacity) {
    const session = NTVideoTextures.sessions.get(id);
    if (!session) return 0;
    NTVideoTextures.cancel(session);
    const task = session.task = { time: timeMs / 1000, status, error, errorCapacity };
    Atomics.store(HEAP32, status >> 2, 0);
    if (session.failure || !Number.isFinite(timeMs) || timeMs < 0 || NTVideoTextures.queue.length >= 64) {
      NTVideoTextures.finish(session, task, session.failure || 'Browser video decode queue or sample is invalid.');
    } else {
      NTVideoTextures.queue.push(session);
      NTVideoTextures.pump();
    }
    return 1;
  },
  nt_web_video_upload__deps: ['$NTVideoTextures', '$GL', '$stringToUTF8'],
  nt_web_video_upload__proxy: 'sync',
  nt_web_video_upload: function(id, texture, error, errorCapacity) {
    const session = NTVideoTextures.sessions.get(id);
    try {
      if (!session || session.failure || !session.task?.done || !session.video || session.video.seeking)
        throw new Error(session?.failure || 'Browser video sample is not ready.');
      const gl = GL.currentContext?.GLctx || (typeof GLctx !== 'undefined' ? GLctx : null);
      const target = GL.textures[texture];
      if (!gl || gl.isContextLost() || !target)
        throw new Error('Browser video GPU texture path is unavailable.');
      if (session.uploadedTime === session.task.time && session.uploadedTexture === target) return 1;
      const binding = gl.getParameter(gl.TEXTURE_BINDING_2D);
      const stores = [gl.UNPACK_ALIGNMENT, gl.UNPACK_FLIP_Y_WEBGL, gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,
        gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.UNPACK_ROW_LENGTH, gl.UNPACK_IMAGE_HEIGHT,
        gl.UNPACK_SKIP_PIXELS, gl.UNPACK_SKIP_ROWS, gl.UNPACK_SKIP_IMAGES];
      const values = stores.map((key) => gl.getParameter(key));
      const buffer = gl.getParameter(gl.PIXEL_UNPACK_BUFFER_BINDING);
      try {
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, null);
        stores.forEach((key) => gl.pixelStorei(key, key === gl.UNPACK_ALIGNMENT ? 1 : 0));
        gl.bindTexture(gl.TEXTURE_2D, target);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, session.video);
        if (gl.getError() !== gl.NO_ERROR) throw new Error('Browser video GPU upload failed.');
      } finally {
        gl.bindTexture(gl.TEXTURE_2D, binding);
        stores.forEach((key, index) => gl.pixelStorei(key, values[index]));
        gl.bindBuffer(gl.PIXEL_UNPACK_BUFFER, buffer);
      }
      session.uploadedTime = session.task.time;
      session.uploadedTexture = target;
      return 1;
    } catch (failure) {
      const message = String(failure);
      if (session) session.failure = message;
      stringToUTF8(message, error, errorCapacity);
      return 0;
    }
  },
  nt_web_video_cancel__deps: ['$NTVideoTextures'],
  nt_web_video_cancel__proxy: 'sync',
  nt_web_video_cancel: function(id) {
    const session = NTVideoTextures.sessions.get(id);
    if (session) NTVideoTextures.cancel(session);
  },
  nt_web_video_dispose__deps: ['$NTVideoTextures'],
  nt_web_video_dispose__proxy: 'sync',
  nt_web_video_dispose: function(id) {
    const session = NTVideoTextures.sessions.get(id);
    if (!session) return;
    NTVideoTextures.cancel(session);
    NTVideoTextures.sessions.delete(id);
    if (session.video) {
      session.video.onerror = null;
      session.video.pause();
      session.video.removeAttribute('src');
      session.video.load();
    }
    if (session.url) URL.revokeObjectURL(session.url);
  },
});
