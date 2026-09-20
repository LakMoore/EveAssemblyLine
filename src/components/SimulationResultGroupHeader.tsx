import type { ReactNode } from "react";
import {
  Avatar,
  AvatarFallback,
  AvatarGroup,
  AvatarGroupCount,
  AvatarImage,
} from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { CollapsibleTrigger } from "@/components/ui/collapsible";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { ChevronsDownUp, ChevronsUpDown, Copy as CopyIcon } from "lucide-react";

export type SimulationGroupAvatar = {
  typeId: number;
  name: string;
  imageVariation: "icon" | "bpc" | "bp";
};

type SimulationResultGroupHeaderProps = {
  label: ReactNode;
  isOpen: boolean;
  avatarRows: SimulationGroupAvatar[];
  remainingCount: number;
  onCopyGroup?: () => void;
  copyLabel?: string;
};

/** Renders a collapsible simulation group label, previews, and optional group action. */
export default function SimulationResultGroupHeader({
  label,
  isOpen,
  avatarRows,
  remainingCount,
  onCopyGroup,
  copyLabel,
}: SimulationResultGroupHeaderProps) {
  return (
    <div className="py-4 text-foreground uppercase">
      <div className="flex flex-1 flex-row items-center justify-between gap-4 px-2">
        <h3 className="flex min-w-0 shrink grow truncate pl-2 text-lg">{label}</h3>
        <AvatarGroup className="ml-auto hidden group-data-closed/simulation-group:flex">
          {avatarRows.map((avatar, index) => (
            <Avatar key={`${avatar.typeId}-${index}`} className="size-6 md:size-10">
              <AvatarImage
                className="bg-muted"
                src={eveTypeImageUrl(avatar.typeId, avatar.imageVariation, 64)}
                alt={`${avatar.name} icon`}
              />
              <AvatarFallback>{avatar.name.slice(0, 2)}</AvatarFallback>
            </Avatar>
          ))}
          {remainingCount > 0 && (
            <AvatarGroupCount className="size-6 md:size-10">+{remainingCount}</AvatarGroupCount>
          )}
        </AvatarGroup>
        {onCopyGroup && copyLabel && (
          <Button
            type="button"
            variant="outline"
            className="shrink-0 normal-case"
            onClick={onCopyGroup}
          >
            <CopyIcon aria-hidden="true" />
            {copyLabel}
          </Button>
        )}
        <CollapsibleTrigger
          type="button"
          className="flex min-h-10 min-w-0 items-center justify-between gap-3 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit uppercase outline-none focus-visible:border-ring focus-visible:ring-1 focus-visible:ring-ring/50"
          aria-label={`${isOpen ? "Collapse" : "Expand"} ${label}`}
        >
          {isOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
        </CollapsibleTrigger>
      </div>
    </div>
  );
}
