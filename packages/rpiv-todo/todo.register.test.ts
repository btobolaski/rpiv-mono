import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createMockCtx, createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { replayFromBranch } from "./state/replay.js";
import { getState } from "./state/store.js";
import { __resetState, registerTodoTool, setActiveRenderSession, type TaskDetails, TOOL_NAME } from "./todo.js";
import { TODO_HISTORY_ENTRY_TYPE } from "./tool/types.js";

const theme = makeTheme() as unknown as Theme;

function setup() {
	__resetState();
	setActiveRenderSession("test-session");
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { pi, tool, captured };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, createMockCtx() as never);
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

describe("registerTodoTool — registration shape", () => {
	it("registers under the tool name 'todo' with the expected label and guidelines", () => {
		const { captured } = setup();
		const tool = captured.tools.get("todo")!;
		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.promptSnippet).toContain("task list");
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect((tool.promptGuidelines as string[]).length).toBeGreaterThan(0);
	});

	it("exposes a typebox parameters schema declaring the six actions", () => {
		const { tool } = setup();
		const raw = JSON.stringify(tool.parameters);
		for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
			expect(raw).toContain(action);
		}
	});
});

describe("registerTodoTool — execute mutates module state", () => {
	it("create → list returns the seeded row", async () => {
		const { tool } = setup();
		const r1 = await call(tool, { action: "create", subject: "first" });
		expect((r1!.details as TaskDetails).action).toBe("create");
		const r2 = await call(tool, { action: "list" });
		expect(r2?.content[0]).toMatchObject({
			text: expect.stringContaining("first"),
		});
	});

	it("clear resets module state and nextId", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		await call(tool, { action: "create", subject: "b" });
		const r = await call(tool, { action: "clear" });
		const d = r?.details as TaskDetails;
		expect(d.tasks).toEqual([]);
		expect(d.nextId).toBe(1);
	});
});

describe("registerTodoTool — history snapshots", () => {
	it("persists and renders details without relying on a tool result or model message", async () => {
		const { pi, tool } = setup();
		const response = await call(tool, {
			action: "create",
			subject: "history task",
			description: "full description",
			metadata: { nested: { value: 1 } },
		});
		expect(pi.appendEntry).toHaveBeenCalledTimes(1);
		expect(pi.appendEntry).toHaveBeenCalledWith(TODO_HISTORY_ENTRY_TYPE, response!.details);
		expect(pi.sendMessage).not.toHaveBeenCalled();
		const [customType, data] = vi.mocked(pi.appendEntry).mock.calls[0];
		const [rendererType, renderer] = vi.mocked(pi.registerEntryRenderer).mock.calls[0];
		expect(rendererType).toBe(customType);
		expect(
			renderer({ data } as never, { expanded: false }, theme)
				?.render(100)
				.join("\n"),
		).toContain("description: full description");

		// Codemode may discard the result; the entry alone restores state.
		__resetState();
		const replayed = replayFromBranch(createMockCtx({ branch: [{ type: "custom", customType, data } as never] }));
		expect(replayed.tasks[0].description).toBe("full description");
		expect(replayed.nextId).toBe(2);
	});

	it("keeps historical cards independent of later updates and argument mutation", async () => {
		const { pi, tool } = setup();
		const params = {
			action: "create",
			subject: "original",
			metadata: { nested: { value: 1 } },
		};
		await call(tool, params);
		const [, snapshot] = vi.mocked(pi.appendEntry).mock.calls[0];
		params.metadata.nested.value = 99;
		await call(tool, { action: "update", id: 1, subject: "renamed" });
		const renderer = vi.mocked(pi.registerEntryRenderer).mock.calls[0][1];
		const text = renderer({ data: snapshot } as never, { expanded: false }, theme)
			?.render(100)
			.join("\n");
		expect(text).toContain("original");
		expect(text).toContain('"value":1');
		expect(text).not.toContain("renamed");
	});

	it("does not commit a mutation if snapshot persistence fails", async () => {
		const { pi, tool } = setup();
		vi.mocked(pi.appendEntry).mockImplementationOnce(() => {
			throw new Error("storage failed");
		});
		await expect(call(tool, { action: "create", subject: "not committed" })).rejects.toThrow("storage failed");
		expect(getState("test-session").tasks).toEqual([]);
	});

	it("declines malformed history entries", () => {
		const { pi } = setup();
		const renderer = vi.mocked(pi.registerEntryRenderer).mock.calls[0][1];
		expect(renderer({ data: null } as never, { expanded: false }, theme)).toBeUndefined();
		expect(
			renderer(
				{
					data: { action: "list", params: {}, tasks: [{ id: 1, subject: 42, status: "pending" }], nextId: 2 },
				} as never,
				{ expanded: false },
				theme,
			),
		).toBeUndefined();
	});
});

describe("registerTodoTool — renderCall", () => {
	it("create action emits 'todo +' and includes the subject", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "create", subject: "hello" } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect(node).toBeInstanceOf(Text);
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("todo ");
		expect(text).toContain("+");
		expect(text).toContain("hello");
	});

	it("update action renders '#id' when the task has not been registered yet", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "update", id: 42 } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("#42");
	});

	it("update action renders the task subject when seeded", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "seeded-subject" });
		const node = tool.renderCall?.(
			{ action: "update", id: 1 } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("seeded-subject");
	});

	it("list action with a status filter renders the humanized status label", () => {
		const { tool } = setup();
		const node = tool.renderCall?.(
			{ action: "list", status: "in_progress" } as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("in progress");
	});

	it("clear action renders only the base prefix + glyph", () => {
		const { tool } = setup();
		const node = tool.renderCall?.({ action: "clear" } as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("∅");
	});
});

describe("registerTodoTool — renderResult", () => {
	it("create renders the new task's status label (pending)", async () => {
		const { tool } = setup();
		const r = await call(tool, { action: "create", subject: "a" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("pending");
		expect((node as unknown as { text: string }).text).toContain("○");
	});

	it("update renders the transitioned status (in progress)", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, {
			action: "update",
			id: 1,
			status: "in_progress",
		});
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("in progress");
		expect(text).toContain("◐");
	});

	it("delete renders the deleted-tombstone label", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "delete", id: 1 });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		const text = (node as unknown as { text: string }).text;
		expect(text).toContain("deleted");
		expect(text).toContain("⊘");
	});

	it("list renders the plain '✓' fallback (no status leakage)", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "list" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});

	it("get renders the plain '✓' fallback", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		const r = await call(tool, { action: "get", id: 1 });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});

	it("clear renders the plain '✓' fallback", async () => {
		const { tool } = setup();
		await call(tool, { action: "clear" });
		const r = await call(tool, { action: "clear" });
		const node = tool.renderResult?.(r as never, {} as never, theme, undefined as never) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});

	it("missing details falls back to plain '✓'", () => {
		const { tool } = setup();
		const node = tool.renderResult?.(
			{ content: [], details: undefined } as never,
			{} as never,
			theme,
			undefined as never,
		) as unknown as Text;
		expect((node as unknown as { text: string }).text).toContain("✓");
	});
});
