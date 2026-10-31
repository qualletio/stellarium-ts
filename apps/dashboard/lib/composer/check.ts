import 'server-only';
import { type Expression, maxTokens, parseScript, RequestScriptError, type Script, type Statement } from 'requestscript';
import { type Catalog, type CatalogFunction, findResource } from './catalog';

/** What the Composer learns about a script before proposing it. */
export interface ScriptCheck {
  ok: boolean;
  kind?: 'request' | 'contract';
  /** A contract's dotted path and name, as it would be called. */
  contract?: { path: string; name: string; version: string; hasReturnType: boolean };
  /** Problems that would fail the run or the deploy. Empty when `ok`. */
  problems: string[];
  /** What may fail, depending on the node. */
  warnings: string[];
  /** The most script tokens any run can execute: the node charges for these at its price. */
  maxTokens?: number;
  /** The paid functions the script calls, and what each call costs. */
  paidCalls: { call: string; price: string }[];
}

function describePrice(fn: CatalogFunction): string | undefined {
  const manifest = fn.paymentManifest;
  if (!manifest) return undefined;
  if (manifest.costMicroUsd !== undefined) return `${manifest.costMicroUsd} micro-USD per call`;
  if (manifest.priceMicroUsdPerMillionTokens !== undefined) return `${manifest.priceMicroUsdPerMillionTokens} micro-USD per million contract tokens`;
  return `${manifest.inputCostMicroUsdPerMillionTokens ?? 0} / ${manifest.outputCostMicroUsdPerMillionTokens ?? 0} micro-USD per million input / output tokens`;
}

/** Every call expression in the script, with the scope names bound to resources where it appears. */
function* calls(statements: Statement[]): Generator<Extract<Expression, { kind: 'call' }>> {
  for (const statement of statements) {
    switch (statement.kind) {
      case 'varDecl':
        yield* expressionCalls(statement.value);
        if (statement.state?.scope) yield* expressionCalls(statement.state.scope);
        break;
      case 'assign':
        yield* expressionCalls(statement.target);
        yield* expressionCalls(statement.value);
        break;
      case 'return':
        if (statement.value) yield* expressionCalls(statement.value);
        break;
      case 'exprStmt':
        yield* expressionCalls(statement.expression);
        break;
      case 'if':
        for (const branch of statement.branches) {
          yield* expressionCalls(branch.condition);
          yield* calls(branch.body);
        }
        if (statement.elseBody) yield* calls(statement.elseBody);
        break;
      case 'resourceDecl':
        break;
    }
  }
}

function* expressionCalls(expression: Expression): Generator<Extract<Expression, { kind: 'call' }>> {
  switch (expression.kind) {
    case 'call':
      yield expression;
      for (const argument of expression.args) yield* expressionCalls(argument.value);
      break;
    case 'templateString':
      for (const part of expression.parts) if (part.type === 'expr') yield* expressionCalls(part.expression);
      break;
    case 'objectLiteral':
      for (const entry of expression.entries) yield* expressionCalls(entry.value);
      break;
    case 'listLiteral':
      for (const element of expression.elements) yield* expressionCalls(element);
      break;
    case 'member':
      yield* expressionCalls(expression.object);
      break;
    case 'index':
      yield* expressionCalls(expression.object);
      yield* expressionCalls(expression.index);
      break;
    case 'unary':
      yield* expressionCalls(expression.operand);
      break;
    case 'binary':
      yield* expressionCalls(expression.left);
      yield* expressionCalls(expression.right);
      break;
    default:
      break;
  }
}

function* resourceDecls(statements: Statement[]): Generator<Extract<Statement, { kind: 'resourceDecl' }>> {
  for (const statement of statements) {
    if (statement.kind === 'resourceDecl') yield statement;
    if (statement.kind === 'if') {
      for (const branch of statement.branches) yield* resourceDecls(branch.body);
      if (statement.elseBody) yield* resourceDecls(statement.elseBody);
    }
  }
}

/**
 * Parses the script and checks what can be checked without running it: the declaration, that every resource
 * exists in the node's catalog, and that every call names one of its functions with exactly its parameters.
 * Types are only checked when the script runs.
 */
export function checkScript(source: string, catalog: Catalog): ScriptCheck {
  let script: Script;
  try {
    script = parseScript(source);
  } catch (error) {
    if (error instanceof RequestScriptError) {
      // Parse errors already name their line.
      const where = error.line === undefined || error.message.includes(`line ${error.line}`) ? '' : ` (line ${error.line}${error.column === undefined ? '' : `, column ${error.column}`})`;
      return { ok: false, problems: [`${error.name}: ${error.message}${where}`], warnings: [], paidCalls: [] };
    }
    throw error;
  }

  const problems: string[] = [];
  const declaration = script.declaration;
  const result: ScriptCheck = { ok: false, kind: declaration.kind, problems, warnings: [], maxTokens: maxTokens(script), paidCalls: [] };
  if (declaration.kind === 'contract') {
    result.contract = { path: declaration.path.join('.'), name: declaration.name, version: declaration.version, hasReturnType: declaration.returnType !== undefined };
    if (declaration.path.length === 0) problems.push('A contract deployed to a node needs a dotted path before its name, such as `com.example.Name`.');
    if (!declaration.returnType) problems.push('A contract deployed to a node needs a return type, such as `: int32` after its parameters.');
    if (findResource(catalog, declaration.path.join('.'), declaration.name)) {
      problems.push(`${declaration.path.join('.')}.${declaration.name} already exists on this node. Deploy a new version with \`@<version>\` only if your organization owns it; otherwise choose another path.`);
    }
  }

  const bound = new Map<string, ReturnType<typeof findResource>>();
  for (const decl of resourceDecls(script.body)) {
    const resource = findResource(catalog, decl.resourcePath.join('.'), decl.resourceName);
    if (!resource) problems.push(`Line ${decl.line}: ${[...decl.resourcePath, decl.resourceName].join('.')} is not a resource this node knows.`);
    bound.set(decl.name, resource);
  }

  for (const call of calls(script.body)) {
    const target = call.callee.object;
    if (target.kind !== 'identifier' || !bound.has(target.name)) {
      problems.push(`Line ${call.line}: only a resource bound with \`const name: path.Resource\` can be called.`);
      continue;
    }
    const resource = bound.get(target.name);
    if (!resource) continue;
    const fn = resource.functions.find((candidate) => candidate.name === call.callee.property);
    if (!fn) {
      problems.push(`Line ${call.line}: ${resource.path}.${resource.name} has no function ${call.callee.property}. It has ${resource.functions.map((f) => f.name).join(', ')}.`);
      continue;
    }
    const passed = call.args.map((argument) => argument.name);
    const declared = fn.parameters.map((parameter) => parameter.name);
    const missing = declared.filter((name) => !passed.includes(name));
    const unknown = passed.filter((name) => !declared.includes(name));
    if (missing.length > 0) problems.push(`Line ${call.line}: ${fn.name} needs ${missing.join(', ')}.`);
    if (unknown.length > 0) problems.push(`Line ${call.line}: ${fn.name} has no parameter ${unknown.join(', ')}.`);
    if (fn.restricted) result.warnings.push(`Line ${call.line}: ${resource.path}.${resource.name}.${fn.name} is restricted and needs a grant the node may not hold.`);
    const price = describePrice(fn);
    if (price) result.paidCalls.push({ call: `${resource.path}.${resource.name}.${fn.name} (line ${call.line})`, price });
  }

  result.ok = problems.length === 0;
  return result;
}
