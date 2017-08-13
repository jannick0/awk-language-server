'use strict';

import {
    IPCMessageReader, IPCMessageWriter, createConnection, IConnection, TextDocuments,
    DiagnosticSeverity, InitializeParams, InitializeResult, CompletionItem,
    CompletionItemKind, Location, Range, Position, Definition, Hover,
    SymbolInformation, SymbolKind, TextDocumentIdentifier, ReferenceParams,
    WorkspaceSymbolParams, TextDocumentPositionParams, TextDocument,
    DocumentSymbolParams, DidCloseTextDocumentParams
} from 'vscode-languageserver';

import {
    parse, setFileBaseName, setDefineFun, setMessageFun, setUsageFun,
    setIncludeFun, updateStylisticWarnings, lastSymbolPos, builtInSymbols,
    BuiltInFunction, functionParameters, AwkLanguageServerSettings
} from "./awk";

import  {
    PathPositionNode, PathPositionTree, finishPositionTree
} from './path';

import {
    AWKDocument, IncludeDeclarationInfo
} from './awkdocument';

import {
    SymbolDefinition,
    SymbolUsage,
    SymbolType,
    getRange,
    getSymbolDefineType,
    isSymbolDefineType,
    removeSymbolDefineType
} from './symbols';

import {
    readFile, makeURI, makeAbsolutePathName, makeRelativePathName,
    fileExists, nrOpenReadRequests
} from './filesystem';

import {
    setDebugLogDir, debugLog
} from './filesystem';

// PROCESSING QUEUE

enum ProcessQueueItemType {
    awk
}

/** Item to process */
class ProcessQueueItem {
    /** The document holder */
    doc: AWKDocument;
    /** The textual contents of the document */
    text: string;
    /** The type of document */
    type: ProcessQueueItemType;
    /** When true, the file is open in the editor */
    openInEditor: boolean;
}

let processingAllowed: boolean = true;

let processingQueue: ProcessQueueItem[] = [];

function haltProcessingQueue(): void {
    processingAllowed = false;
    // debugLog("halt queue"); // !!!
}

function allowProcessingQueue(): void {
    processingAllowed = true;
    // debugLog("resume queue " + processingQueue.map(function (pqi): string {
    //     return pqi.doc.getShortName() + " (" + ProcessQueueItemType[pqi.type] + ")";
    // }).join(", "));  // !!!
}

function addToFrontOfProcessingQueue(doc: AWKDocument, text: string, type: ProcessQueueItemType, openInEditor: boolean): void {
    // debugLog("add to front of queue " + doc.getShortName() + " " + ProcessQueueItemType[type]); // !!!
    processingQueue.unshift({doc: doc, text: text, type: type, openInEditor: openInEditor});
    processNextQueueItem();
}

function addToEndOfProcessingQueue(doc: AWKDocument, text: string, type: ProcessQueueItemType, openInEditor: boolean): void {
    // debugLog("add to end of queue " + doc.getShortName() + " " + ProcessQueueItemType[type]); // !!!
    processingQueue.push({doc: doc, text: text, type: type, openInEditor: openInEditor});
    processNextQueueItem();
}

function processNextQueueItem(): void {
    while (nrOpenReadRequests === 0 && processingAllowed && processingQueue.length !== 0) {
        let queueItem: ProcessQueueItem = processingQueue.shift()!;
        // debugLog("process " + queueItem.doc.uri + " " + ProcessQueueItemType[queueItem.type]); // !!!
        switch (queueItem.type) {
          case ProcessQueueItemType.awk:
            validateTextDocument(queueItem.doc, queueItem.text, queueItem.openInEditor);
            break;
        }
    }
    if (nrOpenReadRequests === 0 && processingAllowed) {
        finishUpProcessing();
    }
}

function sendDiagnostics(): void {
    for (let doc of documentMap.values()) {
        doc.sendDiagnostics(connection, config.maxNumberOfProblems);
    }
}

function finishUpProcessing(): void {
    closeEmptyDocuments();
    sendDiagnostics();
} 

// LANGUAGE DEFINITION AND USAGE

