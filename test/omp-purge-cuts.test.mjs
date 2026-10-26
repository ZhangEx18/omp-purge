// 锚点切除单元测试：只验证 removeSpan / applyCuts 的边界语义，不碰会话状态。
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const mod = await import(
	pathToFileURL(join(import.meta.dirname, "..", "extensions", "omp-purge.ts")).href
);
const { CUTS, CUT_IDS, applyCuts, removeSpan, isFooterBlock } = mod;

// ---------------------------------------------------------------- removeSpan

{
	const text = ["alpha", "§ Role", "You are omp's trusted coding assistant.", "", "# Engineering", "beta"].join("\n");
	const out = removeSpan(text, ["§ Role"], ["# Engineering"]);
	assert.equal(out.matched, true);
	// 开区间：结束标记行 # Engineering 必须留在文本里
	assert.ok(out.text.includes("# Engineering"), "open interval keeps the end marker line");
	assert.ok(!out.text.includes("§ Role"), "start marker removed");
	assert.ok(!out.text.includes("trusted coding assistant"), "role body removed");
	assert.ok(out.text.includes("alpha"));
}

{
	// 闭区间：<critical> … </critical> 连结束标记一起吃掉，不留孤立闭合标签
	const text = ["keep-1", "<critical>", "- rule a", "- rule b", "</critical>", "keep-2"].join("\n");
	const out = removeSpan(text, ["<critical>"], ["</critical>"], true);
	assert.equal(out.matched, true);
	assert.ok(!out.text.includes("<critical>"), "opening tag removed");
	assert.ok(!out.text.includes("</critical>"), "closing tag removed too (consumeEnd)");
	assert.ok(!out.text.includes("rule a"));
	assert.ok(out.text.includes("keep-1") && out.text.includes("keep-2"));
}

{
	// 同文本、不消费结束标记 → 与闭区间形成对照
	const text = ["<critical>", "body", "</critical>"].join("\n");
	const open = removeSpan(text, ["<critical>"], ["</critical>"], false);
	assert.ok(open.text.includes("</critical>"), "without consumeEnd the closing tag survives");
}

{
	// 匹配不到必须原样返回（pi-purge 的失败安全退化契约）
	const text = "no anchors here at all";
	const out = removeSpan(text, ["§ Nothing"], null);
	assert.equal(out.matched, false);
	assert.equal(out.text, text, "unmatched span leaves text byte-identical");
}

{
	// 声明了结束标记却一个都没命中 → 必须放弃该 cut，绝不允许「切到末尾」。
	// 这是 v0.1.1 修的 bug：曾把整块提示词从 112KB 静默吃到 61 字符。
	const text = ["head", "§ Workflow", "1. Scope", "2. Research", "still text"].join("\n");
	const out = removeSpan(text, ["§ Workflow"], ["§ Delivery"]);
	assert.equal(out.matched, false, "missing end marker degrades, never swallows the rest");
	assert.equal(out.text, text, "text must stay byte-identical when the end marker is absent");
}

{
	// null 才是声明式 to-end：只有显式写 end: null 的项才切到块末尾
	const text = ["head", "§ Critical", "everything after goes"].join("\n");
	const out = removeSpan(text, ["§ Critical"], null);
	assert.equal(out.matched, true);
	assert.ok(!out.text.includes("everything after goes"));
	assert.ok(out.text.includes("head"));
}

{
	// 兄弟护栏：结束标记被改名，但先撞到下一个段的起点 → 切到该起点，而不是吃穿
	const text = ["§ Workflow", "1. Scope", "§ Delivery", "<contract>", "body"].join("\n");
	const out = removeSpan(text, ["§ Workflow"], ["§ RenamedAway"], false, true);
	assert.equal(out.matched, true, "sibling guard supplies a trustworthy boundary");
	assert.ok(!out.text.includes("1. Scope"), "own section removed");
	assert.ok(out.text.includes("§ Delivery"), "sibling section preserved");
}

{
	// HOST_PREAMBLE 哨兵：切掉首个 §/# 段头之前的一切
	const text = ["preamble line", "another", "§ Role", "body"].join("\n");
	const out = removeSpan(text, ["\u0000PREAMBLE"], null);
	assert.equal(out.matched, true);
	assert.ok(out.text.startsWith("§ Role"), `preamble stripped, got: ${JSON.stringify(out.text.slice(0, 20))}`);
	assert.ok(!out.text.includes("preamble line"));
}

{
	// 文本本身以段头开头 → 没有 preamble 可切，应报 unmatched 而不是切坏
	const text = ["§ Role", "body"].join("\n");
	const out = removeSpan(text, ["\u0000PREAMBLE"], null);
	assert.equal(out.matched, false);
	assert.equal(out.text, text);
}

// ---------------------------------------------------------------- applyCuts

{
	// 未启用的 cut 标 skipped 且不动文本
	const text = ["§ Role", "id", "# Engineering", "eng", "§ Workflow", "wf"].join("\n");
	const out = applyCuts(text, new Set(), "static");
	assert.equal(out.text.includes("§ Role"), true);
	for (const id of CUT_IDS) {
		if (id === "FOOTER_CRITICAL") continue; // footer 作用域，static 轮次不参与
		assert.equal(out.status[id], "skipped", `${id} should be skipped`);
	}
}

