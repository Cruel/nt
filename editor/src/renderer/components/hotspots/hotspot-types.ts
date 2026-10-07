import type { Condition } from '../../../shared/project-schema/authoring-flow';
import type {
  InteractableHotspotTarget,
  RoomHotspotTarget,
} from '../../../shared/project-schema/authoring-features';
import type {
  HotspotMotionTrack,
  ImageNormalizedRect,
} from '../../../shared/project-schema/authoring-hotspots';
import type { MaterialApplication } from '../../../shared/project-schema/authoring-material-applications';
import type { CursorTarget } from '../../../shared/project-schema/authoring-cursor-vocabulary';

export type EditableHotspotTarget = RoomHotspotTarget | InteractableHotspotTarget;

export interface EditableHotspot {
  id: string;
  label: string;
  condition: Condition;
  inputOrder: number;
  highlight:
    | { kind: 'default' | 'none' }
    | { kind: 'material'; materialApplication: MaterialApplication };
  cursor?: CursorTarget | null;
  target: EditableHotspotTarget;
  shape?: { kind: 'rect'; bounds: ImageNormalizedRect; motionTracks?: HotspotMotionTrack[] };
}