function processConfiguration(doc: AWKDocument, configText: string): void {
    //connection.console.log("config ${doc.uri}"); // !!!
    // no config read
}

// CALLBACK FROM THE PARSER

let includePath: string[] = ["."];

function setIncludePath(ip: string[]): boolean {
    if (ip.length === includePath.length &&
          ip.every((value: string, index: number) => includePath[index] === value)) {
        return false;
    }
    includePath = ip;
    // connection.console.log(`awkpath = ${includePath.join(":")}`);
    return true;
}

// Triggers parsing of an include file, or reports that the file doesn't exist
function addInclude(filename: string, relative: boolean, position: Position, length: number, includeSource: AWKDocument): void {
    let inclFileNames: string[] = relative?
        makeRelativePathName(includeSource.uri, filename): makeAbsolutePathName(filename);
    let inclFileName: string = inclFileNames.filter(function(fn: string): boolean {
        return fileExists(fn);
    })[0];

    // debugLog("addInclude " + filename); // !!!
    if (inclFileName === undefined) {
        includeSource.addParseDiagnostic({
            severity: DiagnosticSeverity.Error,
            range: getRange(position, length),
            message: "no such file: " + filename + " (" + includeSource.uri + ")"
        });
        return;
    }
	let inclURI: string = makeURI(inclFileName);
    if (documentMap.has(inclURI)) {
        // Already parsed
        return;
    }
	// Prevent loading multiple times, possibly in a cycle
    let newDoc: AWKDocument = new AWKDocument(inclURI);
	documentMap.set(inclURI, newDoc);
    updateInclude(includeSource, newDoc, getRange(position, length));
    // This will trigger a read once the current file has been parsed
    readFile(inclFileName, function (err: any, data: string): void {
        if (!err) {
            addToEndOfProcessingQueue(newDoc, data, ProcessQueueItemType.awk, false);
        } else {
            processNextQueueItem();
        }
    });
}

// Adds a message; ignores specific warnings
function messageFun(type: string, subType: string, msg: string, position: Position, length: number, doc: AWKDocument): void {
    function ignoreThisMessage(): boolean {
        return type === "warning" &&
               ((subType === "comma" && !config.stylisticWarnings.missingSemicolon) ||
                (subType === "future" && !config.stylisticWarnings.compatibility));
    }
    if (!ignoreThisMessage()) {
        doc.addParseDiagnostic({
            severity: type === "warning"? DiagnosticSeverity.Warning: DiagnosticSeverity.Error,
            range: getRange(position, length),
            message: msg
        });
    }
}

/** Maps docURI -> AWKDocument */
let documentMap: Map<string, AWKDocument> = new Map();

function addSymbolDefinition(type: SymbolType, doc: AWKDocument, symbol: string, position: Position, docComment: string): void {
    let symbolDefinition: SymbolDefinition = new SymbolDefinition(
        doc, position, type, docComment, symbol);

    doc.addSymbolDefinition(symbol, symbolDefinition);
    let defineType = getSymbolDefineType(type);
    if (defineType !== undefined) {
        addSymbolUsage(defineType, doc, symbol, position);
    }
}

// Store symbol usage
function addSymbolUsage(type: SymbolType, doc: AWKDocument, symbol: string, position: Position): void {
    let usage = new SymbolUsage(symbol, type, position);
    
    doc.addSymbolUsage(usage);
}

function updateInclude(includingDoc: AWKDocument, includedDoc: AWKDocument, range: Range): void {
    let inclInfo = new IncludeDeclarationInfo(range);

    includingDoc.addIncludes(includedDoc, inclInfo);
    includedDoc.addIncludedBy(includingDoc, inclInfo);
}

function closeEmptyDocuments(): void {
    let inclChanges: boolean = true;

    while (inclChanges) {
        inclChanges = false;
        for (let [uri, doc] of documentMap) {
            if (!doc.isIncluded()) {
                // debugLog("closing " + uri); // !!!
                if (doc.close(connection)) {
                    inclChanges = true;
                }
                documentMap.delete(uri);
            }
        }
    }
}

// DOCUMENT HANDLING

