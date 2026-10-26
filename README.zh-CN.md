# omp-purge

给 [omp](https://github.com/oh-my-pi/omp) 用的会话级系统提示词开关。一个 TypeScript 文件，
不改宿主、不写盘 —— `/purge` 把 omp 的静态指令块换成你自己的人设，`/purge off` 原样还回去。

血统两条：

- **[dsh-purge](https://github.com/kingcharleslzy-ai/dsh-purge)** —— 「不跟宿主身份讲道理，直接清掉」
  这个思路，以及逐项状态机（`applied` / `unmatched` / `skipped` 三态 + 明细表）。
- **[pi-purge](https://github.com/ZiChuanLan/pi-purge)** —— 形态：单扩展、会话级内存开关、三模式、
  锚点失配就安全退化、零落盘。

## 为什么 omp 要单独写一个

omp 是 bun 编译的单文件二进制，没有 `lib/core.js` 可 patch，没有审批层可改写 —— dsh-purge 那套
宿主补丁引擎在 omp 上没有着力点。omp 真正开放的是 `before_agent_start`，它把提示词作为
**有序 block 数组**交出来：

```
systemPrompt[0]  → 静态指令块（omp 18.12.6 实测 112 KB）
systemPrompt[1]  → <project-context> footer（你的 AGENTS.md、repo rules、workspace tree、MCP 路由）
```

所以 omp-purge 是**按块 + 按段**切除，不是 pi-purge 那种单串手术。这个分块点同时也是缓存断点所在
—— 这就是为什么 `strict` 能丢掉宿主脚手架、却仍然把你自己仓库的规则留在缓存稳定的尾部。

## 安装

把扩展放进 omp 的用户扩展目录：

```bash
mkdir -p ~/.omp/agent/extensions
ln -sf "$PWD/extensions/omp-purge.ts" ~/.omp/agent/extensions/omp-purge.ts
```

只给某一次运行加载：

```bash
omp -e /absolute/path/to/extensions/omp-purge.ts
```

当包安装（manifest 同时声明了 `omp.extensions` 与 `pi.extensions`）：

```bash
omp plugin link /absolute/path/to/omp-purge
```

注意：`--plugin-dir` **不加载**扩展模块，它加载的是插件包目录。用 `-e`、扩展发现目录，或
`omp plugin link`。

要求 omp ≥ 18。跑测试需要 Node ≥ 22.19（原生 TypeScript 类型剥离）。

## 用法

不输入 `/purge` 就完全关闭。在那之前你的 omp 会话跟没装这个扩展一模一样。

| 命令 | 作用 |
| --- | --- |
| `/purge` | 切换开/关 |
| `/purge on` / `off` | 显式开/关 |
| `/purge status` | 状态、模式、人设来源、上一轮、逐项切除明细表 |
| `/purge mode strict\|replace\|append` | 切模式 |
| `/purge source <绝对路径\|embedded>` | 换人设文件，或切回内置示例 |
| `/purge reload` | 重读当前人设文件 |
| `/purge cut <ID> cut\|keep` | 在当前模式下单独覆盖某一项 |
| `/purge cut reset` | 清空所有手动覆盖 |
| `/purge preview` | 看将要发送的前 400 字符 |

### 三模式

| 模式 | 静态块 | Footer（`<project-context>`） | 适用 |
| --- | --- | --- | --- |
| `strict`（默认） | 整段丢弃，换成 `Current working directory: <cwd>` + 人设 | 保留，只去掉 omp 自己的 `<critical>` 尾块 | 你只要自己的指令 + 自己仓库的规则 |
| `replace` | 只清身份段，工具政策/工作流保留 | 保留 | 想要自己的角色，但不丢 omp 的作业流程 |
| `append` | 一字不动 | 一字不动，人设作为独立块插在 block 0 之后 | 想要可审计的增量层 |

### 人设来源

按这个顺序解析：

1. `OMP_PURGE_SOURCE` 环境变量
2. `~/.dsh/prompt-inject.md` —— 与本机 dsh 侧共用同一份注入文件
3. `extensions/omp-purge.ts` 里的内置示例文本

**默认源**缺失会静默回退内置示例（保证新装即可用）；**显式指定**的路径缺失是错误，并保留上一份
已加载正文。

### 环境变量

| 变量 | 取值 | 含义 |
| --- | --- | --- |
| `OMP_PURGE_SOURCE` | 路径或 `embedded` | 初始人设来源 |
| `OMP_PURGE_MODE` | `strict` \| `replace` \| `append` | 初始模式 |
| `OMP_PURGE_AUTOSTART` | `1`/`true`/`yes`/`on` | 每个会话自动开启 |

环境变量只播种初始状态。任何东西都不会写回 `config.yml` 或磁盘上别的位置。

## 切除表

十四个锚点，取自 omp 18.12.6 `src/prompts/system/system-prompt.md` 渲染后的字面文本。
`strict` 与 `replace` 的差别只在于启用哪几项。

| ID | 段落 | 作用域 | `replace` | `strict` |
| --- | --- | --- | :-: | :-: |
| `HOST_PREAMBLE` | RFC 2119 / XML 权威声明 | static | ✓ | ✓ |
| `ROLE_SECTION` | `§ Role` + "You are omp's trusted coding assistant." | static | ✓ | ✓ |
| `PERSONALITY` | `# Personality`（来自 `config.yml#personality`） | static | ✓ | ✓ |
| `ENGINEERING` | `# Engineering` | static | | ✓ |
| `SKILLS_RULES` | `# Skills & Rules` 含 `<skills>` | static | | ✓ |
| `INTERNAL_URLS` | `# Internal URLs`（`omp://` 文档目录） | static | ✓ | ✓ |
| `TOOL_INVENTORY` | `# Tool Inventory` | static | ✓ | ✓ |
| `XD_DEVICES` | `# xd:// Tool Devices` | static | ✓ | ✓ |
| `SCRATCHPAD` | `§ Scratchpad` | static | | ✓ |
| `TOOL_POLICY` | `§ Tool Policy` | static | | ✓ |
| `WORKFLOW` | `§ Workflow` | static | | ✓ |
| `DELIVERY` | `§ Delivery` | static | | ✓ |
| `CRITICAL` | `§ Critical` | static | | ✓ |
| `FOOTER_CRITICAL` | `<critical>` 尾块 | footer | | ✓ |

`append` 不启用任何切除项。

### 安全退化

每个锚点都是行级 `startsWith` 对 `trimStart()` 后的行做匹配 —— 不靠行号、不靠字节偏移。
只有**起始标记和声明的结束标记都找到**时，该项才真的被切除。缺任一个：

- 该项单独报 `unmatched`（`/purge status` 里看得到）
- 该项跳过、文本一字节不动，其余项照常执行
- 绝不在猜测的边界上截断提示词

`end: null` 是**另一种显式声明**，意思是「本段一直到块末尾」（只有 `§ Critical` 这么写）。
它绝不会由一次失败的搜索推断出来。

另有一层兄弟护栏：扫描结束标记的途中一旦撞到**别的 cut 的起始标记**，就在那里收边。
所以一个标题被改名，代价是丢一项，不是丢掉后面整篇。

两个真实例子：

- 没有 `think` 工具的 omp 会话里，`SCRATCHPAD` 报 `unmatched  § Scratchpad`，其他全部 applied。
  状态机按设计工作。
- `omp` 把 `§ Workflow` 改名成 `§ Process`：`TOOL_POLICY` 与 `WORKFLOW` 转 `unmatched`，
  该块剩下的约 100 KB 原样保留。（v0.1.0 在这里会静默吃穿到只剩 61 字符 —— 这正是 v0.1.1
  修掉的问题，回归测试见 `test/omp-purge-cuts.test.mjs`。）

## 验证

```bash
npm test
```

`test/omp-purge-cuts.test.mjs` 覆盖边界语义（开区间 vs 闭区间、结束标记缺失、preamble 哨兵、
作用域隔离、切空后折叠）。`test/omp-purge.test.mjs` 用 omp 18.12.6 形状的夹具驱动真实 handler：
三模式、toggle、`status`、`cut` 覆盖、`source` 切换、reload、回退、幂等。

## 局限 —— 信任它之前请读这段

- **锚点绑定版本，这是刻意的取舍。** 定位一个段落有三条路：
  (a) 靠行号/字节偏移 —— 最省事，任何一次重排都会灾难性失效；
  (b) 语义解析模板 —— 要拿到模板而不是渲染后文本，而且把你焊死在 omp 的内部渲染管线上；
  (c) 锚点文本 —— 能扛住段落重排和正文改写，只在标题本身被改名时失效。
  本扩展选 (c)，并把失效做成**可见且局部**的：标题被改名，代价就是 `/purge status` 里多一行
  `unmatched`，兄弟护栏阻止它扩散。每次升级 omp 之后重跑 `/purge status`。`ROLE_SECTION` 报
  `unmatched` 就等于「宿主身份还在」—— 这一行绝不能忽略。
- **工具 schema 不是提示词。** 工具通过 API `tools` 参数到达模型，不经过 `systemPrompt`。
  任何提示词层扩展都删不掉一个工具；那要用 `omp --no-extensions`、`setActiveTools` 或你的
  omp 工具配置。
- **Footer 是你的，不是 omp 的。** `strict` 下你的 `AGENTS.md`、`<repo-rules>`、`<dir-context>`、
  `<workspace-tree>`、MCP 路由照旧发出。扩展只从这一块里剥掉 omp 自己的 `<critical>` 尾块，
  其余全是你写的内容。
- **这不是安全边界。** 它改的是模型被告知什么，不是进程能做什么。omp 的权限就是你 OS 用户的
  权限；隔离是容器/VM 层面的事。
- **`strict` 会丢掉 `# Tool Inventory`。** 工具仍然可调用，只是模型不被按名字告知它们存在。
  如果 `/purge mode strict` 之后带工具的会话开始乱撞，原因就在这。

## 许可

MIT，见 [LICENSE](LICENSE)。

## 安装

两条路，看你需不需要改源码。

### A. 软链一份 checkout（作者本人用的）

```sh
git clone https://github.com/ZhangEx18/omp-purge
ln -sf "$PWD/omp-purge/extensions/omp-purge.ts" ~/.omp/agent/extensions/omp-purge.ts
```

更新就是 `git pull` —— 软链指向工作区，下一个 omp 会话直接读到新代码。没有安装步骤，没有缓存要清。

### B. `omp plugin install`（机器上不留 checkout）

```sh
omp plugin install https://github.com/ZhangEx18/omp-purge
omp plugin list            # omp-purge@<version>，enabled: true
```

它通过 Bun 把仓库解析到 `~/.omp/plugins/node_modules/omp-purge`，并登记进 `omp-plugins.lock.json`。
扩展入口读的是 `package.json` 里的 `omp.extensions`。

## 更新

```sh
# A：软链的 checkout
cd omp-purge && git pull

# B：plugin install
omp plugin install https://github.com/ZhangEx18/omp-purge   # 重跑 install，会重新解析 HEAD
```

`omp plugin upgrade` 只遍历 **marketplace** 插件（`name@marketplace`）；用 Git URL 装进来的是
npm 风格的依赖，`upgrade` 会回一句「All marketplace plugins are up to date」然后什么都不做。
用同一个 URL 重跑 `install` 才是它的更新路径。

两条路都一样：新模块只在**新会话**里生效。扩展模块每进程只 import 一次（加载时带 `?mtime`
缓存破坏），而 `/reload-plugins` 明确**不**重新 import 扩展模块 —— 它刷的是 skills、commands、
hooks、tools、agents、MCP。要拿到新扩展代码，重启 `omp` 或开新会话。

在会话里确认当前真正生效的是什么：

```
/purge status      # 模式、人设源、逐项 applied/unmatched/skipped
```

### 锁定某个版本

```sh
omp plugin install https://github.com/ZhangEx18/omp-purge#v0.1.1
```

## 卸载

```sh
# A
rm ~/.omp/agent/extensions/omp-purge.ts

# B
omp plugin uninstall omp-purge
```
