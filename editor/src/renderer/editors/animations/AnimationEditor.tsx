import { useEffect, useMemo, useRef, useState } from 'react';
import { z } from 'zod';
import { useWorkbenchEditorTabState } from '@/workbench/workbench-tab-state';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EditorHelpIcon } from '@/components/editor-section-heading';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useProjectStore } from '@/project/project-store';
import { useCommandStore } from '@/commands/command-store';
import { recordSaveUnitId } from '@/project/save-unit-registry';
import type { WorkbenchEditorProps } from '@/workbench/editor-registry';
import { isAuthoringProject } from '../../../shared/project-schema/authoring-project';
import type { VideoFrameSampling } from '../../../shared/prepared-media-contracts';
import { targetFpsDuplicatesSource } from '../../../shared/video-fps-duplicates';
import {
  NATIVE_VIDEO_MIN_TESTED_NVDEC_DIMENSION,
  videoCanvasNotice,
} from '../../../shared/native-video-playback-limits';
import {
  animationDataSchema,
  animationMarkerTime,
  type AnimationData,
} from '../../../shared/project-schema/authoring-animations';
import {
  advanceAnimationTime,
  animationDuration,
  animationFrameAt,
  animationFrameTime,
  type MotionPolicy,
} from '../../../shared/animation-timeline';

