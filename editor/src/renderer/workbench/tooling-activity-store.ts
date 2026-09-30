import { create } from 'zustand';
import type { ToolingActivityRecord } from '../../shared/tooling-activity';

const TOOLING_ACTIVITY_LIMIT = 1000;

interface ToolingActivityStoreState {
  records: ToolingActivityRecord[];
  add: (record: ToolingActivityRecord) => void;
  clear: () => void;
}

export const useToolingActivityStore = create<ToolingActivityStoreState>()((set) => ({
  records: [],
  add: (record) =>
    set((state) => ({ records: [record, ...state.records].slice(0, TOOLING_ACTIVITY_LIMIT) })),
  clear: () => set({ records: [] }),
}));

let captureStarted = false;
let stopCapture: (() => void) | null = null;

export function startToolingActivityCapture() {
  if (captureStarted) return;
  captureStarted = true;
  stopCapture = window.noveltea.onToolingActivity((record) =>
    useToolingActivityStore.getState().add(record),
  );
}

export function stopToolingActivityCapture() {
  stopCapture?.();
  stopCapture = null;
  captureStarted = false;
}
