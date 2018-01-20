# README

## Language extension for awk

Implements a number of VSCode's language server functions for awk files: syntax checking, referencing and hovering.

## Settings:

* awk.maxNumberOfProblems: maximum number of problems listed in the editor.

* awk.mode: can be "awk" or "gawk". Should be set according to the interpreter used.

* awk.stylisticWarnings.missingSemicolon: true or false. When true, marks places
  where a newline ends a statement. False by default, but true when in "awk" mode.

* awk.stylisticWarnings.compatibility: when true, marks functions and global
  variables only available in gawk.

* awk.path: list of paths to include directories (only in gawk mode).

## Peculiarities:

Comments with a double hash (\#\#) before a function declaration are considered
doc-comments, and are shown in the hover text.