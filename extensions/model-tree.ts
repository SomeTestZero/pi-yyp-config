/**
 * /models —— 按 provider 分组的模型选择器。
 *
 * 内置 /model 是扁平列表；模型多了以后要在一长串里找某个 provider 很累。
 * 这里用两级 select 做成“先选 provider、再选模型”的树：第一级只列有可用凭证的
 * provider（与 /model 的可见范围一致），第二级只列该 provider 的模型，并带上下文/
 * 输出上限/是否思考，方便同类模型之间比较。
 *
 * 两级列表都用 ctx.ui.custom 自绘（pi-tui SelectList + 搜索框），所以能自己处理
 * 快捷键：模型列表里按 ctrl+s（键位 id app.models.save，跟随用户 keybindings.json）
 * 直接把选中模型保存为默认模型并切换；Enter 只切换当前会话，之后仍会追问是否存为
 * 默认（与旧流程一致）。Esc 在模型列表返回 provider 列表，在 provider 列表退出。
 *
 * 扩展 API 的 pi.setModel() 只切当前会话，不提供写默认值的入口，所以保存走直接
 * 编辑 ~/.pi/agent/settings.json 的 defaultProvider/defaultModel（与 pi-sync-guard
 * 同样的做法）。这两个键已在 sync.excludeKeys 里，属机器本地偏好，不影响多机同步。
 *
 * /model 在 TUI 里是内置命令（提交前就被截获），扩展无法替换，所以另给 alt+m 一键入口。
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import type { KeybindingsManager, SelectItem, TUI } from "@earendil-works/pi-tui";
import { Container, Input, SelectList, Spacer, Text } from "@earendil-works/pi-tui";

function compact(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	return `${Math.round(tokens / 1000)}K`;
}

const SESSION_ONLY = "仅切换本会话";
const SAVE_DEFAULT = "保存为默认模型（写入 settings.json）";

function saveDefaultModel(model: { provider: string; id: string }): { ok: boolean; settingsPath: string; error?: string } {
	const agentDir = process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
	const settingsPath = path.join(agentDir, "settings.json");
	try {
		const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8")) : {};
		settings.defaultProvider = model.provider;
		settings.defaultModel = model.id;
		fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
		return { ok: true, settingsPath };
	} catch (error) {
		return { ok: false, settingsPath, error: error instanceof Error ? error.message : String(error) };
	}
}

// ---------------------------------------------------------------------------
// 自绘选择器：SelectList + 搜索框 + 快捷键（含 app.models.save 直接保存默认模型）
// ---------------------------------------------------------------------------

/** ctx.ui.custom 注入的 keybindings / theme 的最小形状 */
interface PickerKeybindings {
	matches(data: string, id: string): boolean;
	getKeys(id: string): string[];
}

interface PickerTheme {
	fg(name: string, text: string): string;
	bold(text: string): string;
}

/** "ctrl+s" → "Ctrl+S"，多键绑定如 ["escape","ctrl+c"] → "Esc/Ctrl+C" 风格的 "Escape/Ctrl+C" */
function formatKeyText(keys: string[]): string {
	return keys
		.map((key) =>
			key
				.split("+")
				.map((part) => (part ? part.charAt(0).toUpperCase() + part.slice(1) : part))
				.join("+"),
		)
		.join("/");
}

function keyHint(kb: PickerKeybindings, id: string, description: string, theme: PickerTheme): string {
	const keys = kb.getKeys(id);
	if (keys.length === 0) return "";
	return theme.fg("dim", formatKeyText(keys)) + theme.fg("muted", ` ${description}`);
}

async function openPicker<T>(
	ctx: any,
	opts: {
		title: string;
		items: SelectItem[];
		/** 启用 app.models.save：把当前选中项作为“保存为默认”返回 */
		enableSave: boolean;
		mapResult: (value: string, save: boolean) => T;
	},
): Promise<T | null> {
	// ctx 是 any（扩展命令上下文），不能直接写 ctx.ui.custom<T>，这里显式标注回调签名
	return (await ctx.ui.custom(
		(tui: TUI, theme: PickerTheme, keybindings: KeybindingsManager, done: (result: T | null) => void) => {
			const border = () => new DynamicBorder((str) => theme.fg("accent", str));
			const container = new Container();
			container.addChild(border());
			container.addChild(new Text(theme.fg("accent", theme.bold(opts.title)), 1, 0));
			container.addChild(new Spacer(1));

			const search = new Input({ placeholder: "输入过滤…", placeholderStyle: (t: string) => theme.fg("dim", t) });
			container.addChild(search);

			const listHolder = new Container();
			container.addChild(listHolder);
			container.addChild(new Spacer(1));

			const footer = new Text("", 1, 0);
			container.addChild(footer);
			container.addChild(border());

			const listTheme = {
				selectedPrefix: (text: string) => theme.fg("accent", text),
				selectedText: (text: string) => theme.fg("accent", text),
				description: (text: string) => theme.fg("muted", text),
				scrollInfo: (text: string) => theme.fg("dim", text),
				noMatch: (text: string) => theme.fg("warning", text),
			};
			const maxVisible = 12;

			const makeList = (items: SelectItem[]): SelectList => {
				const list = new SelectList(items, Math.max(1, Math.min(items.length, maxVisible)), listTheme);
				list.onSelect = (item) => done(opts.mapResult(item.value, false));
				list.onCancel = () => done(null);
				listHolder.clear();
				listHolder.addChild(list);
				return list;
			};
			let list = makeList(opts.items);

			const applyFilter = (query: string) => {
				const needle = query.trim().toLowerCase();
				const items = needle
					? opts.items.filter((item) => `${item.value} ${item.label} ${item.description ?? ""}`.toLowerCase().includes(needle))
					: opts.items;
				list = makeList(items);
			};

			const updateFooter = () => {
				const parts = [
					theme.fg("dim", "↑↓") + theme.fg("muted", " 选择"),
					keyHint(keybindings, "tui.select.confirm", "选择", theme),
					opts.enableSave ? keyHint(keybindings, "app.models.save", "保存为默认模型", theme) : "",
					keyHint(keybindings, "tui.select.cancel", opts.enableSave ? "返回" : "退出", theme),
					theme.fg("dim", "输入") + theme.fg("muted", " 过滤"),
				].filter(Boolean);
				footer.setText("  " + parts.join(theme.fg("dim", " · ")));
			};
			updateFooter();

			const isListKey = (data: string) =>
				keybindings.matches(data, "tui.select.up") ||
				keybindings.matches(data, "tui.select.down") ||
				keybindings.matches(data, "tui.select.pageUp") ||
				keybindings.matches(data, "tui.select.pageDown") ||
				keybindings.matches(data, "tui.select.confirm");

			return {
				// 让 PageUp/PageDown 翻列表，而不是滚动全屏 transcript
				capturesViewportInput: true,
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					if (keybindings.matches(data, "tui.select.cancel")) {
						done(null);
						return;
					}
					// 与内置 /model 一致：app.models.save（默认 ctrl+s）直接“选中并保存为默认模型”
					if (opts.enableSave && keybindings.matches(data, "app.models.save")) {
						const selected = list.getSelectedItem();
						if (selected) done(opts.mapResult(selected.value, true));
						return;
					}
					if (isListKey(data)) {
						list.handleInput(data);
					} else {
						const before = search.getValue();
						search.handleInput(data);
						if (search.getValue() !== before) applyFilter(search.getValue());
					}
					tui.requestRender();
				},
			};
		},
	)) as T | null;
}

