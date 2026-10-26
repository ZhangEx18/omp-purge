/**
 * omp-purge — omp 会话级提示词开关（自带人设，零落盘）
 *
 * 机制来自两条线：
 *   dsh-purge：不「压住」宿主身份，而是**清掉**；且有逐项补丁状态机
 *              （applied / unmatched / skipped 三态 + /purge status 明细表）。
 *   pi-purge ：单扩展、会话级内存开关、strict/replace/append 三模式、
 *              锚点匹配失败就安全退化、绝不写盘。
 *
 * omp 与 pi 的关键差异（决定了本文件的写法）：
 *   1. `before_agent_start` 的 `event.systemPrompt` 是 **string[]**（有序 block 数组），
 *      不是 pi 的单个字符串。block 0 是静态指令模板（默认 system-prompt.md 渲染结果），
 *      尾部是一个以 `<project-context>` 开头的 footer 块（含 AGENTS.md/repo rules/
 *      workspace tree/append 文本）。所以这里做的是**按块 + 按段**的切除，
 *      而不是 pi-purge 那种整串字符串手术。
 *   2. 没有 `systemPromptOptions.cwd`，工作目录从 `ctx.cwd` 取。
 *   3. block 结构让 Anthropic 的 cache breakpoint 落在 footer 之前：
 *      strict 模式保留 footer 就等于保留用户自己的 AGENTS.md，丢掉的是宿主脚手架。
 *
 * 三条设计约束（与 pi-purge 一致）：
 *   1. 默认不启用 —— 不输入 /purge，omp 与未安装本扩展时完全一致。
 *   2. 会话级独立 —— 状态只在内存，session_start / session_switch 归零，退出即失，不落盘。
 *   3. 人设可换 —— 默认读 ~/.dsh/prompt-inject.md，缺失/为空才用内嵌示例。
 *
 * 本文件不 import 任何 omp 类型：omp 以 bun 直接加载 .ts，运行期没有类型检查，
 * 自带最小接口定义可以让它在任意 omp 版本上加载而不依赖包内类型路径。
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// 最小宿主接口（只声明用到的部分，避免依赖 @oh-my-pi/pi-coding-agent 的类型）
// ============================================================================

interface Ctx {
	cwd?: string;
	ui?: {
		notify?: (message: string, type?: "info" | "warning" | "error") => void;
		setStatus?: (key: string, text?: string) => void;
	};
}

interface ExtApi {
	on: (event: string, handler: (event: unknown, ctx: Ctx) => unknown) => void;
	registerCommand?: (
		name: string,
		cmd: {
			description?: string;
			getArgumentCompletions?: (prefix: string) => Array<{ value: string; label: string }> | null;
			handler: (args: string, ctx: Ctx) => Promise<void>;
		},
	) => void;
}

// ============================================================================
// 人设源
// ============================================================================

/** 内嵌示例正文：外部文件缺失时的兜底，保证新装即可用。 */
const EMBEDDED_PERSONA = [
	"# Persona (example)",
	"",
	"You are a helpful assistant running inside omp. Answer the user's request",
	"directly and keep responses concise.",
	"",
	"This text is a placeholder bundled with omp-purge so a fresh install works",
	"immediately: /purge swaps the static instruction block for this persona,",
	"and /purge off restores omp's own prompt.",
	"",
	"To use your own instructions instead:",
	"",
	"    /purge source /absolute/path/to/your-prompt.md",
	"",
	"and `/purge source embedded` comes back to this example.",
].join("\n");

/** 显式选择内嵌源的哨兵值。 */
const EMBEDDED = "embedded";

/** 默认人设路径：与 dsh 侧共用同一份注入文件，缺失才回退内嵌。 */
const DEFAULT_SOURCE = join(homedir(), ".dsh", "prompt-inject.md");

/** 环境变量入口（只读一次，不落盘、不自动写回配置）。 */
const ENV_SOURCE = process.env.OMP_PURGE_SOURCE?.trim() || "";
const ENV_MODE = process.env.OMP_PURGE_MODE?.trim().toLowerCase() || "";
const ENV_AUTOSTART = /^(1|true|yes|on)$/i.test(process.env.OMP_PURGE_AUTOSTART?.trim() || "");

