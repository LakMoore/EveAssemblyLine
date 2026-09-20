import type { ReactNode } from "react";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";

type SimulationsResultsTabProps = {
  settings?: ReactNode;
  children: ReactNode;
  hasResults: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
};

/** Renders shared simulation-tab settings and a generic empty result state. */
export default function SimulationsResultsTab({
  settings,
  children,
  hasResults,
  emptyTitle = "No results",
  emptyDescription = "This simulation has no results in this category.",
}: SimulationsResultsTabProps) {
  if (!hasResults) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {settings}
      {children}
    </div>
  );
}
