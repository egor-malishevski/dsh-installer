import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGitLabUrl } from '../lib/config.js';
import { gitlabGrants, gitlabPackage, gitlabServer } from '../lib/gitlab.js';

test('GitLab URL accepts only HTTPS origin or exact API endpoint', () => {
  assert.equal(normalizeGitLabUrl('https://git.example'), 'https://git.example/api/v4');
  assert.equal(normalizeGitLabUrl('https://git.example/api/v4/'), 'https://git.example/api/v4');
  for (const value of ['http://git.example', 'https://git.example/api/v3', 'https://user:pw@git.example', 'https://git.example/?token=x', 'https://git.example/#x']) assert.throws(() => normalizeGitLabUrl(value));
});

test('GitLab declaration is pinned, readonly and grants only reviewed tools', () => {
  assert.equal(gitlabPackage.version, '2.3.19');
  assert.equal(gitlabPackage.bin, 'zereight-mcp-gitlab');
  assert.equal(gitlabPackage.integrity, 'sha512-QHTJ9UKKtMu6SvI8/aK9WvSsHxPU2fW3Y/cDObe4CvlrQzsXy35Egtuur+fI/P/xgJM+na3Sfa5I37/vfk1NIg==');
  const server = gitlabServer({ url: 'https://git.example', executable: '/managed/bin/zereight-mcp-gitlab', tokenReference: '<secret-file-reference>' });
  assert.deepEqual(server.config.args, []);
  assert.equal(server.config.env.GITLAB_PERMISSION_MODE, 'readonly');
  assert.equal(server.config.env.GITLAB_PERSONAL_ACCESS_TOKEN, '<secret-file-reference>');
  assert.deepEqual(gitlabGrants.oracle, ['get_merge_request', 'list_merge_request_changed_files', 'get_merge_request_file_diff', 'get_file_contents', 'get_repository_tree', 'search_repositories'].map(name => `mcp__gitlab__${name}`));
  assert.deepEqual(gitlabGrants.fixer, gitlabGrants.oracle);
  assert.deepEqual(gitlabGrants.librarian, gitlabGrants.oracle.slice(3));
  assert.deepEqual(gitlabGrants.designer, []);
});
