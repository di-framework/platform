import { parse } from '@marcbachmann/cel-js';

const parsed = new Map<string, ReturnType<typeof parse>>();

/**
 * cel-js `evaluate`, but each expression is parsed once. `evaluate` parses its expression on
 * every call, and the parity matrices run the same few policy rules thousands of times, so the
 * parsing dominated them and pushed them past the test timeout on a busy machine.
 */
export function evaluate(expression: string, context?: Record<string, unknown>): unknown {
  let run = parsed.get(expression);
  if (!run) {
    run = parse(expression);
    parsed.set(expression, run);
  }
  return run(context);
}
