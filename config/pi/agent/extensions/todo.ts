/**
 * Todo Extension - 动态任务清单（基于官方 examples/extensions/todo.ts 增强）
 *
 * 与官方示例的差异：
 * - 状态为三态：pending / in_progress / done（标注进度而不只是完成与否）
 * - 新增 update（修改条目文字）与 remove（删除过时条目）动作，
 *   todo list 是「活计划」，随任务进展和新发现动态增改
 * - promptGuidelines 限定：仅复杂多步任务使用，简单任务不建 todo
 *
 * 状态存储在 tool result details 里（会话条目），分支/回溯时自动正确。
 * /todos 命令查看清单；编辑器下方常驻 widget 实时跟随更新（仅 TUI）。
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

type TodoStatus = "pending" | "in_progress" | "done";

interface Todo {
	id: number;
	text: string;
	status: TodoStatus;
}

interface TodoDetails {
	action: "list" | "add" | "update" | "set" | "remove" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "update", "set", "remove", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add/update)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for update/set/remove)" })),
	status: Type.Optional(StringEnum(["pending", "in_progress", "done"] as const, {
		description: "New status (for set)",
	})),
});

function err(details: Omit<TodoDetails, "error">, message: string) {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		details: { ...details, error: message } as TodoDetails,
	};
}

/**
 * UI component for the /todos command
 */
class TodoListComponent {
	private todos: Todo[];
	private theme: Theme;
	private onClose: () => void;
	private cachedWidth?: number;
	private cachedLines?: string[];

	constructor(todos: Todo[], theme: Theme, onClose: () => void) {
		this.todos = todos;
		this.theme = theme;
		this.onClose = onClose;
	}

	handleInput(data: string): void {
		if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c")) {
			this.onClose();
		}
	}

	render(width: number): string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const lines: string[] = [];
		const th = this.theme;

		lines.push("");
		const title = th.fg("accent", " Todos ");
		const headerLine =
			th.fg("borderMuted", "─".repeat(3)) + title + th.fg("borderMuted", "─".repeat(Math.max(0, width - 10)));
		lines.push(truncateToWidth(headerLine, width));
		lines.push("");

		if (this.todos.length === 0) {
			lines.push(truncateToWidth(`  ${th.fg("dim", "No todos. Complex tasks will create some automatically.")}`, width));
		} else {
			const done = this.todos.filter((t) => t.status === "done").length;
			lines.push(truncateToWidth(`  ${th.fg("muted", `${done}/${this.todos.length} completed`)}`, width));
			lines.push("");

			for (const todo of this.todos) {
				const check =
					todo.status === "done"
						? th.fg("success", "✓")
						: todo.status === "in_progress"
							? th.fg("warning", "▶")
							: th.fg("dim", "○");
				const id = th.fg("accent", `#${todo.id}`);
				const text = todo.status === "done" ? th.fg("dim", todo.text) : th.fg("text", todo.text);
				lines.push(truncateToWidth(`  ${check} ${id} ${text}`, width));
			}
		}

		lines.push("");
		lines.push(truncateToWidth(`  ${th.fg("dim", "Press Escape to close")}`, width));
		lines.push("");

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

const WIDGET_KEY = "todo-list";
const WIDGET_MAX_ITEMS = 6;

