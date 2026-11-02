# 工具开发与“脑海”展示

工具展示是工具契约的一部分。新增本地工具时，需要在同一个 `AgentToolRegistration` 中同时提供：

1. `definition`：模型可见的工具名称和输入 schema。
2. `execute`：真实执行逻辑和原始输出。
3. `activity`：把真实输入、输出和错误翻译成用户可见的活动。

最小结构：

```ts
const activity: ToolActivityPresenter = {
  started: (input) => ({
    message: "我正在查找相关记录。",
    details: [{ label: "查找内容", value: readQuery(input) }]
  }),
  completed: (_input, result) => ({
    message: "相关记录已经找到了。",
    resources: readResources(result),
    resourcesLabel: "相关记录"
  }),
  failed: (input, error) => ({
    message: "这次查找没有顺利完成。",
    details: [
      { label: "查找内容", value: readQuery(input) },
      { label: "原因", value: error }
    ]
  })
};

return { definition, activity, execute };
```

`ToolActivityPresentation` 只接受以下渠道无关字段：

- `message`：必填，第一人称、面向用户的当前动作或结果。
- `title`：可选，简短且在各阶段保持稳定的“动作 + 对象”，用于网页单行工具展示；只能从白名单字段生成（例如项目资料的文件名），不直接输出原始参数。
- `command`：可选，仅从 `exec_command.cmd` 选取的实际 Shell 命令，最多 64,000 字符；标题使用首个非空行，网页默认折叠为首行并可展开完整命令。其余参数、stdin 和原始日志不进入该字段。
- `fileOperation`：可选，明确的 `read`／`edit` 操作，网页使用阅读／编辑图标及单行文件摘要，展开查看文件列表与操作详情。覆盖文档和项目资料读取、文档创建／编辑／移动、补丁文件头及可明确识别的 Shell 文件读写；未知程序、混合运行或脚本命令保留终端展示。仅提取文件名／路径，不将补丁正文、文档正文或搜索表达式用作文件摘要。
- `diff`：可选，仅用于用户要求的文件编辑差异，包含 `patch` 及可确认的 `additions`／`deletions`。补丁展示实际输入中的增删行；删除文件时尝试读取该文件的旧文本，缺失时不虚构计数。直接创建／编辑文字文件从本次写入前后的文本生成统一差异。摘要末显示绿色 `+`／红色 `−` 行数，展开按行着色并可复制；完整差异延迟加载，折叠历史只保留计数。差异元数据不进入模型的工具结果，不包含无关文档正文或原始日志。
- `details`：可选的标签和值；长提示词可使用 `format: "quote"`。
- `resources`：可选的资源标题、HTTP(S) 链接和简短说明。
- `resourcesLabel`：可选的资源分组名称。
- `hidden`：仅用于没有用户价值的内部步骤。

展示规则：

- 只挑选有助于用户理解进度的字段，使用明确的字段白名单。
- 不返回原始 JSON，不展示凭据、Token、Cookie、二进制、长正文或内部控制字段。
- `completed` 和 `failed` 会与 `started` 的展示信息合并，因此可以只补充发生变化的文案、资源或错误。
- 单条文本会被限制为 4,000 字，资源最多展示 8 个；不要依赖截断代替主动筛选。
- 内置供应商工具需要在 `registry.ts` 的 hosted presenter 映射中提供同样的三阶段翻译。

接入链路无需由新工具重复实现：执行器调用 `presentActivity` 产生 `AgentEvent`，`AgentTranscript` 合并为 `AgentActivityItem.presentation`，通讯渠道只读取这些固定字段渲染。完整原始输入输出仍单独进入 `tool_trace_json`，翻译后的活动进入 `activity_trace_json`。

新增工具需审阅代表性输入、成功输出、失败输出，以及敏感或冗长字段是否进入展示结果；遵循仓库快速迭代约定，不新增自动化测试。TypeScript 和运行时注册都会拒绝缺少 `activity` 的本地工具。

## 通用能力与项目

网页账号连接通过渠道提供的 `authorizeAccount` 等待凭据保存与连接验证，然后续接当前工具调用；支持 Notion、XMind、Google Calendar、Google Drive、Todoist 和飞书文档。授权链接与凭据只经认证操作区传输，不进入模型记录。用户停止或替换原回复时取消等待，账号登录本身仍可完成；不跨服务重启重放操作，也不重做此前成功的调用。写入继续经过原有确认流程。后台任务不发起或等待交互授权，不支持续接的其他渠道才返回 `authorization_pending`。

