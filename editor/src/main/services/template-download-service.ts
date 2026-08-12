import { createHash } from 'node:crypto';
import { mkdtemp, open, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  templateRegistryIndexSchema,
  templateDownloadRequestSchema,
  type InstalledTemplate,
  type TemplateDownloadRequest,
  type TemplateDownloadResult,
  type TemplateInstallResult,
} from '../../shared/project-schema/platform-export-contracts';
import { inspectPlayerTemplate, installPlayerTemplate } from './template-registry-service';

const officialReleaseRoot = 'https://github.com/Cruel/nt/releases/download';
const allowedDownloadHosts = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);
const maxMetadataBytes = 8 * 1024 * 1024;
const maxArchiveBytes = 2 * 1024 * 1024 * 1024;

type Fetch = typeof globalThis.fetch;

function failure(message: string): TemplateDownloadResult {
  return {
    success: false,
    diagnostics: [{ code: 'template-download-failed', path: '/template', message }],
  };
}

function assertOfficialResponse(response: Response, label: string) {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  const url = new URL(response.url);
  if (url.protocol !== 'https:' || !allowedDownloadHosts.has(url.hostname)) {
    throw new Error(`${label} redirected to an untrusted host.`);
  }
}

async function fetchMetadata(fetchImpl: Fetch, url: string, label: string): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
  assertOfficialResponse(response, label);
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxMetadataBytes) throw new Error(`${label} exceeds the metadata size limit.`);
  const data = Buffer.from(await response.arrayBuffer());
  if (data.length > maxMetadataBytes) throw new Error(`${label} exceeds the metadata size limit.`);
  return data.toString('utf8');
}

function checksumForAsset(sums: string, asset: string): string {
  const matches = sums
    .split(/\r?\n/)
    .map((line) => /^([0-9a-f]{64})  (.+)$/.exec(line))
    .filter((match): match is RegExpExecArray => !!match && match[2] === asset);
  if (matches.length !== 1)
    throw new Error(`SHA256SUMS must contain exactly one entry for ${asset}.`);
  return matches[0]![1]!;
}

async function downloadArchive(
  fetchImpl: Fetch,
  url: string,
  destination: string,
): Promise<{ sha256: string; bytes: number }> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(15 * 60_000) });
  assertOfficialResponse(response, 'Template archive');
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxArchiveBytes) throw new Error('Template archive exceeds the 2 GiB limit.');
  if (!response.body) throw new Error('Template archive response has no body.');
  const output = await open(destination, 'wx');
  const digest = createHash('sha256');
  let bytes = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxArchiveBytes) {
        await reader.cancel();
        throw new Error('Template archive exceeds the 2 GiB limit.');
      }
      digest.update(value);
      await output.write(value);
    }
  } finally {
    await output.close();
  }
  return { sha256: digest.digest('hex'), bytes };
}

export async function downloadPlayerTemplateForRelease(
  releaseTag: string,
  request: TemplateDownloadRequest,
  fetchImpl: Fetch = globalThis.fetch,
): Promise<TemplateDownloadResult> {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(releaseTag)) {
    return failure(`Editor release '${releaseTag}' cannot select official templates.`);
  }
  let temporaryRoot = '';
  try {
    const parsedRequest = templateDownloadRequestSchema.parse(request);
    const root = `${officialReleaseRoot}/${encodeURIComponent(releaseTag)}`;
    const index = templateRegistryIndexSchema.parse(
      JSON.parse(
        await fetchMetadata(
          fetchImpl,
          `${root}/noveltea-player-template-registry.json`,
          'Template registry',
        ),
      ),
    );
    if (index.release !== releaseTag)
      throw new Error('Template registry release does not match the editor.');
    const matches = index.templates.filter(
      (template) =>
        template.platform === parsedRequest.platform &&
        template.architecture === parsedRequest.architecture &&
        template.buildFlavor === parsedRequest.buildFlavor,
    );
    if (matches.length !== 1) {
      throw new Error(
        `Release ${releaseTag} contains ${matches.length} templates for ${parsedRequest.platform}/${parsedRequest.architecture}/${parsedRequest.buildFlavor}.`,
      );
    }
    const selected = matches[0]!;
    if (
      path.basename(selected.archive) !== selected.archive ||
      !selected.archive.startsWith(
        `noveltea-player-template-${releaseTag}-${selected.templateId}.`,
      ) ||
      !/^[0-9A-Za-z._-]+(?:\.tar\.gz|\.zip)$/.test(selected.archive)
    ) {
      throw new Error('Template registry selected an invalid release asset name.');
    }
    const sums = await fetchMetadata(fetchImpl, `${root}/SHA256SUMS`, 'Release checksums');
    const expectedSha256 = checksumForAsset(sums, selected.archive);
    if (expectedSha256 !== selected.archiveSha256) {
      throw new Error('Template registry and SHA256SUMS disagree about the archive checksum.');
    }
    temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'noveltea-template-download-'));
    const archivePath = path.join(temporaryRoot, path.basename(selected.archive));
    const downloaded = await downloadArchive(fetchImpl, `${root}/${selected.archive}`, archivePath);
    if (downloaded.sha256 !== expectedSha256) {
      throw new Error('Downloaded template archive failed SHA-256 verification.');
    }
    const installed: TemplateInstallResult = await installPlayerTemplate({
      archivePath,
      archiveSha256: expectedSha256,
      force: true,
      officialProvenance: {
        archiveSha256: expectedSha256,
        descriptorSha256: selected.descriptorSha256,
        source: `${root}/${selected.archive}`,
      },
    });
    if (!installed.success || !installed.entry) return installed;
    const template: InstalledTemplate | null = await inspectPlayerTemplate(
      installed.entry.templateId,
      installed.entry.buildId,
    );
    if (!template) throw new Error('Installed template could not be verified after download.');
    return { ...installed, template };
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  } finally {
    if (temporaryRoot) await rm(temporaryRoot, { recursive: true, force: true });
  }
}
