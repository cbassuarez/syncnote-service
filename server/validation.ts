import { execFile as execFileCallback } from "child_process";
import { createHash } from "crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import path from "path";
import { promisify } from "util";
import ts from "typescript";

const execFile = promisify(execFileCallback);

export type DeepValidationLanguage =
  | "swift"
  | "javascript"
  | "typescript"
  | "html"
  | "css"
  | "markdown"
  | "json"
  | "python"
  | "c"
  | "cpp";

export type DeepValidationSeverity = "error" | "warning" | "info";

export type DeepValidationIssue = {
  severity: DeepValidationSeverity;
  message: string;
  line: number;
  column: number;
  endLine?: number | null;
  endColumn?: number | null;
  source: string;
  code?: string | null;
};

export type DeepValidationRequest = {
  text?: string;
  language?: string;
  maxIssues?: number;
  markdownLint?: DeepValidationMarkdownLintOptionsInput;
};

export type DeepValidationMarkdownLintOptionsInput = {
  enabled?: unknown;
  markdownlintEnabled?: unknown;
  remarkLintEnabled?: unknown;
  onlyRules?: unknown;
  disableRules?: unknown;
};

export type DeepValidationResponse = {
  language: DeepValidationLanguage | "unsupported";
  profile: "compile" | "unsupported";
  diagnostics: DeepValidationIssue[];
  tools: string[];
  truncated: boolean;
  cached: boolean;
  generatedAt: string;
  limitedReason?: string | null;
};

type ValidationCacheEntry = {
  expiresAt: number;
  response: DeepValidationResponse;
};

type DeepValidationMarkdownLintOptions = {
  enabled: boolean;
  markdownlintEnabled: boolean;
  remarkLintEnabled: boolean;
  onlyRules: string[];
  disableRules: string[];
};

