# Typst diagrams

A ` ```typst ` code block draws a diagram with [Typst](https://typst.app) and its [CeTZ](https://cetz-package.github.io/) drawing package. You place every shape yourself, in inches, and get real typography, images from the space, and the same picture on the web and in the PDF. For a quick flowchart or a sequence diagram, ` ```mermaid ` is usually less work; see [[writing#diagrams|Writing & Editing]].

This page is written for whoever authors the diagram, person or agent. Each full example below is shown twice: as source, then drawn.

## A first diagram

```typ
#canvas(length: 1in, {
  import draw: *
  rect((0, 0), (1.6, -0.6), name: "web", radius: 0.05, fill: rgb("#e3eef6"), stroke: 1pt + rgb("#147eba"))
  content("web", [*Web* \ Astro])
  rect((2.6, 0), (4.2, -0.6), name: "api", radius: 0.05, fill: rgb("#fdf0e4"), stroke: 1pt + rgb("#d86613"))
  content("api", [*API* \ Hono])
  line("web.east", "api.west", stroke: 1pt, mark: (end: "stealth", fill: black))
})
```

```typst
#canvas(length: 1in, {
  import draw: *
  rect((0, 0), (1.6, -0.6), name: "web", radius: 0.05, fill: rgb("#e3eef6"), stroke: 1pt + rgb("#147eba"))
  content("web", [*Web* \ Astro])
  rect((2.6, 0), (4.2, -0.6), name: "api", radius: 0.05, fill: rgb("#fdf0e4"), stroke: 1pt + rgb("#d86613"))
  content("api", [*API* \ Hono])
  line("web.east", "api.west", stroke: 1pt, mark: (end: "stealth", fill: black))
})
```

Every diagram is a `#canvas`. `length: 1in` makes one unit an inch, which keeps sizes easy to reason about. `import draw: *` brings `rect`, `line`, `content` and the rest into scope inside the canvas.

## What every diagram starts with

Sideways puts these in place before your source, so you don't write them:

- **CeTZ**, as `cetz`, `canvas` and `draw`. Don't import another version.
- **A page that fits the drawing.** No margins, a transparent background, and nothing to set up.
- **Text in the space's fonts.** 8pt, in the theme's body font (Inter without a theme). `sideways-fonts.body`, `.display` and `.mono` hold the theme's families for your own set rules: `#set text(font: sideways-fonts.display)`. Code (`raw`) uses the mono font.

Any of it can be overridden with set rules of your own at the top of the block.

## Coordinates

- **Units and direction.** With `canvas(length: 1in)`, `(1.5, -0.6)` is 1.5in right and 0.6in *up*: y grows upward, so a diagram drawn from the top of the page runs into negative y. Start at `(0, 0)` and work down.
- **Named shapes and anchors.** Give a shape `name: "api"` and refer to it later: `"api"` is its centre; `"api.north"`, `"api.south-east"` and so on are its edges and corners.
- **Relative points.** `(rel: (0.2, -0.1), to: "api.north-west")` is offset from another point. A rectangle's second corner can be relative to its first: `rect((0, 0), (rel: (1.6, -0.6)))`.
- **Right angles.** `("a.east", "-|", "b.north")` is the point level with `a.east` and below or above `b.north`: the corner of an orthogonal route. `"|-"` is the other way round. Both arguments must be points, not numbers. Each is two characters, a hyphen and a vertical bar; some code fonts draw the pair as a single symbol.

```typ
// fragment
line("a.east", ("a.east", "-|", "b.north"), "b.north", mark: (end: "stealth"))
```

## Shapes and text

- `rect(corner, corner, radius:, fill:, stroke:, name:)`, `circle(centre, radius:)`, and `line(p1, p2, …, close: true, fill:)` for any polygon.
- `stroke: 1pt + rgb("#147eba")`, or `(paint: …, thickness: 1pt, dash: "dashed")` for dashed and dotted outlines. `stroke: none` for none.
- `content(point, body, anchor: "west")` places any content: text, a table, an image. Without `anchor` it is centred on the point.
- Text is ordinary Typst markup: `[*bold* and _italic_]`, `\` for a line break, `text(size: 14pt, weight: "bold", fill: white)[…]` for anything else.
- **Text doesn't wrap by itself.** A label wider than its box spills over the edges. Give it a width to wrap within: `box(width: 1.5in)[…]`.
- `std.rotate(-90deg, reflow: true)[…]` turns text on its side. Plain `rotate` inside the canvas is CeTZ's, which rotates the drawing instead (see [Gotchas](#gotchas)).

## Lines and arrows

`line` takes any number of points and draws through them, so an orthogonal route is just its corners. `mark: (end: "stealth", fill: black)` puts an arrowhead on the end; `start:` on the beginning; `scale: 0.5` makes it smaller.

```typ
// Phase columns with wrapped descriptions over a node graph with
// right-angle arrows. "-|" and "|-" make the corner of an orthogonal route.
#let steel = rgb("#7b9cc4")
#let arrow = (stroke: 1pt + rgb("#5b7bb3"), mark: (end: "stealth", fill: rgb("#5b7bb3"), scale: 0.5))

#let node(name, c, w, label, tool: false, h: 0.32) = {
  draw.rect((rel: (-w / 2, h / 2), to: c), (rel: (w, -h)), name: name, radius: 0.03,
    fill: if tool { steel } else { white },
    stroke: if tool { none } else { 0.6pt + rgb("#555") })
  draw.content(name, align(center, text(size: 6pt, weight: "bold", fill: if tool { white } else { black }, label)))
}
#let phase(x, title, body) = {
  draw.content((x, 0), anchor: "north-west", text(size: 12pt, weight: "bold", title))
  draw.content((x, -0.28), anchor: "north-west", box(width: 1.5in, text(size: 7pt, fill: rgb("#444"), body)))
}

