# 课表 MCP

面向 LLM 的个人课表与弹性日程服务。Node.js 24+、SQLite 本地持久化，同一端口提供 Streamable HTTP 和传统 SSE，另支持 stdio。

## 启动

```bash
npm ci
npm start
```

默认连接地址：

| 用途 | 地址 |
|---|---|
| Streamable HTTP | `http://127.0.0.1:3001/mcp` |
| SSE | `http://127.0.0.1:3001/sse` |
| 健康检查 | `http://127.0.0.1:3001/health` |

RikkaHub 添加 MCP 服务时，选择对应传输并填入上方 URL。两种传输同时可用、共享数据。

### 快捷启动

```bash
# 仅当前终端启用，无需修改 bashrc
source ~/kebiao/scripts/kebiao.bash
start_kebiao
start_kebiao 3002

# 安装到 bashrc（先备份，不覆盖现有启动器）
node scripts/install-shell.js
```

前台运行，Ctrl-C 停止。安装后新终端可直接 `start_kebiao`。默认不设置自启动守护进程。

### 配置

```bash
node src/server.js --port 3001 --host 127.0.0.1 --db ./data/kebiao.sqlite
node src/server.js --stdio
```

支持 `KEBIAO_PORT`、`KEBIAO_HOST`、`KEBIAO_DB`；启动函数还支持 `KEBIAO_DIR`。默认数据库在项目 `data/kebiao.sqlite`，不随 shell 当前目录改变。

可选 `KEBIAO_TOKEN`：客户端添加 `Authorization: Bearer <token>`。监听非回环地址时必须配置 token；公网部署自行提供 HTTPS。不要把 token 写入课表数据。

## 给 LLM 的 4 个工具

| 工具 | 一次调用能做什么 |
|---|---|
| `schedule_query` | 同时获取 agenda、catalog、tasks、conflicts、free、config、summary、unscheduled、changes；筛选、分页、假设启用 |
| `schedule_mutate` | 原子执行多次 put/patch/enable/set_timetable/switch_timetable，直接返回修改后的视图 |
| `schedule_import` | 按官方稳定来源键去重导入，保留个人启用状态，返回导入结果及视图 |
| `schedule_plan` | 新建任务并安排，支持仅预览或直接提交，返回时间块和剩余未安排原因 |

工具携带参数 schema 和中文说明；`schedule://guide` 提供补充规则。不需要先读 guide 才能调用工具。

### 查询没选上的 C++（一次）

调用 `schedule_query`：

```json
{"views":["catalog"],"state":"all","search":"C++"}
```

默认 `state=enabled`。`disabled` 只查已停用，`all` 包含两者。禁用保留所有数据，不进入默认 agenda，不占用 free，也不产生 conflicts。

### 假如选上 C++，是否冲突？（一次，不修改数据）

```json
{
  "from":"2026-09-14","to":"2026-09-21",
  "simulateEnable":["cpp"],
  "views":["agenda","conflicts","free"]
}
```

### 启用 C++，同时调整教室并查看最新课表（一次）

调用 `schedule_mutate`：

```json
{
  "requestId":"select-cpp-20260915",
  "operations":[
    {"op":"enable","targets":["C++"],"enabled":true},
    {"op":"patch","target":"C++","changes":{"location":"A202"}}
  ],
  "returnQuery":{"from":"2026-09-14","to":"2026-09-21","views":["agenda","conflicts"]}
}
```

`target`/`targets` 接受 ID 或完整唯一标题，包含禁用数据；重名返回候选 ID，绝不随意选一个。`put` 创建或完整替换；`patch` 局部修改，数组整体替换，metadata 也整体替换。修改前可 `dryRun=true`，已经授权的操作可直接写入。

`enable=false` 可应用于课程、日程、任务、学期和调课例外。禁用学期使所属课程不参与默认课表；禁用任务使关联时间块不占用。禁用课程不会自动禁用关联学习任务。重新启用恢复原数据；显式非 selected 的课程仍需更新选课状态才进入课表。单次取消课程应使用 exception，不要禁用整个课程。

