/**
 * @filedescription Object Schema
 */

"use strict";

//-----------------------------------------------------------------------------
// Imports
//-----------------------------------------------------------------------------

//-----------------------------------------------------------------------------
// Types
//-----------------------------------------------------------------------------

/** @typedef {import("./types.ts").FixupRuleDefinition} FixupRuleDefinition */
/** @typedef {import("./types.ts").FixupLegacyRuleDefinition} FixupLegacyRuleDefinition */
/** @typedef {import("./types.ts").FixupPluginDefinition} FixupPluginDefinition */
/** @typedef {import("./types.ts").FixupConfig} FixupConfig */
/** @typedef {import("./types.ts").FixupConfigArray} FixupConfigArray */

//-----------------------------------------------------------------------------
// Data
//-----------------------------------------------------------------------------

/**
 * The removed methods from the `context` object that need to be added back.
 * The keys are the name of the method on the `context` object and the values
 * are the name of the method on the `sourceCode` object.
 * @type {Map<string, string>}
 */
const removedMethodNames = new Map([
	["getSource", "getText"],
	["getSourceLines", "getLines"],
	["getAllComments", "getAllComments"],
	["getNodeByRangeIndex", "getNodeByRangeIndex"],
	["getCommentsBefore", "getCommentsBefore"],
	["getCommentsAfter", "getCommentsAfter"],
	["getCommentsInside", "getCommentsInside"],
	["getJSDocComment", "getJSDocComment"],
	["getFirstToken", "getFirstToken"],
	["getFirstTokens", "getFirstTokens"],
	["getLastToken", "getLastToken"],
	["getLastTokens", "getLastTokens"],
	["getTokenAfter", "getTokenAfter"],
	["getTokenBefore", "getTokenBefore"],
	["getTokenByRangeStart", "getTokenByRangeStart"],
	["getTokens", "getTokens"],
	["getTokensAfter", "getTokensAfter"],
	["getTokensBefore", "getTokensBefore"],
	["getTokensBetween", "getTokensBetween"],
]);

/**
 * Tracks the original rule definition and the fixed-up rule definition.
 * @type {WeakMap<FixupRuleDefinition|FixupLegacyRuleDefinition,FixupRuleDefinition>}
 */
const fixedUpRuleReplacements = new WeakMap();

/**
 * Tracks all of the fixed up rule definitions so we don't duplicate effort.
 * @type {WeakSet<FixupRuleDefinition>}
 */
const fixedUpRules = new WeakSet();

/**
 * Tracks the original plugin definition and the fixed-up plugin definition.
 * @type {WeakMap<FixupPluginDefinition,FixupPluginDefinition>}
 */
const fixedUpPluginReplacements = new WeakMap();

/**
 * Tracks all of the fixed up plugin definitions so we don't duplicate effort.
 * @type {WeakSet<FixupPluginDefinition>}
 */
const fixedUpPlugins = new WeakSet();

//-----------------------------------------------------------------------------
// Exports
//-----------------------------------------------------------------------------

/**
 * Takes the given rule and creates a new rule with the `create()` method wrapped
 * to provide the missing methods on the `context` object.
 * @param {FixupRuleDefinition|FixupLegacyRuleDefinition} ruleDefinition The rule to fix up.
 * @returns {FixupRuleDefinition} The fixed-up rule.
 */