文件与编程使用 Codex 对齐的 `exec_command`、`write_stdin`、`apply_patch`、`view_image`，Windows 上实际命令/ConPTY/管道/补丁使用仓库源码独立构建的 Zigent 执行模块；普通执行账户开放网络及本机访问，权限模式与审批分开，命令以 Job Object 管理进程树；不注册 `execute`、`document_runtime`、`workspace_files` 或 `builtin_skills`。文档和代码都通过技能、普通程序与成熟文档库处理，技能从只读目录按需读取。项目选择和上传导入沿用 `workspaces`，不可变保存及最终交付沿用 `artifact_files`。预览使用同一执行镜像的渲染脚本，当前预览位于 `src/file-workbench/`，读取 worker 位于 `ops/document-reader/`；旧原生文档执行链已删除。后台命令、结果同步、版本、预览与交付是独立状态。活动展示输出允许的阶段、结果和 `exec_command.cmd` 命令字段，不输出 stdin 或原始日志。详情见[文件与编程底座](../../docs/ARCHITECTURE.md)。

所有文件工作先用 `workspaces select` 确定项目区。根据任务、历史和项目用途，归属明确时自主选择或新建，`confidence=uncertain` 才展示项目选择表单并等待用户。选择表单复用 `UserQuestions` 的 HTTP/SSE 和认证回答通道，使用代码拥有的 `purpose=workspace` 区分控制文案；通用 `ask_user_question` 不能据此授予项目选择或文件执行权限。取消、过期、自由回答均不直接选择项目。命令、补丁、图片、导入、复制和保存／恢复检查会话已选项目，子 Agent 继承该选择；`write_stdin` 保留对既有命令的读取和中断能力。

能力与项目分层：Codex 是面向多个已授权项目和任务的通用委派能力；PDF／Word 读取、页图与检索是 `src/capabilities/documents/` 中的通用能力，工具定义维护用法。独立 `documents` 工具接收用户已分享的上传文档、确认导入的具体服务器文件，以及可选的已授权项目来源；无需先登记项目。`project_files` 负责将登记项目文件经权限与版本核对接入这些能力。本地文件导入走现有认证网页确认路径，读正文前展示确切文件路径，工具参数不能伪造点击授权。项目条目只维护业务背景、用户角色和资料入口，加载项目时不附带能力说明或执行器配置。架构、定位、覆盖限制与调研依据见[文档能力](../../docs/ARCHITECTURE.md)。

`documents` 另提供 `create_text`、`edit_text`、`move_file`，在已有文件授权内直接创建项目文档、编辑网页文字附件／项目文字、将附件移入项目或调整项目文件位置，无需 Codex 派发。附件旧版和归档位置持久保存，下载按内容摘要重新验证缓存。编辑与移动要求具体文件 SHA-256；项目清单摘要不能代替文件摘要。精确替换只接受原版中唯一且互不重叠的匹配；目标同名异内容拒绝覆盖，部分移动明确返回目标与保留的来源。后台工具权限和额外服务器文件的导入确认保持原有机制。

Codex 分工不能缩减用户目标，不能擅加离线降级、产出格式或额外限制。原始用户要求由对话通道逐字保存并随任务交给执行器；确认卡片分别展示原话、分工和完成核对授权。显式授权核对的任务结束后进入持久审阅，按原目标决定交付、同会话补做或请用户决策；补做保持原范围和授权时间，取消、范围变化及失效回执不得触发新任务。

通用技能由 `SQLiteAgentSkillService` 独立保存，按 Agent、用户及可选身份隔离，使用 `update_skill` 的 `list/read/create/replace/delete/updates` 和章节修改，以及 `load_skill` 加载。所有修改走同一操作确认路径，确认前后检查目标和更新序号；删除清除全部会话加载标记，保留递增序号以拒绝旧操作。普通技能不授予工具或数据权限，`health` 保留专用服务与授权。接口及验证见[技能管理](../../docs/ARCHITECTURE.md)。

`update_skill` 使用 `target=rules` 编辑持久项目规则、`target=body`（默认）编辑私人正文，两者共享更新序号，不能跨目标合并确认。`update_skill.replace_sections` 将同一文件的所有不重叠章节修改放进 `sections`，共用一次读取的 `expected_revision`，一次确认、一次事务、一个新修订；提议尚未保存时不能自行递增修订号。保留 `replace_section` 兼容旧调用，同一 Agent、用户、身份、对话、会话和轮次内，对同一项目文件的待确认修改会合并并更新原操作区。预览与最终写入使用同一个章节替换函数；重复或父子重叠章节整批拒绝。网页按钮和飞书回调绑定完整草稿摘要，旧按钮不能确认后来合入的内容；确认时仍核对原文件修订，取消、重试和服务重启不能拆分或重复保存整批修改。

## 主动规则维护

