import {
    Equal
} from './util';

import {
    positionCompare
} from './path';

import {
    Position, Range
} from 'vscode-languageserver';

import {
    AWKDocument
} from './awkdocument';

export function positionOffset(position: Position, nrChars: number): Position {
    return { line: position.line, character: position.character + nrChars };
}

export function getRange(position: Position, nrChars: number): Range {
    return { start: position, end: positionOffset(position, nrChars) };
}

export enum SymbolType {
    func,
    globalVariable,
    localVariable,
    parameter,
    defineFunc,
    defineGlobalVariable,
    defineLocalVariable,
    defineParameter
}

export function getSymbolDefineType(t: SymbolType): SymbolType {
    switch (t) {
      case SymbolType.func: return SymbolType.defineFunc;
      case SymbolType.localVariable: return SymbolType.defineLocalVariable;
      case SymbolType.globalVariable: return SymbolType.defineGlobalVariable;
      case SymbolType.parameter: return SymbolType.defineParameter;
    }
    return t;
}

export function removeSymbolDefineType(t: SymbolType): SymbolType {
    switch (t) {
      case SymbolType.defineFunc: return SymbolType.func;
      case SymbolType.defineLocalVariable: return SymbolType.localVariable;
      case SymbolType.defineParameter: return SymbolType.parameter;
    }
    return t;
}

export function isSymbolDefineType(t: SymbolType): boolean {
    return t >= SymbolType.defineFunc;
}

/** Information about the definition of a symbol
*/
export class SymbolDefinition implements Equal {
    parameters: SymbolDefinition[];
    localVariables: SymbolDefinition[];

    constructor(
        /** file in which it is defined */
        public document: AWKDocument,
        /** symbol position start */
        public position: Position,
        public type: SymbolType,
        public docComment: string,
        /** the scope in which this symbol is defined; in AWK, it's a function or undefined for global */
        public scope: SymbolDefinition|undefined,
        /** the symbol itself */
        public symbol: string,
        public isImplicitDefinition: boolean
    ) {
    }

    getRange(): Range {
        return getRange(this.position, this.symbol === undefined? 10: this.symbol.length);
    }

    isEqual(p: SymbolDefinition): boolean {
        return this.symbol === p.symbol && this.document === p.document &&
            positionCompare(this.position, p.position) === 0 && this.type === p.type &&
            this.docComment === p.docComment;
    }

}

/** Information about a single symbol usage occurrence in a file
*/
export class SymbolUsage implements Equal {
    constructor(
        /// The symbol itself
        public symbol: string,
        public type: SymbolType,
        /// symbol position start
        public position: Position
    ) {
    }

    isEqual(p: SymbolUsage): boolean {
        return this.symbol === p.symbol && this.type === p.type &&
               positionCompare(this.position, p.position) === 0;
    }

    getRange(): Range {
        return getRange(this.position, this.symbol === undefined? 10: this.symbol.length);
    }
}

export class ParameterUsage implements Equal {
    constructor(
        /// The symbol itself
        public functionName: SymbolUsage,
        /// The parameter index
        public parameterIndex: number,
        /// position in text
        public position: Position,
        /// start or end of parameter
        public start: boolean
    ) {
    }

    isEqual(p: ParameterUsage): boolean {
        return this.functionName.isEqual(p.functionName) &&
               this.parameterIndex === p.parameterIndex &&
               positionCompare(this.position, p.position) === 0 &&
               this.start === p.start;
    }
}
