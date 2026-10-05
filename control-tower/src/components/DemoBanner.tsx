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

import { DEMO_MODE, HOME_URL } from "@/lib/demo";
import { ArrowUpRightIcon, BinocularsIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";

/**
 * Persistent read-only demo banner.
 *
 * Renders nothing unless `NEXT_PUBLIC_DEMO_MODE=true`. When active it pins a
 * thin bar to the bottom of the viewport explaining the site is a live but
 * read-only demo and linking to the repo so visitors can deploy their own.
 *
 * The banner is `position: fixed`; `globals`/`layout` add matching bottom
 * padding so it never covers dashboard content.
 */
export default function DemoBanner() {
  if (!DEMO_MODE) return null;

  return (
    <div
      role="note"
      aria-label="Read-only demo notice"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-primary/30 bg-card/95 backdrop-blur-sm supports-backdrop-filter:bg-card/80"
    >
      <div className="mx-auto flex max-w-7xl items-center justify-center gap-2 px-4 py-2 text-center text-xs text-foreground sm:text-sm">
        <BinocularsIcon className="hidden size-4 shrink-0 text-primary sm:block" aria-hidden />
        <span>
          This is a <span className="font-semibold text-primary">live, read-only demo</span> of
          DRADIS — raptor telemetry streams in real time, but no controls are active.
        </span>
        <Button asChild variant="outline" className="ml-1 border-primary/30 text-primary">
          <a href={HOME_URL} target="_blank" rel="noopener noreferrer">
            Deploy your own <ArrowUpRightIcon data-icon="inline-end" />
          </a>
        </Button>
      </div>
    </div>
  );
}
