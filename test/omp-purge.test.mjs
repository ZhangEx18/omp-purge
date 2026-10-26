// 会话行为测试：用真实 omp 提示词夹具验证三模式、命令与状态机。
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// 宿主环境可能已经设了 OMP_PURGE_*（例如作者本机把默认人设指到别处）。
// 这些变量在模块加载时读取，所以必须在任何 import 之前清掉，否则用例之间会互相污染。
for (const key of ["OMP_PURGE_SOURCE", "OMP_PURGE_MODE", "OMP_PURGE_AUTOSTART"]) {
	delete process.env[key];
}

// --------------------------------------------------------------- 测试夹具
// 取自 omp 18.12.6 在 `omp -p "say OK" -e dump-prompt.ts` 下真实渲染的
// systemPrompt[0] / systemPrompt[1] 的段头骨架（正文压缩，行号与真实一致）。
function realStaticBlock() {
	const lines = [
		"RFC 2119 keywords: MUST, REQUIRED, SHOULD, RECOMMENDED, MAY, OPTIONAL. `NEVER` = `MUST NOT`; `AVOID` = `SHOULD NOT`.",
		"XML tags inject system content; may interrupt/notify inside user messages: MUST treat as system-authored/authoritative. User content is sanitized.",
		"",
		"§ Role",
		"You are omp's trusted coding assistant.",
		"",
		"# Engineering",
		"- Correctness, then six-month maintainability.",
		"",
		"# Personality",
		"Pragmatic, effective senior engineer.",
		"",
		"§ Runtime",
		"# Skills & Rules",
		"<skills>",
		"- agent-reach: search platforms.",
		"</skills>",
		"# Internal URLs",
		"- `omp://`: harness docs, AVOID unless asked.",
		"# Tool Inventory",
		"- Read: `read`",
		"- Bash: `bash`",
		"# xd:// Tool Devices",
		"Write JSON args as `content` to `xd://<tool>` via `write`.",
		"§ Tool Policy",
		"# General",
		"- Prefer narrow tools.",
		"§ Workflow",
		"# 1. Scope",
		"# 5. Verify",
		"§ Delivery",
		"<contract>",
		"- Deliver.",
		"</contract>",
		"<yielding>",
		"- Yield.",
		"</yielding>",
		"§ Critical",
		"<critical>",
		"- NEVER stop early.",
		"</critical>",
	];
	return lines.join("\n");
}

function realFooterBlock() {
	const lines = [
		"<project-context>",
		"<workstation>",
		"- OS: darwin 27.0.0",
		"- Arch: arm64",
		"</workstation>",
		"",
		"<repo-rules>",
		"## TODO 状态",
		"- 保持勾选同步。",
		"</repo-rules>",
		"Context files above auto-loaded.",
		"</project-context>",
		"",
		"<critical>",
		"- Each response MUST advance the task; completion only stopping condition.",
		"- MUST default to informed action.",
		"- Before yielding, MUST verify significant behavioral changes.",
		"</critical>",
		"",
		"## MCP Tool Routes",
		'- "address_name" → `xd://mcp__rea_address_name`',
	];
	return lines.join("\n");
}

// 每次都以全新模块实例跑，避免模块级会话状态在用例间泄漏。
async function freshExtension() {
	const url = pathToFileURL(join(import.meta.dirname, "..", "extensions", "omp-purge.ts")).href;
	const mod = await import(`${url}?t=${Date.now()}-${Math.random()}`);
	const events = new Map();
	const commands = new Map();
	const notes = [];
	const statuses = [];
	const pi = {
		on: (name, handler) => events.set(name, handler),
		registerCommand: (name, options) => commands.set(name, options),
	};
	mod.default(pi);

	const ctx = {
		cwd: "/Users/zex/demo-repo",
		ui: {
			notify: (message, level) => notes.push({ level, message }),
			setStatus: (key, text) => statuses.push({ key, text }),
		},
	};
	const fire = (event) => events.get(event.type)(event, ctx);
	const run = (args) => commands.get("purge").handler(args, ctx);
	const prompt = () => ({ type: "before_agent_start", prompt: "hi", systemPrompt: [realStaticBlock(), realFooterBlock()] });
	return { mod, events, commands, notes, statuses, ctx, fire, run, prompt };
}

