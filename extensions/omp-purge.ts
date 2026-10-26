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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

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

interface ToolInfoLike {
	name: string;
	description?: string;
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
	/** 以下为可选能力：宿主版本没提供时各自跳过，不影响核心提示词层。 */
	registerFlag?: (
		name: string,
		options: { description?: string; type: "boolean" | "string"; default?: boolean | string },
	) => void;
	getFlag?: (name: string) => boolean | string | undefined;
	getActiveTools?: () => string[];
	getAllTools?: () => ToolInfoLike[];
	setActiveTools?: (toolNames: string[]) => Promise<void>;
	setLabel?: (label: string) => void;
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

/**
 * 宿主版本标记：锚点绑的是这个版本的字面文本。
 * 从 omp 注入的环境变量尽力取，取不到就标 unknown —— 不猜、不硬编码。
 */
const HOST_TAG =
	process.env.OMP_VERSION?.trim() ||
	process.env.OMP_CLI_VERSION?.trim() ||
	process.env.npm_package_version?.trim() ||
	"unknown";

/**
 * 本扩展自身版本。
 *
 * 为什么不从 package.json 读：软链安装时本文件在别处，`import package.json` 会跨目录；
 * 而 omp 把 .ts 直接交给 bun，路径解析不确定。硬编码 + 一个测试盯着它，
 * 比运行时猜路径更可靠 —— 忘了 bump 时测试会红，不会静默说谎。
 *
 * /purge status 第一行展示它：判断「当前进程加载的是哪个版本的代码」只有这一个可靠信号，
 * 因为扩展模块每进程只 import 一次，改了文件不重启也是旧代码。
 */
const PLUGIN_VERSION = "0.2.2";

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

// ============================================================================
// 锚点重覆盖（移植自 dsh-purge 的 lib/anchors.js）
//
// 上游 omp 改版把某个段头改名后，本文件里的字面锚点就失效了。
// dsh-purge 的解法是允许把某个 pattern 换成「从当前宿主里取出来的真实片段」，
// 而不去改插件源码 —— 这里保留同样的机制，但默认只存在于内存：
//   /purge reanchor WORKFLOW start § Process        # 仅本会话
//   /purge reanchor save                            # 显式落盘（唯一写盘入口）
//   /purge reanchor reset                           # 清空（含落盘文件）
// ============================================================================

interface AnchorOverride {
	/** 覆盖后的起始标记；省略 = 用内置锚点。 */
	start?: string[];
	/** 覆盖后的结束标记；显式 null = 声明「切到块末尾」。 */
	end?: string[] | null;
	/** 记录来源，便于 /purge doctor 追溯。 */
	at: string;
	host?: string;
}

const ANCHORS_PATH =
	process.env.OMP_PURGE_ANCHORS?.trim() || join(homedir(), ".omp", "purge", "anchor-overrides.json");

/** cut id → 覆盖项。空 = 全部走内置锚点。 */
const anchorOverrides = new Map<string, AnchorOverride>();

type CutStatus = "applied" | "guarded" | "unmatched" | "skipped";

/** 取某个 cut 当前真正生效的锚点（有覆盖则用覆盖）。 */
function effectiveCut(cut: Cut): { start: string[]; end: string[] | null } {
	const ov = anchorOverrides.get(cut.id);
	if (!ov) return { start: cut.start, end: cut.end };
	return {
		start: ov.start && ov.start.length > 0 ? ov.start : cut.start,
		end: ov.end === undefined ? cut.end : ov.end,
	};
}

/** 从落盘文件读覆盖；文件缺失/损坏都静默忽略（不阻止扩展加载）。 */
function loadAnchorOverrides(): number {
	anchorOverrides.clear();
	try {
		if (!existsSync(ANCHORS_PATH)) return 0;
		const parsed = JSON.parse(readFileSync(ANCHORS_PATH, "utf8")) as {
			overrides?: Record<string, AnchorOverride>;
		};
		const entries = parsed?.overrides ?? {};
		let loaded = 0;
		for (const [id, ov] of Object.entries(entries)) {
			if (!CUT_BY_ID.has(id) || !ov || typeof ov !== "object") continue;
			anchorOverrides.set(id, ov);
			loaded += 1;
		}
		return loaded;
	} catch {
		return 0;
	}
}

/** 显式落盘（唯一写盘入口）。返回写入的覆盖条数。 */
function saveAnchorOverrides(): number {
	writeFileSync(
		ANCHORS_PATH,
		`${JSON.stringify(
			{
				version: 1,
				host: HOST_TAG,
				savedAt: new Date().toISOString(),
				overrides: Object.fromEntries(anchorOverrides),
			},
			null,
			"\t",
		)}\n`,
		"utf8",
	);
	return anchorOverrides.size;
}

/**
 * 找出「宿主有、我们不认识」的段头 —— 它们是上游改名的候选。
 *
 * 只报两类（避免把 `# 1. Scope` 这种段内小标题全列出来）：
 *   - `§ xxx` 前缀（omp 的顶层段头标记）
 *   - 不带序号的 `# xxx`（如 `# Engineering`、`# Tool Inventory`）
 */
function listUnknownHeaders(text: string): Array<{ line: string; lineNo: number; scope: "static" | "footer" }> {
	const known = new Set<string>();
	for (const cut of CUTS) {
		const { start } = effectiveCut(cut);
		for (const marker of start) {
			if (marker === "\u0000PREAMBLE") continue;
			known.add(marker);
		}
	}

	const out: Array<{ line: string; lineNo: number; scope: "static" | "footer" }> = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i += 1) {
		const line = lines[i].trimStart();
		if (line.startsWith("§ ")) {
			if (!known.has(line.trim())) out.push({ line: line.trim(), lineNo: i, scope: "static" });
			continue;
		}
		if (line.startsWith("# ") && !/^# \d+\./.test(line)) {
			if (!known.has(line.trim())) out.push({ line: line.trim(), lineNo: i, scope: "static" });
		}
	}
	return out;
}

