"use client";

import { useId, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Sheet({ title, trigger, children }: { title: string; trigger: ReactNode; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  return <>
    <button className="sheet-trigger" aria-haspopup="dialog" onClick={() => { if (dialog.current && !dialog.current.open) dialog.current.showModal(); }}>{trigger}</button>
    <dialog ref={dialog} className="sheet" aria-labelledby={id} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}>
      <div className="sheet-content"><div className="sheet-heading"><h2 id={id}>{title}</h2><button className="icon-button" aria-label="Close dialog" title="Close" onClick={() => dialog.current?.close()}><X size={20} /></button></div>{children}</div>
    </dialog>
  </>;
}
