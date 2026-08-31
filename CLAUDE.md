# Writing rules

Binding on every agent. Covers comments, doc comments, markdown, error messages
and generated output. Find your section, do the steps, move on.

## Read PHILOSOPHY.md first

`PHILOSOPHY.md` binds with this file, and it comes first. It says what we want
to make, and how we work. These rules tell you how to say a thing. That document
tells you what is worth saying, and what we refuse to claim.

Read it before you change a claim, argue a design, or write a number. Four of
its rules decide your output directly:

- Write the direction, not the measurement. The measurement stays in
  `bench/FINDINGS.md`, beside the program that produced it.
- Put the correction next to the claim it corrects. A result that flatters us
  gets the second look, not the first.
- Say the narrow thing. Keep the bad result in the list.
- Name what you did not test. An untested area is a risk, and a written risk is
  a risk you can control.

It holds no claim, no measurement and no code. Keep it that way.

## Sentences

1. One idea per sentence. Twenty words maximum.
2. Active voice. Name the thing that acts.
3. Simple present tense.
4. Imperative for an instruction.
5. One word for one meaning. Use the glossary.
6. Plain words. Delete `just`, `simply`, `obviously`, `note that`.
7. No capitals for emphasis. Backticks only for names in the code.

## Punctuation

Never use an em dash, an en dash, a semicolon in prose, or a slash between
words. Replace an em dash with a comma, a period, or two sentences.

Use a colon only to introduce a list or a definition.

Use one short aside per parenthesis. Never nest one.

## Numbers

A measurement is a clue, not a constant. It came from one engine, one machine,
one day.

1. Never write a ratio, a percentage, a timing, a sample count or an engine
   version.
2. Write the direction instead: slower, far slower, can hit a slow path, cheap.
3. Name an engine only when the behaviour belongs to that engine.
4. Keep numbers that describe the data: stride, alignment, offset, nesting
   limit, 2^53.
5. Numbers that carry an argument live under `bench/`. Nothing else quotes one.

## References

Never cite `SCOPE.md`, `PHILOSOPHY.md`, a rule number, an experiment number, a
round or a step. Write the rule itself. This file and the README index the
documents. Nothing you write names one.

- Wrong: `Rule 17 forbids this. See SCOPE.md section 10.`
- Right: `Parse time grows with source size, thus ask only for the fields you walk.`

Point at code and at tests. `test/repr.test.ts compares these offsets with what
rustc emits` is useful, because the test is the evidence.

## Comments

Write why. The signature says what. Delete a comment that repeats a name, a type
or an obvious body.

Write one when:

- the design had alternatives and the reason is invisible
- the code looks wrong and is correct
- an invariant holds that the types cannot express
- a caller must plan around a cost

Put it where breaking the rule is easy, not in a document.

Placement:

- **File header.** What the file owns, what it refuses, the constraints. Short
  paragraphs.
- **Doc comment.** Purpose, what the caller guarantees, the cost. Say hot path
  or cold path.
- **Inline.** Above the line that surprised you. Three lines maximum.
- **Banner.** One noun phrase.

## Error messages

1. State the fact. State the remedy. One period between them.
2. Name the value that caused it.
3. Use a colon only before a list of valid choices.
4. Prefix `pridat: ` only when the caller cannot tell who threw.
5. No rule number, no document name, no measurement.
6. Pick the type. `TypeError` for the wrong shape. `RangeError` for outside
   bounds. `EvalError` for an environment that forbids evaluation. `Error` when
   none of those is honest.

Match these:

    array length must be a non-negative integer, got 2.5
    Tag has no field "nope". It has: a, b
    wrong number of indices for verts.x: expected 1, got 0
    ptrAlign must be a positive power of two, got 6
    Particle: `only` selected no sites. Omit it to emit every site.

## Generated output and markdown

Generated text follows every rule above. A generated comment may state layout
facts. It may not state a measurement.

In markdown, put the conclusion before the argument. Write no preamble.

## Glossary

One meaning each. Invent no synonym.

- **schema** the declared type, as a runtime value
- **field** one named member of a struct
- **leaf** one scalar position in a row, and an inline array adds no leaf per element
- **site** one place a generated accessor reads, and a 64-bit leaf has two
- **node** one entry in the field tree
- **hole** bytes that no leaf occupies
- **row** one instance of a layout
- **stride** the distance to the next row, tail padding included
- **column** one site across every row
- **view** the typed array or DataView an accessor reads through
- **plan** what the generator will emit, before it emits it
- **arena** the owner of the memory
- **handle** what a user holds, and where a check belongs

## Before you commit

- No em dash. No prose semicolon.
- No ratio, percentage or timing.
- No rule number. No document reference.
- The narrow claim, and not the short one. Bad results stay in the list.
- Every sentence short, present, active.
- Nothing repeats the signature above it.
- Delete the longest sentence. Check what you lost.