interface UserPreferences {
    maxNumberOfProblems?: number;
    mode?: string;
    stylisticWarnings?: {
        /** When true, warns for superfluous commas */
        missingSemicolon?: boolean;
        /** When true, warns for gawk features in awk mode */
        compatibility?: boolean;
    };
    path?: string[];
}

// Default config
let config: AwkLanguageServerSettings = {
	maxNumberOfProblems: 100,
    gawk: true,
    stylisticWarnings: {
        missingSemicolon: false,
        compatibility: true
    }
};

function updateConfiguration(settings: UserPreferences|undefined): boolean {
    let reparse: boolean = false;

    // connection.console.log("config " + JSON.stringify(settings)); // !!!
    if (settings === undefined) {
        return false;
    }
    if (settings.maxNumberOfProblems !== config.maxNumberOfProblems) {
          config.maxNumberOfProblems = settings.maxNumberOfProblems || 100;
        reparse = true;
    }
    let gawkMode = settings.mode === undefined || settings.mode === "gawk";
    if (config.gawk !== gawkMode) {
        config.gawk = gawkMode;
        reparse = true;
    }
    if (settings.stylisticWarnings instanceof Object) {
        if (settings.stylisticWarnings.missingSemicolon !== undefined &&
              settings.stylisticWarnings.missingSemicolon !== config.stylisticWarnings.missingSemicolon) {
            config.stylisticWarnings.missingSemicolon = !!settings.stylisticWarnings.missingSemicolon;
            reparse = true;
        }
        if (settings.stylisticWarnings.compatibility !== undefined &&
              settings.stylisticWarnings.compatibility !== config.stylisticWarnings.compatibility) {
            config.stylisticWarnings.compatibility = !!settings.stylisticWarnings.compatibility;
            reparse = true;
        }
        updateStylisticWarnings(config);
        if (settings.path instanceof Array) {
            if (setIncludePath(settings.path)) {
                reparse = true;
            }
        } else if (typeof(process.env["AWKPATH"]) === "string") {
            if (setIncludePath(process.env["AWKPATH"].split(":"))) {
                reparse = true;
            }
        } else {
            if (setIncludePath(["."])) {
                reparse = true;
            }
        }
    }
    return reparse;
}

// let count: number = 0; // debugging

function validateTextDocument(doc: AWKDocument, text: string, openInEditor: boolean): void {
    let baseName: string = doc.uri.replace(/^(.*\/)?([^\/]*)\..*$/, "$2");
    
    // Set up handlers
    setFileBaseName(baseName.match(/Constants$/)? undefined: baseName);
    setDefineFun(function(type: SymbolType, symbol: string, line: number, position: number, docComment: string): void {
        addSymbolDefinition(type, doc, symbol, {line: line - 1, character: position - 1}, docComment);
    });
    setUsageFun(function(type: SymbolType, symbol: string, line: number, position: number): void {
        // connection.console.log(`message ${type} ${inherit} ${symbol}`); // !!!
        addSymbolUsage(type, doc, symbol, {line: line - 1, character: position - 1});
    });
    setMessageFun(function(type: string, subType: string, msg: string, line: number, position: number, length: number): void {
        // connection.console.log(`message ${type} ${subType} ${msg}`); // !!!
        messageFun(type, subType, msg, {line: line - 1, character: position - 1}, length, doc);
    });
    setIncludeFun(function(filename: string, relative: boolean, line: number, position: number, length: number): void {
        addInclude(filename, relative, {line: line - 1, character: position - 1}, length, doc);
    });

	validateText(doc, text);
}

/** This should be 1 at most; anything higher and one call to validateText
    interrupts another.
**/
let parseLevel: number = 0;

function validateText(doc: AWKDocument, text: string): void {
	if (parseLevel !== 0) {
		connection.console.log("parseLevel = " + parseLevel);
	}
	parseLevel++;

    // Clear information from previous parse
    doc.clear();

    // Parse the text; messages are collected via the above handlers
    try {
        parse(text);
    } catch (ex) {
        connection.console.error(ex);
        messageFun("error", "exception", "parser crash", {line: lastSymbolPos.line - 1, character: lastSymbolPos.position - 1}, 100, doc);
    }

    finishPositionTree(doc.positionTree);
	parseLevel--;
}

