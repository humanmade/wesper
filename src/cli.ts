#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { collect, formatSummaryMarkdown, stringifyManifest, summarize, validate } from './index.js';
import { sanitizeErrorMessage } from './collector/safe.js';
import { UsageError } from './types.js';
import { allWarnings, hasActionableWarnings } from './warnings.js';

const EXIT = {
  success: 0,
  policyOrValidation: 1,
  usageOrInput: 2,
  transportOrCollection: 3,
} as const;

const program = new Command();

program
  .name('wesper')
  .description('Read a WordPress site into a portable context manifest for agents and Block Runner passes.')
  .version('0.0.2');

program
  .command('collect')
  .description('Read a WordPress site into site.context.json')
  .option('--wp-path <path>', 'path to a local WordPress install (WP-CLI collector)')
  .option('--wp-url <url>', 'site URL for WP-CLI --url, useful for multisite')
  .option('--rest', 'use the REST collector (App Password over core WP endpoints)')
  .option('--wp-user <user>', 'WordPress username for the REST collector (or WP_API_USERNAME)')
  .option('--ssh <target>', 'WP-CLI SSH target')
  .option('--strict', 'fail on partial required surfaces')
  .option('--out <path>', 'write the manifest to a file instead of stdout')
  .action(
    async (options: {
      wpPath?: string;
      wpUrl?: string;
      rest?: boolean;
      wpUser?: string;
      ssh?: string;
      strict?: boolean;
      out?: string;
    }) => {
      try {
        if (options.rest && (options.wpPath || options.ssh)) {
          throw new UsageError('--rest cannot be combined with --wp-path or --ssh.');
        }
        // The Application Password is read only from WP_API_PASSWORD, never an argv flag,
        // so the secret never lands in shell history or the process arg list.
        const context = options.rest
          ? await collect({
              collector: 'rest',
              wpUrl: options.wpUrl ?? process.env.WP_API_URL,
              wpUser: options.wpUser ?? process.env.WP_API_USERNAME,
              wpAppPassword: process.env.WP_API_PASSWORD,
              strict: options.strict,
            })
          : await collect({
              collector: 'wp-cli',
              wpPath: options.wpPath,
              wpUrl: options.wpUrl,
              ssh: options.ssh,
              strict: options.strict,
            });
        await writeOutput(stringifyManifest(context), options.out);
        // A non-strict collection can legitimately return partial evidence. The manifest
        // records that fact; a nonzero status is reserved for a strict-policy failure.
        process.exitCode = EXIT.success;
      } catch (error) {
        console.error(`wesper collect: ${message(error)}`);
        process.exitCode = collectExitCode(error);
      }
    },
  );

program
  .command('validate <manifest>')
  .description('Validate a manifest against the wesper schema (does not verify source-hash integrity)')
  .action(async (manifestPath: string) => {
    try {
      const manifest = await readJson(manifestPath);
      const result = validate(manifest);
      if (!result.ok) {
        for (const issue of result.errors) {
          console.error(`${issue.path || '<root>'}: ${issue.message}`);
        }
        process.exitCode = EXIT.policyOrValidation;
        return;
      }
      for (const warning of result.warnings) {
        console.error(`${warning.surface}: [${warning.code}] ${warning.message}`);
      }
      process.exitCode = hasActionableWarnings(result.warnings) ? EXIT.policyOrValidation : EXIT.success;
    } catch (error) {
      console.error(`wesper validate: ${message(error)}`);
      process.exitCode = EXIT.usageOrInput;
    }
  });

program
  .command('summarize <manifest>')
  .description('Print an agent-readable summary of a manifest')
  .option('--format <fmt>', 'json | md', 'md')
  .action(async (manifestPath: string, options: { format: string }) => {
    try {
      if (options.format !== 'json' && options.format !== 'md') {
        console.error(`wesper summarize: unsupported format "${options.format}". Expected "json" or "md".`);
        process.exitCode = EXIT.usageOrInput;
        return;
      }
      const manifest = await readJson(manifestPath);
      const result = validate(manifest);
      if (!result.ok || !result.context) {
        for (const issue of result.errors) {
          console.error(`${issue.path || '<root>'}: ${issue.message}`);
        }
        process.exitCode = EXIT.policyOrValidation;
        return;
      }
      const output = options.format === 'json'
        ? `${JSON.stringify(summarize(result.context), null, 2)}\n`
        : formatSummaryMarkdown(result.context);
      process.stdout.write(output);
      process.exitCode = hasActionableWarnings(allWarnings(result.context)) ? EXIT.policyOrValidation : EXIT.success;
    } catch (error) {
      console.error(`wesper summarize: ${message(error)}`);
      process.exitCode = EXIT.usageOrInput;
    }
  });

program
  .command('diff <old> <new>')
  .description('Diff two manifests (deferred to V1.1)')
  .action(() => {
    console.error('wesper diff is deferred to V1.1.');
    process.exitCode = EXIT.usageOrInput;
  });

// Commander renders its own diagnostics. Prevent it from exiting directly so
// parsing failures use the same documented usage status as collector input.
program.exitOverride();
for (const command of program.commands) {
  command.exitOverride();
}
try {
  await program.parseAsync();
} catch (error) {
  process.exitCode = isCommanderSuccess(error) ? EXIT.success : EXIT.usageOrInput;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function writeOutput(output: string, out?: string): Promise<void> {
  const text = output.endsWith('\n') ? output : `${output}\n`;
  if (out) {
    await writeFile(out, text);
    return;
  }
  process.stdout.write(text);
}

function message(error: unknown): string {
  return sanitizeErrorMessage(error);
}

/**
 * Preserve the public library error contract at the process boundary without
 * requiring callers to depend on a particular Error subclass or package copy.
 */
function collectExitCode(error: unknown): number {
  switch (errorCode(error)) {
    case 'WESPER_STRICT_POLICY':
      return EXIT.policyOrValidation;
    case 'WESPER_USAGE':
      return EXIT.usageOrInput;
    case 'WESPER_TRANSPORT':
      return EXIT.transportOrCollection;
    default:
      // Collector implementations may throw native process/network errors. They
      // are operational collection failures unless they opt into a typed code.
      return EXIT.transportOrCollection;
  }
}

function errorCode(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return undefined;
}

function isCommanderSuccess(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'commander.helpDisplayed' || code === 'commander.version';
}