#canvas(length: 1in, {
  import draw: *

  phase(0, [Plan], [Requirements are gathered and written up as specs.])
  phase(1.65, [Generate], [A generator turns the specs into schemas and skeletons.])
  phase(3.3, [Build], [Developers fill in the skeletons with real logic.])
  phase(4.95, [Ship], [The pipeline packages the result and deploys it.])

  rect((0, -1.05), (6.5, -2.55), radius: 0.15, fill: rgb("#f1e9e8"), stroke: none)
  node("req", (0.5, -1.8), 0.8, [REQUIREMENTS], tool: true)
  node("spec", (1.55, -1.4), 0.8, [SPECS])
  node("schema", (1.55, -1.8), 0.8, [SCHEMAS])
  node("model", (1.55, -2.2), 0.8, [MODELS])
  node("gen", (2.65, -1.8), 0.7, [GENERATOR], tool: true)
  node("api", (3.7, -1.4), 0.8, [API SKELETON])
  node("app", (3.7, -1.8), 0.8, [APP SKELETON])
  node("impl", (4.75, -1.8), 0.8, [IMPLEMENTATION])
  node("pkg", (5.85, -1.8), 0.8, [PACKAGE], tool: true, h: 1.0)

  line("req.east", "schema.west", ..arrow)
  line((0.98, -1.8), (0.98, -1.4), "spec.west", ..arrow)
  line((0.98, -1.8), (0.98, -2.2), "model.west", ..arrow)
  line("schema.east", "gen.west", ..arrow)
  line("model.east", ("model.east", "-|", "gen.south"), "gen.south", ..arrow)
  line("gen.east", "app.west", ..arrow)
  line((3.15, -1.8), (3.15, -1.4), "api.west", ..arrow)
  line("app.east", "impl.west", ..arrow)
  line("impl.east", "pkg.west", ..arrow)
  // Over the top rather than through the skeletons, and into the package from above.
  line("spec.east", (2.1, -1.4), (2.1, -1.15), (5.85, -1.15), "pkg.north", ..arrow)
  line("api.east", ("api.east", "-|", "pkg.west"), ..arrow)
})
```

```typst
// Phase columns with wrapped descriptions over a node graph with
// right-angle arrows. "-|" and "|-" make the corner of an orthogonal route.
#let steel = rgb("#7b9cc4")
#let arrow = (stroke: 1pt + rgb("#5b7bb3"), mark: (end: "stealth", fill: rgb("#5b7bb3"), scale: 0.5))