export default function (pi: ExtensionAPI) {
	// In-memory state (reconstructed from session on load)
	let todos: Todo[] = [];
	let nextId = 1;

	/** 常驻底部 widget：跟随 todos 实时刷新，空清单时隐藏 */
	const refreshWidget = (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (todos.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const th = ctx.ui.theme;
		const done = todos.filter((t) => t.status === "done").length;
		const lines: string[] = [
			th.fg("borderMuted", "─ ") +
				th.fg("accent", `Todos ${done}/${todos.length}`) +
				" " +
				th.fg("borderMuted", "─".repeat(40)),
		];
		const display = todos.slice(0, WIDGET_MAX_ITEMS);
		for (const t of display) {
			const check =
				t.status === "done" ? th.fg("success", "✓") : t.status === "in_progress" ? th.fg("warning", "▶") : th.fg("dim", "○");
			const id = th.fg("accent", `#${t.id}`);
			const text = t.status === "done" ? th.fg("dim", t.text) : th.fg("text", t.text);
			lines.push(`${check} ${id} ${text}`);
		}
		if (todos.length > WIDGET_MAX_ITEMS) {
			lines.push(th.fg("dim", `… 还有 ${todos.length - WIDGET_MAX_ITEMS} 项 (/todos 查看全部)`));
		}
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: "belowEditor" });
	};

	/**
	 * Reconstruct state from session entries.
	 * Scans tool results for this tool and applies them in order.
	 */
	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;

		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;

			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		reconstructState(ctx);
		refreshWidget(ctx);
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a living todo list for complex multi-step tasks. Actions: list, add (text), update (id, text), set (id, status), remove (id), clear",
		promptSnippet: "Track progress on complex tasks with a dynamic todo list",
		promptGuidelines: [
			"Use the todo tool ONLY for complex multi-step tasks (roughly 3+ distinct steps, or multi-file changes, investigations, migrations). Do NOT create todos for simple one-shot requests.",
			"The todo list is a living plan, not a fixed upfront contract: add new todos as soon as new work is discovered, use update to revise an item's wording or scope when understanding changes, and remove items that become obsolete.",
			"Mark an item in_progress when you start it and done immediately when it is finished. Keep at most one item in_progress at a time. When all items are done, stop touching the list.",
		],
		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const snapshot = () => ({ todos: todos.map((t) => ({ ...t })), nextId });
			const finish = (result: { content: { type: "text"; text: string }[]; details: TodoDetails }) => {
				refreshWidget(ctx);
				return result;
			};

			switch (params.action) {
				case "list":
					return finish({
						content: [
							{
								type: "text" as const,
								text: todos.length
									? todos.map((t) => `[${t.status === "done" ? "x" : t.status === "in_progress" ? ">" : " "}] #${t.id}: ${t.text}`).join("\n")
									: "No todos",
							},
						],
						details: { action: "list", ...snapshot() } as TodoDetails,
					});

				case "add": {
					if (!params.text) return finish(err({ action: "add", ...snapshot() }, "text required for add"));
					const todo: Todo = { id: nextId++, text: params.text, status: "pending" };
					todos.push(todo);
					return finish({
						content: [{ type: "text" as const, text: `Added todo #${todo.id}: ${todo.text}` }],
						details: { action: "add", ...snapshot() } as TodoDetails,
					});
				}

				case "update": {
					if (params.id === undefined) return finish(err({ action: "update", ...snapshot() }, "id required for update"));
					if (!params.text) return finish(err({ action: "update", ...snapshot() }, "text required for update"));
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) return finish(err({ action: "update", ...snapshot() }, `#${params.id} not found`));
					todo.text = params.text;
					return finish({
						content: [{ type: "text" as const, text: `Updated todo #${todo.id}: ${todo.text}` }],
						details: { action: "update", ...snapshot() } as TodoDetails,
					});
				}

				case "set": {
					if (params.id === undefined) return finish(err({ action: "set", ...snapshot() }, "id required for set"));
					if (!params.status) return finish(err({ action: "set", ...snapshot() }, "status required for set"));
					const todo = todos.find((t) => t.id === params.id);
					if (!todo) return finish(err({ action: "set", ...snapshot() }, `#${params.id} not found`));
					todo.status = params.status;
					return finish({
						content: [{ type: "text" as const, text: `Todo #${todo.id} → ${todo.status}` }],
						details: { action: "set", ...snapshot() } as TodoDetails,
					});
				}

				case "remove": {
					if (params.id === undefined) return finish(err({ action: "remove", ...snapshot() }, "id required for remove"));
					const idx = todos.findIndex((t) => t.id === params.id);
					if (idx === -1) return finish(err({ action: "remove", ...snapshot() }, `#${params.id} not found`));
					todos.splice(idx, 1);
					return finish({
						content: [{ type: "text" as const, text: `Removed todo #${params.id}` }],
						details: { action: "remove", ...snapshot() } as TodoDetails,
					});
				}

				case "clear": {
					const count = todos.length;
					todos = [];
					nextId = 1;
					return finish({
						content: [{ type: "text" as const, text: `Cleared ${count} todos` }],
						details: { action: "clear", todos: [], nextId: 1 } as TodoDetails,
					});
				}
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.status) text += ` ${theme.fg("warning", `→ ${args.status}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}

			if (details.error) {
				return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			}

			const icon = (s: TodoStatus) =>
				s === "done" ? theme.fg("success", "✓") : s === "in_progress" ? theme.fg("warning", "▶") : theme.fg("dim", "○");

			switch (details.action) {
				case "list": {
					if (details.todos.length === 0) {
						return new Text(theme.fg("dim", "No todos"), 0, 0);
					}
					let listText = theme.fg("muted", `${details.todos.length} todo(s):`);
					const display = expanded ? details.todos : details.todos.slice(0, 5);
					for (const t of display) {
						const itemText = t.status === "done" ? theme.fg("dim", t.text) : theme.fg("muted", t.text);
						listText += `\n${icon(t.status)} ${theme.fg("accent", `#${t.id}`)} ${itemText}`;
					}
					if (!expanded && details.todos.length > 5) {
						listText += `\n${theme.fg("dim", `... ${details.todos.length - 5} more`)}`;
					}
					return new Text(listText, 0, 0);
				}

				default: {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", msg), 0, 0);
				}
			}
		},
	});

	// /todos command for users
	pi.registerCommand("todos", {
		description: "Show the todo list on the current branch",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todos requires interactive mode", "error");
				return;
			}

			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				return new TodoListComponent(todos, theme, () => done());
			});
		},
	});
}
