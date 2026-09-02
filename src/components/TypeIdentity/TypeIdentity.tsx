"use client";

import Image from "next/image";
import { useState } from "react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { cn } from "@/lib/utils";
import CopyableText from "@/components/CopyableText";
import styles from "./TypeIdentity.module.css";

type TypeIdentityProps = {
  name: string;
  typeName?: string;
  subline?: string;
  typeId: number;
  imageSize?: number;
  variation?: "icon" | "render" | "bp" | "bpc";
  blueprintType?: "bpo" | "bpc";
  className?: string;
};

export default function TypeIdentity({
  name,
  typeName,
  subline,
  typeId,
  imageSize = 32,
  variation = "icon",
  blueprintType,
  className,
}: TypeIdentityProps) {
  const [useIconFallback, setUseIconFallback] = useState(false);
  const blueprintVariation = blueprintType === "bpo" ? "bp" : "bpc";
  const activeVariation = useIconFallback ? "icon" : blueprintType ? blueprintVariation : variation;

  return (
    <div className={cn(styles.identity, "items-center", className)}>
      <Image
        className={styles.image}
        src={eveTypeImageUrl(typeId, activeVariation)}
        alt={`${name} icon`}
        width={imageSize}
        height={imageSize}
        style={{ width: imageSize, height: imageSize }}
        onError={() => variation === "render" && setUseIconFallback(true)}
      />
      <span className={styles.details}>
        <CopyableText
          className={styles.name}
          title="Copy item name"
          tabIndex={-1}
          textToRender={name}
          textToCopy={name}
          copyLabel="Item name"
        />
        <CopyableText
          className={styles.typeId}
          title="Copy type ID"
          tabIndex={-1}
          textToRender={`${typeName ? `${typeName} · ` : ""}Type ID ${typeId}`}
          textToCopy={String(typeId)}
          copyLabel="Type ID"
        />
        {subline && <small className={styles.subline}>{subline}</small>}
      </span>
    </div>
  );
}
