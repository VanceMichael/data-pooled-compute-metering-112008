// 命令行：
//   node src/cli.mjs run     --source http://127.0.0.1:4173 --state var/
//   node src/cli.mjs report  bills|gaps|review|reconcile --state var/ [--project P1]

import { createClient } from './client.mjs';
import { loadLedger, saveLedger } from './ledger.mjs';
import { runPass } from './pass.mjs';

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) args[token.slice(2)] = argv[index + 1] && !argv[index + 1].startsWith('--') ? argv[++index] : true;
    else args._.push(token);
  }
  return args;
}

const print = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const stateDir = args.state ?? 'var';

  if (command === 'run') {
    const source = args.source ?? 'http://127.0.0.1:4173';
    const state = await loadLedger(stateDir);
    const { report, submitted } = await runPass(state, createClient(source), { submit: args['dry-run'] !== true });
    await saveLedger(stateDir, state);
    print({
      submitted: report.submittedThisPass,
      lines: state.lines.length,
      requisitions: report.requisitions.length,
      held: report.review.held.length,
      unattributed: report.review.unattributed.length,
      flags: report.flags,
      note: submitted.length ? '本 pass 有新提交' : '本 pass 无新提交（幂等）',
    });
    return;
  }

  if (command === 'report') {
    const kind = args._[1];
    const state = await loadLedger(stateDir);
    const report = state.lastReport;
    if (!report) throw new Error('台账中还没有报告，请先执行 run');
    if (kind === 'bills') {
      const bills = args.project ? { [args.project]: report.bills[args.project] ?? null } : report.bills;
      print(bills);
    } else if (kind === 'gaps') {
      print(report.requisitions);
    } else if (kind === 'review') {
      print(report.review);
    } else if (kind === 'reconcile') {
      print(report.reconciliation);
    } else {
      throw new Error(`未知报告类型: ${kind}（可选 bills|gaps|review|reconcile）`);
    }
    return;
  }

  process.stderr.write('用法: cli.mjs run --source URL --state DIR [--dry-run] | cli.mjs report bills|gaps|review|reconcile --state DIR [--project P]\n');
  process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
