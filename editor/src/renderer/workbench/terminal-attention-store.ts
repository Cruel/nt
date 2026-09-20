import { create } from 'zustand';
import type { TerminalAttentionEvent } from '../../shared/terminal';

const PASSIVE_ACK_DELAY_MS = 3_000;
const UNREAD_FADE_MS = 300;

export type TerminalUnreadState = 'unread' | 'fading';

export interface TerminalAttentionState {
  state: TerminalUnreadState;
  latestEvent: TerminalAttentionEvent;
}

interface TerminalAttentionStore {
  selectedSessionId: string | null;
  panelVisible: boolean;
  attentionBySession: Record<string, TerminalAttentionState>;
  setSelectedSessionId(sessionId: string | null): void;
  setPanelVisible(visible: boolean): void;
  receiveAttention(sessionId: string, attention: TerminalAttentionEvent): boolean;
  acknowledgeSelectionChange(nextSessionId: string): void;
  removeSessions(sessionIds: string[]): void;
  reset(): void;
}

let passiveTimer: ReturnType<typeof setTimeout> | null = null;
const fadeTimers = new Map<string, ReturnType<typeof setTimeout>>();

export const useTerminalAttentionStore = create<TerminalAttentionStore>()((set, get) => ({
  selectedSessionId: null,
  panelVisible: false,
  attentionBySession: {},
  setSelectedSessionId: (selectedSessionId) => set({ selectedSessionId }),
  setPanelVisible: (visible) => {
    const previous = get().panelVisible;
    set({ panelVisible: visible });
    if (!visible) {
      clearPassiveTimer();
      return;
    }
    if (!previous) schedulePassiveAcknowledgment(get, set);
  },
  receiveAttention: (sessionId, attention) => {
    const state = get();
    if (state.panelVisible && state.selectedSessionId === sessionId) return false;
    const existing = state.attentionBySession[sessionId];
    if (existing?.state === 'unread') {
      set({
        attentionBySession: {
          ...state.attentionBySession,
          [sessionId]: { ...existing, latestEvent: attention },
        },
      });
      return false;
    }
    clearFadeTimer(sessionId);
    set({
      attentionBySession: {
        ...state.attentionBySession,
        [sessionId]: { state: 'unread', latestEvent: attention },
      },
    });
    return true;
  },
  acknowledgeSelectionChange: (nextSessionId) => {
    clearPassiveTimer();
    const currentSessionId = get().selectedSessionId;
    if (currentSessionId) beginFade(currentSessionId, get, set);
    if (nextSessionId !== currentSessionId) beginFade(nextSessionId, get, set);
  },
  removeSessions: (sessionIds) => {
    const keep = new Set(sessionIds);
    const next: Record<string, TerminalAttentionState> = {};
    for (const [sessionId, attention] of Object.entries(get().attentionBySession)) {
      if (keep.has(sessionId)) next[sessionId] = attention;
      else clearFadeTimer(sessionId);
    }
    set({ attentionBySession: next });
  },
  reset: () => {
    clearPassiveTimer();
    for (const timer of fadeTimers.values()) clearTimeout(timer);
    fadeTimers.clear();
    set({ selectedSessionId: null, panelVisible: false, attentionBySession: {} });
  },
}));

export function terminalHasUnreadAttention(
  attentionBySession: Record<string, TerminalAttentionState>,
): boolean {
  return Object.keys(attentionBySession).length > 0;
}

function schedulePassiveAcknowledgment(
  get: () => TerminalAttentionStore,
  set: (partial: Partial<TerminalAttentionStore>) => void,
): void {
  clearPassiveTimer();
  const sessionId = get().selectedSessionId;
  if (!sessionId || get().attentionBySession[sessionId]?.state !== 'unread') return;
  passiveTimer = setTimeout(() => {
    passiveTimer = null;
    const state = get();
    if (!state.panelVisible || state.selectedSessionId !== sessionId) return;
    beginFade(sessionId, get, set);
  }, PASSIVE_ACK_DELAY_MS);
}

function beginFade(
  sessionId: string,
  get: () => TerminalAttentionStore,
  set: (partial: Partial<TerminalAttentionStore>) => void,
): void {
  const attention = get().attentionBySession[sessionId];
  if (!attention || attention.state === 'fading') return;
  set({
    attentionBySession: {
      ...get().attentionBySession,
      [sessionId]: { ...attention, state: 'fading' },
    },
  });
  clearFadeTimer(sessionId);
  fadeTimers.set(
    sessionId,
    setTimeout(() => {
      fadeTimers.delete(sessionId);
      const current = get().attentionBySession[sessionId];
      if (!current || current.state !== 'fading') return;
      const next = { ...get().attentionBySession };
      delete next[sessionId];
      set({ attentionBySession: next });
    }, UNREAD_FADE_MS),
  );
}

function clearPassiveTimer(): void {
  if (passiveTimer) clearTimeout(passiveTimer);
  passiveTimer = null;
}

function clearFadeTimer(sessionId: string): void {
  const timer = fadeTimers.get(sessionId);
  if (timer) clearTimeout(timer);
  fadeTimers.delete(sessionId);
}
