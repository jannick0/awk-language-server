0.2.0
=====

- Error messages on undeclared functions.

- Error messages on wrong number of parameters.

- Gawk mode set when #!...gawk present in the first line of the file

0.1.0
=====

- Move to github (hoping for some feedback, bugs, feature request)

- Distinction between parameters and local variables based on the fairly common convention that local variables are declared in the function heading, but with extra spaces or newlines before the first one: `function f(a,⎵b)` has two parameters: `a` and `b`, while `function f(a,⎵⎵b)` has one parameter, `a`, and a local variable, `b`. Cf. https://www.gnu.org/software/gawk/manual/html_node/Functions-Summary.html

0.0.2
=====

- Bug fix: crash in `split()` on entry without doc comment

- Not explicitly declared names are marked as global variables without the ability to jump to their declaration
    
- All symbols available for completion and hover
    
- Added some more pre-defined functions; print and exit are now also declared as functions.


0.0.1
=====
Initial release
