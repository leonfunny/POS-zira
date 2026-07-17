#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import ts from 'typescript';

const NODE_BUILTINS = new Set(
  builtinModules.flatMap((name) => {
    const bare = name.replace(/^node:/, '');
    return [bare, `node:${bare}`];
  }),
);
const WINDOWS_NATIVE_PACKAGES = new Set([
  'serialport',
  'usb',
  'node-hid',
  'ffi-napi',
  'ref-napi',
  '@serialport/bindings-cpp',
  '@nut-tree-fork/nut-js',
]);
const INTERNAL_ALIAS_PREFIXES = ['@/', '@main/', '@shared/', '@renderer/'];
const TOP_LEVEL_EFFECT_GLOBALS = new Set([
  'fetch',
  'setInterval',
  'setTimeout',
  'queueMicrotask',
]);
const TOP_LEVEL_EFFECT_CONSTRUCTORS = new Set([
  'EventSource',
  'WebSocket',
  'Worker',
  'SharedWorker',
]);
const TOP_LEVEL_EFFECT_OBJECTS = new Set([
  'document',
  'electronAPI',
  'indexedDB',
  'localStorage',
  'navigator',
  'sessionStorage',
  'window',
]);
const GLOBAL_NAMESPACE_IDENTIFIERS = new Set(['globalThis', 'self', 'window']);
const FORBIDDEN_NODE_GLOBAL_MEMBERS = new Set([
  'Buffer',
  '__dirname',
  '__filename',
  'exports',
  'global',
  'module',
  'process',
  'require',
]);

function packageName(specifier) {
  if (specifier.startsWith('@')) return specifier.split('/').slice(0, 2).join('/');
  return specifier.split('/')[0];
}

function isNodeBuiltin(specifier) {
  if (specifier.startsWith('node:')) return true;
  if (NODE_BUILTINS.has(specifier)) return true;
  return NODE_BUILTINS.has(specifier.split('/')[0]);
}

function isElectronPackage(specifier) {
  return specifier === 'electron'
    || specifier.startsWith('electron/')
    || specifier.startsWith('electron-');
}

function isCapacitorPackage(specifier) {
  return specifier === '@capacitor/core' || specifier.startsWith('@capacitor/');
}

function isWindowsNativePackage(specifier) {
  return WINDOWS_NATIVE_PACKAGES.has(packageName(specifier))
    || specifier.startsWith('@serialport/');
}

function isLocalSpecifier(specifier) {
  return specifier.startsWith('.') || isAbsolute(specifier);
}

function relativeDisplay(root, file) {
  const value = relative(root, file) || '.';
  return value.split(sep).join('/');
}

function insideRoot(root, target) {
  const value = relative(root, target);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function nodeLocation(sourceFile, node) {
  const start = node.getStart(sourceFile, false);
  const position = sourceFile.getLineAndCharacterOfPosition(start);
  return {
    line: position.line + 1,
    column: position.character + 1,
    offset: start,
  };
}

function unwrapExpression(node) {
  let current = node;
  while (
    ts.isParenthesizedExpression(current)
    || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

function staticStringValue(node) {
  if (!node) return null;
  const expression = unwrapExpression(node);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (
    ts.isBinaryExpression(expression)
    && expression.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticStringValue(expression.left);
    const right = staticStringValue(expression.right);
    return left === null || right === null ? null : `${left}${right}`;
  }
  if (ts.isTemplateExpression(expression)) {
    let value = expression.head.text;
    for (const span of expression.templateSpans) {
      const part = staticStringValue(span.expression);
      if (part === null) return null;
      value += part + span.literal.text;
    }
    return value;
  }
  return null;
}

function rootIdentifier(expression) {
  let current = unwrapExpression(expression);
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = unwrapExpression(current.expression);
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function globalNamespaceAccess(node, namespaceAliases) {
  if (ts.isPropertyAccessExpression(node)) {
    const namespace = unwrapExpression(node.expression);
    if (ts.isIdentifier(namespace) && namespaceAliases.has(namespace.text)) {
      return { namespace: namespace.text, namespaceNode: namespace, member: node.name.text };
    }
  }
  if (ts.isElementAccessExpression(node)) {
    const namespace = unwrapExpression(node.expression);
    const member = staticStringValue(node.argumentExpression);
    if (
      ts.isIdentifier(namespace)
      && namespaceAliases.has(namespace.text)
      && member !== null
    ) {
      return { namespace: namespace.text, namespaceNode: namespace, member };
    }
  }
  return null;
}

function hasStaticModifier(node) {
  return Boolean(node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword));
}

function topLevelCallableBindings(sourceFile) {
  const bindings = new Map();

  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.set(statement.name.text, statement);
      continue;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      const initializer = unwrapExpression(declaration.initializer);
      if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
        bindings.set(declaration.name.text, initializer);
      }
    }
  }

  return bindings;
}