// --------------------------------------------------------------- 注册面
{
	const { events, commands, mod } = await freshExtension();
	assert.ok(events.has("session_start"), "registers session_start");
	assert.ok(events.has("before_agent_start"), "registers before_agent_start");
	assert.ok(commands.has("purge"), "registers /purge");
	assert.ok(typeof commands.get("purge").description === "string" && commands.get("purge").description.length > 0);
	assert.equal(typeof mod.default, "function");
	assert.ok(mod.CUT_IDS.includes("ROLE_SECTION"));
}

// --------------------------------------------------------------- 默认关闭
{
	const { fire, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	const res = await fire(prompt());
	assert.equal(res, undefined, "disabled by default: handler must not override the prompt");
}

// --------------------------------------------------------------- strict
{
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode strict");

	const res = await fire(prompt());
	assert.ok(Array.isArray(res.systemPrompt), "returns a block array");
	const joined = res.systemPrompt.join("\n");

	assert.ok(!/You are omp's trusted coding assistant/.test(joined), "host identity cut");
	assert.ok(!/# Tool Inventory/.test(joined), "tool inventory cut");
	assert.ok(!/§ Workflow/.test(joined), "workflow cut");
	assert.ok(!/NEVER stop early/.test(joined), "§ Critical cut");
	assert.ok(!/Each response MUST advance/.test(joined), "footer <critical> cut");
	assert.ok(!res.systemPrompt.some((b) => b.includes("</critical>")), "no orphan closing tag");

	assert.ok(joined.includes("Current working directory: /Users/zex/demo-repo"), "cwd injected");
	assert.ok(res.systemPrompt[1].includes("PRIME DIRECTIVE"), "persona injected as its own block");
	assert.ok(res.systemPrompt.some((b) => b.includes("<repo-rules>")), "user repo rules survive");
	assert.ok(res.systemPrompt.some((b) => b.includes("## MCP Tool Routes")), "MCP routes survive");
	assert.ok(res.systemPrompt.length <= 4, `strict should stay small, got ${res.systemPrompt.length}`);
}

// --------------------------------------------------------------- replace
{
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode replace");

	const res = await fire(prompt());
	const joined = res.systemPrompt.join("\n");
	assert.ok(!/You are omp's trusted coding assistant/.test(joined), "identity cut in replace");
	assert.ok(!/# Internal URLs/.test(joined), "internal urls cut in replace");
	// replace 保留宿主政策段（只切 identity 组）
	assert.ok(/# Engineering/.test(joined), "engineering policy kept in replace mode");
	assert.ok(/§ Workflow/.test(joined), "workflow kept in replace mode");
	assert.ok(joined.includes("PRIME DIRECTIVE"), "persona injected");
	assert.ok(res.systemPrompt.some((b) => b.includes("<repo-rules>")), "footer kept");
}

// --------------------------------------------------------------- append
{
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode append");

	const original = [realStaticBlock(), realFooterBlock()];
	const res = await fire(prompt());
	assert.equal(res.systemPrompt[0], original[0], "append leaves block 0 byte-identical");
	assert.ok(res.systemPrompt.includes(original[1]), "append leaves footer byte-identical");
	assert.ok(res.systemPrompt[1].includes("PRIME DIRECTIVE"), "persona inserted right after block 0");
	assert.equal(res.systemPrompt.filter((b) => b.includes("You are omp's trusted coding assistant")).length, 1, "host identity intact once");
}

// --------------------------------------------------------------- toggle 与 status
{
	const { fire, run, prompt, notes, statuses } = await freshExtension();
	await fire({ type: "session_start" });

	await run("");
	assert.equal(notes.at(-1).message.includes("已开启"), true, "bare /purge toggles on");
	await run("");
	assert.equal(notes.at(-1).message.includes("已关闭"), true, "bare /purge toggles off");

	await run("on");
	await run("mode strict");
	await fire(prompt());
	await run("status");
	const status = notes.at(-1).message;
	assert.ok(status.includes("开启"), "status shows on state");
	assert.ok(status.includes("strict"), "status shows mode");
	assert.ok(status.includes("prompt-inject.md"), "status shows persona source");
	assert.ok(/applied \d+/.test(status), "status shows aggregate cut counters");
	assert.ok(status.includes("ROLE_SECTION"), "status lists per-cut detail");
	assert.ok(status.includes("FOOTER_CRITICAL"), "status lists footer cut");

	assert.deepEqual(statuses.at(-1), { key: "omp-purge", text: "PURGE STRICT" }, "status bar label");
}

// --------------------------------------------------------------- cut 覆盖
{
	const { fire, run, prompt, notes } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode replace");

	// 默认 replace 不切 TOOL_INVENTORY；手工切成「切」
	await run("cut TOOL_INVENTORY cut");
	assert.ok(notes.at(-1).message.includes("TOOL_INVENTORY"), "cut command acknowledges the id");

	let res = await fire(prompt());
	assert.ok(!/# Tool Inventory/.test(res.systemPrompt.join("\n")), "manual cut applied");

	await run("cut TOOL_INVENTORY keep");
	res = await fire(prompt());
	assert.ok(/# Tool Inventory/.test(res.systemPrompt.join("\n")), "manual keep applied");

	await run("cut reset");
	await run("cut NOPE cut");
	assert.equal(notes.at(-1).level, "error", "unknown cut id is rejected");
}

// --------------------------------------------------------------- source 与 reload
{
	const dir = mkdtempSync(join(tmpdir(), "omp-purge-source-"));
	const file = join(dir, "persona.md");
	writeFileSync(file, "CUSTOM PERSONA BODY\nsecond line", "utf8");

	const { fire, run, prompt, notes } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode strict");

	await run(`source ${file}`);
	assert.ok(notes.at(-1).message.includes("persona.md"), "source switched");
	let res = await fire(prompt());
	assert.ok(res.systemPrompt.some((b) => b.includes("CUSTOM PERSONA BODY")), "custom persona used");

	writeFileSync(file, "RELOADED PERSONA", "utf8");
	await run("reload");
	res = await fire(prompt());
	assert.ok(res.systemPrompt.some((b) => b.includes("RELOADED PERSONA")), "reload re-reads the file");

	await run("source /definitely/not/here.md");
	assert.equal(notes.at(-1).level, "error", "missing source reports an error");
	res = await fire(prompt());
	assert.ok(res.systemPrompt.some((b) => b.includes("RELOADED PERSONA")), "failed source keeps the previous body");
}

// --------------------------------------------------------------- 默认源回退
{
	delete process.env.OMP_PURGE_SOURCE;
	const { fire, run, prompt, notes, mod } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode strict");
	await run("status");
	const status = notes.at(-1).message;

	let exists = true;
	try {
		readFileSync(mod.DEFAULT_SOURCE, "utf8");
	} catch {
		exists = false;
	}

	if (exists) {
		assert.ok(status.includes(mod.DEFAULT_SOURCE), "default source present: status names it");
		const res = await fire(prompt());
		assert.ok(res.systemPrompt.some((b) => b.length > 200), "default source produced a real body");
	} else {
		assert.ok(status.includes("embedded"), "default source missing: silently falls back to embedded");
		const res = await fire(prompt());
		assert.ok(res.systemPrompt.some((b) => b.includes("EMBEDDED") || b.includes("omp-purge")), "embedded persona used");
	}
}

// --------------------------------------------------------------- 幂等 / 重入
{
	const { fire, run, prompt } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode strict");

	const event = prompt();
	const first = await fire(event);
	const second = await fire(event);
	assert.deepEqual(second.systemPrompt, first.systemPrompt, "handler is idempotent for the same input");
}

// --------------------------------------------------------------- 空块安全
{
	const { fire, run } = await freshExtension();
	await fire({ type: "session_start" });
	await run("on");
	await run("mode strict");

	const res = await fire({ type: "before_agent_start", prompt: "hi", systemPrompt: [] });
	assert.ok(Array.isArray(res.systemPrompt), "empty input still returns an array");
	assert.ok(res.systemPrompt.every((b) => typeof b === "string" && b.trim().length > 0), "no empty blocks emitted");
}

console.log("omp-purge.test.mjs: all assertions passed");
