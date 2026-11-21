# 异构算力联池的用量凭据采集与关账

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可通过 `SOURCE_PORT` 设置端口，也接受通用的 `PORT`，同时设置时以 `SOURCE_PORT` 为准。`GET /health` 用于确认来源服务已就绪。来源使用进程内演练时钟，启动时处于 `live`。用 `PUT /_source_clock?step=split` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `live`、`split`、`gap`、`close`、`late`、`replay`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

调度事件见 `/scheduler/jobs`。调度节点和机房编号来自 `/scheduler/assignment`，一个槽位可被多次切分，不保证项目与网关计数器一起变化。 `effectiveFrom` 和 `effectiveUntil` 用 UTC 记录。`/metering/catalog` 是声明的网关来源，`/metering/north` 和 `/metering/south` 返回各槽位代次及从代次开始累计的占用秒；`missing` 是采样缺段，迟到接口中的 `revises` 指向调度登记原版。迁移许可对应两个尝试和允许并行计费的时段，取消且 `billable:false` 的尝试不得扣费。
`/accounting/windows` 列出机房关账窗口和可接收调整的结算期；`POST /accounting/submit` 接收业务标识、结算期、项目、费用方向和原依据引用。`/accounting/acks` 回传结算期与项号，`received` 仅确认接收方看到请求，`cleared` 才是关账凭据。演练费率 `/accounting/rates` 用整数分每占用秒，按实际槽位收取。

## 对账应用（src/）

`src/` 是对接上述来源的本地对账应用，只用 Node.js 内置模块：

- `metering.mjs` 计量：同槽同代次相邻采样差分成段（设备重启换代次即不可跨界，交界窗口记为不可计量）；重复/迟到采样去重重排；零增量段即空闲等待，不计费。
- `attribution.mjs` 归属：同槽切分登记按 `effectiveFrom` 后者优先，`revises` 更正只替换其指向的登记；段内项目唯一才算稳定归属；段横跨切卡/账期边界且无分界读数时不按时间硬拆，单独报告未归属用量并列出缺失的边界读数。
- `overlap.mjs` 并跑：同迁移组不同尝试的实际占用重叠，只有被许可窗口完整覆盖才允许双侧计费；未经许可又确实同时占用的段双侧留凭据待核，不擅自只向一池计费。
- `billing.mjs` 账务：业务标识由计量依据确定性生成，运行重试不重复扣收；已确认（cleared/received）行的归属更正在 `adjustmentTarget` 期生成成对调整（原项目冲回 + 新项目补记，指向原行业务标识），原已接收账单保持可对账；未确认行的更正只标记，先与财务确认，不擅自调整或重发。
- `ledger.mjs` 台账：提交行含提交时的逐卡计量依据快照（已关账结果据此对账）；按接收方批次项（acks）对账，`received ≠ cleared`。
- `reports.mjs` 报告：项目账单追到调度与网关原始依据；采样缺口说明涉及哪部分、需向谁补领哪些边界读数、哪些账期可能受影响；失败不收费尝试保有消耗凭据。

### 使用

```sh
npm start                 # 终端 1：启动来源服务
npm run reconcile -- --state var/          # 终端 2：跑一次对账 pass（提交 + 对回执）
npm run report -- bills --state var/       # 项目账单（可加 --project P1）
npm run report -- gaps --state var/        # 采样缺口与补领清单
npm run report -- review --state var/      # 未归属/待核/非计费凭据
npm run report -- reconcile --state var/   # 关账对账状态
npm run demo              # 自起来源，走 live→…→replay 六阶段演练
```

台账落在 `--state` 目录（默认 `var/`），重复执行 `run` 幂等。
