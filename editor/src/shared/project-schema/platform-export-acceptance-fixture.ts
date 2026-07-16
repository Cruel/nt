import { assetDataFromImportMetadata } from './authoring-assets';
import { defaultLayoutData } from './authoring-layouts';
import { defaultMaterialData } from './authoring-materials';
import { createAuthoringProject } from './authoring-project';
import { defaultRoomData, roomAssetRef, roomMaterialRef, roomRoomRef } from './authoring-rooms';
import { defaultShaderData } from './authoring-shaders';

export const PLATFORM_EXPORT_ACCEPTANCE_FIXTURE_REVISION = '2026-07-11.1' as const;

export const platformExportFixtureExpectations = {
  supported: ['room-navigation', 'lua', 'image', 'shader-material'],
  blocked: ['runtime-rmlui-layout-mount', 'runtime-audio-playback', 'save-reload-acceptance'],
} as const;

export function createPlatformExportAcceptanceFixture() {
  const project = createAuthoringProject({
    id: 'platform-export-acceptance',
    name: 'Platform Export Acceptance',
    version: PLATFORM_EXPORT_ACCEPTANCE_FIXTURE_REVISION,
  });
  const assets = [
    ['app-icon', 'image', 'assets/images/app-icon.png'],
    ['backdrop', 'image', 'assets/images/backdrop.png'],
    ['body-font', 'font', 'assets/fonts/body.ttf'],
    ['theme-music', 'audio', 'assets/audio/theme.wav'],
    ['startup-lua', 'script', 'assets/scripts/startup.lua'],
  ] as const;
  for (const [id, kind, assetPath] of assets) {
    project.assets[id] = {
      id,
      label: id,
      data: assetDataFromImportMetadata({ kind, projectRelativePath: assetPath }),
    };
  }

  const fixtureShader = defaultShaderData('Fixture Shader');
  if (fixtureShader.uniforms[0]) delete fixtureShader.uniforms[0].default;
  project.shaders['fixture-shader'] = {
    id: 'fixture-shader',
    label: 'Fixture Shader',
        data: fixtureShader,
  };
  project.materials['fixture-material'] = {
    id: 'fixture-material',
    label: 'Fixture Material',
        data: defaultMaterialData('Fixture Material', 'fixture-shader'),
  };
  const layout = defaultLayoutData('Fixture HUD');
  layout.rml.sourceText = '<rml><body><p id="save-status">Ready</p></body></rml>';
  layout.rcss.sourceText = 'body { font-family: Body; }';
  layout.lua.sourceText = 'function save_and_reload() Game.save("fixture"); Game.load("fixture") end';
  layout.dependencies.fonts = [{ $ref: { collection: 'assets', id: 'body-font' } }];
  layout.dependencies.scripts = [{ $ref: { collection: 'assets', id: 'startup-lua' } }];
  project.layouts['fixture-hud'] = { id: 'fixture-hud', label: 'Fixture HUD', data: layout };

  const foyer = defaultRoomData('Foyer');
  foyer.description.source = { kind: 'inline', text: 'A fixture with [b]rich text[/b].' };
  foyer.background.asset = roomAssetRef('backdrop');
  foyer.background.material = roomMaterialRef('fixture-material');
  foyer.lifecycle.afterEnter = [{ kind: 'run-lua-effect', source: 'fixture_visited = true' }];
  foyer.exits = [{ id: 'continue', label: 'Continue', direction: 'east', target: roomRoomRef('gallery'), condition: { kind: 'always' } }];
  foyer.overlays = [{
    id: 'hud', layout: { $ref: { collection: 'layouts', id: 'fixture-hud' } }, enabled: true,
  }];
  const gallery = defaultRoomData('Gallery');
  gallery.description.source = { kind: 'inline', text: 'Navigation reached the gallery.' };
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', extends: null, properties: {}, data: foyer };
  project.rooms.gallery = { id: 'gallery', label: 'Gallery', extends: null, properties: {}, data: gallery };
  project.entrypoint = { kind: 'room', id: 'foyer' };
  project.startupHook = { source: 'audio.play("theme-music", "music", { loop = true })' };
  project.editor.recordMetadata.assets = Object.fromEntries(assets.map(([id]) => [id, { tags: ['export-fixture'] }]));
  project.settings.text = { defaultFont: { $ref: { collection: 'assets', id: 'body-font' } } };
  const app = project.settings.app as Record<string, unknown>;
  app.icon = { $ref: { collection: 'assets', id: 'app-icon' } };
  app.applicationId = 'org.noveltea.platformexportacceptance';
  app.saveNamespace = 'org.noveltea.platformexportacceptance';
  app.displayName = 'Platform Export Acceptance';
  app.shortName = 'Export Acceptance';
  app.versionName = PLATFORM_EXPORT_ACCEPTANCE_FIXTURE_REVISION;
  return project;
}

export const portabilityFixtureEntries = [
  { sourceId: 'case-a', targetPath: 'Assets/Hero.png' },
  { sourceId: 'case-b', targetPath: 'assets/hero.png' },
  { sourceId: 'unicode-a', targetPath: 'text/café.txt' },
  { sourceId: 'unicode-b', targetPath: 'text/cafe\u0301.txt' },
  { sourceId: 'reserved', targetPath: 'data/CON.json' },
  { sourceId: 'long', targetPath: `assets/${'x'.repeat(260)}.png` },
  { sourceId: 'absolute', targetPath: '/etc/passwd' },
  { sourceId: 'traversal', targetPath: 'assets/../secret.txt' },
] as const;
