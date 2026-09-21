import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...values: ClassValue[]) {
  // The Tailwind rule cannot distinguish clsx's dynamic ClassValue input from a class name.
  // eslint-disable-next-line tailwindcss/no-custom-classname
  return twMerge(clsx(values));
}
