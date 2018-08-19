/*
 * Document administration. See @AWKDocument.
 */

import {
    EMap, Equal, transitiveClosure
} from './util';

import {
    Diagnostic, Position, DiagnosticSeverity, Range,
    IConnection, ParameterInformation
} from 'vscode-languageserver';

import {
    PathPositionTree, positionCompare, PathPositionNode,
    findPathPositionNode, createPathPositionNode
} from './path';

import {
    SymbolUsage,
    SymbolDefinition,
    SymbolType,
    ParameterUsage
} from './symbols';

import {
    builtInSymbols
} from './awk';

export class IncludeDeclarationInfo implements Equal {
    constructor(public range: Range) {
    }

    isEqual(p: IncludeDeclarationInfo): boolean {
        return this.range === p.range;
    }
}

/**
 * Contains the information obtained from parsing one .awk file.
 * 
 * @export
 * @class AWKDocument
 */
export class AWKDocument {
    /** Location and unique id of the document */
    uri: string;

    /** all symbols defined in this document indexed by type */
    definedSymbols: Map<string, SymbolDefinition[]>[];

    /** a list of all used symbols per document, sorted by occurrence (line, column) */
    usedSymbols: SymbolUsage[];

    /** Position tree representing the symbols and their sub expressions in this document */
    positionTree: PathPositionTree;

    /** Documents that include this document */
    includedBy: EMap<AWKDocument, IncludeDeclarationInfo> = new EMap<AWKDocument, IncludeDeclarationInfo>();

    /** Documents that this document includes */
    includes: EMap<AWKDocument, IncludeDeclarationInfo>;

    /**
     * List of errors and warnings from the parsing phase. This list doesn't
     * change during the analysis phase. 
     */
    private parseDiagnostics: Diagnostic[] = [];

    /** List of errors and warnings from later analysis */
    private analysisDiagnostics: Diagnostic[] = [];

    /**
     * When true, the errors have changed since they were last sent to the work
     * space, and need to be sent again.
     */
    private errorsChanged: boolean = false;

    constructor(uri: string) {
        this.uri = uri;
        this.init();
    }

    init(): void {
        this.definedSymbols = [];
        this.usedSymbols = [];
        this.positionTree = [];
        this.functionCallStack = [];
        this.parameterUsage = [];
        this.includes = new EMap<AWKDocument, IncludeDeclarationInfo>();
        if (this.oldNumberOfParameters === undefined) {
            this.oldNumberOfParameters = this.numberOfParameters;
        }
        this.numberOfParameters = {};
    }

    addSymbolDefinition(symbol: string, symbolDefinition: SymbolDefinition): SymbolDefinition {
        let map = this.definedSymbols[symbolDefinition.type];

        if (map === undefined) {
            this.definedSymbols[symbolDefinition.type] = map = new Map();
        }
        if (!map.has(symbol)) {
            map.set(symbol, []);
        }
        map.get(symbol)!.push(symbolDefinition);
        return symbolDefinition;
    }

    getSymbolDefinitions(symbol: string, type: SymbolType): SymbolDefinition[]|undefined {
        const map = this.definedSymbols[type];

        return map === undefined? undefined: map.get(symbol);
    }

    isSymbolDefined(symbol: string, type: SymbolType): boolean {
        const map = this.definedSymbols[type];

        return map !== undefined && map.has(symbol);
    }

    addSymbolUsage(usage: SymbolUsage): void {
        this.usedSymbols.push(usage);
    }

    /** Clears includedBy references from this document. Returns true when
     *  there was a change.
    */
    clearIncludedBy(): boolean {
        let inclChanges: boolean = false;

        for (const includedDoc of this.includes.keys()) {
            includedDoc.includedBy.delete(this);
            inclChanges = true;
        }
        return inclChanges;
    }

    addIncludes(includedDoc: AWKDocument, incl: IncludeDeclarationInfo): void {
        if (this.includes.has(includedDoc)) {
            this.addParseDiagnostic({
                severity: DiagnosticSeverity.Warning,
                range: incl.range,
                message: "repeated include"
            });
        }
        this.includes.set(includedDoc, incl);
    }

    addIncludedBy(includingDoc: AWKDocument, incl: IncludeDeclarationInfo): void {
        this.includedBy.set(includingDoc, incl);
    }

    removeIncludedBy(includingDoc: AWKDocument): void {
        this.includedBy.delete(includingDoc);
    }

    /** Removes the information a document has added, initializing it for
     *  (re)parsing. If the same document is parsed again, the state afterwards
     *  is identical to the state before calling this function. Tracing changes
     *  to inheritanceMapClosure is the caller's responsibility.
     *  Keeps previous caches for incremental updates.
     */
    clear(): void {
        this.clearIncludedBy();
        this.init();
        this.resetParseDiagnostics();
    }

