# README

## Language extension for awk

Implements a number of VSCode's language server functions for awk files:

* syntax checking: the extension marks grammatical errors depending on the mode. Some checks are options (see below).

* referencing and outline: the extension provides a list of the places where a symbol is defined and used, and also a simple outline.

* hovering: on hover, the symbol's definition is shown, including a brief version of the documentation of built-in functions, or the "doc comment" (see below).

* context-sensitive completion: functions, global variables and local variables of the function are listed; variables local to other functions are not listed.

## Comment

When functions are preceded by a comment with two \# symbols, the comment is shown on hover. There is no support for attributes such as in Javadoc.

## Settings (in your .vscode):

* awk.maxNumberOfProblems: maximum number of problems listed in the editor.

* awk.mode: can be "awk" or "gawk". Should be set according to the interpreter used. Note that a "shebang" line at the start of the file will override the mode per file (e.g. #! /usr/bin/gawk -f and variations of it will turn on gawk mode for that file, even if awk.mode is "awk").

* awk.stylisticWarnings.missingSemicolon: true or false. When true, marks places where a newline ends a statement. False by default, but true when in "awk" mode.

* awk.stylisticWarnings.compatibility: when true, marks functions and global variables only available in gawk.

* awk.stylisticWarnings.checkFunctionCalls: when true, compares the number of arguments in a function call to the parameter list; takes the convention for local variables into account; true by default.

* awk.path: list of paths to include directories (only in gawk mode).

## Peculiarities:

- Using more than one space before a parameter in the function declaration makes it a local variable. This is in line with the awk conventions. See: https://www.gnu.org/software/gawk/manual/html_node/Functions-Summary.html