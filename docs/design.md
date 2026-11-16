# The design system

Imp's shell, the app you open, looks like a catalogue: white paper, black ink, one cobalt action, square corners, headlines in Instrument Serif with a Pinyon Script capital, prose in Instrument Sans, and labels and numbers in IBM Plex Mono. The design system writes that look down once, in three files under `client/`. Every screen of the shell builds on those files and never sets a look of its own.

| File | What it holds |
| --- | --- |
| `app.forma` | The tokens: colours, the type scale, spacing, and the widths a column of reading runs to |
| `look.contract` | The text styles, one per role of type, and the shell's motion |
| `controls.contract` | The controls: `Button`, `DialogButton`, `ButtonLink`, `Callout` and `ErrorNote` |

`pnpm check` runs `scripts/design.ts`, which refuses a font, size, line height or weight, a colour of its own, or spacing in pixels in any other contract of the shell. A 1px hairline and a negative margin that lines a control up with the text beside it are allowed. The apps under `client/apps/` keep their own looks and are not checked.

## Tokens

Colours are named by what they do, not by what they look like:

- **Ink:** `ink.strong` for text, `ink.muted` for what is secondary, `ink.faint` for what is unavailable, and `ink.on-fill` for text on a filled surface.
- **Surfaces:** `surface.page` is the paper and `surface.soft` a quiet panel.
- **Lines:** `line.subtle` and `line.strong`.
- **Accent:** `AccentColor` is the one action and the focus ring. `accent.soft` is its tint, for a note that introduces or asks.
- **Meaning:** `ink.danger` with `danger.soft` for what went wrong or can't be undone, and `ink.success` for what works.

The type scale has one token per role, `type.display.xl` through `type.code`. Screens use it through the text styles, not directly.

Spacing sits on a 4px grid: `space.xxs` (2px), `xs` (4), `sm` (8), `ms` (12), `md` (16), `lg` (24), `xl` (32) and `xxl` (48). Use the tokens for `gap`, `padding` and `margin`, such as `padding="space.sm space.md"`.

Widths: `measure.form` for a form, `measure.note` for a note or card, and `measure.page` for a page of reading.

## Text styles

A text takes its role with `class=` and its colour with a colour token: `text "Backup" class=Subheading`, `text detail class=Body color="ink.muted"`.

| Style | For |
| --- | --- |
| `Display`, `Title` | A page's welcome and a screen's title, in the display serif |
| `Heading`, `Subheading` | A section's or row's name |
| `Lead`, `Body`, `Small` | A message, a paragraph, the line under a row |
| `Label` | Small capitals: a section's name, a count, a quiet control |
| `Control`, `ControlLarge` | A boxed control's words, and the onboarding's full-width answers |
| `Mono`, `Code` | What a machine reads (an address, a path), and a code to type elsewhere |
| `Initial`, `Monogram` | The script capital in a word, and a person's initial |

A conditional class picks between two roles, as in `class=(compact ? Body : Lead)`.

## Controls

`Button` takes `press`, `variant`, `disabled` and `testId`. Its children are what it says, such as a text, a symbol or a `KeyBadge`:

```contract
Button(press=save, variant="primary", disabled=(not ready), testId="secret-save")
  text "Save"
```

| Variant | For |
| --- | --- |
| `primary` | The screen's one main action, filled in the accent |
| `secondary` | Any other action, outlined |
| `accent` | The action in an accent `Callout`, outlined in the accent |
| `quiet` | A small capitals label with no box, for what sits beside the content (Sync now, Cancel, Got it) |
| `danger` | A confirmed destructive action, filled in red |
| `quiet-danger` | A quiet action that turns red when pointed at (Uninstall, Disconnect) |

`DialogButton` opens a `Confirm` (`parts.contract`) by its id. `ButtonLink` is a link in a button's look, for what opens elsewhere. A button fills its column's width unless something holds it in, so wrap one that should keep its own width in a `row`.

`Callout` says something beside the content in a tone: `accent`, `danger` or `neutral`. It draws as a tint with a rule down its left edge, never a box across the page. `ErrorNote` is a danger callout with the alert symbol.

Controls with a shape of their own stay their own components but are built from the same tokens: a tab, a row in the sidebar, Settings' sections, a segmented choice, a symbol-only button, and the onboarding's `WizardButton` and `WizardFold`.
