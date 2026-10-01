#!/usr/bin/env node
// Node >= 22.6 runs this TypeScript directly (type stripping), so the npm `bin` shim works
// without a build step.
import { resolve } from 'node:path';
import { HarnessRegistry } from './core/registry.ts';
import { loadHarnessManifest } from './core/loader.ts';
import { CmdHarness, type CmdConfig } from './harnesses/cmd.ts';
import { HttpHarness } from './harnesses/http.ts';
import { CodexHarness, type CodexConfig } from './harnesses/codex.ts';
import { ClaudeCodeHarness, type ClaudeCodeConfig } from './harnesses/claude-code.ts';
import { MockHarness } from './harnesses/mock.ts';
import { runCli } from './channels/cli.ts';
import type { AgentRunner } from './core/runner.ts';

interface Args {
  harness: string;
  workspace: string;
  url?: string;
  manifest?: string;
  session?: string;
  model?: string;
  effort?: string;
  maxTurns?: number;
  permissionMode?: string;
  approvals: boolean;
  list: boolean;
  config: Record<string, unknown>;
  prompt: string[];
}

const USAGE = `agent-bridge — run any agent harness behind one event contract

Usage:
  node src/index.ts [options] "your prompt"
  echo "your prompt" | node src/index.ts [options]

Options:
  --harness <id>        mock | cmd | codex | claude-code | http   (default: mock)
  --workspace <dir>     working directory for the harness (default: cwd)
  --manifest <path>     load a harness from a harness.json plugin manifest
  --url <url>           base URL for --harness http
  --model <id>          model to pass to the harness
  --effort <level>      reasoning effort
  --max-turns <n>       max turns for the harness run
  --permission-mode <m> standard | plan | accept-edits | yolo
  --approvals           (cmd) park shell/write/edit calls for a decision
  --config <key=value>  set any harness config key (repeatable)
  --session <id>        resume a previous session
  --list                print registered harnesses and their capabilities
  -h, --help            show this help
`;

function parseArgs(argv: string[]): Args {
  const args: Args = { harness: 'mock', workspace: process.cwd(), list: false, approvals: false, config: {}, prompt: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = (): string => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} requires a value`);
      return value;
    };
    switch (arg) {
      case '--harness': args.harness = next(); break;
      case '--workspace': args.workspace = next(); break;
      case '--url': args.url = next(); break;
      case '--manifest': args.manifest = next(); break;
      case '--model': args.model = next(); break;
      case '--effort': args.effort = next(); break;
      case '--max-turns': args.maxTurns = Number(next()); break;
      case '--permission-mode': args.permissionMode = next(); break;
      case '--approvals': args.approvals = true; break;
      case '--config': {
        const pair = next();
        const eq = pair.indexOf('=');
        if (eq <= 0) throw new Error(`--config expects key=value, got: ${pair}`);
        args.config[pair.slice(0, eq)] = pair.slice(eq + 1);
        break;
      }
      case '--session': args.session = next(); break;
      case '--list': args.list = true; break;
      case '-h':
      case '--help': process.stdout.write(USAGE); process.exit(0); break;
      default:
        if (arg.startsWith('--')) throw new Error(`unknown option: ${arg}`);
        args.prompt.push(arg);
    }
  }
  return args;
}

function defaultRegistry(): HarnessRegistry {
  return new HarnessRegistry().register(new MockHarness()).register(new CmdHarness()).register(new CodexHarness()).register(new ClaudeCodeHarness());
}

async function readPrompt(inline: string[]): Promise<string> {
  if (inline.length > 0) return inline.join(' ');
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

async function buildRunner(args: Args): Promise<AgentRunner> {
  const flags: Record<string, unknown> = {};
  if (args.model) flags.model = args.model;
  if (args.effort) flags.effort = args.effort;
  if (args.maxTurns !== undefined) flags.maxTurns = args.maxTurns;
  if (args.permissionMode) flags.permissionMode = args.permissionMode;
  if (args.approvals) flags.approvals = true;
  // Explicit --config keys win over the convenience flags, matching the spec's precedence.
  const config: Record<string, unknown> = { ...flags, ...args.config };

  if (args.manifest) return loadHarnessManifest(resolve(args.manifest), config);

  switch (args.harness) {
    case 'mock':
      return new MockHarness();
    case 'cmd':
      return new CmdHarness(config as CmdConfig);
    case 'codex': return new CodexHarness(config as CodexConfig);
    case 'claude-code': return new ClaudeCodeHarness(config as ClaudeCodeConfig);
    case 'http':
      if (!args.url) throw new Error('--harness http requires --url');
      return new HttpHarness({ id: 'http', url: args.url, config });
    default:
      throw new Error(`unknown harness: ${args.harness}`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));

  if (args.list) {
    for (const entry of defaultRegistry().list()) {
      const caps = Object.entries(entry.capabilities)
        .filter(([, value]) => value === true)
        .map(([key]) => key)
        .join(', ');
      process.stdout.write(`${entry.id.padEnd(8)} ${caps}\n`);
    }
    return 0;
  }

  const prompt = await readPrompt(args.prompt);
  if (!prompt) {
    process.stderr.write(USAGE);
    return 2;
  }

  const runner = await buildRunner(args);
  return runCli(runner, { prompt, workspace: resolve(args.workspace), sessionId: args.session, config: undefined });
}

main().then(
  code => {
    process.exitCode = code;
  },
  err => {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  },
);
