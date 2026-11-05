// Imported ahead of every diagram (see worker.mjs). It is the floor every
// diagram starts from: CeTZ in scope, and a page that shrinks to the drawing.
//
// Keep it small. Anything here is a name a diagram can collide with, and it
// changes the output of every diagram ever rendered: bump PRELUDE_VERSION in
// packages/server/src/lib/typst.ts whenever this file changes, so cached SVGs
// made with the old prelude are not served.

#import "@preview/cetz:0.4.2"
#import cetz: canvas, draw

// Applied with `#show: diagram-setup` before the diagram's own source, so a
// diagram can still override any of it with set rules of its own.
#let diagram-setup(body) = {
  // Shrink-wrap the drawing, and leave the background transparent so the
  // diagram sits on whatever page or panel it is placed on.
  set page(width: auto, height: auto, margin: 0pt, fill: none)
  // DejaVu Sans is installed in the container. The others are fallbacks for
  // running the sidecar outside it, e.g. on a developer's Mac.
  set text(font: ("DejaVu Sans", "Liberation Sans", "Arial"), size: 8pt)
  body
}
