/**
 * strata_video —— 本地视频理解：调 E:\LLM\video_watch.py（1fps 抽帧 → Strata 本地
 * Qwen3.8-Flash-Next 视觉模型，127.0.0.1:8081，零 token 费用，无音轨）。
 * 前提：用户已运行 E:\LLM\启动模型.bat；服务没起时脚本 exit 2 并给提示。
 * 长任务（分钟级）：signal 中止即杀子进程；stderr 进度逐行经 onUpdate 进 TUI；
 * 服务端串行 FIFO，故 executionMode 设 sequential 防并发打满。
 */
import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const SCRIPT = "E:\\LLM\\video_watch.py";
const HARD_TIMEOUT_MS = 30 * 60 * 1000; // 兜底：脚本自身有读超时，这里防完全卡死

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "strata_video",
		label: "Strata Video",
		description:
			"Analyze a LOCAL video file with the local Strata Qwen3.8 vision model (1 fps frame extraction, zero API token cost, no audio). " +
			"Requires the Strata server running (user starts E:\\LLM\\启动模型.bat, port 8081); if it is down the tool errors with instructions. " +
			"Returns a markdown report (summary + timestamped timeline + on-screen text); long videos are auto-chunked then consolidated. May take several minutes.",
		promptSnippet: "Watch/analyze a local video file via the local Strata vision model and return a markdown report",
		executionMode: "sequential",
		parameters: Type.Object({
			video_path: Type.String({ description: "Absolute path to the local video file" }),
			prompt: Type.Optional(Type.String({ description: "Question/task focus; default = full content extraction report" })),
			fps: Type.Optional(Type.Number({ description: "Frame sampling rate, default 1" })),
			width: Type.Optional(Type.Number({ description: "Frame scale width, default 640 (~300 tokens/frame, max 1024)" })),
			start: Type.Optional(Type.String({ description: "Range start, seconds or MM:SS" })),
			end: Type.Optional(Type.String({ description: "Range end, seconds or MM:SS" })),
			chunk_frames: Type.Optional(Type.Number({ description: "Frames per chunk for long videos, default 60" })),
			out: Type.Optional(Type.String({ description: "Report output path; default <video>_视频报告.md next to the video" })),
		}),
		async execute(_toolCallId, params, signal, onUpdate, _ctx) {
			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Cancelled" }], details: {} };
			}
			const args = [SCRIPT, params.video_path];
			if (params.prompt) args.push("--prompt", params.prompt);
			if (params.fps !== undefined) args.push("--fps", String(params.fps));
			if (params.width !== undefined) args.push("--width", String(params.width));
			if (params.start !== undefined) args.push("--start", params.start);
			if (params.end !== undefined) args.push("--end", params.end);
			if (params.chunk_frames !== undefined) args.push("--chunk-frames", String(params.chunk_frames));
			if (params.out) args.push("--out", params.out);

			const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
				const child = spawn("python", args, {
					stdio: ["ignore", "pipe", "pipe"],
					windowsHide: true,
					env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
				});
				const out: Buffer[] = [];
				let stderr = "";
				const timer = setTimeout(() => {
					child.kill();
					reject(new Error("strata_video timed out after 30 minutes"));
				}, HARD_TIMEOUT_MS);
				child.stdout.on("data", (d: Buffer) => out.push(d));
				child.stderr.on("data", (d: Buffer) => {
					stderr += d.toString("utf8");
					const lastLine = stderr.trimEnd().split("\n").pop() ?? "";
					onUpdate?.({ content: [{ type: "text", text: lastLine }], details: {} });
				});
				const onAbort = () => child.kill();
				signal?.addEventListener("abort", onAbort, { once: true });
				child.on("error", (e) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					reject(e); // python 不在 PATH 等
				});
				child.on("close", (code) => {
					clearTimeout(timer);
					signal?.removeEventListener("abort", onAbort);
					if (signal?.aborted) reject(new Error("Aborted"));
					else resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr, code });
				});
			});

			if (result.code !== 0) {
				throw new Error(`video_watch.py exited ${result.code}\n${result.stderr.slice(-2000)}`);
			}
			const m = result.stderr.match(/报告已写入\s+(.+?)（/);
			return {
				content: [{ type: "text", text: result.stdout || result.stderr.slice(-2000) }],
				details: { reportPath: m?.[1], exitCode: result.code },
			};
		},
	});
}
