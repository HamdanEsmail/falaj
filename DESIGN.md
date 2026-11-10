# Falaj: the look

*How the page at `/` looks and why. I dropped the dark "console" look I first planned for this build: it could have been any developer tool. This one could only be Falaj.*

## The idea

A falaj is dug as a line of wells, and from above it is a row of round mouths running across the land to the gardens. That round mouth is the one shape on the page.

- **Ten green circles** across the top of the first screen are the ten tools. A circle turns the colour of dry sand when the university changes a page and that tool stops.
- **Every photograph sits in the same circle.** They are real pictures of the falaj and gardens of Al Ain Oasis, where the university is, from Wikimedia Commons (CC BY-SA, unchanged, credited in the footer). None of them is presented as this project.
- **Buttons are fully round**, the busy mark on a pressed button is a small circle that swells, and the footer closes with the ten circles at full width.

Everything else is square-cornered and plain, so the circle is the only shape with character.

## Colour

Taken from the oasis, in flat fields. No gradients, no shadows, no thin rules.

| Name | Value | Where |
|---|---|---|
| ground | `#f6f6f3` | the page: lime plaster in shade |
| surface | `#eaeae4` | bars, tiles, fields to type in |
| paper | `#ffffff` | the first screen's card, code blocks |
| ink | `#101210` | all running text |
| muted | `#595f58` | secondary notes only |
| palm green | `#1c5a38` | the wells, the main button, the footer |
| water | `#bfe4d6` | the square an answer lands on |
| dry | `#e4d9c4` | a stopped tool, an error |

## Type

Switzer (400, 500, 600) for everything, set tight in headings (-0.04em, leading 0.95). Noto Kufi Arabic 600 for one word only, the name in its own script: فلج. Monospace only inside real code. Five working sizes: small notes, 16px for dense parts (bars, tiles, the log), body, a second voice for names and clauses, and section headings. Three things are allowed to be huge: the word "tools", the figure for what is left today, and the name in the footer.

## The parts, top to bottom

1. **First screen.** A white card (the ten wells, the name, "UAEU's website, as ten tools.", the address with a Copy button, three links) beside a circle far taller than the screen holding a photograph of a falaj, which turns slowly from day to dusk. On a phone the circle comes first, whole.
2. **Try one here.** A square of water colour where the answer lands, beside a form. It runs a real tool. A pressed button says "Reading uaeu.ac.ae…", a clock counts, and the usual time is stated. The answer carries where it was read, when, how, and how long it took.
3. **tools.** The word at the full width of its column over ten bars that open: each tool's arguments (read from its schema), what it gives back, what it reads, one example call.
4. **How it works.** Four fields side by side with the same request in each, one step further along every time.
5. **Add it in one line.** One command or address per client, each with a Copy button.
6. **Is it running.** A board of tiles: one in palm green with the verdict, one per tool with its last check.
7. **The last calls.** A plain table of the latest calls: tool, what was asked, how long, the result. Never who asked.
8. **How much is left today?** One control, one very large figure, one sentence saying how it is worked out.
9. **The close.** The ten circles at full width on palm green, the name, links, the terms, my name, the picture credits.

## Rules I hold the page to

- Every headline fits in two lines at every width.
- Running text is ink at 16px or more; muted is for notes.
- Anything a visitor waits for shows it is working in the first screen of a phone: a busy button, a clock, the usual time.
- The page reads and works without scripts. Scripts add the copy buttons, the clock, the slow change of the first photograph and the rise of parts as they are reached; all of it stops for a visitor who asks for reduced motion.
- No inline script or style: the page is sent with a content security policy that allows only this site's files and the two font hosts.