/**
 * 判断某一行是否是「别的 cut」的起始标记。
 * 用于兄弟护栏：本项扫描结束标记时，一旦先碰到别人的段头，就说明本项的范围已经越界。
 *
 * 比较用 cut id（不用数组引用），因为锚点可能被 reanchor 换成新数组。
 */
function isOtherCutStart(
	line: string,
	ownId: string | null,
	scope: "static" | "footer" = "static",
): boolean {
	for (const cut of CUTS) {
		if (cut.id === ownId) continue;
		// 护栏只在同一作用域内生效：footer 的 <critical> 与 static 的 § Critical
		// 是两回事。跨作用域比较会让「本段应到 § Workflow」被同名的 </critical>
		// 之类的父级标记提前收边，把整段内容留在原地还谎报 guarded。
		if ((cut.scope ?? "static") !== scope) continue;
		const { start } = effectiveCut(cut);
		for (const marker of start) {
			if (marker === "\u0000PREAMBLE") continue;
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
	ownId: string | null = null,
	scope: "static" | "footer" = "static",
): { text: string; matched: boolean; guarded?: boolean } {
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
	// 靠兄弟护栏收边（不是命中自己的结束锚点）：边界仍是可信的，但可能连带吃掉了
	// 本项结束后、下一段之前的上游新增段落 —— 状态要如实标成 guarded，不能报 applied。
	let guarded = false;
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
			if (siblingGuard && isOtherCutStart(line, ownId, scope)) {
				endsAt = i;
				foundEnd = true;
				guarded = true;
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
	return { text: kept.length > 0 ? `${kept.join("\n")}\n` : "", matched: true, guarded };
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
		const { start, end } = effectiveCut(cut);
		const result = removeSpan(
			out,
			start,
			end,
			cut.consumeEnd === true,
			cut.siblingGuard !== false,
			cut.id,
			scope,
		);
		out = result.text;
		status[cut.id] = result.matched ? (result.guarded ? "guarded" : "applied") : "unmatched";
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
/** 上一次见到的原始提示词（供 /purge doctor 与未知段头探测用），不落盘。 */
let lastPrompt: { static: string; footer: string } | null = null;
/** 工具裁剪：omp 原生工具的完整名字表（首次裁剪时记下，用于还原）。 */
let toolsBeforeTrim: string[] | null = null;

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
	// 注意：anchorOverrides 不清 —— 它是跨会话的兼容层，只由 reanchor reset 清。
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
	// 可选能力：宿主不提供就静默跳过（老版本 omp 仍能跑核心提示词层）
	try {
		pi.setLabel?.("omp-purge");
	} catch {
		/* 忽略 */
	}

	// CLI flag（等价于环境变量，但可被 --flag 覆盖；两者都给时 flag 优先）
	try {
		pi.registerFlag?.("purge-mode", {
			description: "omp-purge 启动模式：strict | replace | append",
			type: "string",
		});
		pi.registerFlag?.("purge-on", {
			description: "omp-purge 启动即开启（等价 OMP_PURGE_AUTOSTART=1）",
			type: "boolean",
			default: false,
		});
		pi.registerFlag?.("purge-source", {
			description: "omp-purge 人设文件绝对路径（等价 OMP_PURGE_SOURCE）",
			type: "string",
		});
	} catch {
		/* 宿主不支持 flag 时忽略 */
	}

	const bootstrap = (): void => {
		// flag 优先于环境变量；都没有则用内置默认。
		const flagMode = String(pi.getFlag?.("purge-mode") ?? "").trim().toLowerCase();
		const flagSource = String(pi.getFlag?.("purge-source") ?? "").trim();
		const flagOn = pi.getFlag?.("purge-on");

		if (flagMode === "strict" || flagMode === "replace" || flagMode === "append") mode = flagMode;
		if (flagSource) source = flagSource;

		const autostart = flagOn === true || ENV_AUTOSTART;
		resetSessionState();
		// resetSessionState 会覆盖 mode/source，这里重新落在 flag 值上。
		if (flagMode === "strict" || flagMode === "replace" || flagMode === "append") mode = flagMode;
		if (flagSource) source = flagSource;

		loadAnchorOverrides();
		reload();
		if (autostart && body.length > 0) enabled = true;
	};

	// 每个会话独立：新会话 / 恢复会话 / 切换会话 / 热重载都从「关闭」开始
	pi.on("session_start", async (_event, ctx) => {
		toolsBeforeTrim = null;
		bootstrap();
		paint(ctx);
	});

	pi.on("session_switch", async (_event, ctx) => {
		toolsBeforeTrim = null;
		bootstrap();
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
		// 留一份原始文本供 /purge doctor 探测未知段头（内存，不落盘）
		lastPrompt = { static: staticBlocks.join("\n\n"), footer: footerBlocks.join("\n\n") };
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
			const values = [
				"on",
				"off",
				"status",
				"mode",
				"source",
				"cut",
				"preview",
				"reload",
				"doctor",
				"reanchor",
				"tools",
			];
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
				const tally = (want: CutStatus) =>
					lastRun ? Object.values(lastRun.status).filter(v => v === want).length : 0;
				const applied = tally("applied");
				const guarded = tally("guarded");
				const unmatched = tally("unmatched");
				return [
					`omp-purge ${PLUGIN_VERSION}  状态: ${enabled ? "开启" : "关闭"}（仅本会话）  模式: ${modeLabel}`,
					`人设: ${srcLabel}  ${body.length > 0 ? `${body.length} 字符` : `未加载${loadError ? `（${loadError}）` : ""}`}`,
					`上轮: ${run}`,
					lastRun
						? [
								`切除: applied ${applied} / guarded ${guarded} / unmatched ${unmatched} / skipped ${CUTS.length - applied - guarded - unmatched}`,
								guarded > 0
									? "  注意: guarded = 靠相邻段头收边，未命中自身结束锚点；可能连带切掉上游新增段落。用 /purge doctor 看重锚建议。"
									: "",
							]
								.filter(Boolean)
								.join("\n")
						: "",
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

				case "doctor": {
					// 锚点健康检查（对应 dsh-purge 的 selfcheck.js）
					if (!lastPrompt) {
						return notify(
							"还没有见过提示词，无法体检。先发一轮对话（/purge on 后随便问一句），或 /purge preview。",
							"error",
						);
					}
					const lines: string[] = [`锚点体检（宿主 ${HOST_TAG}）`];
					const text = lastPrompt.static;
					let healthy = 0;
					for (const cut of CUTS) {
						if ((cut.scope ?? "static") !== "static") continue;
						const { start } = effectiveCut(cut);
						if (start[0] === "\u0000PREAMBLE") {
							lines.push(`  ok        ${cut.id.padEnd(14)} （首部哨兵，恒可用）`);
							healthy += 1;
							continue;
						}
						const hit = start.some(m => text.split("\n").some(l => l.trimStart().startsWith(m)));
						const reanchored = anchorOverrides.has(cut.id) ? " [已重锚]" : "";
						lines.push(
							`  ${hit ? "ok      " : "MISS    "} ${cut.id.padEnd(14)} ${start.join(" | ")}${reanchored}`,
						);
						if (hit) healthy += 1;
					}
					const total = CUTS.filter(c => (c.scope ?? "static") === "static").length;
					lines.push(`静态侧: ${healthy}/${total} 命中`);

					const unknown = listUnknownHeaders(text);
					if (unknown.length > 0) {
						lines.push("", "宿主里有我们不认识的段头（可能是上游改名）:");
						for (const item of unknown.slice(0, 20)) {
							lines.push(`  L${item.lineNo}  ${item.line}`);
						}
						if (unknown.length > 20) lines.push(`  …另有 ${unknown.length - 20} 条`);
						lines.push("", "重锚示例: /purge reanchor WORKFLOW start <上面某个段头>");
					}
					return notify(lines.join("\n"), healthy === total ? "info" : "warning");
				}

				case "reanchor": {
					const sub = (rest[0] ?? "").toLowerCase();

					if (sub === "reset") {
						anchorOverrides.clear();
						try {
							if (existsSync(ANCHORS_PATH)) rmSync(ANCHORS_PATH, { force: true });
						} catch {
							/* 删不掉也不影响内存已清 */
						}
						return notify("已清空全部重锚（内存 + 落盘文件），回到内置锚点。");
					}

					if (sub === "save") {
						if (anchorOverrides.size === 0) {
							return notify("当前没有重锚可保存。", "error");
						}
						try {
							mkdirSync(dirname(ANCHORS_PATH), { recursive: true });
							const n = saveAnchorOverrides();
							return notify(`已把 ${n} 条重锚写入 ${ANCHORS_PATH}`);
						} catch (error) {
							return notify(
								`写盘失败: ${error instanceof Error ? error.message : String(error)}`,
								"error",
							);
						}
					}

					if (sub === "list" || sub === "") {
						if (anchorOverrides.size === 0) {
							return notify(`当前没有重锚。\n落盘路径: ${ANCHORS_PATH}`);
						}
						const rows = [...anchorOverrides.entries()].map(([id, ov]) => {
							const start = ov.start?.join(" | ") ?? "(内置)";
							const end = ov.end === undefined ? "(内置)" : ov.end === null ? "(切到块末尾)" : ov.end.join(" | ");
							return `  ${id.padEnd(14)} start=${start}  end=${end}`;
						});
						return notify([`重锚 ${anchorOverrides.size} 条:`, ...rows, `落盘路径: ${ANCHORS_PATH}`].join("\n"));
					}

					// /purge reanchor <ID> start|end <marker...>
					const id = (rest[0] ?? "").toUpperCase();
					const slot = (rest[1] ?? "").toLowerCase();
					const marker = rest.slice(2).join(" ").trim();

					if (!CUT_BY_ID.has(id)) {
						return notify(
							[
								"用法:",
								"  /purge reanchor <ID> start <段头标记>",
								"  /purge reanchor <ID> end <段头标记>",
								"  /purge reanchor <ID> end-to-block",
								"  /purge reanchor list | save | reset",
								`可用 ID: ${CUT_IDS.join(", ")}`,
							].join("\n"),
							"error",
						);
					}

					const cut = CUT_BY_ID.get(id)!;
					const current = anchorOverrides.get(id) ?? { at: new Date().toISOString(), host: HOST_TAG };

					if (slot === "start") {
						if (!marker) return notify("缺少起始标记。用法: /purge reanchor " + id + " start <段头>", "error");
						anchorOverrides.set(id, { ...current, start: [marker], at: new Date().toISOString(), host: HOST_TAG });
						return notify(
							`已把 ${id} 的起始锚点重锚为 "${marker}"（仅本会话）。\n/purge reanchor save 可持久化。\n${cutTable(mode)}`,
						);
					}

					if (slot === "end") {
						if (marker === "end-to-block") {
							anchorOverrides.set(id, { ...current, end: null, at: new Date().toISOString(), host: HOST_TAG });
							return notify(`已把 ${id} 的结束锚点设为「切到块末尾」（仅本会话）。`);
						}
						if (!marker) return notify(`缺少结束标记。用法: /purge reanchor ${id} end <段头>`, "error");
						anchorOverrides.set(id, { ...current, end: [marker], at: new Date().toISOString(), host: HOST_TAG });
						return notify(
							`已把 ${id} 的结束锚点重锚为 "${marker}"（仅本会话）。\n${cutTable(mode)}`,
						);
					}

					// 只给 ID 不给槽位 → 显示该项当前锚点
					const eff = effectiveCut(cut);
					return notify(
						[
							`${id}: ${cut.label}`,
							`  start: ${eff.start.join(" | ")}${anchorOverrides.has(id) ? "  [已重锚]" : ""}`,
							`  end  : ${eff.end === null ? "(切到块末尾)" : eff.end.join(" | ")}`,
						].join("\n"),
					);
				}

				case "tools": {
					// 工具裁剪（对应 dsh-purge 的 MINIMAL_OFFICIAL_TOOLSET）
					const sub = (rest[0] ?? "").toLowerCase();
					if (!pi.setActiveTools || !pi.getActiveTools) {
						return notify("当前 omp 版本没有暴露 setActiveTools，无法裁剪工具。", "error");
					}
					const current = pi.getActiveTools();
					if (sub === "" || sub === "list") {
						const all = pi.getAllTools?.().map(t => t.name) ?? [];
						const off = all.filter(name => !current.includes(name));
						return notify(
							[
								`当前启用 ${current.length} 个工具: ${current.join(", ")}`,
								off.length > 0 ? `未启用 ${off.length} 个: ${off.join(", ")}` : "",
								"",
								"用法: /purge tools keep a,b,c    只留这几个（其余全部停用）",
								"      /purge tools drop a,b     停用这几个",
								"      /purge tools reset        还原到首次裁剪前的集合",
								"注意: 裁剪在下一轮生效；不要在 before_agent_start 里调用 setActiveTools（会触发宿主重排准备链）。",
							]
								.filter(Boolean)
								.join("\n"),
						);
					}

					if (sub === "reset") {
						if (!toolsBeforeTrim) return notify("没有裁剪记录可还原。", "error");
						await pi.setActiveTools(toolsBeforeTrim);
						const restored = toolsBeforeTrim.length;
						toolsBeforeTrim = null;
						return notify(`已还原到 ${restored} 个工具。`);
					}

					const names = rest
						.slice(1)
						.join(" ")
						.split(/[,\s]+/)
						.map(s => s.trim())
						.filter(Boolean);

					if (names.length === 0) {
						return notify(`缺少工具名。用法: /purge tools ${sub} <name[,name...]>`, "error");
					}

					const all = pi.getAllTools?.().map(t => t.name) ?? current;
					const unknownNames = names.filter(name => !all.includes(name));
					if (unknownNames.length > 0) {
						return notify(`未知工具: ${unknownNames.join(", ")}\n可用: ${all.join(", ")}`, "error");
					}

					const next =
						sub === "keep"
							? all.filter(name => names.includes(name))
							: current.filter(name => !names.includes(name));

					if (next.length === 0) {
						return notify("结果为空集合，拒绝执行（会把所有工具都停掉）。", "error");
					}

					if (!toolsBeforeTrim) toolsBeforeTrim = [...current];
					await pi.setActiveTools(next);
					return notify(`已把启用工具设为 ${next.length} 个: ${next.join(", ")}`);
				}

				default:
					return notify(
						`未知子命令: ${cmd}\n用法: /purge [on|off|status|mode|source|cut|preview|reload|doctor|reanchor|tools]`,
						"error",
					);
			}
		},
	});
}

// 供测试直接复用纯函数（不影响 omp 加载时的默认导出）
export {
	applyCuts,
	activeCuts,
	removeSpan,
	CUTS,
	CUT_IDS,
	isFooterBlock,
	EMBEDDED_PERSONA,
	DEFAULT_SOURCE,
	effectiveCut,
	listUnknownHeaders,
	loadAnchorOverrides,
	anchorOverrides,
	ANCHORS_PATH,
	HOST_TAG,
	PLUGIN_VERSION,
};
