export const SYSTEM_MESSAGE_ID_BASE = 0xffff0000;

export type SystemMessageArgumentType =
  | 'printable'
  | 'string'
  | 'number'
  | 'integer'
  | 'plural-number';

export type SystemMessageDefinition = {
  readonly id: number;
  readonly key: string;
  readonly arguments: Readonly<Record<string, SystemMessageArgumentType>>;
};

const definitions = [
  [0, 'noveltea.shell.game_menu'],
  [1, 'noveltea.shell.paused'],
  [2, 'noveltea.shell.resume'],
  [3, 'noveltea.shell.save'],
  [4, 'noveltea.shell.load'],
  [5, 'noveltea.shell.text_log'],
  [6, 'noveltea.shell.settings'],
  [7, 'noveltea.shell.title'],
  [8, 'noveltea.shell.quit'],
  [9, 'noveltea.shell.back'],
  [10, 'noveltea.shell.menu'],
  [11, 'noveltea.save.no_thumbnail'],
  [12, 'noveltea.settings.ui_scale'],
  [13, 'noveltea.settings.text_scale'],
  [14, 'noveltea.settings.minimum'],
  [15, 'noveltea.settings.default_scale'],
  [16, 'noveltea.settings.maximum'],
  [17, 'noveltea.text_log.history'],
  [18, 'noveltea.text_log.title'],
  [19, 'noveltea.text_log.empty'],
  [20, 'noveltea.confirmation.confirm'],
  [21, 'noveltea.confirmation.prompt'],
  [22, 'noveltea.confirmation.cancel'],
  [23, 'noveltea.verb_menu.actions'],
  [24, 'noveltea.common.close'],
  [25, 'noveltea.inventory.title'],
  [26, 'noveltea.command_builder.command'],
  [27, 'noveltea.game.nearby'],
  [28, 'noveltea.status.saved'],
  [29, 'noveltea.status.settings_updated'],
  [30, 'noveltea.confirmation.return_to_title'],
  [31, 'noveltea.confirmation.quit'],
  [32, 'noveltea.confirmation.load'],
  [33, 'noveltea.settings.language'],
  [34, 'noveltea.status.language_updated'],
  [35, 'noveltea.status.language_change_failed'],
] as const;

export const systemMessageDefinitions: readonly SystemMessageDefinition[] = Object.freeze(
  definitions.map(([offset, key]) =>
    Object.freeze({
      id: SYSTEM_MESSAGE_ID_BASE + offset,
      key,
      arguments: Object.freeze({}),
    }),
  ),
);

const definitionsByKey = new Map(
  systemMessageDefinitions.map((definition) => [definition.key, definition]),
);
const definitionsById = new Map(
  systemMessageDefinitions.map((definition) => [definition.id, definition]),
);

export function systemMessageDefinitionForKey(key: string): SystemMessageDefinition | null {
  return definitionsByKey.get(key) ?? null;
}

export function systemMessageDefinitionForId(id: number): SystemMessageDefinition | null {
  return definitionsById.get(id) ?? null;
}

export function isReservedSystemMessageKey(key: string): boolean {
  return key === 'noveltea' || key.startsWith('noveltea.');
}
