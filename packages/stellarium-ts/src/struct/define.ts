import { parseTypeString } from "requestscript";
import type { StructField } from "./types.js";

/** A struct defined in TypeScript, for a node to declare when it starts and its resource functions to name. */
export interface HostStruct {
    path: string;
    name: string;
    version: string;
    fields: StructField[];
    /** The struct's type string, `path.Name@version`, for parameter and return types and other structs' fields. */
    readonly type: string;
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const VERSION = /^\d+(\.\d+)*$/;

/**
 * Defines a struct: `defineStruct('com.example.Forecast', 1, { city: 'string', highs: '[]decimal' })`. Field
 * types are RequestScript type strings, and a field that is another struct names its version, by its `.type`
 * (`Address.type`) or as `'com.example.Address@1'`. Register it with `StellariumNode.registerStruct`, and the
 * node declares it as its organization's when it starts. Throws on an invalid name, version or type.
 */
export function defineStruct(qualifiedName: string, version: number | string, fields: Record<string, string>): HostStruct {
    const segments = qualifiedName.split('.');
    if (segments.length < 2 || !segments.every(segment => IDENTIFIER.test(segment))) {
        throw new Error(`Invalid struct name '${qualifiedName}': give it a path, such as com.example.Name`);
    }
    const versionString = String(version);
    if (!VERSION.test(versionString)) {
        throw new Error(`Invalid version '${versionString}' for struct ${qualifiedName}: use dot-separated numbers, such as 1 or 1.2`);
    }
    const name = segments.pop()!;
    const path = segments.join('.');
    const type = `${qualifiedName}@${versionString}`;
    const fieldList = Object.entries(fields).map(([fieldName, fieldType]) => {
        if (!IDENTIFIER.test(fieldName)) {
            throw new Error(`Invalid field name '${fieldName}' in struct ${type}`);
        }
        try {
            parseTypeString(fieldType);
        } catch {
            throw new Error(`Invalid type '${fieldType}' for field '${fieldName}' of struct ${type}: a struct type names its version, such as com.example.Name@1`);
        }
        if (fieldType === type || fieldType.endsWith(`]${type}`)) {
            throw new Error(`Struct ${type} can't contain itself, as field '${fieldName}' does`);
        }
        return { name: fieldName, type: fieldType };
    });
    if (fieldList.length === 0) {
        throw new Error(`Struct ${type} must declare its fields`);
    }
    return { path, name, version: versionString, fields: fieldList, type };
}
