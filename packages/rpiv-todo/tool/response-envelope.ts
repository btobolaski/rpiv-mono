import { selectListTasks } from "../state/selectors.js";
import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { deriveBlocks } from "../state/task-graph.js";
import { sanitizeTerminalText } from "./sanitize.js";
import type { Task, TaskAction, TaskDetails, TaskMutationParams } from "./types.js";

/**
 * Format a single task as a `[status] #id subject [(activeForm)] [⛓ #dep,…]`
 * line. Used by the `list` content branch only — the overlay and `/todos`
 * formatting paths use `view/format.ts` for richer presentations.
 */
function formatListLine(t: Task): string {
	const block = t.blockedBy?.length ? ` ⛓ ${t.blockedBy.map((id) => `#${id}`).join(",")}` : "";
	const form = t.status === "in_progress" && t.activeForm ? ` (${sanitizeTerminalText(t.activeForm)})` : "";
	return `[${t.status}] #${t.id} ${sanitizeTerminalText(t.subject)}${form}${block}`;
}

/**
 * Shared detail rows for `get` output and history cards. Order is pinned by
 * pre-refactor `todo.ts:354-376`; callers add headers and card-only metadata.
 */
export function formatTaskDetailLines(task: Task, blocks: readonly number[]): string[] {
	const lines: string[] = [];
	if (task.description) lines.push(`  description: ${sanitizeTerminalText(task.description)}`);
	if (task.activeForm) lines.push(`  activeForm: ${sanitizeTerminalText(task.activeForm)}`);
	if (task.blockedBy?.length) {
		lines.push(`  blockedBy: ${task.blockedBy.map((id) => `#${id}`).join(", ")}`);
	}
	if (blocks.length) {
		lines.push(`  blocks: ${blocks.map((id) => `#${id}`).join(", ")}`);
	}
	if (task.owner) lines.push(`  owner: ${sanitizeTerminalText(task.owner)}`);
	return lines;
}

function formatGetLines(task: Task, state: TaskState): string {
	return [
		`#${task.id} [${task.status}] ${sanitizeTerminalText(task.subject)}`,
		...formatTaskDetailLines(task, deriveBlocks(state.tasks).get(task.id) ?? []),
	].join("\n");
}

/**
 * Pure formatter: `(op, state) → string`. Closed switch on `op.kind` —
 * adding a new `Op` variant fails to compile here until a branch is added.
 * The strings on each branch are byte-equivalent to pre-refactor `todo.ts`
 * reducer output.
 */
export function formatContent(op: Op, state: TaskState): string {
	switch (op.kind) {
		case "create": {
			const t = state.tasks.find((x) => x.id === op.taskId);
			// Defensive — `op.taskId` always resolves on success path.
			if (!t) return `Created #${op.taskId}`;
			return `Created #${t.id}: ${sanitizeTerminalText(t.subject)} (pending)`;
		}
		case "update": {
			if (!op.changed) {
				return `No change: #${op.id} already matches the requested values (status: ${op.toStatus})`;
			}
			const transition = op.fromStatus !== op.toStatus ? ` (${op.fromStatus} → ${op.toStatus})` : "";
			return `Updated #${op.id}${transition}`;
		}
		case "delete":
			return `Deleted #${op.id}: ${sanitizeTerminalText(op.subject)}`;
		case "clear":
			return `Cleared ${op.count} tasks`;
		case "list": {
			const view = selectListTasks(state, op.includeDeleted, op.statusFilter);
			return view.length === 0 ? "No tasks" : view.map(formatListLine).join("\n");
		}
		case "get":
			return formatGetLines(op.task, state);
		case "error":
			return `Error: ${op.message}`;
	}
}

/**
 * Build the LLM-facing tool envelope from the reducer's new state. The caller
 * persists the snapshot before committing live state. `details` is the replay snapshot —
 * `state/replay.ts` consumes this exact shape on session lifecycle events.
 *
 * Mirrors `packages/rpiv-ask-user-question/tool/response-envelope.ts:13-47`.
 */
export function buildToolResult(
	action: TaskAction,
	params: TaskMutationParams,
	state: TaskState,
	op: Op,
): { content: Array<{ type: "text"; text: string }>; details: TaskDetails } {
	const text = formatContent(op, state);
	const details: TaskDetails = {
		action,
		params: params as Record<string, unknown>,
		tasks: state.tasks,
		nextId: state.nextId,
		...(op.kind === "error" ? { error: op.message } : {}),
	};
	return { content: [{ type: "text", text }], details };
}
