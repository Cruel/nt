import type {
  TerminalNotificationClickEvent,
  TerminalNotificationRequest,
} from '../../shared/terminal';

interface TerminalNativeNotification {
  show(): void;
  onClick(callback: () => void): void;
  onClose(callback: () => void): void;
}

export interface TerminalNotificationServiceOptions {
  isSupported(): boolean;
  isWindowFocused(): boolean;
  resolveSessionLabel(sessionId: string): string | null;
  resolveContent(
    label: string,
    kind: TerminalNotificationRequest['kind'],
  ): { title: string; body: string } | Promise<{ title: string; body: string }>;
  createNotification(options: { title: string; body: string }): TerminalNativeNotification;
  restoreWindow(): void;
  showWindow(): void;
  focusWindow(): void;
  emitClick(event: TerminalNotificationClickEvent): void;
}

export class TerminalNotificationService {
  private readonly activeNotifications = new Set<TerminalNativeNotification>();

  constructor(private readonly options: TerminalNotificationServiceOptions) {}

  async show(request: TerminalNotificationRequest): Promise<boolean> {
    if (!this.options.isSupported() || this.options.isWindowFocused()) return false;
    const label = this.options.resolveSessionLabel(request.sessionId);
    if (!label) return false;

    try {
      const notification = this.options.createNotification(
        await this.options.resolveContent(label, request.kind),
      );
      const release = () => this.activeNotifications.delete(notification);
      notification.onClick(() => {
        release();
        this.options.restoreWindow();
        this.options.showWindow();
        this.options.focusWindow();
        this.options.emitClick({ sessionId: request.sessionId });
      });
      notification.onClose(release);
      this.activeNotifications.add(notification);
      try {
        notification.show();
        return true;
      } catch {
        release();
        return false;
      }
    } catch {
      return false;
    }
  }
}
