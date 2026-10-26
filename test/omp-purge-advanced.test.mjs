// 进阶能力测试：重锚（reanchor）、锚点体检（doctor）、工具裁剪（tools）、CLI flag。
//
// 与 omp-purge.test.mjs 的分工：
//   那个文件验证三模式与切除表本身；这里只验证 v0.2 新增的四个能力面。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 环境变量在模块加载时读取（且 ANCHORS_PATH 由 OMP_PURGE_ANCHORS 决定），
// 必须在任何 import 之前固定下来，否则用例会读到作者本机的真实覆盖文件。
const ANCHOR_DIR = mkdtempSync(join(tmpdir(), "omp-purge-anchor-"));
const ANCHOR_FILE = join(ANCHOR_DIR, "anchor-overrides.json");
for (const key of ["OMP_PURGE_SOURCE", "OMP_PURGE_MODE", "OMP_PURGE_AUTOSTART"]) {
	delete process.env[key];
}
process.env.OMP_PURGE_ANCHORS = ANCHOR_FILE;

const EXT_URL = pathToFileURL(join(import.meta.dirname, "..", "extensions", "omp-purge.ts")).href;

// ------------------------------------------------------------------ 夹具
// 与真实 omp 18.12.6 渲染结果同构：段头齐全，正文压缩。
function staticBlock({ renameWorkflow = false } = {}) {
	return [
		"RFC 2119 keywords: MUST, REQUIRED, SHOULD.",
		"",
		"§ Role",
		"You are omp's trusted coding assistant.",
		"",
		"# Engineering",
		"- Correctness first.",
		"",
		"# Personality",
		"Pragmatic engineer.",
		"",
		"§ Runtime",
		"# Skills & Rules",
		"<skills>",
		"- agent-reach",
		"</skills>",
		"# Internal URLs",
		"- `omp://`",
		"# Tool Inventory",
		"- Read: `read`",
		"# xd:// Tool Devices",
		"JSON args.",
		"§ Tool Policy",
		"# General",
		"- Narrow tools.",
		renameWorkflow ? "§ Process" : "§ Workflow",
		"# 1. Scope",
		"- Scope it.",
		"§ Delivery",
		"<contract>",
		"- Deliver.",
		"</contract>",
		"§ Critical",
		"<critical>",
		"- NEVER stop early.",
		"</critical>",
	].join("\n");
}

function footerBlock() {
	return [
		"<project-context>",
		"<repo-rules>",
		"## 项目规则",
		"- 保持同步。",
		"</repo-rules>",
		"</project-context>",
		"",
		"<critical>",
		"- Each response MUST advance.",
		"</critical>",
	].join("\n");
}