// ============================================================================
// 切除表（dsh-purge 的补丁表在这里映射成「可切除的宿主段落」）
// ============================================================================

type Group = "identity" | "policy" | "content";

interface Cut {
	/** 稳定 id，/purge cut 用它开关。 */
	id: string;
	/** 人类可读说明（/purge status 展示）。 */
	label: string;
	group: Group;
	/** 起始标记：命中任一即以该行为切除起点（行首 trimStart 比较）。 */
	start: string[];
	/**
	 * 结束标记：命中任一即以该行为切除终点（不含该行）。
	 * `null` = 明确声明「本段一直到块末尾」（如 § Critical）。这是**声明式**的 to-end，
	 * 与「声明了结束标记但没找到」必须是两种不同处理 —— 后者要安全退化，不能静默吞掉余下全文。
	 */
	end: string[] | null;
	/** 该 cut 在哪个模式下默认生效。 */
	cutIn: { replace: boolean; strict: boolean };
	/** 作用域：static = 静态指令块；footer = <project-context> 尾块。默认 static。 */
	scope?: "static" | "footer";
	/** true = 结束标记行本身也一并切除（闭区间，如 <critical>…</critical>）。 */
	consumeEnd?: boolean;
	/**
	 * 兄弟边界护栏：扫描结束标记时，若先遇到**任意其它 cut 的起始标记**就停在那里。
	 * 给了一层冗余保护 —— 即使本项的结束标记被上游改名，也不会吃掉后面的段。
	 */
	siblingGuard?: boolean;
}

/**
 * 全部锚点取自 omp 18.12.6 的 `src/prompts/system/system-prompt.md`（渲染后的字面文本）。
 * 任何一处在上游改版后匹配不到，只把该 cut 标成 `unmatched` 并从切除集合里跳过，
 * 绝不猜边界、绝不整段切坏 —— 这是 pi-purge 的失败安全退化契约。
 */
const CUTS: Cut[] = [
	{
		id: "HOST_PREAMBLE",
		label: "首部 RFC 2119 / XML 权威声明",
		group: "identity",
		start: ["\u0000PREAMBLE"],
		end: null,
		cutIn: { replace: true, strict: true },
	},
	{
		id: "ROLE_SECTION",
		label: "§ Role + 宿主身份句",
		group: "identity",
		start: ["§ Role"],
		end: ["# Engineering", "# Personality", "§ Runtime", "# Skills & Rules", "# Internal URLs"],
		cutIn: { replace: true, strict: true },
	},
	{
		id: "PERSONALITY",
		label: "# Personality（config.yml 的 personality 注入）",
		group: "identity",
		start: ["# Personality"],
		end: ["§ Runtime", "# Skills & Rules", "# Internal URLs"],
		cutIn: { replace: true, strict: true },
	},
	{
		id: "ENGINEERING",
		label: "# Engineering（宿主编码风格硬规则）",
		group: "policy",
		start: ["# Engineering"],
		end: ["# Personality", "§ Runtime", "# Skills & Rules", "# Internal URLs"],
		cutIn: { replace: false, strict: true },
	},
	{
		id: "SKILLS_RULES",
		label: "# Skills & Rules（含 <skills>/<generic-rules>/<domain-rules>）",
		group: "content",
		start: ["# Skills & Rules"],
		end: ["# Internal URLs", "# Tool Inventory", "# xd:// Tool Devices", "§ Scratchpad", "§ Tool Policy"],
		cutIn: { replace: false, strict: true },
	},
	{
		id: "INTERNAL_URLS",
		label: "# Internal URLs（omp:// 文档目录）",
		group: "identity",
		start: ["# Internal URLs"],
		end: ["# Tool Inventory", "# xd:// Tool Devices", "§ Scratchpad", "§ Tool Policy"],
		cutIn: { replace: true, strict: true },
	},
	{
		id: "TOOL_INVENTORY",
		label: "# Tool Inventory（内置工具清单）",
		group: "identity",
		start: ["# Tool Inventory"],
		end: ["# xd:// Tool Devices", "§ Scratchpad", "§ Tool Policy"],
		cutIn: { replace: true, strict: true },
	},
	{
		id: "XD_DEVICES",
		label: "# xd:// Tool Devices",
		group: "identity",
		start: ["# xd:// Tool Devices"],
		end: ["§ Scratchpad", "§ Tool Policy"],
		cutIn: { replace: true, strict: true },
	},
	{
		id: "SCRATCHPAD",
		label: "§ Scratchpad（think 工具说明）",
		group: "policy",
		start: ["§ Scratchpad"],
		end: ["§ Tool Policy"],
		cutIn: { replace: false, strict: true },
	},
	{
		id: "TOOL_POLICY",
		label: "§ Tool Policy（工具选择与委派闸门）",
		group: "policy",
		start: ["§ Tool Policy"],
		end: ["§ Workflow"],
		cutIn: { replace: false, strict: true },
	},
	{
		id: "WORKFLOW",
		label: "§ Workflow（Scope→Cleanup 六步）",
		group: "policy",
		start: ["§ Workflow"],
		end: ["§ Delivery"],
		cutIn: { replace: false, strict: true },
	},
	{
		id: "DELIVERY",
		label: "§ Delivery（<contract>/<completeness>/<yielding>）",
		group: "policy",
		start: ["§ Delivery"],
		end: ["§ Critical"],
		cutIn: { replace: false, strict: true },
	},
	{
		id: "CRITICAL",
		label: "§ Critical（禁止收尾的硬约束）",
		group: "policy",
		start: ["§ Critical"],
		end: null,
		cutIn: { replace: false, strict: true },
		siblingGuard: false,
	},
	{
		id: "FOOTER_CRITICAL",
		label: "<critical> 尾块（每轮必须推进 / 收尾前必须验证）",
		group: "policy",
		start: ["<critical>"],
		end: ["</critical>"],
		cutIn: { replace: false, strict: true },
		scope: "footer",
		consumeEnd: true,
	},
];