#let node(name, c, w, label, tool: false, h: 0.32) = {
  draw.rect((rel: (-w / 2, h / 2), to: c), (rel: (w, -h)), name: name, radius: 0.03,
    fill: if tool { steel } else { white },
    stroke: if tool { none } else { 0.6pt + rgb("#555") })
  draw.content(name, align(center, text(size: 6pt, weight: "bold", fill: if tool { white } else { black }, label)))
}
#let phase(x, title, body) = {
  draw.content((x, 0), anchor: "north-west", text(size: 12pt, weight: "bold", title))
  draw.content((x, -0.28), anchor: "north-west", box(width: 1.5in, text(size: 7pt, fill: rgb("#444"), body)))
}

#canvas(length: 1in, {
  import draw: *

  phase(0, [Plan], [Requirements are gathered and written up as specs.])
  phase(1.65, [Generate], [A generator turns the specs into schemas and skeletons.])
  phase(3.3, [Build], [Developers fill in the skeletons with real logic.])
  phase(4.95, [Ship], [The pipeline packages the result and deploys it.])

  rect((0, -1.05), (6.5, -2.55), radius: 0.15, fill: rgb("#f1e9e8"), stroke: none)
  node("req", (0.5, -1.8), 0.8, [REQUIREMENTS], tool: true)
  node("spec", (1.55, -1.4), 0.8, [SPECS])
  node("schema", (1.55, -1.8), 0.8, [SCHEMAS])
  node("model", (1.55, -2.2), 0.8, [MODELS])
  node("gen", (2.65, -1.8), 0.7, [GENERATOR], tool: true)
  node("api", (3.7, -1.4), 0.8, [API SKELETON])
  node("app", (3.7, -1.8), 0.8, [APP SKELETON])
  node("impl", (4.75, -1.8), 0.8, [IMPLEMENTATION])
  node("pkg", (5.85, -1.8), 0.8, [PACKAGE], tool: true, h: 1.0)

  line("req.east", "schema.west", ..arrow)
  line((0.98, -1.8), (0.98, -1.4), "spec.west", ..arrow)
  line((0.98, -1.8), (0.98, -2.2), "model.west", ..arrow)
  line("schema.east", "gen.west", ..arrow)
  line("model.east", ("model.east", "-|", "gen.south"), "gen.south", ..arrow)
  line("gen.east", "app.west", ..arrow)
  line((3.15, -1.8), (3.15, -1.4), "api.west", ..arrow)
  line("app.east", "impl.west", ..arrow)
  line("impl.east", "pkg.west", ..arrow)
  // Over the top rather than through the skeletons, and into the package from above.
  line("spec.east", (2.1, -1.4), (2.1, -1.15), (5.85, -1.15), "pkg.north", ..arrow)
  line("api.east", ("api.east", "-|", "pkg.west"), ..arrow)
})
```

Keep routes clear of the boxes they pass: an arrow through a box reads as a connection to it. The `SPECS` arrow above goes over the top and into the package from above rather than straight across.

## Reuse: functions and loops

A shape you draw more than once is a function. Outside the canvas, call the drawing functions as `draw.rect`, `draw.content` and so on, rather than importing them (see [Gotchas](#gotchas)). Loops repeat anything.

```typ
// Two panels with header bars, numbered badges, a dashed boundary, thick
// connector bars and a rotated label. Helpers call draw.* explicitly.
#let slate = rgb("#cfd5de")
#let deploy = rgb("#6c63ff")
#let traffic = rgb("#f7a23b")