### 导入官方课表

`examples/import.json` 是完整的 `schedule_import` 参数示例，包含已选高数和未选 C++。示例不自动写入真实数据库。

- `source.namespace + source.key` 唯一标识来源条目，namespace 由本次参数统一设置。
- key 使用官方稳定编号，不使用容易重复的课程名称。
- 新导入课程默认禁用；明确 `enabled=true` 表示已选。学期默认启用。
- 重复导入保留个人 enabled，`preserveEnabled=false` 可覆盖。
- 导入更新为完整替换：除自动保留的 enabled 和已有 status 外，notes/tags/metadata 等字段都以本次导入内容为准，需要保留的必须在导入条目中携带。
- 未出现在本次导入的旧记录保留，可在之后批量 disable。
- 学期和课程可同批写入，通过自定义固定 ID 引用；重新导入已有来源会沿用旧 ID，调用方应继续沿用返回的 ID。
- 导入接收结构化 JSON。网页、教务登录、PDF、图片解析由客户端先处理。

### 用原始 Markdown 补齐已有课表

先查询 `catalog/config/tasks`，使用 state=all 并遍历分页，核对现有 ID、source 和个人选择。缺课程时间时，优先 patch 对应课程的 rules、scheduleStatus、expectedTiming、scheduleSource；原文未写的信息不猜测，明确说是“预计/往年安排在假期”的用 expectedTiming.window 并标 source/confidence，不要写成确定日期。新增课堂才用稳定来源键导入，各课堂独立记录。已有例会可 patch category=activity（原记录若带选课状态或学分字段，完整 put 时移除这些不适用字段）。

整份重新 import 是**完整替换**，自动保留的只有已有 enabled/status（可分别关闭）；任务 completed、作息表、调休日历、备注等需要在导入内容中显式保留。不要拿较旧的 Markdown 恢复后来已经完成的登记任务，或抹去后来设置的冬夏切换和调休。先 dryRun，确认数据和 coverage 后再使用期望版本提交；已获授权时不必额外询问确认。

可交给录入 AI 的指令：

> 先读取全部现有课表，再根据这份 Markdown 补齐所有课堂的公示时间，包括未选、候选课程。原有课程用原 ID 做 patch；新增课堂用独立稳定 source.key 去重导入。未选状态与时间规则独立保存，默认保留现有选课、启禁用状态。材料未写的时间标 unknown，明确待通知标 tbd，缺部分课次标 partial；已知开课周用 expectedTiming，只有“预计安排在假期”这类说法的用 expectedTiming.window 并标 source/confidence，勿编造节次。个人周期例会标 category=activity。保留已完成任务、现有作息表和调休，不用旧材料覆盖这些后续变更。最后返回 unscheduled、coverage，并模拟 C++ 的新增冲突；缺时间时明确说明无法完整判断，不要重复解释已 acknowledge 的缺口。

### 未选课程、公示时间和分析覆盖情况

公示课表继续保存在课程的 `rules`，独立于选课 `status` 和 `enabled`。每个课堂用不同 ID 和稳定 source.key，例如 CPP-01、CPP-02；这样可以分别查询或预演，无需复制一份容易失同步的 expectedRules。只有确实取得公示时间才能录入，不能从空规则推断“学校没有排课”。`scheduleSource:{type:"official",reference:"公示网址或材料名称"}` 可记录依据（type 也可为 personal、unknown）。

查看尚未选上的课堂的已知时间：

```json
{"from":"2026-09-14","to":"2026-09-21","views":["catalog","agenda","unscheduled"],"state":"all","courseStatus":"not_selected"}
```

`candidate` 用于尚在考虑/课堂待选，查询方式相同。agenda 展开已知时间；未选条目不占用 free，也不会产生实际冲突。

时间资料状态独立记录为 `scheduleStatus`：

| 值 | 含义 |
|---|---|
| scheduled | 已录完整的时间规则 |
| partial | 只录了部分课次时间，仍有缺口 |
| unknown | 时间未录入或未知，不代表学校未公布 |
| tbd | 已知来源明确说时间待定/待通知 |