    /** Like clearDocument, but the document won't be parsed any time soon.
     *  Sets inheritanceClosureOutdated in case there is a possible change.
     */
    close(connection: IConnection): boolean {
        const inclChanges: boolean = this.clearIncludedBy();

        connection.sendDiagnostics({
            uri: this.uri,
            diagnostics: []
        });
        return inclChanges;
    }

    /** True when document is included by other document; when a document is
     * not included, it must be closed. Note that the editor and lib.conf +
     * includeList.js are responsible for most inclusions.
     */
    isIncluded(): boolean {
        return this.includedBy.size !== 0;
    }

    addParseDiagnostic(d: Diagnostic): void {
        if (this.parseDiagnostics.length === 0 ||
              positionCompare(
                  this.parseDiagnostics[this.parseDiagnostics.length - 1].range.start,
                  d.range.start
              ) !== 0) {
            this.parseDiagnostics.push(d);
            this.errorsChanged = true;
        }
    }

    resetParseDiagnostics(): void {
        this.errorsChanged = true;
        this.parseDiagnostics.length = 0;
    }

    addAnalysisDiagnostic(d: Diagnostic): void {
        this.analysisDiagnostics.push(d);
        this.errorsChanged = true;
    }

    resetAnalysisDiagnostics(): void {
        if (this.analysisDiagnostics.length !== 0) { 
            this.errorsChanged = true;
        }
        this.analysisDiagnostics.length = 0;
    }

    sendDiagnostics(connection: IConnection, maxNumberOfProblems: number): void {
        if (this.errorsChanged) {
            let diagnostics = this.parseDiagnostics.concat(this.analysisDiagnostics);
            if (diagnostics.length > maxNumberOfProblems) {
                diagnostics = diagnostics.
                    sort(function(a: Diagnostic, b: Diagnostic): number {
                            return a.severity! - b.severity!;
                        }).
                    slice(0, maxNumberOfProblems).
                    sort(function(a: Diagnostic, b: Diagnostic): number {
                        return positionCompare(a.range.start, b.range.start);
                    });
            }
            connection.sendDiagnostics({
                uri: this.uri,
                diagnostics: diagnostics
            });
            this.errorsChanged = false;
        }
    }

    getShortName(): string {
        return this.uri.slice(this.uri.lastIndexOf('/') + 1);
    }

    // Marks first valid position after attribute (just after the colon)
    beginPathFun(path: string[], position: Position): void {
        createPathPositionNode(this.positionTree, path, position);
    }

    // Marks last valid position after attribute (the comma or closing brace) when
    // it hasn't been closed by closing of lower paths yet.
    endPathFun(path: string[], position: Position): void {
        const node = findPathPositionNode(this.positionTree, path);

        // debugLog("endPathFun " + path.join(".") + " " + String(node !== undefined));
        if (node !== undefined && node.end === undefined) {
            node.end = position;
        }
    }

    // Marks first valid position of an AV
    beginEmbeddingFun(path: string[], position: Position): void {
        const node: PathPositionNode = createPathPositionNode(this.positionTree, path, position);

        node.avStart = position;
    }

    // Marks last valid position of an AV (before endPathFun).
    endEmbeddingFun(path: string[], position: Position): void {
        const node = findPathPositionNode(this.positionTree, path);

        if (node !== undefined) {
            node.end = position;
        }
    }

    /**
     * The call stack of functions at the current symbol during parsing
     */
    functionCallStack: SymbolUsage[] = [];
    /**
     * Positions of the start and end of each function parameter, sorted by
     * ascending text position.
     */
    parameterUsage: ParameterUsage[] = [];

    /**
     * Called by the parser when a function call starts or ends
     * 
     * @param start True at start of function call, false at end
     * @param position text position
     */
    registerFunctionCall(start: boolean, position: Position): void {
        if (start) {
            this.functionCallStack.push(this.usedSymbols[this.usedSymbols.length - 1]);
        } else {
            const funcCallSym = this.functionCallStack.pop();
            // Mark end of parameters
            this.parameterUsage.push(new ParameterUsage(funcCallSym!, -1, position, start));
        }
    }

    /**
     * Registers begin and end of a function parameter
     * 
     * @param parameterIndex 0 based index of the parameter
     * @param start true at start of parameter, false at end
     * @param line line number in text
     * @param position character position in text
     */
    registerFunctionCallParameter(parameterIndex: number, start: boolean, line: number, position: number): void {
        this.parameterUsage.push(new ParameterUsage(
            this.functionCallStack[this.functionCallStack.length - 1],
            parameterIndex, {line: line, character: position}, start));
    }

    /**
     * Number of parameters of the functions declared in this document
     */
    numberOfParameters: {[fnName: string]: number} = {};
    /**
     * Number of parameters of the functions declared in the previous version of
     * this document
     */
    oldNumberOfParameters: {[fnName: string]: number}|undefined = undefined;

