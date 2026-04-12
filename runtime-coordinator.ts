import type { OverlayHandle } from "@mariozechner/pi-tui";
import type { HeadlessDispatchMonitor } from "./headless-monitor.js";
import type { MonitorEventPayload } from "./types.js";

const MONITOR_HISTORY_LIMIT = 200;

/** Centralizes overlay, monitor, widget, and completion-suppression state for the extension runtime. */
export class InteractiveShellCoordinator {
	private overlayOpen = false;
	private overlayHandle: OverlayHandle | null = null;
	private headlessMonitors = new Map<string, HeadlessDispatchMonitor>();
	private monitorEventHistory = new Map<string, MonitorEventPayload[]>();
	private monitorEventCounters = new Map<string, number>();
	private bgWidgetCleanup: (() => void) | null = null;
	private agentHandledCompletion = new Set<string>();

	isOverlayOpen(): boolean {
		return this.overlayOpen;
	}

	beginOverlay(): boolean {
		if (this.overlayOpen) return false;
		this.overlayOpen = true;
		return true;
	}

	endOverlay(): void {
		this.overlayOpen = false;
		this.clearOverlayHandle();
	}

	focusOverlay(): void {
		this.overlayHandle?.focus();
	}

	unfocusOverlay(): void {
		this.overlayHandle?.unfocus();
	}

	isOverlayFocused(): boolean {
		return this.overlayHandle?.isFocused() === true;
	}

	setOverlayHandle(handle: OverlayHandle): void {
		this.overlayHandle = handle;
	}

	clearOverlayHandle(): void {
		this.overlayHandle = null;
	}

	markAgentHandledCompletion(sessionId: string): void {
		this.agentHandledCompletion.add(sessionId);
	}

	consumeAgentHandledCompletion(sessionId: string): boolean {
		const had = this.agentHandledCompletion.has(sessionId);
		this.agentHandledCompletion.delete(sessionId);
		return had;
	}

	setMonitor(id: string, monitor: HeadlessDispatchMonitor): void {
		this.headlessMonitors.set(id, monitor);
	}

	getMonitor(id: string): HeadlessDispatchMonitor | undefined {
		return this.headlessMonitors.get(id);
	}

	deleteMonitor(id: string): void {
		this.headlessMonitors.delete(id);
	}

	recordMonitorEvent(event: Omit<MonitorEventPayload, "eventId" | "timestamp">): MonitorEventPayload {
		const nextId = (this.monitorEventCounters.get(event.sessionId) ?? 0) + 1;
		this.monitorEventCounters.set(event.sessionId, nextId);

		const recorded: MonitorEventPayload = {
			...event,
			eventId: nextId,
			timestamp: new Date().toISOString(),
		};

		const existing = this.monitorEventHistory.get(event.sessionId) ?? [];
		existing.push(recorded);
		if (existing.length > MONITOR_HISTORY_LIMIT) {
			existing.splice(0, existing.length - MONITOR_HISTORY_LIMIT);
		}
		this.monitorEventHistory.set(event.sessionId, existing);
		return recorded;
	}

	getMonitorEvents(sessionId: string, options?: { limit?: number; offset?: number }): {
		events: MonitorEventPayload[];
		total: number;
		limit: number;
		offset: number;
	} {
		const events = this.monitorEventHistory.get(sessionId) ?? [];
		const total = events.length;
		const limit = Math.max(1, Math.trunc(options?.limit ?? 20));
		const offset = Math.max(0, Math.trunc(options?.offset ?? 0));
		const end = Math.max(0, total - offset);
		const start = Math.max(0, end - limit);
		return {
			events: events.slice(start, end),
			total,
			limit,
			offset,
		};
	}

	clearMonitorEvents(sessionId: string): void {
		this.monitorEventHistory.delete(sessionId);
		this.monitorEventCounters.delete(sessionId);
	}

	disposeMonitor(id: string): void {
		const monitor = this.headlessMonitors.get(id);
		if (!monitor) return;
		monitor.dispose();
		this.headlessMonitors.delete(id);
	}

	disposeAllMonitors(): void {
		for (const monitor of this.headlessMonitors.values()) {
			monitor.dispose();
		}
		this.headlessMonitors.clear();
	}

	replaceBackgroundWidgetCleanup(cleanup: (() => void) | null): void {
		this.bgWidgetCleanup?.();
		this.bgWidgetCleanup = cleanup;
	}

	clearBackgroundWidget(): void {
		this.bgWidgetCleanup?.();
		this.bgWidgetCleanup = null;
	}
}
