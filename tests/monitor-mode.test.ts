import { afterEach, describe, expect, it, vi } from "vitest";

type MonitorOptionsCapture = {
	monitor?: {
		strategy: "stream" | "poll-diff";
		triggers: Array<{ id: string; match: (input: string) => string | undefined; cooldownMs?: number }>;
		pollIntervalMs: number;
		dedupeExactLine: boolean;
		cooldownMs?: number;
	};
	onMonitorEvent?: (event: unknown) => void | Promise<void>;
} | null;

async function setupHarness() {
	let toolDef: any;
	let monitorOptions: MonitorOptionsCapture = null;
	let launchedCommand: string | undefined;

	vi.resetModules();
	vi.doMock("@mariozechner/pi-coding-agent", () => ({
		getAgentDir: () => "/tmp/pi-agent",
	}));
	vi.doMock("@mariozechner/pi-tui", () => ({
		isKeyRelease: () => false,
		isKeyRepeat: () => false,
		matchesKey: () => false,
		truncateToWidth: (value: string) => value,
		visibleWidth: (value: string) => value.length,
	}));
	vi.doMock("../config.js", async () => {
		const actual = await vi.importActual<typeof import("../config.js")>("../config.js");
		return {
			...actual,
			loadConfig: vi.fn(() => ({
				exitAutoCloseDelay: 10,
				overlayWidthPercent: 95,
				overlayHeightPercent: 60,
				focusShortcut: "alt+shift+f",
				spawn: {
					defaultAgent: "pi",
					shortcut: "alt+shift+p",
					commands: { pi: "pi", codex: "codex", claude: "claude" },
					defaultArgs: { pi: [], codex: [], claude: [] },
					worktree: false,
					worktreeBaseDir: undefined,
				},
				scrollbackLines: 5000,
				ansiReemit: true,
				handoffPreviewEnabled: true,
				handoffPreviewLines: 30,
				handoffPreviewMaxChars: 2000,
				handoffSnapshotEnabled: false,
				handoffSnapshotLines: 200,
				handoffSnapshotMaxChars: 12000,
				transferLines: 200,
				transferMaxChars: 20000,
				completionNotifyLines: 50,
				completionNotifyMaxChars: 5000,
				handsFreeUpdateMode: "on-quiet",
				handsFreeUpdateInterval: 60000,
				handsFreeQuietThreshold: 8000,
				autoExitGracePeriod: 15000,
				handsFreeUpdateMaxChars: 1500,
				handsFreeMaxTotalChars: 100000,
				minQueryIntervalSeconds: 60,
			})),
		};
	});
	vi.doMock("../overlay-component.js", () => ({
		InteractiveShellOverlay: class MockInteractiveShellOverlay {},
	}));
	vi.doMock("../reattach-overlay.js", () => ({
		ReattachOverlay: class MockReattachOverlay {},
	}));
	vi.doMock("../pty-session.js", () => ({
		PtyTerminalSession: class MockPtyTerminalSession {
			exited = false;
			exitCode: number | null = null;
			signal: number | undefined;
			constructor(options: { command: string }) {
				launchedCommand = options.command;
			}
			addDataListener(_cb: (data: string) => void) { return () => {}; }
			addExitListener(_cb: (exitCode: number | null, signal?: number) => void) { return () => {}; }
			getTailLines() { return { lines: [], totalLinesInBuffer: 0, truncatedByChars: false }; }
			write() {}
			kill() {}
			setEventHandlers() {}
			dispose() {}
			getRawStream() { return ""; }
		},
	}));
	vi.doMock("../headless-monitor.js", () => ({
		HeadlessDispatchMonitor: class MockHeadlessDispatchMonitor {
			disposed = false;
			constructor(
				_session: unknown,
				_config: unknown,
				options: MonitorOptionsCapture,
				_onComplete: (info: unknown) => void,
			) {
				monitorOptions = options;
			}
			getResult() { return undefined; }
			registerCompleteCallback() {}
			dispose() { this.disposed = true; }
		},
	}));
	vi.doMock("../session-manager.js", () => ({
		sessionManager: {
			getActive: vi.fn(() => undefined),
			unregisterActive: vi.fn(),
			registerActive: vi.fn(),
			list: vi.fn(() => []),
			add: vi.fn(() => "monitor-1"),
			take: vi.fn(() => undefined),
			get: vi.fn(() => undefined),
			restore: vi.fn(),
			remove: vi.fn(),
			scheduleCleanup: vi.fn(),
			restartAutoCleanup: vi.fn(),
			killAll: vi.fn(),
			onChange: vi.fn(() => () => {}),
			setActiveUpdateInterval: vi.fn(() => false),
			setActiveQuietThreshold: vi.fn(() => false),
			writeToActive: vi.fn(() => false),
		},
		generateSessionId: vi.fn(() => "monitor-1"),
	}));

	const extensionModule = await import("../index.js");
	extensionModule.default({
		registerShortcut: vi.fn(),
		registerCommand: vi.fn(),
		registerTool: vi.fn((definition: any) => {
			toolDef = definition;
		}),
		on: vi.fn(),
		events: { emit: vi.fn() },
		sendMessage: vi.fn(),
	} as any);

	return {
		toolDef,
		getMonitorOptions: () => monitorOptions,
		getLaunchedCommand: () => launchedCommand,
	};
}