const supportedLanguages = new Set<DeepValidationLanguage>([
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
const maxValidationBytes = Math.max(
  8_192,
  Number(process.env.VALIDATION_MAX_BYTES || "120000")
);
const validationCacheTTLms = 5 * 60 * 1_000;
const execTimeoutMs = Math.max(
  1_500,
  Number(process.env.VALIDATION_EXEC_TIMEOUT_MS || "6000")
);

const validationCache = new Map<string, ValidationCacheEntry>();
const validationInFlight = new Map<string, Promise<DeepValidationResponse>>();

let cachedSwiftcAvailable: boolean | null = null;
let cachedSourceKitLSPAvailable: boolean | null = null;
let cachedPyrightAvailable: boolean | null = null;
let cachedRuffToolCommand: ToolCommand | null | undefined;
let cachedClangdBinary: string | null | undefined;
let cachedClangTidyBinary: string | null | undefined;

type ESLintLike = {
  lintText(
    code: string,
    options?: { filePath?: string; warnIgnored?: boolean }
  ): Promise<Array<{ messages?: Array<Record<string, unknown>> }>>;
};

type ToolCommand = {
  command: string;
  argsPrefix: string[];
};

let eslintJavaScript: ESLintLike | null = null;
let eslintTypeScript: ESLintLike | null = null;

export async function validateWithToolchains(
  request: DeepValidationRequest
): Promise<DeepValidationResponse> {
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
  } finally {
    validationInFlight.delete(digest);
  }
}

function normalizeLanguage(rawLanguage: string | undefined): DeepValidationLanguage | null {
  if (!rawLanguage) {
    return null;
  }

  const normalized = rawLanguage.trim().toLowerCase();
  if (normalized === "js") return "javascript";
  if (normalized === "ts") return "typescript";
  if (normalized === "md") return "markdown";
  if (normalized === "py") return "python";
  if (normalized === "c++" || normalized === "cxx") return "cpp";
  if (supportedLanguages.has(normalized as DeepValidationLanguage)) {
    return normalized as DeepValidationLanguage;
  }
  return null;
}

function normalizeMaxIssues(rawValue: number | undefined): number {
  if (typeof rawValue !== "number" || !Number.isFinite(rawValue)) {
    return maxIssuesDefault;
  }
  return Math.min(maxIssuesCeiling, Math.max(8, Math.floor(rawValue)));
}

function normalizeMarkdownLintOptions(
  raw: DeepValidationMarkdownLintOptionsInput | undefined
): DeepValidationMarkdownLintOptions {
  const enabled = typeof raw?.enabled === "boolean" ? raw.enabled : true;
  const markdownlintEnabled =
    typeof raw?.markdownlintEnabled === "boolean" ? raw.markdownlintEnabled : true;
  const remarkLintEnabled =
    typeof raw?.remarkLintEnabled === "boolean" ? raw.remarkLintEnabled : true;

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

function normalizeMarkdownRuleList(raw: unknown): string[] {
  const rawValues: string[] = [];
  if (Array.isArray(raw)) {
    for (const value of raw) {
      if (typeof value === "string") {
        rawValues.push(value);
      }
    }
  } else if (typeof raw === "string") {
    rawValues.push(...raw.split(/[\s,\n\t]+/));
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
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

function normalizeMarkdownRuleID(raw: string): string | null {
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

function contentDigest(
  language: DeepValidationLanguage,
  text: string,
  maxIssues: number,
  markdownLintOptions: DeepValidationMarkdownLintOptions
): string {
  const hasher = createHash("sha256")
    .update(language)
    .update("\u2063")
    .update(String(maxIssues))
    .update("\u2063")
    .update(text);
  if (language === "markdown") {
    hasher
      .update("\u2063")
      .update(
        JSON.stringify({
          enabled: markdownLintOptions.enabled,
          markdownlintEnabled: markdownLintOptions.markdownlintEnabled,
          remarkLintEnabled: markdownLintOptions.remarkLintEnabled,
          onlyRules: markdownLintOptions.onlyRules,
          disableRules: markdownLintOptions.disableRules,
        })
      );
  }
  return hasher.digest("hex");
}

function pruneExpiredValidationCache(now: number): void {
  for (const [key, entry] of validationCache.entries()) {
    if (entry.expiresAt <= now) {
      validationCache.delete(key);
    }
  }
}

async function runDeepValidation(
  language: DeepValidationLanguage,
  text: string,
  maxIssues: number,
  markdownLintOptions: DeepValidationMarkdownLintOptions
): Promise<DeepValidationResponse> {
  const diagnostics: DeepValidationIssue[] = [];
  const tools = new Set<string>();
  let limitedReason: string | null = null;

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
          diagnostics.push(
            ...(await validateMarkdownlint(
              text,
              maxIssues,
              tools,
              markdownLintOptions
            ))
          );
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
  } catch (error) {
    diagnostics.push(
      toolFailureIssue(
        "chrony-validate",
        `Deep validation failed: ${errorMessage(error)}`
      )
    );
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

async function validateSwiftCompile(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  const swiftcAvailable = await ensureSwiftcAvailability();
  if (!swiftcAvailable) {
    diagnostics.push(
      toolFailureIssue(
        "swiftc",
        "swiftc is unavailable on this backend, so compile-grade Swift diagnostics are skipped."
      )
    );
    return diagnostics;
  }

  tools.add("swiftc");
  const tempDir = mkdtempSync(path.join(tmpdir(), "chrony-swift-validate-"));
  const filePath = path.join(tempDir, "Document.swift");

  try {
    writeFileSync(filePath, text, "utf8");

    let output = "";
    try {
      const result = await execFile("swiftc", ["-frontend", "-typecheck", filePath], {
        timeout: execTimeoutMs,
        maxBuffer: 1_024 * 1_024,
      });
      output = `${result.stdout || ""}\n${result.stderr || ""}`;
    } catch (error) {
      const typedError = error as {
        stdout?: string;
        stderr?: string;
      };
      output = `${typedError.stdout || ""}\n${typedError.stderr || ""}`;
    }

    diagnostics.push(...parseSwiftCompilerDiagnostics(output, maxIssues));

    if (process.env.VALIDATION_ENABLE_SOURCEKIT_LSP === "1") {
      if (await ensureSourceKitLSPAvailability()) {
        tools.add("sourcekit-lsp");
      } else {
        diagnostics.push(
          toolFailureIssue(
            "sourcekit-lsp",
            "sourcekit-lsp was requested but is not installed on this backend."
          )
        );
      }
    }
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return diagnostics;
}

async function ensureSwiftcAvailability(): Promise<boolean> {
  if (cachedSwiftcAvailable != null) {
    return cachedSwiftcAvailable;
  }

  try {
    await execFile("swiftc", ["--version"], {
      timeout: execTimeoutMs,
      maxBuffer: 256 * 1024,
    });
    cachedSwiftcAvailable = true;
  } catch {
    cachedSwiftcAvailable = false;
  }

  return cachedSwiftcAvailable;
}

async function ensureSourceKitLSPAvailability(): Promise<boolean> {
  if (cachedSourceKitLSPAvailable != null) {
    return cachedSourceKitLSPAvailable;
  }

  try {
    await execFile("sourcekit-lsp", ["--version"], {
      timeout: execTimeoutMs,
      maxBuffer: 256 * 1024,
    });
    cachedSourceKitLSPAvailable = true;
  } catch {
    cachedSourceKitLSPAvailable = false;
  }

  return cachedSourceKitLSPAvailable;
}

function parseSwiftCompilerDiagnostics(
  output: string,
  maxIssues: number
): DeepValidationIssue[] {
  const diagnostics: DeepValidationIssue[] = [];
  const regex = /^.+?:(\d+):(\d+):\s+(error|warning|note):\s+(.+)$/gm;
  let match: RegExpExecArray | null = null;

  while ((match = regex.exec(output)) != null) {
    const line = Number(match[1]);
    const column = Number(match[2]);
    const rawSeverity = match[3].toLowerCase();
    const message = match[4].trim();

    diagnostics.push({
      severity:
        rawSeverity === "error"
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

function validateTypeScriptCompiler(
  text: string,
  language: "javascript" | "typescript",
  maxIssues: number
): DeepValidationIssue[] {
  const fileName = language === "typescript" ? "Document.ts" : "Document.js";
  const scriptKind =
    language === "typescript" ? ts.ScriptKind.TS : ts.ScriptKind.JS;

  const compilerOptions: ts.CompilerOptions = {
    allowJs: language === "javascript",
    checkJs: language === "javascript",
    noEmit: true,
    strict: false,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  };

  const baseHost = ts.createCompilerHost(compilerOptions, true);
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    true,
    scriptKind
  );

  const host: ts.CompilerHost = {
    ...baseHost,
    getSourceFile: (
      name: string,
      languageVersion: ts.ScriptTarget,
      onError?: (message: string) => void,
      shouldCreateNewSourceFile?: boolean
    ) => {
      if (name === fileName) {
        return sourceFile;
      }
      return baseHost.getSourceFile(
        name,
        languageVersion,
        onError,
        shouldCreateNewSourceFile
      );
    },
    readFile: (name: string) => {
      if (name === fileName) {
        return text;
      }
      return baseHost.readFile(name);
    },
    fileExists: (name: string) => {
      if (name === fileName) {
        return true;
      }
      return baseHost.fileExists(name);
    },
    writeFile: () => undefined,
  };

  const program = ts.createProgram([fileName], compilerOptions, host);
  const diagnostics = [
    ...program.getOptionsDiagnostics(),
    ...program.getSyntacticDiagnostics(sourceFile),
    ...program.getSemanticDiagnostics(sourceFile),
  ];

  const output: DeepValidationIssue[] = [];
  for (const diagnostic of diagnostics) {
    const message = ts
      .flattenDiagnosticMessageText(diagnostic.messageText, "\n")
      .trim();
    const lineColumn = resolveTypeScriptLineColumn(diagnostic, sourceFile);

    output.push({
      severity:
        diagnostic.category === ts.DiagnosticCategory.Error
          ? "error"
          : diagnostic.category === ts.DiagnosticCategory.Warning
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

function resolveTypeScriptLineColumn(
  diagnostic: ts.Diagnostic,
  fallbackFile: ts.SourceFile
): { line: number; column: number } {
  const file = diagnostic.file || fallbackFile;
  const start = typeof diagnostic.start === "number" ? diagnostic.start : 0;
  const lineAndCharacter = file.getLineAndCharacterOfPosition(start);
  return {
    line: Math.max(1, lineAndCharacter.line + 1),
    column: Math.max(1, lineAndCharacter.character + 1),
  };
}

async function validateESLint(
  text: string,
  language: "javascript" | "typescript",
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
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
          endLine:
            typeof entry.endLine === "number"
              ? Math.max(1, entry.endLine)
              : null,
          endColumn:
            typeof entry.endColumn === "number"
              ? Math.max(1, entry.endColumn)
              : null,
          source: "eslint",
          code:
            entry.ruleId == null
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
  } catch (error) {
    diagnostics.push(toolFailureIssue("eslint", errorMessage(error)));
  }
  return diagnostics;
}

async function eslintForLanguage(
  language: "javascript" | "typescript"
): Promise<ESLintLike> {
  if (language === "javascript" && eslintJavaScript) {
    return eslintJavaScript;
  }
  if (language === "typescript" && eslintTypeScript) {
    return eslintTypeScript;
  }

  const eslintModule = require("eslint") as {
    ESLint: new (options: Record<string, unknown>) => ESLintLike;
  };

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

function validateHTMLHint(text: string, maxIssues: number): DeepValidationIssue[] {
  const diagnostics: DeepValidationIssue[] = [];
  try {
    const htmlhintModule = require("htmlhint") as {
      HTMLHint: {
        verify(
          source: string,
          rules: Record<string, unknown>
        ): Array<Record<string, unknown>>;
      };
    };

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
        code:
          message.rule && typeof message.rule === "object"
            ? String((message.rule as Record<string, unknown>).id || "htmlhint")
            : "htmlhint",
      });
      if (diagnostics.length >= maxIssues) {
        break;
      }
    }
  } catch (error) {
    diagnostics.push(toolFailureIssue("htmlhint", errorMessage(error)));
  }

  return diagnostics;
}

function validateHTMLParser(text: string, maxIssues: number): DeepValidationIssue[] {
  const diagnostics: DeepValidationIssue[] = [];
  try {
    const parse5Module = require("parse5") as {
      parse: (
        source: string,
        options: Record<string, unknown>
      ) => unknown;
    };
    const parseErrors: Array<Record<string, unknown>> = [];
    parse5Module.parse(text, {
      sourceCodeLocationInfo: true,
      onParseError: (error: Record<string, unknown>) => {
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
  } catch (error) {
    diagnostics.push(toolFailureIssue("parse5", errorMessage(error)));
  }
  return diagnostics;
}

async function validateStylelint(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  try {
    const stylelintModule = await import("stylelint");
    const stylelint = (stylelintModule as Record<string, unknown>)
      .default as {
      lint(options: Record<string, unknown>): Promise<Record<string, unknown>>;
    };

    const result = await stylelint.lint({
      code: text,
      codeFilename: "Document.css",
      config: {
        extends: ["stylelint-config-standard"],
      },
    });

    const results = Array.isArray(result.results)
      ? (result.results as Array<Record<string, unknown>>)
      : [];

    for (const row of results) {
      const warnings = Array.isArray(row.warnings)
        ? (row.warnings as Array<Record<string, unknown>>)
        : [];
      for (const warning of warnings) {
        diagnostics.push({
          severity:
            String(warning.severity || "").toLowerCase() === "error"
              ? "error"
              : "warning",
          message: String(warning.text || "Stylelint warning"),
          line: Math.max(1, Number(warning.line) || 1),
          column: Math.max(1, Number(warning.column) || 1),
          source: "stylelint",
          code:
            warning.rule == null ? null : String(warning.rule),
        });
        if (diagnostics.length >= maxIssues) {
          tools.add("stylelint");
          return diagnostics;
        }
      }
    }
    tools.add("stylelint");
  } catch (error) {
    diagnostics.push(toolFailureIssue("stylelint", errorMessage(error)));
  }

  return diagnostics;
}

function validateJSONStrict(
  text: string,
  maxIssues: number,
  tools: Set<string>
): DeepValidationIssue[] {
  const diagnostics: DeepValidationIssue[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return diagnostics;
  }

  tools.add("json.parse");
  try {
    JSON.parse(text);
  } catch (error) {
    const message = errorMessage(error);
    const offset = parseJSONParseOffset(message);
    const location =
      offset == null ? { line: 1, column: 1 } : lineColumnForUTF16Offset(text, offset);
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

async function validateJSONSchema(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  const trimmed = text.trim();
  if (!trimmed) {
    return diagnostics;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return diagnostics;
  }

  if (!isLikelyJSONSchemaDocument(parsed)) {
    return diagnostics;
  }

  try {
    let AjvCtor:
      | (new (options?: Record<string, unknown>) => {
          validateSchema(schema: unknown): boolean;
          errors?: Array<Record<string, unknown>> | null;
        })
      | null = null;

    try {
      const ajv2020Module = await import("ajv/dist/2020.js");
      AjvCtor = ((ajv2020Module as Record<string, unknown>).default ??
        ajv2020Module) as new (options?: Record<string, unknown>) => {
        validateSchema(schema: unknown): boolean;
        errors?: Array<Record<string, unknown>> | null;
      };
    } catch {
      const ajvModule = await import("ajv");
      AjvCtor = ((ajvModule as Record<string, unknown>).default ??
        ajvModule) as new (options?: Record<string, unknown>) => {
        validateSchema(schema: unknown): boolean;
        errors?: Array<Record<string, unknown>> | null;
      };
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
  } catch (error) {
    diagnostics.push(toolFailureIssue("ajv", errorMessage(error)));
  }

  return diagnostics;
}

function isLikelyJSONSchemaDocument(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const schema = value as Record<string, unknown>;
  return (
    schema.$schema != null ||
    schema.$id != null ||
    schema.$defs != null ||
    schema.definitions != null ||
    schema.properties != null ||
    schema.required != null
  );
}

async function validateRuff(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  const ruffCommand = await resolveRuffToolCommand();
  if (!ruffCommand) {
    const wasmResult = await validateRuffWithWasm(text, maxIssues, tools);
    if (wasmResult.available) {
      return wasmResult.diagnostics;
    }
    diagnostics.push(
      toolFailureIssue(
        "ruff",
        "ruff is unavailable on this backend, so Ruff diagnostics are skipped."
      )
    );
    return diagnostics;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "chrony-python-ruff-"));
  const filePath = path.join(tempDir, "Document.py");

  try {
    writeFileSync(filePath, text, "utf8");

    let output = "";
    try {
      const result = await execFile(
        ruffCommand.command,
        withToolArgs(ruffCommand, ["check", "--output-format", "json", filePath]),
        {
          timeout: execTimeoutMs,
          maxBuffer: 2 * 1_024 * 1_024,
        }
      );
      output = mergedToolOutput(result);
    } catch (error) {
      output = mergedToolOutput(error as { stdout?: string; stderr?: string });
    }

    const rows = safeJSONArray(output);
    for (const row of rows) {
      const code = String(row.code || "ruff");
      const location = (row.location ?? {}) as Record<string, unknown>;
      const endLocation = (row.end_location ?? {}) as Record<string, unknown>;
      diagnostics.push({
        severity: ruffSeverity(code, String(row.message || "")),
        message: String(row.message || "Ruff issue"),
        line: Math.max(1, Number(location.row) || 1),
        column: Math.max(1, Number(location.column) || 1),
        endLine:
          typeof endLocation.row === "number"
            ? Math.max(1, Number(endLocation.row))
            : null,
        endColumn:
          typeof endLocation.column === "number"
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
  } catch (error) {
    const wasmResult = await validateRuffWithWasm(text, maxIssues, tools);
    if (wasmResult.available) {
      return wasmResult.diagnostics;
    }
    diagnostics.push(toolFailureIssue("ruff", errorMessage(error)));
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return diagnostics;
}

async function validateRuffWithWasm(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<{ available: boolean; diagnostics: DeepValidationIssue[] }> {
  try {
    const ruffWasmModule = await import("@astral-sh/ruff-wasm-nodejs");
    const Workspace = (ruffWasmModule as Record<string, unknown>).Workspace as
      | (new (options: unknown, positionEncoding: number) => { check(source: string): unknown })
      | undefined;
    const PositionEncoding = (ruffWasmModule as Record<string, unknown>)
      .PositionEncoding as Record<string, number> | undefined;
    if (!Workspace || !PositionEncoding) {
      return { available: false, diagnostics: [] };
    }

    const workspace = new Workspace({}, PositionEncoding.Utf16 ?? 1);
    const rows = workspace.check(text);
    const entries = Array.isArray(rows) ? (rows as Array<Record<string, unknown>>) : [];
    const diagnostics: DeepValidationIssue[] = [];
    for (const row of entries) {
      const code = String(row.code || "ruff");
      const location = (row.start_location ?? {}) as Record<string, unknown>;
      const endLocation = (row.end_location ?? {}) as Record<string, unknown>;
      diagnostics.push({
        severity: ruffSeverity(code, String(row.message || "")),
        message: String(row.message || "Ruff issue"),
        line: Math.max(1, Number(location.row) || 1),
        column: Math.max(1, Number(location.column) || 1),
        endLine:
          typeof endLocation.row === "number"
            ? Math.max(1, Number(endLocation.row))
            : null,
        endColumn:
          typeof endLocation.column === "number"
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
  } catch {
    return { available: false, diagnostics: [] };
  }
}

async function validatePyright(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  if (!(await ensurePyrightAvailability())) {
    diagnostics.push(
      toolFailureIssue(
        "pyright",
        "pyright is unavailable on this backend, so static type diagnostics are skipped."
      )
    );
    return diagnostics;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), "chrony-python-pyright-"));
  const filePath = path.join(tempDir, "Document.py");
  const pyrightBin = resolveLocalBinary("pyright");

  try {
    writeFileSync(filePath, text, "utf8");

    let output = "";
    try {
      const result = await execFile(pyrightBin, ["--outputjson", filePath], {
        timeout: execTimeoutMs,
        maxBuffer: 2 * 1_024 * 1_024,
      });
      output = mergedToolOutput(result);
    } catch (error) {
      output = mergedToolOutput(error as { stdout?: string; stderr?: string });
    }

    const root = safeJSONObject(output);
    const rows = Array.isArray(root.generalDiagnostics)
      ? (root.generalDiagnostics as Array<Record<string, unknown>>)
      : [];

    for (const row of rows) {
      const range = (row.range ?? {}) as Record<string, unknown>;
      const start = (range.start ?? {}) as Record<string, unknown>;
      const end = (range.end ?? {}) as Record<string, unknown>;
      diagnostics.push({
        severity: pyrightSeverity(row.severity),
        message: String(row.message || "Pyright diagnostic"),
        line: Math.max(1, Number(start.line) + 1 || 1),
        column: Math.max(1, Number(start.character) + 1 || 1),
        endLine:
          typeof end.line === "number" ? Math.max(1, Number(end.line) + 1) : null,
        endColumn:
          typeof end.character === "number"
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
  } catch (error) {
    diagnostics.push(toolFailureIssue("pyright", errorMessage(error)));
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return diagnostics;
}

async function validateClangd(
  text: string,
  language: "c" | "cpp",
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  const clangdBinary = await resolveClangdBinary();
  if (!clangdBinary) {
    diagnostics.push(
      toolFailureIssue(
        "clangd",
        "clangd is unavailable on this backend, so compile diagnostics are skipped."
      )
    );
    return diagnostics;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), `chrony-${language}-clangd-`));
  const fileName = language === "cpp" ? "Document.cpp" : "Document.c";
  const filePath = path.join(tempDir, fileName);
  const argumentsList =
    language === "cpp"
      ? ["clang++", "-std=c++20", "-x", "c++", filePath]
      : ["clang", "-std=c17", "-x", "c", filePath];

  try {
    writeFileSync(filePath, text, "utf8");
    writeFileSync(
      path.join(tempDir, "compile_commands.json"),
      JSON.stringify(
        [
          {
            directory: tempDir,
            file: filePath,
            arguments: argumentsList,
          },
        ],
        null,
        2
      ),
      "utf8"
    );

    let output = "";
    try {
      const result = await execFile(
        clangdBinary,
        [
          `--check=${filePath}`,
          `--compile-commands-dir=${tempDir}`,
          "--clang-tidy=true",
          "--log=error",
        ],
        {
          timeout: execTimeoutMs,
          maxBuffer: 2 * 1_024 * 1_024,
        }
      );
      output = mergedToolOutput(result);
    } catch (error) {
      output = mergedToolOutput(error as { stdout?: string; stderr?: string });
    }

    const clangdDiagnostics = parseClangStyleDiagnostics(output, "clangd", maxIssues);
    if (clangdDiagnostics.length > 0) {
      diagnostics.push(...clangdDiagnostics);
    } else {
      diagnostics.push(...parseClangdCheckDiagnostics(output, maxIssues));
    }
    tools.add("clangd");
  } catch (error) {
    diagnostics.push(toolFailureIssue("clangd", errorMessage(error)));
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return diagnostics;
}

async function validateClangTidy(
  text: string,
  language: "c" | "cpp",
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  const clangTidyBinary = await resolveClangTidyBinary();
  if (!clangTidyBinary) {
    return diagnostics;
  }

  const tempDir = mkdtempSync(path.join(tmpdir(), `chrony-${language}-tidy-`));
  const fileName = language === "cpp" ? "Document.cpp" : "Document.c";
  const filePath = path.join(tempDir, fileName);
  const compileArgs =
    language === "cpp" ? ["-std=c++20", "-xc++"] : ["-std=c17", "-xc"];

  try {
    writeFileSync(filePath, text, "utf8");

    let output = "";
    try {
      const result = await execFile(clangTidyBinary, [filePath, "--", ...compileArgs], {
        timeout: execTimeoutMs,
        maxBuffer: 2 * 1_024 * 1_024,
      });
      output = mergedToolOutput(result);
    } catch (error) {
      output = mergedToolOutput(error as { stdout?: string; stderr?: string });
    }

    diagnostics.push(...parseClangStyleDiagnostics(output, "clang-tidy", maxIssues));
    tools.add("clang-tidy");
  } catch (error) {
    diagnostics.push(toolFailureIssue("clang-tidy", errorMessage(error)));
  } finally {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return diagnostics;
}

async function validateMarkdownlint(
  text: string,
  maxIssues: number,
  tools: Set<string>,
  options: DeepValidationMarkdownLintOptions
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  try {
    // @ts-ignore NodeNext subpath exports are resolved at runtime.
    const markdownlintModule = (await import("markdownlint/sync")) as Record<
      string,
      unknown
    >;
    const lint = markdownlintModule.lint as
      | ((options: Record<string, unknown>) => Record<string, unknown>)
      | undefined;

    if (!lint) {
      diagnostics.push(
        toolFailureIssue(
          "markdownlint",
          "markdownlint sync API is unavailable on this backend runtime."
        )
      );
      return diagnostics;
    }

    const config = markdownlintConfig(options);
    const result = lint({
      strings: { source: text },
      config,
    });

    const entries = result.source;
    const rows = Array.isArray(entries)
      ? (entries as Array<Record<string, unknown>>)
      : [];
    for (const row of rows) {
      const ruleNames = Array.isArray(row.ruleNames)
        ? (row.ruleNames as string[])
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
        column: Math.max(1, Number(row.errorRange && (row.errorRange as number[])[0]) || 1),
        source: "markdownlint",
        code: ruleNames.length > 0 ? ruleNames[0] : "markdownlint",
      });
      if (diagnostics.length >= maxIssues) {
        tools.add("markdownlint");
        return diagnostics;
      }
    }
    tools.add("markdownlint");
  } catch (error) {
    diagnostics.push(toolFailureIssue("markdownlint", errorMessage(error)));
  }

  return diagnostics;
}

function markdownlintConfig(
  options: DeepValidationMarkdownLintOptions
): Record<string, unknown> {
  const config: Record<string, unknown> = {
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

async function validateRemarkLint(
  text: string,
  maxIssues: number,
  tools: Set<string>
): Promise<DeepValidationIssue[]> {
  const diagnostics: DeepValidationIssue[] = [];
  try {
    const remarkModule = await import("remark");
    const remarkLintModule = await import("remark-lint");
    const remarkPresetModule = await import("remark-preset-lint-recommended");

    type RemarkProcessorLike = {
      use(plugin: unknown): RemarkProcessorLike;
      process(source: string): Promise<Record<string, unknown>>;
    };
    const remark = ((remarkModule as Record<string, unknown>).remark ??
      (remarkModule as Record<string, unknown>).default) as () => RemarkProcessorLike;
    const remarkLintPlugin =
      (remarkLintModule as Record<string, unknown>).default ?? remarkLintModule;
    const remarkPresetPlugin =
      (remarkPresetModule as Record<string, unknown>).default ??
      remarkPresetModule;

    const file = await remark()
      .use(remarkLintPlugin)
      .use(remarkPresetPlugin)
      .process(text);

    const messages = Array.isArray(file.messages)
      ? (file.messages as Array<Record<string, unknown>>)
      : [];

    for (const message of messages) {
      const location = (message.location ?? {}) as Record<string, unknown>;
      const start = (location.start ?? {}) as Record<string, unknown>;
      const line = Number(message.line ?? start.line) || 1;
      const column = Number(message.column ?? start.column) || 1;
      diagnostics.push({
        severity: message.fatal ? "error" : "warning",
        message: String(message.reason || message.message || "Remark lint warning"),
        line: Math.max(1, line),
        column: Math.max(1, column),
        source: "remark-lint",
        code:
          message.ruleId == null ? null : String(message.ruleId),
      });
      if (diagnostics.length >= maxIssues) {
        tools.add("remark-lint");
        return diagnostics;
      }
    }
    tools.add("remark-lint");
  } catch (error) {
    diagnostics.push(toolFailureIssue("remark-lint", errorMessage(error)));
  }
  return diagnostics;
}

function parseJSONParseOffset(message: string): number | null {
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

function lineColumnForUTF16Offset(
  text: string,
  utf16Offset: number
): { line: number; column: number } {
  const clampedOffset = Math.max(0, Math.min(text.length, utf16Offset));
  let line = 1;
  let column = 1;

  for (let i = 0; i < clampedOffset; i += 1) {
    if (text.charCodeAt(i) === 0x0a) {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }

  return { line, column };
}

function mergedToolOutput(output: { stdout?: string; stderr?: string }): string {
  return `${output.stdout || ""}\n${output.stderr || ""}`.trim();
}

function safeJSONArray(raw: string): Array<Record<string, unknown>> {
  if (!raw.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? (parsed as Array<Record<string, unknown>>)
      : [];
  } catch {
    return [];
  }
}

function safeJSONObject(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function ruffSeverity(code: string, message: string): DeepValidationSeverity {
  const upperCode = code.toUpperCase();
  const lowerMessage = message.toLowerCase();
  if (
    upperCode.startsWith("E9") ||
    upperCode.startsWith("F") ||
    lowerMessage.includes("syntax")
  ) {
    return "error";
  }
  return "warning";
}

function pyrightSeverity(rawSeverity: unknown): DeepValidationSeverity {
  const normalized = String(rawSeverity || "").toLowerCase();
  if (normalized === "error") {
    return "error";
  }
  if (normalized === "warning") {
    return "warning";
  }
  return "info";
}

function parseClangStyleDiagnostics(
  output: string,
  source: string,
  maxIssues: number
): DeepValidationIssue[] {
  const diagnostics: DeepValidationIssue[] = [];
  if (!output.trim()) {
    return diagnostics;
  }

  const regex =
    /^.+?:(\d+):(\d+):\s+(fatal error|error|warning|note):\s+(.+?)(?:\s+\[([^\]]+)\])?$/gm;
  let match: RegExpExecArray | null = null;
  while ((match = regex.exec(output)) != null) {
    const rawSeverity = match[3].toLowerCase();
    diagnostics.push({
      severity:
        rawSeverity === "fatal error" || rawSeverity === "error"
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

function parseClangdCheckDiagnostics(
  output: string,
  maxIssues: number
): DeepValidationIssue[] {
  const diagnostics: DeepValidationIssue[] = [];
  if (!output.trim()) {
    return diagnostics;
  }

  const regex = /^([EWI])\[[^\]]+\]\s+\[([^\]]+)\]\s+Line\s+(\d+):\s+(.+)$/gm;
  let match: RegExpExecArray | null = null;
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

function resolveLocalBinary(binaryName: string): string {
  const candidates = [
    path.join(process.cwd(), "node_modules", ".bin", binaryName),
    path.join(__dirname, "..", "node_modules", ".bin", binaryName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return binaryName;
}

function withToolArgs(command: ToolCommand, args: string[]): string[] {
  return [...command.argsPrefix, ...args];
}

async function isToolCommandAvailable(command: ToolCommand): Promise<boolean> {
  try {
    await execFile(command.command, withToolArgs(command, ["--version"]), {
      timeout: execTimeoutMs,
      maxBuffer: 256 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

async function resolveToolViaXcrun(toolName: string): Promise<string | null> {
  try {
    const result = await execFile("xcrun", ["--find", toolName], {
      timeout: execTimeoutMs,
      maxBuffer: 256 * 1024,
    });
    const candidate = String(result.stdout || "").trim();
    if (!candidate) {
      return null;
    }
    return existsSync(candidate) ? candidate : null;
  } catch {
    return null;
  }
}

async function resolveRuffToolCommand(): Promise<ToolCommand | null> {
  if (cachedRuffToolCommand !== undefined) {
    return cachedRuffToolCommand;
  }

  const localRuff = resolveLocalBinary("ruff");
  const candidates: ToolCommand[] = [];
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

async function resolveClangdBinary(): Promise<string | null> {
  if (cachedClangdBinary !== undefined) {
    return cachedClangdBinary;
  }

  const localClangd = resolveLocalBinary("clangd");
  const candidates: string[] = [];
  if (localClangd !== "clangd") {
    candidates.push(localClangd);
  }
  const xcrunClangd = await resolveToolViaXcrun("clangd");
  if (xcrunClangd) {
    candidates.push(xcrunClangd);
  }
  candidates.push("clangd");

  for (const candidate of new Set(candidates)) {
    if (
      await isToolCommandAvailable({
        command: candidate,
        argsPrefix: [],
      })
    ) {
      cachedClangdBinary = candidate;
      return candidate;
    }
  }

  cachedClangdBinary = null;
  return null;
}

async function resolveClangTidyBinary(): Promise<string | null> {
  if (cachedClangTidyBinary !== undefined) {
    return cachedClangTidyBinary;
  }

  const localClangTidy = resolveLocalBinary("clang-tidy");
  const candidates: string[] = [];
  if (localClangTidy !== "clang-tidy") {
    candidates.push(localClangTidy);
  }
  const xcrunClangTidy = await resolveToolViaXcrun("clang-tidy");
  if (xcrunClangTidy) {
    candidates.push(xcrunClangTidy);
  }
  candidates.push("clang-tidy");

  for (const candidate of new Set(candidates)) {
    if (
      await isToolCommandAvailable({
        command: candidate,
        argsPrefix: [],
      })
    ) {
      cachedClangTidyBinary = candidate;
      return candidate;
    }
  }

  cachedClangTidyBinary = null;
  return null;
}

async function ensurePyrightAvailability(): Promise<boolean> {
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
  } catch {
    cachedPyrightAvailable = false;
  }

  return cachedPyrightAvailable;
}

function normalizeDiagnostics(
  diagnostics: DeepValidationIssue[],
  maxIssues: number
): DeepValidationIssue[] {
  const seen = new Set<string>();
  const deduped: DeepValidationIssue[] = [];

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

function severityRank(severity: DeepValidationSeverity): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "info":
      return 2;
  }
}

function toolFailureIssue(tool: string, message: string): DeepValidationIssue {
  return {
    severity: "info",
    message: `${tool}: ${message}`,
    line: 1,
    column: 1,
    source: tool,
    code: "tool.failure",
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return "unknown error";
}
