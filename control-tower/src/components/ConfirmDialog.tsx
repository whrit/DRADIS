"use client";

// SPDX-License-Identifier: AGPL-3.0-only
//
// DRADIS Control Tower — operator dashboard for the DRADIS trading engine.
// Copyright (C) 2026 Michael Bordash
//
// This file is part of DRADIS. DRADIS is free software: you can redistribute it
// and/or modify it under the terms of the GNU Affero General Public License,
// version 3, as published by the Free Software Foundation.
//
// DRADIS is distributed in the hope that it will be useful, but WITHOUT ANY
// WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR
// A PARTICULAR PURPOSE. See the GNU Affero General Public License for details.
//
// You should have received a copy of the GNU Affero General Public License along
// with this program. If not, see <https://www.gnu.org/licenses/>.

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

/**
 * In-app replacement for `window.confirm`.
 *
 * The native dialog is unstyled, cannot render structured content (the risk
 * profile apply needs to list the squadrons it is about to overwrite), and
 * blocks the JS thread — which stalls SWR polling behind it. This keeps the
 * Control Tower's own look and lets a confirmation show real data.
 *
 * Uses the shared dialog primitives so all overlays match.
 */

export interface ConfirmOptions {
  title: string;
  /** Structured body — plain text, or JSX for lists/emphasis. */
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  /** `danger` styles the confirm button as destructive. */
  tone?: "default" | "danger";
}

/**
 * Promise-based confirm, so call sites keep the `if (!(await confirm(...))) return;`
 * shape that `window.confirm` had.
 *
 * ```tsx
 * const [confirm, confirmDialog] = useConfirm();
 * ...
 * if (!(await confirm({ title: 'Restart?' }))) return;
 * return <>{confirmDialog}{...}</>;
 * ```
 */
export function useConfirm(): [(opts: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  // Held across renders so resolve() survives the re-render that opens the dialog.
  const resolver = useRef<((ok: boolean) => void) | null>(null);

  const confirm = useCallback((o: ConfirmOptions) => {
    // A second call while one is pending would strand the first promise forever
    // and leak the caller's `await`. Resolve it as cancelled first.
    resolver.current?.(false);
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((ok: boolean) => {
    resolver.current?.(ok);
    resolver.current = null;
    setOpts(null);
  }, []);

  const dialog = opts ? <ConfirmDialog opts={opts} onResolve={settle} /> : null;

  return [confirm, dialog];
}

function ConfirmDialog({
  opts,
  onResolve,
}: {
  opts: ConfirmOptions;
  onResolve: (ok: boolean) => void;
}) {
  const confirmBtn = useRef<HTMLButtonElement>(null);

  // Escape and backdrop clicks cancel, matching the previous dialog.
  // Focus the confirm action so Enter works without reaching for the mouse.
  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (
        event.target instanceof Element &&
        event.target.matches('[data-slot="alert-dialog-overlay"]')
      )
        onResolve(false);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [onResolve]);

  const danger = opts.tone === "danger";

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onResolve(false);
      }}
    >
      <AlertDialogContent
        className="max-h-dvh overflow-y-auto sm:max-w-md"
        aria-describedby={opts.body != null ? "confirm-dialog-body" : undefined}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          confirmBtn.current?.focus();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{opts.title}</AlertDialogTitle>
          {opts.body != null && (
            <AlertDialogDescription asChild>
              <div
                id="confirm-dialog-body"
                className="max-h-96 space-y-2 overflow-y-auto text-xs text-muted-foreground"
              >
                {opts.body}
              </div>
            </AlertDialogDescription>
          )}
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel
            onClick={(event) => {
              event.preventDefault();
              onResolve(false);
            }}
          >
            {opts.cancelLabel ?? "Cancel"}
          </AlertDialogCancel>
          <AlertDialogAction
            ref={confirmBtn}
            variant={danger ? "destructive" : "default"}
            onClick={(event) => {
              event.preventDefault();
              onResolve(true);
            }}
          >
            {opts.confirmLabel ?? "Confirm"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
