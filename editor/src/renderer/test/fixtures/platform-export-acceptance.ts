import { assetDataFromImportMetadata } from '../../../shared/project-schema/authoring-assets';
import { defaultLayoutData } from '../../../shared/project-schema/authoring-layouts';
import { defaultMaterialData } from '../../../shared/project-schema/authoring-materials';
import { createAuthoringProject } from '../../../shared/project-schema/authoring-project';
import { defaultRoomData, roomAssetRef, roomMaterialRef, roomRoomRef } from '../../../shared/project-schema/authoring-rooms';
import { defaultShaderData } from '../../../shared/project-schema/authoring-shaders';

export const platformExportFixtureExpectations = {
  supported: ['room-navigation', 'lua', 'image', 'shader-material'],
  blocked: ['runtime-rmlui-layout-mount', 'runtime-audio-playback', 'save-reload-acceptance'],
} as const;

export function createPlatformExportAcceptanceFixture() {
  const project = createAuthoringProject({ id: 'platform-export-acceptance', name: 'Platform Export Acceptance' });
  const assets = [
    ['backdrop', 'image', 'assets/images/backdrop.png'], ['body-font', 'font', 'assets/fonts/body.ttf'],
    ['theme-music', 'audio', 'assets/audio/theme.ogg'], ['startup-lua', 'script', 'assets/scripts/startup.lua'],
  ] as const;
  for (const [id, kind, path] of assets) project.assets[id] = { id, label: id, tags: ['export-fixture'], data: assetDataFromImportMetadata({ kind, projectRelativePath: path }) };

  project.shaders['fixture-shader'] = { id: 'fixture-shader', label: 'Fixture Shader', tags: [], data: defaultShaderData('Fixture Shader') };
  project.materials['fixture-material'] = { id: 'fixture-material', label: 'Fixture Material', tags: [], data: defaultMaterialData('Fixture Material', 'fixture-shader') };
  const layout = defaultLayoutData('Fixture HUD');
  layout.rml.sourceText = '<rml><body><p id="save-status">Ready</p></body></rml>';
  layout.rcss.sourceText = 'body { font-family: Body; }';
  layout.lua.sourceText = 'function save_and_reload() Game.save("fixture"); Game.load("fixture") end';
  layout.dependencies.fonts = [{ $ref: { collection: 'assets', id: 'body-font' } }];
  layout.dependencies.scripts = [{ $ref: { collection: 'assets', id: 'startup-lua' } }];
  project.layouts['fixture-hud'] = { id: 'fixture-hud', label: 'Fixture HUD', tags: [], data: layout };

  const foyer = defaultRoomData('Foyer');
  foyer.description.source = 'A fixture with [b]rich text[/b].';
  foyer.background.asset = roomAssetRef('backdrop');
  foyer.background.material = roomMaterialRef('fixture-material');
  foyer.scripts.afterEnter = 'Game.prop("visited", true)';
  foyer.paths = [{ id: 'continue', label: 'Continue', direction: 'east', target: roomRoomRef('gallery'), enabled: true, condition: '', order: 0 }];
  foyer.overlays = [{ id: 'hud', label: 'HUD', layout: { $ref: { collection: 'layouts', id: 'fixture-hud' } }, enabled: true }];
  const gallery = defaultRoomData('Gallery');
  gallery.description.source = 'Navigation reached the gallery.';
  project.rooms.foyer = { id: 'foyer', label: 'Foyer', tags: [], data: foyer };
  project.rooms.gallery = { id: 'gallery', label: 'Gallery', tags: [], data: gallery };
  project.entrypoint = { collection: 'rooms', id: 'foyer' };
  project.settings.startup = { initScript: 'Audio.play("project:/audio/theme.ogg")' };
  project.settings.text = { defaultFont: { $ref: { collection: 'assets', id: 'body-font' } } };
  return project;
}

export const portabilityFixtureEntries = [
  { sourceId: 'case-a', targetPath: 'Assets/Hero.png' }, { sourceId: 'case-b', targetPath: 'assets/hero.png' },
  { sourceId: 'unicode-a', targetPath: 'text/café.txt' }, { sourceId: 'unicode-b', targetPath: 'text/cafe\u0301.txt' },
  { sourceId: 'reserved', targetPath: 'data/CON.json' }, { sourceId: 'long', targetPath: `assets/${'x'.repeat(260)}.png` },
  { sourceId: 'absolute', targetPath: '/etc/passwd' }, { sourceId: 'traversal', targetPath: 'assets/../secret.txt' },
] as const;
