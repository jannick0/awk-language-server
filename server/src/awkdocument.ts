import {
    EMap, Equal
} from './util';

import {
    Diagnostic, Position, DiagnosticSeverity, Range,
    IConnection
} from 'vscode-languageserver';

import {
    PathPositionTree, positionCompare, PathPositionNode,
    findPathPositionNode, createPathPositionNode
} from './path';

import {
    SymbolUsage,
    SymbolDefinition,
    SymbolType
} from './symbols';

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

    /** docURIs that include this document */
    includedBy: EMap<AWKDocument, IncludeDeclarationInfo> = new EMap<AWKDocument, IncludeDeclarationInfo>();

    /** docURIs that this document includes */
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
        this.includes = new EMap<AWKDocument, IncludeDeclarationInfo>();
    }

    addSymbolDefinition(symbol: string, symbolDefinition: SymbolDefinition): void {
        let map = this.definedSymbols[symbolDefinition.type];

        if (map === undefined) {
            this.definedSymbols[symbolDefinition.type] = map = new Map();
        }
        if (!map.has(symbol)) {
            map.set(symbol, []);
        }
        map.get(symbol)!.push(symbolDefinition);
    }

    isSymbolDefined(symbol: string, type: SymbolType): boolean {
        let map = this.definedSymbols[type];

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

        for (let includedDoc of this.includes.keys()) {
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
        let inclChanges: boolean = this.clearIncludedBy();

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
        let node = findPathPositionNode(this.positionTree, path);

        // debugLog("endPathFun " + path.join(".") + " " + String(node !== undefined));
        if (node !== undefined && node.end === undefined) {
            node.end = position;
        }
    }

    // Marks first valid position of an AV
    beginEmbeddingFun(path: string[], position: Position): void {
        let node: PathPositionNode = createPathPositionNode(this.positionTree, path, position);

        node.avStart = position;
    }

    // Marks last valid position of an AV (before endPathFun).
    endEmbeddingFun(path: string[], position: Position): void {
        let node = findPathPositionNode(this.positionTree, path);

        if (node !== undefined) {
            node.end = position;
        }
    }
}
