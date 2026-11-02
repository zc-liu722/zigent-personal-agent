// Reviewed against the pinned @larksuite/cli 1.0.83. Only these commands and
// compact guides are exposed; upstream service help and skill catalogs stay private.
type Command = { description: string; identity: "bot" | "user"; guide: string; flags: string[]; booleans?: string[] };
export const FEISHU_COMMANDS: Readonly<Record<string, Command>> = {
  "docs +search": { description: "搜索可访问的文档", identity: "user", guide: "docs/search", flags: ["query", "page-size", "page-token", "filter"] },
  "docs +fetch": { description: "按链接、目录、章节或关键词读取文档", identity: "bot", guide: "docs/read", flags: ["doc", "doc-format", "detail", "scope", "start-block-id", "end-block-id", "keyword", "context-before", "context-after", "max-depth", "revision-id"] },
  "docs +create": { description: "新建图文文档", identity: "bot", guide: "docs/create", flags: ["title", "content", "doc-format", "parent-token", "parent-position", "reference-map"] },
  "docs +update": { description: "追加内容或局部修改文档", identity: "bot", guide: "docs/update", flags: ["doc", "command", "content", "doc-format", "pattern", "block-id", "revision-id", "reference-map"] },
  "docs +whiteboard-update": { description: "更新文档内的流程图", identity: "bot", guide: "docs/diagram", flags: ["whiteboard-token", "input_format", "source", "idempotent-token"], booleans: ["overwrite"] },
  "sheets +workbook-create": { description: "创建飞书电子表格及多张工作表", identity: "bot", guide: "sheets/create", flags: ["title", "folder-token", "sheets", "styles", "values"] },
  "sheets +workbook-info": { description: "查看电子表格的工作表和结构", identity: "bot", guide: "sheets/read", flags: ["spreadsheet-token", "url"] },
  "sheets +table-get": { description: "读取电子表格的表格数据", identity: "bot", guide: "sheets/read", flags: ["spreadsheet-token", "url", "sheet-id", "sheet-name", "range"], booleans: ["no-header"] },
  "sheets +table-put": { description: "向电子表格写入多张工作表", identity: "bot", guide: "sheets/write", flags: ["spreadsheet-token", "url", "sheets", "styles"] },
  "drive files patch": { description: "修改文档标题", identity: "bot", guide: "docs/rename", flags: ["file-token", "type", "data"] },
  "minutes +search": { description: "查找已有会议纪要", identity: "user", guide: "minutes/search", flags: ["query", "start", "end", "page-size", "page-token", "owner-ids", "participant-ids"] },
  "minutes +detail": { description: "读取已有纪要、章节和转写文字", identity: "user", guide: "minutes/read", flags: ["minute-tokens"], booleans: ["summary", "chapter", "todo", "keyword", "transcript"] }
};
export const FEISHU_GUIDES: Readonly<Record<string, string>> = {
  "docs/search": "docs +search --query 关键词；可选 --page-size（最多20）、--page-token、--filter（JSON）。需要个人授权。默认每页5条。返回标题和链接后，只读取相关文档；搜索命中不代表已经读过正文。",
  "docs/read": "docs +fetch --doc 文档或知识库链接。默认先取目录；--scope outline --max-depth 3 查看标题，--scope section --start-block-id 标题ID 读取章节，--scope keyword --keyword 关键词定位，--scope range --start-block-id ID --end-block-id ID读取范围。确需全文时显式 --scope full。只读用 --detail simple；修改前局部读取 --detail full，保留结构、引用和样式。--doc-format xml（默认）或 markdown。fragment/excerpt 是节选，不可声称读完全文；reference_map 与原文配套保留。图片token或链接不代表已看过图片；嵌入表格数据未必包含在正文里。",
  "docs/create": "docs +create --title 标题 --doc-format xml或markdown --content 正文。可选 --parent-token 指定已有父位置，或 --parent-position my_library；二者互斥。正文语法见 docs/format，图文公式同样通过正文写入。工具参数是字符串数组，不加shell引号或命令替换；使用真实换行。长正文由程序暂存，不要传入服务器文件路径。成功后按返回链接局部读取核验；失败或超时时先核查是否已创建，不盲目重试。",
  "docs/update": "docs +update --doc 链接 --command 操作 --content 内容。开放 append（文末追加）、str_replace（--pattern 精确匹配）、block_insert_after（--block-id 锚点后插入）、block_replace（--block-id 替换指定块）、block_delete（--block-id 删除指定块）。修改前局部 fetch --detail full，保留无关内容与reference_map；按块修改默认XML，Markdown适合普通追加。XML str_replace只匹配行内，跨段用block_replace。空content配合str_replace删除匹配文字。替换或删除后相关旧块ID失效，继续编辑前重新读取。不要整篇覆盖；追加章节内容应定位章节而非一律append。正文语法见docs/format。修改结果不确定时先读回核查。",
  "docs/rename": '仅改文档标题：drive files patch --file-token 文档token --type docx（或doc） --data {"new_title":"新标题"}。data仅允许new_title；不修改正文。按链接读回核实。',
  "docs/format": '默认采用简洁段落与必要标题，不强行堆叠组件。XML片段：<title>文档标题</title><h1>标题</h1><p>段落</p>，列表<ul><li>要点</li></ul>，链接<a href="https://...">文字</a>，表格<table><tr><td>单元格</td></tr></table>。文本中的&、<、>分别转义为&amp;、&lt;、&gt;，属性引号转义为&quot;。Markdown支持标题、列表、链接、GFM表格；保留读取结果的转义，字面量特殊符号使用反斜杠，表格内竖线转义。图片用<img href="https://..."/>或Markdown网络图片语法；已有图片保留原token及reference_map，不杜撰token、不使用本地文件路径。公式用<p><latex>E=mc^2</latex></p>，Markdown可用$...$。简单流程图可内联<whiteboard type="mermaid">graph TD; A-->B;</whiteboard>；复杂图先创建<whiteboard type="blank"></whiteboard>，再用返回的board token和docs/diagram写入。XML内图源含&或<时也须转义。保持原有图片、表格、流程图，不因文字修改重建整篇。',
  "docs/diagram": "docs +whiteboard-update --whiteboard-token 已有画板token --input_format mermaid --source 图源。创建画板用docs/create或docs/update在正文中插入whiteboard，读取结果中的new_blocks.block_token；也可从fetch中取得whiteboard token。改现有图先理解原内容，--overwrite会清空画板，只在用户要求替换这张图时使用。不开放独立画板管理或任意本地文件读取。",
  "sheets/create": "sheets +workbook-create --title 标题 --sheets JSON，一次创建飞书电子表格和多张工作表。--sheets 结构为 {\"sheets\":[{\"name\":\"表名\",\"columns\":[\"列名\"],\"data\":[[\"值\"]]}]}；可选 dtypes、formats 保留日期和数字类型。--sheets 和 --values 互斥。可选 --styles JSON 设置样式，--folder-token 指定有权限的文件夹。长 JSON 直接传入参数，程序会安全暂存；不要传服务器文件路径。创建失败或超时后先核实是否已创建，不盲目重试。成功后用 sheets +workbook-info 和 +table-get 抽查工作表与数据。",
  "sheets/read": "sheets +workbook-info --spreadsheet-token token（或 --url 链接）查看工作表；sheets +table-get --spreadsheet-token token --sheet-name 表名 --range A1:D10 局部核对数据。读取只返回当前选定的范围；不要把局部读取当成全表核验。",
  "sheets/write": "sheets +table-put --spreadsheet-token token --sheets JSON 向已有电子表格写入一张或多张工作表，JSON 结构同 sheets/create；可选 --styles JSON。写入前先用 workbook-info 核对目标，防止覆盖已有内容；失败或超时先读取核实，不盲目重试。",
  "minutes/search": "minutes +search --query 关键词；可选 --start/--end 日期、--owner-ids、--participant-ids、--page-size、--page-token。需要个人授权，默认每页5条。只搜索已有记录，不上传录音或创建转写任务。",
  "minutes/read": "minutes +detail --minute-tokens 一个纪要token，按需加 --summary、--chapter、--todo、--keyword、--transcript。默认摘要和章节；需要原话时加--transcript，程序会读取临时转写文件并返回文字，模型不得指定文件路径。processing表示转写尚未完成，不要紧密轮询。返回truncated表示节选，不能声称阅读全文。只读已有内容，不修改纪要、不下载音视频。"
};
export function feishuCatalog(service?: string) {
  return Object.entries(FEISHU_COMMANDS).filter(([key]) => !service || key.startsWith(`${service} `))
    .map(([command, item]) => ({ command, description: item.description, identity: item.identity, guide: item.guide }));
}
export function feishuCommand(service: string, args: readonly string[]): { key: string; spec: Command; offset: number } {
  const offset = service === "drive" ? 2 : 1;
  const key = [service, ...args.slice(0, offset)].join(" ");
  if (!Object.hasOwn(FEISHU_COMMANDS, key)) throw new Error("This Feishu operation is not available; use capabilities for the enabled document and meeting operations");
  return { key, spec: FEISHU_COMMANDS[key]!, offset };
}
export function validateFeishuCommand(service: string, args: readonly string[]): Command {
  const { key, spec, offset } = feishuCommand(service, args);
  const values = new Map<string, string>();
  for (let i = offset; i < args.length; i++) {
    const argument = args[i]!;
    if (!argument.startsWith("--")) throw new Error("Expected a supported named flag");
    const equals = argument.indexOf("=");
    const flag = argument.slice(2, equals < 0 ? undefined : equals);
    if (values.has(flag)) throw new Error("Repeated flags are not supported");
    if (spec.booleans?.includes(flag)) {
      const value = equals < 0 ? "true" : argument.slice(equals + 1);
      if (value !== "true" && value !== "false") throw new Error("Expected a boolean flag");
      values.set(flag, value); continue;
    }
    if (!spec.flags.includes(flag)) throw new Error("Flag is not available for this Feishu operation");
    const value = equals < 0 ? args[++i] : argument.slice(equals + 1);
    if (value === undefined || value.startsWith("--")) throw new Error("Missing flag value");
    values.set(flag, value);
  }
  if (key === "docs +update" && !["append", "str_replace", "block_insert_after", "block_replace", "block_delete"].includes(values.get("command") ?? "")) throw new Error("Only append and local document edits are available");
  if (key === "drive files patch") {
    let body: unknown; try { body = JSON.parse(values.get("data") ?? ""); } catch { throw new Error("Rename requires JSON data with new_title"); }
    if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(k => k !== "new_title") || !("new_title" in body) || typeof body.new_title !== "string" || !body.new_title.trim() || !["doc", "docx"].includes(values.get("type") ?? "")) throw new Error("Only document title changes are available");
  }
  if (key === "minutes +detail" && !/^[A-Za-z0-9_-]+$/.test(values.get("minute-tokens") ?? "")) throw new Error("Read one meeting at a time using its token");
  return spec;
}