旧数据不改写：有 rules 时查询显示 scheduled，空 rules 显示 unknown。scheduled/partial 必须有规则；unknown/tbd 必须无规则。补齐显式 unknown/tbd 的课程时，同批 patch rules 和 scheduleStatus；只补了一部分应设 partial。

可以用 `expectedTiming:{startWeek:9}` 表示“第9周起，具体时间未录入”，不虚构结束周、星期和节次。还支持 endWeek、实际 date、durationWeeks；date 与教学周范围互斥。durationWeeks 仅表示持续周数，不会被展开成占用，也不能单凭“持续1周”推断是哪一周。对 partial，这些边界描述尚缺的部分；已知 rules 仍照常参与计算。

预期还可以是**学期之外**的：`expectedTiming.window` 用 `{from,to,label}`（含首尾的当地日期）记录“预计安排在 2027 暑假”这类尚未确定的落点，它是软性预期，不会生成任何占用，也不能替代 rules。window 与 date/startWeek/endWeek/durationWeeks 互斥，长度上限 420 天。同一处可标注 `source`（official/personal/unknown）、`confidence`（high/medium/low）和 `verifiedAt`，说明这条预期来自谁、有多可信、何时核对过；personal 或 low 只能作为预期，不能当成官方排课。

已经知道缺口但暂时不想被反复提醒时，用 `acknowledge:{until,note}` 记下确认日期。在 until 之前 coverage 仍会报告该缺口并标记 acknowledged（确认到期后自动恢复普通缺口），`acknowledgedIssues` 给出这类条目的数量；解释原因只需做一次。

`unscheduled` 独立分页，列出查询日期范围内可能涉及的未知/待定/部分录入课程；state=all 含未选，catalog 可不限日期查所有记录。已知教学周边界会考虑 term.calendar 调休；没有明确边界时保守认为可能影响整个学期，写了 window 的则按该预期窗口判断。

查询 agenda/conflicts/free/unscheduled 或进行模拟时，附带 `coverage`：

- courses 提供已纳入记录数、有实际课次的记录数、完整时间记录数、缺时间数、部分时间数和 issuesOutsideRange 数；这里“课程记录”也包括 category=activity 的周期活动。
- issues 给出 ID、标题和原因，reason 是稳定枚举：time_not_imported、time_tbd、partial_schedule，模拟目标另加 term_disabled、outside_term。issues 使用独立 pagination，跟随 limit/offset。
- **issues 只列可能落在本次范围内的缺口。** 学期覆盖本范围、但按预期时间（如暑假 window）不可能落在范围内的已知缺口放在 issuesOutsideRange，不计入 complete，只提示“别处还有不确定项”，避免同一口待定课把每次查询都标成不完整。
- `complete` 是本次范围的结论，不是全局结论：它只看 issues，不看 issuesOutsideRange，也不证明学校全量课表已导入。
- issues[].acknowledged=true 表示该缺口已被 acknowledge 确认，仍需按 complete=false 对待冲突结论，但不必重复解释。
- **complete=false 时，conflicts=[] 只能表示已知时间之间未发现冲突。** free 只扣除了已知占用；plan 会返回 tentative=true，提交的安排仍需等资料补齐后复核。
- complete 仅针对本次范围内已存的有效数据，不证明学校全量课表已导入；粗略事件另由 approximateEvents 和冲突 certainty 披露精度。
- coverage 与 free/conflicts 一样，始终检查全部有效占用，不受 search/state/kinds/ids/termId/category/scheduleStatus 等展示筛选或分页缩小。

一键预演仍使用现有参数：

```json
{"from":"2026-09-14","to":"2026-09-21","simulateEnable":["cpp"],"views":["agenda","conflicts","free","unscheduled"]}
```

新增 `simulation` 返回 baselineConflictCount、addedConflictCount、removedConflictCount、分页的 addedConflicts 和每个目标的生效状态/课次数。不会写入数据。空规则会明确暴露为缺时间；所属学期禁用时会报告 term_disabled，需要模拟时可同时指定学期 ID。范围内没有课次不代表该课程整个学期没有时间冲突。