describe("monitor mode", () => {
	afterEach(() => {
		vi.doUnmock("@mariozechner/pi-coding-agent");
		vi.doUnmock("@mariozechner/pi-tui");
		vi.doUnmock("../config.js");
		vi.doUnmock("../overlay-component.js");
		vi.doUnmock("../reattach-overlay.js");
		vi.doUnmock("../pty-session.js");
		vi.doUnmock("../headless-monitor.js");
		vi.doUnmock("../session-manager.js");
	});

	it("requires monitor object when mode is monitor", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			command: "npm test",
			mode: "monitor",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("mode='monitor' requires monitor configuration.");
	});

	it("wires compiled monitor config and callback for monitor mode", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "npm test --watch",
			mode: "monitor",
			monitor: {
				strategy: "stream",
				triggers: [{ id: "error", regex: "/ERROR/i" }],
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(result.details.mode).toBe("monitor");
		expect(result.details.monitor.strategy).toBe("stream");
		expect(harness.getMonitorOptions()?.monitor?.strategy).toBe("stream");
		expect(harness.getMonitorOptions()?.monitor?.triggers[0]?.id).toBe("error");
		expect(typeof harness.getMonitorOptions()?.onMonitorEvent).toBe("function");
	});

	it("rejects legacy monitorFilter usage after hard cutover", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			command: "tail -f logs/dev.log",
			mode: "monitor",
			monitorFilter: "/tmp/log",
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("monitorFilter was removed");
	});

	it("requires target session when querying monitorEvents", async () => {
		const { toolDef } = await setupHarness();
		const result = await toolDef.execute("call-1", {
			monitorEvents: true,
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("monitorEvents requires monitorSessionId");
	});

	it("wraps poll-diff monitor command into a recurring loop", async () => {
		const harness = await setupHarness();
		const result = await harness.toolDef.execute("call-1", {
			command: "echo health",
			mode: "monitor",
			monitor: {
				strategy: "poll-diff",
				triggers: [{ id: "changed", regex: "/./" }],
				poll: { intervalMs: 5000 },
			},
		}, undefined, undefined, {
			hasUI: false,
			cwd: "/tmp/project",
			ui: {},
			sessionManager: { getSessionFile: () => "/tmp/project/session.jsonl" },
		} as any);

		expect(result.isError).not.toBe(true);
		expect(harness.getLaunchedCommand()).toContain("while true; do");
		expect(harness.getLaunchedCommand()).toContain("echo health");
	});
});
