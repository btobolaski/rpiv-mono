import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createMockCtx, createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	__resetState,
	getTodos as getSessionTodos,
	registerTodoAddCommand,
	registerTodosCommand,
	registerTodoTool,
	TODO_ADD_COMMAND_NAME,
	TOOL_NAME,
} from "./todo.js";
import type { Task } from "./todo.js";

const getTodos = () => getSessionTodos("test-session");

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	registerTodosCommand(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	const cmd = captured.commands.get("todos");
	if (!cmd) throw new Error("command not registered");
	return { tool, cmd };
}

async function seed(tool: ReturnType<typeof setup>["tool"], actions: Array<Record<string, unknown>>) {
	const ctx = createMockCtx();
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, ctx as never);
	}
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
	vi.restoreAllMocks();
});

describe("/todos command — registration", () => {
	it("registers a command named 'todos' with a description", () => {
		const { cmd } = setup();
		expect(cmd.description).toContain("todos");
	});
});

describe("/todos command — guard branches", () => {
	it("notifies an error when the session has no UI", async () => {
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: false });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
	});

	it("notifies an info message when there are no visible tasks", async () => {
		const { cmd } = setup();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No todos"), "info");
	});

	it("treats all-deleted tasks as empty (info notify, not group render)", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "a" },
			{ action: "update", id: 1, status: "deleted" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("No todos"), "info");
	});
});

describe("/todos command — grouped output", () => {
	function grabOutput(ctx: ExtensionContext): string {
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledTimes(1);
		const [text, level] = notify.mock.calls[0];
		expect(level).toBe("info");
		return text as string;
	}

	it("renders 'Pending' group with ○ glyph and task id", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [{ action: "create", subject: "research" }]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("── Pending ──");
		expect(out).toContain("○ #1 research");
		expect(out).toContain("1 pending");
	});

	it("renders 'In Progress' group with ◐ glyph and activeForm suffix", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "build", activeForm: "Building" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("── In Progress ──");
		expect(out).toContain("◐ #1 build (Building)");
		expect(out).toContain("1 in progress");
	});

	it("renders 'Completed' group with ✓ glyph and 'N/M completed' header", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "ship" },
			{ action: "update", id: 1, status: "completed" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("── Completed ──");
		expect(out).toContain("✓ #1 ship");
		expect(out).toContain("1/1 completed");
	});

	it("emits the header parts in 'completed · in progress · pending' order", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "p" },
			{ action: "create", subject: "ip" },
			{ action: "update", id: 2, status: "in_progress" },
			{ action: "create", subject: "done" },
			{ action: "update", id: 3, status: "completed" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		const header = out.split("\n")[0];
		const iC = header.indexOf("completed");
		const iIP = header.indexOf("in progress");
		const iP = header.indexOf("pending");
		expect(iC).toBeGreaterThanOrEqual(0);
		expect(iIP).toBeGreaterThan(iC);
		expect(iP).toBeGreaterThan(iIP);
	});

	it("appends '⛓ #deps' suffix for tasks with blockedBy", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "base" },
			{ action: "create", subject: "follow-up", blockedBy: [1] },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("⛓ #1");
	});

	it("omits deleted tombstones from the grouped output", async () => {
		const { tool, cmd } = setup();
		await seed(tool, [
			{ action: "create", subject: "keep" },
			{ action: "create", subject: "drop" },
			{ action: "update", id: 2, status: "deleted" },
		]);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const out = grabOutput(ctx);
		expect(out).toContain("keep");
		expect(out).not.toContain("drop");
	});
});

// -------------------------------------------------------------------------
// /todo-add command
// -------------------------------------------------------------------------

function setupTodoAdd(onUpdate?: () => void) {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	registerTodoAddCommand(pi, onUpdate);
	const cmd = captured.commands.get(TODO_ADD_COMMAND_NAME);
	if (!cmd) throw new Error("todo-add command not registered");
	return { cmd, captured };
}

