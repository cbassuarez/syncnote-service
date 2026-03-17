"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.validateWithToolchains = validateWithToolchains;
const child_process_1 = require("child_process");
const crypto_1 = require("crypto");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = __importDefault(require("path"));
const util_1 = require("util");
const typescript_1 = __importDefault(require("typescript"));
const execFile = (0, util_1.promisify)(child_process_1.execFile);
const supportedLanguages = new Set([
    "swift",
    "javascript",
    "typescript",
    "html",
    "css",
    "markdown",
    "json",
    "python",
    "c",
    "cpp",
]);
const maxIssuesDefault = 120;
const maxIssuesCeiling = 220;
const maxValidationBytes = Math.max(8192, Number(process.env.VALIDATION_MAX_BYTES || "120000"));
const validationCacheTTLms = 5 * 60 * 1000;
const execTimeoutMs = Math.max(1500, Number(process.env.VALIDATION_EXEC_TIMEOUT_MS || "6000"));
const validationCache = new Map();
const validationInFlight = new Map();
let cachedSwiftcAvailable = null;
let cachedSourceKitLSPAvailable = null;
let cachedPyrightAvailable = null;
let cachedRuffToolCommand;
let cachedClangdBinary;
let cachedClangTidyBinary;
let eslintJavaScript = null;
let eslintTypeScript = null;
async function validateWithToolchains(request) {
    const text = typeof request.text === "string" ? request.text : "";
    const language = normalizeLanguage(request.language);
    const maxIssues = normalizeMaxIssues(request.maxIssues);
    const markdownLintOptions = normalizeMarkdownLintOptions(request.markdownLint);
    const generatedAt = new Date().toISOString();
    if (!language) {
        return {
            language: "unsupported",
            profile: "unsupported",
            diagnostics: [
                {
                    severity: "info",
                    message: "Deep validation is unavailable for this language.",
                    line: 1,
                    column: 1,
                    source: "chrony-validate",
                    code: "coverage.unsupported",
                },
            ],
            tools: [],
            truncated: false,
            cached: false,
            generatedAt,
            limitedReason: "Language is not mapped to a compile-grade backend profile.",
        };
    }
    const byteCount = Buffer.byteLength(text, "utf8");
    if (byteCount > maxValidationBytes) {
        return {
            language,
            profile: "compile",
            diagnostics: [
                {
                    severity: "info",
                    message: `Deep validation skipped for large input (${byteCount} bytes > ${maxValidationBytes} byte limit).`,
                    line: 1,
                    column: 1,
                    source: "chrony-validate",
                    code: "validation.largeInput",
                },
            ],
            tools: [],
            truncated: false,
            cached: false,
            generatedAt,
            limitedReason: "Compile-grade pass is capped for large documents to control latency and compute cost.",
        };
    }
    const digest = contentDigest(language, text, maxIssues, markdownLintOptions);
    const now = Date.now();
    pruneExpiredValidationCache(now);
    const cached = validationCache.get(digest);
    if (cached && cached.expiresAt > now) {
        return {
            ...cached.response,
            cached: true,
        };
    }
    let inFlight = validationInFlight.get(digest);
    if (!inFlight) {
        inFlight = runDeepValidation(language, text, maxIssues, markdownLintOptions).then((response) => ({
            ...response,
            cached: false,
            generatedAt: new Date().toISOString(),
        }));
        validationInFlight.set(digest, inFlight);
    }
    try {
        const response = await inFlight;
        validationCache.set(digest, {
            expiresAt: now + validationCacheTTLms,
            response,
        });
        return response;
    }
    finally {
        validationInFlight.delete(digest);
    }
}
function normalizeLanguage(rawLanguage) {
    if (!rawLanguage) {
        return null;
    }
    const normalized = rawLanguage.trim().toLowerCase();
    if (normalized === "js")
        return "javascript";
    if (normalized === "ts")
        return "typescript";
    if (normalized === "md")
        return "markdown";
    if (normalized === "py")
        return "python";
    if (normalized === "c++" || normalized === "cxx")
        return "cpp";
    if (supportedLanguages.has(normalized)) {
        return normalized;
    }
    return null;
}
function normalizeMaxIssues(rawValue) {
    if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
        return maxIssuesDefault;
    }
    return Math.min(maxIssuesCeiling, Math.max(8, Math.floor(rawValue)));
}
function normalizeMarkdownLintOptions(raw) {
    const enabled = typeof raw?.enabled === "boolean" ? raw.enabled : true;
    const markdownlintEnabled = typeof raw?.markdownlintEnabled === "boolean" ? raw.markdownlintEnabled : true;
    const remarkLintEnabled = typeof raw?.remarkLintEnabled === "boolean" ? raw.remarkLintEnabled : true;
    const onlyRules = normalizeMarkdownRuleList(raw?.onlyRules);
    const disableRules = normalizeMarkdownRuleList(raw?.disableRules);
    return {
        enabled,
        markdownlintEnabled,
        remarkLintEnabled,
        onlyRules,
        disableRules,
    };
}
function normalizeMarkdownRuleList(raw) {
    const rawValues = [];
    if (Array.isArray(raw)) {
        for (const value of raw) {
            if (typeof value === "string") {
                rawValues.push(value);
            }
        }
    }
    else if (typeof raw === "string") {
        rawValues.push(...raw.split(/[\s,\n\t]+/));
    }
    const seen = new Set();
    const normalized = [];
    for (const token of rawValues) {
        const ruleID = normalizeMarkdownRuleID(token);
        if (!ruleID || seen.has(ruleID)) {
            continue;
        }
        seen.add(ruleID);
        normalized.push(ruleID);
    }
    return normalized;
}
function normalizeMarkdownRuleID(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    const upper = trimmed.toUpperCase();
    if (upper.startsWith("MD") && /^[0-9]+$/.test(upper.slice(2))) {
        return upper;
    }
    return trimmed.toLowerCase();
}
function contentDigest(language, text, maxIssues, markdownLintOptions) {
    const hasher = (0, crypto_1.createHash)("sha256")
        .update(language)
        .update("\u2063")
        .update(String(maxIssues))
        .update("\u2063")
        .update(text);
    if (language === "markdown") {
        hasher
            .update("\u2063")
            .update(JSON.stringify({
            enabled: markdownLintOptions.enabled,
            markdownlintEnabled: markdownLintOptions.markdownlintEnabled,
            remarkLintEnabled: markdownLintOptions.remarkLintEnabled,
            onlyRules: markdownLintOptions.onlyRules,
            disableRules: markdownLintOptions.disableRules,
        }));
    }
    return hasher.digest("hex");
}
function pruneExpiredValidationCache(now) {
    for (const [key, entry] of validationCache.entries()) {
        if (entry.expiresAt <= now) {
            validationCache.delete(key);
        }
    }
}
async function runDeepValidation(language, text, maxIssues, markdownLintOptions) {
    const diagnostics = [];
    const tools = new Set();
    let limitedReason = null;
    try {
        switch (language) {
            case "swift":
                diagnostics.push(...(await validateSwiftCompile(text, maxIssues, tools)));
                break;
            case "javascript":
            case "typescript":
                diagnostics.push(...validateTypeScriptCompiler(text, language, maxIssues));
                diagnostics.push(...(await validateESLint(text, language, maxIssues, tools)));
                tools.add("typescript");
                break;
            case "html":
                diagnostics.push(...validateHTMLHint(text, maxIssues));
                diagnostics.push(...validateHTMLParser(text, maxIssues));
                tools.add("htmlhint");
                tools.add("parse5");
                break;
            case "css":
                diagnostics.push(...(await validateStylelint(text, maxIssues, tools)));
                break;
            case "json":
                diagnostics.push(...validateJSONStrict(text, maxIssues, tools));
                diagnostics.push(...(await validateJSONSchema(text, maxIssues, tools)));
                break;
            case "python":
                diagnostics.push(...(await validateRuff(text, maxIssues, tools)));
                diagnostics.push(...(await validatePyright(text, maxIssues, tools)));
                break;
            case "c":
            case "cpp":
                diagnostics.push(...(await validateClangd(text, language, maxIssues, tools)));
                diagnostics.push(...(await validateClangTidy(text, language, maxIssues, tools)));
                break;
            case "markdown":
                if (!markdownLintOptions.enabled) {
                    limitedReason =
                        "Markdown deep validation is disabled in language settings.";
                    break;
                }
                if (markdownLintOptions.markdownlintEnabled) {
                    diagnostics.push(...(await validateMarkdownlint(text, maxIssues, tools, markdownLintOptions)));
                }
                if (markdownLintOptions.remarkLintEnabled) {
                    diagnostics.push(...(await validateRemarkLint(text, maxIssues, tools)));
                }
                if (!markdownLintOptions.markdownlintEnabled && !markdownLintOptions.remarkLintEnabled) {
                    limitedReason =
                        "Markdown deep validation is enabled, but all markdown lint engines are turned off.";
                }
                break;
        }
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("chrony-validate", `Deep validation failed: ${errorMessage(error)}`));
    }
    const normalized = normalizeDiagnostics(diagnostics, maxIssues);
    const truncated = normalized.length < diagnostics.length;
    if (truncated && !limitedReason) {
        limitedReason = `Diagnostics were truncated to ${maxIssues} issues.`;
    }
    return {
        language,
        profile: "compile",
        diagnostics: normalized,
        tools: Array.from(tools.values()).sort(),
        truncated,
        cached: false,
        generatedAt: new Date().toISOString(),
        limitedReason,
    };
}
async function validateSwiftCompile(text, maxIssues, tools) {
    const diagnostics = [];
    const swiftcAvailable = await ensureSwiftcAvailability();
    if (!swiftcAvailable) {
        diagnostics.push(toolFailureIssue("swiftc", "swiftc is unavailable on this backend, so compile-grade Swift diagnostics are skipped."));
        return diagnostics;
    }
    tools.add("swiftc");
    const tempDir = (0, fs_1.mkdtempSync)(path_1.default.join((0, os_1.tmpdir)(), "chrony-swift-validate-"));
    const filePath = path_1.default.join(tempDir, "Document.swift");
    try {
        (0, fs_1.writeFileSync)(filePath, text, "utf8");
        let output = "";
        try {
            const result = await execFile("swiftc", ["-frontend", "-typecheck", filePath], {
                timeout: execTimeoutMs,
                maxBuffer: 1024 * 1024,
            });
            output = `${result.stdout || ""}\n${result.stderr || ""}`;
        }
        catch (error) {
            const typedError = error;
            output = `${typedError.stdout || ""}\n${typedError.stderr || ""}`;
        }
        diagnostics.push(...parseSwiftCompilerDiagnostics(output, maxIssues));
        if (process.env.VALIDATION_ENABLE_SOURCEKIT_LSP === "1") {
            if (await ensureSourceKitLSPAvailability()) {
                tools.add("sourcekit-lsp");
            }
            else {
                diagnostics.push(toolFailureIssue("sourcekit-lsp", "sourcekit-lsp was requested but is not installed on this backend."));
            }
        }
    }
    finally {
        try {
            (0, fs_1.rmSync)(tempDir, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
    return diagnostics;
}
async function ensureSwiftcAvailability() {
    if (cachedSwiftcAvailable != null) {
        return cachedSwiftcAvailable;
    }
    try {
        await execFile("swiftc", ["--version"], {
            timeout: execTimeoutMs,
            maxBuffer: 256 * 1024,
        });
        cachedSwiftcAvailable = true;
    }
    catch {
        cachedSwiftcAvailable = false;
    }
    return cachedSwiftcAvailable;
}
async function ensureSourceKitLSPAvailability() {
    if (cachedSourceKitLSPAvailable != null) {
        return cachedSourceKitLSPAvailable;
    }
    try {
        await execFile("sourcekit-lsp", ["--version"], {
            timeout: execTimeoutMs,
            maxBuffer: 256 * 1024,
        });
        cachedSourceKitLSPAvailable = true;
    }
    catch {
        cachedSourceKitLSPAvailable = false;
    }
    return cachedSourceKitLSPAvailable;
}
function parseSwiftCompilerDiagnostics(output, maxIssues) {
    const diagnostics = [];
    const regex = /^.+?:(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;
    let match = null;
    while ((match = regex.exec(output)) != null) {
        const line = Number(match[1]);
        const column = Number(match[2]);
        const rawSeverity = match[3].toLowerCase();
        const message = match[4].trim();
        diagnostics.push({
            severity: rawSeverity === "error"
                ? "error"
                : rawSeverity === "warning"
                    ? "warning"
                    : "info",
            message,
            line: Number.isFinite(line) ? Math.max(1, line) : 1,
            column: Number.isFinite(column) ? Math.max(1, column) : 1,
            source: "swiftc",
            code: "swiftc",
        });
        if (diagnostics.length >= maxIssues) {
            break;
        }
    }
    return diagnostics;
}
function validateTypeScriptCompiler(text, language, maxIssues) {
    const fileName = language === "typescript" ? "Document.ts" : "Document.js";
    const scriptKind = language === "typescript" ? typescript_1.default.ScriptKind.TS : typescript_1.default.ScriptKind.JS;
    const compilerOptions = {
        allowJs: language === "javascript",
        checkJs: language === "javascript",
        noEmit: true,
        strict: false,
        skipLibCheck: true,
        target: typescript_1.default.ScriptTarget.ES2022,
        module: typescript_1.default.ModuleKind.ESNext,
        lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
    };
    const baseHost = typescript_1.default.createCompilerHost(compilerOptions, true);
    const sourceFile = typescript_1.default.createSourceFile(fileName, text, typescript_1.default.ScriptTarget.Latest, true, scriptKind);
    const host = {
        ...baseHost,
        getSourceFile: (name, languageVersion, onError, shouldCreateNewSourceFile) => {
            if (name === fileName) {
                return sourceFile;
            }
            return baseHost.getSourceFile(name, languageVersion, onError, shouldCreateNewSourceFile);
        },
        readFile: (name) => {
            if (name === fileName) {
                return text;
            }
            return baseHost.readFile(name);
        },
        fileExists: (name) => {
            if (name === fileName) {
                return true;
            }
            return baseHost.fileExists(name);
        },
        writeFile: () => undefined,
    };
    const program = typescript_1.default.createProgram([fileName], compilerOptions, host);
    const diagnostics = [
        ...program.getOptionsDiagnostics(),
        ...program.getSyntacticDiagnostics(sourceFile),
        ...program.getSemanticDiagnostics(sourceFile),
    ];
    const output = [];
    for (const diagnostic of diagnostics) {
        const message = typescript_1.default
            .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            .trim();
        const lineColumn = resolveTypeScriptLineColumn(diagnostic, sourceFile);
        output.push({
            severity: diagnostic.category === typescript_1.default.DiagnosticCategory.Error
                ? "error"
                : diagnostic.category === typescript_1.default.DiagnosticCategory.Warning
                    ? "warning"
                    : "info",
            message,
            line: lineColumn.line,
            column: lineColumn.column,
            source: "typescript",
            code: `TS${diagnostic.code}`,
        });
        if (output.length >= maxIssues) {
            break;
        }
    }
    return output;
}
function resolveTypeScriptLineColumn(diagnostic, fallbackFile) {
    const file = diagnostic.file || fallbackFile;
    const start = typeof diagnostic.start === "number" ? diagnostic.start : 0;
    const lineAndCharacter = file.getLineAndCharacterOfPosition(start);
    return {
        line: Math.max(1, lineAndCharacter.line + 1),
        column: Math.max(1, lineAndCharacter.character + 1),
    };
}
async function validateESLint(text, language, maxIssues, tools) {
    const diagnostics = [];
    try {
        const eslint = await eslintForLanguage(language);
        const filePath = language === "typescript" ? "Document.ts" : "Document.js";
        const results = await eslint.lintText(text, { filePath });
        for (const result of results) {
            const messages = Array.isArray(result.messages) ? result.messages : [];
            for (const entry of messages) {
                const severity = Number(entry.severity);
                diagnostics.push({
                    severity: severity >= 2 ? "error" : "warning",
                    message: String(entry.message || "Lint warning"),
                    line: Math.max(1, Number(entry.line) || 1),
                    column: Math.max(1, Number(entry.column) || 1),
                    endLine: typeof entry.endLine === "number"
                        ? Math.max(1, entry.endLine)
                        : null,
                    endColumn: typeof entry.endColumn === "number"
                        ? Math.max(1, entry.endColumn)
                        : null,
                    source: "eslint",
                    code: entry.ruleId == null
                        ? null
                        : String(entry.ruleId),
                });
                if (diagnostics.length >= maxIssues) {
                    tools.add("eslint");
                    return diagnostics;
                }
            }
        }
        tools.add("eslint");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("eslint", errorMessage(error)));
    }
    return diagnostics;
}
async function eslintForLanguage(language) {
    if (language === "javascript" && eslintJavaScript) {
        return eslintJavaScript;
    }
    if (language === "typescript" && eslintTypeScript) {
        return eslintTypeScript;
    }
    const eslintModule = require("eslint");
    if (language === "javascript") {
        eslintJavaScript = new eslintModule.ESLint({
            useEslintrc: false,
            ignore: false,
            fix: false,
            overrideConfig: {
                env: {
                    browser: true,
                    node: true,
                    es2022: true,
                },
                parserOptions: {
                    ecmaVersion: "latest",
                    sourceType: "module",
                },
                rules: {
                    "no-undef": "error",
                    "no-unreachable": "warn",
                    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
                    "no-constant-condition": "warn",
                    "no-dupe-keys": "error",
                    "no-redeclare": "error",
                },
            },
        });
        return eslintJavaScript;
    }
    eslintTypeScript = new eslintModule.ESLint({
        useEslintrc: false,
        ignore: false,
        fix: false,
        overrideConfig: {
            parser: "@typescript-eslint/parser",
            plugins: ["@typescript-eslint"],
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
            },
            rules: {
                "no-undef": "off",
                "no-unused-vars": "off",
                "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
                "@typescript-eslint/no-redeclare": "error",
                "@typescript-eslint/ban-ts-comment": "warn",
            },
        },
    });
    return eslintTypeScript;
}
function validateHTMLHint(text, maxIssues) {
    const diagnostics = [];
    try {
        const htmlhintModule = require("htmlhint");
        const messages = htmlhintModule.HTMLHint.verify(text, {
            "attr-no-duplication": true,
            "attr-value-double-quotes": false,
            "doctype-first": false,
            "id-unique": true,
            "spec-char-escape": true,
            "tag-pair": true,
            "tag-self-close": false,
            "tagname-lowercase": true,
        });
        for (const message of messages) {
            diagnostics.push({
                severity: "error",
                message: String(message.message || "HTML issue"),
                line: Math.max(1, Number(message.line) || 1),
                column: Math.max(1, Number(message.col) || 1),
                source: "htmlhint",
                code: message.rule && typeof message.rule === "object"
                    ? String(message.rule.id || "htmlhint")
                    : "htmlhint",
            });
            if (diagnostics.length >= maxIssues) {
                break;
            }
        }
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("htmlhint", errorMessage(error)));
    }
    return diagnostics;
}
function validateHTMLParser(text, maxIssues) {
    const diagnostics = [];
    try {
        const parse5Module = require("parse5");
        const parseErrors = [];
        parse5Module.parse(text, {
            sourceCodeLocationInfo: true,
            onParseError: (error) => {
                parseErrors.push(error);
            },
        });
        for (const error of parseErrors) {
            diagnostics.push({
                severity: "error",
                message: `HTML parse error: ${String(error.code || "unknown")}`,
                line: Math.max(1, Number(error.startLine) || 1),
                column: Math.max(1, Number(error.startCol) || 1),
                source: "parse5",
                code: String(error.code || "parse5"),
            });
            if (diagnostics.length >= maxIssues) {
                break;
            }
        }
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("parse5", errorMessage(error)));
    }
    return diagnostics;
}
async function validateStylelint(text, maxIssues, tools) {
    const diagnostics = [];
    try {
        const stylelintModule = await Promise.resolve().then(() => __importStar(require("stylelint")));
        const stylelint = stylelintModule
            .default;
        const result = await stylelint.lint({
            code: text,
            codeFilename: "Document.css",
            config: {
                extends: ["stylelint-config-standard"],
            },
        });
        const results = Array.isArray(result.results)
            ? result.results
            : [];
        for (const row of results) {
            const warnings = Array.isArray(row.warnings)
                ? row.warnings
                : [];
            for (const warning of warnings) {
                diagnostics.push({
                    severity: String(warning.severity || "").toLowerCase() === "error"
                        ? "error"
                        : "warning",
                    message: String(warning.text || "Stylelint warning"),
                    line: Math.max(1, Number(warning.line) || 1),
                    column: Math.max(1, Number(warning.column) || 1),
                    source: "stylelint",
                    code: warning.rule == null ? null : String(warning.rule),
                });
                if (diagnostics.length >= maxIssues) {
                    tools.add("stylelint");
                    return diagnostics;
                }
            }
        }
        tools.add("stylelint");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("stylelint", errorMessage(error)));
    }
    return diagnostics;
}
function validateJSONStrict(text, maxIssues, tools) {
    const diagnostics = [];
    const trimmed = text.trim();
    if (!trimmed) {
        return diagnostics;
    }
    tools.add("json.parse");
    try {
        JSON.parse(text);
    }
    catch (error) {
        const message = errorMessage(error);
        const offset = parseJSONParseOffset(message);
        const location = offset == null ? { line: 1, column: 1 } : lineColumnForUTF16Offset(text, offset);
        diagnostics.push({
            severity: "error",
            message: `JSON parse error: ${message}`,
            line: location.line,
            column: location.column,
            source: "json.parse",
            code: "json.parse",
        });
    }
    return diagnostics.slice(0, maxIssues);
}
async function validateJSONSchema(text, maxIssues, tools) {
    const diagnostics = [];
    const trimmed = text.trim();
    if (!trimmed) {
        return diagnostics;
    }
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch {
        return diagnostics;
    }
    if (!isLikelyJSONSchemaDocument(parsed)) {
        return diagnostics;
    }
    try {
        let AjvCtor = null;
        try {
            const ajv2020Module = await Promise.resolve().then(() => __importStar(require("ajv/dist/2020.js")));
            AjvCtor = (ajv2020Module.default ??
                ajv2020Module);
        }
        catch {
            const ajvModule = await Promise.resolve().then(() => __importStar(require("ajv")));
            AjvCtor = (ajvModule.default ??
                ajvModule);
        }
        const ajv = new AjvCtor({
            allErrors: true,
            strict: false,
            validateFormats: false,
        });
        tools.add("ajv");
        const isValid = ajv.validateSchema(parsed);
        if (isValid) {
            return diagnostics;
        }
        const errors = Array.isArray(ajv.errors) ? ajv.errors : [];
        for (const row of errors) {
            diagnostics.push({
                severity: "error",
                message: [
                    "JSON Schema validation:",
                    String(row.instancePath || "/"),
                    String(row.message || "invalid schema"),
                ]
                    .join(" ")
                    .trim(),
                line: 1,
                column: 1,
                source: "ajv",
                code: row.keyword == null ? "json.schema" : `json.schema.${String(row.keyword)}`,
            });
            if (diagnostics.length >= maxIssues) {
                break;
            }
        }
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("ajv", errorMessage(error)));
    }
    return diagnostics;
}
function isLikelyJSONSchemaDocument(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return false;
    }
    const schema = value;
    return (schema.$schema != null ||
        schema.$id != null ||
        schema.$defs != null ||
        schema.definitions != null ||
        schema.properties != null ||
        schema.required != null);
}
async function validateRuff(text, maxIssues, tools) {
    const diagnostics = [];
    const ruffCommand = await resolveRuffToolCommand();
    if (!ruffCommand) {
        const wasmResult = await validateRuffWithWasm(text, maxIssues, tools);
        if (wasmResult.available) {
            return wasmResult.diagnostics;
        }
        diagnostics.push(toolFailureIssue("ruff", "ruff is unavailable on this backend, so Ruff diagnostics are skipped."));
        return diagnostics;
    }
    const tempDir = (0, fs_1.mkdtempSync)(path_1.default.join((0, os_1.tmpdir)(), "chrony-python-ruff-"));
    const filePath = path_1.default.join(tempDir, "Document.py");
    try {
        (0, fs_1.writeFileSync)(filePath, text, "utf8");
        let output = "";
        try {
            const result = await execFile(ruffCommand.command, withToolArgs(ruffCommand, ["check", "--output-format", "json", filePath]), {
                timeout: execTimeoutMs,
                maxBuffer: 2 * 1024 * 1024,
            });
            output = mergedToolOutput(result);
        }
        catch (error) {
            output = mergedToolOutput(error);
        }
        const rows = safeJSONArray(output);
        for (const row of rows) {
            const code = String(row.code || "ruff");
            const location = (row.location ?? {});
            const endLocation = (row.end_location ?? {});
            diagnostics.push({
                severity: ruffSeverity(code, String(row.message || "")),
                message: String(row.message || "Ruff issue"),
                line: Math.max(1, Number(location.row) || 1),
                column: Math.max(1, Number(location.column) || 1),
                endLine: typeof endLocation.row === "number"
                    ? Math.max(1, Number(endLocation.row))
                    : null,
                endColumn: typeof endLocation.column === "number"
                    ? Math.max(1, Number(endLocation.column))
                    : null,
                source: "ruff",
                code,
            });
            if (diagnostics.length >= maxIssues) {
                break;
            }
        }
        tools.add("ruff");
    }
    catch (error) {
        const wasmResult = await validateRuffWithWasm(text, maxIssues, tools);
        if (wasmResult.available) {
            return wasmResult.diagnostics;
        }
        diagnostics.push(toolFailureIssue("ruff", errorMessage(error)));
    }
    finally {
        try {
            (0, fs_1.rmSync)(tempDir, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
    return diagnostics;
}
async function validateRuffWithWasm(text, maxIssues, tools) {
    try {
        const ruffWasmModule = await Promise.resolve().then(() => __importStar(require("@astral-sh/ruff-wasm-nodejs")));
        const Workspace = ruffWasmModule.Workspace;
        const PositionEncoding = ruffWasmModule
            .PositionEncoding;
        if (!Workspace || !PositionEncoding) {
            return { available: false, diagnostics: [] };
        }
        const workspace = new Workspace({}, PositionEncoding.Utf16 ?? 1);
        const rows = workspace.check(text);
        const entries = Array.isArray(rows) ? rows : [];
        const diagnostics = [];
        for (const row of entries) {
            const code = String(row.code || "ruff");
            const location = (row.start_location ?? {});
            const endLocation = (row.end_location ?? {});
            diagnostics.push({
                severity: ruffSeverity(code, String(row.message || "")),
                message: String(row.message || "Ruff issue"),
                line: Math.max(1, Number(location.row) || 1),
                column: Math.max(1, Number(location.column) || 1),
                endLine: typeof endLocation.row === "number"
                    ? Math.max(1, Number(endLocation.row))
                    : null,
                endColumn: typeof endLocation.column === "number"
                    ? Math.max(1, Number(endLocation.column))
                    : null,
                source: "ruff",
                code,
            });
            if (diagnostics.length >= maxIssues) {
                break;
            }
        }
        tools.add("ruff");
        tools.add("ruff-wasm");
        return {
            available: true,
            diagnostics,
        };
    }
    catch {
        return { available: false, diagnostics: [] };
    }
}
async function validatePyright(text, maxIssues, tools) {
    const diagnostics = [];
    if (!(await ensurePyrightAvailability())) {
        diagnostics.push(toolFailureIssue("pyright", "pyright is unavailable on this backend, so static type diagnostics are skipped."));
        return diagnostics;
    }
    const tempDir = (0, fs_1.mkdtempSync)(path_1.default.join((0, os_1.tmpdir)(), "chrony-python-pyright-"));
    const filePath = path_1.default.join(tempDir, "Document.py");
    const pyrightBin = resolveLocalBinary("pyright");
    try {
        (0, fs_1.writeFileSync)(filePath, text, "utf8");
        let output = "";
        try {
            const result = await execFile(pyrightBin, ["--outputjson", filePath], {
                timeout: execTimeoutMs,
                maxBuffer: 2 * 1024 * 1024,
            });
            output = mergedToolOutput(result);
        }
        catch (error) {
            output = mergedToolOutput(error);
        }
        const root = safeJSONObject(output);
        const rows = Array.isArray(root.generalDiagnostics)
            ? root.generalDiagnostics
            : [];
        for (const row of rows) {
            const range = (row.range ?? {});
            const start = (range.start ?? {});
            const end = (range.end ?? {});
            diagnostics.push({
                severity: pyrightSeverity(row.severity),
                message: String(row.message || "Pyright diagnostic"),
                line: Math.max(1, Number(start.line) + 1 || 1),
                column: Math.max(1, Number(start.character) + 1 || 1),
                endLine: typeof end.line === "number" ? Math.max(1, Number(end.line) + 1) : null,
                endColumn: typeof end.character === "number"
                    ? Math.max(1, Number(end.character) + 1)
                    : null,
                source: "pyright",
                code: row.rule == null ? "pyright" : String(row.rule),
            });
            if (diagnostics.length >= maxIssues) {
                break;
            }
        }
        tools.add("pyright");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("pyright", errorMessage(error)));
    }
    finally {
        try {
            (0, fs_1.rmSync)(tempDir, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
    return diagnostics;
}
async function validateClangd(text, language, maxIssues, tools) {
    const diagnostics = [];
    const clangdBinary = await resolveClangdBinary();
    if (!clangdBinary) {
        diagnostics.push(toolFailureIssue("clangd", "clangd is unavailable on this backend, so compile diagnostics are skipped."));
        return diagnostics;
    }
    const tempDir = (0, fs_1.mkdtempSync)(path_1.default.join((0, os_1.tmpdir)(), `chrony-${language}-clangd-`));
    const fileName = language === "cpp" ? "Document.cpp" : "Document.c";
    const filePath = path_1.default.join(tempDir, fileName);
    const argumentsList = language === "cpp"
        ? ["clang++", "-std=c++20", "-x", "c++", filePath]
        : ["clang", "-std=c17", "-x", "c", filePath];
    try {
        (0, fs_1.writeFileSync)(filePath, text, "utf8");
        (0, fs_1.writeFileSync)(path_1.default.join(tempDir, "compile_commands.json"), JSON.stringify([
            {
                directory: tempDir,
                file: filePath,
                arguments: argumentsList,
            },
        ], null, 2), "utf8");
        let output = "";
        try {
            const result = await execFile(clangdBinary, [
                `--check=${filePath}`,
                `--compile-commands-dir=${tempDir}`,
                "--clang-tidy=true",
                "--log=error",
            ], {
                timeout: execTimeoutMs,
                maxBuffer: 2 * 1024 * 1024,
            });
            output = mergedToolOutput(result);
        }
        catch (error) {
            output = mergedToolOutput(error);
        }
        const clangdDiagnostics = parseClangStyleDiagnostics(output, "clangd", maxIssues);
        if (clangdDiagnostics.length > 0) {
            diagnostics.push(...clangdDiagnostics);
        }
        else {
            diagnostics.push(...parseClangdCheckDiagnostics(output, maxIssues));
        }
        tools.add("clangd");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("clangd", errorMessage(error)));
    }
    finally {
        try {
            (0, fs_1.rmSync)(tempDir, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
    return diagnostics;
}
async function validateClangTidy(text, language, maxIssues, tools) {
    const diagnostics = [];
    const clangTidyBinary = await resolveClangTidyBinary();
    if (!clangTidyBinary) {
        return diagnostics;
    }
    const tempDir = (0, fs_1.mkdtempSync)(path_1.default.join((0, os_1.tmpdir)(), `chrony-${language}-tidy-`));
    const fileName = language === "cpp" ? "Document.cpp" : "Document.c";
    const filePath = path_1.default.join(tempDir, fileName);
    const compileArgs = language === "cpp" ? ["-std=c++20", "-xc++"] : ["-std=c17", "-xc"];
    try {
        (0, fs_1.writeFileSync)(filePath, text, "utf8");
        let output = "";
        try {
            const result = await execFile(clangTidyBinary, [filePath, "--", ...compileArgs], {
                timeout: execTimeoutMs,
                maxBuffer: 2 * 1024 * 1024,
            });
            output = mergedToolOutput(result);
        }
        catch (error) {
            output = mergedToolOutput(error);
        }
        diagnostics.push(...parseClangStyleDiagnostics(output, "clang-tidy", maxIssues));
        tools.add("clang-tidy");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("clang-tidy", errorMessage(error)));
    }
    finally {
        try {
            (0, fs_1.rmSync)(tempDir, { recursive: true, force: true });
        }
        catch {
            // best-effort cleanup
        }
    }
    return diagnostics;
}
async function validateMarkdownlint(text, maxIssues, tools, options) {
    const diagnostics = [];
    try {
        // @ts-ignore NodeNext subpath exports are resolved at runtime.
        const markdownlintModule = (await Promise.resolve().then(() => __importStar(require("markdownlint/sync"))));
        const lint = markdownlintModule.lint;
        if (!lint) {
            diagnostics.push(toolFailureIssue("markdownlint", "markdownlint sync API is unavailable on this backend runtime."));
            return diagnostics;
        }
        const config = markdownlintConfig(options);
        const result = lint({
            strings: { source: text },
            config,
        });
        const entries = result.source;
        const rows = Array.isArray(entries)
            ? entries
            : [];
        for (const row of rows) {
            const ruleNames = Array.isArray(row.ruleNames)
                ? row.ruleNames
                : [];
            diagnostics.push({
                severity: "warning",
                message: [
                    String(row.ruleDescription || "Markdownlint warning"),
                    row.errorDetail ? `(${String(row.errorDetail)})` : "",
                ]
                    .filter(Boolean)
                    .join(" ")
                    .trim(),
                line: Math.max(1, Number(row.lineNumber) || 1),
                column: Math.max(1, Number(row.errorRange && row.errorRange[0]) || 1),
                source: "markdownlint",
                code: ruleNames.length > 0 ? ruleNames[0] : "markdownlint",
            });
            if (diagnostics.length >= maxIssues) {
                tools.add("markdownlint");
                return diagnostics;
            }
        }
        tools.add("markdownlint");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("markdownlint", errorMessage(error)));
    }
    return diagnostics;
}
function markdownlintConfig(options) {
    const config = {
        default: options.onlyRules.length === 0,
    };
    for (const rule of options.onlyRules) {
        config[rule] = true;
    }
    for (const rule of options.disableRules) {
        config[rule] = false;
    }
    return config;
}
async function validateRemarkLint(text, maxIssues, tools) {
    const diagnostics = [];
    try {
        const remarkModule = await Promise.resolve().then(() => __importStar(require("remark")));
        const remarkLintModule = await Promise.resolve().then(() => __importStar(require("remark-lint")));
        const remarkPresetModule = await Promise.resolve().then(() => __importStar(require("remark-preset-lint-recommended")));
        const remark = (remarkModule.remark ??
            remarkModule.default);
        const remarkLintPlugin = remarkLintModule.default ?? remarkLintModule;
        const remarkPresetPlugin = remarkPresetModule.default ??
            remarkPresetModule;
        const file = await remark()
            .use(remarkLintPlugin)
            .use(remarkPresetPlugin)
            .process(text);
        const messages = Array.isArray(file.messages)
            ? file.messages
            : [];
        for (const message of messages) {
            const location = (message.location ?? {});
            const start = (location.start ?? {});
            const line = Number(message.line ?? start.line) || 1;
            const column = Number(message.column ?? start.column) || 1;
            diagnostics.push({
                severity: message.fatal ? "error" : "warning",
                message: String(message.reason || message.message || "Remark lint warning"),
                line: Math.max(1, line),
                column: Math.max(1, column),
                source: "remark-lint",
                code: message.ruleId == null ? null : String(message.ruleId),
            });
            if (diagnostics.length >= maxIssues) {
                tools.add("remark-lint");
                return diagnostics;
            }
        }
        tools.add("remark-lint");
    }
    catch (error) {
        diagnostics.push(toolFailureIssue("remark-lint", errorMessage(error)));
    }
    return diagnostics;
}
function parseJSONParseOffset(message) {
    const match = /position\s+(\d+)/i.exec(message);
    if (!match) {
        return null;
    }
    const value = Number(match[1]);
    if (!Number.isFinite(value)) {
        return null;
    }
    return Math.max(0, Math.floor(value));
}
function lineColumnForUTF16Offset(text, utf16Offset) {
    const clampedOffset = Math.max(0, Math.min(text.length, utf16Offset));
    let line = 1;
    let column = 1;
    for (let i = 0; i < clampedOffset; i += 1) {
        if (text.charCodeAt(i) === 0x0a) {
            line += 1;
            column = 1;
        }
        else {
            column += 1;
        }
    }
    return { line, column };
}
function mergedToolOutput(output) {
    return `${output.stdout || ""}\n${output.stderr || ""}`.trim();
}
function safeJSONArray(raw) {
    if (!raw.trim()) {
        return [];
    }
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed)
            ? parsed
            : [];
    }
    catch {
        return [];
    }
}
function safeJSONObject(raw) {
    if (!raw.trim()) {
        return {};
    }
    try {
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === "object"
            ? parsed
            : {};
    }
    catch {
        return {};
    }
}
function ruffSeverity(code, message) {
    const upperCode = code.toUpperCase();
    const lowerMessage = message.toLowerCase();
    if (upperCode.startsWith("E9") ||
        upperCode.startsWith("F") ||
        lowerMessage.includes("syntax")) {
        return "error";
    }
    return "warning";
}
function pyrightSeverity(rawSeverity) {
    const normalized = String(rawSeverity || "").toLowerCase();
    if (normalized === "error") {
        return "error";
    }
    if (normalized === "warning") {
        return "warning";
    }
    return "info";
}
function parseClangStyleDiagnostics(output, source, maxIssues) {
    const diagnostics = [];
    if (!output.trim()) {
        return diagnostics;
    }
    const regex = /^.+?:(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.+?)(?:\s+\[([^\]]+)\])?$/gm;
    let match = null;
    while ((match = regex.exec(output)) != null) {
        const rawSeverity = match[3].toLowerCase();
        diagnostics.push({
            severity: rawSeverity === "fatal error" || rawSeverity === "error"
                ? "error"
                : rawSeverity === "warning"
                    ? "warning"
                    : "info",
            message: String(match[4] || "Compiler diagnostic").trim(),
            line: Math.max(1, Number(match[1]) || 1),
            column: Math.max(1, Number(match[2]) || 1),
            source,
            code: match[5] ? String(match[5]) : source,
        });
        if (diagnostics.length >= maxIssues) {
            break;
        }
    }
    return diagnostics;
}
function parseClangdCheckDiagnostics(output, maxIssues) {
    const diagnostics = [];
    if (!output.trim()) {
        return diagnostics;
    }
    const regex = /^([EWI])\[[^\]]+\]\s+\[([^\]]+)\]\s+Line\s+(\d+):\s+(.+)$/gm;
    let match = null;
    while ((match = regex.exec(output)) != null) {
        const level = match[1];
        diagnostics.push({
            severity: level === "E" ? "error" : level === "W" ? "warning" : "info",
            message: String(match[4] || "Clangd diagnostic").trim(),
            line: Math.max(1, Number(match[3]) || 1),
            column: 1,
            source: "clangd",
            code: String(match[2] || "clangd"),
        });
        if (diagnostics.length >= maxIssues) {
            break;
        }
    }
    return diagnostics;
}
function resolveLocalBinary(binaryName) {
    const candidates = [
        path_1.default.join(process.cwd(), "node_modules", ".bin", binaryName),
        path_1.default.join(__dirname, "..", "node_modules", ".bin", binaryName),
    ];
    for (const candidate of candidates) {
        if ((0, fs_1.existsSync)(candidate)) {
            return candidate;
        }
    }
    return binaryName;
}
function withToolArgs(command, args) {
    return [...command.argsPrefix, ...args];
}
async function isToolCommandAvailable(command) {
    try {
        await execFile(command.command, withToolArgs(command, ["--version"]), {
            timeout: execTimeoutMs,
            maxBuffer: 256 * 1024,
        });
        return true;
    }
    catch {
        return false;
    }
}
async function resolveToolViaXcrun(toolName) {
    try {
        const result = await execFile("xcrun", ["--find", toolName], {
            timeout: execTimeoutMs,
            maxBuffer: 256 * 1024,
        });
        const candidate = String(result.stdout || "").trim();
        if (!candidate) {
            return null;
        }
        return (0, fs_1.existsSync)(candidate) ? candidate : null;
    }
    catch {
        return null;
    }
}
async function resolveRuffToolCommand() {
    if (cachedRuffToolCommand !== undefined) {
        return cachedRuffToolCommand;
    }
    const localRuff = resolveLocalBinary("ruff");
    const candidates = [];
    if (localRuff !== "ruff") {
        candidates.push({ command: localRuff, argsPrefix: [] });
    }
    candidates.push({ command: "ruff", argsPrefix: [] });
    candidates.push({ command: "python3", argsPrefix: ["-m", "ruff"] });
    candidates.push({ command: "python", argsPrefix: ["-m", "ruff"] });
    for (const candidate of candidates) {
        if (await isToolCommandAvailable(candidate)) {
            cachedRuffToolCommand = candidate;
            return candidate;
        }
    }
    cachedRuffToolCommand = null;
    return null;
}
async function resolveClangdBinary() {
    if (cachedClangdBinary !== undefined) {
        return cachedClangdBinary;
    }
    const localClangd = resolveLocalBinary("clangd");
    const candidates = [];
    if (localClangd !== "clangd") {
        candidates.push(localClangd);
    }
    const xcrunClangd = await resolveToolViaXcrun("clangd");
    if (xcrunClangd) {
        candidates.push(xcrunClangd);
    }
    candidates.push("clangd");
    for (const candidate of new Set(candidates)) {
        if (await isToolCommandAvailable({
            command: candidate,
            argsPrefix: [],
        })) {
            cachedClangdBinary = candidate;
            return candidate;
        }
    }
    cachedClangdBinary = null;
    return null;
}
async function resolveClangTidyBinary() {
    if (cachedClangTidyBinary !== undefined) {
        return cachedClangTidyBinary;
    }
    const localClangTidy = resolveLocalBinary("clang-tidy");
    const candidates = [];
    if (localClangTidy !== "clang-tidy") {
        candidates.push(localClangTidy);
    }
    const xcrunClangTidy = await resolveToolViaXcrun("clang-tidy");
    if (xcrunClangTidy) {
        candidates.push(xcrunClangTidy);
    }
    candidates.push("clang-tidy");
    for (const candidate of new Set(candidates)) {
        if (await isToolCommandAvailable({
            command: candidate,
            argsPrefix: [],
        })) {
            cachedClangTidyBinary = candidate;
            return candidate;
        }
    }
    cachedClangTidyBinary = null;
    return null;
}
async function ensurePyrightAvailability() {
    if (cachedPyrightAvailable != null) {
        return cachedPyrightAvailable;
    }
    const pyrightBin = resolveLocalBinary("pyright");
    try {
        await execFile(pyrightBin, ["--version"], {
            timeout: execTimeoutMs,
            maxBuffer: 256 * 1024,
        });
        cachedPyrightAvailable = true;
    }
    catch {
        cachedPyrightAvailable = false;
    }
    return cachedPyrightAvailable;
}
function normalizeDiagnostics(diagnostics, maxIssues) {
    const seen = new Set();
    const deduped = [];
    const sorted = diagnostics
        .map((diagnostic) => ({
        ...diagnostic,
        line: Math.max(1, diagnostic.line),
        column: Math.max(1, diagnostic.column),
        message: String(diagnostic.message || "Validation issue").trim(),
    }))
        .sort((lhs, rhs) => {
        const lhsSeverity = severityRank(lhs.severity);
        const rhsSeverity = severityRank(rhs.severity);
        if (lhsSeverity !== rhsSeverity) {
            return lhsSeverity - rhsSeverity;
        }
        if (lhs.line !== rhs.line) {
            return lhs.line - rhs.line;
        }
        if (lhs.column !== rhs.column) {
            return lhs.column - rhs.column;
        }
        if (lhs.source !== rhs.source) {
            return lhs.source.localeCompare(rhs.source);
        }
        return lhs.message.localeCompare(rhs.message);
    });
    for (const issue of sorted) {
        const key = `${issue.severity}|${issue.source}|${issue.code || ""}|${issue.line}|${issue.column}|${issue.message}`;
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        deduped.push(issue);
        if (deduped.length >= maxIssues) {
            break;
        }
    }
    return deduped;
}
function severityRank(severity) {
    switch (severity) {
        case "error":
            return 0;
        case "warning":
            return 1;
        case "info":
            return 2;
    }
}
function toolFailureIssue(tool, message) {
    return {
        severity: "info",
        message: `${tool}: ${message}`,
        line: 1,
        column: 1,
        source: tool,
        code: "tool.failure",
    };
}
function errorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return "unknown error";
}