{
	// 全部启用：static 里的每一段都被切干净，且没有 unmatched（SCRATCHPAD 除外，真实提示词里未必有）
	const text = [
		"preamble",
		"§ Role",
		"id",
		"# Engineering",
		"eng",
		"# Personality",
		"pers",
		"§ Runtime",
		"# Skills & Rules",
		"skills",
		"# Internal URLs",
		"urls",
		"# Tool Inventory",
		"tools",
		"# xd:// Tool Devices",
		"xd",
		"§ Tool Policy",
		"policy",
		"§ Workflow",
		"wf",
		"§ Delivery",
		"del",
		"§ Critical",
		"crit",
	].join("\n");
	const out = applyCuts(text, new Set(CUT_IDS), "static");
	for (const probe of ["§ Role", "# Engineering", "# Personality", "# Internal URLs", "# Tool Inventory", "# Tool Policy", "§ Workflow", "§ Delivery", "§ Critical", "preamble"]) {
		assert.ok(!out.text.includes(probe), `${probe} should be cut`);
	}
	assert.equal(out.status.SCRATCHPAD, "unmatched", "absent § Scratchpad is reported unmatched, not applied");
	assert.equal(out.status.ROLE_SECTION, "applied");
}

{
	// 护栏按作用域隔离（回归）：footer 的 <critical> 起始锚点也会出现在 static 块内部
	// —— omp 18.12.6 的 § Tool Policy 段里就有两对。若护栏不比较 scope，static 的 cut
	// 会被 footer 的 cut 提前收边：该切的内容（# Exploration / # AST / # Delegation）
	// 留在原地，状态还谎报 guarded。v0.2.0 首发版本正是这个 bug。
	const staticText = [
		"§ Tool Policy",
		"# General",
		"- narrow tools",
		"<critical>",
		"- static hard rule",
		"</critical>",
		"# Exploration",
		"- explore first",
		"# Delegation",
		"- delegate reads",
		"§ Workflow",
		"# 1. Scope",
		"§ Delivery",
	].join("\n");

	const r = applyCuts(staticText, new Set(["TOOL_POLICY"]), "static");
	assert.equal(
		r.status.TOOL_POLICY,
		"applied",
		"静态 <critical> 不能替 TOOL_POLICY 收边；结束锚点 § Workflow 就在后面",
	);
	assert.ok(!r.text.includes("# Exploration"), "# Exploration 应随 TOOL_POLICY 一起切掉");
	assert.ok(!r.text.includes("# Delegation"), "# Delegation 应随 TOOL_POLICY 一起切掉");
	assert.ok(r.text.includes("§ Workflow"), "§ Workflow 是结束锚点，应留给下一段");

	// 同一段文本交给 footer 作用域：只吃 <critical> 那一对，不动 static 子段
	const f = applyCuts(staticText, new Set(["FOOTER_CRITICAL"]), "footer");
	assert.equal(f.status.FOOTER_CRITICAL, "applied");
	assert.ok(!f.text.includes("<critical>"), "footer 作用域切掉 <critical> 块");
	assert.ok(f.text.includes("# Exploration"), "footer 作用域不动 static 子段");
}

{
	// footer 作用域隔离：static 轮次绝不能碰 footer 的 cut
	const footer = ["<project-context>", "rules", "</project-context>", "<critical>", "hard", "</critical>"].join("\n");
	const outStatic = applyCuts(footer, new Set(CUT_IDS), "static");
	assert.ok(outStatic.text.includes("<critical>"), "static pass must not touch footer cut");
	assert.equal(outStatic.status.FOOTER_CRITICAL, undefined, "footer cut not reported in static pass");

	const outFooter = applyCuts(footer, new Set(CUT_IDS), "footer");
	assert.ok(!outFooter.text.includes("<critical>"));
	assert.ok(outFooter.text.includes("<project-context>"), "footer pass must not touch static cuts");
}

{
	// 全切空后必须返回空串而不是残留换行，交给上层决定丢弃该块。
	// § Critical 是声明式 to-end（end: null），所以它之后的一切都会被吃掉。
	const only = ["§ Critical", "id", "<critical>", "hard", "</critical>"].join("\n");
	const out = applyCuts(only, new Set(["CRITICAL"]), "static");
	assert.equal(out.text, "", "declared to-end cut collapses the block to empty string");

	// 对照组：非 to-end 的项切空后，剩下的兄弟段必须原样保留
	const withSibling = ["§ Critical", "id", "§ Delivery", "del"].join("\n");
	const kept = applyCuts(withSibling, new Set(["CRITICAL"]), "static");
	assert.equal(kept.text, "", "§ Critical still runs to the end even with a sibling after it");
}

// ---------------------------------------------------------------- isFooterBlock

{
	assert.equal(isFooterBlock("<project-context>\n<workstation>"), true);
	assert.equal(isFooterBlock("  <project-context>"), true, "leading whitespace tolerated");
	assert.equal(isFooterBlock("<memories>"), true);
	assert.equal(isFooterBlock("§ Role\nYou are omp's"), false);
	assert.equal(isFooterBlock(""), false);
}

// ---------------------------------------------------------------- CUTS integrity

{
	// 每个 cut 的 start 必须非空，footer 的闭区间必须显式声明 consumeEnd
	for (const cut of CUTS) {
		assert.ok(Array.isArray(cut.start) && cut.start.length > 0, `${cut.id} needs a start marker`);
		assert.ok(["identity", "policy", "content"].includes(cut.group), `${cut.id} bad group`);
		if (cut.end && cut.scope === "footer") {
			assert.equal(cut.consumeEnd, true, `${cut.id} closed footer span needs consumeEnd`);
		}
	}
	assert.equal(new Set(CUT_IDS).size, CUT_IDS.length, "cut ids are unique");
}

console.log("omp-purge-cuts.test.mjs: all assertions passed");
