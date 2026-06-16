import { scanBalanced } from './scan';

/** Inner text of the first `( … )` call group in `expr` (e.g. `style( <here> )`). */
export function callArgsOf(expr: string): string {
  const open = expr.indexOf('(');
  const end = scanBalanced(expr, open);
  return expr.slice(open + 1, end - 1);
}