export function AnimationEditor({ tab }: WorkbenchEditorProps) {
  const { t } = useTranslation('workspace');
  const document = useProjectStore((state) => state.document);
  const session = useProjectStore((state) => state.projectSessionId);
  const project = isAuthoringProject(document) ? document : null;
  const id = tab.resource?.entityId;
  const record = id ? project?.animations[id] : null;
  const parsed = useMemo(() => animationDataSchema.safeParse(record?.data), [record?.data]);
  const data = parsed.success ? parsed.data : null;
  const hasVideoMotion = data?.motions.some((entry) => entry.kind === 'video') ?? false;
  const canvasNotice = hasVideoMotion && data ? videoCanvasNotice(data.canvas) : null;
  const [newFrameAsset, setNewFrameAsset] = useState<string | null>(null);
  const [newFrameDuration, setNewFrameDuration] = useState(100);
  const imageIds = project
    ? Object.keys(project.assets).filter((id) => project.assets[id]?.data.kind === 'image')
    : [];
  const newImage = newFrameAsset ?? imageIds[0] ?? '';
  const [selected, setSelected] = useState<string | null>(null);
  const motion =
    data?.motions.find((entry) => entry.id === (selected ?? data.defaultMotionId)) ?? null;
  const spriteMotion = motion?.kind === 'sprite-sequence' ? motion : null;
  const [time, setTime] = useState(0);
  const timeRef = useRef(time);
  timeRef.current = time;
  const [playing, setPlaying] = useState(false);
  const [restart, setRestart] = useState(0);
  const [loop, setLoop] = useState(false);
  const [pendingSampling, setPendingSampling] = useState<VideoFrameSampling | null>(null);
  const [samplingError, setSamplingError] = useState(false);
  const [inspectingSampling, setInspectingSampling] = useState(false);
  const samplingProbeToken = useRef(0);
  const [rangeStart, setRangeStart] = useState('start');
  const [rangeEnd, setRangeEnd] = useState('end');
  const [urls, setUrls] = useState<Record<string, string>>({});
  const videoRef = useRef<HTMLVideoElement>(null);
  const [videoMetadata, setVideoMetadata] = useState<{ url: string; durationMs: number } | null>(
    null,
  );
  const videoUrl = motion?.kind === 'video' ? urls[motion.video.$ref.id] : null;
  const timelineMotion = useMemo(() => {
    if (motion?.kind !== 'video' || motion.sourceRange || videoMetadata?.url !== videoUrl)
      return motion;
    return { ...motion, sourceRange: { startMs: 0, endMs: videoMetadata.durationMs } };
  }, [motion, videoMetadata, videoUrl]);
  const duration = timelineMotion ? animationDuration(timelineMotion) : 0;
  const start = timelineMotion ? animationMarkerTime(timelineMotion, rangeStart) : null;
  const end = timelineMotion ? animationMarkerTime(timelineMotion, rangeEnd) : null;
  const validRange = start !== null && end !== null && start < end;
  const policy = useMemo<MotionPolicy>(
    () => ({
      repeat: loop ? 'loop' : 'once',
      rate: 1,
      clock: 'unscaled-presentation',
      initialMarker: null,
      ...(loop ? { loopRange: { start: rangeStart, end: rangeEnd } } : {}),
    }),
    [loop, rangeStart, rangeEnd],
  );
  const frameIndex = spriteMotion ? animationFrameAt(spriteMotion, time) : 0;
  const frame = spriteMotion?.frames[frameIndex];
  const assetIds = motion
    ? motion.kind === 'video'
      ? [motion.video.$ref.id]
      : [...new Set(motion.frames.map((entry) => entry.image.$ref.id))]
    : [];
  const assetKey = JSON.stringify(assetIds);

  useWorkbenchEditorTabState(tab.id, {
    schema: 'noveltea.editor.tab-state.animation',
    captureTabState: () => ({
      schema: 'noveltea.editor.tab-state.animation',
      payload: { selected, time },
    }),
    restoreTabState: (state) => {
      const view = z
        .object({ selected: z.string().nullable(), time: z.number().finite().nonnegative() })
        .strict()
        .safeParse(state.payload);
      if (view.success) {
        setSelected(view.data.selected);
        setTime(view.data.time);
        setPlaying(false);
      }
    },
  });

  useEffect(() => {
    let canceled = false;
    setUrls({});
    if (!session) return;
    const ids: string[] = JSON.parse(assetKey);
    void Promise.all(
      ids.map(async (assetId) => {
        const result = await window.noveltea.resolveProjectOriginalAssetUrl(session, assetId);
        return result.ok ? ([assetId, result.url] as const) : null;
      }),
    )
      .then((entries) => {
        if (!canceled) setUrls(Object.fromEntries(entries.filter((entry) => entry !== null)));
      })
      .catch(() => {
        if (!canceled) setUrls({});
      });
    return () => {
      canceled = true;
    };
  }, [session, assetKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (video && motion?.kind === 'video')
      video.currentTime = ((motion.sourceRange?.startMs ?? 0) + Math.min(time, duration)) / 1000;
  }, [time, duration, motion, videoUrl]);

  useEffect(() => {
    if (!playing || !timelineMotion || duration <= 0 || (loop && !validRange)) return;
    const anchor = timeRef.current;
    const started = performance.now();
    let handle = 0;
    const tick = (now: number) => {
      const next = advanceAnimationTime(timelineMotion, policy, anchor, now - started);
      setTime(next);
      if (!loop && next >= duration) setPlaying(false);
      else handle = requestAnimationFrame(tick);
    };
    handle = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(handle);
  }, [playing, timelineMotion, loop, policy, validRange, duration, restart]);

  useEffect(() => {
    samplingProbeToken.current += 1;
    setSamplingError(false);
    setInspectingSampling(false);
    setPendingSampling(null);
  }, [motion?.id, session]);

  if (!data || !record || !id || !motion)
    return <div className="p-4">{t('animationEditor.unavailable')}</div>;
  const commit = (next: AnimationData) => {
    if (!animationDataSchema.safeParse(next).success) return;
    void useCommandStore.getState().executeCommandAsync({
      type: 'entity.replaceRecord',
      label: t('animationEditor.edit'),
      payload: { collection: 'animations', entityId: id, record: { ...record, data: next } },
      originSaveUnitId: recordSaveUnitId('animations', id),
      persistencePolicy: 'manual-save',
    });
  };
  const setMarkers = (markers: typeof motion.markers) =>
    commit({
      ...data,
      motions: data.motions.map((entry) =>
        entry.id === motion.id ? { ...entry, markers } : entry,
      ),
    });
  const markers = ['start', ...motion.markers.map((entry) => entry.id), 'end'];
  const select = (
    label: string,
    value: string,
    values: string[],
    onChange: (value: string) => void,
    labelForValue: (value: string) => string = (value) => value,
  ) => (
    <div>
      <Label>{label}</Label>
      <Select
        items={values.map((value) => ({ value, label: labelForValue(value) }))}
        value={value}
        onValueChange={(value) => {
          if (value) onChange(value);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((value) => (
            <SelectItem key={value} value={value}>
              {labelForValue(value)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  const seek = (value: number) => {
    setPlaying(false);
    setTime(Math.max(0, Math.min(value, duration)));
  };
  const supportsFrames = motion.kind === 'sprite-sequence';
  const sampling = motion.kind === 'video' ? (motion.frameSampling ?? { mode: 'source' }) : null;
  const commitSampling = (next: VideoFrameSampling) => {
    if (motion.kind !== 'video') return;
    const apply = () =>
      commit({
        ...data,
        motions: data.motions.map((entry) =>
          entry.id === motion.id && entry.kind === 'video'
            ? { ...entry, frameSampling: next }
            : entry,
        ),
      });
    if (next.mode !== 'target-fps') {
      samplingProbeToken.current += 1;
      setSamplingError(false);
      apply();
      return;
    }
    const asset = project?.assets[motion.video.$ref.id]?.data;
    if (!session || asset?.kind !== 'video' || asset.source.type !== 'project-file') {
      setSamplingError(true);
      return;
    }
    const probeToken = ++samplingProbeToken.current;
    setSamplingError(false);
    setInspectingSampling(true);
    void window.noveltea
      .probeVideoTimeline(session, {
        assetId: motion.video.$ref.id,
        sourcePath: asset.source.path,
        ...(motion.sourceRange ? { sourceRange: motion.sourceRange } : {}),
      })
      .then((result) => {
        if (probeToken !== samplingProbeToken.current) return;
        if (targetFpsDuplicatesSource(result.sampleTimesMs, result.endpointMs, next.fps))
          setPendingSampling(next);
        else apply();
      })
      .catch(() => {
        if (probeToken === samplingProbeToken.current) setSamplingError(true);
      })
      .finally(() => {
        if (probeToken === samplingProbeToken.current) setInspectingSampling(false);
      });
  };
  const confirmSampling = () => {
    if (!pendingSampling || motion.kind !== 'video') return;
    commit({
      ...data,
      motions: data.motions.map((entry) =>
        entry.id === motion.id && entry.kind === 'video'
          ? { ...entry, frameSampling: pendingSampling }
          : entry,
      ),
    });
    setPendingSampling(null);
  };
  return (
    <div className="h-full space-y-4 overflow-auto p-4">
      <h2 className="font-semibold">{record.label ?? id}</h2>
      {record.import ? (
        <p className="text-xs text-muted-foreground">
          {t('animationEditor.provenance', {
            format: record.import.format,
            sources: record.import.sources.map((source) => source.originalName).join(', '),
          })}
        </p>
      ) : null}
      <div className="flex gap-2">
        {(['width', 'height'] as const).map((axis) => (
          <div key={axis}>
            <Label htmlFor={`canvas-${axis}-${tab.id}`}>
              {t(`animationEditor.canvas${axis === 'width' ? 'Width' : 'Height'}`)}
            </Label>
            <Input
              id={`canvas-${axis}-${tab.id}`}
              key={`${axis}:${data.canvas[axis]}`}
              type="number"
              min={1}
              max={10000}
              defaultValue={data.canvas[axis]}
              onBlur={(event) => {
                const value = Number(event.target.value);
                if (
                  Number.isInteger(value) &&
                  value > 0 &&
                  value <= 10000 &&
                  value !== data.canvas[axis]
                )
                  commit({ ...data, canvas: { ...data.canvas, [axis]: value } });
              }}
            />
          </div>
        ))}
      </div>
      {canvasNotice ? (
        <div
          className={`flex items-center gap-1.5 text-xs ${
            canvasNotice === 'native-limit' ? 'text-destructive' : 'text-muted-foreground'
          }`}
        >
          <span role={canvasNotice === 'native-limit' ? 'alert' : 'status'}>
            {t(
              canvasNotice === 'native-limit'
                ? 'animationEditor.videoNativeLimitNotice'
                : 'animationEditor.videoHardwareNotice',
            )}
          </span>
          <EditorHelpIcon
            label={t('animationEditor.videoNoticeDetails')}
            className="size-4 text-inherit"
          >
            {canvasNotice === 'native-limit'
              ? t('animationEditor.videoNativeLimitTooltip', data.canvas)
              : t('animationEditor.videoHardwareTooltip', {
                  ...data.canvas,
                  reason:
                    data.canvas.width < NATIVE_VIDEO_MIN_TESTED_NVDEC_DIMENSION ||
                    data.canvas.height < NATIVE_VIDEO_MIN_TESTED_NVDEC_DIMENSION
                      ? data.canvas.width % 2 !== 0 || data.canvas.height % 2 !== 0
                        ? t('animationEditor.videoHardwareSmallAndOdd')
                        : t('animationEditor.videoHardwareSmall')
                      : t('animationEditor.videoHardwareOdd'),
                })}
          </EditorHelpIcon>
        </div>
      ) : null}
      {select(
        t('animationEditor.motion'),
        motion.id,
        data.motions.map((entry) => entry.id),
        (value) => {
          setSelected(value);
          setPlaying(false);
          setTime(0);
          setRangeStart('start');
          setRangeEnd('end');
        },
      )}
      {supportsFrames ? (
        <div className="flex flex-wrap items-end gap-2">
          {select(t('animationEditor.image'), newImage, imageIds, setNewFrameAsset)}
          <div>
            <Label htmlFor={`new-duration-${tab.id}`}>{t('animationEditor.newDuration')}</Label>
            <Input
              id={`new-duration-${tab.id}`}
              type="number"
              min={1}
              value={newFrameDuration}
              onChange={(event) => setNewFrameDuration(Number(event.target.value))}
            />
          </div>
          <Button
            disabled={
              !imageIds.includes(newImage) ||
              !Number.isSafeInteger(newFrameDuration) ||
              newFrameDuration <= 0
            }
            onClick={() =>
              commit({
                ...data,
                motions: data.motions.map((entry) =>
                  entry.id === motion.id && entry.kind === 'sprite-sequence'
                    ? {
                        ...entry,
                        frames: [
                          ...entry.frames,
                          {
                            image: { $ref: { collection: 'assets', id: newImage } },
                            durationMs: newFrameDuration,
                          },
                        ],
                      }
                    : entry,
                ),
              })
            }
          >
            {t('animationEditor.addFrame')}
          </Button>
        </div>
      ) : null}
      {sampling ? (
        <div className="space-y-2">
          {select(
            t('animationEditor.videoSampling'),
            sampling.mode,
            [
              { value: 'source', label: t('animationEditor.samplingSource') },
              { value: 'target-fps', label: t('animationEditor.samplingTarget') },
              { value: 'retain-percent', label: t('animationEditor.samplingRetain') },
            ].map((option) => option.value),
            (mode) => {
              if (mode === 'source') commitSampling({ mode: 'source' });
              else if (mode === 'retain-percent')
                commitSampling({ mode: 'retain-percent', percent: 50 });
              else
                commitSampling({
                  mode: 'target-fps',
                  fps: { numerator: 30000, denominator: 1001 },
                });
            },
            (mode) =>
              t(
                `animationEditor.sampling${mode === 'source' ? 'Source' : mode === 'target-fps' ? 'Target' : 'Retain'}`,
              ),
          )}
          {sampling.mode === 'target-fps' ? (
            <div className="flex gap-2">
              {(['numerator', 'denominator'] as const).map((part) => (
                <div key={part}>
                  <Label htmlFor={`sampling-${part}-${tab.id}`}>
                    {t(`animationEditor.${part}`)}
                  </Label>
                  <Input
                    id={`sampling-${part}-${tab.id}`}
                    key={`${motion.id}:${part}:${sampling.fps[part]}`}
                    type="number"
                    min={1}
                    step={1}
                    defaultValue={sampling.fps[part]}
                    onBlur={(event) => {
                      const value = Number(event.target.value);
                      if (Number.isSafeInteger(value) && value > 0 && value !== sampling.fps[part])
                        commitSampling({ ...sampling, fps: { ...sampling.fps, [part]: value } });
                    }}
                  />
                </div>
              ))}
            </div>
          ) : null}
          {sampling.mode === 'retain-percent' ? (
            <div>
              <Label htmlFor={`retain-percent-${tab.id}`}>
                {t('animationEditor.retainPercent')}
              </Label>
              <Input
                id={`retain-percent-${tab.id}`}
                key={`${motion.id}:${sampling.percent}`}
                type="number"
                min={1}
                max={100}
                step={1}
                defaultValue={sampling.percent}
                onBlur={(event) => {
                  const percent = Number(event.target.value);
                  if (
                    Number.isSafeInteger(percent) &&
                    percent >= 1 &&
                    percent <= 100 &&
                    percent !== sampling.percent
                  )
                    commitSampling({ mode: 'retain-percent', percent });
                }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {inspectingSampling ? (
        <p className="text-xs text-muted-foreground">{t('animationEditor.samplingInspecting')}</p>
      ) : null}
      {samplingError ? (
        <p role="alert" className="text-xs text-destructive">
          {t('animationEditor.samplingInspectionFailed')}
        </p>
      ) : null}
      <Dialog
        open={pendingSampling !== null}
        onOpenChange={(open) => !open && setPendingSampling(null)}
      >
        <DialogPopup>
          <DialogTitle>{t('animationEditor.fpsConfirmationTitle')}</DialogTitle>
          <DialogDescription>{t('animationEditor.fpsConfirmationBody')}</DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingSampling(null)}>
              {t('animationEditor.cancel')}
            </Button>
            <Button onClick={confirmSampling}>{t('animationEditor.confirmFps')}</Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <div className="flex h-64 items-center justify-center bg-muted/20">
        {videoUrl ? (
          <video
            key={videoUrl}
            ref={videoRef}
            src={videoUrl}
            muted
            playsInline
            preload="auto"
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (Number.isFinite(video.duration) && video.duration > 0)
                setVideoMetadata({ url: videoUrl, durationMs: Math.round(video.duration * 1000) });
              video.currentTime =
                ((motion.kind === 'video' ? (motion.sourceRange?.startMs ?? 0) : 0) +
                  timeRef.current) /
                1000;
            }}
            className="max-h-full max-w-full bg-black object-contain"
            style={{ aspectRatio: `${data.canvas.width} / ${data.canvas.height}` }}
          />
        ) : frame && urls[frame.image.$ref.id] ? (
          <img
            src={urls[frame.image.$ref.id]}
            alt={record.label ?? id}
            className="max-h-full max-w-full object-fill"
            style={{ aspectRatio: `${data.canvas.width} / ${data.canvas.height}` }}
          />
        ) : (
          t('animationEditor.noSource')
        )}
      </div>
      <p className="text-xs text-muted-foreground">{t('animationEditor.sourcePreview')}</p>
      <div className="flex flex-wrap gap-2">
        <Button
          onClick={() => setPlaying(true)}
          disabled={(!frame && !videoUrl) || duration <= 0 || (loop && !validRange)}
        >
          {t('animationEditor.play')}
        </Button>
        <Button onClick={() => setPlaying(false)}>{t('animationEditor.pause')}</Button>
        <Button
          onClick={() => {
            setTime(0);
            setRestart((value) => value + 1);
          }}
        >
          {t('animationEditor.restart')}
        </Button>
        <Button
          disabled={!supportsFrames || frameIndex === 0}
          onClick={() => spriteMotion && seek(animationFrameTime(spriteMotion, frameIndex - 1))}
        >
          {t('animationEditor.previous')}
        </Button>
        <Button
          disabled={!spriteMotion || !frame || frameIndex === spriteMotion.frames.length - 1}
          onClick={() => spriteMotion && seek(animationFrameTime(spriteMotion, frameIndex + 1))}
        >
          {t('animationEditor.next')}
        </Button>
      </div>
      <Label htmlFor={`time-${tab.id}`}>{t('animationEditor.time')}</Label>
      <Input
        id={`time-${tab.id}`}
        type="range"
        min={0}
        max={duration}
        step={1}
        value={Math.min(time, duration)}
        onChange={(event) => seek(Number(event.target.value))}
      />
      <Label htmlFor={`duration-${tab.id}`}>{t('animationEditor.frameDuration')}</Label>
      <Input
        id={`duration-${tab.id}`}
        key={`${motion.id}:${frameIndex}`}
        type="number"
        min={1}
        defaultValue={frame?.durationMs ?? 1}
        disabled={!supportsFrames || !frame}
        onBlur={(event) => {
          const durationMs = Number(event.target.value);
          if (
            !Number.isSafeInteger(durationMs) ||
            durationMs <= 0 ||
            durationMs === frame?.durationMs
          )
            return;
          commit({
            ...data,
            motions: data.motions.map((entry) =>
              entry.id === motion.id && entry.kind === 'sprite-sequence'
                ? {
                    ...entry,
                    frames: entry.frames.map((value, index) =>
                      index === frameIndex ? { ...value, durationMs } : value,
                    ),
                  }
                : entry,
            ),
          });
        }}
      />
      <output aria-label={t('animationEditor.frameIndex')}>
        {supportsFrames ? `${frameIndex} / ${spriteMotion?.frames.length ?? 0}` : 'video'}
      </output>
      <output className="ml-4">
        {Math.floor(time)} / {duration} ms
      </output>
      <div className="flex flex-wrap items-end gap-3">
        <Button aria-pressed={loop} onClick={() => setLoop(!loop)}>
          {t('animationEditor.loop')}
        </Button>
        {select(t('animationEditor.loopStart'), rangeStart, markers, setRangeStart)}
        {select(t('animationEditor.loopEnd'), rangeEnd, markers, setRangeEnd)}
      </div>
      {loop && !validRange ? <p role="alert">{t('animationEditor.invalidRange')}</p> : null}
      <h3>{t('animationEditor.markers')}</h3>
      <div className="text-sm">start: 0 ms · end: {duration} ms</div>
      {motion.markers.map((marker, index) => (
        <div key={`${motion.id}:${index}`} className="flex gap-2">
          <Input
            aria-label={t('animationEditor.markerId')}
            defaultValue={marker.id}
            key={marker.id}
            onBlur={(event) => {
              const value = event.target.value;
              if (
                value === 'start' ||
                value === 'end' ||
                motion.markers.some((entry, other) => other !== index && entry.id === value)
              )
                return;
              setMarkers(
                motion.markers.map((entry, other) =>
                  other === index ? { ...entry, id: value } : entry,
                ),
              );
            }}
          />
          <Input
            aria-label={t('animationEditor.markerTime')}
            key={`${marker.id}:${marker.timeMs}`}
            type="number"
            min={0}
            max={duration}
            defaultValue={marker.timeMs}
            onBlur={(event) => {
              const value = Number(event.target.value);
              if (
                Number.isInteger(value) &&
                value >= 0 &&
                value <= duration &&
                value !== marker.timeMs
              )
                setMarkers(
                  motion.markers.map((entry, other) =>
                    other === index ? { ...entry, timeMs: value } : entry,
                  ),
                );
            }}
          />
          <Button onClick={() => seek(marker.timeMs)}>{t('animationEditor.seekMarker')}</Button>
          <Button onClick={() => setMarkers(motion.markers.filter((_, other) => other !== index))}>
            {t('animationEditor.deleteMarker')}
          </Button>
        </div>
      ))}
      <Button
        onClick={() => {
          let markerId = 'marker';
          let suffix = 1;
          while (markers.includes(markerId)) markerId = `marker-${suffix++}`;
          setMarkers([...motion.markers, { id: markerId, timeMs: Math.floor(time) }]);
        }}
      >
        {t('animationEditor.addMarker')}
      </Button>
    </div>
  );
}
