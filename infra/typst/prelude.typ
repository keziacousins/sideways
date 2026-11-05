// Imported ahead of every diagram (see worker.mjs). It is the floor every
// diagram starts from: CeTZ in scope, the space's fonts, and a page that
// shrinks to the drawing.
//
// Keep it small. Anything here is a name a diagram can collide with, and it
// changes the output of every diagram ever rendered: bump PRELUDE_VERSION in
// packages/server/src/lib/typst.ts whenever this file changes, so cached SVGs
// made with the old prelude are not served.

#import "@preview/cetz:0.4.2"
#import cetz: canvas, draw

// The space's theme fonts arrive as compile inputs (`sys.inputs`), set by the
// API from the theme and never by the diagram, so a themed space's diagrams
// are drawn in its type without the author naming it. Unthemed, they are the
// Sideways defaults: the same families as the web view and the PDF.
//
// Typst sees a few families under other names than CSS does — the static
// Newsreader it is given is "Newsreader 16pt" — so theme names are mapped.
#let _aliases = ("Newsreader": "Newsreader 16pt")
#let _family(name) = _aliases.at(name, default: name)
#let _fonts(input, defaults) = {
  let chosen = sys.inputs.at(input, default: none)
  if chosen == none { defaults } else { (_family(chosen),) + defaults }
}

/// The families a diagram is drawn in, for use in its own set rules:
/// `#set text(font: sideways-fonts.display)`.
///
/// No further fallbacks: these three are installed wherever the sidecar runs
/// (the image, or vendor/fonts outside it), and Typst warns about every
/// family in a list that it can't find, even ones it never needed.
#let sideways-fonts = (
  body: _fonts("font-body", ("Inter",)),
  display: _fonts("font-display", ("Newsreader 16pt",)),
  mono: _fonts("font-mono", ("Fira Code",)),
)

// Applied with `#show: diagram-setup` before the diagram's own source, so a
// diagram can still override any of it with set rules of its own.
#let diagram-setup(body) = {
  // Shrink-wrap the drawing, and leave the background transparent so the
  // diagram sits on whatever page or panel it is placed on.
  set page(width: auto, height: auto, margin: 0pt, fill: none)
  set text(font: sideways-fonts.body, size: 8pt)
  show raw: set text(font: sideways-fonts.mono)
  body
}