    /**
     * Stores the number of parameters for the function for the current analysis.
     * Comparing to the results of the previous analysis shows changes.
     */
    registerNumberOfParameters(fn: SymbolDefinition): void {
        this.numberOfParameters[fn.symbol] = fn.parameters.length;
    }

    /**
     * Compares the map with function information (just number of parameters
     * really) to the last known information.
     * 
     * @returns true when at least one function has changed
     */
    functionInformationHasChanged(): boolean {
        let change: boolean = false;

        if (this.oldNumberOfParameters === undefined) {
            this.oldNumberOfParameters = {};
        }
        for (const fnName in this.numberOfParameters) {
            if (this.numberOfParameters[fnName] !== this.oldNumberOfParameters[fnName]) {
                change = true;
                break;
            }
        }
        if (!change) {
            for (const fnName in this.oldNumberOfParameters) {
                if (!(fnName in this.numberOfParameters)) {
                    change = true;
                    break;
                }
            }
        }
        this.oldNumberOfParameters = undefined;
        return change;
    }

    checkFunctionCalls(): void {
        let includedDocs = new Set(this.includes.keys());
        let numberOfParameters: {[fnName: string]: number} = { ...this.numberOfParameters};

        this.resetAnalysisDiagnostics();

        // Get set of all included documents; note that includedDocs does not
        // contain this.
        transitiveClosure(includedDocs, doc => doc.includes.keys());
        // Compile list of all available function names and their number of
        // parameters; issue warning when function included and contained in
        // this document.
        for (const inclDoc of includedDocs) {
            const funDefs = inclDoc.numberOfParameters;
            for (const funName in funDefs) {
                const nrParamFun = funDefs[funName];
                if (funName in numberOfParameters) {
                    if (funName in this.numberOfParameters) {
                        const funDef = this.getSymbolDefinitions(funName, SymbolType.func);
                        if (funDef !== undefined && funDef.length > 0) {
                            this.addAnalysisDiagnostic(Diagnostic.create(
                                funDef[0].getRange(),
                                "already defined in `${inclDoc.uri}`"));
                        }
                    }
                } else {
                    numberOfParameters[funName] = funDefs[funName];
                }
            }
        }

        // Mark wrong number of parameters and ambiguous and non-existent function calls

        function getNrParametersRange(fnName: string): [number, number] {
            if (fnName in numberOfParameters) {
                return [numberOfParameters[fnName], numberOfParameters[fnName]];
            } else if (fnName in builtInSymbols) {
                const bif = builtInSymbols[fnName];
                if (bif.parameters === undefined) {
                    return [-1, Number.MAX_SAFE_INTEGER];
                } else {
                    const max = bif.maxNrArguments !== undefined?
                                bif.maxNrArguments: bif.parameters.length;
                    return bif.firstOptional !== undefined?
                           [bif.firstOptional, max]: [max, max];
                }
            } else {
                return [-1, Number.MAX_SAFE_INTEGER];
            }
        }

        if (this.parameterUsage.length === 0) {
            return;
        }

        // Establish min/max nr of parameters for first call
        let nrParamRangeStack = [];
        let nrParametersStack: number[] = [];

        for (let i = 0; i < this.parameterUsage.length; i++) {
            const param = this.parameterUsage[i];
            if (param.start) {
                if (param.parameterIndex <= 0) {
                    // First parameter of function call
                    nrParamRangeStack.push(getNrParametersRange(param.functionName.symbol));
                    nrParametersStack.push(0);
                    this.checkFunctionExistence(param.functionName, numberOfParameters);
                }
                nrParametersStack[nrParametersStack.length - 1] = param.parameterIndex + 1;
            } else {
                if (param.parameterIndex === -1) {
                    // Closing function call
                    const [minNrParams, maxNrParams] = nrParamRangeStack.pop()!;
                    const nrParameters = nrParametersStack.pop()!;
                    if (nrParameters < minNrParams) {
                        const endPosition = {line: param.position.line, character: param.position.character + 1};
                        this.addAnalysisDiagnostic(Diagnostic.create(
                            param.functionName.getRange(),
                            "not enough arguments"));
                    } else if (nrParameters > maxNrParams) {
                        const endPosition = {line: param.position.line, character: param.position.character + 1};
                        this.addAnalysisDiagnostic(Diagnostic.create(
                            param.functionName.getRange(),
                            "too many arguments"));
                    }
                }
            }
        }
    }

    // Mark undefined functions
    checkFunctionExistence(fn: SymbolUsage, numberOfParameters: {[fnName: string]: number}): void {
        const sym: string = fn.symbol;

        if (!(sym in numberOfParameters) && !(sym in builtInSymbols)) {
            this.addAnalysisDiagnostic(Diagnostic.create(
                fn.getRange(), "undeclared function"));
        }
    }
}
