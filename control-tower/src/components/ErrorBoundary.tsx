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

interface Props {
  children: ReactNode;
  /** Short label shown in the fallback card, e.g. "Telemetry". */
  label?: string;
}

interface State {
  error: Error | null;
}

/**
 * Localized error boundary. Prevents a render-time exception in one view (e.g. a
 * formatter hitting unexpected data) from white-screening the entire dashboard.
 * The failed subtree degrades to an inline card; the rest of the app keeps working.
 */
export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: unknown) {
    // Surface to the console for debugging; no external reporting.
    console.error(`[${this.props.label ?? "view"}] render error:`, error, info);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (this.state.error) {
      return (
        <Alert variant="destructive">
          <WarningIcon />
          <AlertTitle>{this.props.label ?? "This view"} failed to render.</AlertTitle>
          <AlertDescription>
            <p className="break-all">{this.state.error.message}</p>
            <Button variant="outline" onClick={this.reset}>
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      );
    }
    return this.props.children;
  }
}
