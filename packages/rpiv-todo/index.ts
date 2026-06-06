/**
 * rpiv-todo — Pi extension. Registers the `todo` tool, `/todos` and
 * `/todo-add` slash commands, and the persistent TodoOverlay widget.
 *
 * TUI chrome strings localize at render time via the i18n bridge. Strings are
 * registered with rpiv-i18n here, once, at module init — but only when the
 * SDK is actually installed. If `@juicesharp/rpiv-i18n` is missing (standalone
 * install of just this package), the dynamic-load shim no-ops and the bridge's
 * `t(key, fallback)` returns the inline English literal at every call site.
 * The extension stays online either way.
 *
 * Adding a locale: drop `locales/<code>.json` next to en.json (mirroring the
 * key set). No edit needed here — `registerLocalesFromDir` iterates
 * `SUPPORTED_LOCALES` from the SDK. See `@juicesharp/rpiv-i18n` README →
 * "Contributing translations" for the full convention.
 *
 * Extracted from rpiv-pi@7525a5d. Tool name "todo" and widget key
 * "rpiv-todos" preserved verbatim so existing session history replays
 * correctly after upgrade.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { I18N_NAMESPACE } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { selectTodoCounts } from "./state/selectors.js";
import { getState, replaceState } from "./state/store.js";
import { registerTodoAddCommand, registerTodosCommand, registerTodoTool, TOOL_NAME } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

type I18nLoader = {
	registerLocalesFromDir: (namespace: string, packageUrl: string, options?: { label?: string }) => void;
};

// Dynamic import keeps `@juicesharp/rpiv-i18n` a soft optional peer: when the
// SDK is installed alongside this package the strings register and
// `/languages` flips them live; when it isn't, the import rejects here, we
// no-op, and the bridge's English-fallback shim keeps the extension online.
//
// The `/loader` subpath is used instead of the SDK entry so the i18n-ui +
// pi-tui modules are not pulled into our load graph just to register strings.
try {
	const sdk = (await import("@juicesharp/rpiv-i18n/loader")) as I18nLoader;
	sdk.registerLocalesFromDir(I18N_NAMESPACE, import.meta.url, { label: "rpiv-todo" });
} catch {
	// SDK absent — extension still loads with English-only UI.
}

// pi-core's ExtensionRunner throws this exact phrase from an invalidated ctx
// proxy after session replacement/reload. Match the stable substring so genuine
// replay bugs still propagate instead of being silently swallowed.
function isStaleCtxError(e: unknown): boolean {
	return /stale after session replacement/.test(String(e));
}

export default function (pi: ExtensionAPI) {
	// Todo overlay widget — constructed lazily at the first session_start with UI.
	let todoOverlay: TodoOverlay | undefined;

	registerTodoTool(pi);
	registerTodosCommand(pi);
	registerTodoAddCommand(pi, () => todoOverlay?.update());

	pi.on("session_start", async (_event, ctx) => {
		replaceState(replayFromBranch(ctx));
		if (ctx.hasUI) {
			todoOverlay ??= new TodoOverlay();
			todoOverlay.setUICtx(ctx.ui);
			todoOverlay.resetCompletedDisplayState();
			todoOverlay.update();
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		// Auto-compaction races session disposal: pi-core invalidates the
		// extension runner while still emitting session_compact, so `ctx` may be
		// a dead proxy whose getters throw the stale error. The compacting session
		// is being discarded — the replacement session's session_start replays
		// state — so keep current state on a stale ctx. Other errors are real
		// replay bugs and must propagate.
		try {
			replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_tree", async (_event, ctx) => {
		try {
			replaceState(replayFromBranch(ctx));
		} catch (e) {
			if (!isStaleCtxError(e)) throw e;
		}
		todoOverlay?.resetCompletedDisplayState();
		todoOverlay?.update();
	});

	pi.on("session_shutdown", async () => {
		todoOverlay?.dispose();
		todoOverlay = undefined;
	});

	// Reads getTodos() at render time; do NOT call replayFromBranch here
	// (branch is stale — message_end runs after tool_execution_end).
	pi.on("tool_execution_end", async (event) => {
		if (event.toolName !== TOOL_NAME || event.isError) return;
		todoOverlay?.update();
	});

	pi.on("agent_start", async () => {
		todoOverlay?.hideCompletedTasksFromPreviousTurn();
	});

	pi.on("agent_end", async (event) => {
		// The agent core awaits agent_end handlers before transitioning to
		// idle, so sendUserMessage must be deferred — calling it inline
		// while isStreaming is still true will throw.
		const lastAssistant = [...event.messages].reverse().find(
			(m) => "role" in m && (m as { role: string }).role === "assistant",
		) as { stopReason?: string } | undefined;
		if (!lastAssistant || lastAssistant.stopReason !== "stop") return;

		const counts = selectTodoCounts(getState());
		if (counts.pending === 0 && counts.inProgress === 0) return;

		setTimeout(() => {
			pi.sendUserMessage(
				"You have unfinished todos, you must continue until you have completed your task. If you need to ask the user a question, you must use the ask_user tool",
			);
		}, 0);
	});
}