`phone_notifications` 提供 owner 私聊的通知接收状态、按时间/App/中文子串分页检索及单条原文读取；有效主动任务租约允许只读访问，健康后台和其他身份不可访问。通知来自已有设备事件入口，历史补传只入库，不影响触发点与近期事件条件；文本不授予工具执行或记忆写入权限。活动展示只报告动作与数量，不展示通知、关键词或凭证。接口、存储及生产接入见[手机通知](../../docs/ARCHITECTURE.md)。

`create` / `propose` 的 `title`、`instruction`、`trigger` 必须放在顶层；`spec` / `fixtures` 仅用于 `trigger_stage`，不能包裹任务。提议与执行共用 `proactive-task-input.ts` 的纯校验，无效参数必须在展示确认组件前返回给模型。定位事件叠加工作日/时段条件时，先暂存并验证规则，再用 `trigger={type:reference,triggerId}` 与 `activate_revision` 提议同时启用规则和创建任务。

可复用触发规则继续使用 `proactive_tasks`，不新增通用代码执行或文件写入工具。`trigger_list`、`trigger_stage`、`trigger_validate` 不启用规则；`trigger_activate`、`trigger_rollback`、`trigger_pause`、`trigger_resume` 走共享操作确认。规则来源、条件、取消事件和正反例必须通过后端严格 schema 校验，测试调用真实求值器，不调用模型或发送消息。修改、启用和恢复时保留 owner/principal 与来源授权，后台执行禁止管理规则。

为减少每轮工具上下文，可复用规则的模型可见条件 schema 在各层共享字段形状，条件类型的必填字段、互斥字段、时间格式和数值范围由 `parseReusableTriggerSpec` 的严格判别联合统一校验；精简模型 schema 不得替代或放宽后端校验。保留各条件类型、字段和原有嵌套深度，且不依赖供应商未确认支持的递归 JSON Schema 引用。

确认前读取完整目标修订和订阅影响范围，确认时比较同一份保存状态；运行游标和最近事件不得使无关的用户确认过期。规则修订号、内容摘要和验证记录属于判断依据，不能在确认后悄悄替换。活动展示只报告维护动作和验证结果，不输出事件载荷、测试内容、身份、凭据或内部确认编号。扩展和发布边界见[主动任务架构](../../docs/ARCHITECTURE.md)。

## 长期记忆与存档记忆

`long_term_memory` 将个人档案和行为规则合并为一份长期记忆；存档目录仅含标题，使用 `read_archive` 与完整标题读取正文。修改与移动共用既有网页操作确认；移入存档应在同一提议中删除常驻条目并新增标题文件。后台主动任务只能在有效执行授权内读取，不能提议或保存。兼容数据、首次迁移和验证方式见[记忆](../../docs/ARCHITECTURE.md)。

派发前按语义核对用户意图：允许模型改写、综合跨会话需求、拆解任务并补充合理执行细节，不要求字面匹配。模型先检索相关历史，使用 sourceTurns 引用原始用户轮次；服务端验证所属用户并重新读取原文，和当前要求、相关偏好一起核对是否有目标漂移或擅加限制。经核对的需求依据随确认卡片和任务持久化，供执行与完成审阅使用；最近几条原话只是起点，不是意图范围。用户直接编辑卡片可补充或修订要求。

## 子 agent

`subagents` 在当前用户轮次内派发独立子任务，提供 spawn/list/wait/read/continue/cancel。每次 spawn 必须提供具体英文人名、职业身份、任务标题和任务内容，前端按“英文人名 + 职业身份”展示。`name` 按职业选择领域顶尖人物的英文姓名，可以使用知名专家或名人的姓名，不使用固定人名名单，不接受职业、角色、主题或任务名；任务名填写在 `title`，职业填写在 `profession`。调度器由 AgentExecutor 注入可信上下文，工具参数不接受用户、Agent、会话或模型覆盖。沿用父权限和确认路径，同时最多运行 3 个子任务，不设累计子身份数、续派次数、工具调用、模型轮次或总运行时间预算；父任务共享执行器同样不设工具调用与模型轮次预算。取消和父轮次结束仍正常收尾；共享工作区显式寻址，子任务不递归派发、不操作共享浏览器、不直接交付。源码研究、适用判断、持久记录及发布边界见[子 agent 派发](../../docs/ARCHITECTURE.md)。

## 浏览器与调研的工具选择

浏览器仅用于必要的网站交互（登录、表单、上传）、其他工具无法取得的视觉/动态内容，或用户明确要求使用浏览器。优先使用专用工具/API；公开调研使用 `web_search` 和非浏览器读取，搜索不足不自动转用浏览器。用途边界集中维护在浏览器工具描述中，避免共享提示重复。
