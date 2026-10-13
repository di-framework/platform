import { writeFile } from 'node:fs/promises';
import { nodeIo } from './io.ts';
import { type AgentRequest, parseRequest, runAgent } from './run.ts';

const parsed = parseRequest(process.env);
if (!('kind' in parsed)) {
  await writeFile(process.env.TERMINATION_LOG ?? '/dev/termination-log', JSON.stringify(parsed));
  process.exit(1);
}

process.exit(await runAgent(parsed as AgentRequest, nodeIo()));
