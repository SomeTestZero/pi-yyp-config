/**
 * /models —— 按 provider 分组的模型选择器（两级树）。
 *
 * 内置 /model 是扁平列表；模型多了以后要在一长串里找某个 provider 很累。
 * 这里用两级列表做成“先选 provider、再选模型”的树：第一级只列有可用凭证的
 * provider（与 /model 的可见范围一致），第二级只列该 provider 的模型，并带上下文/
 * 输出上限/是否思考，方便同类模型之间比较。
 *
 * 为什么不用 ctx.ui.select()：
 *  · 它把选项一次全渲染、没有窗口和滚动，选中项一旦移出屏幕就再也看不到
 *    （provider 有几十个模型时必踩），鼠标滚轮也不跟。
 *  · 它没有“设为默认”这个动作，切换只活在当前会话。
 * 所以改用 ctx.ui.custom() 自绘：按终端高度开窗，↑↓/PgUp/PgDn/滚轮都在窗口内跟随，
 * 直接输入即筛选；Ctrl+S（app.models.save）把选中项写进 settings.json 的默认模型。
 *
 * /model 在 TUI 里是内置命令（提交前就被截获），扩展无法替换，所以另给 alt+m 一键入口。
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Input, fuzzyFilter, truncateToWidth } from "@earendil-works/pi-tui";

/** 除列表行以外的固定占用：边框、标题、搜索框、计数、提示行与 pi 自己的 footer。 */
const OVERHEAD_ROWS = 13;
const MIN_VISIBLE_ROWS = 4;
const MAX_VISIBLE_ROWS = 20;

/** `default` = 切换并写成默认模型。 */
interface PickResult<T> {
	kind: "select" | "default";
	value: T;
}

interface PickerRow<T> {
	/** 纯文本，供模糊筛选用。 */
	text: string;
	/** 渲染整行（选中态由 selected 决定），宽度由外层统一裁。 */
	line(theme: Theme, selected: boolean): string;
	value: T;
	/** 不支持写成默认模型的行（如“返回”）显式排除，免得多级菜单里被 Ctrl+S 误触。 */
	canDefault?: boolean;
}

interface PickerOptions<T> {
	title: string;
	rows: PickerRow<T>[];
	/** 终端行数，决定窗口高度。 */
	terminalRows(): number;
	theme: Theme;
	keybindings: Keybindings;
	done(result: PickResult<T> | undefined): void;
}

/** 只取组件用到的 Theme 接口，避免把 extension 类型绑到内部实现。 */
interface Theme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}
interface Keybindings {
	matches(data: string, keybinding: string): boolean;
	getKeys(keybinding: string): string[];
}

function compact(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	return `${Math.round(tokens / 1000)}K`;
}

/**
 * 有窗口的单选列表。选中项始终被拉回窗口内，所以不会出现“指针跑出界面外”。
 */
class Picker<T> {
	private rows: PickerRow<T>[];
	private selected = 0;
	private readonly allRows: PickerRow<T>[];
	private readonly searchInput: Input;
	private _focused = false;

	constructor(private readonly opts: PickerOptions<T>) {
		this.rows = opts.rows;
		this.allRows = opts.rows;
		this.searchInput = new Input({
			prompt: "  ",
			placeholder: "输入筛选，Esc 清除",
			placeholderStyle: (text: string) => opts.theme.fg("muted", text),
		});
	}

	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	render(width: number): string[] {
		const theme = this.opts.theme;
		const visible = this.visibleCount();
		const start = this.windowStart(visible);
		const end = Math.min(start + visible, this.rows.length);

		const lines: string[] = ["", `  ${theme.bold(theme.fg("accent", this.opts.title))}`, ""];
		lines.push(...this.searchInput.render(Math.max(1, width - 2)));
		lines.push("");
		if (this.rows.length === 0) lines.push(`  ${theme.fg("muted", "没有匹配的项")}`);
		for (let i = start; i < end; i++) lines.push(this.rows[i]!.line(theme, i === this.selected));
		if (this.rows.length > 0) {
			lines.push(`  ${theme.fg("muted", `${this.selected + 1}/${this.rows.length}`)}`);
		}
		lines.push("");
		lines.push(this.hints(theme));
		lines.push("");
		const maxWidth = Math.max(1, width);
		return lines.map((line) => truncateToWidth(line, maxWidth, ""));
	}

	invalidate(): void {
		this.searchInput.invalidate();
	}

