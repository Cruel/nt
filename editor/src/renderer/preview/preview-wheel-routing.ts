import type { PreviewToEditorMessage } from '../../shared/preview-protocol';

export type PreviewWheelMessage = Extract<PreviewToEditorMessage, { type: 'preview-wheel' }>;

export interface PreviewWheelScrollResult {
  movedX: boolean;
  movedY: boolean;
  remainingX: number;
  remainingY: number;
}

const DELTA_EPSILON = 0.001;
const DEFAULT_LINE_HEIGHT = 16;

function axisOverflowAllowsScroll(value: string) {
  return /^(auto|scroll|overlay)$/i.test(value);
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(maximum, Math.max(minimum, value));
}

function computedLineHeight(element: HTMLElement) {
  const parsed = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_LINE_HEIGHT;
}

function normalizeDeltas(placeholder: HTMLElement, input: PreviewWheelMessage) {
  if (input.deltaMode === 0) return { deltaX: input.deltaX, deltaY: input.deltaY };
  if (input.deltaMode === 1) {
    const lineHeight = computedLineHeight(placeholder);
    return { deltaX: input.deltaX * lineHeight, deltaY: input.deltaY * lineHeight };
  }
  const boundary = placeholder.closest<HTMLElement>('[data-workbench-group-id]');
  return {
    deltaX: input.deltaX * Math.max(1, boundary?.clientWidth ?? placeholder.clientWidth),
    deltaY: input.deltaY * Math.max(1, boundary?.clientHeight ?? placeholder.clientHeight),
  };
}

function consumeHorizontal(element: HTMLElement, delta: number) {
  if (Math.abs(delta) <= DELTA_EPSILON) return 0;
  const style = window.getComputedStyle(element);
  if (!axisOverflowAllowsScroll(style.overflowX) || element.scrollWidth <= element.clientWidth) return 0;
  const maximum = Math.max(0, element.scrollWidth - element.clientWidth);
  const before = clamp(element.scrollLeft, 0, maximum);
  const target = clamp(before + delta, 0, maximum);
  if (Math.abs(target - before) <= DELTA_EPSILON) return 0;
  element.scrollLeft = target;
  return element.scrollLeft - before;
}

function consumeVertical(element: HTMLElement, delta: number) {
  if (Math.abs(delta) <= DELTA_EPSILON) return 0;
  const style = window.getComputedStyle(element);
  if (!axisOverflowAllowsScroll(style.overflowY) || element.scrollHeight <= element.clientHeight) return 0;
  const maximum = Math.max(0, element.scrollHeight - element.clientHeight);
  const before = clamp(element.scrollTop, 0, maximum);
  const target = clamp(before + delta, 0, maximum);
  if (Math.abs(target - before) <= DELTA_EPSILON) return 0;
  element.scrollTop = target;
  return element.scrollTop - before;
}

export function routePreviewWheelToScrollAncestors(
  placeholder: HTMLElement,
  input: PreviewWheelMessage,
): PreviewWheelScrollResult {
  const normalized = normalizeDeltas(placeholder, input);
  let remainingX = normalized.deltaX;
  let remainingY = normalized.deltaY;
  if (input.shiftKey && Math.abs(remainingX) <= DELTA_EPSILON && Math.abs(remainingY) > DELTA_EPSILON) {
    remainingX = remainingY;
    remainingY = 0;
  }

  let movedX = false;
  let movedY = false;
  const boundary = placeholder.closest<HTMLElement>('[data-workbench-group-id]');

  for (let current = placeholder.parentElement; current; current = current.parentElement) {
    const consumedX = consumeHorizontal(current, remainingX);
    if (Math.abs(consumedX) > DELTA_EPSILON) {
      movedX = true;
      remainingX -= consumedX;
    }

    const consumedY = consumeVertical(current, remainingY);
    if (Math.abs(consumedY) > DELTA_EPSILON) {
      movedY = true;
      remainingY -= consumedY;
    }

    if (Math.abs(remainingX) <= DELTA_EPSILON) remainingX = 0;
    if (Math.abs(remainingY) <= DELTA_EPSILON) remainingY = 0;
    if (remainingX === 0 && remainingY === 0) break;
    if (current === boundary || current === document.body || current === document.documentElement) break;
  }

  return { movedX, movedY, remainingX, remainingY };
}
