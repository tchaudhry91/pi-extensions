---
description: Deep multi-round web research on a topic. Searches from multiple angles, fetches and analyzes sources, cross-references findings, identifies gaps, and produces a synthesized markdown document with inline citations.
argument-hint: "<topic> [--interactive] [--output <path>]"
---
Load the deep-research skill with `/skill:deep-research` and then conduct deep research on the topic below.

## Arguments

Parse the following from $ARGUMENTS. Everything before the first flag is the topic.

Flags:
- `--interactive`, `-i`: Run in interactive mode. Pause between research phases to discuss findings with the user before proceeding.
- `--output <path>`, `-o <path>`: Write the final document to this path. If not specified, use `research/<topic-slug>.md` (lowercase, hyphenated slug derived from the topic).
- `--depth <n>`, `-d <n>`: Maximum rounds of follow-up research (default: 2). Each round means searching, fetching, and analyzing additional sources targeting identified gaps.

## Default Behavior

If no flags are specified:
- Run in **one-shot mode**: execute all phases without pausing.
- Write output to `research/<topic-slug>.md`.
- Use up to 2 rounds of follow-up research if gaps are found.

## Research Topic

$ARGUMENTS

## Important

Follow the deep-research skill methodology exactly. Produce a synthesized, integrated document — NOT a list of source summaries. Use inline citations. Do not stop until the final document is written to disk.
