import { TASK_ACTIONS, TASK_STATUSES, type TaskDetails, TODO_HISTORY_ENTRY_TYPE } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";

function isTask(value: unknown): boolean {
	if (!value || typeof value !== "object") return false;
	const task = value as Record<string, unknown>;
	return (
		typeof task.id === "number" &&
		Number.isFinite(task.id) &&
		typeof task.subject === "string" &&
		typeof task.status === "string" &&
		Object.hasOwn(TASK_STATUSES, task.status) &&
		["description", "activeForm", "owner"].every(
			(field) => task[field] === undefined || typeof task[field] === "string",
		) &&
		(task.blockedBy === undefined ||
			(Array.isArray(task.blockedBy) &&
				task.blockedBy.every((id) => typeof id === "number" && Number.isFinite(id)))) &&
		(task.metadata === undefined ||
			(task.metadata !== null && typeof task.metadata === "object" && !Array.isArray(task.metadata)))
	);
}

/** Reject corrupt envelopes before their fields reach replay or renderers. */
export function isTaskDetails(value: unknown): value is TaskDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.action === "string" &&
		Object.hasOwn(TASK_ACTIONS, v.action) &&
		v.params !== null &&
		typeof v.params === "object" &&
		!Array.isArray(v.params) &&
		typeof v.nextId === "number" &&
		Number.isFinite(v.nextId) &&
		Array.isArray(v.tasks) &&
		v.tasks.every(isTask) &&
		(v.error === undefined || typeof v.error === "string")
	);
}

/**
 * Replay the latest UI-only snapshot, including codemode-nested calls. Legacy
 * sessions fall back to the latest todo tool result. Once a snapshot exists,
 * tool results cannot overwrite it: a parallel direct result may arrive after
 * a newer nested mutation. When neither exists, returns `EMPTY_STATE`.
 *
 * Pure of module state — `index.ts` writes the returned snapshot into the
 * store after this returns. The function explicitly does NOT touch the store
 * cell.
 */
export function replayFromBranch(ctx: { sessionManager: { getBranch(): Iterable<unknown> } }): TaskState {
	let result: TaskState = {
		tasks: [...EMPTY_STATE.tasks],
		nextId: EMPTY_STATE.nextId,
	};
	// ponytail: retain legacy fallback until no supported saved sessions predate custom snapshots.
	let hasSnapshot = false;
	for (const entry of ctx.sessionManager.getBranch()) {
		const e = entry as {
			type?: string;
			customType?: string;
			data?: unknown;
			message?: { role?: string; toolName?: string; details?: unknown };
		};
		let details: unknown;
		if (e.type === "custom" && e.customType === TODO_HISTORY_ENTRY_TYPE && isTaskDetails(e.data)) {
			details = e.data;
			hasSnapshot = true;
		} else if (
			!hasSnapshot &&
			e.type === "message" &&
			e.message?.role === "toolResult" &&
			e.message.toolName === "todo"
		) {
			details = e.message.details;
		}
		if (!isTaskDetails(details)) continue;
		result = {
			tasks: details.tasks.map((t) => ({ ...t })),
			nextId: details.nextId,
		};
	}
	return result;
}
