// 本地合成上游的 HTTP 客户端：调度事件、计量网关、账务接收方。

export function createClient(base) {
  const get = async (path) => {
    const response = await fetch(base + path);
    if (!response.ok) throw new Error(`GET ${path} → HTTP ${response.status}`);
    return response.json();
  };

  return {
    base,
    jobs: () => get('/scheduler/jobs'),
    permits: () => get('/scheduler/permits'),
    assignments: () => get('/scheduler/assignment'),
    catalog: () => get('/metering/catalog'),
    metering: (path) => get(path),
    rates: () => get('/accounting/rates'),
    windows: () => get('/accounting/windows'),
    acks: () => get('/accounting/acks'),
    // 提交计费/调整行。返回 null 表示提交结果不明（网络异常等），
    // 调用方必须按“先与财务确认、不擅自重发”处理。
    submit: async (line) => {
      const response = await fetch(`${base}/accounting/submit`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(line),
      });
      const body = await response.json().catch(() => null);
      return { httpStatus: response.status, body };
    },
  };
}

// 一次抓取全部来源快照：调度（作业/许可/切分登记）、各机房计量、账务窗口与回执。
export async function fetchSnapshot(client) {
  const [jobs, permits, assignments, catalog, rates, windows, acks] = await Promise.all([
    client.jobs(),
    client.permits(),
    client.assignments(),
    client.catalog(),
    client.rates(),
    client.windows(),
    client.acks(),
  ]);
  const metering = {};
  for (const [pool, path] of Object.entries(catalog.pools)) {
    metering[pool] = { path, ...(await client.metering(path)) };
  }
  return { jobs, permits, assignments, catalog, rates, windows, acks, metering };
}