#let panel(nw, w, h, title, color) = {
  draw.rect(nw, (rel: (w, -h)), fill: slate, stroke: none)
  draw.rect(nw, (rel: (w, -0.35)), fill: color, stroke: none)
  draw.content((rel: (w / 2, -0.175), to: nw), text(fill: white, weight: "bold", size: 10pt, title))
}
#let item(name, nw, w, h, label) = {
  draw.rect(nw, (rel: (w, -h)), name: name, radius: 0.03, fill: white, stroke: none)
  draw.content(name, align(center, text(weight: "bold", label)))
}
#let badge(at, n) = {
  draw.circle(at, radius: 0.1, fill: rgb("#e01b24"), stroke: 1pt + white)
  draw.content(at, text(fill: white, weight: "bold", size: 7pt, n))
}

#canvas(length: 1in, {
  import draw: *

  panel((0, 0), 2.6, 2.6, [Build], rgb("#00897b"))
  item("src", (0.15, -0.55), 0.85, 0.55, [Source])
  item("models", (0.15, -1.2), 0.85, 0.55, [Models])
  item("specs", (0.15, -1.85), 0.85, 0.55, [Specs])
  item("ci", (1.1, -0.55), 0.6, 1.85, [CI/CD])
  item("ship", (1.8, -0.55), 0.65, 0.55, [Deploy])

  panel((2.8, 0), 3.7, 2.6, [Run], rgb("#e31b1b"))
  rect((2.96, -0.46), (4.99, -1.84), stroke: (paint: rgb("#222"), thickness: 1pt, dash: "dotted"))
  item("dev", (3.05, -0.55), 0.55, 0.55, [Dev])
  item("test", (3.7, -0.55), 0.55, 0.55, [Test])
  item("prod", (4.35, -0.55), 0.55, 0.55, [Prod])
  item("db", (3.05, -1.2), 1.85, 0.55, [Databases])
  item("gw", (5.1, -0.55), 0.35, 1.2, std.rotate(-90deg, reflow: true)[API Gateway])
  item("users", (5.6, -0.55), 0.8, 0.55, [Users])
  item("int", (5.6, -1.2), 0.8, 0.55, [Integrations])
  item("shared", (3.05, -1.95), 1.2, 0.5, [Shared services])
  item("mon", (4.35, -1.95), 0.9, 0.5, [Monitoring])

  line("ship.east", "dev.west", stroke: 5pt + deploy)
  // gw.west is the middle of the tall gateway; "-|" keeps the bar level with prod.
  line("prod.east", ("prod.east", "-|", "gw.west"), stroke: 5pt + traffic)
  line(("gw.east", "|-", "users.west"), "users.west", stroke: 2pt + traffic)
  line(("gw.east", "|-", "int.west"), "int.west", stroke: 2pt + traffic)

  for (n, at) in (("1", "src"), ("2", "ci"), ("3", "ship"), ("4", "dev"), ("5", "db"), ("6", "gw"), ("7", "users"), ("8", "int"), ("9", "shared"), ("10", "mon")) {
    badge(at + ".north-west", n)
  }
})
```

```typst
// Two panels with header bars, numbered badges, a dashed boundary, thick
// connector bars and a rotated label. Helpers call draw.* explicitly.
#let slate = rgb("#cfd5de")
#let deploy = rgb("#6c63ff")
#let traffic = rgb("#f7a23b")

#let panel(nw, w, h, title, color) = {
  draw.rect(nw, (rel: (w, -h)), fill: slate, stroke: none)
  draw.rect(nw, (rel: (w, -0.35)), fill: color, stroke: none)
  draw.content((rel: (w / 2, -0.175), to: nw), text(fill: white, weight: "bold", size: 10pt, title))
}
#let item(name, nw, w, h, label) = {
  draw.rect(nw, (rel: (w, -h)), name: name, radius: 0.03, fill: white, stroke: none)
  draw.content(name, align(center, text(weight: "bold", label)))
}
#let badge(at, n) = {
  draw.circle(at, radius: 0.1, fill: rgb("#e01b24"), stroke: 1pt + white)
  draw.content(at, text(fill: white, weight: "bold", size: 7pt, n))
}

