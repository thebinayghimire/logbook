---
name: Almanac Minimal
colors:
  surface: '#fcf9f2'
  surface-dim: '#dcdad3'
  surface-bright: '#fcf9f2'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f6f3ec'
  surface-container: '#f1eee7'
  surface-container-high: '#ebe8e1'
  surface-container-highest: '#e5e2db'
  on-surface: '#1c1c18'
  on-surface-variant: '#49473f'
  inverse-surface: '#31312c'
  inverse-on-surface: '#f3f0e9'
  outline: '#7a776e'
  outline-variant: '#cac6bc'
  surface-tint: '#615e55'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1d1c14'
  on-primary-container: '#87847a'
  inverse-primary: '#cac6bb'
  secondary: '#b51c00'
  on-secondary: '#ffffff'
  secondary-container: '#dc3214'
  on-secondary-container: '#fffbff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#1e1c13'
  on-tertiary-container: '#888378'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e7e2d6'
  primary-fixed-dim: '#cac6bb'
  on-primary-fixed: '#1d1c14'
  on-primary-fixed-variant: '#49473e'
  secondary-fixed: '#ffdad3'
  secondary-fixed-dim: '#ffb4a5'
  on-secondary-fixed: '#3e0400'
  on-secondary-fixed-variant: '#8e1400'
  tertiary-fixed: '#e8e2d4'
  tertiary-fixed-dim: '#ccc6b9'
  on-tertiary-fixed: '#1e1c13'
  on-tertiary-fixed-variant: '#4a473d'
  background: '#fcf9f2'
  on-background: '#1c1c18'
  surface-variant: '#e5e2db'
typography:
  metric-hero:
    fontFamily: Newsreader
    fontSize: 5.5rem
    fontWeight: '400'
    lineHeight: '1'
    letterSpacing: -0.03em
  headline-xl:
    fontFamily: Newsreader
    fontSize: 3rem
    fontWeight: '400'
    lineHeight: '1.15'
    letterSpacing: -0.02em
  headline-lg:
    fontFamily: Newsreader
    fontSize: 2rem
    fontWeight: '400'
    lineHeight: '1.2'
    letterSpacing: -0.015em
  headline-md:
    fontFamily: Newsreader
    fontSize: 1.5rem
    fontWeight: '400'
    lineHeight: '1.3'
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Hanken Grotesk
    fontSize: 1.125rem
    fontWeight: '400'
    lineHeight: '1.6'
  body-md:
    fontFamily: Hanken Grotesk
    fontSize: 0.9375rem
    fontWeight: '400'
    lineHeight: '1.5'
  body-sm:
    fontFamily: Hanken Grotesk
    fontSize: 0.8125rem
    fontWeight: '400'
    lineHeight: '1.4'
  mono-data:
    fontFamily: JetBrains Mono
    fontSize: 0.875rem
    fontWeight: '500'
    lineHeight: '1.4'
  label-mono:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: '500'
    lineHeight: '1.2'
    letterSpacing: 0.08em
  label-mono-bold:
    fontFamily: JetBrains Mono
    fontSize: 0.6875rem
    fontWeight: '700'
    lineHeight: '1.2'
    letterSpacing: 0.1em
spacing:
  gutter: 1.5rem
  gutter-desktop: 2rem
  margin: 1.5rem
  margin-desktop: 3rem
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
  space-2xl: 4rem
  space-3xl: 6rem
---

## Brand & Style

This design system translates personal GitHub telemetry into the physical gravitas of a printed archival almanac. The target user is a craft-conscious engineer who views software creation as an enduring trade rather than ephemeral digital noise. The emotional tenor is focused, archival, and definitive: quiet confidence born from disciplined labor, stripped of SaaS ornamentation, marketing fluff, and dynamic clutter.