function topLevelGlobalNamespaceAliases(sourceFile) {
  const aliases = new Set(GLOBAL_NAMESPACE_IDENTIFIERS);
  let changed = true;

  while (changed) {
    changed = false;
    for (const statement of sourceFile.statements) {
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
        const initializer = unwrapExpression(declaration.initializer);
        if (
          ts.isIdentifier(initializer)
          && aliases.has(initializer.text)
          && !aliases.has(declaration.name.text)
        ) {
          aliases.add(declaration.name.text);
          changed = true;
        }
      }
    }
  }

  return aliases;
}

function unsafeTopLevelEffect(statement, callableBindings) {
  let violation = null;
  const executingFunctions = new Set();

  const visitExecutedFunction = (node) => {
    if (executingFunctions.has(node)) return;
    executingFunctions.add(node);
    for (const parameter of node.parameters) {
      if (parameter.initializer) visit(parameter.initializer);
    }
    if (node.body) visit(node.body);
    executingFunctions.delete(node);
  };

  const visit = (node) => {
    if (violation) return;
    if (ts.isDecorator(node)) {
      violation = {
        node,
        rule: 'UNVERIFIED_TOP_LEVEL_DECORATOR',
        detail: `unverified decorator application @${node.expression.getText()}`,
      };
      return;
    }
    if (node === statement && ts.isFunctionLike(node)) return;
    if (node !== statement && ts.isFunctionLike(node)) {
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
      for (const decorator of decorators) visit(decorator);
      for (const parameter of node.parameters) {
        const parameterDecorators = ts.canHaveDecorators(parameter)
          ? ts.getDecorators(parameter) || []
          : [];
        for (const decorator of parameterDecorators) visit(decorator);
      }
      if (node.name && ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      return;
    }

    if (ts.isClassLike(node)) {
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
      for (const decorator of decorators) visit(decorator);
      if (violation) return;
    }

    if (ts.isPropertyDeclaration(node) && !hasStaticModifier(node)) {
      const decorators = ts.canHaveDecorators(node) ? ts.getDecorators(node) || [] : [];
      for (const decorator of decorators) visit(decorator);
      if (ts.isComputedPropertyName(node.name)) visit(node.name.expression);
      return;
    }

    if (ts.isAwaitExpression(node)) {
      violation = { node, detail: 'top-level await' };
      return;
    }

    if (ts.isCallExpression(node)) {
      const callee = unwrapExpression(node.expression);
      if (ts.isIdentifier(callee) && TOP_LEVEL_EFFECT_GLOBALS.has(callee.text)) {
        violation = { node, detail: `top-level ${callee.text}()` };
        return;
      }
      const root = rootIdentifier(callee);
      if (root && TOP_LEVEL_EFFECT_OBJECTS.has(root)) {
        violation = { node, detail: `top-level call through ${root}` };
        return;
      }
      if (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee)) {
        visitExecutedFunction(callee);
      } else if (ts.isIdentifier(callee)) {
        const callable = callableBindings.get(callee.text);
        if (callable) {
          visitExecutedFunction(callable);
        } else {
          violation = {
            node,
            rule: 'UNVERIFIED_TOP_LEVEL_CALL',
            detail: `unverified top-level call ${callee.text}()`,
          };
          return;
        }
      } else {
        violation = {
          node,
          rule: 'UNVERIFIED_TOP_LEVEL_CALL',
          detail: `unverified top-level member or computed call ${callee.getText()}`,
        };
        return;
      }
    }

    if (ts.isNewExpression(node)) {
      const constructor = unwrapExpression(node.expression);
      if (ts.isIdentifier(constructor) && TOP_LEVEL_EFFECT_CONSTRUCTORS.has(constructor.text)) {
        violation = { node, detail: `top-level new ${constructor.text}()` };
        return;
      }
      if (ts.isIdentifier(constructor)) {
        violation = {
          node,
          rule: 'UNVERIFIED_TOP_LEVEL_CONSTRUCTION',
          detail: `unverified top-level construction new ${constructor.text}()`,
        };
        return;
      }
      violation = {
        node,
        rule: 'UNVERIFIED_TOP_LEVEL_CONSTRUCTION',
        detail: `unverified top-level construction new ${constructor.getText()}()`,
      };
      return;
    }

    if (ts.isTaggedTemplateExpression(node)) {
      violation = {
        node,
        rule: 'UNVERIFIED_TOP_LEVEL_TAGGED_TEMPLATE',
        detail: `unverified top-level tagged template invocation ${node.tag.getText()}`,
      };
      return;
    }

    if (
      ts.isBinaryExpression(node)
      && ts.isAssignmentOperator(node.operatorToken.kind)
    ) {
      const root = rootIdentifier(node.left);
      if (root && TOP_LEVEL_EFFECT_OBJECTS.has(root)) {
        violation = { node, detail: `top-level assignment through ${root}` };
        return;
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(statement);
  return violation;
}

function isDeclarationOrPropertyName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (
    (ts.isPropertyAccessExpression(parent) && parent.name === node)
    || (ts.isPropertyAssignment(parent) && parent.name === node)
    || (ts.isMethodDeclaration(parent) && parent.name === node)
    || (ts.isPropertyDeclaration(parent) && parent.name === node)
    || (ts.isPropertySignature(parent) && parent.name === node)
    || (ts.isMethodSignature(parent) && parent.name === node)
    || (ts.isImportSpecifier(parent))
    || (ts.isExportSpecifier(parent))
    || (ts.isImportClause(parent))
    || (ts.isNamespaceImport(parent))
    || (ts.isTypeReferenceNode(parent))
    || (ts.isInterfaceDeclaration(parent))
    || (ts.isTypeAliasDeclaration(parent))
  ) return true;

  return (
    (ts.isVariableDeclaration(parent)
      || ts.isParameter(parent)
      || ts.isFunctionDeclaration(parent)
      || ts.isFunctionExpression(parent)
      || ts.isClassDeclaration(parent)
      || ts.isClassExpression(parent))
    && parent.name === node
  );
}

function bindingNameContains(name, expected) {
  if (ts.isIdentifier(name)) return name.text === expected;
  return name.elements.some((element) => (
    !ts.isOmittedExpression(element) && bindingNameContains(element.name, expected)
  ));
}

function importDeclaresName(statement, expected) {
  if (!ts.isImportDeclaration(statement) || !statement.importClause) return false;
  if (statement.importClause.name?.text === expected) return true;
  const bindings = statement.importClause.namedBindings;
  if (bindings && ts.isNamespaceImport(bindings)) return bindings.name.text === expected;
  return Boolean(bindings && bindings.elements.some((element) => element.name.text === expected));
}

function statementDeclaresName(statement, expected) {
  if (ts.isVariableStatement(statement)) {
    return statement.declarationList.declarations.some((declaration) => (
      bindingNameContains(declaration.name, expected)
    ));
  }
  if (
    (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
    && statement.name?.text === expected
  ) return true;
  return importDeclaresName(statement, expected);
}

function isLexicallyShadowed(node) {
  const expected = node.text;
  let current = node.parent;
  while (current) {
    if (
      ts.isFunctionLike(current)
      && current.parameters.some((parameter) => bindingNameContains(parameter.name, expected))
    ) return true;
    if (
      ts.isCatchClause(current)
      && current.variableDeclaration
      && bindingNameContains(current.variableDeclaration.name, expected)
    ) return true;
    if (
      (ts.isBlock(current) || ts.isSourceFile(current))
      && current.statements.some((statement) => statementDeclaresName(statement, expected))
    ) return true;
    current = current.parent;
  }
  return false;
}

function isNestedLexicallyShadowed(node, expected) {
  let current = node.parent;
  while (current && !ts.isSourceFile(current)) {
    if (
      ts.isFunctionLike(current)
      && current.parameters.some((parameter) => bindingNameContains(parameter.name, expected))
    ) return true;
    if (
      ts.isCatchClause(current)
      && current.variableDeclaration
      && bindingNameContains(current.variableDeclaration.name, expected)
    ) return true;
    if (
      ts.isBlock(current)
      && current.statements.some((statement) => statementDeclaresName(statement, expected))
    ) return true;
    current = current.parent;
  }
  return false;
}

function bindingElementMember(element) {
  const property = element.propertyName || element.name;
  if (ts.isIdentifier(property) || ts.isStringLiteralLike(property)) return property.text;
  return null;
}

function directUsageViolations(sourceFile) {
  const violations = [];
  const identityOffsets = new Set();
  const namespaceAliases = topLevelGlobalNamespaceAliases(sourceFile);

  const addIdentityViolation = (node, value) => {
    const normalized = value.toLowerCase();
    if (
      normalized.startsWith('x-print-agent-')
      || normalized.includes('/print-agent/')
      || normalized.includes('pa_')
    ) {
      const offset = node.getStart(sourceFile, false);
      if (identityOffsets.has(offset)) return;
      identityOffsets.add(offset);
      violations.push({
        rule: 'FORBIDDEN_PRINT_AGENT_IDENTITY',
        node,
        message: `Print-agent identity/execution literal "${value}" is forbidden in Android/shared core`,
      });
    }
  };

  const visit = (node) => {
    if (ts.isExpression(node)) {
      const value = staticStringValue(node);
      if (value !== null) addIdentityViolation(node, value);
    }

    if (
      ts.isIdentifier(node)
      && !isDeclarationOrPropertyName(node)
      && !isLexicallyShadowed(node)
    ) {
      if (node.text === 'electronAPI') {
        violations.push({
          rule: 'FORBIDDEN_ELECTRON_API_GLOBAL',
          node,
          message: 'Bare electronAPI is forbidden in cross-platform core',
        });
      } else if (GLOBAL_NAMESPACE_IDENTIFIERS.has(node.text)) {
        violations.push({
          rule: 'FORBIDDEN_GLOBAL_NAMESPACE',
          node,
          message: `Global namespace "${node.text}" is forbidden in cross-platform core`,
        });
      } else if (FORBIDDEN_NODE_GLOBAL_MEMBERS.has(node.text)) {
        violations.push({
          rule: 'FORBIDDEN_NODE_GLOBAL',
          node,
          message: `Node global "${node.text}" is forbidden in cross-platform core`,
        });
      }
    }

    if (
      ts.isVariableDeclaration(node)
      && ts.isObjectBindingPattern(node.name)
      && node.initializer
    ) {
      const namespace = unwrapExpression(node.initializer);
      if (
        ts.isIdentifier(namespace)
        && namespaceAliases.has(namespace.text)
        && !isNestedLexicallyShadowed(namespace, namespace.text)
      ) {
        for (const element of node.name.elements) {
          const member = bindingElementMember(element);
          if (member === 'electronAPI') {
            violations.push({
              rule: 'FORBIDDEN_ELECTRON_API_GLOBAL',
              node: element,
              message: `Destructuring ${namespace.text}.${member} is forbidden in cross-platform core`,
            });
          } else if (member && FORBIDDEN_NODE_GLOBAL_MEMBERS.has(member)) {
            violations.push({
              rule: 'FORBIDDEN_NODE_GLOBAL',
              node: element,
              message: `Destructuring Node global escape ${namespace.text}.${member} is forbidden in cross-platform core`,
            });
          }
        }
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const access = globalNamespaceAccess(node, namespaceAliases);
      if (access && isNestedLexicallyShadowed(access.namespaceNode, access.namespace)) {
        ts.forEachChild(node, visit);
        return;
      }
      if (access?.member === 'electronAPI') {
        violations.push({
          rule: 'FORBIDDEN_ELECTRON_API_GLOBAL',
          node,
          message: `${access.namespace}.${access.member} is forbidden in cross-platform core`,
        });
      } else if (access && FORBIDDEN_NODE_GLOBAL_MEMBERS.has(access.member)) {
        violations.push({
          rule: 'FORBIDDEN_NODE_GLOBAL',
          node,
          message: `Node global escape ${access.namespace}.${access.member} is forbidden in cross-platform core`,
        });
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  const callableBindings = topLevelCallableBindings(sourceFile);
  for (const statement of sourceFile.statements) {
    const effect = unsafeTopLevelEffect(statement, callableBindings);
    if (effect) {
      violations.push({
        rule: effect.rule || 'FORBIDDEN_TOP_LEVEL_SIDE_EFFECT',
        node: effect.node,
        message: `Unsafe platform side effect is forbidden at module load: ${effect.detail}`,
      });
    }
  }
  return violations;
}

function moduleReferences(sourceFile) {
  const references = [];

  const add = (node, expression, syntax) => {
    const specifier = staticStringValue(expression);
    references.push({
      node: expression || node,
      specifier,
      syntax,
      nonStatic: specifier === null,
    });
  };

  const visit = (node) => {
    if (ts.isImportDeclaration(node)) {
      add(node, node.moduleSpecifier, 'import');
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      add(node, node.moduleSpecifier, 'export');
    } else if (
      ts.isImportEqualsDeclaration(node)
      && ts.isExternalModuleReference(node.moduleReference)
    ) {
      add(node, node.moduleReference.expression, 'import equals');
    } else if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node, node.arguments[0], 'dynamic import');
      } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        add(node, node.arguments[0], 'require');
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  const seen = new Set();
  return references.filter((reference) => {
    const key = `${reference.node.getStart(sourceFile, false)}:${reference.syntax}:${reference.specifier}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function loadTsConfig(searchFrom, explicitPath) {
  const configPath = explicitPath
    ? resolve(explicitPath)
    : ts.findConfigFile(searchFrom, ts.sys.fileExists, 'tsconfig.json');
  if (!configPath) return { configPath: null, options: {}, aliasPatterns: [] };

  const readResult = ts.readConfigFile(configPath, ts.sys.readFile);
  if (readResult.error) {
    throw new Error(ts.flattenDiagnosticMessageText(readResult.error.messageText, '\n'));
  }
  const parsed = ts.parseJsonConfigFileContent(
    readResult.config,
    ts.sys,
    dirname(configPath),
    undefined,
    configPath,
  );
  if (parsed.errors.length > 0) {
    throw new Error(parsed.errors.map((error) => (
      ts.flattenDiagnosticMessageText(error.messageText, '\n')
    )).join('\n'));
  }
  return {
    configPath,
    options: parsed.options,
    aliasPatterns: Object.keys(parsed.options.paths || {}),
  };
}

function aliasPatternMatches(pattern, specifier) {
  const star = pattern.indexOf('*');
  if (star === -1) return pattern === specifier;
  return specifier.startsWith(pattern.slice(0, star)) && specifier.endsWith(pattern.slice(star + 1));
}

function isInternalAlias(specifier, aliasPatterns) {
  return aliasPatterns.some((pattern) => aliasPatternMatches(pattern, specifier))
    || INTERNAL_ALIAS_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

function resolveModule(importer, specifier, compilerOptions) {
  const result = ts.resolveModuleName(specifier, importer, compilerOptions, ts.sys);
  const file = result.resolvedModule?.resolvedFileName;
  if (!file || file.includes(`${sep}node_modules${sep}`)) return null;
  return resolve(file);
}

function isForbiddenPlatformPath(file) {
  const normalized = file.split(sep).join('/');
  return normalized.includes('/src/main/') || normalized.includes('/src/preload/');
}

function diagnosticKey(diagnostic) {
  return `${diagnostic.rule}:${diagnostic.file}:${diagnostic.offset}:${diagnostic.message}`;
}

export async function verifyCrossPlatformBoundaries({
  entries,
  root = process.cwd(),
  tsconfigPath,
  allowedPackages = [],
}) {
  const absoluteRoot = resolve(root);
  const entryFiles = entries.map((entry) => resolve(entry));
  const config = loadTsConfig(dirname(entryFiles[0] || absoluteRoot), tsconfigPath);
  const allowedPackageSet = new Set(allowedPackages);
  const diagnostics = [];
  const diagnosticKeys = new Set();
  const visited = new Set();

  const addDiagnostic = (diagnostic) => {
    const key = diagnosticKey(diagnostic);
    if (diagnosticKeys.has(key)) return;
    diagnosticKeys.add(key);
    diagnostics.push(diagnostic);
  };

  const visit = async (file, chain) => {
    const absoluteFile = resolve(file);
    if (visited.has(absoluteFile)) return;
    visited.add(absoluteFile);

    let source;
    try {
      source = await readFile(absoluteFile, 'utf8');
    } catch (error) {
      addDiagnostic({
        rule: 'UNREADABLE_ENTRY',
        file: absoluteFile,
        line: 1,
        column: 1,
        offset: 0,
        message: `Cannot read source: ${error?.message || String(error)}`,
        chain,
      });
      return;
    }

    const sourceFile = ts.createSourceFile(
      absoluteFile,
      source,
      ts.ScriptTarget.Latest,
      true,
      absoluteFile.endsWith('.tsx') || absoluteFile.endsWith('.jsx')
        ? ts.ScriptKind.TSX
        : ts.ScriptKind.TS,
    );

    for (const error of sourceFile.parseDiagnostics || []) {
      const start = error.start || 0;
      const position = sourceFile.getLineAndCharacterOfPosition(start);
      addDiagnostic({
        rule: 'SOURCE_PARSE_ERROR',
        file: absoluteFile,
        line: position.line + 1,
        column: position.character + 1,
        offset: start,
        message: ts.flattenDiagnosticMessageText(error.messageText, '\n'),
        chain,
      });
    }

    for (const violation of directUsageViolations(sourceFile)) {
      addDiagnostic({
        rule: violation.rule,
        file: absoluteFile,
        ...nodeLocation(sourceFile, violation.node),
        message: violation.message,
        chain,
      });
    }

    for (const reference of moduleReferences(sourceFile)) {
      const location = nodeLocation(sourceFile, reference.node);
      const baseDiagnostic = { file: absoluteFile, ...location, chain };
      if (reference.nonStatic) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'NON_STATIC_MODULE_SPECIFIER',
          message: `${reference.syntax} must use a statically resolvable string literal`,
        });
        continue;
      }

      const specifier = reference.specifier;
      if (isElectronPackage(specifier)) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'FORBIDDEN_ELECTRON_IMPORT',
          message: `${reference.syntax} of Electron package "${specifier}" is forbidden`,
        });
        continue;
      }
      if (isNodeBuiltin(specifier)) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'FORBIDDEN_NODE_BUILTIN',
          message: `${reference.syntax} of Node builtin "${specifier}" is forbidden`,
        });
        continue;
      }
      if (isCapacitorPackage(specifier)) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'FORBIDDEN_CAPACITOR_IMPORT',
          message: `${reference.syntax} of Capacitor package "${specifier}" is forbidden; use a platform port`,
        });
        continue;
      }
      if (isWindowsNativePackage(specifier)) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'FORBIDDEN_WINDOWS_NATIVE_PACKAGE',
          message: `${reference.syntax} of Windows/native package "${specifier}" is forbidden`,
        });
        continue;
      }

      const internalAlias = isInternalAlias(specifier, config.aliasPatterns);
      if (!isLocalSpecifier(specifier) && !internalAlias) {
        const dependency = packageName(specifier);
        if (!allowedPackageSet.has(dependency)) {
          addDiagnostic({
            ...baseDiagnostic,
            rule: 'NON_ALLOWLISTED_BARE_PACKAGE',
            message: `Bare package "${specifier}" is not allowlisted for cross-platform core`,
          });
        }
        continue;
      }

      const resolvedImport = resolveModule(absoluteFile, specifier, config.options);
      if (!resolvedImport) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: internalAlias ? 'UNRESOLVED_INTERNAL_ALIAS' : 'UNRESOLVED_LOCAL_IMPORT',
          message: `Cannot resolve ${reference.syntax} "${specifier}" using ${config.configPath || 'default TypeScript resolution'}`,
        });
        continue;
      }
      if (isForbiddenPlatformPath(resolvedImport)) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'FORBIDDEN_MAIN_PROCESS_IMPORT',
          message: `Import resolves to a main/preload module: ${relativeDisplay(absoluteRoot, resolvedImport)}`,
        });
        continue;
      }
      if (!insideRoot(absoluteRoot, resolvedImport)) {
        addDiagnostic({
          ...baseDiagnostic,
          rule: 'IMPORT_OUTSIDE_BOUNDARY_ROOT',
          message: `Local/aliased import escapes boundary root: ${relativeDisplay(absoluteRoot, resolvedImport)}`,
        });
        continue;
      }
      await visit(resolvedImport, [...chain, resolvedImport]);
    }
  };

  for (const entry of entryFiles) {
    if (!insideRoot(absoluteRoot, entry)) {
      addDiagnostic({
        rule: 'ENTRY_OUTSIDE_BOUNDARY_ROOT',
        file: entry,
        line: 1,
        column: 1,
        offset: 0,
        message: `Entry is outside boundary root: ${entry}`,
        chain: [entry],
      });
      continue;
    }
    await visit(entry, [entry]);
  }

  diagnostics.sort((left, right) => (
    left.file.localeCompare(right.file)
    || left.line - right.line
    || left.column - right.column
    || left.rule.localeCompare(right.rule)
  ));

  return {
    ok: diagnostics.length === 0,
    root: absoluteRoot,
    entries: entryFiles,
    tsconfigPath: config.configPath,
    visitedFiles: [...visited].sort(),
    diagnostics,
  };
}

export function formatBoundaryResult(result) {
  if (result.ok) {
    return `PASS cross-platform boundaries: ${result.visitedFiles.length} file(s) scanned from ${result.entries.length} entry point(s)`;
  }
  const lines = [
    `FAIL cross-platform boundaries: ${result.diagnostics.length} violation(s) in ${result.visitedFiles.length} scanned file(s)`,
  ];
  for (const diagnostic of result.diagnostics) {
    lines.push(
      `[${diagnostic.rule}] ${relativeDisplay(result.root, diagnostic.file)}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
    );
    lines.push(`  import chain: ${diagnostic.chain.map((file) => relativeDisplay(result.root, file)).join(' -> ')}`);
  }
  return lines.join('\n');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/verify-cross-platform-boundaries.mjs --root <boundary-root> --entry <entry.ts> [options]',
    '',
    'Options:',
    '  --entry <file>          Repeat for every application entry point',
    '  --tsconfig <file>       TypeScript config used for aliases/module resolution',
    '  --allow-package <name>  Repeat for reviewed cross-platform bare packages',
  ].join('\n');
}

function parseCliArgs(argv) {
  const entries = [];
  const allowedPackages = [];
  let root = process.cwd();
  let tsconfigPath;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--entry') {
      if (!argv[index + 1]) throw new Error('--entry requires a path');
      entries.push(argv[index + 1]);
      index += 1;
    } else if (argument === '--root') {
      if (!argv[index + 1]) throw new Error('--root requires a path');
      root = argv[index + 1];
      index += 1;
    } else if (argument === '--tsconfig') {
      if (!argv[index + 1]) throw new Error('--tsconfig requires a path');
      tsconfigPath = argv[index + 1];
      index += 1;
    } else if (argument === '--allow-package') {
      if (!argv[index + 1]) throw new Error('--allow-package requires a package name');
      allowedPackages.push(argv[index + 1]);
      index += 1;
    } else if (argument === '--help' || argument === '-h') {
      return { help: true, entries, root, tsconfigPath, allowedPackages };
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (entries.length === 0) throw new Error('At least one --entry is required');
  return { help: false, entries, root, tsconfigPath, allowedPackages };
}

const invokedAsScript = process.argv[1]
  && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;

if (invokedAsScript) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      console.log(usage());
    } else {
      const result = await verifyCrossPlatformBoundaries(options);
      const output = formatBoundaryResult(result);
      (result.ok ? console.log : console.error)(output);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    console.error(`Boundary verifier configuration error: ${error?.message || String(error)}`);
    console.error(usage());
    process.exitCode = 2;
  }
}