#canvas(length: 1in, {
  import draw: *

  panel((0, 0), 2.6, 2.6, [Build], rgb("#00897b"))
  item("src", (0.15, -0.55), 0.85, 0.55, [Source])
  item("models", (0.15, -1.2), 0.85, 0.55, [Models])
  item("specs", (0.15, -1.85), 0.85, 0.55, [Specs])
  item("ci", (1.1, -0.55), 0.6, 1.85, [CI/CD])
  item("ship", (1.8, -0.55), 0.65, 0.55, [Deploy])

  panel((2.8, 0), 3.7, 2.6, [Run], rgb("#e31b1b"))
  rect((2.96, -0.46), (4.99, -1.84), stroke: (paint: rgb("#222"), thickness: 1pt, dash: "dotted"))
  item("dev", (3.05, -0.55), 0.55, 0.55, [Dev])
  item("test", (3.7, -0.55), 0.55, 0.55, [Test])
  item("prod", (4.35, -0.55), 0.55, 0.55, [Prod])
  item("db", (3.05, -1.2), 1.85, 0.55, [Databases])
  item("gw", (5.1, -0.55), 0.35, 1.2, std.rotate(-90deg, reflow: true)[API Gateway])
  item("users", (5.6, -0.55), 0.8, 0.55, [Users])
  item("int", (5.6, -1.2), 0.8, 0.55, [Integrations])
  item("shared", (3.05, -1.95), 1.2, 0.5, [Shared services])
  item("mon", (4.35, -1.95), 0.9, 0.5, [Monitoring])

  line("ship.east", "dev.west", stroke: 5pt + deploy)
  // gw.west is the middle of the tall gateway; "-|" keeps the bar level with prod.
  line("prod.east", ("prod.east", "-|", "gw.west"), stroke: 5pt + traffic)
  line(("gw.east", "|-", "users.west"), "users.west", stroke: 2pt + traffic)
  line(("gw.east", "|-", "int.west"), "int.west", stroke: 2pt + traffic)

  for (n, at) in (("1", "src"), ("2", "ci"), ("3", "ship"), ("4", "dev"), ("5", "db"), ("6", "gw"), ("7", "users"), ("8", "int"), ("9", "shared"), ("10", "mon")) {
    badge(at + ".north-west", n)
  }
})
```

A closed `line` draws any polygon, and a loop lays out rows:

```typ
// A layered stack: chevrons are closed polylines, rows are rectangles laid
// out by a loop.
#let ink = rgb("#1a587a")
#let sun = rgb("#f7941d")
#let label(body) = text(fill: white, weight: "bold", size: 7pt, upper(body))

