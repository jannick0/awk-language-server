# README

This is a visual studio code language server implementation in node for [AWK](https://en.wikipedia.org/wiki/AWK) and GAWK (a modern variant). The interface, src/server.ts between VSCode and the parser and document administration has been taken from an (older) [VSCode language server sample](https://code.visualstudio.com/docs/extensions/example-language-server)

The interface calls the parser, src/awk.ll, an LL(1) recursive descent parser that marks syntax errors, warnings and also registers symbol definition and usage. The parser-generator is home brew and can be found [here](https://github.com/theovosse/llgen).

The other modules are for quick adminstration and retrieval.