function findSymbolForPosition(textDocumentPosition: TextDocumentPositionParams): SymbolUsage|undefined {
    let docURI = textDocumentPosition.textDocument.uri;
    let doc = documentMap.get(docURI);
    let pos = textDocumentPosition.position;

    function binsearch(arr: SymbolUsage[], val: Position): SymbolUsage|undefined {
        let from: number = 0;
        let to: number = arr.length - 1;

        function compare(a: SymbolUsage, b: Position): number {
            return a.position.line !== b.line? a.position.line - b.line:
                   b.character == a.position.character && a.symbol.length === 0? 0:
                   b.character > a.position.character + a.symbol.length? -1:
                   b.character < a.position.character? 1:
                   0;
        }

        if (from > to) {
            return undefined;
        }
        while (from < to) {
            let i: number = Math.floor((to + from) / 2);
            let res: number = compare(arr[i], val);
            if (res < 0) {
                from = i + 1;
            } else if (res > 0) {
                to = i - 1;
            } else {
                return arr[i];
            }
        }
        return compare(arr[from], val) === 0? arr[from]: undefined;
    }

    if (doc === undefined) {
        // connection.console.log(`cannot find position`);
        return undefined;
    } else {
        let usage = binsearch(doc.usedSymbols, pos);
        if (usage !== undefined && isSymbolDefineType(usage.type)) {
            // connection.console.log(`found define ${usage.symbol}`);
            return new SymbolUsage(usage.symbol, removeSymbolDefineType(usage.type),
                                   usage.position);
        } else {
            // connection.console.log(`found usage ${usage === undefined? "<none>": usage.symbol}`);
            return usage;
        }
    }
}

function dumpPositionTree(tree: PathPositionTree, indent: string = ""): string {
    let txt: string = "";
    let nextIndent: string = indent + "  ";

    function formatpos(p: Position|undefined): string {
        return p !== undefined? p.line + ":" + p.character: "?";
    }

    for (var i = 0; i < tree.length; i++) {
        var node: PathPositionNode = tree[i];
        txt += indent + node.attribute + " [" + formatpos(node.start) + "," + formatpos(node.avStart) + "," + formatpos(node.end) + "]" + "\n";
        if (node.next !== undefined) {
            txt += dumpPositionTree(node.next, nextIndent);
        }
    }
    return txt;
}

function builtInCompletions(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    return Object.keys(builtInSymbols).map(bif => {
        return {
                label: bif,
                kind: CompletionItemKind.Function,
                data: {
                    symbol: bif,
                    docComment: builtInSymbols[bif].description
                }
            }
    });
}

/**
 * Strips the leading comment symbols and spaces from dc
 * 
 * @param {string} dc 
 * @returns {string} 
 */
let docCommentStart = /^##[ \t]*/;
function leftAlign(docComment: string): string {
    let lines = docComment.split("\n");
    let minLength = lines.map((line) => {
        let matches = line.match(docCommentStart);
        return matches === null? 2: matches[0].length;
    }).reduce((min: number, len: number) => len < min? len: min, 2);

    return lines.map((line: string): string => line.substr(minLength)).join("\n");
}

// LANGUAGE FEATURES

// Finds symbol to be completed and returns all symbols with a corresponding
// definition.
function awkCompletionHandler(textDocumentPosition: TextDocumentPositionParams): CompletionItem[] {
    let usage = findSymbolForPosition(textDocumentPosition);
    let compl = builtInCompletions(textDocumentPosition);

    let usageType: SymbolType|undefined = usage === undefined? undefined: usage.type;
    let completions: Map<string, Set<string>> = new Map();
    documentMap.forEach(function(doc: AWKDocument): void {
        for (var type = 0; type < doc.definedSymbols.length; type++) {
            let defMap = doc.definedSymbols[type];
            if (defMap !== undefined && (usageType === undefined || type === usageType)) {
                defMap.forEach(function(definitions: SymbolDefinition[], symbol: string): void {
                    if (symbol !== undefined /*&& symbol.startsWith(usage!.symbol)*/) {
                        for (let i = 0; i < definitions.length; i++) {
                            let def = definitions[i];
                            if (!completions.has(symbol)) {
                                completions.set(symbol, new Set());
                            }
                            if (def.docComment !== "") {
                                completions.get(symbol)!.add(leftAlign(def.docComment));
                            }
                        }
                    }
                });
            }
        }
    });
    let ci: CompletionItem[] = [];
    completions.forEach(function(docComments: Set<string>, symbol: string): void {
        docComments.forEach(function(docComment: string): void {
            ci.push({
                label: symbol,
                kind: SymbolKind.Interface,
                data: {
                    symbol: symbol,
                    docComment: docComment
                }
            });
        });
    });
    return ci.concat(compl);
}

