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
import styles from "@/app/page.module.css";
import { ChevronsDownUp, ChevronsUpDown, Copy as CopyIcon } from "lucide-react";

type PlannerGroupAvatar = {
  typeId: number;
  name: string;
  imageVariation: "icon" | "bpc" | "bp";
};

type PlannerResultGroupHeaderProps = {
  label: string;
  isOpen: boolean;
  avatarRows: PlannerGroupAvatar[];
  remainingCount: number;
  onCopyGroup?: () => void;
  copyLabel?: string;
};

/** Renders a collapsible planner group label, previews, and optional group action. */
export default function PlannerResultGroupHeader({
  label,
  isOpen,
  avatarRows,
  remainingCount,
  onCopyGroup,
  copyLabel,
}: PlannerResultGroupHeaderProps) {
  return (
    <h3 className={styles.locationGroupHeader}>
      <CollapsibleTrigger
        type="button"
        className="flex min-h-10 min-w-0 flex-1 items-center justify-between gap-3 border-0 bg-transparent p-0 text-left font-[inherit] text-inherit uppercase"
        aria-label={`${isOpen ? "Collapse" : "Expand"} ${label}`}
      >
        <span className="min-w-0 truncate">{label}</span>
        <AvatarGroup className="ml-auto hidden group-data-closed/plan-group:flex">
          {avatarRows.map((avatar, index) => (
            <Avatar key={`${avatar.typeId}-${index}`} size="lg">
              <AvatarImage
                className="bg-muted"
                src={eveTypeImageUrl(avatar.typeId, avatar.imageVariation, 64)}
                alt={`${avatar.name} icon`}
              />
              <AvatarFallback>{avatar.name.slice(0, 2)}</AvatarFallback>
            </Avatar>
          ))}
          {remainingCount > 0 && <AvatarGroupCount>+{remainingCount}</AvatarGroupCount>}
        </AvatarGroup>
        {isOpen ? <ChevronsDownUp /> : <ChevronsUpDown />}
      </CollapsibleTrigger>
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
    </h3>
  );
}
