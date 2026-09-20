"use client";

import Image from "next/image";
import { usePathname } from "next/navigation";
import { NoPrefetchLink } from "@/components/NoPrefetchLink";
import { useState, type ReactNode } from "react";
import { eveTypeImageUrl } from "@/lib/eve/imageServer";
import { cn } from "@/lib/utils";
import CopyableText from "@/components/CopyableText";
import styles from "./TypeIdentity.module.css";
import { PackageSearch, type LucideIcon } from "lucide-react";

type TypeIdentityProps = {
  name: string;
  typeName?: string;
  subline?: ReactNode;
  typeId: number;
  imageSize?: number;
  variation?: "icon" | "render" | "bp" | "bpc";
  blueprintType?: "bpo" | "bpc";
  linkPath?: string | null;
  linkIcon?: LucideIcon;
  linkSearchParams?: Record<string, string>;
  linkHash?: string;
  navigateInPlace?: boolean;
  onNavigate?: () => void;
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
  linkPath = "assets",
  linkIcon: LinkIcon = PackageSearch,
  linkSearchParams,
  linkHash,
  navigateInPlace = false,
  onNavigate,
  className,
}: TypeIdentityProps) {
  const [useIconFallback, setUseIconFallback] = useState(false);
  const pathname = usePathname();
  const blueprintVariation = blueprintType === "bpo" ? "bp" : "bpc";
  const activeVariation = useIconFallback ? "icon" : blueprintType ? blueprintVariation : variation;
  const resolvedLinkPath =
    linkPath === "planner" && pathname.startsWith("planner") ? linkPath : pathname.slice(1);
  const linkHref =
    linkPath === null
      ? null
      : `/${resolvedLinkPath}?${new URLSearchParams({
          ...linkSearchParams,
          typeId: String(typeId),
        }).toString()}${linkHash ? `#${encodeURIComponent(linkHash)}` : ""}`;

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
        <span className={styles.nameRow}>
          {linkHref && navigateInPlace ? (
            <button
              type="button"
              className={styles.searchLink}
              title={`View ${name}`}
              aria-label={`View ${name}`}
              onClick={() => {
                onNavigate?.();
                window.history.pushState(null, "", linkHref);
                window.dispatchEvent(new PopStateEvent("popstate"));
              }}
            >
              <LinkIcon size={12} strokeWidth={2} aria-hidden="true" />
            </button>
          ) : linkHref ? (
            <NoPrefetchLink
              className={styles.searchLink}
              href={linkHref}
              title={`View ${name}`}
              aria-label={`View ${name}`}
              prefetch={false}
            >
              <LinkIcon size={12} strokeWidth={2} aria-hidden="true" />
            </NoPrefetchLink>
          ) : null}
          <CopyableText
            className={styles.name}
            title="Copy item name"
            tabIndex={-1}
            textToRender={name}
            textToCopy={name}
            copyLabel="Item name"
          />
        </span>
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