function makeBuiltInHover(descr: BuiltInFunction): string {
    return descr.parameters === undefined? "built-in variable: " + descr.description:
           "built-in function: " + descr.name + "(" + 
           (descr.firstOptional === undefined? descr.parameters.join(","):
            descr.parameters.slice(0, descr.firstOptional).join(",") +
            "[" + descr.parameters.slice(descr.firstOptional).join(",") + "]") +
           "): " + descr.description;
}

function awkHoverProvider(textDocumentPosition: TextDocumentPositionParams): Hover {
    let usage = findSymbolForPosition(textDocumentPosition);
    let doc = documentMap.get(textDocumentPosition.textDocument.uri);

	if (doc === undefined || usage === undefined) {
        return { contents: [] };
    } else if (usage.type === SymbolType.func && usage.symbol in builtInSymbols &&
               (config.stylisticWarnings.compatibility || builtInSymbols[usage.symbol].awk)) {
        return {
            contents: [
                makeBuiltInHover(builtInSymbols[usage.symbol])
            ]
        }
    } else if (usage.type === SymbolType.globalVariable && usage.symbol in builtInSymbols &&
               (config.stylisticWarnings.compatibility || builtInSymbols[usage.symbol].awk)) {
        return {
            contents: [
                makeBuiltInHover(builtInSymbols[usage.symbol])
            ]
        }
    }
    let hoverTexts: string[] = [];
    documentMap.forEach(function(doc: AWKDocument): void {
        let defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage!.type];
        if (defMap !== undefined && defMap.has(usage!.symbol)) {
            let definitions = defMap.get(usage!.symbol)!;
            for (let i = 0; i < definitions.length; i++) {
                let def = definitions[i];
                let text: string|undefined;
                switch (def.type) {
                  case SymbolType.localVariable:
                    text = "parameter/local variable";
                    break;
                  case SymbolType.func:
                    let name = def.getSymbol();
                    text = "function " + name + "(" + functionParameters[name].join(", ") + ")";
                    break;
                }
                if (def.docComment !== undefined) {
                    if (text !== undefined) {
                        text += "\n" + leftAlign(def.docComment);
                    } else {
                        text = leftAlign(def.docComment);
                    }
                }
                if (text !== undefined) {
                    hoverTexts.push(text);
                }
            }
        }
    });
	return hoverTexts.length === 0 && usage.type === SymbolType.func? {
            contents: ["undeclared function"]
        }: hoverTexts.length === 0 && usage.type === SymbolType.globalVariable? {
            contents: ["global variable"]
        }: {
		    contents: hoverTexts
        };
}

function awkDefinitionProvider(textDocumentPosition: TextDocumentPositionParams): Definition {
    let usage = findSymbolForPosition(textDocumentPosition);
    let doc = documentMap.get(textDocumentPosition.textDocument.uri);

    if (doc === undefined || usage === undefined) {
        return [];
    }
    let symbol: string = usage.symbol;
    let definitionDistance: {definition: SymbolDefinition;}[] = [];
    documentMap.forEach(function(doc: AWKDocument): void {
        let defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage!.type];
        if (defMap !== undefined && defMap.has(usage!.symbol)) {
            let definitions = defMap.get(usage!.symbol)!;
            for (let i = 0; i < definitions.length; i++) {
                let def = definitions[i];
                definitionDistance.push({definition: def});
            }
        }
    });
    return definitionDistance.map((distDef): Location => {
                let def = distDef.definition;
                return Location.create(def.document.uri,
                                       getRange(def.position, symbol.length));
            });
}

