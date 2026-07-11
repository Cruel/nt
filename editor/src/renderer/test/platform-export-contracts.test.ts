import { describe, expect, it } from 'vitest';
import {
  EDITOR_EXPORT_LOCAL_STATE_FORMAT, EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION, PLATFORM_EXPORT_PROFILE_FORMAT,
  PLATFORM_EXPORT_PROFILE_FORMAT_VERSION, PLAYER_CONFIG_FORMAT, PLAYER_CONFIG_FORMAT_VERSION, TEMPLATE_DESCRIPTOR_FORMAT,
  TEMPLATE_DESCRIPTOR_FORMAT_VERSION, parseEditorExportLocalState, parsePlatformExportProfile, parsePlayerBootstrapConfig,
  parseTemplateDescriptor,
} from '../../shared/project-schema/platform-export-contracts';

const sha = 'a'.repeat(64);
describe('platform export contracts', () => {
  it('parses and normalizes player bootstrap capabilities', () => {
    const value = parsePlayerBootstrapConfig({ format: PLAYER_CONFIG_FORMAT, formatVersion: PLAYER_CONFIG_FORMAT_VERSION, displayName: 'Game', applicationId: 'org.example.game', saveNamespace: 'org.example.game', versionName: '1.0.0', package: { path: 'game.ntpkg', sha256: sha, runtimePackageApi: 1 }, capabilities: ['vibration', 'network.client', 'vibration'], display: { aspectRatio: { width: 16, height: 9 }, orientation: 'landscape', barColor: '#000000' } });
    expect(value.capabilities).toEqual(['network.client', 'vibration']);
    expect(() => parsePlayerBootstrapConfig({ ...value, formatVersion: 2 })).toThrow();
    expect(() => parsePlayerBootstrapConfig({ ...value, package: { ...value.package, path: '../game.ntpkg' } })).toThrow();
    expect(() => parsePlayerBootstrapConfig({ ...value, package: { ...value.package, sha256: 'bad' } })).toThrow();
  });

  it('parses a compatible template descriptor and rejects inverted API ranges', () => {
    const descriptor = { format: TEMPLATE_DESCRIPTOR_FORMAT, formatVersion: TEMPLATE_DESCRIPTOR_FORMAT_VERSION, templateId: 'linux-x64', buildId: 'build-1', engineVersion: '1', platform: 'linux', architecture: 'x64', minimumPlatformVersion: 'provisional', graphicsBackends: ['opengl'], shaderVariants: ['glsl-120'], runtimePackageApi: { minimum: 1, maximum: 1 }, playerConfigApi: { minimum: 1, maximum: 1 }, compiledFeatures: ['lua'], capabilities: [], buildFlavor: 'release', packageAccessModes: ['sidecar'], files: [{ path: 'licenses/NOTICE.txt', size: 1, mode: 420, sha256: sha }], runtimeDependencies: [{ path: 'licenses/NOTICE.txt', kind: 'notice' }], artifacts: { archive: 'template.tar.gz', symbols: 'symbols.tar.gz', sbom: 'SBOM.cdx.json', notices: 'licenses/NOTICE.txt' }, provenance: { provider: 'local', source: 'test' }, host: { assembly: 'any', requiresToolchain: false, tools: [] } } as const;
    expect(parseTemplateDescriptor(descriptor).runtimePackageApi).toEqual({ minimum: 1, maximum: 1 });
    expect(() => parseTemplateDescriptor({ ...descriptor, runtimePackageApi: { minimum: 2, maximum: 1 } })).toThrow();
  });

  it('keeps committed profiles free of local paths and secrets', () => {
    const profile = { format: PLATFORM_EXPORT_PROFILE_FORMAT, formatVersion: PLATFORM_EXPORT_PROFILE_FORMAT_VERSION, id: 'web-release', label: 'Web Release', target: 'web', architecture: 'wasm32', buildFlavor: 'release', packageAccess: 'web-fetch', web: { artifact: 'directory-zip', threaded: false, pwa: true } } as const;
    expect(parsePlatformExportProfile(profile).compression).toBe('default');
    expect(() => parsePlatformExportProfile({ ...profile, outputPath: '/home/me/game.zip' })).toThrow();
    expect(() => parsePlatformExportProfile({ ...profile, password: 'secret' })).toThrow();
  });

  it('accepts host paths only in editor-local state', () => {
    const state = parseEditorExportLocalState({ format: EDITOR_EXPORT_LOCAL_STATE_FORMAT, formatVersion: EDITOR_EXPORT_LOCAL_STATE_FORMAT_VERSION, lastOutputDirectory: '/home/me/exports', templateRoots: ['/opt/noveltea/templates'], toolchains: { androidSdk: '/opt/android' }, signing: { keystorePath: '/secure/release.jks', secretReferences: { storePassword: 'keychain:noveltea/store' } } });
    expect(state.signing.secretReferences.storePassword).toBe('keychain:noveltea/store');
  });
});
