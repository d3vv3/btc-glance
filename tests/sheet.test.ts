import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it, vi } from "vitest";

it("does not reopen an already open sheet on repeated clicks", () => {
  const dialog = { open: false, showModal: vi.fn(() => { dialog.open = true; }) };
  const jsx = (type: any, props: any) => ({ type, props });
  const exports: { Sheet?: (props: any) => any } = {};
  const source = readFileSync(new URL("../src/components/Sheet.tsx", import.meta.url), "utf8");
  runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX } }).outputText, {
    exports, require: (name: string) => name === "react" ? { useRef: () => ({ current: dialog }), useId: () => "sheet" } : name === "react/jsx-runtime" ? { jsx, jsxs: jsx } : {},
  });
  const trigger = exports.Sheet!({ title: "Install", trigger: "Install", children: "Guidance" }).props.children[0];
  trigger.props.onClick(); trigger.props.onClick();
  expect(dialog.showModal).toHaveBeenCalledOnce();
  dialog.open = false; trigger.props.onClick();
  expect(dialog.showModal).toHaveBeenCalledTimes(2);
});