### 选课状态与学分学时

课程可记录 `status`：`candidate`（候选）、`selected`（已选）、`not_selected`（未选上）、`dropped`（已退选）。省略表示未知，旧数据继续按 enabled 工作，不根据启禁用猜测选课历史。

- status 与 enabled 独立。显式非 selected 的课程不进入默认 agenda、不占用 free；`state=all` 可查完整资料，`courseStatus` 可按状态筛选（含 `unknown`）。`state=disabled` 包含这些实际不生效的课程。
- 选上课程时 patch `{"status":"selected","enabled":true}`；仅 enable 不改变 status。`simulateEnable` 在查询副本中同时模拟已选，不写入数据库。
- 可用 `rules:[]` 保存尚无课表的候选/历史课程。
- 重复导入默认保留已有 status；`preserveStatus=false` 使用传入状态，省略状态则清除。它与 preserveEnabled 分别控制。
- `credits` 为非负数；`hours` 支持可选的 `total`、`theory`、`practice`，已知分项之和不得超过 total。缺失表示未知，0 表示明确为零。

查询本学期已选课程的学分学时（包括被手动禁用的已选课程）：

```json
{"views":["summary"],"termId":"autumn","courseStatus":"selected","state":"all"}
```

个人周期例会可用 `kind:"course",category:"activity"` 复用现有周规则；它仍参与 agenda/conflicts/free，但不设置选课状态/学分/学时，且排除 summary。课程 category 默认为 academic，不能靠缺少 status 猜测它是个人事务。一次性例会使用 event。

summary 按学期与状态分组，遵循查询筛选、独立分页，不按查询日期折算课程学时。每个数值返回 `knownTotal`（已知部分之和）、`missing`（未填写课程数）、`knownCount` 和 `available`；available=false 表示全缺失，客户端可隐藏该列，而不是显示“0学时”；明确填写0时 available=true。有缺失时不能把已知部分当完整总数。默认 state=enabled 只汇总当前生效课程。

### 只知道考试在下午

```json
{"operations":[{"op":"put","entity":{
  "kind":"event","title":"期末考试","date":"2026-11-28",
  "slot":"afternoon","timezone":"Asia/Shanghai"
}}]}
```

一次性事件支持三种互斥形式：

- `start` + `end`：精确带时区时间戳。
- `date` + `slot`：`morning` / `afternoon` / `evening`。timezone 默认 Asia/Shanghai，指定 termId 则默认继承学期时区。
- `date` + `termId` + `periods:[5,6]`：按该学期节次表生成时间。节次必须存在、有序、不重复；使用学期时区。

只有“第13周周六”时，按 term.weekOne 加 12 周再加 5 天得到实际 date；一次性事件不会随 term.calendar 调休映射。指定 termId 时日期必须在学期内。

粗略时段不存储猜测的起止时间。agenda 返回 `precision:"slot"` 和 `occupancy:{start,end,conservative:true}`，不返回事件 start/end；占用范围按当地 00–12、12–18、18–次日00 点保守避让。它是排程边界，不是考试的实际时间。涉及这些时段的冲突标记 `certainty:"possible"`，精确时间或节次之间的冲突标记 `confirmed`。free 和 plan 都避让整个占用范围，busy=false 则不占用。

节次事件返回 `precision:"periods"` 和按作息表解析的 start/end。关联 taskId 的时间块必须使用精确时间。切换事件时间形式请用完整 put 替换，避免 patch 留下原形式的字段。

### 设置 summer / winter 并切换作息

AI 可以通过同一个 `schedule_mutate` 工具设置、切换命名作息表，名称可自定义。下面示例假设已有 ID 为 `autumn` 的学期，且课程引用第 5、6 节；实际使用须填写学校的完整作息表。

