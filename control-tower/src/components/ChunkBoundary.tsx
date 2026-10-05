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

import { Component, type ReactNode } from "react";
import { WarningIcon } from "@phosphor-icons/react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

// ── Chunk-load boundary ───────────────────────────────────────────────────────
//
// The heavy panels are `next/dynamic` imports, so their JavaScript arrives in a
// separate request made when the operator opens the tab. That request can fail —
// a flaky connection, an nginx hiccup on the AMI, or a dev server still
// compiling the route. Without a boundary the failure propagates as a render
// error and the whole dashboard goes with it: a blank page, a console message
// the operator will not see, and no way back except knowing to hard-reload.
//
// A chunk failure is also unusually recoverable, which is why it is worth
// catching rather than letting the app die: the request simply needs making
// again, and remounting does exactly that.

interface Props {
  /** Panel name, shown in the message so the operator knows what failed. */
  name: string;
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** Bumped to remount the subtree, which re-issues the chunk request. */
  attempt: number;
}

export default class ChunkBoundary extends Component<Props, State> {
  state: State = { error: null, attempt: 0 };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Left in the console deliberately — the operator sees the panel below,
    // but a support conversation wants the original message.
    console.error("[DRADIS] panel failed to load:", error);
  }

  render() {
    const { error, attempt } = this.state;
    if (!error) {
      // `key` forces a fresh mount on retry so the failed import is re-run.
      return <div key={attempt}>{this.props.children}</div>;
    }
    return (
      <Alert variant="destructive">
        <WarningIcon />
        <AlertTitle>{this.props.name} could not be loaded</AlertTitle>
        <AlertDescription>
          <p>
            Its code failed to download. The engine and your squadrons are unaffected — this is the
            dashboard only.
          </p>
          <Button
            variant="outline"
            onClick={() => this.setState({ error: null, attempt: attempt + 1 })}
          >
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }
}
