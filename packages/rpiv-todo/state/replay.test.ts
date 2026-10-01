import { buildSessionEntries, createMockCtx, makeTodoToolResult, makeUserMessage } from "@juicesharp/rpiv-test-utils";
import { describe, expect, it } from "vitest";
import { type Task, type TaskDetails, TODO_HISTORY_ENTRY_TYPE } from "../tool/types.js";
import { isTaskDetails, replayFromBranch } from "./replay.js";

function buildBranch(snapshots: TaskDetails[]) {
	const messages = snapshots.map((s) => makeTodoToolResult(s));
	return buildSessionEntries([makeUserMessage("hi"), ...messages]);
}

const taskFixture = (id: number, subject: string, extra: Partial<Task> = {}): Task => ({
	id,
	subject,
	status: "pending",
	...extra,
});

describe("isTaskDetails — defensive type guard", () => {
	it("rejects null and undefined", () => {
		expect(isTaskDetails(null)).toBe(false);
		expect(isTaskDetails(undefined)).toBe(false);
	});

	it("rejects primitives (string, number, boolean)", () => {
		expect(isTaskDetails("oops")).toBe(false);
		expect(isTaskDetails(42)).toBe(false);
		expect(isTaskDetails(true)).toBe(false);
	});

	it("rejects objects missing tasks[] or nextId", () => {
		expect(isTaskDetails({})).toBe(false);
		expect(isTaskDetails({ tasks: "x", nextId: 1 })).toBe(false);
		expect(isTaskDetails({ tasks: [], nextId: "1" })).toBe(false);
	});

	it("accepts well-formed snapshot envelopes", () => {
		expect(isTaskDetails({ tasks: [], nextId: 1 })).toBe(false);
		expect(isTaskDetails({ action: "create", params: {}, tasks: [], nextId: 1 })).toBe(true);
	});

	it("rejects corrupt task fields and malformed renderer envelopes", () => {
		const envelope = { action: "list", params: {}, tasks: [taskFixture(1, "valid")], nextId: 2 };
		for (const corrupt of [
			{ id: "1" },
			{ status: "__proto__" },
			{ status: {} },
			{ subject: 42 },
			{ blockedBy: ["2"] },
			{ description: 42 },
			{ activeForm: [] },
			{ owner: null },
			{ metadata: [] },
		]) {
			expect(isTaskDetails({ ...envelope, tasks: [{ ...envelope.tasks[0], ...corrupt }] })).toBe(false);
		}
		for (const invalid of [null, {}]) expect(isTaskDetails({ ...envelope, tasks: [invalid] })).toBe(false);
		for (const override of [{ action: "constructor" }, { params: null }, { nextId: Number.NaN }, { error: 42 }]) {
			expect(isTaskDetails({ ...envelope, ...override })).toBe(false);
		}
	});
});