	handleInput(data: string): void {
		const kb = this.opts.keybindings;
		if (kb.matches(data, "tui.select.up")) this.move(-1);
		else if (kb.matches(data, "tui.select.down")) this.move(1);
		else if (kb.matches(data, "tui.select.pageUp")) this.move(-this.visibleCount());
		else if (kb.matches(data, "tui.select.pageDown")) this.move(this.visibleCount());
		else if (kb.matches(data, "tui.select.confirm")) this.choose("select");
		else if (kb.matches(data, "app.models.save")) this.choose("default");
		else if (kb.matches(data, "tui.select.cancel")) {
			// 有筛选词时先清筛选（同内置 /model），空筛选才退出。
			if (this.searchInput.getValue()) {
				this.searchInput.setValue("");
				this.refilter();
			} else {
				this.opts.done(undefined);
			}
		} else {
			this.searchInput.handleInput(data);
			this.refilter();
		}
	}

	handleMouse(event: { type?: string; wheelDelta?: number }): { handled: boolean } | undefined {
		if (event?.type !== "wheel" || !event.wheelDelta) return undefined;
		this.move(event.wheelDelta < 0 ? -1 : 1);
		return { handled: true };
	}

	private hints(theme: Theme): string {
		const keys = (binding: string) => this.opts.keybindings.getKeys(binding).join("/");
		// 提示行要能塞进 54 列，否则窄终端会把末尾的“返回”截掉。
		const parts = [`${keys("tui.select.confirm")} 切换`, `${keys("app.models.save") || "ctrl+s"} 默认`, `PgUp/PgDn 翻页`, `${keys("tui.select.cancel")} 返回`];
		return `  ${theme.fg("muted", parts.join(" · "))}`;
	}

	private visibleCount(): number {
		const rows = Number(this.opts.terminalRows());
		const fit = Number.isFinite(rows) && rows > 0 ? rows - OVERHEAD_ROWS : MAX_VISIBLE_ROWS;
		return Math.max(MIN_VISIBLE_ROWS, Math.min(MAX_VISIBLE_ROWS, fit));
	}

	private windowStart(visible: number = this.visibleCount()): number {
		const maxStart = Math.max(0, this.rows.length - visible);
		return Math.max(0, Math.min(this.selected - Math.floor(visible / 2), maxStart));
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		this.selected = Math.max(0, Math.min(this.rows.length - 1, this.selected + delta));
	}

	private choose(kind: "select" | "default"): void {
		const row = this.rows[this.selected];
		if (!row) return;
		if (kind === "default" && row.canDefault === false) return;
		this.opts.done({ kind, value: row.value });
	}

	private refilter(): void {
		const query = this.searchInput.getValue().trim();
		this.rows = query ? fuzzyFilter(this.allRows, query, (row) => row.text) : this.allRows;
		this.selected = query ? 0 : Math.min(this.selected, Math.max(0, this.rows.length - 1));
	}
}

async function runPicker<T>(
	ctx: ExtensionContext,
	opts: { title: string; rows: PickerRow<T>[] },
): Promise<PickResult<T> | undefined> {
	if (ctx.mode !== "tui") {
		// RPC / print 模式没有自定义组件：退回内置 select（无窗口、无“设为默认”）。
		const choice = await ctx.ui.select(
			opts.title,
			opts.rows.map((row) => row.text),
		);
		const row = choice === undefined ? undefined : opts.rows.find((candidate) => candidate.text === choice);
		return row ? { kind: "select", value: row.value } : undefined;
	}
	return ctx.ui.custom<PickResult<T> | undefined>((tui, theme, keybindings, done) => {
		return new Picker<T>({
			title: opts.title,
			rows: opts.rows,
			terminalRows: () => tui.terminal?.rows ?? 40,
			theme,
			keybindings,
			done,
		});
	}) as Promise<PickResult<T> | undefined>;
}

/**
 * pi 的 ExtensionAPI 只有 setModel()（会话级），默认模型没有 API，只能自己落盘。
 * 每次都新建 manager 读最新文件：save() 按被改字段合并写回，不会盖掉别的改动。
 */
async function persistDefaultModel(ctx: ExtensionContext, provider: string, id: string): Promise<void> {
	const manager = SettingsManager.create(ctx.cwd, getAgentDir());
	manager.setDefaultModelAndProvider(provider, id);
	await manager.flush();
	const [problem] = manager.drainErrors();
	if (problem) throw problem.error;
}

/** settings.json 已写，但跨会话的 manager 不会重读，所以本进程内自己记住。 */
let sessionDefault: { provider: string; id: string } | undefined;