```json
{
  "operations":[
    {"op":"set_timetable","target":"autumn","name":"summer","periods":[
      {"number":5,"start":"14:30","end":"15:15"},
      {"number":6,"start":"15:25","end":"16:10"}
    ]},
    {"op":"set_timetable","target":"autumn","name":"winter","periods":[
      {"number":5,"start":"14:00","end":"14:45"},
      {"number":6,"start":"14:55","end":"15:40"}
    ]},
    {"op":"switch_timetable","target":"autumn","timetable":"summer","effectiveFrom":"2026-09-01"},
    {"op":"switch_timetable","target":"autumn","timetable":"winter","effectiveFrom":"2026-10-08"}
  ],
  "returnQuery":{"from":"2026-10-08","to":"2026-10-15","termId":"autumn","views":["config","agenda","conflicts"]}
}
```

之后只需一条 switch 即可切换到已存的表。比如“今天切换 winter”：AI 根据学期时区填写今天的 `effectiveFrom`，不必重传节次。生效日期必须在学期内。

- **set** 只保存或完整替换该名称的表，不激活，也不影响其他命名表。
- **switch** 从学期当地日期零点起生效，持续到下一次切换；提前设置即可自动按日期使用，无需后台定时任务。相同日期再次 switch 会替换该日记录，其他日期的切换保留。
- 首次切换前使用旧 `term.periods`；`timetable:null` 从指定日恢复它。旧数据无需迁移。若默认 periods 为空，须从学期第一天起安排命名表覆盖课程。
- `term.timetables` 保存命名表数组，`term.timetableSwitches` 保存切换记录。可通过 put/patch/import 完整设置。取消某次计划切换时，patch 去掉该条后的完整 timetableSwitches 数组；普通 switch 不删除未来计划。
- **修改同名表会改变所有引用该表日期的查询结果，包括历史。** 只想从某天调整，应 set 新名称（例如 winter-v2），再从该日 switch。
- 已生效或计划生效的每套表都须包含所属课程引用的节次，包括禁用课程；节次事件校验其实际日期使用的表。缺节次、重复编号、非法时间、未知表名、同日重复配置会使整批回滚。未激活的新表可以先保存。
- 按实际上课日期选作息表；term.calendar 映射只决定教学周和星期。例如冬季补上夏季某天的课，使用冬季钟点。节次考试同样跟随切换。
- 写明 start/end 的课程、活动、调课例外及已安排的任务块保持原钟点。新任务排程、free、conflicts 使用切换后的占用；切换后可同次 returnQuery 检查与既有活动的冲突。
- `config` 返回全部配置和 `activeTimetable:{date,name,effectiveFrom,periods}`：按查询起点换算到学期时区的日期选表，name=null 表示默认表；查询起点在学期外则 activeTimetable=null。agenda 中按节次展开的条目返回 `timetable` 名称。
- 导入仍按完整替换语义处理学期，重新导入需携带需要保留的命名表及切换配置。

查某日起生效的作息：

```json
{"views":["config"],"termId":"autumn","from":"2026-10-08","to":"2026-10-09"}
```

### 调整一次课

agenda 返回 `entityId`、`originalDate`、`ruleIndex`。调用 `schedule_mutate`：

```json
{
  "operations":[{"op":"put","entity":{
    "kind":"exception","id":"cpp-move-20260915","title":"C++ 调课",
    "courseId":"cpp","originalDate":"2026-09-15","ruleIndex":0,
    "start":"2026-09-16T14:00:00+08:00","end":"2026-09-16T15:40:00+08:00"
  }}],
  "returnQuery":{"from":"2026-09-14","to":"2026-09-21","views":["agenda","conflicts"]}
}
```

取消使用 `cancelled=true`；同一次课只允许一条启用的 exception，后续 patch 此例外。禁用例外恢复原安排。课程规则重排可能使 ruleIndex 改变，修改规则时应同批调整相关例外。

### 一次创建并安排三小时复习

调用 `schedule_plan`：

```json
{
  "requestId":"study-math-20260915",
  "from":"2026-09-15","to":"2026-09-21",
  "prefer":"evening","bufferMinutes":10,"commit":true,
  "newTasks":[{
    "kind":"task","title":"高数复习","durationMinutes":180,
    "earliest":"2026-09-15T08:00:00+08:00","deadline":"2026-09-20T22:00:00+08:00",
    "minBlockMinutes":30,"maxBlockMinutes":60,"splittable":true
  }]
}
```