The aesthetic fuses **Editorial Minimalism** with **Archival Print Typography**:
- Absolute reliance on typographic tension, scale disparity, and raw whitespace.
- Zero cards, zero drop-shadows, zero surface blurs, and zero rounded pill containers.
- Spatial division achieved exclusively through structural 1px hairline rules, tabular layouts, and rigorous baseline grids.
- Warm paper grounds meet deep carbon ink, punctured by surgical strokes of vermilion ink applied strictly to critical indices, active states, and alert thresholds.

## Colors

The palette reproduces the tactile conditions of a physical ledger printed on rag paper with dense carbon pigment and specialized offset spot inks.

### Structural Palette
- **Paper Canvas (`neutral_color_hex` / `#F4F1EA`)**: The base material surface across the entire screen. Never overlay with stark white surfaces or floating panels.
- **Deep Carbon Ink (`primary_color_hex` / `#17160F`)**: High-contrast pigment for primary headings, massive metric values, and primary text.
- **Muted Ink (`tertiary_color_hex` / `#6B675C`)**: Softened ink for secondary metadata, descriptions, table column headers, and inactive states.
- **Vermilion Accent (`secondary_color_hex` / `#E5391A`)**: A piercing, traditional stamp ink reserved for focal points: current live streaks, active commit pointers, selected tab underlines, and broken builds. It must occupy less than 5% of any given view.
- **Hairline Ink (`rgba(23, 22, 15, 0.14)`)**: A calibrated dilution of carbon ink used for all structural grid axes, borders, and separator rules.

### Chart Inks
Designed to register cleanly without harsh visual vibration:
- **Teal**: `#2E7D6B` (Additions / Merges)
- **Mustard**: `#D9A21B` (Code reviews / Open tickets)
- **Dusty Blue**: `#4A6A94` (Language breakdown / Python or Go)
- **Rose**: `#D98A94` (Deletions / Refactors)
- **Olive**: `#7C8444` (Documentation / Tests)
- **Slate**: `#5B5F66` (Infrastructure / Chore)

### Heatmap Density Ramp
A strictly calculated value ramp on raw paper:
- **Level 0 (Empty)**: `#E6E1D3`
- **Level 1 (Sparse)**: `#C9C2AE`
- **Level 2 (Moderate)**: `#9A9380`
- **Level 3 (Dense)**: `#5A5648`
- **Level 4 (Peak)**: `#17160F`

## Typography

Typography governs this system completely. Hierarchy is defined by scale and family changes rather than tonal shifts or background blocks.

- **Newsreader**: The voice of history and authority. Used for massive summary statistics, editorial logbook entries, and section headers. Numerals should use proportional or tabular figures depending on context, keeping italics for editorial notes and metadata citations.
- **Hanken Grotesk**: The functional interface voice. Provides an unobtrusive, highly legible human conduit for navigation, commit messages, and descriptive paragraphs.
- **JetBrains Mono**: The technical ledger voice. Used for all tabular metrics, commit hashes, timestamps, language tags, and column headers. Always styled in uppercase when serving as a section subhead or metadata label (`label-mono`), tracking out to 0.08em–0.1em for maximum clarity at small sizes.

## Layout & Spacing

The layout is desktop-first, designed for an optimal canvas width of 1440px with a hard container max-width of 1360px centered horizontally.

### Structural Model
- Built upon a strict 12-column ledger grid.
- Rather than modular elevated boxes, sections are separated by structural hairline borders (`1px solid rgba(23, 22, 15, 0.14)`).
- Vertical rhythm follows multiples of `0.5rem` (8px). Major thematic segments utilize generous vertical margins (`space-2xl` to `space-3xl`) to establish the pacing of an unbound printed folio.
- Data density within individual ledger tables remains compact, utilizing `space-xs` and `space-sm` row padding to maximize information density.