export function fixupRule(ruleDefinition) {
	// first check if we've already fixed up this rule
	if (fixedUpRuleReplacements.has(ruleDefinition)) {
		return fixedUpRuleReplacements.get(ruleDefinition);
	}

	const isLegacyRule = typeof ruleDefinition === "function";

	// check to see if this rule definition has already been fixed up
	if (!isLegacyRule && fixedUpRules.has(ruleDefinition)) {
		return ruleDefinition;
	}

	const originalCreate = isLegacyRule
		? ruleDefinition
		: ruleDefinition.create.bind(ruleDefinition);

	const ruleCreate = context => {
		// if getScope is already there then no need to create old methods
		if ("getScope" in context) {
			return originalCreate(context);
		}

		const sourceCode = context.sourceCode;
		let currentNode = sourceCode.ast;

		const newContext = Object.assign(Object.create(context), {
			parserServices: sourceCode.parserServices,

			/*
			 * The following methods rely on the current node in the traversal,
			 * so we need to add them manually.
			 */
			getScope() {
				return sourceCode.getScope(currentNode);
			},

			getAncestors() {
				return sourceCode.getAncestors(currentNode);
			},

			getDeclaredVariables() {
				return sourceCode.getDeclaredVariables(currentNode);
			},

			markVariableAsUsed(variable) {
				sourceCode.markVariableAsUsed(variable, currentNode);
			},
		});

		// add passthrough methods
		for (const [
			contextMethodName,
			sourceCodeMethodName,
		] of removedMethodNames) {
			newContext[contextMethodName] =
				sourceCode[sourceCodeMethodName].bind(sourceCode);
		}

		// freeze just like the original context
		Object.freeze(newContext);

		/*
		 * Create the visitor object using the original create() method.
		 * This is necessary to ensure that the visitor object is created
		 * with the correct context.
		 */
		const visitor = originalCreate(newContext);

		/*
		 * Wrap each method in the visitor object to update the currentNode
		 * before calling the original method. This is necessary because the
		 * methods like `getScope()` need to know the current node.
		 */
		for (const [methodName, method] of Object.entries(visitor)) {
			// node is the second argument for code path methods
			if (methodName.startsWith("on")) {
				visitor[methodName] = (...args) => {
					currentNode = args[1];

					return method.call(visitor, ...args);
				};

				continue;
			}

			visitor[methodName] = (...args) => {
				currentNode = args[0];

				return method.call(visitor, ...args);
			};
		}

		return visitor;
	};

	const newRuleDefinition = {
		...(isLegacyRule ? undefined : ruleDefinition),
		create: ruleCreate,
	};

	// cache the fixed up rule
	fixedUpRuleReplacements.set(ruleDefinition, newRuleDefinition);
	fixedUpRules.add(newRuleDefinition);

	return newRuleDefinition;
}

/**
 * Takes the given plugin and creates a new plugin with all of the rules wrapped
 * to provide the missing methods on the `context` object.
 * @param {FixupPluginDefinition} plugin The plugin to fix up.
 * @returns {FixupPluginDefinition} The fixed-up plugin.
 */
export function fixupPluginRules(plugin) {
	// first check if we've already fixed up this plugin
	if (fixedUpPluginReplacements.has(plugin)) {
		return fixedUpPluginReplacements.get(plugin);
	}

	/*
	 * If the plugin has already been fixed up, or if the plugin
	 * doesn't have any rules, we can just return it.
	 */
	if (fixedUpPlugins.has(plugin) || !plugin.rules) {
		return plugin;
	}

	const newPlugin = {
		...plugin,
		rules: Object.fromEntries(
			Object.entries(plugin.rules).map(([ruleId, ruleDefinition]) => [
				ruleId,
				fixupRule(ruleDefinition),
			]),
		),
	};

	// cache the fixed up plugin
	fixedUpPluginReplacements.set(plugin, newPlugin);
	fixedUpPlugins.add(newPlugin);

	return newPlugin;
}

/**
 * Takes the given configuration and creates a new configuration with all of the
 * rules wrapped to provide the missing methods on the `context` object.
 * @param {FixupConfigArray} configs The configuration to fix up.
 * @returns {FixupConfigArray} The fixed-up configuration.
 */
export function fixupConfigRules(configs) {
	return configs.map(config => {
		if (!config.plugins) {
			return config;
		}

		const newPlugins = Object.fromEntries(
			Object.entries(config.plugins).map(([pluginName, plugin]) => [
				pluginName,
				fixupPluginRules(plugin),
			]),
		);

		return {
			...config,
			plugins: newPlugins,
		};
	});
}