// ---------------------------------------------------------------------------
// 两级模型树
// ---------------------------------------------------------------------------

async function pickModel(pi: ExtensionAPI, ctx: any): Promise<void> {
	for (;;) {
		const available = ctx.modelRegistry.getAvailable();
		const groups = new Map<string, typeof available>();
		for (const model of available) {
			const list = groups.get(model.provider);
			if (list) list.push(model);
			else groups.set(model.provider, [model]);
		}
		const providers = [...groups.entries()]
			.map(([id, models]) => ({
				id,
				models: [...models].sort((a, b) => a.name.localeCompare(b.name)),
				label: ctx.modelRegistry.getProviderDisplayName(id),
			}))
			.sort((a, b) => a.label.localeCompare(b.label));

		if (providers.length === 0) {
			ctx.ui.notify("没有可用模型：先 /login 或配置 provider", "warning");
			return;
		}

		const current = ctx.model;
		const providerItems: SelectItem[] = providers.map((provider) => {
			const mark = provider.id === current?.provider ? "● " : "  ";
			return {
				value: provider.id,
				label: `${mark}${provider.label}`,
				description: `(${provider.id}) · ${provider.models.length} 个模型`,
			};
		});
		const providerId = await openPicker<string>(ctx, {
			title: `选择 provider（当前 ${current?.provider ?? "无"}）`,
			items: providerItems,
			enableSave: false,
			mapResult: (value) => value,
		});
		if (!providerId) return;
		const provider = providers.find((p) => p.id === providerId);
		if (!provider) continue;

		const modelItems: SelectItem[] = provider.models.map((model) => {
			const mark = model.provider === current?.provider && model.id === current.id ? "● " : "  ";
			const caps = `${compact(model.contextWindow)} ctx / ${compact(model.maxTokens)} out`;
			const thinking = model.reasoning ? " · thinking" : "";
			const images = model.input.includes("image") ? " · image" : "";
			return {
				value: model.id,
				label: `${mark}${model.name}`,
				description: `${caps}${thinking}${images}`,
			};
		});
		const picked = await openPicker<{ id: string; save: boolean }>(ctx, {
			title: `${provider.label} · 选择模型`,
			items: modelItems,
			enableSave: true,
			mapResult: (value, save) => ({ id: value, save }),
		});
		if (!picked) continue; // Esc 返回 provider 列表
		const model = provider.models.find((m) => m.id === picked.id);
		if (!model) continue;

		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`切换失败：${model.provider}/${model.id}`, "error");
			return;
		}
		if (picked.save) {
			const result = saveDefaultModel(model);
			if (result.ok) ctx.ui.notify(`已切换并保存为默认模型：${model.provider}/${model.id} → ${result.settingsPath}`, "info");
			else ctx.ui.notify(`已切换，但保存默认模型失败：${result.error}`, "error");
			return;
		}
		const action = await ctx.ui.select(`已选 ${model.provider}/${model.id}（本会话已生效）`, [SESSION_ONLY, SAVE_DEFAULT]);
		if (action === SAVE_DEFAULT) {
			const result = saveDefaultModel(model);
			if (result.ok) ctx.ui.notify(`已保存默认模型：${model.provider}/${model.id} → ${result.settingsPath}`, "info");
			else ctx.ui.notify(`保存默认模型失败：${result.error}`, "error");
		}
		return;
	}
}

export default function modelTreeExtension(pi: ExtensionAPI) {
	pi.registerCommand("models", {
		description: "按 provider 分组选择模型（树状，ctrl+s 存为默认）",
		handler: async (_args, ctx) => pickModel(pi, ctx),
	});
	pi.registerShortcut("alt+m", {
		description: "模型树：先选 provider 再选模型，ctrl+s 存为默认",
		handler: async (ctx) => pickModel(pi, ctx),
	});
}
