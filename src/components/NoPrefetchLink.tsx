import Link from "next/link";
import type { LinkProps } from "next/link";
import type { AnchorHTMLAttributes, ReactNode } from "react";

type Props = LinkProps
  & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, "href"> & {
    children?: ReactNode;
    className?: string;
    prefetch?: LinkProps["prefetch"];
  };

export function NoPrefetchLink({ children, prefetch = false, ...rest }: Props) {
  return (
    <Link {...rest} prefetch={prefetch}>
      {children}
    </Link>
  );
}
