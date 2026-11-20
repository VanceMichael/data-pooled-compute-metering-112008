# 异构算力联池的用量凭据采集与关账

这里是可离线启动的合成上游，所有编号、时间和凭据都用于联调。

## 本地运行

使用 Node.js 22.23.4。项目只使用随 Node.js 提供的运行库。

```sh
npm start
npm test
```

不同终端分别启动服务和执行独立来源测试。默认地址为 `http://127.0.0.1:4173`，可设置 `SOURCE_PORT`。来源使用进程内演练时钟，启动时处于 `live`。用 `PUT /_source_clock?step=split` 推进到下一阶段，`GET /_source_calls` 查看本实例收到的业务请求。可查阶段为 `live`、`split`、`gap`、`close`、`late`、`replay`。重启服务会重置时钟和请求记录。预置的源端回执按演练阶段出现，和本地应用是否已处理某次回执是两回事。
`npm test` 核对可访问的上游响应和合成资料。

## 来源约定

调度事件见 `/scheduler/jobs`。调度节点和机房编号来自 `/scheduler/assignment`，一个槽位可被多次切分，不保证项目与网关计数器一起变化。 `effectiveFrom` 和 `effectiveUntil` 用 UTC 记录。`/metering/catalog` 是声明的网关来源，`/metering/north` 和 `/metering/south` 返回各槽位代次及从代次开始累计的占用秒；`missing` 是采样缺段，迟到接口中的 `revises` 指向调度登记原版。迁移许可对应两个尝试和允许并行计费的时段，取消且 `billable:false` 的尝试不得扣费。
`/accounting/windows` 列出机房关账窗口和可接收调整的结算期；`POST /accounting/submit` 接收业务标识、结算期、项目、费用方向和原依据引用。`/accounting/acks` 回传结算期与项号，`received` 仅确认接收方看到请求，`cleared` 才是关账凭据。演练费率 `/accounting/rates` 用整数分每占用秒，按实际槽位收取。
