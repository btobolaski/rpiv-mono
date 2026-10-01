import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { makeTheme } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import type { Task, TaskDetails } from "../tool/types.js";
import { formatOverlayTaskLine, renderTodoHistory } from "./format.js";

const recordingTheme = makeTheme({
	fg: (color, text) => `<${color}>${text}</${color}>`,
	strikethrough: (text) => `<strike>${text}</strike>`,
}) as unknown as Theme;

function task(overrides: Partial<Task> = {}): Task {
	return {
		id: 1,
		subject: "quiet task",
		status: "pending",
		...overrides,
	};
}

function history(overrides: Partial<TaskDetails> = {}): TaskDetails {
	return {
		action: "get",
		params: { id: 1 },
		tasks: [task()],
		nextId: 2,
		...overrides,
	};
}

const plainTheme = makeTheme() as Theme;
const renderHistory = (overrides: Partial<TaskDetails> = {}, width = 100) =>
	renderTodoHistory(history(overrides), plainTheme).render(width).join("\n");

describe("renderTodoHistory", () => {
	it("shows every field and both dependency directions without expansion", () => {
		const text = renderHistory(
			{
				tasks: [
					task({
						description: "Explain the work",
						activeForm: "Doing the work",
						owner: "worker",
						blockedBy: [2],
						metadata: { url: "https://example.test", nested: { value: true } },
					}),
					task({ id: 2, subject: "dependency" }),
					task({ id: 3, subject: "dependent", blockedBy: [1] }),
				],
			},
			200,
		);
		for (const field of [
			"#1 [pending] quiet task",
			"description: Explain the work",
			"activeForm: Doing the work",
			"owner: worker",
			"blockedBy: #2",
			"blocks: #3",
			'metadata: {"url":"https://example.test","nested":{"value":true}}',
		]) {
			expect(text).toContain(field);
		}
		expect(text).not.toContain("#2 [pending] dependency");
	});

	it.each(["create", "get", "delete"] as const)("shows only the affected task for %s", (action) => {
		const text = renderHistory({
			action,
			params: { id: 2 },
			tasks: [
				task({ subject: "unrelated" }),
				task({
					id: 2,
					subject: "affected",
					description: "shown",
					status: action === "delete" ? "deleted" : "pending",
				}),
			],
		});
		expect(text).toContain("#2");
		expect(text).toContain("affected");
		expect(text).toContain("description: shown");
		expect(text).not.toContain("unrelated");
	});

	it("respects list status and tombstone filters", () => {
		const tasks = [
			task(),
			task({ id: 2, subject: "removed", status: "deleted" }),
			task({ id: 3, subject: "finished", status: "completed" }),
		];
		const render = (params: TaskDetails["params"]) => renderHistory({ action: "list", tasks, params });
		expect(render({})).toContain("finished");
		expect(render({})).not.toContain("removed");
		expect(render({ includeDeleted: true })).toContain("removed");
		expect(render({ status: "completed" })).not.toContain("quiet task");
		expect(render({ status: "deleted" })).toContain("No tasks");
		expect(render({ status: "deleted", includeDeleted: true })).toContain("removed");
	});

	it("reports clear, empty lists and errors without rendering task details", () => {
		expect(renderHistory({ action: "clear", tasks: [] })).toContain("Cleared all tasks");
		expect(renderHistory({ action: "list", tasks: [] })).toContain("No tasks");
		const error = renderHistory({ error: "#9 not found" });
		expect(error).toContain("Error: #9 not found");
		expect(error).not.toContain("quiet task");
	});

	it.each([16, 40, 100])("wraps complete long Unicode descriptions at width %i", (width) => {
		const description = `Long description 测试 ${"detail ".repeat(200)}END`;
		const card = renderTodoHistory(history({ tasks: [task({ description })] }), plainTheme);
		const lines = card.render(width);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		expect(lines.join("\n")).toContain("END");
	});

	it("shows all matching tasks rather than applying the overlay row budget", () => {
		const tasks = Array.from({ length: 20 }, (_, i) =>
			task({ id: i + 1, subject: `task ${i + 1}`, description: `description ${i + 1}` }),
		);
		expect(renderHistory({ action: "list", params: {}, tasks })).toContain("description: description 20");
	});

	it("sanitizes terminal escapes and bidi controls in every displayed string", () => {
		const unsafe = "safe\u001b[2J\u001b]0;hidden\u0007\u202etest";
		const text = renderHistory(
			{
				tasks: [
					task({
						subject: unsafe,
						description: unsafe,
						activeForm: unsafe,
						owner: unsafe,
						metadata: { value: unsafe },
					}),
				],
			},
			200,
		);
		expect(text).toContain("description: safetest");
		expect(text).toContain("activeForm: safetest");
		expect(text).toContain("owner: safetest");
		expect(text).not.toMatch(/[\u001b\u202e]/);
	});
});

describe("formatOverlayTaskLine — semantic color hierarchy", () => {
	it("keeps pending subjects primary while rendering IDs quietly", () => {
		expect(formatOverlayTaskLine(task(), recordingTheme, true)).toBe(
			"<dim>○</dim> <dim>#1</dim> <text>quiet task</text>",
		);
	});

	it("emphasizes the current task while muting its supporting metadata", () => {
		expect(
			formatOverlayTaskLine(
				task({
					status: "in_progress",
					activeForm: "Working",
					blockedBy: [2, 3],
				}),
				recordingTheme,
				true,
			),
		).toBe(
			"<warning>◐</warning> <dim>#1</dim> <accent>quiet task</accent> <muted>(Working)</muted> <muted>⛓ #2,#3</muted>",
		);
	});

	it("mutes and strikes completed subjects", () => {
		expect(formatOverlayTaskLine(task({ status: "completed" }), recordingTheme, false)).toBe(
			"<success>✓</success> <strike><muted>quiet task</muted></strike>",
		);
	});
});

describe("formatOverlayTaskLine — terminal control characters", () => {
	it("strips escape sequences from subject and activeForm before theming", () => {
		expect(
			formatOverlayTaskLine(
				task({
					status: "in_progress",
					subject: "quiet\u001b[2Jtask",
					activeForm: "Work\u009bcing",
				}),
				recordingTheme,
				false,
			),
		).toBe("<warning>◐</warning> <accent>quiettask</accent> <muted>(Working)</muted>");
	});
});
