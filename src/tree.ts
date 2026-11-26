export interface TreeNode {
  drv: string;
  children: TreeNode[];
}

/**
 * The builds matching `keep` and the dependents leading to them, as a forest rooted at the
 * builds nothing kept depends on. A shared dependency appears once, under its first dependent.
 */
export function dependencyForest(
  drvs: readonly string[],
  inputsOf: (drv: string) => readonly string[] | undefined,
  keep: (drv: string) => boolean,
): TreeNode[] {
  const known = new Set(drvs);
  const dependents = new Map<string, string[]>();
  for (const drv of drvs) {
    for (const input of inputsOf(drv) ?? []) {
      if (!known.has(input)) continue;
      const list = dependents.get(input);
      if (list) list.push(drv);
      else dependents.set(input, [drv]);
    }
  }

  const kept = new Set<string>();
  const pending = drvs.filter(keep);
  while (pending.length > 0) {
    const drv = pending.pop() as string;
    if (kept.has(drv)) continue;
    kept.add(drv);
    pending.push(...(dependents.get(drv) ?? []));
  }

  const placed = new Set<string>();
  const grow = (drv: string): TreeNode => {
    placed.add(drv);
    const children: TreeNode[] = [];
    for (const input of inputsOf(drv) ?? []) {
      if (kept.has(input) && !placed.has(input)) children.push(grow(input));
    }
    return { drv, children };
  };
  const isRoot = (drv: string) => !(dependents.get(drv) ?? []).some((parent) => kept.has(parent));
  return drvs.filter((drv) => kept.has(drv) && isRoot(drv)).map(grow);
}
