export function groupDiagnostics(diagnostics: readonly { code: string; message: string }[]) {
  const groups = new Map<string, { count: number; examples: string[] }>();
  for (const diagnostic of diagnostics) {
    const group = groups.get(diagnostic.code) ?? { count: 0, examples: [] };
    group.count++;
    const example = diagnostic.message.length > 240 ? `${diagnostic.message.slice(0, 240)}...` : diagnostic.message;
    if (group.examples.length < 3 && !group.examples.includes(example)) group.examples.push(example);
    groups.set(diagnostic.code, group);
  }
  return groups;
}