function awkListAllSymbolsInFile(params: DocumentSymbolParams/*textDocumentIdentifier: TextDocumentIdentifier*/): SymbolInformation[] {
    let doc = documentMap.get(params.textDocument.uri);

    if (doc === undefined) {
        return [];
    }
    let si: SymbolInformation[] = [];
    doc.definedSymbols.forEach(function(defMap: Map<string, SymbolDefinition[]>, type: SymbolType): void {
        defMap.forEach(function(defs: SymbolDefinition[], symbol: string): void {
            if (symbol !== undefined && defs !== undefined && defs.length > 0) {
                let def: SymbolDefinition = defs[0];
                if (removeSymbolDefineType(def.type) === SymbolType.func) {
                    si.push(SymbolInformation.create(symbol, SymbolKind.Function,
                                                    getRange(def.position, symbol.length)));
                }
            }
        });
    });
    return si;
}

function awkReferenceProvider(rp: ReferenceParams): Location[] {
    let includeDeclaration = rp.context.includeDeclaration;
    let usage = findSymbolForPosition(rp);

    if (usage === undefined) {
        return [];
    }
    let locs: Location[] = [];
    if (includeDeclaration) {
        documentMap.forEach(function(doc: AWKDocument): void {
            let defMap: Map<string, SymbolDefinition[]> = doc.definedSymbols[usage!.type];
            if (defMap !== undefined && defMap.has(usage!.symbol)) {
                let defs = defMap.get(usage!.symbol)!;
                for (let i = 0; i < defs.length; i++) {
                    locs.push(Location.create(doc.uri, defs[i].getRange()));
                }
            }
        });
    }
    documentMap.forEach(function(doc: AWKDocument): void {
        let symbolUsage = doc.usedSymbols;
        for (let i = 0; i < symbolUsage.length; i++) {
            let docUsage = symbolUsage[i];
            if (docUsage.symbol === usage!.symbol &&
                  docUsage.type === usage!.type) {
                locs.push(Location.create(doc.uri, docUsage.getRange()));
            }
        }
    });
    return locs;
}

function awkWorkspaceSymbolProvider(ws: WorkspaceSymbolParams): SymbolInformation[] {
    let query: string = ws.query;
    let si: SymbolInformation[] = [];

    documentMap.forEach(function(doc: AWKDocument): void {
        doc.definedSymbols.forEach(function(defMap: Map<string, SymbolDefinition[]>, type: SymbolType): void {
            defMap.forEach(function(definitions: SymbolDefinition[], symbol: string): void {
                if (symbol !== undefined && symbol.startsWith(query)) {
                    if (definitions !== undefined) {
                        for (let i = 0; i < definitions.length; i++) {
                            let def = definitions[i];
                            if (removeSymbolDefineType(def.type) === SymbolType.func) {
                                si.push(SymbolInformation.create(symbol, SymbolKind.Function,
                                                                 def.getRange(), doc.uri));
                            }
                        }
                    }
                }
            });
        });
    });
    return si;
}

// Fake reference for the source that includes open documents
let editorURI: string = "editor://";
let editorDocument: AWKDocument = new AWKDocument(editorURI);

function closeDocURI(params: DidCloseTextDocumentParams): void {
    let doc = documentMap.get(params.textDocument.uri);

    if (doc !== undefined) {
        doc.removeIncludedBy(editorDocument);
        finishUpProcessing();
    }
}

// INTERFACE TO VSCODE

// Create a connection for the server. The connection uses Node's IPC as a transport
let connection: IConnection = createConnection(new IPCMessageReader(process), new IPCMessageWriter(process));

// After the server has started the client sends an initilize request. The server receives
// in the passed params the rootPath of the workspace plus the client capabilites. 
let workspaceRoot: string|null;

// Create a simple text document manager. The text document manager
// supports full document sync only
let documents: TextDocuments = new TextDocuments();
// Make the text document manager listen on the connection
// for open, change and close text document events
documents.listen(connection);

