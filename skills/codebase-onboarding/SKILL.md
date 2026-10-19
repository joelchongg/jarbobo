---
name: codebase-onboarding
description: Guide someone through learning a large, unfamiliar codebase — domain first, then the structural map, the repeated pattern, and hot paths before depth — using jarbobo diagrams as the persistent map. Use when the user asks how a codebase works, where to start reading, how to get up to speed, what a component does, or asks for a reading guide or hot path; also when they say they are new to a codebase.
---

# Codebase onboarding

The learner wants to understand a codebase too large to read front to back.
Your job is to choose what they read, in what order, and why — and to leave
that guidance on a jarbobo diagram so it survives the chat scrolling away.

Two rules override everything below:

- **Purpose before mechanism.** Say what a thing is *for* in plain words
  before naming functions, files or jargon. A label like `pack` means nothing
  to a newcomer; `pack · chooses block transactions` does.
- **Only point at code you have opened.** Every `file`+`line` you attach must
  come from a file you read this session. If something is inferred from names
  or wiring, say "inferred" in the tooltip or detail. A confident diagram that
  is wrong is worse than no diagram.

## The method

Move one level at a time. Finish a level, check understanding, then offer the
next. Never dump all levels at once.

### 1. Domain first (no code yet)

Explain what the system exists to do, as if to a smart person outside the
field:

1. One analogy to something they know.
2. The system's job as 4–6 numbered steps of what it is *trying to do*.
3. A table mapping each step to the components that do it.

