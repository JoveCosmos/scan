import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * A chain accent as a text colour. Accents are tuned for the dark ground; on
 * the light one they are mixed toward black so a pale yellow or cyan still
 * reads. The amount lives in the theme (`--accent-ink-mix`), not here.
 */
export function ink(accent: string): string {
  return `color-mix(in oklab, ${accent} var(--accent-ink-mix), black)`
}
