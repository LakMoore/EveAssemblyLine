"use client";

import Image from "next/image";
import { useState } from "react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import styles from "./TypeIdentity.module.css";
import { useToast } from "./ToastProvider";

type TypeIdentityProps = {
  name: string;
  typeName?: string;
  typeId: number;
  imageSize?: number;
  variation?: "icon" | "render" | "bp" | "bpc";
  className?: string;
};

export default function TypeIdentity({
  name,
  typeName,
  typeId,
  imageSize = 32,
  variation = "icon",
  className,
}: TypeIdentityProps) {
  const { showToast } = useToast();
  const [useIconFallback, setUseIconFallback] = useState(false);
  const activeVariation = useIconFallback ? "icon" : variation;

  async function copyValue(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      showToast(`${label} copied`);
    } catch {
      showToast(`Could not copy ${label.toLowerCase()}`);
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
          onClick={() => void copyValue(name, "Item name")}
        >
          {name}
        </button>
        <button
          type="button"
          className={styles.typeId}
          title="Copy type ID"
          onClick={() => void copyValue(String(typeId), "Type ID")}
        >
          {typeName ? `${typeName} · ` : ""}Type ID {typeId}
        </button>
      </span>
    </div>
  );
}
