# Design System Document

## 1. Overview & Creative North Star: "The Sonic Brutalist"
This design system is built to bridge the gap between high-end editorial layouts and the raw, unrefined energy of alternative rock. The Creative North Star is **"The Sonic Brutalist"**—a philosophy that prioritizes massive, unapologetic typography, high-contrast color shifts, and an architectural approach to depth. 

We avoid "app-like" templates. Instead, we treat the interface as a living record sleeve. We break the grid through intentional asymmetry, allowing cover art to bleed off-edge and using oversized display type to anchor the user’s eye. This is not just a utility; it is a high-octane digital experience that feels as loud as the music it plays.

---

## 2. Colors & Surface Philosophy
The palette is rooted in a high-contrast dark mode, utilizing the signature KINK orange-yellow as a high-visibility kinetic energy source against deep, tectonic blues.

### Color Tokens (Material Convention)
- **Primary (The Pulse):** `#f8bd20` (Surface Tint) / `#ffd98a` (Primary)
- **Primary Container:** `#f3b91a` (The core "KINK" yellow-orange)
- **Surface (The Base):** `#061421` (Deep Midnight)
- **Surface Bright:** `#2d3a49` (For layered depth)
- **On-Surface:** `#d5e4f6` (Off-white for readability)

### The "No-Line" Rule
Traditional 1px borders are strictly prohibited for sectioning. This design system defines boundaries through **Background Shifts**. To separate a track listing from a player, transition from `surface` to `surface-container-low`. Visual clarity comes from tonal contrast, not structural lines.

### Surface Hierarchy & Nesting
Treat the UI as a series of stacked slabs. 
- Use `surface-container-lowest` (#020f1c) for the primary background.
- Use `surface-container` (#12212e) for persistent elements like bottom navigation.
- Use `surface-container-highest` (#283644) for interactive cards or active states.

### The "Glass & Gradient" Rule
To add "soul" to the brutalist aesthetic, use semi-transparent overlays for floating playback controls. Use `surface-variant` at 60% opacity with a `20px` backdrop blur. For primary CTAs, apply a subtle linear gradient from `primary` (#ffd98a) to `primary-container` (#f3b91a) at a 135-degree angle to create a metallic, industrial sheen.

---

## 3. Typography
The typography is the architecture of the app. We pair the aggressive, wide-set **Space Grotesk** for headings with the high-legibility **Manrope** for metadata.

- **Display-LG (Space Grotesk, 3.5rem):** Reserved for track titles in full-screen mode. Use tight letter-spacing (-0.04em) to create a "block" of text.
- **Headline-MD (Space Grotesk, 1.75rem):** Used for station names and section headers.
- **Title-LG (Manrope, 1.375rem):** Used for artist names to provide a sophisticated, editorial contrast to the display type.
- **Body-MD (Manrope, 0.875rem):** The workhorse for secondary metadata and descriptions.
- **Label-MD (Inter, 0.75rem):** Used for technical data (bitrate, duration, timestamps).

---

## 4. Elevation & Depth
We reject the standard "Material" drop shadow. Elevation in this design system is achieved through **Tonal Layering** and **Ambient Glows**.

- **The Layering Principle:** Instead of shadows, nest a `surface-container-high` card inside a `surface-container-low` area to create a "lifted" effect. 
- **Ambient Shadows:** For floating elements (like a "Now Playing" FAB), use a large, diffused shadow (`blur: 40px`) using the `primary` color at 8% opacity. This creates a subtle light leak effect rather than a dark "hole" behind the element.
- **The "Ghost Border" Fallback:** If a border is required for accessibility, use the `outline-variant` token at 15% opacity. Never use 100% opaque lines.
- **Edge Bleeds:** Large cover art should use `0px` border-radius on at least two sides (e.g., top and left) to feel integrated into the screen's frame, breaking the "contained" feel of mobile apps.

---

## 5. Components

### Full-Screen Vertical Containers (The "V-Slide")
The core navigation pattern. Each station or track is a full-screen container. 
- **Cover Art:** Occupies the top 60% of the viewport.
- **Typography Overlay:** Track titles (`Display-LG`) should overlap the cover art using a `surface` gradient mask at the bottom to ensure legibility.

### Buttons (The Kinetic Triggers)
- **Primary:** High-gloss `primary-container` background, rounded-sm (`0.125rem`). Bold, uppercase labels.
- **Secondary (The Spotify Link):** A "Ghost Border" approach. Transparent background with a `primary` ghost border (20% opacity) and the Spotify icon in `primary`.

### List Items (The Stream)
- No dividers. 
- Separate items using `8px` (`spacing-2`) of vertical white space.
- Active items use a `surface-container-highest` background with a `2px` left-accent bar in `primary`.

### Playback Icons
Icons must be "Optical-Heavy." Use a 2.5pt stroke weight for all playback controls to match the weight of the **Space Grotesk** typeface. Icons should be sized at `32px` minimum for the main player.

---

## 6. Do’s and Don’ts

### Do:
- **Do** lean into asymmetry. It’s okay if the artist's name is left-aligned while the track time is right-aligned on a different horizontal axis.
- **Do** use the `primary` color (#F3B91A) as a "highlight" tool—use it for progress bars, active states, and critical CTAs only.
- **Do** allow typography to be the hero. If the cover art is low-res, let the `Display-LG` type take over the screen.

### Don't:
- **Don't** use rounded corners larger than `xl` (0.75rem) for main containers. This system is "edgy," not "bubbly."
- **Don't** use pure black (#000000). Use the `surface` token (#061421) to maintain the "Midnight Blue" tonal depth.
- **Don't** use standard list dividers. If the list feels cluttered, increase the `spacing` scale between items rather than adding lines.