import { createHash } from 'node:crypto';
import { resolveNovelTeaCliPath } from '../../shared/noveltea-cli-subprocess';
import type { ActiveProjectSessionService } from './active-project-session-service';
import { resolveContainedOriginalAsset } from './project-original-asset-service';
import {
  installedMediaTool,
  type MediaTool,
  type MediaToolRunner,
} from './media-preparation-service';
import {
  probeOpaqueVideoTimeline,
  runVideoMediaToolProcess,
} from './opaque-video-preparation-service';
import { prepareProductionVideoMotion } from './transparent-video-tracer';
import type {
  OpaqueVideoPreparationRequest,
  VideoSourceTimingRequest,
} from '../../shared/prepared-media-contracts';

export async function probeProjectVideoTimeline(
  sessions: ActiveProjectSessionService,
  projectSessionId: string,
  request: VideoSourceTimingRequest,
  tool: MediaTool = installedMediaTool(resolveNovelTeaCliPath()),
  run: MediaToolRunner = runVideoMediaToolProcess,
) {
  const authorized = sessions.requireActiveAsset(projectSessionId, request.assetId);
  if (authorized.asset.sourcePath !== request.sourcePath)
    throw new Error('Video source does not match the active Project Asset.');
  const source = await resolveContainedOriginalAsset(sessions, projectSessionId, request.assetId, {
    requireKind: 'video',
    allowDerivedMetadata: true,
  });
  if (typeof source === 'string') throw new Error(`Video Asset is unavailable (${source}).`);
  try {
    const bytes = await source.handle.readFile();
    if (
      bytes.byteLength !== source.size ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== source.contentHash
    )
      throw new Error('Video Asset changed during inspection.');
    sessions.requireActiveAsset(projectSessionId, request.assetId);
    const result = await probeOpaqueVideoTimeline(authorized.root, request, tool, run, bytes);
    sessions.requireActiveAsset(projectSessionId, request.assetId);
    return result;
  } finally {
    await source.handle.close();
  }
}

export async function prepareProjectOpaqueVideo(
  sessions: ActiveProjectSessionService,
  projectSessionId: string,
  request: OpaqueVideoPreparationRequest,
  tool: MediaTool = installedMediaTool(resolveNovelTeaCliPath()),
  run: MediaToolRunner = runVideoMediaToolProcess,
) {
  const authorized = sessions.requireActiveAsset(projectSessionId, request.assetId);
  if (authorized.asset.sourcePath !== request.sourcePath)
    throw new Error('Video source does not match the active Project Asset.');
  const source = await resolveContainedOriginalAsset(sessions, projectSessionId, request.assetId, {
    requireKind: 'video',
    allowDerivedMetadata: true,
  });
  if (typeof source === 'string') throw new Error(`Video Asset is unavailable (${source}).`);
  try {
    const bytes = await source.handle.readFile();
    if (
      bytes.byteLength !== source.size ||
      `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== source.contentHash
    )
      throw new Error('Video Asset changed during preparation.');
    sessions.requireActiveAsset(projectSessionId, request.assetId);
    const result = await prepareProductionVideoMotion(authorized.root, request, tool, run, bytes);
    sessions.requireActiveAsset(projectSessionId, request.assetId);
    return result;
  } finally {
    await source.handle.close();
  }
}
