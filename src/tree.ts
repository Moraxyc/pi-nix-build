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

export interface PrunedRow {
  drv: string;
  /** Tree connectors for this row, e.g. `""` for roots or `"│  ├─ "` for nested items. */
  prefix: string;
  /** Number of descendants hidden below this row due to the row budget. */
  hiddenDescendants: number;
  hiddenDrvs: string[];
}

export interface PrunedForest {
  rows: PrunedRow[];
  /** Top-level roots omitted when even depth 0 exceeds `maxRows`. */
  omittedRoots: number;
}

/**
 * Renders `roots` within `maxRows` lines by choosing the deepest uniform depth that fits.
 * When `roots` itself exceeds `maxRows`, keeps the leading roots and reports `omittedRoots`.
 */
export function pruneForest(roots: readonly TreeNode[], maxRows: number): PrunedForest {
  if (roots.length === 0 || maxRows <= 0) return { rows: [], omittedRoots: 0 };

  if (roots.length > maxRows) {
    const shownCount = maxRows > 1 ? maxRows - 1 : 1;
    const rows = roots.slice(0, shownCount).map((root) => {
      const hiddenDrvs = collectDescendants(root);
      return { drv: root.drv, prefix: "", hiddenDescendants: hiddenDrvs.length, hiddenDrvs };
    });
    return { rows, omittedRoots: roots.length - shownCount };
  }

  const height = forestDepth(roots);
  let chosenDepth = 0;
  for (let depth = 0; depth <= height; depth++) {
    if (countAtDepth(roots, depth) <= maxRows) chosenDepth = depth;
    else break;
  }

  const rows: PrunedRow[] = [];
  const walk = (nodes: readonly TreeNode[], indent: string, depth: number) => {
    nodes.forEach((node, index) => {
      const last = index === nodes.length - 1;
      const branch = depth === 0 ? "" : last ? "└─ " : "├─ ";
      const cut = depth === chosenDepth && node.children.length > 0;
      const hiddenDrvs = cut ? collectDescendants(node) : [];
      rows.push({
        drv: node.drv,
        prefix: `${indent}${branch}`,
        hiddenDescendants: hiddenDrvs.length,
        hiddenDrvs,
      });
      if (depth < chosenDepth) {
        const childIndent = depth === 0 ? indent : `${indent}${last ? "   " : "│  "}`;
        walk(node.children, childIndent, depth + 1);
      }
    });
  };
  walk(roots, "", 0);
  return { rows, omittedRoots: 0 };
}

function forestDepth(nodes: readonly TreeNode[]): number {
  let max = 0;
  for (const node of nodes) {
    if (node.children.length > 0) {
      max = Math.max(max, 1 + forestDepth(node.children));
    }
  }
  return max;
}

function countAtDepth(nodes: readonly TreeNode[], maxDepth: number, depth = 0): number {
  let count = 0;
  for (const node of nodes) {
    count++;
    if (depth < maxDepth) count += countAtDepth(node.children, maxDepth, depth + 1);
  }
  return count;
}

function collectDescendants(root: TreeNode): string[] {
  const drvs: string[] = [];
  const visit = (nodes: readonly TreeNode[]) => {
    for (const node of nodes) {
      drvs.push(node.drv);
      visit(node.children);
    }
  };
  visit(root.children);
  return drvs;
}