#canvas(length: 1in, {
  import draw: *

  let chevron(top, bottom, color, title, note) = {
    line((0, top), (1.3, top), (1.5, (top + bottom) / 2), (1.3, bottom), (0, bottom), close: true, fill: color, stroke: none)
    content((0.7, (top + bottom) / 2), box(width: 1.2in, align(center)[#text(fill: white, weight: "bold", size: 11pt, title) \ #label(note)]))
  }
  chevron(0, -1.47, ink, [Your team], [Responsible for what runs])
  chevron(-1.52, -2.6, sun, [Platform], [Responsible for where it runs])

  // Rows: (height, colour, cells). Widths share the 4.8in column equally.
  let rows = (
    (0.45, ink, ([Data],)),
    (0.45, ink, ([Applications and access],)),
    (0.45, ink, ([Encryption at rest], [In transit], [Identity])),
    (0.3, sun, ([Software],)),
    (0.45, sun, ([Compute], [Storage], [Database], [Network])),
    (0.3, sun, ([Hardware and regions],)),
  )
  let y = 0
  for (h, color, cells) in rows {
    let w = (4.8 - 0.04 * (cells.len() - 1)) / cells.len()
    for (i, cell) in cells.enumerate() {
      let x = 1.65 + i * (w + 0.04)
      rect((x, y), (x + w, y - h), fill: color, stroke: none)
      content((x + w / 2, y - h / 2), label(cell))
    }
    y -= h + 0.04
  }
})
```

```typst
// A layered stack: chevrons are closed polylines, rows are rectangles laid
// out by a loop.
#let ink = rgb("#1a587a")
#let sun = rgb("#f7941d")
#let label(body) = text(fill: white, weight: "bold", size: 7pt, upper(body))

#canvas(length: 1in, {
  import draw: *

  let chevron(top, bottom, color, title, note) = {
    line((0, top), (1.3, top), (1.5, (top + bottom) / 2), (1.3, bottom), (0, bottom), close: true, fill: color, stroke: none)
    content((0.7, (top + bottom) / 2), box(width: 1.2in, align(center)[#text(fill: white, weight: "bold", size: 11pt, title) \ #label(note)]))
  }
  chevron(0, -1.47, ink, [Your team], [Responsible for what runs])
  chevron(-1.52, -2.6, sun, [Platform], [Responsible for where it runs])

  // Rows: (height, colour, cells). Widths share the 4.8in column equally.
  let rows = (
    (0.45, ink, ([Data],)),
    (0.45, ink, ([Applications and access],)),
    (0.45, ink, ([Encryption at rest], [In transit], [Identity])),
    (0.3, sun, ([Software],)),
    (0.45, sun, ([Compute], [Storage], [Database], [Network])),
    (0.3, sun, ([Hardware and regions],)),
  )
  let y = 0
  for (h, color, cells) in rows {
    let w = (4.8 - 0.04 * (cells.len() - 1)) / cells.len()
    for (i, cell) in cells.enumerate() {
      let x = 1.65 + i * (w + 0.04)
      rect((x, y), (x + w, y - h), fill: color, stroke: none)
      content((x + w / 2, y - h / 2), label(cell))
    }
    y -= h + 0.04
  }
})
```

## Images and icons

A diagram reads images from the space the way the markdown around it does: relative to the document, and nothing outside its section. From `guides/arch.md`, `image("img/logo.png")` is `guides/img/logo.png`. `sideways push` uploads the images a diagram uses along with the document.

- **Write the path out in full**, as one string: `image("img/logo.png")`. A path built up in code (`image(dir + "logo.png")`) isn't found.
- PNG, JPEG, GIF, WebP and SVG, as for markdown images. At most 5MB of images in one diagram.
- **Avoid SVG icons with gradients** for anything that will be printed: some print blank in a PDF. Flat colours are safe.
- A missing image is an error naming the path it looked for, e.g. `searched at /img/logo.png`.

```typ
// Images read from the space (relative to the document, written literally)
// with captions, a connector, and a table placed like any other content.
#let caption-under(at, file, caption, w: 0.4in) = {
  draw.content(at, image(file, width: w))
  draw.content((rel: (0, -(w / 1in) / 2 - 0.03), to: at), anchor: "north", text(size: 7pt, caption))
}

#canvas(length: 1in, {
  import draw: *

  rect((0, 0), (3.2, -1.3), radius: 0.06, fill: rgb("#e3eef6"), stroke: 1pt + rgb("#147eba"))
  content((0.1, -0.12), anchor: "west", text(size: 7pt, weight: "bold")[Private network])
  caption-under((0.8, -0.6), "img/typst-server.svg", [App server])
  caption-under((2.4, -0.6), "img/typst-database.svg", [Database])
  line((1.05, -0.6), (2.15, -0.6), stroke: 1pt, mark: (end: "stealth", fill: black))

  content((3.45, 0), anchor: "north-west", table(
    columns: 3, stroke: none, inset: (x: 4pt, y: 2pt), align: left,
    table.header[*Port*][*Proto*][*Purpose*],
    [443], [TCP], [HTTPS],
    [5432], [TCP], [Postgres],
    [9100], [TCP], [Metrics],
  ))
})
```

```typst
// Images read from the space (relative to the document, written literally)
// with captions, a connector, and a table placed like any other content.
#let caption-under(at, file, caption, w: 0.4in) = {
  draw.content(at, image(file, width: w))
  draw.content((rel: (0, -(w / 1in) / 2 - 0.03), to: at), anchor: "north", text(size: 7pt, caption))
}

