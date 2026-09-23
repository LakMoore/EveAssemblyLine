"use client";

import { ChartLine } from "lucide-react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import styles from "@/app/page.module.css";
import { cn } from "@/lib/utils";

/** Shows the current total quantity of buy orders for a material type. */
export default function MarketBuyOrderIndicator({ quantity }: { quantity: number }) {
  if (quantity <= 0) return null;
  const label = `Buy Orders: ${quantity.toLocaleString()}`;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={label}
            className={cn(styles.simulationSourceIcon, "size-5 shrink-0 p-0")}
            data-source="market"
          >
            <ChartLine aria-hidden="true" size={14} strokeWidth={1.8} />
          </Button>
        }
      />
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}
