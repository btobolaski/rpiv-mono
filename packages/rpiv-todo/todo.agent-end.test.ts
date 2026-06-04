import { createMockPi } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import registerTodo from "./index.js";
import { replaceState } from "./state/store.js";
import { __resetState } from "./todo.js";

const CONTINUATION =
	"You have unfinished todos, you must continue until you have completed your task. If you need to ask the user a question, you must use the ask_user tool";

function assistant(stopReason?: string) {
	return {
		role: "assistant",
		content: [] as { type: string; text: string }[],
		...(stopReason === undefined ? {} : { stopReason }),
	};
}

function userMessage() {
	return { role: "user", content: [{ type: "text" as const, text: "hi" }] };
}

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodo(pi);

	const handler = captured.events.get("agent_end")?.[0];
	if (!handler) throw new Error("agent_end handler not registered");

	return { pi, handler };
}

beforeEach(() => {
	__resetState();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	__resetState();
});

describe("agent_end — unfinished todo continuation", () => {
	it.each(["pending", "in_progress"] as const)(
		"sends continuation on model stop when a todo is %s",
		async (status) => {
			const { pi, handler } = setup();
			replaceState({
				tasks: [{ id: 1, subject: "finish work", status }],
				nextId: 2,
			});

			await handler({ messages: [assistant("stop")] } as never);

			expect(pi.sendUserMessage).not.toHaveBeenCalled();
			vi.advanceTimersByTime(0);
			expect(pi.sendUserMessage).toHaveBeenCalledWith(CONTINUATION);
		},
	);

	it("does not send when there are no unfinished todos", async () => {
		const { pi, handler } = setup();
		replaceState({
			tasks: [{ id: 1, subject: "done", status: "completed" }],
			nextId: 2,
		});

		await handler({ messages: [assistant("stop")] } as never);

		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not send when only deleted todos remain", async () => {
		const { pi, handler } = setup();
		replaceState({
			tasks: [{ id: 1, subject: "removed", status: "deleted" }],
			nextId: 2,
		});

		await handler({ messages: [assistant("stop")] } as never);

		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not send when there are no todos at all", async () => {
		const { pi, handler } = setup();

		await handler({ messages: [assistant("stop")] } as never);

		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it.each(["aborted", "length", "toolUse", "error", undefined] as const)(
		"does not send continuation for stopReason=%s",
		async (stopReason) => {
			const { pi, handler } = setup();
			replaceState({
				tasks: [{ id: 1, subject: "unfinished", status: "pending" }],
				nextId: 2,
			});

			await handler({ messages: [assistant(stopReason)] } as never);

			vi.advanceTimersByTime(0);
			expect(pi.sendUserMessage).not.toHaveBeenCalled();
		},
	);

	it("uses the last assistant message — suppresses when last is non-stop", async () => {
		const { pi, handler } = setup();
		replaceState({
			tasks: [{ id: 1, subject: "unfinished", status: "pending" }],
			nextId: 2,
		});

		// Latest assistant is "aborted", earlier assistant is "stop".
		// The handler must pick the latest → should not send continuation.
		await handler({
			messages: [assistant("stop"), userMessage(), assistant("aborted")],
		} as never);

		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("uses the last assistant message — continues when last is stop", async () => {
		const { pi, handler } = setup();
		replaceState({
			tasks: [{ id: 1, subject: "unfinished", status: "pending" }],
			nextId: 2,
		});

		// Latest assistant is "stop", earlier assistant is "aborted".
		// The handler must pick the latest → should send continuation.
		await handler({
			messages: [assistant("aborted"), userMessage(), assistant("stop")],
		} as never);

		expect(pi.sendUserMessage).not.toHaveBeenCalled();
		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).toHaveBeenCalledWith(CONTINUATION);
	});

	it("does not send when messages array is empty", async () => {
		const { pi, handler } = setup();
		replaceState({
			tasks: [{ id: 1, subject: "unfinished", status: "pending" }],
			nextId: 2,
		});

		await handler({ messages: [] } as never);

		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});

	it("does not send when messages has no assistant role entries", async () => {
		const { pi, handler } = setup();
		replaceState({
			tasks: [{ id: 1, subject: "unfinished", status: "pending" }],
			nextId: 2,
		});

		await handler({ messages: [userMessage()] } as never);

		vi.advanceTimersByTime(0);
		expect(pi.sendUserMessage).not.toHaveBeenCalled();
	});
});
