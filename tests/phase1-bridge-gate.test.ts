import { describe, expect, test } from 'vitest';
import { mcpToolCatalog } from '../src/app/mcp-tool-catalog.js';
import { allCapabilities } from '../src/domain/authorization/capability.js';

const REQUIRED_PHASE1_TOOLS = [
  'system_health',
  'list_projects',
  'project_info',
  'project_access_status',
  'project_readiness',
  'prepare_workspace',
  'workspace_bootstrap',

  'read_file',
  'read_files',
  'stat_path',
  'list_files',
  'search_text',
  'write_file',
  'append_file',
  'diff_file',
  'apply_patch',
  'batch_patch',
  'copy_file',
  'move_file',
  'delete_file',

  'list_task_profiles',
  'run_task',
  'list_command_recipes',
  'run_command_recipe',

  'process_profiles',
  'process_list',
  'process_start',
  'process_status',
  'process_stop',

  'git_status',
  'git_diff',
  'git_log',
  'git_branches',
  'git_stage',
  'git_unstage',
  'git_create_branch',
  'git_switch_branch',
  'git_commit',
  'git_restore_paths',

  'preview_profiles',
  'preview_list',
  'preview_start',
  'preview_status',
  'preview_stop',
  'browser_review',
] as const;

const REQUIRED_PHASE1_CAPABILITIES = [
  'filesystem.read',
  'filesystem.write',
  'command.run',
  'git.read',
  'git.write',
] as const;

describe('Phase 1 Bridge capability gate', () => {
  test('keeps every required vibecode bridge tool exposed in the canonical MCP catalog', () => {
    const names = new Set<string>(mcpToolCatalog.map((tool) => tool.name));
    const missing = REQUIRED_PHASE1_TOOLS.filter((name) => !names.has(name));
    expect(missing, 'Phase 1 Bridge is incomplete: missing required MCP tools').toEqual([]);
  });

  test('keeps the required authorization capabilities available for filesystem, command, Git and browser boundaries', () => {
    const capabilities = new Set<string>(allCapabilities);
    const missing = REQUIRED_PHASE1_CAPABILITIES.filter((capability) => !capabilities.has(capability));
    expect(missing, 'Phase 1 Bridge is incomplete: missing required authorization capabilities').toEqual([]);
  });

  test('never reintroduces a caller-controlled raw shell tool into the Phase 1 bridge surface', () => {
    const names = new Set<string>(mcpToolCatalog.map((tool) => tool.name));
    expect(names.has('shell')).toBe(false);
    expect(names.has('run_shell')).toBe(false);
    expect(names.has('exec_shell')).toBe(false);
    expect(names.has('command_exec')).toBe(false);
  });
});