#canvas(length: 1in, {
  import draw: *

  rect((0, 0), (3.2, -1.3), radius: 0.06, fill: rgb("#e3eef6"), stroke: 1pt + rgb("#147eba"))
  content((0.1, -0.12), anchor: "west", text(size: 7pt, weight: "bold")[Private network])
  caption-under((0.8, -0.6), "img/typst-server.svg", [App server])
  caption-under((2.4, -0.6), "img/typst-database.svg", [Database])
  line((1.05, -0.6), (2.15, -0.6), stroke: 1pt, mark: (end: "stealth", fill: black))

  content((3.45, 0), anchor: "north-west", table(
    columns: 3, stroke: none, inset: (x: 4pt, y: 2pt), align: left,
    table.header[*Port*][*Proto*][*Purpose*],
    [443], [TCP], [HTTPS],
    [5432], [TCP], [Postgres],
    [9100], [TCP], [Metrics],
  ))
})
```

## Sizing for the page

- **At most about 6.5in wide.** That is the PDF's text width (A4 with Sideways' margins). A wider diagram is scaled down to fit, text and all, on the page and on screen alike. A diagram is never scaled up.
- **Draw for white paper.** In the dark web theme a diagram is shown on a light panel, so dark strokes and text stay readable.
- **Keep text 6pt or larger.** Smaller is hard to read once a wide diagram is scaled down.

## Errors and warnings

A diagram that doesn't compile is shown as its source, with the compiler's message under it:

```text
Diagram failed to render: line 3, column 8: module `draw` does not contain `nonsense`
```

The line and column count from the first line of your block. Up to three problems are listed, each with any hint the compiler gave (`(hint: …)`). An error inside CeTZ names the package instead (`in @preview/cetz:0.4.2: …`); look at the call on the line reported after it.

Warnings don't stop a diagram, but they usually mean it doesn't look as intended. The commonest is `unknown font family: …` for a font that isn't installed (the text falls back to a built-in serif).

## Gotchas

Each of these cost a real round trip while the examples on this page were written.

- **`import draw: *` shadows names.** It brings in CeTZ's `group`, `fill`, `stroke`, `rotate`, `scale` and `translate`. A helper with a parameter called `fill` then receives a CeTZ function. Inside helpers, call `draw.rect(…)` and leave the import out. For Typst's own text rotation, write `std.rotate`.

```typ
// broken: `fill` below is CeTZ's fill(), not the parameter
#let tile(at, fill) = {
  import draw: *
  rect(at, (rel: (1, -1)), fill: fill)
}
```

- **A code block joins everything it produces.** A block that draws a shape *and* evaluates to a number joins the two and fails (`cannot join array with float`). Compute values in one place and draw in another.
- **Right-angle points take two points.** `("a", "-|", 4.3)` fails; write `("a", "-|", (4.3, 0))`.
- **A font that isn't installed falls back to a serif**, with a warning. Use `sideways-fonts.*`, or one of Inter, Fira Code, Newsreader 16pt, EB Garamond or Oswald, or the space theme's own fonts.
- **Text wider than its box overflows.** Size the box for the text, or wrap the text with `box(width: …)`.
- **Long loops are killed.** Typst stops a `while` loop that seems infinite, but not a `for` over a huge range. A diagram gets 8 seconds and 512MB.

## Limits

| | |
|---|---|
| Time per diagram | 8 seconds |
| Memory per diagram | 512 MB |
| Images per diagram | 50 files, 5 MB in all |
| Diagrams per document | 50 |
| Source per diagram | 100,000 characters |
| Packages | CeTZ only; anything else fails to import |
| Fonts | Inter, Fira Code, Newsreader 16pt, EB Garamond, Oswald, and the space theme's fonts |

<!-- Maintainers: every ```typst block on this page, and every ```typ block
     that isn't marked `// fragment` or `// broken`, is compiled by
     infra/typst/test/docs.test.mjs, which also checks that each example's
     ```typ listing matches the ```typst block drawn after it. -->