connection.onInitialize((params: InitializeParams): InitializeResult => {
    // connection.console.log("Initializing server");
    workspaceRoot = params.rootUri;
    setDebugLogDir(workspaceRoot, false);
    // connection.console.log(`server starting: ${process.pid}`); // !!!
    // connection.console.log("server initialized"); // !!!
    return {
        capabilities: {
            // Tell the client that the server works in FULL text document sync mode
            textDocumentSync: documents.syncKind,
            // Tell the client that the server support code complete
            completionProvider: {
                resolveProvider: true
            },
            definitionProvider: true,
            hoverProvider: true,
            documentSymbolProvider: true,
            referencesProvider: true,
            workspaceSymbolProvider: true
            // signatureHelpProvider?: SignatureHelpOptions;
            // documentHighlightProvider?: boolean;
            // codeActionProvider?: boolean;
            // codeLensProvider?: CodeLensOptions;
            // documentFormattingProvider?: boolean;
            // documentRangeFormattingProvider?: boolean;
            // documentOnTypeFormattingProvider?: DocumentOnTypeFormattingOptions;
            // renameProvider?: boolean;
        }
    }
});

// The content of a text document has changed. This event is emitted
// when the text document first opened or when its content has changed.
documents.onDidChangeContent((change) => {
    let doc = documentMap.get(change.document.uri);
    let type: ProcessQueueItemType = ProcessQueueItemType.awk;

    if (doc === undefined) {
        let inclDeclInfo = new IncludeDeclarationInfo({start: {line: 0, character: 0}, end: {line: 1, character: 0}});
        doc = new AWKDocument(change.document.uri);
        doc.addIncludedBy(editorDocument, inclDeclInfo);
        documentMap.set(change.document.uri, doc);
    }
    addToEndOfProcessingQueue(doc, change.document.getText(), type, true);
});

// The settings interface describe the server relevant settings part
interface Settings {
    awk: AwkLanguageServerSettings;
}

// The settings have changed. Is send on server activation as well.
connection.onDidChangeConfiguration((change) => {
    if (change === undefined) {
        return;
    }
    let settings = <Settings> change.settings;
    if (updateConfiguration(settings.awk)) {
        // Revalidate any open text documents immediately
        documents.all().forEach(function(document: TextDocument): void {
            let doc = documentMap.get(document.uri);
            let type: ProcessQueueItemType = ProcessQueueItemType.awk;
            if (doc !== undefined) {
                addToEndOfProcessingQueue(doc, document.getText(), type, true);
            }
        });
    }
});

/*
connection.onDidOpenTextDocument((params) => {
    // A text document got opened in VSCode.
    // params.uri uniquely identifies the document. For documents store on disk this is a file URI.
    // params.text the initial full content of the document.
    connection.console.log(`${params.uri} opened.`);
});

connection.onDidChangeTextDocument((params) => {
    // The content of a text document did change in VSCode.
    // params.uri uniquely identifies the document.
    // params.contentChanges describe the content changes to the document.
    connection.console.log(`${params.uri} changed: ${JSON.stringify(params.contentChanges)}`);
});

connection.onDidChangeWatchedFiles((change) => {
    // Monitored files have change in VSCode
    connection.console.log('We received an file change event');
});
*/

// This handler provides the initial list of the completion items.
connection.onCompletion(awkCompletionHandler);

// This handler resolve additional information for the item selected in
// the completion list.
connection.onCompletionResolve((item: CompletionItem): CompletionItem => {
    item.detail = item.data.label;
    item.documentation = item.data.docComment;
    return item;
});

// List of all definitions (including docComment) of the symbol at the given position
connection.onHover(awkHoverProvider);

// List of locations of the symbol at the given position sorted by inheritance
// distance.
connection.onDefinition(awkDefinitionProvider);

// List of all definitions in a file
connection.onDocumentSymbol(awkListAllSymbolsInFile);

connection.onReferences(awkReferenceProvider);

connection.onWorkspaceSymbol(awkWorkspaceSymbolProvider);

connection.onDidCloseTextDocument(closeDocURI);

// Listen on the connection
connection.listen();