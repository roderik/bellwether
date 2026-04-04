export { getProxyAwareFetch } from "./fetch.js";

export { getGitHubToken } from "./auth.js";

export { type GitHubClient, createGitHubClient } from "./client.js";

export {
  type RepoInfo,
  type PR,
  type PRMergeState,
  getRepoRoot,
  getRepoInfo,
  getCurrentBranch,
  findPRForBranch,
  listOpenPRs,
  fetchPRMergeState,
  updatePRBranch,
} from "./repo.js";

export {
  type ProcessedComment,
  type Reply,
  type FilterOptions,
  type RawCommentData,
  TRACKING_COMMENT_MARKER,
  fetchPRComments,
  fetchThreadResolutionState,
  processComments,
  filterComments,
  replyToComment,
  resolveThread,
} from "./comments.js";

export {
  type CheckCategory,
  type FailingCheck,
  type CIStatus,
  classifyCheck,
  fetchCIStatus,
} from "./checks.js";

export {
  type ConflictHunk,
  type FileConflict,
  type UpdateBranchResult,
  detectLocalConflicts,
  parseMergeTreeOutput,
  extractConflictHunks,
} from "./sync.js";