describe("replayFromBranch — history snapshots", () => {
	const snapshot = (tasks: Task[], nextId: number) => ({
		type: "custom",
		customType: TODO_HISTORY_ENTRY_TYPE,
		data: { action: "list", params: {}, tasks, nextId },
	});

	it("uses the newest snapshot even if an older direct tool result arrives later", () => {
		const branch = [
			...buildBranch([
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "legacy")],
					nextId: 2,
				},
			]),
			snapshot([taskFixture(1, "direct")], 2),
			snapshot([taskFixture(1, "direct"), taskFixture(2, "nested", { description: "codemode detail" })], 3),
			...buildBranch([
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "direct")],
					nextId: 2,
				},
			]),
		];
		const state = replayFromBranch(createMockCtx({ branch: branch as never }));
		expect(state.tasks.map((task) => task.subject)).toEqual(["direct", "nested"]);
		expect(state.tasks[1].description).toBe("codemode detail");
		expect(state.nextId).toBe(3);
	});

	it("replays a clear snapshot and its reset id counter", () => {
		const state = replayFromBranch(
			createMockCtx({
				branch: [snapshot([taskFixture(1, "nested")], 2), snapshot([], 1)] as never,
			}),
		);
		expect(state).toEqual({ tasks: [], nextId: 1 });
	});

	it("ignores unrelated or malformed entries without losing the legacy fallback", () => {
		const state = replayFromBranch(
			createMockCtx({
				branch: [
					...buildBranch([
						{
							action: "create",
							params: {},
							tasks: [taskFixture(1, "legacy")],
							nextId: 2,
						},
					]),
					{ ...snapshot([], 1), customType: "other-extension" },
					{
						type: "custom",
						customType: TODO_HISTORY_ENTRY_TYPE,
						data: { action: "list", params: {}, tasks: [{ id: 1, subject: 42, status: "pending" }], nextId: 99 },
					},
					{
						type: "custom",
						customType: TODO_HISTORY_ENTRY_TYPE,
						data: { tasks: "corrupt", nextId: 99 },
					},
				] as never,
			}),
		);
		expect(state.tasks[0].subject).toBe("legacy");
		expect(state.nextId).toBe(2);
	});
});

describe("replayFromBranch", () => {
	it("returns empty TaskState when branch has no todo toolResults", () => {
		const ctx = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("hi")]),
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toEqual([]);
		expect(state.nextId).toBe(1);
	});

	it("replays the last snapshot (last-write-wins)", () => {
		const ctx = createMockCtx({
			branch: buildBranch([
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "old")],
					nextId: 2,
				},
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "old"), taskFixture(2, "new")],
					nextId: 3,
				},
			]),
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(2);
		expect(state.nextId).toBe(3);
	});

	it("clones tasks so mutating the fixture does not mutate replayed state", () => {
		const fixture: Task = taskFixture(1, "original");
		const ctx = createMockCtx({
			branch: buildBranch([{ action: "create", params: {}, tasks: [fixture], nextId: 2 }]),
		});
		const state = replayFromBranch(ctx);
		const replayed = state.tasks[0];
		expect(replayed).not.toBe(fixture);
		expect(replayed.subject).toBe("original");
	});

	it("skips non-message entries in the branch (defensive type guard)", () => {
		const ctx = createMockCtx({
			branch: [
				{ type: "tool_call", call: { id: "x" } } as never,
				...buildBranch([
					{
						action: "create",
						params: {},
						tasks: [taskFixture(1, "kept")],
						nextId: 2,
					},
				]),
			] as never,
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("kept");
		expect(state.nextId).toBe(2);
	});

	it("skips toolResult entries whose details fail isTaskDetails (corrupt-snapshot guard)", () => {
		// Construct a toolResult with toolName=todo but malformed details — must be ignored.
		const corrupt = {
			type: "message" as const,
			message: {
				role: "toolResult",
				toolName: "todo",
				details: { tasks: "not-an-array" },
			},
		};
		const ctx = createMockCtx({
			branch: [
				...buildBranch([
					{
						action: "create",
						params: {},
						tasks: [taskFixture(1, "good")],
						nextId: 2,
					},
				]),
				corrupt as never,
			] as never,
		});
		const state = replayFromBranch(ctx);
		expect(state.tasks).toHaveLength(1);
		expect(state.tasks[0]?.subject).toBe("good");
	});

	it("returns a fresh empty TaskState when called with an empty branch", () => {
		const ctx1 = createMockCtx({
			branch: buildBranch([
				{
					action: "create",
					params: {},
					tasks: [taskFixture(1, "x")],
					nextId: 2,
				},
			]),
		});
		expect(replayFromBranch(ctx1).nextId).toBe(2);

		const ctx2 = createMockCtx({
			branch: buildSessionEntries([makeUserMessage("hi")]),
		});
		const fresh = replayFromBranch(ctx2);
		expect(fresh.tasks).toEqual([]);
		expect(fresh.nextId).toBe(1);
	});
});
