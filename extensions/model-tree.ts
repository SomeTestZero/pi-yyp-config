/**
 * /models —— 按 provider 分组的模型选择器。
 *
 * 内置 /model 是扁平列表；模型多了以后要在一长串里找某个 provider 很累。
 * 这里用两级 select 做成“先选 provider、再选模型”的树：第一级只列有可用凭证的
 * provider（与 /model 的可见范围一致），第二级只列该 provider 的模型，并带上下文/
 * 输出上限/是否思考，方便同类模型之间比较。
 *
 * /model 在 TUI 里是内置命令（提交前就被截获），扩展无法替换，所以另给 alt+m 一键入口。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

function compact(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
	return `${Math.round(tokens / 1000)}K`;
}

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
		const providerItems = providers.map((provider) => {
			const mark = provider.id === current?.provider ? "● " : "  ";
			return `${mark}${provider.label}  (${provider.id})  ·  ${provider.models.length} 个模型`;
		});
		const providerChoice = await ctx.ui.select(`选择 provider（当前 ${current?.provider ?? "无"}）`, providerItems);
		if (!providerChoice) return;
		const provider = providers[providerItems.indexOf(providerChoice)];
		if (!provider) return;

		const back = "← 返回 provider 列表";
		const modelItems = provider.models.map((model) => {
			const mark = model.provider === current?.provider && model.id === current.id ? "● " : "  ";
			const caps = `${compact(model.contextWindow)} ctx / ${compact(model.maxTokens)} out`;
			const thinking = model.reasoning ? " · thinking" : "";
			const images = model.input.includes("image") ? " · image" : "";
			return `${mark}${model.name}  ·  ${caps}${thinking}${images}`;
		});
		const choice = await ctx.ui.select(`${provider.label} · 选择模型`, [back, ...modelItems]);
		if (!choice) return;
		if (choice === back) continue;

		const model = provider.models[modelItems.indexOf(choice)];
		if (!model) continue;
		const ok = await pi.setModel(model);
		if (ok) ctx.ui.notify(`已切换：${model.provider}/${model.id}`, "info");
		else ctx.ui.notify(`切换失败：${model.provider}/${model.id}`, "error");
		return;
	}
}

export default function modelTreeExtension(pi: ExtensionAPI) {
	pi.registerCommand("models", {
		description: "按 provider 分组选择模型（树状）",
		handler: async (_args, ctx) => pickModel(pi, ctx),
	});
	pi.registerShortcut("alt+m", {
		description: "模型树：先选 provider 再选模型",
		handler: async (ctx) => pickModel(pi, ctx),
	});
}