function currentDefault(pi: ExtensionAPI): { provider?: string; id?: string } {
	if (sessionDefault) return sessionDefault;
	const settings = pi.getSettings() as { defaultProvider?: string; defaultModel?: string } | undefined;
	return { provider: settings?.defaultProvider, id: settings?.defaultModel };
}

function markerLine(prefix: string, body: string, theme: Theme, selected: boolean): string {
	return selected ? theme.fg("accent", `→ ${body}`) : `${prefix} ${body}`;
}

/** ● 当前会话模型 · ◆ 已配置的默认模型 */
function marks(isCurrent: boolean, isDefault: boolean): string {
	return `${isCurrent ? "●" : " "}${isDefault ? "◆" : " "}`;
}

/** 二级列表的“返回”占位，和模型对象区分开。 */
const BACK = Symbol("back");

/** 注册表里的聊天模型类型，直接从 API 推导，免得额外依赖 pi-ai。 */
type CatalogModel = ReturnType<ExtensionContext["modelRegistry"]["getAvailable"]>[number];

async function pickModel(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	for (;;) {
		const groups = new Map<string, ReturnType<typeof ctx.modelRegistry.getAvailable>>();
		for (const model of ctx.modelRegistry.getAvailable()) {
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
		const wanted = currentDefault(pi);

		const providerChoice = await runPicker(ctx, {
			title: `选择 provider（当前 ${current?.provider ?? "无"}）`,
			rows: providers.map((provider) => ({
				text: `${provider.label} ${provider.id} ${provider.models.length}`,
				value: provider,
				line: (theme: Theme, selected: boolean) => {
					const badge = marks(provider.id === current?.provider, provider.id === wanted.provider);
					const body =
						`${badge} ${provider.label} ${theme.fg("muted", `(${provider.id})`)}` +
						theme.fg("muted", `  ·  ${provider.models.length} 个模型`);
					return markerLine(" ", body, theme, selected);
				},
			})),
		});
		if (!providerChoice) return;
		const provider = providerChoice.value;

		const modelRows: PickerRow<CatalogModel | typeof BACK>[] = [
			{
				text: "← 返回 provider 列表",
				value: BACK,
				canDefault: false,
				line: (theme, selected) => markerLine(" ", theme.fg("muted", "← 返回 provider 列表"), theme, selected),
			},
			...provider.models.map((model) => ({
				text: `${model.name} ${model.id} ${model.provider}`,
				value: model as CatalogModel,
				line: (theme: Theme, selected: boolean) => {
					const badge = marks(
						model.provider === current?.provider && model.id === current.id,
						model.provider === wanted.provider && model.id === wanted.id,
					);
					const caps = `${compact(model.contextWindow)} ctx / ${compact(model.maxTokens)} out`;
					const thinking = model.reasoning ? " · thinking" : "";
					const images = model.input.includes("image") ? " · image" : "";
					const body = `${badge} ${model.name} ${theme.fg("muted", `· ${caps}${thinking}${images}`)}`;
					return markerLine(" ", body, theme, selected);
				},
			})),
		];

		const modelChoice = await runPicker<CatalogModel | typeof BACK>(ctx, {
			title: `${provider.label} · 选择模型`,
			rows: modelRows,
		});
		if (!modelChoice) return;
		if (modelChoice.value === BACK) continue;

		const model = modelChoice.value;
		const ok = await pi.setModel(model);
		if (!ok) {
			ctx.ui.notify(`切换失败：${model.provider}/${model.id}（provider 没有可用凭证）`, "error");
			return;
		}
		if (modelChoice.kind === "select") {
			ctx.ui.notify(`已切换：${model.provider}/${model.id}`, "info");
			return;
		}
		try {
			await persistDefaultModel(ctx, model.provider, model.id);
			sessionDefault = { provider: model.provider, id: model.id };
			ctx.ui.notify(`已切换并设为默认：${model.provider}/${model.id}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`已切换，但默认模型没写进 settings.json：${message}`, "error");
		}
		return;
	}
}

export default function modelTreeExtension(pi: ExtensionAPI) {
	// settings.json 只在启动时读，跨会话的默认模型要重新从 settings 取。
	pi.on("session_start", () => {
		sessionDefault = undefined;
	});
	pi.registerCommand("models", {
		description: "按 provider 分组选择模型（树状，Ctrl+S 设为默认）",
		handler: async (_args, ctx) => pickModel(pi, ctx),
	});
	pi.registerShortcut("alt+m", {
		description: "模型树：先选 provider 再选模型",
		handler: async (ctx) => pickModel(pi, ctx),
	});
}
