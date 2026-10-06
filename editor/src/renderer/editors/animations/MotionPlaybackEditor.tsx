import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { animationMarkerTime } from '../../../shared/project-schema/authoring-animations';
import type { MotionPolicy, SpriteMotion } from '../../../shared/animation-timeline';

export function MotionPlaybackEditor({
  motion,
  value,
  onChange,
}: {
  motion: SpriteMotion;
  value: MotionPolicy | null;
  onChange: (value: MotionPolicy | null) => void;
}) {
  const { t } = useTranslation('workspace');
  const policy: MotionPolicy = value ?? {
    repeat: 'loop',
    rate: 1,
    clock: 'gameplay',
    initialMarker: null,
  };
  const markers = ['start', ...motion.markers.map((marker) => marker.id), 'end'];
  const select = (
    label: string,
    selected: string,
    values: { value: string; label: string }[],
    change: (value: string) => void,
  ) => (
    <div>
      <Label>{label}</Label>
      <Select
        items={values}
        value={selected}
        onValueChange={(value) => {
          if (value) change(value);
        }}
      >
        <SelectTrigger aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
  const markerOptions = markers.map((value) => ({ value, label: value }));
  const range = policy.loopRange ?? { start: 'start', end: 'end' };
  return (
    <div className="space-y-2">
      {select(
        t('animationEditor.repeat'),
        policy.repeat,
        [
          { value: 'once', label: t('animationEditor.once') },
          { value: 'loop', label: t('animationEditor.loop') },
        ],
        (repeat) => {
          const { loopRange: _, ...base } = policy;
          onChange({ ...base, repeat: repeat === 'once' ? 'once' : 'loop' });
        },
      )}
      {policy.repeat === 'loop' ? (
        <div className="grid grid-cols-2 gap-2">
          {select(t('animationEditor.loopStart'), range.start, markerOptions, (start) =>
            onChange({ ...policy, loopRange: { ...range, start } }),
          )}
          {select(t('animationEditor.loopEnd'), range.end, markerOptions, (end) =>
            onChange({ ...policy, loopRange: { ...range, end } }),
          )}
          {(animationMarkerTime(motion, range.start) ?? Infinity) >=
          (animationMarkerTime(motion, range.end) ?? -Infinity) ? (
            <p role="alert">{t('animationEditor.invalidRange')}</p>
          ) : null}
        </div>
      ) : null}
      {select(
        t('animationEditor.initialMarker'),
        policy.initialMarker ?? 'start',
        markerOptions,
        (initialMarker) =>
          onChange({ ...policy, initialMarker: initialMarker === 'start' ? null : initialMarker }),
      )}
      <Label>{t('animationEditor.rate')}</Label>
      <Input
        aria-label={t('animationEditor.rate')}
        type="number"
        min={0.001}
        step={0.1}
        value={policy.rate}
        onChange={(event) => {
          const rate = Number(event.target.value);
          if (Number.isFinite(rate) && rate > 0) onChange({ ...policy, rate });
        }}
      />
      {select(
        t('animationEditor.clock'),
        policy.clock,
        [
          { value: 'gameplay', label: t('animationEditor.gameplay') },
          { value: 'unscaled-presentation', label: t('animationEditor.unscaled') },
        ],
        (clock) =>
          onChange({
            ...policy,
            clock: clock === 'gameplay' ? 'gameplay' : 'unscaled-presentation',
          }),
      )}
      <Button onClick={() => onChange(null)} disabled={!value}>
        {t('animationEditor.defaultPolicy')}
      </Button>
    </div>
  );
}