const CUT_IDS = CUTS.map(cut => cut.id);
const CUT_BY_ID = new Map(CUTS.map(cut => [cut.id, cut]));

type CutStatus = "applied" | "unmatched" | "skipped";

/**
 * 判断某一行是否是「别的 cut」的起始标记。
 * 用于兄弟护栏：本项扫描结束标记时，一旦先碰到别人的段头，就说明本项的范围已经越界。
 */
function isOtherCutStart(line: string, ownStart: string[]): boolean {
	for (const cut of CUTS) {
		if (cut.start === ownStart) continue;
		if (cut.start[0] === "\u0000PREAMBLE") continue;
		for (const marker of cut.start) {
			if (line.startsWith(marker)) return true;
		}
	}
	return false;
}

/** 把一段静态提示词按标记切成块后移除目标区间。 */
function removeSpan(
	text: string,
	startMarkers: string[],
	endMarkers: string[] | null,
	consumeEnd = false,
	siblingGuard = false,
): { text: string; matched: boolean } {
	const lines = text.split("\n");
	const startsAt = lines.findIndex(line => startMarkers.some(m => line.trimStart().startsWith(m)));

	// HOST_PREAMBLE 是特殊形态：没有字面起始标记，靠「首个 §/# 段头之前的一切」定义。
	if (startMarkers[0] === "\u0000PREAMBLE") {
		const firstHeader = lines.findIndex(line => /^\s*(§|#)\s/.test(line));
		if (firstHeader <= 0) return { text, matched: false };
		return { text: lines.slice(firstHeader).join("\n"), matched: true };
	}

	if (startsAt === -1) return { text, matched: false };

	let endsAt = lines.length;
	let foundEnd = endMarkers === null; // end === null 是声明式的「切到块末尾」
	if (endMarkers) {
		for (let i = startsAt + 1; i < lines.length; i += 1) {
			const line = lines[i].trimStart();
			if (endMarkers.some(m => line.startsWith(m))) {
				// 开区间（默认）= 结束标记行留给下一段；闭区间 = 连它一起吃掉。
				endsAt = consumeEnd ? i + 1 : i;
				foundEnd = true;
				break;
			}
			// 兄弟护栏：先撞到别的段的起点，说明本段的范围已经越界了。
			if (siblingGuard && isOtherCutStart(line, startMarkers)) {
				endsAt = i;
				foundEnd = true;
				break;
			}
		}
	}

	// 声明了结束标记却一个都没命中 → 边界不可信，整项放弃（安全退化）。
	// 绝不能退化成「切到末尾」：那会静默吞掉后续所有段落，并让它们的状态全部变成假 unmatched。
	if (!foundEnd) return { text, matched: false };

	// 连带吃掉切除区间两端的空行，避免留下连续 3 个以上换行。
	const head = lines.slice(0, startsAt);
	while (head.length > 0 && head[head.length - 1].trim() === "") head.pop();
	const tail = lines.slice(endsAt);
	while (tail.length > 0 && tail[0].trim() === "") tail.shift();

	const kept = [...head, ...tail];
	return { text: kept.length > 0 ? `${kept.join("\n")}\n` : "", matched: true };
}

/** 对一段文本按启用的 cut 依次切除，返回结果与逐项状态（只处理指定 scope 的 cut）。 */
function applyCuts(
	text: string,
	active: Set<string>,
	scope: "static" | "footer" = "static",
): { text: string; status: Record<string, CutStatus> } {
	let out = text;
	const status: Record<string, CutStatus> = {};

	for (const cut of CUTS) {
		if ((cut.scope ?? "static") !== scope) continue;
		if (!active.has(cut.id)) {
			status[cut.id] = "skipped";
			continue;
		}
		const result = removeSpan(
			out,
			cut.start,
			cut.end,
			cut.consumeEnd === true,
			cut.siblingGuard !== false,
		);
		out = result.text;
		status[cut.id] = result.matched ? "applied" : "unmatched";
	}

	return { text: out.trim().length > 0 ? out : "", status };
}

// ============================================================================
// 会话级状态（纯内存）
// ============================================================================

type Mode = "strict" | "replace" | "append";

interface LastRun {
	at: number;
	mode: Mode;
	staticBlocks: number;
	footerBlocks: number;
	outBlocks: number;
	status: Record<string, CutStatus>;
	personaBlock: boolean;
}

let enabled = false;
let mode: Mode = "strict";
let source = ENV_SOURCE || DEFAULT_SOURCE;
let body = "";
let loadError = "";
/** 人设是否来自内嵌兜底（默认源缺失时置 true，/purge status 会明说）。 */
let fellBackToEmbedded = false;
/** 用户在模式默认之外的手动开关：id → true(切) / false(保留)。 */
const cutOverrides = new Map<string, boolean>();
let lastRun: LastRun | null = null;

function resetSessionState(): void {
	enabled = false;
	mode = (ENV_MODE === "strict" || ENV_MODE === "replace" || ENV_MODE === "append"
		? ENV_MODE
		: "strict") as Mode;
	source = ENV_SOURCE || DEFAULT_SOURCE;
	body = "";
	loadError = "";
	fellBackToEmbedded = false;
	cutOverrides.clear();
	lastRun = null;
}

/** 读取人设正文；失败时不抛错，只记 loadError 并返回 false。 */
function reload(): boolean {
	const target = source;
	if (target === EMBEDDED) {
		body = EMBEDDED_PERSONA;
		loadError = body.length > 0 ? "" : "内嵌人设为空";
		fellBackToEmbedded = true;
		return body.length > 0;
	}

	try {
		if (!existsSync(target)) throw new Error(`文件不存在: ${target}`);
		const text = readFileSync(target, "utf8").trim();
		if (text.length === 0) throw new Error(`文件为空: ${target}`);
		body = text;
		loadError = "";
		fellBackToEmbedded = false;
		return true;
	} catch (error) {
		// 默认源缺失（不是用户显式指定的路径）→ 静默回退内嵌，保证 /purge 立刻可用。
		if (target === DEFAULT_SOURCE) {
			body = EMBEDDED_PERSONA;
			loadError = "";
			fellBackToEmbedded = true;
			return body.length > 0;
		}
		body = "";
		loadError = error instanceof Error ? error.message : String(error);
		fellBackToEmbedded = false;
		return false;
	}
}

/** 某模式下真正生效的 cut 集合。 */
function activeCuts(forMode: Mode): Set<string> {
	const active = new Set<string>();
	if (forMode === "append") return active;

	for (const cut of CUTS) {
		const base = forMode === "strict" ? cut.cutIn.strict : cut.cutIn.replace;
		const override = cutOverrides.get(cut.id);
		const on = override === undefined ? base : override;
		if (on) active.add(cut.id);
	}
	return active;
}

function isFooterBlock(block: string): boolean {
	const head = block.trimStart();
	return head.startsWith("<project-context>") || head.startsWith("<memories>");
}

function paint(ctx: Ctx): void {
	// -p / --mode json 没有 footer，setStatus 抛错不能把会话搞挂
	try {
		ctx.ui?.setStatus?.("omp-purge", enabled ? `PURGE ${mode.toUpperCase()}` : undefined);
	} catch {
		/* 非交互模式忽略 */
	}
}

// ============================================================================
// 扩展入口
// ============================================================================

export default function ompPurge(pi: ExtApi) {
	// 每个会话独立：新会话 / 恢复会话 / 切换会话 / 热重载都从「关闭」开始
	pi.on("session_start", async (_event, ctx) => {
		resetSessionState();
		reload();
		if (ENV_AUTOSTART && body.length > 0) enabled = true;
		paint(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		resetSessionState();
		reload();
		if (ENV_AUTOSTART && body.length > 0) enabled = true;
		paint(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!enabled) return;
		if (body.length === 0 && !reload()) return;

		const incoming = (event as { systemPrompt?: unknown }).systemPrompt;
		const blocks = Array.isArray(incoming)
			? incoming.filter((item): item is string => typeof item === "string")
			: [];

		// 定位 footer：第一个以 <project-context>/<memories> 开头的块，其后全部算 footer。
		let footerStart = blocks.length;
		for (let i = 0; i < blocks.length; i += 1) {
			if (isFooterBlock(blocks[i])) {
				footerStart = i;
				break;
			}
		}

		const staticBlocks = blocks.slice(0, footerStart);
		const footerBlocks = blocks.slice(footerStart);
		const persona = body.trim();
		const active = activeCuts(mode);

		// footer 侧的切除（scope = "footer"）：<critical> 是 omp 生成的收尾硬约束，
		// 不属于用户的 AGENTS.md，所以 strict/replace 都能切。
		const footerMerged =
			active.size === 0
				? { text: footerBlocks.join("\n\n"), status: {} as Record<string, CutStatus> }
				: applyCuts(footerBlocks.join("\n\n"), active, "footer");
		const rebuiltFooter = footerMerged.text.length > 0 ? [footerMerged.text] : [];

		let out: string[];
		let status: Record<string, CutStatus> = { ...footerMerged.status };
		const staticCount = staticBlocks.length;

		if (mode === "strict") {
			// 静态块整段丢弃：身份/工具政策/工作流/收尾硬约束都不进请求。
			// footer 保留 —— 那是用户自己的 AGENTS.md、repo rules、workspace tree。
			// 仍跑一遍 static 切除只为把逐项状态标成 applied（让 /purge status 可读）。
			const staticMerged = applyCuts(staticBlocks.join("\n\n"), active, "static");
			status = { ...staticMerged.status, ...status };
			const cwd = String(ctx?.cwd ?? "").replace(/\\/g, "/").trim();
			const head = cwd ? [`Current working directory: ${cwd}`, persona] : [persona];
			out = [...head, ...rebuiltFooter];
		} else if (mode === "replace") {
			const staticMerged = applyCuts(staticBlocks.join("\n\n"), active, "static");
			status = { ...staticMerged.status, ...status };
			const rebuilt = staticMerged.text.length > 0 ? [staticMerged.text] : [];
			out = [rebuilt[0] ?? "", persona, ...rebuilt.slice(1), ...rebuiltFooter].filter(
				block => block.trim().length > 0,
			);
		} else {
			// append：宿主提示词一字不改，人设作独立块插在 block 0 之后。
			out = [staticBlocks[0] ?? "", persona, ...staticBlocks.slice(1), ...footerBlocks].filter(
				block => block.trim().length > 0,
			);
		}

		lastRun = {
			at: Date.now(),
			mode,
			staticBlocks: staticCount,
			footerBlocks: footerBlocks.length,
			outBlocks: out.length,
			status,
			personaBlock: persona.length > 0,
		};

		return { systemPrompt: out };
	});

	pi.registerCommand?.("purge", {
		description: "会话级提示词开关：清掉宿主脚手架段落并挂上自己的人设（仅本会话，不落盘）",
		getArgumentCompletions: (prefix: string) => {
			const values = ["on", "off", "status", "mode", "source", "cut", "preview", "reload"];
			return values.filter(value => value.startsWith(prefix)).map(value => ({ value, label: value }));
		},
		handler: async (args: string, ctx: Ctx) => {
			const parts = args.trim().split(/\s+/).filter(Boolean);
			const cmd = (parts[0] ?? "").toLowerCase();
			const rest = parts.slice(1);
			const arg = rest.join(" ").trim();

			const notify = (text: string, type: "info" | "warning" | "error" = "info") => {
				try {
					ctx.ui?.notify?.(text, type);
				} catch {
					/* 无 UI 时忽略 */
				}
			};

			if ((cmd === "status" || cmd === "" || cmd === "preview") && body.length === 0) reload();

			const cutTable = (forMode: Mode): string => {
				const active = activeCuts(forMode);
				const status = forMode === "append" ? null : lastRun?.status;
				return CUTS.map(cut => {
					const override = cutOverrides.get(cut.id);
					const on = active.has(cut.id);
					let tag: string;
					if (forMode === "append") tag = "n/a     ";
					else if (!on) tag = "skipped ";
					else if (status) tag = `${(status[cut.id] ?? "skipped").padEnd(8)}`;
					else tag = "pending ";
					const note =
						override === undefined ? "" : on ? "  [手动:切]" : "  [手动:留]";
					return `  ${tag} ${cut.id.padEnd(14)} ${cut.label}${note}`;
				}).join("\n");
			};

			const describe = (): string => {
				const modeLabel =
					mode === "strict"
						? "strict（只发人设 + 工作目录 + <project-context>）"
						: mode === "replace"
							? "replace（按切除表清宿主段，保留其余）"
							: "append（宿主提示词不动，人设另起一块）";
				const srcLabel =
					fellBackToEmbedded
						? source === EMBEDDED
							? "内嵌示例"
							: `内嵌兜底（默认源缺失: ${source}）`
						: source;
				const run =
					lastRun === null
						? "尚未跑过一轮"
						: `${new Date(lastRun.at).toLocaleTimeString()} 静态块 ${lastRun.staticBlocks} → footer ${lastRun.footerBlocks} → 输出 ${lastRun.outBlocks} 块`;
				const applied = lastRun
					? Object.values(lastRun.status).filter(v => v === "applied").length
					: 0;
				const unmatched = lastRun
					? Object.values(lastRun.status).filter(v => v === "unmatched").length
					: 0;
				return [
					`状态: ${enabled ? "开启" : "关闭"}（仅本会话）  模式: ${modeLabel}`,
					`人设: ${srcLabel}  ${body.length > 0 ? `${body.length} 字符` : `未加载${loadError ? `（${loadError}）` : ""}`}`,
					`上轮: ${run}`,
					lastRun ? `切除: applied ${applied} / unmatched ${unmatched} / skipped ${CUTS.length - applied - unmatched}` : "",
					"切除表:",
					cutTable(mode),
				]
					.filter(Boolean)
					.join("\n");
			};

			const turnOn = () => {
				if (!reload()) return notify(`开启失败：${loadError}`, "error");
				enabled = true;
				paint(ctx);
				notify(`已开启（${mode}，仅本会话），每轮注入 ${body.length} 字符。\n${describe()}`);
			};

			const turnOff = () => {
				enabled = false;
				lastRun = null;
				paint(ctx);
				notify("已关闭，恢复 omp 原始系统提示词。");
			};

			switch (cmd) {
				case "":
					if (enabled) turnOff();
					else turnOn();
					return;

				case "on":
				case "enable":
					return turnOn();

				case "off":
				case "disable":
					return turnOff();

				case "status":
					return notify(describe());

				case "reload": {
					if (!reload()) return notify(`重读失败：${loadError}`, "error");
					paint(ctx);
					return notify(`人设已重读，正文 ${body.length} 字符。\n${describe()}`);
				}

				case "mode": {
					const wanted = arg.toLowerCase() as Mode;
					if (wanted !== "strict" && wanted !== "replace" && wanted !== "append") {
						return notify(
							[
								`当前模式: ${mode}`,
								"用法: /purge mode strict|replace|append",
								"strict  = 只发人设 + 工作目录 + <project-context>（宿主脚手架全丢，最彻底）",
								"replace = 按切除表清身份段，保留工具政策/工作流（较温和）",
								"append  = 宿主提示词不动，人设只作附加块",
							].join("\n"),
							"error",
						);
					}
					mode = wanted;
					paint(ctx);
					return notify(`模式已切换为 ${wanted}（仅本会话）。\n${describe()}`);
				}

				case "source": {
					if (!arg) {
						return notify(
							[
								`当前人设: ${source}`,
								"用法: /purge source <绝对路径|embedded>",
								`默认源: ${DEFAULT_SOURCE}`,
								"提示: /purge source embedded 切回内嵌示例；/purge reload 重读当前文件",
							].join("\n"),
							"error",
						);
					}
					const previous = source;
					const next = arg.replace(/^["']|["']$/g, "");
					source = next.toLowerCase() === EMBEDDED ? EMBEDDED : next;
					if (!reload()) {
						const reason = loadError;
						source = previous;
						reload();
						return notify(`切换失败：${reason}`, "error");
					}
					return notify(`人设已切换，正文 ${body.length} 字符。\n${describe()}`);
				}

				case "cut": {
					const sub = (rest[0] ?? "").toLowerCase();
					if (sub === "reset") {
						cutOverrides.clear();
						return notify(`已清空手动开关，回到模式默认。\n${cutTable(mode)}`);
					}
					const id = (rest[0] ?? "").toUpperCase();
					const action = (rest[1] ?? "").toLowerCase();
					if (!CUT_BY_ID.has(id)) {
						return notify(
							[
								"用法: /purge cut <ID> cut|keep   或   /purge cut reset",
								`可用 ID: ${CUT_IDS.join(", ")}`,
								`当前模式 ${mode} 的生效情况:`,
								cutTable(mode),
							].join("\n"),
							"error",
						);
					}
					if (action !== "cut" && action !== "keep") {
						return notify(
							`用法: /purge cut ${id} cut|keep\n${cutTable(mode)}`,
							"error",
						);
					}
					cutOverrides.set(id, action === "cut");
					return notify(`已把 ${id} 设为「${action === "cut" ? "切" : "保留"}」。\n${cutTable(mode)}`);
				}

				case "preview": {
					if (!enabled) {
						return notify("未开启，无法预览。先执行 /purge on。", "error");
					}
					const snippet = body.trim().slice(0, 400);
					return notify(
						[
							`模式 ${mode} 下即将发送的首块（前 400 字符）:`,
							"---",
							snippet,
							"---",
							`人设共 ${body.length} 字符；剩余段由 omp 的 <project-context> footer 提供。`,
						].join("\n"),
					);
				}

				default:
					return notify(
						`未知子命令: ${cmd}\n用法: /purge [on|off|status|mode|source|cut|preview|reload]`,
						"error",
					);
			}
		},
	});
}

// 供测试直接复用纯函数（不影响 omp 加载时的默认导出）
export { applyCuts, activeCuts, removeSpan, CUTS, CUT_IDS, isFooterBlock, EMBEDDED_PERSONA, DEFAULT_SOURCE };
