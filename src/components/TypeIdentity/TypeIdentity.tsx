"use client";

import Image from "next/image";
import { useState } from "react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { toast } from "@/components/ui/toast";
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

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      toast.add({ description: `${label} copied` });
    }
    catch {
      toast.add({ description: `Could not copy ${label.toLowerCase()}`, type: "error" });
    }
  }

  return (
    <div className={`${styles.identity} ${className ?? ""}`}>
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
        <button
          type="button"
          className={styles.name}
          title="Copy item name"
          tabIndex={-1}
          onClick={() => void copyValue(name, "Item name")}
        >
          {name}
        </button>
        <button
          type="button"
          className={styles.typeId}
          title="Copy type ID"
          tabIndex={-1}
          onClick={() => void copyValue(String(typeId), "Type ID")}
        >
          {typeName ? `${typeName} · ` : ""}Type ID {typeId}
        </button>
        {subline && <small className={styles.subline}>{subline}</small>}
      </span>
    </div>
  );
}