### Breakpoint Scaling
- **Desktop (1440px and above)**: Full 12-column layout. Metric hero panels span 3 or 4 columns with hairlines bordering adjacent quadrants.
- **Tablet (768px – 1024px)**: 8-column layout. Margins collapse to `1.5rem`. Metric blocks reflow to 2 columns with shared horizontal dividers.
- **Mobile (< 768px)**: 4-column layout. All grid boundaries stack sequentially. The primary `metric-hero` scales down to `3.5rem` to avoid line breaks.

## Elevation & Depth

This system rejects simulated three-dimensional space. The UI is strictly two-dimensional, referencing printed paper, hot-metal typography, and hand-bound ledgers.

- **Zero Shadows**: No box-shadows, drops, ambient glows, or inner bevels exist anywhere in the system.
- **Zero Translucency**: No frosted backdrops, blurs, or tinted translucent overlays. Surfaces are opaque and share the ground `#F4F1EA`.
- **Hairline Division**: Visual layering is created purely by 1px rules colored `rgba(23, 22, 15, 0.14)`. When elements need delineation, they are partitioned by these rules along the horizontal and vertical axes.
- **Hover & Focus States**: Interactions are signaled via immediate typographic state changes (e.g., underline shifts, italicization, vermilion tinting, or a solid 1px carbon ink underline) rather than physical lifts or depth transitions.

## Shapes

Every corner is absolutely sharp (`0px` border radius). 

Curvature contradicts the vernacular of physical bookbinding, letterpress plates, and raw algorithmic output. Rectangles, indicators, buttons, heatmap tiles, and table borders are rendered with pure orthogonal precision.

## Components

### Buttons & Action Triggers
- **Primary Action**: Solid `#17160F` rectangle with `#F4F1EA` text set in `JetBrains Mono` (0.75rem, uppercase, 0.08em tracking). No border-radius. On hover, background shifts to `#E5391A`.
- **Secondary Action**: Transparent background with a 1px border of `#17160F` and carbon text. On hover, inverts to solid `#17160F` with `#F4F1EA` text.
- **Text Action**: Unadorned text featuring a persistent 1px hairline underline offset by 4px. On hover, underline turns `#E5391A`.

### Tables & Ledgers
- The primary vehicle for commit histories, PR reviews, and file diffs.
- Header row styled in `label-mono`, separated by a `1px solid rgba(23, 22, 15, 0.14)` border above and below.
- Alternating rows do not have shaded zebra stripes. Every entry is separated by a 1px hairline rule spanning the full width.
- Hovering over a row highlights the entire row with a subtle tint (`rgba(23, 22, 15, 0.03)`).

### Metrics & Stat Displays
- Composed of an uppercase `label-mono` descriptor at the top, followed by a massive `metric-hero` or `headline-xl` Newsreader integer.
- Supplemental changes (+12%, -4 commits) sit underneath in `mono-data`, with additions rendered in `#2E7D6B` and deletions in `#D98A94`.
- Enclosed inside grid cells defined by right and bottom hairlines.

### Heatmap Matrix
- 52 columns of 7-day tiles. Each cell is a sharp square (11px × 11px) separated by a 2px paper gap.
- No rounded corners on the individual day tiles.
- The ramp strictly adheres to the calibrated palette (`#E6E1D3` through `#17160F`).
- Tooltip displays appear as unrounded solid `#17160F` rectangular boxes with `#F4F1EA` monospace text, anchored directly to the baseline of the inspected column.

### Inputs & Selectors
- Flat input surfaces with no background contrast against the paper. Defined purely by a bottom 1px rule in `#17160F`.
- Placeholder text rendered in `tertiary_color_hex` (`#6B675C`).
- Focused state: bottom rule darkens and doubles to 2px, or becomes `#E5391A`.

### Badges & Language Chips
- Plain text bracketed by mono glyphs (e.g., `[ TypeScript ]`) or wrapped in a hairline box (`1px solid rgba(23, 22, 15, 0.2)`).
- No filled pill shapes. Language indicators use a 6px × 6px sharp square filled with the corresponding Chart Ink color.