/** 全新模块实例 + 可注入 flag/工具能力的假宿主。 */
async function freshExtension({ flags = {}, tools = null } = {}) {
	const url = `${EXT_URL}?t=${Date.now()}-${Math.random()}`;
	const mod = await import(url);

	const events = new Map();
	const commands = new Map();
	const notes = [];
	const statuses = [];
	const flagDefs = new Map();

	let activeTools = tools ? [...tools] : [];
	const setActiveCalls = [];

	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, options) => commands.set(name, options),
		registerFlag: (name, options) => flagDefs.set(name, options),
		getFlag: (name) => flags[name],
		setLabel: () => {},
	};
	if (tools) {
		pi.getActiveTools = () => [...activeTools];
		pi.getAllTools = () => activeTools.map((name) => ({ name }));
		pi.setActiveTools = async (names) => {
			setActiveCalls.push([...names]);
			activeTools = [...names];
		};
	}

	mod.default(pi);

	const ctx = {
		cwd: "/Users/example/demo-repo",
		ui: {
			notify: (message, level) => notes.push({ level, message }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
	};

	const fire = (event) => events.get(event.type)(event, ctx);
	const run = (args) => commands.get("purge").handler(args, ctx);
	const prompt = (opts) => ({
		type: "before_agent_start",
		prompt: "hi",
		systemPrompt: [staticBlock(opts), footerBlock()],
	});
	const lastNote = () => notes[notes.length - 1]?.message ?? "";

	return { mod, events, commands, notes, statuses, flagDefs, ctx, fire, run, prompt, lastNote, setActiveCalls, getActiveTools: () => activeTools };
}

// ================================================================== flag 注册
{
	const { flagDefs } = await freshExtension();
	assert.ok(flagDefs.has("purge-mode"), "注册 purge-mode flag");
	assert.ok(flagDefs.has("purge-on"), "注册 purge-on flag");
	assert.ok(flagDefs.has("purge-source"), "注册 purge-source flag");
	assert.equal(flagDefs.get("purge-mode").type, "string");
	assert.equal(flagDefs.get("purge-on").type, "boolean");
}

// ================================================================== flag 优先于环境变量
{
	// 环境变量没设，flag 给 replace + 立即开启
	const { fire, prompt } = await freshExtension({ flags: { "purge-mode": "replace", "purge-on": true } });
	await fire({ type: "session_start" });
	const res = await fire(prompt());
	assert.ok(res, "purge-on flag 应让会话启动即开启");
	const joined = res.systemPrompt.join("\n");
	assert.ok(!/You are omp's trusted coding assistant/.test(joined), "replace 模式应切掉宿主身份");
	assert.ok(/§ Workflow/.test(joined), "replace 模式应保留 workflow");
}

{
	// 没有 flag 也没有环境变量 → 默认关闭
	const { fire, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	assert.equal(await fire(prompt()), undefined, "无 flag 无 env 时默认关闭");
}

// ================================================================== effectiveCut 与内置锚点
{
	const { mod } = await freshExtension();
	const role = mod.CUTS.find((c) => c.id === "ROLE_SECTION");
	const eff = mod.effectiveCut(role);
	assert.deepEqual(eff.start, role.start, "无覆盖时 effectiveCut 返回内置 start");
	assert.deepEqual(eff.end, role.end, "无覆盖时 effectiveCut 返回内置 end");
}

// ================================================================== 未知段头探测
{
	const { mod } = await freshExtension();
	const unknown = mod.listUnknownHeaders(staticBlock({ renameWorkflow: true }));
	const lines = unknown.map((u) => u.line);
	assert.ok(lines.includes("§ Process"), "应报出被改名的 § Process");
	assert.ok(!lines.includes("§ Role"), "已认识的 § Role 不该报出");
	assert.ok(!lines.includes("# 1. Scope"), "带序号的段内小标题不该报出");
}

// ================================================================== reanchor 生效（内存内）
{
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	// 用 replace 而不是 strict：strict 会把整块静态提示词丢掉，
	// 那样「§ Process 是否存活」根本观察不到。
	await run("mode replace");
	// replace 下 TOOL_POLICY / WORKFLOW 默认不切，用 cut 命令手动打开才能观察边界。
	await run("cut TOOL_POLICY cut");
	await run("cut WORKFLOW cut");

	// 宿主把 § Workflow 改名成 § Process。
	// 此时 TOOL_POLICY 的结束锚点（§ Workflow）失效，靠兄弟护栏在 § Delivery 前收边 ——
	// 边界安全，但连带吃掉了没人认领的 § Process，所以状态必须是 guarded 而不是 applied。
	const before = await fire(prompt({ renameWorkflow: true }));
	assert.equal(before.systemPrompt.length > 0, true);
	assert.ok(!before.systemPrompt.join("\n").includes("§ Role"), "replace 模式下身份段仍被切");

	// 把边界重锚到新名字 → TOOL_POLICY 重新命中自己的结束锚点
	await run("reanchor TOOL_POLICY end § Process");
	await run("reanchor WORKFLOW start § Process");
	await run("reanchor WORKFLOW end § Delivery");

	const after = await fire(prompt({ renameWorkflow: true }));
	const afterText = after.systemPrompt.join("\n");
	assert.ok(!afterText.includes("§ Process"), "重锚后 § Process 仍被切（这次是命中锚点）");
	assert.ok(!afterText.includes("# 1. Scope"), "重锚后其子段也应一起切掉");
	assert.ok(afterText.includes("§ Delivery"), "§ Delivery 不应被误切");
}

// ================================================================== guarded 状态：兄弟护栏收边要如实报告
{
	const { mod } = await freshExtension();
	const text = staticBlock({ renameWorkflow: true });

	// 无覆盖：TOOL_POLICY 找不到 § Workflow，靠 § Delivery 兄弟护栏收边 → guarded
	const guardedRun = mod.applyCuts(text, new Set(["TOOL_POLICY"]), "static");
	assert.equal(
		guardedRun.status.TOOL_POLICY,
		"guarded",
		"靠兄弟护栏收边必须报 guarded，不能谎报 applied",
	);
	assert.ok(!guardedRun.text.includes("§ Process"), "护栏收边确实切掉了未认领的 § Process（这正是要暴露的风险）");

	// 重锚后：命中自己的结束锚点 → applied
	mod.anchorOverrides.set("TOOL_POLICY", { end: ["§ Process"], at: "t", host: "test" });
	const exactRun = mod.applyCuts(text, new Set(["TOOL_POLICY"]), "static");
	assert.equal(exactRun.status.TOOL_POLICY, "applied", "命中自己的结束锚点报 applied");
	mod.anchorOverrides.clear();

	// 起始锚点彻底失踪 → unmatched，文本一字不动
	const goneRun = mod.applyCuts(text, new Set(["WORKFLOW"]), "static");
	assert.equal(goneRun.status.WORKFLOW, "unmatched");
	assert.ok(goneRun.text.includes("# 1. Scope"), "unmatched 时文本必须保持原样");
}

// ================================================================== reanchor 直接作用于 applyCuts
{
	const { mod } = await freshExtension();
	const text = staticBlock({ renameWorkflow: true });

	mod.anchorOverrides.set("TOOL_POLICY", { end: ["§ Process"], at: "t", host: "test" });
	mod.anchorOverrides.set("WORKFLOW", { start: ["§ Process"], end: ["§ Delivery"], at: "t", host: "test" });
	const fixed = mod.applyCuts(text, new Set(["TOOL_POLICY", "WORKFLOW"]), "static");
	assert.equal(fixed.status.TOOL_POLICY, "applied");
	assert.equal(fixed.status.WORKFLOW, "applied");
	assert.ok(!fixed.text.includes("§ Process"), "重锚后应被切除");
	mod.anchorOverrides.clear();
}

// ================================================================== reanchor list / save / reset
{
	const { fire, run, mod, lastNote } = await freshExtension();
	await fire({ type: "session_start" });

	await run("reanchor list");
	assert.ok(lastNote().includes("当前没有重锚"), `空态应明说，实际: ${lastNote()}`);

	await run("reanchor WORKFLOW start § Process");
	await run("reanchor list");
	assert.ok(lastNote().includes("WORKFLOW"), "list 应列出 WORKFLOW");
	assert.ok(lastNote().includes("§ Process"), "list 应显示覆盖后的锚点");

	// save 是唯一写盘入口
	assert.ok(!existsSync(ANCHOR_FILE), "save 之前不应写盘");
	await run("reanchor save");
	assert.ok(existsSync(ANCHOR_FILE), "save 之后应写盘");

	await run("reanchor reset");
	assert.ok(!existsSync(ANCHOR_FILE), "reset 应删掉落盘文件");
	await run("reanchor list");
	assert.ok(lastNote().includes("当前没有重锚"), "reset 后应回到空态");
}

// ================================================================== reanchor 参数校验
{
	const { fire, run, lastNote } = await freshExtension();
	await fire({ type: "session_start" });

	await run("reanchor NOPE start § X");
	assert.ok(lastNote().includes("可用 ID"), "未知 ID 应列出可用 ID");

	await run("reanchor WORKFLOW start");
	assert.ok(lastNote().includes("缺少起始标记"), "缺 marker 应报错");
}

// ================================================================== 落盘覆盖在加载时被读取
{
	// 先写一份覆盖文件，再起新模块实例，验证 loadAnchorOverrides 生效
	writeFileSync(
		ANCHOR_FILE,
		JSON.stringify(
			{
				version: 1,
				overrides: {
					WORKFLOW: { start: ["§ Process"], at: "2026-01-01T00:00:00.000Z", host: "test" },
					BOGUS_ID: { start: ["§ Whatever"], at: "2026-01-01T00:00:00.000Z" },
				},
			},
			null,
			"\t",
		),
		"utf8",
	);

	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode strict");

	const res = await fire(prompt({ renameWorkflow: true }));
	const text = res.systemPrompt.join("\n");
	assert.ok(!text.includes("§ Process"), "落盘覆盖应在 session_start 时自动加载并生效");

	// 未知 id 应被忽略而不是让加载失败
	const { mod } = await freshExtension();
	assert.ok(!mod.anchorOverrides.has("BOGUS_ID"), "未知 cut id 的覆盖应被忽略");

	writeFileSync(ANCHOR_FILE, "{}", "utf8");
}

// ================================================================== 损坏的覆盖文件不该炸
{
	writeFileSync(ANCHOR_FILE, "{ this is not json", "utf8");
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	const res = await fire(prompt());
	assert.ok(res, "覆盖文件损坏时扩展仍应正常工作（静默忽略）");
	writeFileSync(ANCHOR_FILE, "{}", "utf8");
}

// ================================================================== doctor
{
	const { fire, run, lastNote } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("doctor");
	assert.ok(lastNote().includes("还没有见过提示词"), "未跑过一轮时 doctor 应明说无法体检");

	await fire(({
		type: "before_agent_start",
		prompt: "hi",
		systemPrompt: [staticBlock({ renameWorkflow: true }), footerBlock()],
	}));
	await run("doctor");
	const report = lastNote();
	assert.ok(report.includes("锚点体检"), "doctor 应报体检标题");
	assert.ok(report.includes("命中"), "doctor 应报命中统计");
	assert.ok(report.includes("§ Process"), "doctor 应指出未知段头 § Process");
	assert.ok(!report.includes("MISS    ROLE_SECTION"), "ROLE_SECTION 应命中");
}

// ================================================================== 工具裁剪
{
	const TOOLS = ["read", "bash", "edit", "write", "grep", "glob", "todo", "web_search"];
	const { fire, run, lastNote, setActiveCalls, getActiveTools } = await freshExtension({ tools: TOOLS });
	await fire({ type: "session_start" });

	await run("tools list");
	assert.ok(lastNote().includes("当前启用 8 个工具"), `应报当前工具数，实际: ${lastNote()}`);

	await run("tools keep read,bash,todo");
	assert.deepEqual(getActiveTools(), ["read", "bash", "todo"], "keep 应只留指定工具");
	assert.equal(setActiveCalls.length, 1);

	await run("tools drop bash");
	assert.deepEqual(getActiveTools(), ["read", "todo"], "drop 应移除指定工具");

	await run("tools reset");
	assert.deepEqual(getActiveTools(), TOOLS, "reset 应还原到首次裁剪前");

	// 安全性：空集合应被拒绝
	await run("tools keep nonexistent-tool");
	assert.ok(lastNote().includes("未知工具"), "未知工具名应报错");
}

{
	// 拒绝把工具全停掉
	const TOOLS = ["read", "bash"];
	const { fire, run, lastNote, getActiveTools } = await freshExtension({ tools: TOOLS });
	await fire({ type: "session_start" });
	await run("tools drop read,bash");
	assert.deepEqual(getActiveTools(), TOOLS, "全停应被拒绝");
	assert.ok(lastNote().includes("拒绝执行") || lastNote().includes("未知工具"), `应拒绝，实际: ${lastNote()}`);
}

{
	// 宿主不提供 setActiveTools 时应优雅降级
	const { fire, run, lastNote } = await freshExtension();
	await fire({ type: "session_start" });
	await run("tools list");
	assert.ok(lastNote().includes("没有暴露 setActiveTools"), "缺能力时应明说而不是崩");
}

// ================================================================== HOST_TAG
{
	const { mod } = await freshExtension();
	assert.equal(typeof mod.HOST_TAG, "string");
	assert.ok(mod.HOST_TAG.length > 0, "HOST_TAG 始终有值（取不到时是 unknown）");
}

// ============================================================ 版本一致性
{
	// 硬编码版本的风险是忘记 bump：这里让 package.json 与源码互相盯着。
	// 版本号本身也是 /purge status 的第一行，用户靠它判断当前进程加载的代码是新的。
	const { mod } = await freshExtension();
	const pkg = JSON.parse(
		readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8"),
	);
	assert.equal(
		mod.PLUGIN_VERSION,
		pkg.version,
		`package.json (${pkg.version}) 与 PLUGIN_VERSION (${mod.PLUGIN_VERSION}) 必须一致`,
	);
	assert.match(mod.PLUGIN_VERSION, /^\d+\.\d+\.\d+$/, "版本号应是 semver");

	// status 第一行必须带版本，否则用户无法判断进程里装的是哪一版
	const { fire, run, lastNote } = await freshExtension();
	await fire({ type: "session_start" });
	await run("status");
	assert.ok(
		lastNote().includes(`omp-purge ${mod.PLUGIN_VERSION}`),
		`status 应显示版本，实际: ${lastNote()}`,
	);
}

// ========================================================== 幂等（重复加载）
{
	// omp 不按 realpath 去重：软链自动发现 + `-e` 指向同一文件时，factory 会跑两次，
	// 两个 handler 串联执行。若不幂等，append 模式下人设会插两次（真实实测 4 块）。
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("mode append");
	await run("on");

	const first = (await fire(prompt())).systemPrompt;
	assert.equal(first.length, 3, "单次执行：static + persona + footer");
	assert.equal(first[1], first[1].trim(), "人设块应是 trim 过的正文");

	// 把上一次的输出当输入再跑一遍 —— 等价于第二个 handler 接收第一个的输出。
	// 返回 undefined 就是「不改写」，宿主保留上游结果，正是幂等。
	const secondResult = await fire({ ...prompt(), systemPrompt: [...first] });
	assert.equal(secondResult, undefined, "重复执行应返回 undefined（不改写）");
	const after = secondResult?.systemPrompt ?? [...first];
	assert.equal(
		after.filter((b) => b === first[1]).length,
		1,
		"人设块必须只有一份，不能被插入第二次",
	);

	// strict 模式同理
	const s2 = await freshExtension();
	await s2.fire({ type: "session_start" });
	await s2.run("mode strict");
	await s2.run("on");
	const strictFirst = (await s2.fire(s2.prompt())).systemPrompt;
	const strictSecond = await s2.fire({ ...s2.prompt(), systemPrompt: [...strictFirst] });
	assert.equal(strictSecond, undefined, "strict 重复执行同样必须幂等");
}

console.log("omp-purge-advanced.test.mjs: all assertions passed");