Correct misconceptions directly and specifically ("one node down doesn't halt
the network; more than a third of stake does"). Define each domain term the
first time it appears.

### 2. Find the map

Every large system has one place that declares its structure: a topology or
wiring file, a router, a DI container, a service registry, `main` and its
startup sequence. Find it before reading any component.

Draw a **phase overview** with `draw_graph` (see "Diagram conventions"):
components grouped by *when they run and what they do*, the study path
highlighted, at most ~30 edges. Tell the learner which phase to ignore for now.

### 3. Teach the repeated pattern

Find the contract every component follows: a base class, an event loop and
its callbacks, a request handler interface, a plugin API. Point at the 50–150
lines that define it and the order things are called in. Once the learner
knows this, every component reads the same way. Skip the machinery under it
(scheduling, memory ordering, flow control) unless asked.

Give 2–3 check questions ("if no message arrived and downstream has room,
which callback runs?").

### 4. Hot path before depth

For a component the learner is about to read, give its **hot path**: the
route one typical message or request takes through the file, in execution
order, showing only the lines that make decisions.

- 4–8 steps. Each step: what arrives, what is decided, where it goes next.
- Each step is a ref with a **tight** line range and a one-sentence `note`.
- Leave out init, config parsing, metrics, sandboxing, logging and error
  handling unless the error path *is* the question.
- Open the functions before writing the steps. Function names are not enough.

Go deep only along the hot path. Depth on cold code is wasted early effort.

### 5. Reading guide per file

When the learner opens a file, give a section table:

```
# | Section | Lines | What's there | Read?
1 | Callback list | 263–287 | which hooks this component uses | READ FIRST
2 | Frag callbacks | 37–163 | filter, verify, publish | READ
3 | Init + sandbox | 164–262 | | SKIP
```

Use READ FIRST / READ / SKIM / SKIP. Point out the file's table of contents
when there is one (a registration struct, a callback list at the bottom, a
header comment) and mark it READ FIRST. Mark the long header comment READ when
it explains the component; many do.

### 6. Code-reading companion (when they open a component)

Only after steps 2–4: the learner needs the map and the hot path first, or
this is a detailed picture of an unknown part. When they start reading a
component's code, read the whole file yourself, then produce both of these
together:

- **A sequence diagram of one message's trip through the component**
  (`draw_sequence_diagram`):
  - Participants: the upstream producer, the framework loop, each hook or
    function on the path, the key helper, the downstream consumer.
  - Each call carries two refs: the call site in the framework and the
    definition in the component.
  - Frames for conditions: `loop` for the run loop, `opt` for "only if mine"
    and "only if valid". A drop is where a frame ends.
  - A `note` on any non-obvious design choice (a copy avoided, a cheap check
    placed before an expensive one).
  - **Keep it traceable.** One path per diagram: if the component handles
    several kinds of input (data messages, control messages, idle-time
    work), draw one small diagram per path rather than one big one. At most
    ~7 participants and ~12 messages; labels under ~40 characters; at most
    two levels of frame nesting; end each call with a `reply` so activation
    bars close; put long explanations in `detail`, keep `note`s to a few
    words and use them sparingly.
- **A component card, before any line-level detail.** This is what lets the
  learner skip most of the file safely, so lead with it. Put it in the path
  diagram's `card` field, where it stays open beside the diagram instead of
  scrolling away in chat: give pseudocode lines a `step` (the 1-based message
  number they correspond to) and give I/O rows, reading-order items and
  questions `refs`. In chat, give only the purpose sentence and point to the
  card. Its parts, in this order:
  1. **One sentence** of what the component is for, plus a one-line analogy
     (reuse the system's running analogy if there is one).
  2. **Key terms** (only if the component has its own vocabulary): a
     `Term | Meaning` table of 2–4 words the code uses everywhere, each
     defined by what it is *for* ("parity shreds let the receiver rebuild
     the set from any 32 of 64"), not by its type.
  3. **The whole component in ~10–20 lines of pseudocode**, one block per
     path or entry point, each line saying what is *decided*. Mark each
     block with its diagram status (`← diagram drawn`, `← next`) so the
     learner sees which path they are on and what comes after.
  4. **An I/O table:** `Direction | Link | What | Line`, important inputs
     and outputs only; group setup inputs (config, peers, epochs) into one
     "skip for now" row. Call out signals that are not messages, such as
     shared memory or flags.
  5. **Treat as a black box:** the libraries, alternate paths (bundles,
     legacy variants), metrics/timing and init the learner should not open
     yet, each with a few words on what it does ("batch in, FEC sets
     out"). End with a **"good enough" bar**: one line of the 2–3 things
     they should be able to explain.
- **Then the path diagram** (above), with a short note on its frames —
  what each frame means and which steps happen *later* or rarely — plus,
  also in the card (`readingOrder`, `questions`):
  1. **Reading order covering only the lines that matter** (often ~150 of
     ~1,000), as line links, with skipped code named explicitly. Point out
     compiled-out code (`#if` on a macro that is never defined).
  2. **2–3 check questions**, each with its answer (hidden until the
     learner asks) and a ref to the code that proves it. If they can answer
     them, they are done with this path; one question leads into the next
     path or component.
- **For long functions, chunk the reading.** Split a big function into 2–3
  chunks of ~20–60 lines, each with READ / SKIM / SKIP ranges and *one*
  question to answer before moving on. Ask the learner to read a chunk and
  explain it back. Proofs, long math comments and asserts are SKIP.
- **Bridge paths.** When moving to a component's second path, open with a
  short table `Path 1 assumed… | Path 2 makes it true` so the new path
  connects to what they just learned instead of starting cold.
- **Chat walkthrough with the diagram's numbering**, only if the learner
  asks or opens the code: the steps in diagram order with what each one
  decides.
- **Close the component with a summary card** when the learner says they
  get it (edit the last path diagram by its `id` so its `card` becomes the
  summary): one sentence + analogy, the whole-component pseudocode (all
  paths, now complete), the I/O table, **5–6 key ideas to keep** (the
  insights from the questions they asked along the way, not a list of
  functions), what is still unread and whether it matters, and the file
  names of every diagram made for it. Then name the next component and why.

Size the depth to the component. For a large, stateful one (a scheduler,
a cache, anything split into a framework layer and an algorithm library),
the card is the default deliverable: say which layer to treat as a black
box and that knowing the skeleton is enough. Go line-by-line (bit tricks,
data-structure internals) only when the learner asks about a specific
block. Long reading tables and line-level detail before the learner has the
whole picture are what made a scheduler component feel overwhelming in
practice; the card fixed it.

### 7. Check understanding and make it concrete

End each level with 2–3 questions the learner should now be able to answer,
and one small change they could make and run (add a log line, a test case, a
counter) to prove the code does what they think.

### 8. Adapt

If the diagram has notes or pins from the learner, read them (`open_diagram`)
before redrawing; answer their questions and fix what they misread. If the
learner says something is confusing, simplify the diagram rather than adding
to it.

## Diagram conventions (jarbobo)

**Overview diagram** — one per system:

- Group `label` = phase + when it runs, e.g. `PHASE 3 · Only during our
  leader slots`; group `description` = the job, e.g. `Accept user
  transactions, check them, pick the best ones, run them, broadcast our
  block.` Never just a topic word like "Ingress".
- Node `label` = the name; node `purpose` = what it is for, under ~60
  characters (`chooses which transactions go in the block`). The purpose
  shows as a smaller line under the name, so don't repeat it in the label.
- Highlight one or two study paths: give their nodes and edges a strong
  colour and number the edge labels `1 · …`, `2 · …`. Everything else stays
  default or dotted.
- Keep only edges that tell the story. Drop request/reply pairs, status
  broadcasts, signing and acks; say in the reply what you dropped and where the
  full list lives.
- Node ref = the function where the hot path *starts*, not line 1 of the file.
- Edge ref = the line that wires the connection.

**Detailed diagram** — one per area, when the learner starts opening files:

- Node `detail`, in this order: `What it's for:` (2 sentences), `In:` / `Out:`
  (every input and output, including ones the overview dropped), then the
  reading-guide table.
- Node `refs`: one per reading-guide section, in file order, each with the
  section's line range, a `label` like `4 · after_credit` and a `note` starting
  with READ FIRST / READ / SKIM / SKIP. Then a `core:` ref for where the real
  algorithm lives if it is in another file. Then the line that registers or
  creates the component.

**Hot path** — attach to the component's node as ordered refs (or draw a
sequence diagram for one component when the path crosses several files), each
ref labelled `hop N: …` with a one-sentence note.

**Size limits.** Over ~30 nodes or ~40 edges, split by phase or area. A dense
diagram reads as noise to a newcomer.

**Edits.** Pass the diagram's `id` to update it in place and keep node ids
stable, so the learner's hand arrangement and notes survive.

## Explanation style

- Short sentences, plain words, numbered steps for anything sequential.
- Tables for mappings (concept → code, step → component, section → lines).
- Name the level of certainty: read in code / inferred from names / general
  domain knowledge.
- When the learner's summary is mostly right, confirm what is right, then
  correct the specific parts. Don't restate the whole thing.
- When your own earlier simplification misled them (pseudocode that implied
  a branch the code doesn't have), say so plainly and show where the logic
  really lives.
- Answer "why not do X instead?" questions with the concrete reasons the
  design rules X out, ordered strongest first. These answers become the
  "key ideas" in the summary card.
- Give realistic scope: what to treat as a black box (crypto, base libraries,
  protocol stacks) and what is worth deep reading.

## Pitfalls

- Starting from line 1 of the biggest file. Start from the map and the
  smallest component on the study path.
- One diagram with every edge. It looks complete and teaches nothing.
- Describing functions instead of what the code decides. "after_frag: handles
  frags" is useless; "after_frag: drops the transaction if its signature was
  seen in the last N" is the point.
- Section ranges or refs guessed from grep output alone. Open the code.
- Answering "where should I start?" with a list of ten files. Give one, and
  say why.
