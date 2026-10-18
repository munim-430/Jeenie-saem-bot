"use client";

import { useEffect, useRef, useState } from "react";
import { Shirt } from "lucide-react";
import type { AvatarDirector } from "@/hooks/useAvatarDirector";
import { OUTFIT_LABELS, OUTFITS } from "@/lib/avatar/clips";
import { cn } from "@/lib/utils";

// Wardrobe: picks what Jeannie wears. The choice is remembered on this device; the stage plays a
// sparkle over the swap (both outfits share the same pose, so the change reads as one move).

interface WardrobeButtonProps {
  director: AvatarDirector;
  /** Classes for the round trigger (the avatar screen and the desktop frame size it differently). */
  className?: string;
  /** Which edge the menu lines up with, so it opens toward the middle of the screen. */
  align?: "left" | "right";
}

export function WardrobeButton({ director, className, align = "left" }: WardrobeButtonProps) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !root.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={root} className="wardrobe">
      <button
        type="button"
        className={cn("avatar-fab", className)}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-label={`Wardrobe: ${OUTFIT_LABELS[director.outfit]}`}
        title="Wardrobe"
        data-wardrobe=""
      >
        <Shirt className="h-[1.1rem] w-[1.1rem]" aria-hidden="true" />
      </button>
      {open ? (
        <div className="wardrobe-menu" data-align={align} role="radiogroup" aria-label="Outfit">
          {OUTFITS.map((outfit) => (
            <button
              key={outfit}
              type="button"
              role="radio"
              aria-checked={director.outfit === outfit}
              data-outfit={outfit}
              onClick={() => {
                director.setOutfit(outfit);
                setOpen(false);
              }}
            >
              {OUTFIT_LABELS[outfit]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