默认 `commit=false` 预览。`commit=true` 原子创建并安排；默认 `requireAll=true`，不能完整安排则不写入任何数据。`requireAll=false` 允许部分安排。任务按期限、优先级排序，偏好不满足时回退其他允许时段。既有时间块不被移动，并从剩余任务时长扣除。

如要重新安排，先禁用不需要的旧时间块，再调用 plan；手动定时可直接批量 put event。`locked` 为手动/后续重排保留标记，当前算法对所有既有时间块都不移动。

### 截止任务与通知边界

登记截止日期应使用已有 task.deadline，先检查 completed，避免重复创建或催办已完成任务。备注不是可靠的自动执行来源，系统不会自行从文字提取日期后写入提醒。保存任务/查询截止时间不等于后台推送；本服务目前没有通知投递通道，也不会主动发送调休或作息切换提示。

## 时间与一致性

- 查询日期使用给定时区（默认 Asia/Shanghai），from 包含、to 不包含，默认从今天查询 7 天，最长 120 天。精确时间戳必须带偏移量；粗略事件使用下述 date/slot 表达。
- term.endDate 包含；weekOne 是学期开始所在周的周一。课程 weeks 为明确教学周集合，单双周转换成集合。
- 按节次上课时，占用从第一节开始到最后一节结束（包含课间）；不连续课程请拆为多条 rules。
- `term.calendar` 将实际日期映射为教学日期，`null` 表示当天停课，例如 `{"2026-09-15":null,"2026-09-19":"2026-09-15"}`。
- 单次例外覆盖实例时间/地点；移入查询范围的课也会出现，实例 ID 保留原日期。
- 时间区间为 `[start,end)`，相邻事件不冲突。free/conflicts 始终计算全部有效占用，**不会被 search/state/kinds/ids 缩小**；agenda/catalog 等视图才应用这些筛选。
- 每个视图独立分页，检查 `pagination.*.hasMore`。默认最多 200 条，可到 2000 条；后续用 offset。coverage 的 issues 也独立分页。
- `changes` 视图按 `revision` 升序返回审计日志增量：指定 `sinceRevision` 后只返回更新的记录，用最后一页的 revision 作为下一次的 sinceRevision 即可增量同步，无需全量重读。在写入响应里（returnQuery），changes 表示本次写入产生的差异，含每条的 before/after。
- 写入整批事务、版本号、持久化 requestId 去重和审计。重试同一个 requestId 必须使用相同参数；`expectedRevision` 可防止覆盖旧版本。预览不持久化，不保留 requestId。
- returnQuery 是同一事务内的视图，其版本号使用外层 `revision`；dryRun 外层版本不递增。
- 冲突不会阻止手工录入（课表可能真实冲突），按需在同次写入指定 returnQuery.views 包含 conflicts。

## 模块与当前范围

```text
src/schema.js  参数和实体结构
src/store.js   SQLite、事务、版本、审计、请求去重
src/engine.js  规则展开、查询、批量修改、导入、空闲与安排
src/timetable.js  命名作息表校验、按日期选表及节次解析
src/coverage.js  时间资料状态、已知边界及查询覆盖情况
src/server.js  MCP 工具、资源、HTTP/SSE/stdio 入口
```

v0.1 已实现课程按教学周重复、调停课、校历、固定活动、弹性任务、批量导入和修改。暂不包含通用日历 RRULE、自动提醒、教务抓取、双向日历同步、从某次起自动分割系列和 Web UI。可用独立规则/事件表示当前所需安排。

```bash
npm test
npm run check
```

测试覆盖真实 SDK 双传输连接、写入查询、禁用/假设启用、导入保留选择、跨范围调课、事务回滚、请求去重、磁盘重启及弹性安排。

传输基于 [官方 TypeScript MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)。优先使用 Streamable HTTP，SSE 用于兼容现有客户端。