describe("/todo-add command — registration", () => {
	it("registers a command named 'todo-add' with a description", () => {
		const { cmd } = setupTodoAdd();
		expect(cmd.description).toBeTruthy();
	});

	it("registers the literal command name 'todo-add'", () => {
		const { captured } = setupTodoAdd();
		expect(captured.commands.has("todo-add")).toBe(true);
	});
});

describe("/todo-add command — guard branches", () => {
	it("notifies an error when the session has no UI and does not mutate state", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: false });
		await cmd.handler("Buy milk", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("interactive"), "error");
		expect(getTodos()).toHaveLength(0);
	});

	it("notifies an error when the subject is empty and does not mutate state", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Subject"), "error");
		expect(getTodos()).toHaveLength(0);
	});

	it("notifies an error when the subject is whitespace-only and does not mutate state", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("   \t  ", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Subject"), "error");
		expect(getTodos()).toHaveLength(0);
	});
});

describe("/todo-add command — successful create", () => {
	it("creates a task and notifies with the new id and subject", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("Buy milk", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledTimes(1);
		const [msg, level] = notify.mock.calls[0];
		expect(level).toBe("info");
		expect(msg).toContain("Created");
		expect(msg).toContain("#1");
		expect(msg).toContain("Buy milk");
	});

	it("increments nextId so subsequent creates get unique ids", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("task 1", ctx as never);
		await cmd.handler("task 2", ctx as never);
		const todos = getTodos();
		expect(todos).toHaveLength(2);
		expect(todos[0].id).toBe(1);
		expect(todos[1].id).toBe(2);
		expect(todos[0].subject).toBe("task 1");
		expect(todos[1].subject).toBe("task 2");
	});

	it("sets status to pending for the new task", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("Review PR", ctx as never);
		const todos = getTodos();
		expect(todos[0].status).toBe("pending");
	});

	it("notifies with 'pending' in the confirmation message", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("Review PR", ctx as never);
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("(pending)"), "info");
	});

	it("trims surrounding whitespace from the subject and uses trimmed text in notification", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("  Buy milk  ", ctx as never);
		const todos = getTodos();
		expect(todos).toHaveLength(1);
		expect(todos[0].subject).toBe("Buy milk");
		const notify = ctx.ui.notify as ReturnType<typeof vi.fn>;
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("Buy milk"), "info");
		expect(notify.mock.calls[0]?.[0]).not.toContain("  Buy milk  ");
	});
});

describe("/todo-add command — overlay callback", () => {
	it("invokes the onUpdate callback after creating a task", async () => {
		const onUpdate = vi.fn();
		const { cmd } = setupTodoAdd(onUpdate);
		const ctx = createMockCtx({ hasUI: true });
		expect(onUpdate).not.toHaveBeenCalled();
		await cmd.handler("Buy milk", ctx as never);
		expect(onUpdate).toHaveBeenCalledTimes(1);
	});

	it("does not invoke onUpdate when the subject is empty", async () => {
		const onUpdate = vi.fn();
		const { cmd } = setupTodoAdd(onUpdate);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("", ctx as never);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("does not invoke onUpdate when there is no UI", async () => {
		const onUpdate = vi.fn();
		const { cmd } = setupTodoAdd(onUpdate);
		const ctx = createMockCtx({ hasUI: false });
		await cmd.handler("Buy milk", ctx as never);
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("does not throw when onUpdate is undefined (optional callback)", async () => {
		const { cmd } = setupTodoAdd();
		const ctx = createMockCtx({ hasUI: true });
		await expect(cmd.handler("Buy milk", ctx as never)).resolves.not.toThrow();
	});

	it("invokes onUpdate after the created todo is committed to state", async () => {
		let observed: Task[] = [];
		const onUpdate = vi.fn(() => {
			// Read live state at callback time — the overlay does this too.
			observed = [...getTodos()];
		});
		const { cmd } = setupTodoAdd(onUpdate);
		const ctx = createMockCtx({ hasUI: true });
		await cmd.handler("Buy milk", ctx as never);
		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(observed).toHaveLength(1);
		expect(observed[0].subject).toBe("Buy milk");
		expect(observed[0].status).toBe("pending");
	});
});
