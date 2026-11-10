Here's the exact font stack for the **product app** (the interface we're cloning):

## Primary: Inter

- **Source:** Google Fonts (free) — `https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap`
- **Weights used in the app:** 400 (body), 500 (medium/labels), 600 (semibold/buttons), 700 (bold/headings)
- **Variable font available** — you can load the variable version for smaller payload.

## The full font stack (what to put in CSS)

Todoist's app uses a system-font fallback chain after Inter, like this:

```css
font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI',
             Roboto, 'Helvetica Neue', Arial, sans-serif;
```

This is what I used in the clone (`font-sans` in the Tailwind config) — I just didn't wire up the actual Inter webfont, so it was falling back to the system font.

## How to add it to the clone

**Option A — Google Fonts `<link>` (simplest):**
Add this in `<head>`:

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
```

Then set it in the Tailwind config:

```js
tailwind.config = {
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI',
               'Roboto', 'Helvetica', 'Arial', 'sans-serif'],
      },
      // ...rest
    }
  }
}
```

**Option B — Tailwind's `@import` (inside a `<style>` block, before Tailwind loads it won't work; use the `<link>` above instead).**

## Notes on the app's typography

- **Base size:** Todoist uses **14px** for task titles and most UI text (not 16px). Small metadata (due date, project) is **12px**.
- **Line height:** ~1.4–1.5 on body.
- **Letter-spacing:** slightly tight on headings (`-0.01em`), normal on body.
- **Numeric/date text:** Inter's tabular figures aren't strictly needed, but the app renders dates in the same Inter.