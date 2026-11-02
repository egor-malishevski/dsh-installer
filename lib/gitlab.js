import { normalizeGitLabUrl } from './config.js';

// Package provenance: https://github.com/zereight/gitlab-mcp/tree/v2.3.19
export const gitlabPackage = Object.freeze({
  name: '@zereight/mcp-gitlab',
  version: '2.3.19',
  bin: 'zereight-mcp-gitlab',
  integrity: 'sha512-QHTJ9UKKtMu6SvI8/aK9WvSsHxPU2fW3Y/cDObe4CvlrQzsXy35Egtuur+fI/P/xgJM+na3Sfa5I37/vfk1NIg==',
});

const repositoryTools = ['get_file_contents', 'get_repository_tree', 'search_repositories'];
const reviewTools = ['get_merge_request', 'list_merge_request_changed_files', 'get_merge_request_file_diff', ...repositoryTools];
export const gitlabGrants = Object.freeze({
  oracle: Object.freeze(reviewTools.map(tool => `mcp__gitlab__${tool}`)),
  fixer: Object.freeze(reviewTools.map(tool => `mcp__gitlab__${tool}`)),
  librarian: Object.freeze(repositoryTools.map(tool => `mcp__gitlab__${tool}`)),
  designer: Object.freeze([]),
});

// The caller supplies a target-managed executable and secret-file reference;
// never embed the token in the generated server declaration.
export function gitlabServer({ url, executable, tokenReference }) {
  if (typeof executable !== 'string' || !executable.startsWith('/') || typeof tokenReference !== 'string' || !tokenReference) throw new Error('GitLab executable and secret reference are required.');
  return {
    name: 'dsh-integrations/mcp-client',
    config: {
      command: executable,
      args: [],
      env: {
        GITLAB_API_URL: normalizeGitLabUrl(url),
        GITLAB_PERSONAL_ACCESS_TOKEN: tokenReference,
        GITLAB_PERMISSION_MODE: 'readonly',
      },
    },
  };
}
