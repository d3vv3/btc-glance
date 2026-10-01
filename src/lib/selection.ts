import type { Operator } from "./types";

// Only public selection state travels between pages. Private records never enter the URL.
export function selectionHref(path: "/" | "/watches" | "/history", search: string, condition?: { threshold: number; operator: Operator }): string {
  const source = new URLSearchParams(search);
  const params = new URLSearchParams();
  for (const key of ["market", "topicId", "watch", "snapshotId", "boundary", "operator"]) {
    const value = source.get(key);
    if (value !== null) params.set(key, value);
  }
  if (condition) { params.set("boundary", String(condition.threshold)); params.set("operator", condition.operator); }
  return path + (params.size ? `?${params}` : "");
}
