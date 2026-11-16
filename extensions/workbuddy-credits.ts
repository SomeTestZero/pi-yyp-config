/**
 * 主/子 Pi 进程共享的积分账本。
 *
 * 每个进程写自己的文件，读取方按本次主会话的 run 目录求和。子进程继承
 * PI_WB_CREDITS_DIR；resume 创建新 run，旧会话的积分不会重复计入本次运行。
 * 账本只含积分数字，不写请求、回答、token 或凭据。
 */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

interface LedgerEntry {
	version: 1;
	credits: Record<string, number>;
	updatedAt: string;
}

export function creditDelta(data: unknown): number | undefined {
	if (!data || typeof data !== "object") return undefined;
	const credit = (data as { usage?: { credit?: unknown } }).usage?.credit;
	return typeof credit === "number" && Number.isFinite(credit) && credit > 0 ? credit : undefined;
}

export function readCreditLedger(dir: string): Record<string, number> {
	const totals: Record<string, number> = {};
	for (const file of fs.readdirSync(dir)) {
		if (!/^[0-9a-f-]{36}\.json$/i.test(file)) continue;
		try {
			const raw: unknown = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
			if (!raw || typeof raw !== "object" || (raw as { version?: unknown }).version !== 1) continue;
			const credits = (raw as { credits?: unknown }).credits;
			if (!credits || typeof credits !== "object") continue;
			for (const [provider, credit] of Object.entries(credits)) {
				if (!/^workbuddy-(?:cn|intl)$/.test(provider)) continue;
				if (typeof credit !== "number" || !Number.isFinite(credit) || credit <= 0) continue;
				totals[provider] = (totals[provider] ?? 0) + credit;
			}
		} catch {
			// 写入中的临时文件不带 .json 后缀；坏文件不影响其他子进程。
		}
	}
	return totals;
}

export class CreditLedger {
	readonly dir: string;
	private readonly file: string;
	private readonly credits: Record<string, number> = {};
	private queue: Promise<void> = Promise.resolve();
	private stopped = false;

	constructor(sessionFile: string | undefined, cwd: string, agentDir: string, inheritedDir?: string) {
		const sessionDir = sessionFile ? path.dirname(sessionFile) : path.join(agentDir, "sessions", "ephemeral", process.pid.toString());
		this.dir = inheritedDir ?? path.join(sessionDir, ".workbuddy-credits", randomUUID());
		this.file = path.join(this.dir, `${randomUUID()}.json`);
		fs.mkdirSync(this.dir, { recursive: true });
		fs.writeFileSync(this.file, JSON.stringify(this.entry()), { encoding: "utf8", mode: 0o600 });
	}

	add(provider: string, credit: number): void {
		if (this.stopped || !Number.isFinite(credit) || credit <= 0) return;
		this.credits[provider] = (this.credits[provider] ?? 0) + credit;
		this.queue = this.queue.then(async () => {
			const temporary = `${this.file}.${randomUUID()}.tmp`;
			try {
				await fs.promises.writeFile(temporary, JSON.stringify(this.entry()), { encoding: "utf8", mode: 0o600 });
				await fs.promises.rename(temporary, this.file);
			} catch {
				// 账本写入失败不能中断模型响应；本进程内存计数仍保留。
			} finally {
				await fs.promises.rm(temporary, { force: true }).catch(() => undefined);
			}
		});
	}

	read(): Record<string, number> {
		return readCreditLedger(this.dir);
	}

	async close(): Promise<void> {
		this.stopped = true;
		await this.queue;
	}

	private entry(): LedgerEntry {
		return { version: 1, credits: { ...this.credits }, updatedAt: new Date().toISOString() };
	}
}
